/**
 * V2 Position Advice API
 * 
 * The user tells us: "I bought SOLUSDT at $150"
 * We fetch current market data and return:
 *   - Current P&L
 *   - Recommendation: HOLD / TAKE_PROFIT / STOP_LOSS / TRAIL_STOP / CLOSE_PARTIAL
 *   - Best exit strategy with reasoning
 *   - Next price targets (resistance levels)
 *
 * POST /api/v2advice
 * Body: { symbol, buyPrice, quantity (optional), takeProfitPct (optional), stopLossPct (optional) }
 *
 * GET /api/v2advice?symbol=SOLUSDT&buyPrice=150
 * (for easy browser testing)
 */

const axios = require('axios');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';

const KRAKEN_MAP = {
  BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD',
  BNBUSDT: 'BNBUSD', XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD',
  DOGEUSDT: 'DOGEUSD', AVAXUSDT: 'AVAXUSD', LINKUSDT: 'LINKUSD',
};

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
    const d = deltas[i]; if (d > 0) avgG += d; else avgL -= d;
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

// Find recent swing highs as resistance levels
function findResistanceLevels(candles, lookback = 20) {
  const levels = [];
  for (let i = 2; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      levels.push(candles[i].high);
    }
  }
  return [...new Set(levels)].sort((a, b) => a - b).slice(-lookback);
}

async function fetchCurrentData(symbol) {
  // Try Binance first
  try {
    const [klines1h, price] = await Promise.all([
      axios.get(`${BINANCE_BASE}/klines`, {
        params: { symbol, interval: '1h', limit: 100 },
        timeout: 12000,
      }),
      axios.get(`${BINANCE_BASE}/ticker/price`, {
        params: { symbol },
        timeout: 8000,
      }),
    ]);
    const candles = klines1h.data.map(c => ({
      time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
      low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
    }));
    return { candles, currentPrice: parseFloat(price.data.price), exchange: 'Binance' };
  } catch {
    // Fallback to Kraken
    const krakenPair = KRAKEN_MAP[symbol.toUpperCase()] || symbol.replace('USDT', 'USD');
    const resp = await axios.get(`${KRAKEN_BASE}/OHLC`, {
      params: { pair: krakenPair, interval: 60 },
      timeout: 12000,
    });
    const key = Object.keys(resp.data.result).find(k => k !== 'last');
    const candles = resp.data.result[key].slice(-100).map(c => ({
      time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
      low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]),
    }));
    const currentPrice = candles[candles.length - 1].close;
    return { candles, currentPrice, exchange: 'Kraken' };
  }
}

