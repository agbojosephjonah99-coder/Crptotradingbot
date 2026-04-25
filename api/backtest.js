const axios = require('axios');

// Kraken public REST API — no API key, no geo-restrictions on Vercel
const KRAKEN_BASE = 'https://api.kraken.com/0/public';

const RISK_PER_TRADE    = 0.01;
const REWARD_MULTIPLIER = 2;
const SWING_LOOKBACK    = 5;

const INTERVAL_MAP = {
  '15m': 15,
  '1h':  60,
  '4h':  240
};

function toKrakenPair(symbol) {
  const map = {
    'BTCUSDT':  'XBTUSD',
    'BTCUSD':   'XBTUSD',
    'ETHUSDT':  'ETHUSD',
    'ETHUSD':   'ETHUSD',
    'SOLUSDT':  'SOLUSD',
    'SOLUSD':   'SOLUSD',
    'BNBUSDT':  'BNBUSD',
    'XRPUSDT':  'XRPUSD',
    'ADAUSDT':  'ADAUSD',
    'DOGEUSDT': 'DOGEUSD',
    'AVAXUSDT': 'AVAXUSD',
    'DOTUSDT':  'DOTUSD',
    'MATICUSDT':'MATICUSD',
    'LINKUSDT': 'LINKUSD',
  };
  const upper = symbol.toUpperCase();
  if (map[upper]) return map[upper];
  if (upper.endsWith('USDT')) return upper.slice(0, -1);
  return upper;
}

async function fetchKlines(krakenPair, interval, limit = 720) {
  const intervalMin = INTERVAL_MAP[interval];
  if (!intervalMin) throw new Error(`Unsupported interval: ${interval}`);

  const response = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: { pair: krakenPair, interval: intervalMin },
    timeout: 15000,
    headers: { 'User-Agent': 'CryptoTradingBot/1.0' }
  });

  if (response.data.error && response.data.error.length > 0) {
    throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
  }

  const resultKey = Object.keys(response.data.result).find(k => k !== 'last');
  if (!resultKey) throw new Error(`No OHLC data found for pair: ${krakenPair}`);

  const candles = response.data.result[resultKey];

  // Kraken format: [time, open, high, low, close, vwap, volume, count]
  // Drop the last (in-progress) candle
  return candles.slice(0, -1).slice(-limit).map(c => ({
    time:   new Date(Number(c[0]) * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open:   Number(c[1]),
    high:   Number(c[2]),
    low:    Number(c[3]),
    close:  Number(c[4]),
    volume: Number(c[6])
  }));
}

function getLatestBarBefore(candles, time) {
  let last = null;
  for (const candle of candles) {
    if (candle.time <= time) last = candle;
    else break;
  }
  return last;
}

function getRecentSwingLow(candles, lookback = 5) {
  const slice = candles.slice(-lookback - 1, -1);
  return slice.length === 0 ? null : Math.min(...slice.map(c => c.low));
}

function getRecentSwingHigh(candles, lookback = 5) {
  const slice = candles.slice(-lookback - 1, -1);
  return slice.length === 0 ? null : Math.max(...slice.map(c => c.high));
}

function calculateMaxDrawdown(balanceHistory) {
  let peak = -Infinity, maxDrawdown = 0;
  for (const point of balanceHistory) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown * 100;
}

function checkExit(position, candle) {
  const { side, stopPrice, targetPrice } = position;
  if (side === 'BUY') {
    if (candle.low  <= stopPrice)   return { reason: 'stop',   price: stopPrice };
    if (candle.high >= targetPrice) return { reason: 'target', price: targetPrice };
  }
  if (side === 'SELL') {
    if (candle.high >= stopPrice)  return { reason: 'stop',   price: stopPrice };
    if (candle.low  <= targetPrice) return { reason: 'target', price: targetPrice };
  }
  return null;
}

