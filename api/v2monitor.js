/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor
 * Called by cron-job.org every hour.
 *
 * Checks every open position and fires Telegram alerts for:
 *  🎯 Target hit (5X or custom multiplier)
 *  🔴 Stop loss hit
 *  🟢 Take profit levels (TP1/TP2/TP3)
 *  🟡 Trailing stop needed
 *  ⚪ HOLD (every 4 hours)
 */

const axios = require('axios');
const {
  getAllPositions, updateLastChecked, updatePosition,
} = require('../src/services/positionStore');
const { fetchCurrentData, buildAdvice } = require('./v2advice');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendAlert(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[Monitor] Alert failed:', e.message);
  }
}

async function checkPosition(pos) {
  const { candles1h, candles4h, currentPrice } = await fetchCurrentData(pos.symbol);
  const advice = buildAdvice({
    symbol:      pos.symbol,
    buyPrice:    pos.buyPrice,
    currentPrice,
    candles1h,
    candles4h,
    accountSize: pos.accountSize,
    riskPct:     pos.riskPct,
  });

  const pnlPct     = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
  const currentMultiple = currentPrice / pos.buyPrice;

  // Track highest price (for trailing stop awareness)
  if (currentPrice > (pos.highestPrice || pos.buyPrice)) {
    await updatePosition(pos.symbol, { highestPrice: currentPrice });
  }

  const tp1 = advice.tradePlan?.takeProfits?.tp1;
  const tp2 = advice.tradePlan?.takeProfits?.tp2;
  const tp3 = advice.tradePlan?.takeProfits?.tp3;
  const sl  = advice.tradePlan?.stopLoss;

  // ── 1. TARGET HIT (5X or custom) ────────────────────────────────────────
  if (pos.targetMultiple && !pos.targetHit && currentPrice >= pos.targetPrice) {
    await sendAlert([
      `🎯🎯🎯 *TARGET HIT — ${pos.symbol}* 🎯🎯🎯`,
      ``,
      `🌕 *${pos.targetMultiple}X TARGET REACHED!*`,
      ``,
      `💰 *You bought at:* \`$${pos.buyPrice}\``,
      `📊 *Current price:* \`$${currentPrice.toFixed(6)}\``,
      `📈 *Gain:*          +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      pos.quantity ? `💵 *Profit:*         $${((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2)}` : '',
      ``,
      `🔴 *SELL NOW — TAKE YOUR PROFIT*`,
      ``,
      `📋 *How to exit:*`,
      `  • Sell 50% immediately at market price`,
      `  • Set trailing stop on remaining 50%`,
      `  • If it keeps rising — let it run`,
      `  • If it drops 20% from here → sell everything`,
      ``,
      `Type \`sell ${pos.symbol}\` after you exit to remove this position.`,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    await updatePosition(pos.symbol, { targetHit: true });
    return { recommendation: 'TARGET_HIT', alerted: true };
  }

  // ── 2. STOP LOSS HIT ─────────────────────────────────────────────────────
  if (sl && currentPrice <= sl && !pos.stopLossHit) {
    await sendAlert([
      `🔴 *STOP LOSS HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(6)}\``,
      `📉 *Loss:*      ${pnlPct.toFixed(2)}%`,
      ``,
      `🔴 *EXIT NOW — DO NOT HOLD THROUGH THE STOP*`,
      ``,
      `👉 Sell 100% at market price immediately.`,
      `👉 A small loss now prevents a catastrophic loss later.`,
      ``,
      `Type \`sell ${pos.symbol}\` after you exit.`,
      `⏰ ${new Date().toUTCString()}`,
    ].join('\n'));

    await updatePosition(pos.symbol, { stopLossHit: true });
    return { recommendation: 'STOP_LOSS', alerted: true };
  }

  // ── 3. TAKE PROFIT LEVELS ────────────────────────────────────────────────
  if (advice.recommendation === 'TAKE_PROFIT') {
    const tpHit = tp3 && currentPrice >= tp3.price ? 'TP3'
      : tp2 && currentPrice >= tp2.price ? 'TP2'
      : 'TP1';

    const emoji = tpHit === 'TP3' ? '🟢🟢🟢' : tpHit === 'TP2' ? '🟢🟢' : '🟢';

    await sendAlert([
      `${emoji} *${tpHit} HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *P&L:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      ...(advice.actions || []).map(a => `👉 ${a}`),
      ``,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 *Your ${pos.targetMultiple}X target:* \`$${pos.targetPrice.toFixed(6)}\` — keep holding!`
        : '',
      sl  ? `🛡 Move stop to: \`$${pos.buyPrice.toFixed(4)}\` (breakeven)` : '',
      tp2 && tpHit === 'TP1' ? `🎯 Next target: \`$${tp2.price.toFixed(4)}\` (TP2)` : '',
      tp3 && tpHit === 'TP2' ? `🎯 Next target: \`$${tp3.price.toFixed(4)}\` (TP3)` : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    return { recommendation: advice.recommendation, alerted: true };
  }

  // ── 4. TRAIL STOP / CLOSE PARTIAL ────────────────────────────────────────
  if (advice.recommendation === 'TRAIL_STOP' || advice.recommendation === 'CLOSE_PARTIAL') {
    const emoji = advice.recommendation === 'TRAIL_STOP' ? '🟡' : '🟠';
    await sendAlert([
      `${emoji} *${advice.recommendation} — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *P&L:*       +${pnlPct.toFixed(2)}%`,
      ``,
      ...(advice.reasons || []).map(r => `  ${r}`),
      ``,
      ...(advice.actions || []).map(a => `👉 ${a}`),
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    return { recommendation: advice.recommendation, alerted: true };
  }

  // ── 5. HOLD (send every 4 hours only — not every hour) ───────────────────
  const lastChecked    = pos.lastChecked ? new Date(pos.lastChecked).getTime() : 0;
  const hoursSinceCheck = (Date.now() - lastChecked) / (1000 * 60 * 60);

  if (advice.recommendation === 'HOLD' && hoursSinceCheck >= 4) {
    await sendAlert([
      `⚪ *HOLD — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *P&L:*       ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      pos.targetPrice ? `🎯 *${pos.targetMultiple}X target:* \`$${pos.targetPrice.toFixed(6)}\` — ${((pos.targetPrice - currentPrice) / currentPrice * 100).toFixed(1)}% away` : '',
      ``,
      `✅ Trend intact. Stay in the trade.`,
      sl  ? `🛡 Stop loss: \`$${sl.toFixed(4)}\`` : '',
      tp1 ? `🎯 Next target: \`$${tp1.price.toFixed(4)}\` (TP1)` : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    return { recommendation: 'HOLD', alerted: true };
  }

  return { recommendation: advice.recommendation, alerted: false };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const positions = await getAllPositions();
    const entries   = Object.values(positions);

    if (entries.length === 0) {
      return res.status(200).json({ success: true, message: 'No open positions' });
    }

    const results = [];
    for (const pos of entries) {
      try {
        const result = await checkPosition(pos);
        await updateLastChecked(pos.symbol, result.recommendation);
        results.push({ symbol: pos.symbol, ...result });
      } catch (err) {
        console.error(`[Monitor] ${pos.symbol}:`, err.message);
        results.push({ symbol: pos.symbol, error: err.message });
      }
    }

    return res.status(200).json({
      success: true, checked: results.length, results,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};