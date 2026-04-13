const { evaluateSignal } = require('./signalService');
const { getLatestBarBefore, getRecentSwingLow, getRecentSwingHigh, calculateMaxDrawdown } = require('../utils/helpers');

const RISK_PER_TRADE = 0.01;
const REWARD_MULTIPLIER = 2;
const SWING_LOOKBACK = 5;

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

  for (let i = 1; i < fifteenMin.length - 1; i += 1) {
    const current15m = fifteenMin[i];
    const next15m = fifteenMin[i + 1];
    const base1h = getLatestBarBefore(oneHour, current15m.time);
    const base4h = getLatestBarBefore(fourHour, current15m.time);

    if (!base1h || !base4h || !next15m) {
      results.balanceHistory.push({ time: current15m.time, equity });
      continue;
    }

    const slice1h = oneHour.slice(0, oneHour.indexOf(base1h) + 1);
    const slice4h = fourHour.slice(0, fourHour.indexOf(base4h) + 1);
    const slice15m = fifteenMin.slice(0, i + 1);
    const signalContext = evaluateSignal({ fourHour: slice4h, oneHour: slice1h, fifteenMin: slice15m });

    if (!position && signalContext.signal !== 'WAIT') {
      const entryPrice = next15m.open;
      const riskAmount = equity * RISK_PER_TRADE;
      const swingPrice = signalContext.signal === 'BUY'
        ? getRecentSwingLow(slice15m, SWING_LOOKBACK)
        : getRecentSwingHigh(slice15m, SWING_LOOKBACK);

      if (swingPrice) {
        const stopDistance = Math.abs(entryPrice - swingPrice);
        if (stopDistance > 0) {
          const positionSize = riskAmount / stopDistance;
          const targetPrice = signalContext.signal === 'BUY'
            ? entryPrice + stopDistance * REWARD_MULTIPLIER
            : entryPrice - stopDistance * REWARD_MULTIPLIER;

          position = {
            side: signalContext.signal,
            entryPrice,
            stopPrice: swingPrice,
            targetPrice,
            size: positionSize,
            entryTime: next15m.time,
            entryIndex: i + 1,
            signalTime: signalContext.time
          };
        }
      }
    }

    if (position && i > position.entryIndex) {
      const exit = checkExit(position, current15m);
      if (exit) {
        const pnl = position.side === 'BUY'
          ? (exit.price - position.entryPrice) * position.size
          : (position.entryPrice - exit.price) * position.size;

        equity += pnl;
        const trade = {
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: exit.price,
          entryTime: position.entryTime,
          exitTime: current15m.time,
          pnl,
          outcome: pnl >= 0 ? 'WIN' : 'LOSS'
        };

        results.trades.push(trade);
        results.totalTrades += 1;
        if (pnl >= 0) {
          results.wins += 1;
          results.grossProfit += pnl;
        } else {
          results.losses += 1;
          results.grossLoss += pnl;
        }

        position = null;
      }
    }

    results.balanceHistory.push({ time: current15m.time, equity });
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

  if (side === 'BUY') {
    const stopHit = candle.low <= stopPrice;
    const targetHit = candle.high >= targetPrice;
    if (stopHit) return { reason: 'stop', price: stopPrice };
    if (targetHit) return { reason: 'target', price: targetPrice };
  }

  if (side === 'SELL') {
    const stopHit = candle.high >= stopPrice;
    const targetHit = candle.low <= targetPrice;
    if (stopHit) return { reason: 'stop', price: stopPrice };
    if (targetHit) return { reason: 'target', price: targetPrice };
  }

  return null;
}

module.exports = {
  runBacktest
};
