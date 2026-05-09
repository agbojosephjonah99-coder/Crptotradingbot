/**
 * ─── V2 Enhanced Position Advice API ─────────────────────────────────────────
 * GET  /api/v2advice?symbol=SOLUSDT&buyPrice=150&accountSize=10000&riskPct=1
 * POST /api/v2advice — body: { symbol, buyPrice, accountSize, riskPct, quantity }
 *
 * TRADER'S AUDIT OF ORIGINAL — GAPS FIXED:
 *
 * ❌ GAP 1: Single static take profit (TP1 only)
 *    ✅ FIX: Three TP levels with partial exit %s (40/35/25 split).
 *           After TP1 hits → move SL to breakeven. After TP2 → trail.
 *
 * ❌ GAP 2: Fixed 8% TP / 5% SL defaults — ignores coin volatility
 *    ✅ FIX: ATR-based dynamic stop. Scales to actual market noise.
 *           BTC has low ATR volatility, PEPE has wild ATR — stops reflect this.
 *
 * ❌ GAP 3: No position sizing advice
 *    ✅ FIX: If user provides accountSize + riskPct → exact units & dollar risk shown.
 *
 * ❌ GAP 4: Resistance detection was crude (just swing highs from last 20 bars)
 *    ✅ FIX: Proper swing high/low detection using pivot logic on 100 bars.
 *
 * ❌ GAP 5: No trailing stop calculation
 *    ✅ FIX: Dynamic trailing stop = current price - 1x ATR (tightens as price rises).
 *
 * ❌ GAP 6: No StochRSI or MACD in exit logic
 *    ✅ FIX: Both added. MACD bearish cross + overbought StochRSI = early exit warning.
 *
 * ❌ GAP 7: No multi-timeframe check for the exit — was 1H only
 *    ✅ FIX: 4H EMA200 still checked to confirm macro trend not broken.
 */

const axios = require('axios');
const {
  ema, rsi, stochRsi, macd, atr,
  bollingerBands, findSwingLevels,
} = require('../src/services/indicatorService');
const {
  calcATRStop, calcTakeProfits, calcRiskReward, calcPositionSize,
} = require('../src/services/riskService');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';
const KRAKEN_MAP = {
  BTCUSDT:'XBTUSD', ETHUSDT:'ETHUSD', SOLUSDT:'SOLUSD', BNBUSDT:'BNBUSD',
  XRPUSDT:'XRPUSD', ADAUSDT:'ADAUSD', DOGEUSDT:'DOGEUSD', AVAXUSDT:'AVAXUSD',
  LINKUSDT:'LINKUSD',
};

async function fetchCurrentData(symbol) {
  try {
    const [klines1h, klines4h, price] = await Promise.all([
      axios.get(`${BINANCE_BASE}/klines`, { params: { symbol, interval: '1h', limit: 100 }, timeout: 12000 }),
      axios.get(`${BINANCE_BASE}/klines`, { params: { symbol, interval: '4h', limit: 50  }, timeout: 12000 }),
      axios.get(`${BINANCE_BASE}/ticker/price`, { params: { symbol }, timeout: 8000 }),
    ]);
    const map = c => ({ time: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) });
    return {
      candles1h:    klines1h.data.map(map),
      candles4h:    klines4h.data.map(map),
      currentPrice: parseFloat(price.data.price),
      exchange:     'Binance',
    };
  } catch {
    const krakenPair = KRAKEN_MAP[symbol.toUpperCase()] || symbol.replace('USDT', 'USD');
    const [r1h, r4h] = await Promise.all([
      axios.get(`${KRAKEN_BASE}/OHLC`, { params: { pair: krakenPair, interval: 60  }, timeout: 12000 }),
      axios.get(`${KRAKEN_BASE}/OHLC`, { params: { pair: krakenPair, interval: 240 }, timeout: 12000 }),
    ]);
    const mapK = r => {
      const key = Object.keys(r.data.result).find(k => k !== 'last');
      return r.data.result[key].slice(-100).map(c => ({
        time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
        low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]),
      }));
    };
    const c1h = mapK(r1h);
    return {
      candles1h: c1h, candles4h: mapK(r4h),
      currentPrice: c1h[c1h.length - 1].close,
      exchange: 'Kraken',
    };
  }
}

