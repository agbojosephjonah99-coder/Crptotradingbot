const axios = require('axios');

const BASE_URL = 'https://api.binance.com/api/v3';

async function fetchHistoricalKlines(symbol, interval, limit = 500) {
  const response = await axios.get(`${BASE_URL}/klines`, {
    params: { symbol, interval, limit }
  });
  return response.data.map(candle => ({
    time: new Date(candle[0]).toISOString().slice(0, 16).replace('T', ' '),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5])
  }));
}

async function fetchLatestPrice(symbol) {
  const response = await axios.get(`${BASE_URL}/ticker/price`, {
    params: { symbol }
  });
  return Number(response.data.price);
}

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return [];
  }

  const k = 2 / (period + 1);
  const ema = [];
  let sum = 0;

  for (let i = 0; i < period; i += 1) {
    sum += values[i];
  }

  let previousEma = sum / period;
  ema[period - 1] = previousEma;

  for (let i = period; i < values.length; i += 1) {
    const value = values[i];
    previousEma = value * k + previousEma * (1 - k);
    ema[i] = previousEma;
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) {
    return [];
  }

  const deltas = [];
  for (let i = 1; i < values.length; i += 1) {
    deltas.push(values[i] - values[i - 1]);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i += 1) {
    const delta = deltas[i];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  const rsi = [];
  let averageGain = gains / period;
  let averageLoss = losses / period;
  rsi[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let i = period; i < deltas.length; i += 1) {
    const delta = deltas[i];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;

    rsi[i + 1] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }

  return rsi;
}

async function evaluateSymbol(symbol) {
  const [fourHour, oneHour, fifteenMin] = await Promise.all([
    fetchHistoricalKlines(symbol, '4h', 250),
    fetchHistoricalKlines(symbol, '1h', 120),
    fetchHistoricalKlines(symbol, '15m', 20)
  ]);

  if (!Array.isArray(fourHour) || !Array.isArray(oneHour) || !Array.isArray(fifteenMin)) {
    return { signal: 'WAIT', score: 0, reason: 'insufficient data' };
  }

  if (fourHour.length < 200 || oneHour.length < 50 || fifteenMin.length < 2) {
    return { signal: 'WAIT', score: 0, reason: 'insufficient data' };
  }

  const last4h = fourHour[fourHour.length - 1];
  const fourHourCloses = fourHour.map(c => c.close);
  const ema200Series = calculateEMA(fourHourCloses, 200);
  const ema200 = ema200Series[fourHour.length - 1];

  if (ema200 === undefined) {
    return { signal: 'WAIT', score: 0, reason: 'incomplete 4h indicators' };
  }

  const trend = last4h.close > ema200 ? 'UP' : last4h.close < ema200 ? 'DOWN' : 'WAIT';
  if (trend === 'WAIT') {
    return { signal: 'WAIT', score: 0, reason: 'no 4h trend' };
  }

  const last1h = oneHour[oneHour.length - 1];
  const oneHourCloses = oneHour.map(c => c.close);
  const ema50Series = calculateEMA(oneHourCloses, 50);
  const rsiSeries = calculateRSI(oneHourCloses, 14);
  const ema50 = ema50Series[oneHour.length - 1];
  const rsi = rsiSeries[oneHour.length - 1];

  if (ema50 === undefined || rsi === undefined) {
    return { signal: 'WAIT', score: 0, reason: 'incomplete 1h indicators' };
  }

  const current15m = fifteenMin[fifteenMin.length - 1];
  const previous15m = fifteenMin[fifteenMin.length - 2];
  const current15mClose = current15m.close;

  const isPullback = Math.abs(last1h.close - ema50) / ema50 <= 0.02;
  const isRsiValid = trend === 'UP' ? rsi >= 40 && rsi <= 50 : rsi >= 50 && rsi <= 60;

  const bullishBreakout = current15mClose > previous15m.high;
  const bearishBreakout = current15mClose < previous15m.low;
  const bullishEngulfing = current15m.open < previous15m.close && current15mClose > previous15m.open && (current15mClose - current15m.open) > Math.abs(previous15m.close - previous15m.open);
  const bearishEngulfing = current15m.open > previous15m.close && current15mClose < previous15m.open && (current15m.open - current15mClose) > Math.abs(previous15m.close - previous15m.open);

  const confirmation = trend === 'UP'
    ? bullishBreakout || bullishEngulfing
    : bearishBreakout || bearishEngulfing;

  let score = 0;
  if (trend === 'UP' || trend === 'DOWN') score += 3;
  if (isPullback) score += 2;
  if (isRsiValid) score += 1;
  if (confirmation) score += 3;

  const signal = score >= 6
    ? (trend === 'UP' ? 'BUY' : 'SELL')
    : 'WAIT';

  return {
    symbol,
    signal,
    score,
    trend,
    price: current15mClose,
    ema50,
    ema200,
    rsi,
    confirmation,
    confirmationType: trend === 'UP' ? (bullishBreakout || bullishEngulfing ? 'bullish' : 'none') : (bearishBreakout || bearishEngulfing ? 'bearish' : 'none'),
    time: current15m.time,
    previousHigh: previous15m.high,
    previousLow: previous15m.low
  };
}

module.exports = async (req, res) => {
  try {
    const symbols = (process.env.BINANCE_SYMBOLS || 'SOLUSDT').split(',').map(s => s.trim().toUpperCase());
    const results = [];

    for (const symbol of symbols) {
      const signalData = await evaluateSymbol(symbol);
      results.push(signalData);
    }

    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
