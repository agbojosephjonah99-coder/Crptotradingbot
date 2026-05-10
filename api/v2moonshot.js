/**
 * ─── Auto Moonshot Alert Engine ──────────────────────────────────────────────
 * GET /api/v2moonshot
 *
 * Hit this endpoint every 30 mins via cron-job.org
 * Scans the entire market for coins with genuine 2x-5x potential
 * and fires Telegram alerts automatically — no command needed.
 *
 * Only alerts when score >= 70/100 to avoid spam.
 * Deduplication: same coin won't alert again for 6 hours.
 */

const axios = require('axios');
const { getMoonshots } = require('../src/services/listingsService');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const KUCOIN_BASE = 'https://api.kucoin.com/api/v1';

// In-memory dedup cache (resets on cold start — acceptable)
const alertCache = new Map();
const COOLDOWN   = 6 * 60 * 60 * 1000; // 6 hours per coin

function isDuplicate(symbol) {
  const last = alertCache.get(symbol);
  return last && (Date.now() - last) < COOLDOWN;
}
function markSent(symbol) { alertCache.set(symbol, Date.now()); }

async function sendAlert(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error('[Moonshot Alert]', e.message); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const moonshots = await getMoonshots();

    // Only fire alerts for genuinely high-confidence picks (score >= 70)
    const qualified = moonshots.filter(c => c.score >= 70 && !isDuplicate(c.base));

    if (qualified.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No high-confidence moonshots right now',
        scannedAt: new Date().toISOString(),
      });
    }

    for (const coin of qualified) {
      const meta     = coin.meta;
      const priceStr = coin.price < 0.001
        ? coin.price.toFixed(8)
        : coin.price < 0.01
          ? coin.price.toFixed(6)
          : coin.price.toFixed(4);

      const cgPrice = meta?.currentPrice
        ? (meta.currentPrice < 0.001 ? meta.currentPrice.toFixed(8) : meta.currentPrice.toFixed(4))
        : priceStr;

      // Calculate each target price
      const t2x = (parseFloat(cgPrice) * 2).toFixed(6);
      const t3x = (parseFloat(cgPrice) * 3).toFixed(6);
      const t4x = (parseFloat(cgPrice) * 4).toFixed(6);
      const t5x = (parseFloat(cgPrice) * 5).toFixed(6);

      const lines = [
        `🚨 *HIGH CONFIDENCE ALERT — ${meta?.name || coin.base} (${coin.base})* 🚨`,
        ``,
        `⚡ *This coin has a ${coin.probability}% chance of a major pump within 3 days.*`,
        ``,
        `💰 *Current Price:* \`$${cgPrice}\``,
        `📈 *24H Change:*    +${coin.change24h.toFixed(2)}%`,
        `💵 *24H Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
        meta?.marketCap ? `🏦 *Market Cap:*    $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
        coin.isTrending ? `🔥 *TRENDING on CoinGecko right now*` : '',
        `📊 *Confidence Score:* ${coin.score}/100`,
        ``,
        `🎯 *PROFIT TARGETS:*`,
        `  2X → \`$${t2x}\` (+100%)`,
        `  3X → \`$${t3x}\` (+200%)`,
        `  4X → \`$${t4x}\` (+300%)`,
        `  5X → \`$${t5x}\` (+400%)`,
        ``,
        `📋 *Why this coin:*`,
        ...coin.reasons.map(r => `  ✅ ${r}`),
        ``,
      ];

      // Contract addresses
      if (meta?.contracts?.length > 0) {
        lines.push(`📋 *Contract Addresses:*`);
        meta.contracts.slice(0, 3).forEach(ct => {
          lines.push(`  *${ct.chainLabel}:*`);
          lines.push(`  \`${ct.address}\``);
        });
        lines.push(`⚠️ _Verify on CoinGecko before buying_`);
      } else if (meta?.isNativeAsset) {
        lines.push(`ℹ️ _Native asset — no contract address_`);
      } else {
        lines.push(`⚠️ _Verify contract on CoinGecko before buying_`);
      }

      if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);

      lines.push(``);
      lines.push(`── *HOW TO TRADE THIS* ──`);
      lines.push(`1️⃣ Buy on exchange at \`$${cgPrice}\``);
      lines.push(`2️⃣ Tell the bot you bought:`);
      lines.push(`   \`buy ${coin.base} ${cgPrice} 2x\` ← alert at 2X`);
      lines.push(`   \`buy ${coin.base} ${cgPrice} 3x\` ← alert at 3X`);
      lines.push(`   \`buy ${coin.base} ${cgPrice} 5x\` ← alert at 5X`);
      lines.push(`3️⃣ Bot monitors 24/7 and alerts you the moment to sell`);
      lines.push(``);
      lines.push(`🔴 *RISK MANAGEMENT:*`);
      lines.push(`  • Max 1-2% of your account on this trade`);
      lines.push(`  • If it drops 20% from entry → exit immediately`);
      lines.push(`  • New coins are HIGH RISK — only money you can afford to lose`);
      lines.push(`⏰ ${new Date().toUTCString()}`);

      await sendAlert(lines.filter(Boolean).join('\n'));
      markSent(coin.base);

      // Small delay between messages to avoid Telegram rate limit
      await new Promise(r => setTimeout(r, 1000));
    }

    return res.status(200).json({
      success:   true,
      alerted:   qualified.length,
      coins:     qualified.map(c => c.base),
      scannedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[v2moonshot]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};