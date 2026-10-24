/**
 * ─── Market data (single shared copy) ────────────────────────────────────────
 * Candles:  Binance → Kraken fallback (Binance blocks some regions).
 * Price:    Binance → KuCoin → Kraken fallback.
 *
 * Candle shape everywhere: { time (ms, candle open), open, high, low, close, volume }
 */

const axios = require('axios');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';
const KUCOIN_BASE  = 'https://api.kucoin.com/api/v1';

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

const KRAKEN_INTERVAL_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

// Binance symbol → Kraken pair (anything not listed: SOLUSDT → SOLUSD)
const KRAKEN_MAP = {
  BTCUSDT: 'XBTUSD', BTCUSD: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD', BNBUSDT: 'BNBUSD',
  XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', DOGEUSDT: 'DOGEUSD', AVAXUSDT: 'AVAXUSD',
  DOTUSDT: 'DOTUSD', MATICUSDT: 'MATICUSD', LINKUSDT: 'LINKUSD', LTCUSDT: 'LTCUSD',
  UNIUSDT: 'UNIUSD', ATOMUSDT: 'ATOMUSD', NEARUSDT: 'NEARUSD', APTUSDT: 'APTUSD',
  SUIUSDT: 'SUIUSD', INJUSDT: 'INJUSD', ARBUSDT: 'ARBUSD', OPUSDT: 'OPUSD',
};

function toKrakenPair(symbol) {
  const u = String(symbol).toUpperCase();
  if (KRAKEN_MAP[u]) return KRAKEN_MAP[u];
  return u.endsWith('USDT') ? u.slice(0, -1) : u;
}

function toKuCoinSymbol(symbol) {
  const u = String(symbol).toUpperCase();
  return u.endsWith('USDT') ? `${u.slice(0, -4)}-USDT` : u;
}

function parseBinance(rows) {
  return rows.map(c => ({
    time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
  }));
}

/** Binance klines with paging for limit > 1000. */
async function binanceKlines(symbol, interval, limit, startTime = null) {
  if (!INTERVAL_MS[interval]) throw new Error(`Unsupported interval: ${interval}`);
  const out = [];
  const batch = 1000;
  let remaining = limit;
  let nextStart = startTime;
  if (!nextStart && limit > batch) nextStart = Date.now() - INTERVAL_MS[interval] * limit;

  while (remaining > 0) {
    const reqLimit = Math.min(batch, remaining);
    const params = { symbol, interval, limit: reqLimit };
    if (nextStart) params.startTime = nextStart;
    const r = await axios.get(`${BINANCE_BASE}/klines`, { params, timeout: 12000 });
    const page = parseBinance(r.data);
    if (!page.length) break;
    out.push(...page);
    remaining -= page.length;
    if (page.length < reqLimit) break;
    nextStart = page[page.length - 1].time + INTERVAL_MS[interval];
  }
  return out.slice(-limit);
}

/** Kraken OHLC (max ~720 candles, in-progress candle dropped). */
async function krakenKlines(symbol, interval, limit) {
  const intervalMin = KRAKEN_INTERVAL_MIN[interval];
  if (!intervalMin) throw new Error(`Kraken does not support interval ${interval}`);
  const pair = toKrakenPair(symbol);
  const r = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: { pair, interval: intervalMin },
    timeout: 12000,
    headers: { 'User-Agent': 'CryptoBotV2/2.2' },
  });
  if (r.data.error && r.data.error.length) throw new Error(`Kraken: ${r.data.error.join(', ')}`);
  const key = Object.keys(r.data.result || {}).find(k => k !== 'last');
  if (!key) throw new Error(`Kraken: no OHLC data for ${pair}`);
  return r.data.result[key].slice(0, -1).slice(-limit).map(c => ({
    time: Number(c[0]) * 1000, open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]),
  }));
}

/**
 * Candles with automatic fallback.
 * @returns {Promise<{candles: Array, exchange: string}>}
 */
async function fetchKlinesWithSource(symbol, interval, limit, { startTime = null } = {}) {
  try {
    return { candles: await binanceKlines(symbol, interval, limit, startTime), exchange: 'Binance' };
  } catch (binanceErr) {
    try {
      return { candles: await krakenKlines(symbol, interval, limit), exchange: 'Kraken' };
    } catch (krakenErr) {
      throw new Error(`No candle data for ${symbol} ${interval} (Binance: ${binanceErr.message}; Kraken: ${krakenErr.message})`);
    }
  }
}

async function fetchKlines(symbol, interval, limit, opts) {
  return (await fetchKlinesWithSource(symbol, interval, limit, opts)).candles;
}

/** Latest price with fallbacks. Returns null if every source fails. */
async function fetchPrice(symbol) {
  try {
    const r = await axios.get(`${BINANCE_BASE}/ticker/price`, { params: { symbol }, timeout: 6000 });
    const p = parseFloat(r.data.price);
    if (p > 0) return p;
  } catch { /* fall through */ }

  try {
    const r = await axios.get(`${KUCOIN_BASE}/market/orderbook/level1`, { params: { symbol: toKuCoinSymbol(symbol) }, timeout: 6000 });
    const p = parseFloat(r.data?.data?.price);
    if (p > 0) return p;
  } catch { /* fall through */ }

  try {
    const r = await axios.get(`${KRAKEN_BASE}/Ticker`, { params: { pair: toKrakenPair(symbol) }, timeout: 6000 });
    const key = Object.keys(r.data?.result || {})[0];
    const p = key ? parseFloat(r.data.result[key].c[0]) : NaN;
    if (p > 0) return p;
  } catch { /* fall through */ }

  return null;
}

/** Comma-separated BINANCE_SYMBOLS → array. */
function configuredSymbols(fallback = 'SOLUSDT,BTCUSDT,ETHUSDT') {
  const raw = process.env.BINANCE_SYMBOLS || process.env.BINANCE_SYMBOL || fallback;
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/** "sol" / "SOL" / "solusdt" → "SOLUSDT" */
function normaliseSymbol(raw) {
  const u = String(raw || '').toUpperCase().trim().replace('/', '');
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

module.exports = {
  INTERVAL_MS, toKrakenPair, toKuCoinSymbol,
  fetchKlines, fetchKlinesWithSource, fetchPrice,
  configuredSymbols, normaliseSymbol,
};
