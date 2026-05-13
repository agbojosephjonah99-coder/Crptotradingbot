/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor
 *
 * TWO-CHANNEL ALERT SYSTEM:
 *
 *  ACTION channel (TELEGRAM_CHAT_ID — your main private chat)
 *  ────────────────────────────────────────────────────────────
 *  🔴 Stop Loss          → EXIT NOW
 *  🚨 Custom Target Hit  → SELL NOW
 *  🟢 TP1 / TP2 / TP3   → Take partial profit
 *  🚀 50%, 100%, 150%... → Round-number milestone (every 50%)
 *
 *  INFO channel (TELEGRAM_INFO_CHANNEL_ID — your Telegram channel)
 *  ────────────────────────────────────────────────────────────────
 *  📊 10%, 20%, 30%, 40% milestones (every 10%, skipping 50/100/150)
 *  ⚪ HOLD updates every 4 hours
 *
 * Setup:
 *  1. Create a Telegram Channel (e.g. "CryptoBot Info")
 *  2. Add your bot as admin of that channel
 *  3. Add TELEGRAM_INFO_CHANNEL_ID to Vercel env vars
 *     Value = the channel's chat ID (e.g. -1001234567890)
 *     or username (e.g. @mycryptobotinfo)
 */

const axios = require('axios');
const { getAllPositions, updateLastChecked, updatePosition } = require('../src/services/positionStore');
const { getUsersByStatus } = require('../src/services/userService');

async function getApprovedUsers() {
  return getUsersByStatus('approved');
}
const { fetchCurrentData, buildAdvice } = require('./v2advice');

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const INFO_CHANNEL   = process.env.TELEGRAM_INFO_CHANNEL_ID; // low-priority channel

// ─── Send helpers ─────────────────────────────────────────────────────────────

// ACTION: sends to the user's own chat (urgent — requires immediate action)
async function sendAction(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error('[Monitor ACTION]', e.message); }
}

// INFO: sends to the shared info channel (low-priority, no action needed)
// Falls back to the user's own chat if INFO channel not configured
async function sendInfo(chatId, text) {
  const dest = INFO_CHANNEL || chatId;
  if (!BOT_TOKEN || !dest) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: dest, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error('[Monitor INFO]', e.message); }
}

// ─── Milestone Helper ─────────────────────────────────────────────────────────
function getNextMilestone(pnlPct, milestoneHits = []) {
  if (pnlPct < 10) return null;
  const STEP    = 10;
  const highest = Math.floor(pnlPct / STEP) * STEP;
  for (let m = highest; m >= STEP; m -= STEP) {
    if (!milestoneHits.includes(m)) return m;
  }
  return null;
}

// Round milestones (50, 100, 150...) go to ACTION channel — everything else to INFO
function isRoundMilestone(m) {
  return m % 50 === 0;
}

function milestoneEmoji(milestone) {
  if (milestone >= 100) return '🚀🚀🚀';
  if (milestone >= 70)  return '🚀🚀';
  if (milestone >= 40)  return '🚀';
  if (milestone >= 20)  return '🟢🟢';
  return '🟢';
}

