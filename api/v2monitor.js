/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor
 *
 * Hit every 30 mins via cron-job.org for fast target detection.
 * Fires Telegram alerts the moment a target is hit.
 *
 * DUAL-CHANNEL ROUTING:
 *  ACTION channel  (TELEGRAM_CHAT_ID)         — requires immediate action:
 *    🔴 Stop loss hit
 *    🎯 Custom target hit
 *    🚨 Round milestones: 50%, 100%, 150% only
 *    🟢 TP1 / TP2 / TP3
 *
 *  INFO channel    (TELEGRAM_INFO_CHANNEL_ID)  — useful but not urgent:
 *    📊 Milestones: 10%, 20%, 30%, 40% (and non-round milestones)
 *    ⚪ HOLD updates
 *
 * Set TELEGRAM_INFO_CHANNEL_ID in your .env to a channel/group ID or @username.
 * If not set, all alerts fall back to the main ACTION channel.
 */

const axios = require('axios');
const { getAllPositions, updateLastChecked, updatePosition } = require('../src/services/positionStore');
const { getUsersByStatus } = require('../src/services/userService');

async function getApprovedUsers() {
  return getUsersByStatus('approved');
}
const { fetchCurrentData, buildAdvice } = require('./v2advice');

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const INFO_CHANNEL_ID = process.env.TELEGRAM_INFO_CHANNEL_ID || null;

// ─── Send helpers ─────────────────────────────────────────────────────────────

async function sendToChat(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) { console.error('[Monitor Alert]', e.message); }
}

// Action alert → user's personal chat (requires immediate action)
async function sendAlert(chatId, text) {
  await sendToChat(chatId, text);
}

// Info alert → info channel if configured, else fall back to user's personal chat
async function sendInfoAlert(chatId, text) {
  await sendToChat(INFO_CHANNEL_ID || chatId, text);
}

// ─── Milestone Helper ─────────────────────────────────────────────────────────
// Returns the highest NEW 10% milestone crossed that hasn't fired yet, or null.
// e.g. pnlPct=55, milestoneHits=[10,20] → returns 50
function getNextMilestone(pnlPct, milestoneHits = []) {
  if (pnlPct < 10) return null;
  const STEP    = 10;
  const highest = Math.floor(pnlPct / STEP) * STEP;
  for (let m = highest; m >= STEP; m -= STEP) {
    if (!milestoneHits.includes(m)) return m;
  }
  return null;
}

function milestoneEmoji(milestone) {
  if (milestone >= 100) return '🚀🚀🚀';
  if (milestone >= 70)  return '🚀🚀';
  if (milestone >= 40)  return '🚀';
  if (milestone >= 20)  return '🟢🟢';
  return '🟢';
}

async function checkPosition(pos, userId) {
  const targetChatId = userId || pos.chatId || process.env.TELEGRAM_CHAT_ID;
  const { candles1h, candles4h, currentPrice } = await fetchCurrentData(pos.symbol);

  const pnlPct          = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
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

  if (sl && !pos.stopLossPrice) {
    await updatePosition(pos.chatId, pos.positionId, { stopLossPrice: sl });
  }

  if (currentPrice > (pos.highestPrice || pos.buyPrice)) {
    await updatePosition(pos.chatId, pos.positionId, { highestPrice: currentPrice });
  }

  // ── MILESTONE ALERTS ──────────────────────────────────────────────────────
  // ACTION channel: 50%, 100%, 150% (round milestones — consider selling)
  // INFO channel:   10%, 20%, 30%, 40% (and any other non-round milestones)
  const milestoneHits = pos.milestoneHits || [];
  const nextMilestone = getNextMilestone(pnlPct, milestoneHits);
  let milestoneAlerted = false;

  if (nextMilestone !== null) {
    const emoji      = milestoneEmoji(nextMilestone);
    const nextTarget = nextMilestone + 10;
    const nextPrice  = (pos.buyPrice * (1 + nextTarget / 100)).toFixed(6);
    const isRound    = nextMilestone % 50 === 0; // 50, 100, 150 …

    // Show ceiling target status if one exists and hasn't been hit yet
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
      // 50 / 100 / 150 … → ACTION channel (same as stop loss / TP alerts)
      await sendAlert(targetChatId, milestoneMsg);
    } else {
      // 10 / 20 / 30 / 40 … → INFO channel
      await sendInfoAlert(targetChatId, milestoneMsg);
    }

    // Record so this milestone never fires again
    await updatePosition(pos.chatId, pos.positionId, {
      milestoneHits: [...milestoneHits, nextMilestone],
    });
    milestoneAlerted = true;
  }

  // ── CUSTOM TARGET HIT (ceiling) ───────────────────────────────────────────
  if (pos.targetMultiple && pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    const ceilingPct  = (pos.targetMultiple - 1) * 100;
    const targetLabel = Number.isInteger(ceilingPct)
      ? `+${ceilingPct}% (${pos.targetMultiple}X)`
      : `${pos.targetMultiple}X`;

    await sendAlert(targetChatId, [
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
  if (tp3 && currentPrice >= tp3.price && !pos.tp3Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp3Hit: true });
    await sendAlert(targetChatId, [
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

  // ── TP2 HIT ───────────────────────────────────────────────────────────────
  if (tp2 && currentPrice >= tp2.price && pnlPct > 0 && !pos.tp2Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp2Hit: true });
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
        ? `🎯 Target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP3 at \`$${tp3?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP2', alerted: true };
  }

  // ── TP1 HIT ───────────────────────────────────────────────────────────────
  if (tp1 && currentPrice >= tp1.price && pnlPct > 0 && !pos.tp1Hit) {
    await updatePosition(pos.chatId, pos.positionId, { tp1Hit: true });
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
        ? `🎯 Target at \`$${pos.targetPrice.toFixed(6)}\` — still watching.`
        : `🎯 Next: TP2 at \`$${tp2?.price.toFixed(4)}\``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join('\n'));
    return { recommendation: 'TP1', alerted: true };
  }

  // ── HOLD — send every 4 hours only → INFO channel ────────────────────────
  const lastChecked     = pos.lastChecked ? new Date(pos.lastChecked).getTime() : 0;
  const hoursSinceCheck = (Date.now() - lastChecked) / (1000 * 60 * 60);

  if (hoursSinceCheck >= 4) {
    const distToTarget = pos.targetPrice
      ? `${(((pos.targetPrice - currentPrice) / currentPrice) * 100).toFixed(1)}% away`
      : null;

    const nextMs      = Math.ceil(Math.max(pnlPct, 0) / 10) * 10 || 10;
    const nextMsPrice = (pos.buyPrice * (1 + nextMs / 100)).toFixed(6);

    await sendInfoAlert(targetChatId, [
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

    const results = [];
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
      success: true, checked: results.length,
      results, checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};