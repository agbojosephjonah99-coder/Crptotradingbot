const { evaluateSignal } = require('./signalService');
const {
  getLatestClosedIndex, getRecentSwingLow, getRecentSwingHigh, calculateMaxDrawdown, fmtTime,
} = require('../utils/helpers');
const { INTERVAL_MS } = require('../lib/market');

const RISK_PER_TRADE = 0.01;
const REWARD_MULTIPLIER = 2;
const SWING_LOOKBACK = 5;

/**
 * Multi-timeframe backtest of signalService (4h trend, 1h pullback, 15m trigger).
 *
 * Only candles that had fully closed at the decision time are visible to the
 * signal (the previous version leaked the still-forming 1h/4h candle).
 * Note: no fees or slippage are modelled yet.
 */
function runBacktest({ fourHour, oneHour, fifteenMin }, initialCapital = 10000) {
  if (!Array.isArray(fourHour) || !Array.isArray(oneHour) || !Array.isArray(fifteenMin)) {
    throw new Error('Must supply 4h, 1h, and 15m candles for backtest');
  }
  if (fourHour.length < 200 || oneHour.length < 50 || fifteenMin.length < 5) {
    throw new Error('Not enough historical candles for multi-timeframe backtest');
  }

  const results = {
    initialCapital,
    equity: initialCapital,
    balanceHistory: [],
    trades: [],
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0,
    netProfit: 0,
    maxDrawdown: 0
  };

  let position = null;
  let equity = initialCapital;
  let idx1h = -1;
  let idx4h = -1;

  for (let i = 1; i < fifteenMin.length - 1; i += 1) {
    const current15m = fifteenMin[i];
    const next15m = fifteenMin[i + 1];
    const decisionTime = current15m.time + INTERVAL_MS['15m']; // at the close of this 15m bar

    idx1h = getLatestClosedIndex(oneHour, decisionTime, INTERVAL_MS['1h'], Math.max(idx1h, 0));
    idx4h = getLatestClosedIndex(fourHour, decisionTime, INTERVAL_MS['4h'], Math.max(idx4h, 0));

    if (idx1h < 0 || idx4h < 0) {
      results.balanceHistory.push({ time: fmtTime(current15m.time), equity });
      continue;
    }

    // Manage an open position first (exits are checked from the bar after entry)
    if (position && i > position.entryIndex) {
      const exit = checkExit(position, current15m);
      if (exit) {
        const pnl = position.side === 'BUY'
          ? (exit.price - position.entryPrice) * position.size
          : (position.entryPrice - exit.price) * position.size;

        equity += pnl;
        results.trades.push({
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: exit.price,
          exitReason: exit.reason,
          entryTime: fmtTime(position.entryTime),
          exitTime: fmtTime(current15m.time),
          pnl,
          outcome: pnl >= 0 ? 'WIN' : 'LOSS'
        });
        results.totalTrades += 1;
        if (pnl >= 0) { results.wins += 1; results.grossProfit += pnl; }
        else          { results.losses += 1; results.grossLoss += pnl; }
        position = null;
      }
    }

    if (!position) {
      const slice1h = oneHour.slice(0, idx1h + 1);
      const slice4h = fourHour.slice(0, idx4h + 1);
      const slice15m = fifteenMin.slice(0, i + 1);
      const signalContext = evaluateSignal({ fourHour: slice4h, oneHour: slice1h, fifteenMin: slice15m });

      if (signalContext.signal === 'BUY' || signalContext.signal === 'SELL') {
        const entryPrice = next15m.open;
        const riskAmount = equity * RISK_PER_TRADE;
        const stopPrice = signalContext.signal === 'BUY'
          ? getRecentSwingLow(slice15m, SWING_LOOKBACK)
          : getRecentSwingHigh(slice15m, SWING_LOOKBACK);

        // Stop must be on the losing side of the entry
        const validStop = stopPrice && (signalContext.signal === 'BUY' ? stopPrice < entryPrice : stopPrice > entryPrice);
        if (validStop) {
          const stopDistance = Math.abs(entryPrice - stopPrice);
          position = {
            side: signalContext.signal,
            entryPrice,
            stopPrice,
            targetPrice: signalContext.signal === 'BUY'
              ? entryPrice + stopDistance * REWARD_MULTIPLIER
              : entryPrice - stopDistance * REWARD_MULTIPLIER,
            size: riskAmount / stopDistance,
            entryTime: next15m.time,
            entryIndex: i + 1,
          };
        }
      }
    }

    results.balanceHistory.push({ time: fmtTime(current15m.time), equity });
  }

  results.equity = equity;
  results.netProfit = equity - initialCapital;
  results.winRate = results.totalTrades > 0 ? (results.wins / results.totalTrades) * 100 : 0;
  results.profitFactor = results.grossLoss === 0
    ? (results.grossProfit > 0 ? Infinity : 0)
    : results.grossProfit / Math.abs(results.grossLoss);
  results.maxDrawdown = calculateMaxDrawdown(results.balanceHistory);

  return results;
}

function checkExit(position, candle) {
  const { side, stopPrice, targetPrice } = position;
  // If both levels are inside one candle we assume the stop hit first (conservative).
  if (side === 'BUY') {
    if (candle.low <= stopPrice) return { reason: 'stop', price: Math.min(stopPrice, candle.open) };
    if (candle.high >= targetPrice) return { reason: 'target', price: targetPrice };
  }
  if (side === 'SELL') {
    if (candle.high >= stopPrice) return { reason: 'stop', price: Math.max(stopPrice, candle.open) };
    if (candle.low <= targetPrice) return { reason: 'target', price: targetPrice };
  }
  return null;
}

module.exports = { runBacktest, checkExit };