function runBacktest({ fourHour, oneHour, fifteenMin }, initialCapital = 10000) {
  if (fourHour.length < 200 || oneHour.length < 50 || fifteenMin.length < 5) {
    throw new Error('Not enough historical candles for backtest (need 4h×200, 1h×50, 15m×5)');
  }

  const results = {
    initialCapital, equity: initialCapital,
    balanceHistory: [], trades: [],
    totalTrades: 0, wins: 0, losses: 0,
    winRate: 0, grossProfit: 0, grossLoss: 0,
    profitFactor: 0, netProfit: 0, maxDrawdown: 0
  };

  let position = null;
  let equity = initialCapital;

  for (let i = 1; i < fifteenMin.length - 1; i++) {
    const current15m = fifteenMin[i];
    const next15m    = fifteenMin[i + 1];
    const base1h     = getLatestBarBefore(oneHour, current15m.time);
    const base4h     = getLatestBarBefore(fourHour, current15m.time);

    if (!base1h || !base4h || !next15m) {
      results.balanceHistory.push({ time: current15m.time, equity });
      continue;
    }

    const slice1h  = oneHour.slice(0, oneHour.indexOf(base1h) + 1);
    const slice4h  = fourHour.slice(0, fourHour.indexOf(base4h) + 1);
    const slice15m = fifteenMin.slice(0, i + 1);

    let signal = 'WAIT';

    if (slice4h.length >= 200 && slice1h.length >= 50 && slice15m.length >= 2) {
      const last4h  = slice4h[slice4h.length - 1];
      const ema200  = slice4h.map(c => c.close).slice(-200).reduce((a, b) => a + b, 0) / 200;
      const trend   = last4h.close > ema200 ? 'UP' : last4h.close < ema200 ? 'DOWN' : 'WAIT';

      if (trend !== 'WAIT') {
        const last1h  = slice1h[slice1h.length - 1];
        const ema50   = slice1h.map(c => c.close).slice(-50).reduce((a, b) => a + b, 0) / 50;
        const curr    = slice15m[slice15m.length - 1];
        const prev    = slice15m[slice15m.length - 2];

        const isPullback   = Math.abs(last1h.close - ema50) / ema50 <= 0.02;
        const confirmation = trend === 'UP' ? curr.close > prev.high : curr.close < prev.low;

        let score = 3;
        if (isPullback)   score += 2;
        if (confirmation) score += 3;

        if (score >= 6) signal = trend === 'UP' ? 'BUY' : 'SELL';
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
          const targetPrice  = signal === 'BUY'
            ? entryPrice + stopDistance * REWARD_MULTIPLIER
            : entryPrice - stopDistance * REWARD_MULTIPLIER;

          position = {
            side: signal, entryPrice,
            stopPrice: swingPrice, targetPrice,
            size: positionSize,
            entryTime: next15m.time, entryIndex: i + 1
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
        results.trades.push({
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice:  exit.price,
          entryTime:  position.entryTime,
          exitTime:   current15m.time,
          pnl,
          outcome: pnl >= 0 ? 'WIN' : 'LOSS'
        });
        results.totalTrades++;
        if (pnl >= 0) { results.wins++;   results.grossProfit += pnl; }
        else          { results.losses++; results.grossLoss   += pnl; }
        position = null;
      }
    }

    results.balanceHistory.push({ time: current15m.time, equity });
  }

  results.equity       = equity;
  results.netProfit    = equity - initialCapital;
  results.winRate      = results.totalTrades > 0 ? (results.wins / results.totalTrades) * 100 : 0;
  results.profitFactor = results.grossLoss === 0
    ? (results.grossProfit > 0 ? Infinity : 0)
    : results.grossProfit / Math.abs(results.grossLoss);
  results.maxDrawdown  = calculateMaxDrawdown(results.balanceHistory);

  return results;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const symbols = (process.env.BINANCE_SYMBOLS || 'SOLUSDT').split(',').map(s => s.trim().toUpperCase());
    const resultSets = [];

    for (const symbol of symbols) {
      const krakenPair = toKrakenPair(symbol);

      // Kraken max is 720 candles per call — use all available
      const [fourHour, oneHour, fifteenMin] = await Promise.all([
        fetchKlines(krakenPair, '4h', 720),
        fetchKlines(krakenPair, '1h', 720),
        fetchKlines(krakenPair, '15m', 720)
      ]);

      const backtestResults = runBacktest({ fourHour, oneHour, fifteenMin }, 10000);
      resultSets.push({ symbol, krakenPair, ...backtestResults });
    }

    res.status(200).json({ success: true, results: resultSets });
  } catch (error) {
    console.error('Backtest API Error:', error.message);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};