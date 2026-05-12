/**
 * ─── New Listings Auto-Alert ──────────────────────────────────────────────────
 * GET /api/v2listings-alert
 *
 * Hit by cron-job.org every 30 minutes (same schedule as v2monitor).
 * Scans for new listings and broadcasts to ALL approved users automatically.
 * No button click needed.
 *
 * DEDUPLICATION:
 *  Each coin that has been alerted is stored in `alertedListings` cache.
 *  A coin will NOT be re-alerted for 24 hours after its first alert.
 *  This prevents the same listing spamming every 30 minutes.
 *
 * CONTRACT ADDRESSES:
 *  Every alert includes the contract address for every chain the coin
 *  is deployed on (fetched from CoinGecko). If no address is found,
 *  the alert says so explicitly so users know to verify manually.
 */

const axios = require('axios');
const { getMoonshots, getNewListingsWithMetadata } = require('../src/services/listingsService');
const { getUsersByStatus } = require('../src/services/userService');

const UPSTASH_URL     = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID        = process.env.TELEGRAM_CHAT_ID;
const INFO_CHANNEL_ID = process.env.TELEGRAM_INFO_CHANNEL_ID || null;

// ─── Alert cache (24h dedup) ──────────────────────────────────────────────────
// Key: cryptobot:listed-alerts  Value: { SYMBOL: timestamp }
const CACHE_KEY    = 'cryptobot:listed-alerts';
const COOLDOWN_MS  = 24 * 60 * 60 * 1000; // 24 hours

// In-memory fallback if Upstash not configured
const memCache = {};

async function getAlertedCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return memCache;
  try {
    const r = await axios.get(`${UPSTASH_URL}/get/${CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 5000,
    });
    return r.data.result ? JSON.parse(r.data.result) : {};
  } catch { return {}; }
}

async function saveAlertedCache(cache) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    Object.assign(memCache, cache);
    return;
  }
  try {
    await axios.post(`${UPSTASH_URL}/set/${CACHE_KEY}`, JSON.stringify(cache), {
      headers: {
        Authorization:  `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
  } catch (e) { console.error('[ListingsAlert] Cache save error:', e.message); }
}

function isAlreadyAlerted(cache, symbol) {
  const ts = cache[symbol];
  if (!ts) return false;
  return (Date.now() - ts) < COOLDOWN_MS;
}

// ─── Send to one user ─────────────────────────────────────────────────────────
async function sendToUser(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:                  chatId,
        text,
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error(`[ListingsAlert] Failed to send to ${chatId}:`, e.message);
  }
}

// ─── Broadcast listings to the INFO channel (or DM each user as fallback) ────
// If TELEGRAM_INFO_CHANNEL_ID is set, one post to the channel reaches everyone.
// If it is not set, we fall back to DMing every approved user individually.
async function broadcast(text) {
  if (INFO_CHANNEL_ID) {
    await sendToUser(INFO_CHANNEL_ID, text);
    return;
  }
  // Fallback: DM every approved user + admin
  const approvedUsers = await getUsersByStatus('approved');
  const allIds = [...new Set([ADMIN_ID, ...approvedUsers.map(u => u.chatId)])].filter(Boolean);
  for (const chatId of allIds) {
    await sendToUser(chatId, text);
  }
}

// ─── Format a price cleanly based on magnitude ───────────────────────────────
function fmtPrice(p) {
  if (!p) return 'N/A';
  if (p < 0.000001) return p.toFixed(10);
  if (p < 0.0001)   return p.toFixed(8);
  if (p < 0.01)     return p.toFixed(6);
  if (p < 1)        return p.toFixed(4);
  return p.toFixed(2);
}

