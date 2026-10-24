/**
 * Candle helpers. Candle `time` is the open time in milliseconds.
 */

function parseKlines(klines) {
  return klines.map(candle => ({
    time: Number(candle[0]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5])
  }));
}

/**
 * Index of the latest candle that had fully CLOSED by `time`.
 *
 * BUGFIX: the old version returned the candle that had merely OPENED by `time`,
 * so a 15m signal at 10:15 could "see" the 10:00–11:00 1h candle's final close
 * (look-ahead bias), which made backtests look better than reality.
 */
function getLatestClosedIndex(candles, time, intervalMs, startIndex = 0) {
  let last = -1;
  for (let i = Math.max(0, startIndex); i < candles.length; i++) {
    if (candles[i].time + intervalMs <= time) last = i;
    else break;
  }
  return last;
}

function getLatestBarBefore(candles, time, intervalMs = 0) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const idx = getLatestClosedIndex(candles, time, intervalMs);
  return idx >= 0 ? candles[idx] : null;
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
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown * 100;
}

function fmtTime(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

module.exports = {
  parseKlines,
  getLatestClosedIndex,
  getLatestBarBefore,
  getRecentSwingLow,
  getRecentSwingHigh,
  calculateMaxDrawdown,
  fmtTime
};