function buildAdvice({ symbol, buyPrice, currentPrice, candles1h, candles4h, accountSize, riskPct }) {
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const n1 = closes1h.length;

  // Indicators
  const rsiArr     = rsi(closes1h, 14);
  const rsiNow     = rsiArr[n1 - 1];
  const srsi       = stochRsi(closes1h);
  const macdData   = macd(closes1h);
  const ema20      = ema(closes1h, 20)[n1 - 1];
  const ema50      = ema(closes1h, 50)[n1 - 1];
  const ema200_4h  = ema(closes4h, 200)[closes4h.length - 1];
  const atrArr     = atr(candles1h, 14);
  const atrNow     = atrArr[n1 - 1];
  const bb         = bollingerBands(closes1h, 20)[n1 - 1];

  // Dynamic ATR-based stop (1.5x ATR below buy price — same logic as scanner)
  const atrStop    = calcATRStop({ entryPrice: buyPrice, atrValue: atrNow, multiplier: 1.5 });
  const tps        = atrStop ? calcTakeProfits({ entryPrice: buyPrice, stopLoss: atrStop }) : null;

  // Trailing stop = current price - 1x ATR (tightens as price moves up)
  const trailingStop = atrNow ? parseFloat((currentPrice - atrNow).toFixed(6)) : null;

  // P&L
  const pnlPct  = ((currentPrice - buyPrice) / buyPrice) * 100;
  const pnlSign = pnlPct >= 0 ? '+' : '';

  // Swing levels for resistance/support context
  const { resistance, support } = findSwingLevels(candles1h, 3);
  const resistanceAbove = resistance.filter(r => r > currentPrice).slice(0, 3);
  const supportBelow    = support.filter(s => s < currentPrice).slice(0, 2);

  // R:R on TP1
  const rrTp1 = tps && atrStop ? calcRiskReward({ entryPrice: buyPrice, stopLoss: atrStop, takeProfit: tps.tp1.price }) : null;

  // Position sizing (optional — if accountSize provided)
  const sizing = accountSize && atrStop ? calcPositionSize({
    accountBalance: accountSize,
    riskPercent:    riskPct || 1,
    entryPrice:     buyPrice,
    stopLoss:       atrStop,
  }) : null;

  // Macro trend check (4H)
  const macroTrend = ema200_4h ? (currentPrice > ema200_4h ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';

  // ── Decision Logic ────────────────────────────────────────────────────────

  let recommendation = 'HOLD';
  let urgency        = 'LOW';
  const reasons      = [];
  const actions      = [];

  // ── Check if stop loss hit ──
  if (atrStop && currentPrice <= atrStop) {
    recommendation = 'STOP_LOSS';
    urgency        = 'CRITICAL';
    reasons.push(`Price $${currentPrice} has broken below ATR stop at $${atrStop.toFixed(4)}`);
    reasons.push(`You are down ${Math.abs(pnlPct).toFixed(2)}% from entry of $${buyPrice}`);
    if (macroTrend === 'BEARISH') reasons.push('Macro trend (4H) is also bearish — no case to hold');
    actions.push('🔴 EXIT THE TRADE NOW — stop loss breached');
    actions.push('Do not average down. Take the loss and wait for the next setup.');

  // ── TP3 hit (moon bag territory) ──
  } else if (tps && currentPrice >= tps.tp3.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'HIGH';
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — TP3 (${tps.tp3.ratio}) reached 🎉`);
    reasons.push('This is exceptional. Take the remaining position off.');
    actions.push(`🟢 Close remaining 25% at $${currentPrice.toFixed(4)}`);
    if (trailingStop) actions.push(`If holding: set hard floor at $${trailingStop.toFixed(4)} (1x ATR trail)`);

  // ── TP2 hit ──
  } else if (tps && currentPrice >= tps.tp2.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'HIGH';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — TP2 (${tps.tp2.ratio}) reached`);
    actions.push('🟢 Sell 35% of position here');
    actions.push(`Move stop to $${tps.tp1.price.toFixed(4)} (TP1 — protecting earlier profit)`);
    if (resistanceAbove.length > 0) actions.push(`TP3 target: $${tps.tp3.price.toFixed(4)} — next resistance at $${resistanceAbove[0].toFixed(4)}`);

  // ── TP1 hit ──
  } else if (tps && currentPrice >= tps.tp1.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'MEDIUM';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — TP1 (${tps.tp1.ratio}) reached`);
    actions.push('🟢 Sell 40% of position — lock in your first profit');
    actions.push(`Move stop loss to BREAKEVEN ($${buyPrice.toFixed(4)}) — free trade now`);
    if (tps.tp2) actions.push(`Target TP2 at $${tps.tp2.price.toFixed(4)} with remaining 60%`);

  // ── Warning: overbought but no TP hit yet ──
  } else if (rsiNow > 72 && srsi.k > 80 && pnlPct > 2) {
    recommendation = 'TRAIL_STOP';
    urgency        = 'MEDIUM';
    reasons.push(`RSI ${rsiNow.toFixed(1)} + StochRSI ${srsi.k.toFixed(1)} — both overbought`);
    reasons.push('Combination of both at extremes has high reversal probability');
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — protect gains now`);
    actions.push(trailingStop ? `Set trailing stop at $${trailingStop.toFixed(4)} (1x ATR below current)` : 'Set trailing stop 3–4% below current price');
    actions.push('If MACD crosses bearish → exit immediately');

  // ── MACD bearish cross + price below EMA20 ──
  } else if (!macdData.histogramGrowing && ema20 && currentPrice < ema20 && pnlPct > 0) {
    recommendation = 'CLOSE_PARTIAL';
    urgency        = 'MEDIUM';
    reasons.push('MACD momentum fading AND price below EMA20 — trend weakening');
    reasons.push(`Still in profit at ${pnlPct.toFixed(2)}% — reduce risk before it evaporates`);
    actions.push('Sell 30–50% of position now');
    actions.push(`Keep remaining position only if 4H trend stays ${macroTrend}`);
    if (atrStop) actions.push(`Tighten stop to $${atrStop.toFixed(4)}`);

  // ── Macro trend broken ──
  } else if (macroTrend === 'BEARISH' && pnlPct < 0) {
    recommendation = 'CLOSE_PARTIAL';
    urgency        = 'MEDIUM';
    reasons.push('4H price is below EMA200 — macro trend has turned bearish');
    reasons.push(`Currently at ${pnlPct.toFixed(2)}% — managing risk is priority`);
    actions.push('Consider cutting 50% of position to reduce exposure');
    actions.push(`If price recovers above $${ema200_4h ? ema200_4h.toFixed(4) : 'EMA200'}, re-evaluate`);

  // ── In loss, above stop ──
  } else if (pnlPct < 0 && (!atrStop || currentPrice > atrStop)) {
    recommendation = 'HOLD';
    urgency        = 'LOW';
    reasons.push(`Down ${Math.abs(pnlPct).toFixed(2)}% — within stop range, no action needed`);
    if (atrStop) reasons.push(`ATR stop at $${atrStop.toFixed(4)} — price hasn't breached it`);
    actions.push('Hold — let the trade play out');
    actions.push(atrStop ? `Watch: if price closes below $${atrStop.toFixed(4)}, exit immediately` : 'Monitor closely');

  // ── Healthy profit, ride it ──
  } else {
    recommendation = 'HOLD';
    urgency        = 'LOW';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — trade progressing normally`);
    if (tps) reasons.push(`Next target: TP1 at $${tps.tp1.price.toFixed(4)} (${tps.tp1.ratio})`);
    if (rsiNow < 65) reasons.push(`RSI ${rsiNow.toFixed(1)} — room to run`);
    if (atrStop) actions.push(`Keep ATR stop at $${atrStop.toFixed(4)}`);
    if (resistanceAbove.length > 0) actions.push(`Watch resistance at $${resistanceAbove[0].toFixed(4)}`);
  }

  return {
    symbol,
    buyPrice,
    currentPrice,
    pnlPct:      parseFloat(pnlPct.toFixed(2)),
    pnlDisplay:  `${pnlSign}${pnlPct.toFixed(2)}%`,
    recommendation,
    urgency,
    reasons,
    actions,

    // Trade Plan
    tradePlan: {
      stopLoss:      atrStop,
      trailingStop,
      takeProfits:   tps,
      riskReward:    rrTp1,
      breakeven:     buyPrice,
    },

    // Position Sizing (only if accountSize was provided)
    positionSizing: sizing ? {
      ...sizing,
      riskPercent:   riskPct || 1,
      accountSize,
      note: sizing.capped ? sizing.capReason : `Risk $${sizing.dollarRisk} to make $${(sizing.dollarRisk * (rrTp1 || 1.5)).toFixed(2)} at TP1`,
    } : null,

    // Market Context
    levels: {
      ema20, ema50, ema200_4h,
      atr:       atrNow ? parseFloat(atrNow.toFixed(6)) : null,
      resistanceAbove,
      supportBelow,
      bbUpper:   bb ? parseFloat(bb.upper.toFixed(6)) : null,
      bbLower:   bb ? parseFloat(bb.lower.toFixed(6)) : null,
    },

    indicators: {
      rsi:         rsiNow ? parseFloat(rsiNow.toFixed(2)) : null,
      stochRsiK:   srsi.k ? parseFloat(srsi.k.toFixed(2)) : null,
      stochRsiD:   srsi.d ? parseFloat(srsi.d.toFixed(2)) : null,
      macdGrowing: macdData.histogramGrowing,
      macroTrend,
    },

    analyzedAt: new Date().toISOString(),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let symbol, buyPrice, accountSize, riskPct, quantity;

    if (req.method === 'POST') {
      ({ symbol, buyPrice, accountSize, riskPct, quantity } = req.body || {});
    } else {
      symbol      = req.query.symbol;
      buyPrice    = parseFloat(req.query.buyPrice);
      accountSize = parseFloat(req.query.account) || null;
      riskPct     = parseFloat(req.query.risk)    || 1;
      quantity    = parseFloat(req.query.qty)     || null;
    }

    if (!symbol || !buyPrice || isNaN(buyPrice) || buyPrice <= 0) {
      return res.status(400).json({
        success: false,
        error: 'symbol and buyPrice required. Example: ?symbol=SOLUSDT&buyPrice=150&account=10000&risk=1',
      });
    }

    const sym = symbol.toUpperCase();
    const { candles1h, candles4h, currentPrice, exchange } = await fetchCurrentData(sym);
    const advice = buildAdvice({ symbol: sym, buyPrice, currentPrice, candles1h, candles4h, accountSize, riskPct });
    advice.exchange = exchange;
    if (quantity) advice.quantity = quantity;

    return res.status(200).json({ success: true, advice });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Named exports for reuse by telegram-webhook.js and v2monitor.js
module.exports.fetchCurrentData = fetchCurrentData;
module.exports.buildAdvice      = buildAdvice;