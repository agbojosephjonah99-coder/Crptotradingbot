/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor
 *
 * Hit every 30 mins via cron-job.org for fast target detection.
 * Fires Telegram alerts the moment a target is hit.
 */

const axios = require('axios');
const { getAllUsersPositions, updateLastChecked, updatePosition } = require('../src/services/positionStore');
const { getApprovedUsers } = require('../src/services/userStore');
const { fetchCurrentData, buildAdvice } = require('./v2advice');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendAlert(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error('[Monitor Alert]', e.message); }
}

async function checkPosition(pos, userId) {
  const targetChatId = userId || pos.chatId || process.env.TELEGRAM_CHAT_ID;
  const { candles1h, candles4h, currentPrice } = await fetchCurrentData(pos.symbol);

  const pnlPct          = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

  // Store calculated stop loss price so v2quickcheck can use it
  // without needing to fetch candles (much faster)
  if (sl && !pos.stopLossPrice) {
    await updatePosition(pos.chatId, pos.positionId, { stopLossPrice: sl });
  }
  const currentMultiple = currentPrice / pos.buyPrice;
  const profitDollar    = pos.quantity ? ((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2) : null;

  const advice = buildAdvice({
    symbol: pos.symbol, buyPrice: pos.buyPrice,
    currentPrice, candles1h, candles4h,
    accountSize: pos.accountSize, riskPct: pos.riskPct,
  });

  const sl  = advice.tradePlan?.stopLoss;
  const tp1 = advice.tradePlan?.takeProfits?.tp1;
  const tp2 = advice.tradePlan?.takeProfits?.tp2;
  const tp3 = advice.tradePlan?.takeProfits?.tp3;

  // Track highest price seen
  if (currentPrice > (pos.highestPrice || pos.buyPrice)) {
    await updatePosition(pos.chatId, pos.positionId, { highestPrice: currentPrice });
  }

  // ── TARGET HIT (2x / 3x / 4x / 5x) ──────────────────────────────────────
  if (pos.targetMultiple && pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    await sendAlert(targetChatId, [
      ``,
      `🚨🎯🚨 *${pos.targetMultiple}X TARGET HIT — ${pos.symbol}* 🚨🎯🚨`,
      ``,
      `🌕 *SELL NOW — YOUR TARGET HAS BEEN REACHED*`,
      ``,
      `💰 *You bought at:*   \`$${pos.buyPrice}\``,
      `📊 *Current price:*   \`$${currentPrice.toFixed(8)}\``,
      `📈 *Your gain:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      profitDollar ? `💵 *Estimated profit:* $${profitDollar}` : '',
      ``,
      `🔴 *DO THIS RIGHT NOW:*`,
      `  1. Open your exchange immediately`,
      `  2. Sell 60% of your position at market price`,
      `  3. Move stop on remaining 40% to your buy price ($${pos.buyPrice})`,
      `  4. If price drops back to buy price → sell the rest`,
      `  5. If price keeps rising → enjoy the ride 🚀`,
      ``,
      `⚠️ _Do not be greedy. Secure your profit now._`,
      ``,
      `Type \`sell ${pos.symbol}\` after you exit to remove this position.`,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    await updatePosition(pos.chatId, pos.positionId, { targetHit: true });
    return { recommendation: `${pos.targetMultiple}X_TARGET_HIT`, alerted: true };
  }

  // ── STOP LOSS HIT ─────────────────────────────────────────────────────────
  if (sl && currentPrice <= sl && !pos.stopLossHit) {
    await sendAlert(targetChatId, [
      `🔴 *STOP LOSS — EXIT NOW — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(8)}\``,
      `📉 *Loss:*      ${pnlPct.toFixed(2)}%`,
      ``,
      `🔴 *Sell 100% immediately. No hesitation.*`,
      `A small loss now prevents a wipeout later.`,
      ``,
      `Type \`sell ${pos.symbol}\` to remove this position.`,
      `⏰ ${new Date().toUTCString()}`,
    ].join('\n'));

    await updatePosition(pos.chatId, pos.positionId, { stopLossHit: true });
    return { recommendation: 'STOP_LOSS', alerted: true };
  }

  // ── TP3 HIT ───────────────────────────────────────────────────────────────
  if (tp3 && currentPrice >= tp3.price) {
    await sendAlert(targetChatId, [
      `🟢🟢🟢 *TP3 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell remaining 25% — TP3 reached. Outstanding trade.*`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 Your ${pos.targetMultiple}X target is \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP3', alerted: true };
  }

  // ── TP2 HIT ───────────────────────────────────────────────────────────────
  if (tp2 && currentPrice >= tp2.price && pnlPct > 0) {
    await sendAlert(targetChatId, [
      `🟢🟢 *TP2 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell 35% of position now.*`,
      `🛡 Move stop loss to \`$${tp1?.price.toFixed(4) || pos.buyPrice}\` (lock in profit)`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 ${pos.targetMultiple}X target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP3 at \`$${tp3?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP2', alerted: true };
  }

  // ── TP1 HIT ───────────────────────────────────────────────────────────────
  if (tp1 && currentPrice >= tp1.price && pnlPct > 0) {
    await sendAlert(targetChatId, [
      `🟢 *TP1 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell 40% of position now.*`,
      `🛡 Move stop loss to \`$${pos.buyPrice}\` — free trade, can't lose now.`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 ${pos.targetMultiple}X target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP2 at \`$${tp2?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP1', alerted: true };
  }

  // ── HOLD — send every 4 hours only ───────────────────────────────────────
  const lastChecked     = pos.lastChecked ? new Date(pos.lastChecked).getTime() : 0;
  const hoursSinceCheck = (Date.now() - lastChecked) / (1000 * 60 * 60);

  if (hoursSinceCheck >= 4) {
    const distToTarget = pos.targetPrice
      ? `${(((pos.targetPrice - currentPrice) / currentPrice) * 100).toFixed(1)}% away`
      : null;

    await sendAlert(targetChatId, [
      `⚪ *HOLD — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(6)}\``,
      `📈 *P&L:*       ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      pos.targetMultiple
        ? `🎯 *${pos.targetMultiple}X target:* \`$${pos.targetPrice.toFixed(6)}\` — ${distToTarget}`
        : '',
      ``,
      `✅ Stay in the trade. No action needed.`,
      sl ? `🛡 Stop loss: \`$${sl.toFixed(6)}\`` : '',
      tp1 ? `🎯 Next TP: \`$${tp1.price.toFixed(4)}\`` : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    return { recommendation: 'HOLD', alerted: true };
  }

  return { recommendation: 'HOLD', alerted: false };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Get all approved users and check each user's positions
    const adminId      = process.env.TELEGRAM_CHAT_ID;
    const approvedUsers = await getApprovedUsers();
    const allUserIds   = [...new Set([adminId, ...approvedUsers.map(u => u.chatId)])].filter(Boolean);

    const results = [];
    let totalPositions = 0;

    for (const userId of allUserIds) {
      const positions = await getAllPositions(userId);
      const entries   = Object.values(positions);
      totalPositions += entries.length;

      for (const pos of entries) {
        try {
          const result = await checkPosition(pos, userId);
          await updateLastChecked(userId, pos.symbol, result.recommendation);
          results.push({ userId, symbol: pos.symbol, ...result });
        } catch (err) {
          console.error(`[Monitor] ${userId}/${pos.symbol}:`, err.message);
          results.push({ userId, symbol: pos.symbol, error: err.message });
        }
      }
    }

    if (totalPositions === 0) {
      return res.status(200).json({ success: true, message: 'No open positions across any users' });
    }

    return res.status(200).json({
      success: true, checked: results.length,
      results, checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};