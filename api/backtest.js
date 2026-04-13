const axios = require('axios');

const BASE_URL = 'https://api.binance.com/api/v3';
const RISK_PER_TRADE = 0.01;
const REWARD_MULTIPLIER = 2;
const SWING_LOOKBACK = 5;

async function fetchHistoricalKlines(symbol, interval, limit = 500, startTime = null) {
  const result = [];
  const batchLimit = 1000;
  let remaining = limit;
  let nextStartTime = startTime;

  if (!['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'].includes(interval)) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  const intervalMs = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000,
    '8h': 28800000, '12h': 43200000, '1d': 86400000
  };

  if (!nextStartTime && limit > batchLimit) {
    nextStartTime = Date.now() - intervalMs[interval] * limit;
  }

  while (remaining > 0) {
    const requestLimit = Math.min(batchLimit, remaining);
    const params = { symbol, interval, limit: requestLimit };
    if (nextStartTime) params.startTime = nextStartTime;

    const response = await axios.get(`${BASE_URL}/klines`, { params });
    const page = response.data.map(candle => ({
      time: new Date(candle[0]).toISOString().slice(0, 16).replace('T', ' '),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5])
    }));

    if (!page.length) break;
    result.push(...page);
    remaining -= page.length;

    if (page.length < requestLimit) break;
    const lastTimestamp = response.data[response.data.length - 1][0];
    nextStartTime = lastTimestamp + intervalMs[interval];
  }

  return result.slice(-limit);
}

function getLatestBarBefore(candles, time) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return null;
  }

  let last = null;
  for (const candle of candles) {
    if (candle.time <= time) {
      last = candle;
    } else {
      break;
    }
  }

  return last;
}

function getRecentSwingLow(candles, lookback = 5) {
  const slice = candles.slice(-lookback - 1, -1);
  if (slice.length === 0) return null;
  return Math.min(...slice.map(c => c.low));
}

function getRecentSwingHigh(candles, lookback = 5) {
  const slice = candles.slice(-lookback - 1, -1);
  if (slice.length === 0) return null;
  return Math.max(...slice.map(c => c.high));
}

function calculateMaxDrawdown(balanceHistory) {
  let peak = -Infinity;
  let maxDrawdown = 0;

  for (const point of balanceHistory) {
    if (point.equity > peak) {
      peak = point.equity;
    }
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return maxDrawdown * 100;
}

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

    // Simple signal evaluation (inline for self-containment)
    let signal = 'WAIT';
    let score = 0;

    if (slice4h.length >= 200 && slice1h.length >= 50 && slice15m.length >= 2) {
      const last4h = slice4h[slice4h.length - 1];
      const fourHourCloses = slice4h.map(c => c.close);
      const ema200 = fourHourCloses.slice(-200).reduce((a, b) => a + b, 0) / 200; // Simple MA

      const trend = last4h.close > ema200 ? 'UP' : last4h.close < ema200 ? 'DOWN' : 'WAIT';
      if (trend !== 'WAIT') {
        const last1h = slice1h[slice1h.length - 1];
        const oneHourCloses = slice1h.map(c => c.close);
        const ema50 = oneHourCloses.slice(-50).reduce((a, b) => a + b, 0) / 50; // Simple MA

        const current15m = slice15m[slice15m.length - 1];
        const previous15m = slice15m[slice15m.length - 2];

        const isPullback = Math.abs(last1h.close - ema50) / ema50 <= 0.02;
        const confirmation = trend === 'UP'
          ? current15m.close > previous15m.high
          : current15m.close < previous15m.low;

        score = 3; // trend
        if (isPullback) score += 2;
        if (confirmation) score += 3;

        if (score >= 6) {
          signal = trend === 'UP' ? 'BUY' : 'SELL';
        }
      }
    }

    if (!position && signal !== 'WAIT') {
      const entryPrice = next15m.open;
      const riskAmount = equity * RISK_PER_TRADE;
      const swingPrice = signal === 'BUY'
        ? getRecentSwingLow(slice15m, SWING_LOOKBACK)
        : getRecentSwingHigh(slice15m, SWING_LOOKBACK);

      if (swingPrice) {
        const stopDistance = Math.abs(entryPrice - swingPrice);
        if (stopDistance > 0) {
          const positionSize = riskAmount / stopDistance;
          const targetPrice = signal === 'BUY'
            ? entryPrice + stopDistance * REWARD_MULTIPLIER
            : entryPrice - stopDistance * REWARD_MULTIPLIER;

          position = {
            side: signal,
            entryPrice,
            stopPrice: swingPrice,
            targetPrice,
            size: positionSize,
            entryTime: next15m.time,
            entryIndex: i + 1
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

module.exports = async (req, res) => {
  try {
    const symbols = (process.env.BINANCE_SYMBOLS || 'SOLUSDT').split(',').map(s => s.trim().toUpperCase());
    const resultSets = [];

    for (const symbol of symbols) {
      const [fourHour, oneHour, fifteenMin] = await Promise.all([
        fetchHistoricalKlines(symbol, '4h', 500),
        fetchHistoricalKlines(symbol, '1h', 1500),
        fetchHistoricalKlines(symbol, '15m', 8000)
      ]);

      const results = runBacktest({ fourHour, oneHour, fifteenMin }, 10000);
      resultSets.push({ symbol, ...results });
    }

    res.status(200).json({ success: true, results: resultSets });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
