/**
 * ─── Quick Price Check ────────────────────────────────────────────────────────
 * GET /api/v2quickcheck?key=CRON_SECRET     (run every 10 min via cron-job.org)
 *
 * Price-only check of custom target and stop loss — no candles, very fast —
 * so a coin that spikes and dumps inside 30 minutes still triggers an alert.
 * v2monitor (every 30 min) handles TPs, milestones and HOLD updates.
 *
 * Fixes:
 *  - Uses the stop loss locked on the position (same one v2monitor uses).
 *  - "Approaching target" now fires once per position instead of every 10 min.
 *  - Alerts go only to the position owner.
 */

const { getAllUsersPositions, updatePosition } = require('../src/services/positionStore');
const { fetchPrice } = require('../src/lib/market');
const tg = require('../src/lib/telegram');
const { cors, requireCronKey } = require('../src/lib/auth');

const APPROACH_PCT = 5;

function fmtPrice(p) {
  return p < 0.01 ? p.toFixed(8) : p.toFixed(4);
}

/** Pure decision for one position at a given price. */
function evaluateQuick(pos, currentPrice) {
  const pnlPct   = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
  const multiple = currentPrice / pos.buyPrice;
  const priceStr = fmtPrice(currentPrice);
  const coin     = pos.symbol.replace('USDT', '');

  if (pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    return {
      event: 'TARGET_HIT',
      updates: { targetHit: true },
      text: [
        `🚨🎯🚨 *${pos.targetMultiple}X TARGET HIT — ${pos.symbol}* 🚨🎯🚨`,
        ``,
        `🌕 *SELL NOW — YOUR TARGET HAS BEEN REACHED*`,
        ``,
        `💰 *Bought at:*   \`$${pos.buyPrice}\``,
        `📊 *Now:*         \`$${priceStr}\``,
        `📈 *Your gain:*   +${pnlPct.toFixed(2)}% (${multiple.toFixed(2)}X)`,
        pos.quantity ? `💵 *Est. profit:* $${((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2)}` : '',
        ``,
        `🔴 *DO THIS RIGHT NOW:*`,
        `  1. Open your exchange immediately`,
        `  2. Sell 60% of your position at market price`,
        `  3. Set stop on remaining 40% at your entry ($${pos.buyPrice})`,
        `  4. If price keeps rising → let it run 🚀`,
        `  5. If price drops back → sell the rest`,
        ``,
        `📝 Record your sale: \`sold ${coin} ${pos.buyPrice} ${priceStr}\``,
        `⏰ ${new Date().toUTCString()}`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (pos.stopLossPrice && !pos.stopLossHit && currentPrice <= pos.stopLossPrice) {
    return {
      event: 'STOP_LOSS',
      updates: { stopLossHit: true },
      text: [
        `🔴 *STOP LOSS HIT — EXIT NOW — ${pos.symbol}*`,
        ``,
        `💰 *Bought at:* \`$${pos.buyPrice}\``,
        `🛡 *Stop:*      \`$${fmtPrice(pos.stopLossPrice)}\``,
        `📊 *Now:*       \`$${priceStr}\``,
        `📉 *Loss:*      ${pnlPct.toFixed(2)}%`,
        ``,
        `🔴 *Sell 100% immediately. No hesitation.*`,
        `_A small controlled loss now prevents a catastrophic loss later._`,
        ``,
        `📝 Record your exit: \`sold ${coin} ${pos.buyPrice} ${priceStr}\``,
        `⏰ ${new Date().toUTCString()}`,
      ].join('\n'),
    };
  }

  if (pos.targetPrice && !pos.targetHit && !pos.approachAlerted) {
    const distPct = ((pos.targetPrice - currentPrice) / currentPrice) * 100;
    if (distPct > 0 && distPct <= APPROACH_PCT) {
      return {
        event: 'APPROACHING_TARGET',
        updates: { approachAlerted: true },
        text: [
          `⚡ *APPROACHING TARGET — ${pos.symbol}*`,
          ``,
          `💰 Bought at: \`$${pos.buyPrice}\``,
          `📊 Now:       \`$${priceStr}\``,
          `🎯 Target:    \`$${fmtPrice(pos.targetPrice)}\` (${pos.targetMultiple}X)`,
          `📏 Distance:  ${distPct.toFixed(1)}% away`,
          ``,
          `Get ready to sell when target hits.`,
          `Open your exchange now so you are ready.`,
        ].join('\n'),
      };
    }
  }

  return null;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  try {
    const positions = await getAllUsersPositions();
    const active = positions.filter(p =>
      !p.targetHit && !p.stopLossHit && (p.targetPrice || p.stopLossPrice)
    );

    if (active.length === 0) {
      return res.status(200).json({ success: true, message: 'No active targets to check', checkedAt: new Date().toISOString() });
    }

    // Group by symbol to avoid duplicate price fetches
    const symbolMap = {};
    for (const pos of active) (symbolMap[pos.symbol] = symbolMap[pos.symbol] || []).push(pos);

    const results = [];
    for (const [symbol, list] of Object.entries(symbolMap)) {
      const currentPrice = await fetchPrice(symbol);
      if (!currentPrice) { results.push({ symbol, error: 'Could not fetch price' }); continue; }

      for (const pos of list) {
        const outcome = evaluateQuick(pos, currentPrice);
        if (!outcome) continue;
        await tg.send(pos.chatId, outcome.text);
        await updatePosition(pos.chatId, pos.positionId, outcome.updates);
        results.push({ symbol, positionId: pos.positionId, event: outcome.event, price: currentPrice });
      }
    }

    return res.status(200).json({
      success:   true,
      checked:   active.length,
      symbols:   Object.keys(symbolMap).length,
      alerts:    results.filter(r => r.event),
      errors:    results.filter(r => r.error),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[QuickCheck]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports.evaluateQuick = evaluateQuick;
