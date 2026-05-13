/**
 * ─── New Listings Auto-Alert ──────────────────────────────────────────────────
 * GET /api/v2listings-alert
 *
 * Hit by cron-job.org every 30 minutes.
 * Broadcasts new listings to ALL approved users automatically.
 *
 * TWO-CHANNEL SYSTEM:
 *  All listings go to INFO channel (TELEGRAM_INFO_CHANNEL_ID) — low priority.
 *  Your main bot chat stays clean for ACTION alerts only.
 *  If INFO channel is not configured, listings go to main chat as fallback.
 *
 * DEDUPLICATION:
 *  Each alerted coin is cached for 24 hours — same coin never spams twice.
 *
 * CONTRACT ADDRESSES:
 *  Every alert includes the contract address for every chain from CoinGecko.
 */

const axios = require('axios');
const { getMoonshots, getNewListingsWithMetadata } = require('../src/services/listingsService');
const { getUsersByStatus } = require('../src/services/userService');

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.TELEGRAM_CHAT_ID;
const INFO_CHANNEL = process.env.TELEGRAM_INFO_CHANNEL_ID;

// ─── Alert cache (24h dedup) ──────────────────────────────────────────────────
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_KEY     = 'cryptobot:listed-alerts';
const COOLDOWN_MS   = 24 * 60 * 60 * 1000;
const memCache      = {};