// ─── Build the alert message for one coin ────────────────────────────────────
function buildListingMessage(coin, type) {
  const meta      = coin.meta;
  const price     = meta?.currentPrice || coin.price;
  const priceStr  = fmtPrice(price);
  const name      = meta?.name || coin.base || coin.symbol || 'Unknown';
  const symbol    = coin.base || coin.symbol;
  const change    = coin.change24h ?? coin.priceChange24h;
  const vol       = coin.volume || coin.volume24h;
  const marketCap = meta?.marketCap;

  // ── Contract address block ──────────────────────────────────────────────
  const contracts = meta?.contracts || [];
  let contractBlock;

  if (contracts.length > 0) {
    const lines = ['📋 *Contract Addresses:*'];
    contracts.forEach(ct => {
      lines.push(`  *${ct.chainLabel}:*`);
      lines.push(`  \`${ct.address}\``);
    });
    lines.push(`⚠️ _Always verify on CoinGecko before buying_`);
    contractBlock = lines.join('\n');
  } else if (meta?.isNativeAsset) {
    contractBlock = `ℹ️ _Native chain asset — no contract address (like BTC or SOL)_`;
  } else {
    contractBlock = `⚠️ _Contract address not found — verify manually on CoinGecko before buying_`;
  }

  // ── Probability / band (moonshot listings) ──────────────────────────────
  const probLine = coin.probability
    ? `\n📊 *Probability:* ${coin.probability}% — ${coin.band}`
    : '';

  // ── Top green signals ───────────────────────────────────────────────────
  const signals = (coin.greenSignals || []).slice(0, 3);
  const signalBlock = signals.length > 0
    ? `\n✅ *Signals:*\n${signals.map(s => `  • ${s}`).join('\n')}`
    : '';

  // ── Red flags ───────────────────────────────────────────────────────────
  const flags = (coin.redFlags || []).slice(0, 2);
  const flagBlock = flags.length > 0
    ? `\n⚠️ *Warnings:*\n${flags.map(f => `  • ${f}`).join('\n')}`
    : '';

  // ── Description ─────────────────────────────────────────────────────────
  const desc = meta?.description ? `\n📄 _${meta.description.slice(0, 100)}_` : '';

  // ── 2X / 5X targets ─────────────────────────────────────────────────────
  const t2x = price ? fmtPrice(price * 2) : null;
  const t5x = price ? fmtPrice(price * 5) : null;

  const header = type === 'trending'
    ? `🌊 *NEW TRENDING — ${name} (${symbol})*`
    : `🚀 *NEW LISTING — ${name} (${symbol})*`;

  return [
    header,
    ``,
    `💰 *Price:*   \`$${priceStr}\``,
    change != null ? `📈 *24H:*    ${change >= 0 ? '+' : ''}${Number(change).toFixed(2)}%` : '',
    vol    != null ? `💵 *Volume:* $${(vol / 1e6).toFixed(2)}M` : '',
    marketCap      ? `🏦 *MCap:*   $${(marketCap / 1e6).toFixed(1)}M` : '',
    probLine,
    desc,
    ``,
    contractBlock,
    signalBlock,
    flagBlock,
    ``,
    t2x ? `🎯 *Targets:*  2X → \`$${t2x}\`  |  5X → \`$${t5x}\`` : '',
    price ? `\n📝 \`buy ${symbol} ${priceStr} 2x\`` : '',
    meta?.cgUrl ? `🔗 ${meta.cgUrl}` : '',
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const cache   = await getAlertedCache();
    const alerted = [];
    const skipped = [];

    // ── Scan 1: Moonshot listings (high probability new coins) ─────────────
    let moonshots = [];
    try {
      moonshots = await getMoonshots();
    } catch (e) {
      console.error('[ListingsAlert] Moonshots scan failed:', e.message);
    }

    for (const coin of moonshots) {
      const symbol = coin.base || coin.symbol;
      if (!symbol) continue;

      if (isAlreadyAlerted(cache, symbol)) {
        skipped.push(symbol);
        continue;
      }

      const msg = buildListingMessage(coin, 'moonshot');
      await broadcast(msg);

      cache[symbol] = Date.now();
      alerted.push(symbol);

      // Small delay between broadcasts to avoid Telegram rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Scan 2: New listings + trending from CoinGecko ─────────────────────
    let hotCoins = [], trending = [];
    try {
      ({ hotCoins, trending } = await getNewListingsWithMetadata());
    } catch (e) {
      console.error('[ListingsAlert] New listings scan failed:', e.message);
    }

    for (const coin of hotCoins) {
      const symbol = coin.base || coin.symbol;
      if (!symbol) continue;
      // Skip if already sent via moonshots above
      if (isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      const msg = buildListingMessage(coin, 'listing');
      await broadcast(msg);

      cache[symbol] = Date.now();
      alerted.push(symbol);
      await new Promise(r => setTimeout(r, 500));
    }

    for (const coin of trending) {
      const symbol = coin.symbol;
      if (!symbol) continue;
      if (isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      const msg = buildListingMessage(coin, 'trending');
      await broadcast(msg);

      cache[symbol] = Date.now();
      alerted.push(symbol);
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Save updated cache ─────────────────────────────────────────────────
    // Prune entries older than 24h to keep cache lean
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [sym, ts] of Object.entries(cache)) {
      if (ts < cutoff) delete cache[sym];
    }
    await saveAlertedCache(cache);

    return res.status(200).json({
      success: true,
      alerted,
      skipped,
      alertedCount: alerted.length,
      skippedCount: skipped.length,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[ListingsAlert] Fatal error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};