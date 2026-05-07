/**
 * V2 Existing Coin Scanner
 * Multi-timeframe analysis — BUY signals only (market direction).
 * SELL/exit advice is handled by /api/v2advice (position-aware).
 *
 * Signal logic fix vs V1:
 *  - V1 issued "SELL" on a downtrend — meaning "go short", confusing for spot traders.
 *  - V2 only issues BUY when price is NOT at a peak (RSI 35–55, pulled back to EMA50).
 *  - Downtrend is reported as BEARISH_ALERT (informational), never as a trading action.
 */

const axios = require('axios');

const KRAKEN_BASE = 'https://api.kraken.com/0/public';
const BINANCE_BASE = 'https://api.binance.com/api/v3';

// ─── Kraken helpers ─────────────────────────────────────────────────────────

const KRAKEN_MAP = {
  BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD',
  BNBUSDT: 'BNBUSD', XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD',
  DOGEUSDT: 'DOGEUSD', AVAXUSDT: 'AVAXUSD', DOTUSDT: 'DOTUSD',
  LINKUSDT: 'LINKUSD', MATICUSDT: 'MATICUSD', LTCUSDT: 'LTCUSD',
  UNIUSDT: 'UNIUSD', ATOMUSDT: 'ATOMUSD', NEARUSDT: 'NEARUSD',
  APTUSDT: 'APTUSD', SUIUSDT: 'SUIUSD', INJUSDT: 'INJUSD',
  ARBUSDT: 'ARBUSD', OPUSDT: 'OPUSD',
};

function toKrakenPair(symbol) {
  const up = symbol.toUpperCase();
  if (KRAKEN_MAP[up]) return KRAKEN_MAP[up];
  if (up.endsWith('USDT')) return up.slice(0, -1);
  return up;
}

async function krakenKlines(pair, intervalMin, limit = 500) {
  const resp = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: { pair, interval: intervalMin },
    timeout: 12000,
    headers: { 'User-Agent': 'CryptoBot-V2/2.0' },
  });
  if (resp.data.error?.length) throw new Error(resp.data.error.join(', '));
  const key = Object.keys(resp.data.result).find(k => k !== 'last');
  const raw = resp.data.result[key];
  return raw.slice(0, -1).slice(-limit).map(c => ({
    time:   Number(c[0]),
    open:   Number(c[1]),
    high:   Number(c[2]),
    low:    Number(c[3]),
    close:  Number(c[4]),
    volume: Number(c[6]),
  }));
}

async function binanceKlines(symbol, interval, limit = 500) {
  const resp = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol, interval, limit },
    timeout: 12000,
  });
  return resp.data.map(c => ({
    time:   Number(c[0]),
    open:   Number(c[1]),
    high:   Number(c[2]),
    low:    Number(c[3]),
    close:  Number(c[4]),
    volume: Number(c[5]),
  }));
}

async function fetchKlines(symbol, intervalMin, intervalStr, limit) {
  // Try Binance first (more complete), fall back to Kraken
  try {
    return await binanceKlines(symbol, intervalStr, limit);
  } catch {
    return await krakenKlines(toKrakenPair(symbol), intervalMin, limit);
  }
}

// ─── Technical Indicators ────────────────────────────────────────────────────

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(undefined);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return [];
  const deltas = values.slice(1).map((v, i) => v - values[i]);
  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  const out = new Array(values.length).fill(undefined);
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i + 1] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] !== undefined && emaSlow[i] !== undefined
      ? emaFast[i] - emaSlow[i]
      : undefined
  );
  const defined = macdLine.filter(v => v !== undefined);
  const signalLine = defined.length >= signal ? ema(defined, signal) : [];
  // Align signal line to end of macdLine
  const signalAligned = new Array(macdLine.length).fill(undefined);
  let si = signalAligned.length - 1;
  for (let i = signalLine.length - 1; i >= 0; i--) {
    signalAligned[si--] = signalLine[i];
  }
  return { macdLine, signalLine: signalAligned };
}

function volumeAvg(candles, period = 20) {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period - 1, -1);
  return recent.reduce((s, c) => s + c.volume, 0) / period;
}

// ─── Signal Evaluator (V2 — BUY + BEARISH_ALERT only) ───────────────────────

