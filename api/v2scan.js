/**
 * ─── V2 Enhanced Multi-Timeframe Scanner (Patched) ───────────────────────────
 * GET /api/v2scan
 *
 * PATCH NOTES (v2.1.1):
 *  🐛 FIX 1: Telegram TypeError crashing results — sendBuyAlert/sendBearishAlert
 *            now called inside setImmediate + typeof guard. Never pollutes results.
 *  🐛 FIX 2: ADX < 20 was a score bonus — now a HARD BLOCK returning WAIT.
 *  🐛 FIX 3: Bearish divergence was ignored on BUY path — now blocks BUY signal.
 *  🐛 FIX 4: Bearish 15M patterns had no penalty on BUY — now subtracts their strength.
 *  🐛 FIX 5: OBV bearish was silent — now flagged explicitly in factors.
 */

const axios = require('axios');
const {
  ema, rsi, stochRsi, macd, bollingerBands, atr, adx,
  obv, vwap, volumeAvg, detectDivergence, detectPatterns, findSwingLevels,
} = require('../src/services/indicatorService');
const { calcATRStop, calcTakeProfits, calcRiskReward } = require('../src/services/riskService');
const { sendBuyAlert, sendBearishAlert } = require('../src/services/telegramService');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';

const KRAKEN_MAP = {
  BTCUSDT:'XBTUSD', ETHUSDT:'ETHUSD', SOLUSDT:'SOLUSD', BNBUSDT:'BNBUSD',
  XRPUSDT:'XRPUSD', ADAUSDT:'ADAUSD', DOGEUSDT:'DOGEUSD', AVAXUSDT:'AVAXUSD',
  DOTUSDT:'DOTUSD', MATICUSDT:'MATICUSD', LINKUSDT:'LINKUSD', LTCUSDT:'LTCUSD',
  UNIUSDT:'UNIUSD', ATOMUSDT:'ATOMUSD', NEARUSDT:'NEARUSD', APTUSDT:'APTUSD',
  SUIUSDT:'SUIUSD', INJUSDT:'INJUSD', ARBUSDT:'ARBUSD', OPUSDT:'OPUSD',
};

function toKrakenPair(sym) {
  const u = sym.toUpperCase();
  return KRAKEN_MAP[u] || (u.endsWith('USDT') ? u.slice(0, -1) : u);
}

async function binanceKlines(symbol, interval, limit) {
  const r = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol, interval, limit },
    timeout: 12000,
  });
  return r.data.map(c => ({
    time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
  }));
}

async function krakenKlines(pair, intervalMin, limit) {
  const r = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: { pair, interval: intervalMin },
    timeout: 12000,
    headers: { 'User-Agent': 'CryptoBotV2/2.0' },
  });
  if (r.data.error?.length) throw new Error(r.data.error.join(', '));
  const key = Object.keys(r.data.result).find(k => k !== 'last');
  return r.data.result[key].slice(0, -1).slice(-limit).map(c => ({
    time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]),
  }));
}

async function fetchKlines(symbol, intervalMin, intervalStr, limit) {
  try { return await binanceKlines(symbol, intervalStr, limit); }
  catch { return await krakenKlines(toKrakenPair(symbol), intervalMin, limit); }
}

// ─── Core Signal Engine ───────────────────────────────────────────────────────