async function getAlertedCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return memCache;
  try {
    const r = await axios.get(`${UPSTASH_URL}/get/${CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }, timeout: 5000,
    });
    return r.data.result ? JSON.parse(r.data.result) : {};
  } catch { return {}; }
}

async function saveAlertedCache(cache) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) { Object.assign(memCache, cache); return; }
  try {
    await axios.post(`${UPSTASH_URL}/set/${CACHE_KEY}`, JSON.stringify(cache), {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    });
  } catch (e) { console.error('[ListingsAlert] Cache save error:', e.message); }
}

function isAlreadyAlerted(cache, symbol) {
  const ts = cache[symbol];
  return ts && (Date.now() - ts) < COOLDOWN_MS;
}

// ─── Send to one destination ──────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error(`[ListingsAlert] Send failed to ${chatId}:`, e.message); }
}

// ─── Broadcast listing to INFO channel (or fallback to all user chats) ────────
// Listings are LOW PRIORITY — they go to the quiet info channel only.
// Users check that channel at their own pace.
async function broadcastListing(text) {
  if (INFO_CHANNEL) {
    // Single destination — the shared info channel
    await sendMessage(INFO_CHANNEL, text);
  } else {
    // Fallback: no info channel configured → send to all users directly
    // (this is the noisy fallback — set up TELEGRAM_INFO_CHANNEL_ID to avoid this)
    const approvedUsers = await getUsersByStatus('approved');
    const allIds = [...new Set([ADMIN_ID, ...approvedUsers.map(u => u.chatId)])].filter(Boolean);
    for (const chatId of allIds) {
      await sendMessage(chatId, text);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// ─── Format price ─────────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p) return 'N/A';
  if (p < 0.000001) return p.toFixed(10);
  if (p < 0.0001)   return p.toFixed(8);
  if (p < 0.01)     return p.toFixed(6);
  if (p < 1)        return p.toFixed(4);
  return p.toFixed(2);
}

// ─── Build alert message for one coin ────────────────────────────────────────
function buildListingMessage(coin, type) {
  const meta     = coin.meta;
  const price    = meta?.currentPrice || coin.price;
  const symbol   = coin.base || coin.symbol;
  const name     = meta?.name || symbol || 'Unknown';
  const change   = coin.change24h ?? coin.priceChange24h;
  const vol      = coin.volume    || coin.volume24h;
  const mcap     = meta?.marketCap;
  const priceStr = fmtPrice(price);

  // ── Contract addresses (always shown) ──────────────────────────────────
  const contracts = meta?.contracts || [];
  let contractBlock;
  if (contracts.length > 0) {
    const lines = ['📋 *Contract Addresses:*'];
    contracts.forEach(ct => {
      lines.push(`  *${ct.chainLabel}:*`);
      lines.push(`  \`${ct.address}\``);
    });
    lines.push(`⚠️ _Verify on CoinGecko before buying_`);
    contractBlock = lines.join('\n');
  } else if (meta?.isNativeAsset) {
    contractBlock = `ℹ️ _Native asset — no contract address (like BTC or SOL)_`;
  } else {
    contractBlock = `⚠️ _Contract address not found — verify on CoinGecko manually_`;
  }

  // ── Probability line (for moonshots) ───────────────────────────────────
  const probLine = coin.probability
    ? `\n📊 *Probability:* ${coin.probability}% — ${coin.band}`
    : '';

  // ── Green signals ───────────────────────────────────────────────────────
  const signals     = (coin.greenSignals || []).slice(0, 3);
  const signalBlock = signals.length > 0
    ? `\n✅ *Why it looks good:*\n${signals.map(s => `  • ${s}`).join('\n')}`
    : '';

  // ── Red flags ───────────────────────────────────────────────────────────
  const flags     = (coin.redFlags || []).slice(0, 2);
  const flagBlock = flags.length > 0
    ? `\n⚠️ *Watch out:*\n${flags.map(f => `  • ${f}`).join('\n')}`
    : '';

  // ── Description ─────────────────────────────────────────────────────────
  const desc = meta?.description
    ? `\n📄 _${meta.description.slice(0, 120)}_`
    : '';

  // ── Targets ─────────────────────────────────────────────────────────────
  const t2x = price ? fmtPrice(price * 2) : null;
  const t5x = price ? fmtPrice(price * 5) : null;

  const headers = {
    moonshot: `🌕 *MOONSHOT ALERT — ${name} (${symbol})*`,
    listing:  `🚀 *NEW LISTING — ${name} (${symbol})*`,
    trending: `🌊 *TRENDING NOW — ${name} (${symbol})*`,
  };

  return [
    headers[type] || `🚀 *NEW — ${name} (${symbol})*`,
    ``,
    `💰 *Price:*   \`$${priceStr}\``,
    change != null ? `📈 *24H:*    ${change >= 0 ? '+' : ''}${Number(change).toFixed(2)}%` : '',
    vol   != null  ? `💵 *Volume:* $${(Number(vol) / 1e6).toFixed(2)}M`                    : '',
    mcap           ? `🏦 *MCap:*   $${(mcap / 1e6).toFixed(1)}M`                           : '',
    probLine,
    desc,
    ``,
    contractBlock,
    signalBlock,
    flagBlock,
    ``,
    t2x ? `🎯 *Targets:*  2X → \`$${t2x}\`  |  5X → \`$${t5x}\`` : '',
    price ? `\n📝 Quick buy: \`buy ${symbol} ${priceStr} 2x\`` : '',
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

    // ── Scan 1: High-probability moonshots ────────────────────────────────
    let moonshots = [];
    try { moonshots = await getMoonshots(); }
    catch (e) { console.error('[ListingsAlert] Moonshots failed:', e.message); }

    for (const coin of moonshots) {
      const symbol = coin.base || coin.symbol;
      if (!symbol) continue;
      if (isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'moonshot'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Scan 2: New listings + CoinGecko trending ─────────────────────────
    let hotCoins = [], trending = [];
    try { ({ hotCoins, trending } = await getNewListingsWithMetadata()); }
    catch (e) { console.error('[ListingsAlert] New listings failed:', e.message); }

    for (const coin of hotCoins) {
      const symbol = coin.base || coin.symbol;
      if (!symbol || isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'listing'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await new Promise(r => setTimeout(r, 500));
    }

    for (const coin of trending) {
      const symbol = coin.symbol;
      if (!symbol || isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'trending'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Prune cache entries older than 24h then save ───────────────────────
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [sym, ts] of Object.entries(cache)) {
      if (ts < cutoff) delete cache[sym];
    }
    await saveAlertedCache(cache);

    return res.status(200).json({
      success:      true,
      alerted,
      skipped,
      alertedCount: alerted.length,
      skippedCount: skipped.length,
      destination:  INFO_CHANNEL
        ? `Info channel (${INFO_CHANNEL})`
        : 'Fallback — no TELEGRAM_INFO_CHANNEL_ID set',
      checkedAt:    new Date().toISOString(),
    });

  } catch (err) {
    console.error('[ListingsAlert] Fatal:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};