function evaluateSignalV2(candles4h, candles1h, candles15m) {
  const n4 = candles4h.length;
  const n1 = candles1h.length;
  const n15 = candles15m.length;

  if (n4 < 200 || n1 < 50 || n15 < 3) {
    return { signal: 'WAIT', score: 0, confidence: 0, reason: 'insufficient data' };
  }

  // ── 4H: Macro trend ──
  const closes4h = candles4h.map(c => c.close);
  const ema200 = ema(closes4h, 200)[n4 - 1];
  const ema50_4h = ema(closes4h, 50)[n4 - 1];
  const last4h = candles4h[n4 - 1];
  const trend = last4h.close > ema200 ? 'UP' : 'DOWN';

  // ── 1H: Momentum & RSI ──
  const closes1h = candles1h.map(c => c.close);
  const ema50_1h = ema(closes1h, 50)[n1 - 1];
  const rsi1h = rsi(closes1h, 14)[n1 - 1];
  const { macdLine, signalLine } = macd(closes1h);
  const macdVal = macdLine[n1 - 1];
  const sigVal = signalLine[n1 - 1];
  const macdBullish = macdVal !== undefined && sigVal !== undefined && macdVal > sigVal;

  // ── 15M: Entry confirmation ──
  const curr = candles15m[n15 - 1];
  const prev = candles15m[n15 - 2];
  const prev2 = candles15m[n15 - 3];

  const bullishBreakout  = curr.close > prev.high && curr.close > prev2.high;
  const bullishEngulfing = curr.open < prev.close && curr.close > prev.open &&
    (curr.close - curr.open) > Math.abs(prev.close - prev.open);
  const bearishBreakout  = curr.close < prev.low;
  const bearishEngulfing = curr.open > prev.close && curr.close < prev.open &&
    (curr.open - curr.close) > Math.abs(prev.close - prev.open);

  // Volume context
  const avgVol15 = volumeAvg(candles15m, Math.min(20, n15 - 1));
  const volSurge = avgVol15 > 0 && curr.volume > avgVol15 * 1.5;

  // ── V2 BUY Score (only in uptrend) ──
  // KEY FIX: RSI must be in 35–58 — buying after pullback, not at the peak
  const rsiInBuyZone = rsi1h >= 35 && rsi1h <= 58;
  const priceNearEma50 = Math.abs(candles1h[n1 - 1].close - ema50_1h) / ema50_1h <= 0.04;

  let score = 0;
  const factors = [];

  if (trend === 'UP') {
    score += 2; factors.push('4H uptrend');

    if (rsiInBuyZone)      { score += 3; factors.push(`RSI ${rsi1h.toFixed(1)} (buy zone 35–58)`); }
    else if (rsi1h > 65)   { score -= 2; factors.push(`RSI ${rsi1h.toFixed(1)} (overbought — avoid)`); }

    if (priceNearEma50)    { score += 2; factors.push('Pulled back to EMA50'); }
    if (macdBullish)       { score += 1; factors.push('MACD bullish cross'); }
    if (bullishBreakout)   { score += 3; factors.push('15M breakout candle'); }
    else if (bullishEngulfing) { score += 2; factors.push('15M engulfing'); }
    if (volSurge)          { score += 1; factors.push('Volume surge'); }

    const confidence = Math.min(100, Math.round((score / 12) * 100));
    const signal = score >= 7 ? 'BUY' : 'WAIT';

    // Entry / SL / TP
    const entryPrice = curr.close;
    const stopLoss   = Math.min(prev.low, prev2.low) * 0.995;  // just below recent swing low
    const riskPct    = (entryPrice - stopLoss) / entryPrice;
    const takeProfit1 = entryPrice * (1 + riskPct * 1.5);  // 1.5R
    const takeProfit2 = entryPrice * (1 + riskPct * 3);    // 3R

    return {
      signal, score, confidence, trend, factors,
      price: entryPrice, ema50: ema50_1h, ema200, rsi: rsi1h,
      entryPrice, stopLoss, takeProfit1, takeProfit2,
      macdBullish, volSurge,
      candleType: bullishBreakout ? 'BREAKOUT' : bullishEngulfing ? 'ENGULFING' : 'NONE',
    };
  }

  // Downtrend → report as BEARISH_ALERT (not SELL — user may have no short position)
  const bearishScore = (bearishBreakout ? 2 : 0) + (bearishEngulfing ? 1 : 0);
  return {
    signal: 'BEARISH_ALERT',
    score: bearishScore,
    confidence: Math.round((bearishScore / 5) * 100),
    trend: 'DOWN',
    factors: ['4H downtrend', rsi1h < 30 ? 'RSI oversold — possible reversal ahead' : `RSI ${rsi1h?.toFixed(1)}`],
    price: curr.close, ema50: ema50_1h, ema200, rsi: rsi1h,
    entryPrice: null, stopLoss: null, takeProfit1: null, takeProfit2: null,
    macdBullish, volSurge,
    candleType: bearishBreakout ? 'BREAKDOWN' : bearishEngulfing ? 'BEAR_ENGULF' : 'NONE',
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const rawSymbols = process.env.BINANCE_SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT';
    const symbols = rawSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const results = [];

    for (const symbol of symbols) {
      try {
        const [c4h, c1h, c15m] = await Promise.all([
          fetchKlines(symbol, 240, '4h', 250),
          fetchKlines(symbol, 60,  '1h', 120),
          fetchKlines(symbol, 15,  '15m', 30),
        ]);
        const sig = evaluateSignalV2(c4h, c1h, c15m);
        results.push({ symbol, ...sig, scannedAt: new Date().toISOString() });
      } catch (err) {
        results.push({ symbol, signal: 'ERROR', error: err.message, score: 0, confidence: 0 });
      }
    }

    res.status(200).json({ success: true, count: results.length, results, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