// ─── Core position checker ────────────────────────────────────────────────────
async function checkPosition(pos, userId) {
  const actionChatId = userId || pos.chatId || process.env.TELEGRAM_CHAT_ID;
  const { candles1h, candles4h, currentPrice } = await fetchCurrentData(pos.symbol);

  const pnlPct          = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
  const currentMultiple = currentPrice / pos.buyPrice;
  const profitDollar    = pos.quantity
    ? ((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2)
    : null;

  const advice = buildAdvice({
    symbol:      pos.symbol,
    buyPrice:    pos.buyPrice,
    currentPrice,
    candles1h,
    candles4h,
    accountSize: pos.accountSize,
    riskPct:     pos.riskPct,
  });

  const sl  = advice.tradePlan?.stopLoss;
  const tp1 = advice.tradePlan?.takeProfits?.tp1;
  const tp2 = advice.tradePlan?.takeProfits?.tp2;
  const tp3 = advice.tradePlan?.takeProfits?.tp3;

  if (sl && !pos.stopLossPrice) {
    await updatePosition(pos.chatId, pos.positionId, { stopLossPrice: sl });
  }
  if (currentPrice > (pos.highestPrice || pos.buyPrice)) {
    await updatePosition(pos.chatId, pos.positionId, { highestPrice: currentPrice });
  }

  // ── MILESTONE ALERTS ──────────────────────────────────────────────────────
  const milestoneHits = pos.milestoneHits || [];
  const nextMilestone = getNextMilestone(pnlPct, milestoneHits);
  let milestoneAlerted = false;

  if (nextMilestone !== null) {
    const emoji      = milestoneEmoji(nextMilestone);
    const nextTarget = nextMilestone + 10;
    const nextPrice  = (pos.buyPrice * (1 + nextTarget / 100)).toFixed(6);
    const isRound    = isRoundMilestone(nextMilestone);

    const ceilingPct   = pos.targetMultiple ? (pos.targetMultiple - 1) * 100 : null;
    const ceilingAhead = ceilingPct && ceilingPct > nextMilestone && !pos.targetHit;
    const ceilingMsg   = ceilingAhead
      ? `🎯 Your target (+${Number.isInteger(ceilingPct) ? ceilingPct : ceilingPct.toFixed(1)}% = \`$${pos.targetPrice.toFixed(6)}\`) is still ahead — hold on.`
      : '';

    const milestoneMsg = [
      `${emoji} *+${nextMilestone}% MILESTONE — ${pos.symbol}*`,
      isRound ? `🎉 *Round number — consider taking some profit!*` : '',
      ``,
      `💰 *Bought at:*  \`$${pos.buyPrice}\``,
      `📊 *Now:*        \`$${currentPrice.toFixed(6)}\``,
      `📈 *Gain:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      profitDollar ? `💵 *Profit:*      $${profitDollar}` : '',
      ``,
      `📌 *Next milestone:* +${nextTarget}% at \`$${nextPrice}\``,
      ceilingMsg,
      ``,
      sl ? `🛡 *Stop loss:* \`$${sl.toFixed(6)}\`` : '',
      `💡 _Consider moving your stop loss up to lock in profit._`,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n');

    if (isRound) {
      // 50%, 100%, 150%... → ACTION channel (phone buzzes)
      await sendAction(actionChatId, milestoneMsg);
    } else {
      // 10%, 20%, 30%, 40%, 60%... → INFO channel (quiet)
      await sendInfo(actionChatId, milestoneMsg);
    }

    await updatePosition(pos.chatId, pos.positionId, {
      milestoneHits: [...milestoneHits, nextMilestone],
    });
    milestoneAlerted = true;
  }

  // ── CUSTOM TARGET HIT → ACTION ────────────────────────────────────────────
  if (pos.targetMultiple && pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    const ceilingPct  = (pos.targetMultiple - 1) * 100;
    const targetLabel = Number.isInteger(ceilingPct)
      ? `+${ceilingPct}% (${pos.targetMultiple}X)`
      : `${pos.targetMultiple}X`;

    await sendAction(actionChatId, [
      ``,
      `🚨🎯🚨 *TARGET HIT — ${pos.symbol}* 🚨🎯🚨`,
      ``,
      `🌕 *${targetLabel} REACHED — SELL NOW*`,
      ``,
      `💰 *You bought at:*   \`$${pos.buyPrice}\``,
      `📊 *Current price:*   \`$${currentPrice.toFixed(8)}\``,
      `📈 *Your gain:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      profitDollar ? `💵 *Estimated profit:* $${profitDollar}` : '',
      ``,
      `🔴 *DO THIS RIGHT NOW:*`,
      `  1. Open your exchange immediately`,
      `  2. Sell 60% of your position at market price`,
      `  3. Move stop on remaining 40% to your buy price (\`$${pos.buyPrice}\`)`,
      `  4. If price drops back to buy price → sell the rest`,
      `  5. If price keeps rising → enjoy the ride 🚀`,
      ``,
      `⚠️ _Do not be greedy. Secure your profit now._`,
      ``,
      `Type \`sell ${pos.symbol}\` after you exit to remove this position.`,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    await updatePosition(pos.chatId, pos.positionId, { targetHit: true });
    return { recommendation: `TARGET_HIT_${targetLabel}`, alerted: true };
  }

  // ── STOP LOSS HIT → ACTION ────────────────────────────────────────────────
  if (sl && currentPrice <= sl && !pos.stopLossHit) {
    await sendAction(actionChatId, [
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

  // ── TP3 HIT → ACTION ──────────────────────────────────────────────────────
  if (tp3 && currentPrice >= tp3.price && !pos.tp3Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp3Hit: true });
    await sendAction(actionChatId, [
      `🟢🟢🟢 *TP3 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell remaining 25% — TP3 reached. Outstanding trade.*`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 Your target is \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP3', alerted: true };
  }

  // ── TP2 HIT → ACTION ──────────────────────────────────────────────────────
  if (tp2 && currentPrice >= tp2.price && pnlPct > 0 && !pos.tp2Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp2Hit: true });
    await sendAction(actionChatId, [
      `🟢🟢 *TP2 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell 35% of position now.*`,
      `🛡 Move stop loss to \`$${tp1?.price.toFixed(4) || pos.buyPrice}\` (lock in profit)`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 Target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP3 at \`$${tp3?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP2', alerted: true };
  }

  // ── TP1 HIT → ACTION ──────────────────────────────────────────────────────
  if (tp1 && currentPrice >= tp1.price && pnlPct > 0 && !pos.tp1Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp1Hit: true });
    await sendAction(actionChatId, [
      `🟢 *TP1 HIT — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      ``,
      `🟢 *Sell 40% of position now.*`,
      `🛡 Move stop loss to \`$${pos.buyPrice}\` — free trade, can't lose now.`,
      pos.targetMultiple && !pos.targetHit
        ? `🎯 Target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP2 at \`$${tp2?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP1', alerted: true };
  }

  // ── HOLD → INFO (every 4 hours, quiet channel) ────────────────────────────
  const lastChecked     = pos.lastChecked ? new Date(pos.lastChecked).getTime() : 0;
  const hoursSinceCheck = (Date.now() - lastChecked) / (1000 * 60 * 60);

  if (hoursSinceCheck >= 4) {
    const distToTarget = pos.targetPrice
      ? `${(((pos.targetPrice - currentPrice) / currentPrice) * 100).toFixed(1)}% away`
      : null;
    const nextMs      = Math.ceil(Math.max(pnlPct, 0) / 10) * 10 || 10;
    const nextMsPrice = (pos.buyPrice * (1 + nextMs / 100)).toFixed(6);

    await sendInfo(actionChatId, [
      `⚪ *HOLD — ${pos.symbol}*`,
      ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${currentPrice.toFixed(6)}\``,
      `📈 *P&L:*       ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      pos.targetMultiple
        ? `🎯 *Target:* \`$${pos.targetPrice.toFixed(6)}\` — ${distToTarget}`
        : '',
      pnlPct < nextMs
        ? `📌 *Next milestone:* +${nextMs}% at \`$${nextMsPrice}\``
        : '',
      ``,
      `✅ Stay in the trade. No action needed.`,
      sl  ? `🛡 Stop loss: \`$${sl.toFixed(6)}\`` : '',
      tp1 ? `🎯 Next TP: \`$${tp1.price.toFixed(4)}\`` : '',
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));

    return { recommendation: 'HOLD', alerted: true };
  }

  if (milestoneAlerted) {
    return { recommendation: `MILESTONE_${nextMilestone}PCT`, alerted: true };
  }

  return { recommendation: 'HOLD', alerted: false };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const adminId       = process.env.TELEGRAM_CHAT_ID;
    const approvedUsers = await getApprovedUsers();
    const allUserIds    = [...new Set([adminId, ...approvedUsers.map(u => u.chatId)])].filter(Boolean);

    const results      = [];
    let totalPositions = 0;

    for (const userId of allUserIds) {
      const positions = await getAllPositions(userId);
      const entries   = Object.values(positions);
      totalPositions += entries.length;

      for (const pos of entries) {
        try {
          const result = await checkPosition(pos, userId);
          await updateLastChecked(userId, pos.positionId, result.recommendation);
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
      success:   true,
      checked:   results.length,
      results,
      infoChannel: INFO_CHANNEL || 'not configured — falling back to user chat',
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};