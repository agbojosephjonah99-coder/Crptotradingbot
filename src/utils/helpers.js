function parseKlines(klines) {
  return klines.map(candle => ({
    time: new Date(candle[0]).toISOString().slice(0, 16).replace('T', ' '),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5])
  }));
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

module.exports = {
  parseKlines,
  getLatestBarBefore,
  getRecentSwingLow,
  getRecentSwingHigh,
  calculateMaxDrawdown
};