function evaluateSignal(c4h, c1h, c15m) {
  const n4 = c4h.length, n1 = c1h.length, n15 = c15m.length;

  if (n4 < 200 || n1 < 60 || n15 < 5) {
    return { signal: 'WAIT', score: 0, confidence: 0, reason: 'Insufficient data' };
  }

  // ── Layer 1: 4H Macro Trend ──────────────────────────────────────────────
  const closes4h  = c4h.map(c => c.close);
  const ema200_4h = ema(closes4h, 200)[n4 - 1];
  const ema50_4h  = ema(closes4h, 50)[n4 - 1];
  const last4h    = c4h[n4 - 1];
  const trend4h   = last4h.close > ema200_4h ? 'UP' : 'DOWN';

  // ADX on 4H
  const adx4h = adx(c4h, 14);

  // ── Layer 2: 1H Momentum ─────────────────────────────────────────────────
  const closes1h  = c1h.map(c => c.close);
  const ema50_1h  = ema(closes1h, 50)[n1 - 1];
  const ema20_1h  = ema(closes1h, 20)[n1 - 1];
  const rsi1h     = rsi(closes1h, 14);
  const rsiNow    = rsi1h[n1 - 1];
  const srsi      = stochRsi(closes1h);
  const macdData  = macd(closes1h);
  const bb1h      = bollingerBands(closes1h, 20)[n1 - 1];
  const atr1h     = atr(c1h, 14);
  const atrNow    = atr1h[n1 - 1];
  const vwapArr   = vwap(c1h);
  const vwapNow   = vwapArr[n1 - 1];
  const obvArr    = obv(c1h);
  const obvEmaArr = ema(obvArr, 20);
  const obvTrend  = obvArr[n1 - 1] > (obvEmaArr[n1 - 1] || 0) ? 'BULLISH' : 'BEARISH';
  const div       = detectDivergence(c1h, rsi1h);

  // ── Layer 3: 15M Entry ───────────────────────────────────────────────────
  const avgVol15   = volumeAvg(c15m, Math.min(20, n15 - 1));
  const volSurge   = avgVol15 > 0 && c15m[n15 - 1].volume > avgVol15 * 1.5;
  const patterns   = detectPatterns(c15m);
  const bullishPat = patterns.filter(p => p.bullish === true);
  const bearishPat = patterns.filter(p => p.bullish === false);

  const entryPrice = c15m[n15 - 1].close;

  // ── Shared base result fields ────────────────────────────────────────────
  const base = {
    patterns, price: entryPrice,
    ema20: ema20_1h, ema50: ema50_1h, ema200: ema200_4h,
    rsi: rsiNow, stochRsiK: srsi.k, stochRsiD: srsi.d,
    adxValue: adx4h.adx, adxBullish: adx4h.bullishDI,
    aboveVWAP: closes1h[n1 - 1] > vwapNow,
    bBandPctB: bb1h ? bb1h.percentB : undefined,
    obvTrend, atr: atrNow, divergence: div,
    scannedAt: new Date().toISOString(),
  };

  // ════════════════════════════════════════════════════════════════════════
  // UPTREND PATH
  // ════════════════════════════════════════════════════════════════════════
  if (trend4h === 'UP') {
    // ── HARD FILTER 1: ADX < 20 = ranging market — no trade ─────────────
    if (!adx4h.trending) {
      return {
        ...base, signal: 'WAIT', score: 0, confidence: 0, trend: 'UP',
        factors: [`ADX ${adx4h.adx !== undefined ? adx4h.adx.toFixed(1) : 'N/A'} — market is ranging (ADX < 20). No directional edge. Wait for trend.`],
        stopLoss: null, takeProfits: null, riskReward: null,
        nearestSupport: null, nearestResistance: null,
      };
    }

    // ── HARD FILTER 2: Bearish divergence = trend exhaustion — no trade ──
    if (div.bearish) {
      return {
        ...base, signal: 'WAIT', score: 2, confidence: 13, trend: 'UP',
        factors: [
          '4H uptrend confirmed, BUT:',
          '⚠️ Bearish RSI divergence: price making higher highs while RSI makes lower highs.',
          'Classic trend exhaustion. High reversal probability. DO NOT BUY here.',
          'Wait for RSI to reset (drop below 40) before re-evaluating.',
        ],
        stopLoss: null, takeProfits: null, riskReward: null,
        nearestSupport: null, nearestResistance: null,
      };
    }

    // ── SCORING ──────────────────────────────────────────────────────────
    let score = 0;
    const factors = [];

    // Trend Quality (0–4)
    score += 2; factors.push('4H uptrend (above EMA200)');
    if (adx4h.adx > 25) { score += 1; factors.push(`ADX ${adx4h.adx.toFixed(1)} — strong trend`); }
    if (last4h.close > ema50_4h) { score += 1; factors.push('4H price above EMA50 — trend intact'); }

    // Momentum Quality (0–4)
    const rsiInZone = rsiNow >= 38 && rsiNow <= 58;
    if (rsiInZone)       { score += 2; factors.push(`RSI ${rsiNow.toFixed(1)} — pullback buy zone (38–58)`); }
    else if (rsiNow > 65){ score -= 2; factors.push(`RSI ${rsiNow.toFixed(1)} — overbought, AVOID`); }
    else if (rsiNow < 32){ score += 1; factors.push(`RSI ${rsiNow.toFixed(1)} — oversold, watch for bounce`); }

    if (srsi.k !== undefined && srsi.k < 25) { score += 1; factors.push(`StochRSI %K ${srsi.k.toFixed(1)} — oversold (entry zone)`); }
    if (srsi.kCrossedAboveD)                  { score += 1; factors.push('StochRSI bullish cross (%K above %D)'); }

    if (macdData.histogramGrowing)            { score += 1; factors.push('MACD histogram expanding — momentum building'); }
    else if (macdData.bullishCross)           { score += 1; factors.push('MACD bullish crossover'); }

    // Volatility & Structure (0–3)
    if (bb1h && bb1h.percentB < 0.25)        { score += 2; factors.push(`BB %B ${(bb1h.percentB * 100).toFixed(0)}% — near lower band (buy zone)`); }
    else if (bb1h && bb1h.percentB > 0.85)   { score -= 1; factors.push('BB %B near upper band — extended'); }

    const nearEma50 = ema50_1h && Math.abs(closes1h[n1 - 1] - ema50_1h) / ema50_1h <= 0.04;
    if (nearEma50) { score += 1; factors.push('Price pulled back to 1H EMA50 — value area'); }

    // Volume & Institutional Flow (0–3)
    if (closes1h[n1 - 1] > vwapNow) { score += 1; factors.push('Price above VWAP — institutional buy pressure'); }
    if (obvTrend === 'BULLISH')      { score += 1; factors.push('OBV bullish — smart money accumulating'); }
    else                             { factors.push('⚠️ OBV bearish — volume not confirming price move, caution'); }
    if (volSurge)                    { score += 1; factors.push('Volume surge on 15M'); }

    // Candle Patterns — bullish adds, bearish subtracts (FIX)
    const bullishStr = bullishPat.reduce((s, p) => s + p.strength, 0);
    const bearishStr = bearishPat.reduce((s, p) => s + p.strength, 0);
    if (bullishStr > 0) {
      score += Math.min(bullishStr, 4);
      factors.push(`15M bullish patterns: ${bullishPat.map(p => p.name).join(', ')}`);
    }
    if (bearishStr > 0) {
      score -= bearishStr;
      factors.push(`⚠️ 15M bearish patterns: ${bearishPat.map(p => p.name).join(', ')} — entry timing is poor`);
    }

    // Bullish divergence bonus
    if (div.bullish) { score += 2; factors.push('⚡ Bullish RSI divergence — premium reversal setup'); }

    // ── Build result ──────────────────────────────────────────────────────
    const confidence = Math.min(100, Math.round((score / 15) * 100));
    const stopLoss   = calcATRStop({ entryPrice, atrValue: atrNow, multiplier: 1.5 });
    const tps        = stopLoss ? calcTakeProfits({ entryPrice, stopLoss }) : null;
    const rr         = tps && stopLoss ? calcRiskReward({ entryPrice, stopLoss, takeProfit: tps.tp1.price }) : null;

    if (score >= 7 && rr !== null && rr < 1.5) {
      factors.push(`⚠️ R:R ${rr}:1 below 1.5 minimum — WAIT for better entry price`);
    }

    const signal = score >= 7 && (rr === null || rr >= 1.5) ? 'BUY' : 'WAIT';
    const { support, resistance } = findSwingLevels(c1h, 3);

    return {
      ...base, signal, score, confidence, trend: 'UP', factors,
      stopLoss, takeProfits: tps, riskReward: rr,
      nearestSupport:    support[0]    || null,
      nearestResistance: resistance[resistance.length - 1] || null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // DOWNTREND PATH
  // ════════════════════════════════════════════════════════════════════════
  let bScore = 0;
  const bFactors = [];

  bScore += 2; bFactors.push('4H downtrend (below EMA200)');
  if (adx4h.adx > 25)   { bScore += 1; bFactors.push(`ADX ${adx4h.adx.toFixed(1)} — strong downtrend`); }
  if (!adx4h.bullishDI) { bScore += 1; bFactors.push('-DI dominant — sellers in control'); }
  if (rsiNow > 55)      { bScore += 1; bFactors.push(`RSI ${rsiNow.toFixed(1)} — overbought in downtrend (bounce likely to fail)`); }
  if (rsiNow < 30)      { bFactors.push(`RSI ${rsiNow.toFixed(1)} — oversold, possible short-term bounce`); }
  if (bearishPat.length > 0) { bScore += 2; bFactors.push(`Bearish patterns: ${bearishPat.map(p => p.name).join(', ')}`); }
  if (div.bearish)      { bScore += 2; bFactors.push('⚡ Bearish RSI divergence — momentum collapsing'); }

  return {
    ...base, signal: 'BEARISH_ALERT', trend: 'DOWN',
    score: bScore,
    confidence: Math.min(100, Math.round((bScore / 10) * 100)),
    factors: bFactors,
    stopLoss: null, takeProfits: null, riskReward: null,
    nearestSupport: null, nearestResistance: null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const rawSymbols = process.env.BINANCE_SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT';
    const symbols    = rawSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const results    = [];

    for (const symbol of symbols) {
      try {
        const [c4h, c1h, c15m] = await Promise.all([
          fetchKlines(symbol, 240, '4h',  260),
          fetchKlines(symbol, 60,  '1h',  100),
          fetchKlines(symbol, 15,  '15m',  50),
        ]);

        const sig    = evaluateSignal(c4h, c1h, c15m);
        const result = { symbol, ...sig };
        results.push(result);

        // FIX: Telegram calls fully isolated — TypeError can NEVER reach outer catch
        setImmediate(() => {
          try {
            if (sig.signal === 'BUY' && typeof sendBuyAlert === 'function') {
              sendBuyAlert(result).catch(e => console.error('[TG BUY]', e.message));
            }
            if (sig.signal === 'BEARISH_ALERT' && typeof sendBearishAlert === 'function') {
              sendBearishAlert(result).catch(e => console.error('[TG BEARISH]', e.message));
            }
          } catch (tgErr) {
            console.error('[TG] Alert error (non-fatal):', tgErr.message);
          }
        });

      } catch (err) {
        results.push({ symbol, signal: 'ERROR', error: err.message, score: 0, confidence: 0 });
      }
    }

    const order = { BUY: 0, WAIT: 1, BEARISH_ALERT: 2, ERROR: 3 };
    results.sort((a, b) => (order[a.signal] - order[b.signal]) || (b.score - a.score));

    return res.status(200).json({
      success: true,
      count: results.length,
      buySignals: results.filter(r => r.signal === 'BUY').length,
      results,
      scannedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};