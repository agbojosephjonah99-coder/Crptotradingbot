const axios = require('axios');
const { sendSignalAlert } = require('../src/services/telegramService');

// Kraken public REST API — no API key, no geo-restrictions on Vercel
const KRAKEN_BASE = 'https://api.kraken.com/0/public';

// Kraken interval values are in minutes
const INTERVAL_MAP = {
  '15m': 15,
  '1h':  60,
  '4h':  240
};

// Convert "SOLUSDT" → "SOLUSD", "BTCUSDT" → "XBTUSD", etc.
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
  // Generic: strip trailing T from USDT pairs
  if (upper.endsWith('USDT')) return upper.slice(0, -1);
  return upper;
}

async function fetchKlines(krakenPair, interval, limit = 720) {
  const intervalMin = INTERVAL_MAP[interval];
  if (!intervalMin) throw new Error(`Unsupported interval: ${interval}`);

  const response = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: {
      pair: krakenPair,
      interval: intervalMin
    },
    timeout: 12000,
    headers: { 'User-Agent': 'CryptoTradingBot/1.0' }
  });

  if (response.data.error && response.data.error.length > 0) {
    throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
  }

  // Result key is usually the pair name but may differ (e.g. SOLUSD → SOLUSD)
  const resultKey = Object.keys(response.data.result).find(k => k !== 'last');
  if (!resultKey) throw new Error(`No OHLC data found for pair: ${krakenPair}`);

  const candles = response.data.result[resultKey];

  // Kraken format: [time, open, high, low, close, vwap, volume, count]
  // Already oldest-first, drop the last (in-progress) candle
  return candles.slice(0, -1).slice(-limit).map(c => ({
    time:   new Date(Number(c[0]) * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open:   Number(c[1]),
    high:   Number(c[2]),
    low:    Number(c[3]),
    close:  Number(c[4]),
    volume: Number(c[6])
  }));
}

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  ema[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    ema[i] = prev;
  }
  return ema;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return [];
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);

  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d >= 0) gains += d; else losses -= d;
  }

  const rsi = [];
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

async function evaluateSymbol(symbol) {
  const krakenPair = toKrakenPair(symbol);

  // Kraken returns max 720 candles — enough for 4h(200), 1h(120), 15m(20)
  const [fourHour, oneHour, fifteenMin] = await Promise.all([
    fetchKlines(krakenPair, '4h', 250),
    fetchKlines(krakenPair, '1h', 120),
    fetchKlines(krakenPair, '15m', 20)
  ]);

  if (fourHour.length < 200 || oneHour.length < 50 || fifteenMin.length < 2) {
    return { symbol, signal: 'WAIT', score: 0, reason: 'insufficient data' };
  }

  const last4h = fourHour[fourHour.length - 1];
  const ema200Series = calculateEMA(fourHour.map(c => c.close), 200);
  const ema200 = ema200Series[fourHour.length - 1];
  if (ema200 === undefined) return { symbol, signal: 'WAIT', score: 0, reason: 'incomplete 4h EMA' };

  const trend = last4h.close > ema200 ? 'UP' : last4h.close < ema200 ? 'DOWN' : 'WAIT';
  if (trend === 'WAIT') return { symbol, signal: 'WAIT', score: 0, reason: 'no 4h trend' };

  const last1h = oneHour[oneHour.length - 1];
  const oneHourCloses = oneHour.map(c => c.close);
  const ema50 = calculateEMA(oneHourCloses, 50)[oneHour.length - 1];
  const rsi  = calculateRSI(oneHourCloses, 14)[oneHour.length - 1];
  if (ema50 === undefined || rsi === undefined) return { symbol, signal: 'WAIT', score: 0, reason: 'incomplete 1h indicators' };

  const curr = fifteenMin[fifteenMin.length - 1];
  const prev = fifteenMin[fifteenMin.length - 2];

  const isPullback  = Math.abs(last1h.close - ema50) / ema50 <= 0.02;
  const isRsiValid  = trend === 'UP' ? (rsi >= 40 && rsi <= 50) : (rsi >= 50 && rsi <= 60);

  const bullishBreakout  = curr.close > prev.high;
  const bearishBreakout  = curr.close < prev.low;
  const bullishEngulfing = curr.open < prev.close && curr.close > prev.open && (curr.close - curr.open) > Math.abs(prev.close - prev.open);
  const bearishEngulfing = curr.open > prev.close && curr.close < prev.open && (curr.open - curr.close) > Math.abs(prev.close - prev.open);

  const confirmation = trend === 'UP' ? (bullishBreakout || bullishEngulfing) : (bearishBreakout || bearishEngulfing);
  const confirmationType = trend === 'UP'
    ? (bullishBreakout ? 'bullish_breakout' : bullishEngulfing ? 'bullish_engulfing' : 'none')
    : (bearishBreakout ? 'bearish_breakout' : bearishEngulfing ? 'bearish_engulfing' : 'none');

  let score = 3;
  if (isPullback)   score += 2;
  if (isRsiValid)   score += 1;
  if (confirmation) score += 3;

  const signal = score >= 6 ? (trend === 'UP' ? 'BUY' : 'SELL') : 'WAIT';

  return {
    symbol, signal, score, trend,
    price: curr.close, ema50, ema200, rsi,
    confirmation, confirmationType,
    time: curr.time,
    previousHigh: prev.high,
    previousLow:  prev.low
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const symbols = (process.env.BINANCE_SYMBOLS || 'SOLUSDT').split(',').map(s => s.trim().toUpperCase());
    const results = [];

    for (const symbol of symbols) {
      const signalData = await evaluateSymbol(symbol);
      results.push(signalData);

      if (signalData.signal === 'BUY' || signalData.signal === 'SELL') {
        try {
          await sendSignalAlert(signalData);
        } catch (telegramErr) {
          console.error('Telegram notification failed:', telegramErr.message);
        }
      }
    }

    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Signal API Error:', error.message);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};