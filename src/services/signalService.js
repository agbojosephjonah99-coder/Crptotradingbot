const { calculateEMA, calculateRSI } = require('./indicatorService');

const SIGNAL_THRESHOLD = 6;
const PULLBACK_THRESHOLD = 0.02;

function evaluateSignal({ fourHour, oneHour, fifteenMin }) {
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

  const isPullback = Math.abs(last1h.close - ema50) / ema50 <= PULLBACK_THRESHOLD;
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

  const signal = score >= SIGNAL_THRESHOLD
    ? (trend === 'UP' ? 'BUY' : 'SELL')
    : 'WAIT';

  return {
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

module.exports = {
  evaluateSignal
};