function buildAdvice({ symbol, buyPrice, currentPrice, candles, takeProfitPct, stopLossPct }) {
  const closes = candles.map(c => c.close);
  const n = closes.length;

  const rsiNow = rsi(closes, 14)[n - 1];
  const ema50Now = ema(closes, 50)[n - 1];
  const ema20Now = ema(closes, 20)[n - 1];

  const pnlPct  = ((currentPrice - buyPrice) / buyPrice) * 100;
  const pnlSign = pnlPct >= 0 ? '+' : '';

  // User-defined or default thresholds
  const tp  = takeProfitPct  || 8;   // default 8% take profit
  const sl  = stopLossPct    || 5;   // default 5% stop loss

  const tpPrice = buyPrice * (1 + tp / 100);
  const slPrice = buyPrice * (1 - sl / 100);

  // Resistance levels above buy price
  const allResistance = findResistanceLevels(candles);
  const resistanceAbove = allResistance.filter(r => r > currentPrice).slice(0, 3);
  const resistanceBelow = allResistance.filter(r => r < currentPrice).slice(-2);

  // ── Decision logic ──────────────────────────────────────────────────────

  let recommendation = 'HOLD';
  let urgency = 'LOW';
  const reasons = [];
  const actions = [];

  // 1. Stop loss hit — sell immediately to preserve capital
  if (currentPrice <= slPrice) {
    recommendation = 'STOP_LOSS';
    urgency = 'CRITICAL';
    reasons.push(`Price dropped ${Math.abs(pnlPct).toFixed(2)}% from your buy price of $${buyPrice}`);
    reasons.push(`Your stop-loss level ($${slPrice.toFixed(4)}) has been breached`);
    actions.push('Exit the trade NOW to prevent further losses');
    actions.push('Do not wait — the trend is working against you');
  }
  // 2. Take profit target hit
  else if (currentPrice >= tpPrice) {
    recommendation = 'TAKE_PROFIT';
    urgency = 'HIGH';
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — target of ${tp}% reached`);
    if (rsiNow > 70) {
      reasons.push(`RSI ${rsiNow.toFixed(1)} is overbought — reversal risk is high`);
      actions.push('Consider selling 50–70% now to lock in gains');
      actions.push('Move stop loss to break-even for remainder');
    } else {
      actions.push('Sell partial position (50%) to lock in profits');
      actions.push(`Trail stop loss to $${(currentPrice * 0.97).toFixed(4)} (3% below current)`);
    }
    if (resistanceAbove.length > 0) {
      actions.push(`Next resistance at $${resistanceAbove[0].toFixed(4)} — could target this before selling remainder`);
    }
  }
  // 3. Overbought but not at target — warn
  else if (rsiNow > 72 && pnlPct > 3) {
    recommendation = 'TRAIL_STOP';
    urgency = 'MEDIUM';
    reasons.push(`RSI ${rsiNow.toFixed(1)} — market is overbought, correction likely`);
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — protect gains now`);
    actions.push(`Set a trailing stop at $${(currentPrice * 0.96).toFixed(4)} (4% below current)`);
    actions.push('If price breaks below EMA20, sell immediately');
  }
  // 4. Price is below EMA50 but above stop — trend weakening
  else if (ema50Now && currentPrice < ema50Now * 0.99 && pnlPct > 0) {
    recommendation = 'CLOSE_PARTIAL';
    urgency = 'MEDIUM';
    reasons.push('Price has dropped below EMA50 — trend is weakening');
    reasons.push(`You still have profit of ${pnlPct.toFixed(2)}% — reduce risk now`);
    actions.push('Sell 30–50% of position to reduce exposure');
    actions.push('Hold remainder only if macro trend (4H) is still bullish');
  }
  // 5. In loss but above stop — hold
  else if (pnlPct < 0 && currentPrice > slPrice) {
    recommendation = 'HOLD';
    urgency = 'LOW';
    reasons.push(`Currently at ${pnlPct.toFixed(2)}% — within acceptable range`);
    reasons.push(`Stop loss at $${slPrice.toFixed(4)} is your safety net`);
    actions.push('Hold position — trend may recover');
    actions.push(`Watch closely: if price drops to $${slPrice.toFixed(4)}, exit immediately`);
  }
  // 6. In profit, trend healthy — hold for more
  else if (pnlPct > 0 && pnlPct < tp) {
    recommendation = 'HOLD';
    urgency = 'LOW';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — target is ${tp}% ($${tpPrice.toFixed(4)})`);
    if (rsiNow < 65) reasons.push(`RSI ${rsiNow.toFixed(1)} — room to run higher`);
    actions.push(`Target: $${tpPrice.toFixed(4)} (${tp}% gain from entry)`);
    if (resistanceAbove.length > 0) {
      actions.push(`Next resistance: $${resistanceAbove[0].toFixed(4)}`);
    }
    actions.push(`Keep stop loss at $${slPrice.toFixed(4)}`);
  }

  // Best sell price calculation
  let bestSellPrice = tpPrice;
  if (resistanceAbove.length > 0 && resistanceAbove[0] < tpPrice) {
    bestSellPrice = resistanceAbove[0];  // Sell at nearest resistance
  }

  return {
    symbol,
    exchange: null, // filled by caller
    buyPrice,
    currentPrice,
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    pnlDisplay: `${pnlSign}${pnlPct.toFixed(2)}%`,
    recommendation,
    urgency,
    reasons,
    actions,
    levels: {
      stopLoss:    parseFloat(slPrice.toFixed(6)),
      takeProfit1: parseFloat(tpPrice.toFixed(6)),
      bestSell:    parseFloat(bestSellPrice.toFixed(6)),
      resistanceAbove,
      resistanceBelow,
      ema20:       ema20Now ? parseFloat(ema20Now.toFixed(6)) : null,
      ema50:       ema50Now ? parseFloat(ema50Now.toFixed(6)) : null,
    },
    indicators: {
      rsi: rsiNow ? parseFloat(rsiNow.toFixed(2)) : null,
    },
    thresholds: { takeProfitPct: tp, stopLossPct: sl },
    analyzedAt: new Date().toISOString(),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let symbol, buyPrice, quantity, takeProfitPct, stopLossPct;

    if (req.method === 'POST') {
      ({ symbol, buyPrice, quantity, takeProfitPct, stopLossPct } = req.body || {});
    } else {
      symbol       = req.query.symbol;
      buyPrice     = parseFloat(req.query.buyPrice);
      quantity     = parseFloat(req.query.quantity) || null;
      takeProfitPct = parseFloat(req.query.tp) || null;
      stopLossPct  = parseFloat(req.query.sl) || null;
    }

    if (!symbol || !buyPrice || isNaN(buyPrice) || buyPrice <= 0) {
      return res.status(400).json({ success: false, error: 'symbol and buyPrice are required. Example: ?symbol=SOLUSDT&buyPrice=150' });
    }

    const sym = symbol.toUpperCase();
    const { candles, currentPrice, exchange } = await fetchCurrentData(sym);
    const advice = buildAdvice({ symbol: sym, buyPrice, currentPrice, candles, takeProfitPct, stopLossPct });
    advice.exchange = exchange;
    if (quantity) advice.quantity = quantity;

    res.status(200).json({ success: true, advice });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
