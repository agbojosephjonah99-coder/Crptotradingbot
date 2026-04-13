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

module.exports = {
  calculateEMA,
  calculateRSI
};
