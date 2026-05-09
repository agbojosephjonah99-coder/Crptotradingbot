/**
 * ─── V2 New Listing Scanner with BUY/SELL Signals ────────────────────────────
 * GET /api/v2listings
 *
 * HOW IT WORKS:
 *  1. Scans ALL Binance USDT pairs, excludes established coins
 *  2. Filters for minimum $500K volume (liquidity gate)
 *  3. Scores each coin for pump potential
 *  4. For HOT/WARM coins — fetches OHLC candles and runs full technical analysis
 *  5. Returns exact BUY signal with Entry, Stop Loss, TP1, TP2, TP3
 *  6. Sends Telegram alert with complete trade plan
 *
 * NOTE ON NEW LISTINGS:
 *  New coins won't have 200x 4H candles for EMA200. The analysis adapts:
 *  - Uses 1H candles (as many as available, min 20)
 *  - Shorter EMAs (20/50 instead of 50/200)
 *  - ATR-based stops (same as main scanner)
 *  - RSI + StochRSI + volume for entry timing
 *  - Flags coins with very limited history as EARLY_STAGE
 */

const axios = require('axios');
const {
  ema, rsi, stochRsi, macd, bollingerBands, atr,
  obv, vwap, volumeAvg, detectPatterns,
} = require('../src/services/indicatorService');
const { calcATRStop, calcTakeProfits, calcRiskReward, isDuplicateSignal, markSignalFired } = require('../src/services/riskService');
const { sendListingBuyAlert } = require('../src/services/telegramService');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';

// ─── Established Coins (excluded from new listing scan) ──────────────────────
const ESTABLISHED = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','ADAUSDT','SOLUSDT','DOGEUSDT',
  'DOTUSDT','MATICUSDT','LTCUSDT','LINKUSDT','AVAXUSDT','UNIUSDT','ATOMUSDT',
  'ETCUSDT','XLMUSDT','ALGOUSDT','VETUSDT','TRXUSDT','FILUSDT','AAVEUSDT',
  'MKRUSDT','COMPUSDT','YFIUSDT','SUSHIUSDT','CRVUSDT','SNXUSDT','UMAUSDT',
  'RUNEUSDT','ICPUSDT','NEARUSDT','FTMUSDT','SANDUSDT','MANAUSDT','AXSUSDT',
  'GALAUSDT','ENJUSDT','CHZUSDT','BATUSDT','ZRXUSDT','STORJUSDT','AUDIOUSDT',
  'FLOWUSDT','HBARUSDT','EGLDUSDT','THETAUSDT','XTZUSDT','IOTAUSDT','NEOUSDT',
  'QTUMUSDT','ONTUSDT','ZILUSDT','RVNUSDT','SCUSDT','DCRUSDT','ZECUSDT',
  'DASHUSDT','WAVESUSDT','ZENUSDT','IOSTUSDT','KSMUSDT','IOTXUSDT','RSRUSDT',
  'LRCUSDT','COTIUSDT','SLPUSDT','SKLUSDT','CELRUSDT','BANDUSDT','KNCUSDT',
  'STMXUSDT','BLZUSDT','CVCUSDT','GRTUSDT','INJUSDT','ALPHAUSDT','AIONUSDT',
  'LPTUSDT','NUUSDT','NKNUSDT','DATAUSDT','RIFUSDT','PONDUSDT','ALICEUSDT',
  'CHRUSDT','ERNUSDT','KLAYUSDT','PHBUSDT','AGLDUSDT','RADUSDT','QNTUSDT',
  'APTUSDT','GMTUSDT','LDOUSDT','STGUSDT','SPELLUSDT','LOOMUSDT','APEUSDT',
  'GALUSDT','OPUSDT','ASTRUSDT','HOOKUSDT','MAGICUSDT','HFTUSDT','GLMUSDT',
  'HIGHUSDT','ARBUSDT','SUIUSDT','PEPEUSDT','WLDUSDT','SEIUSDT','CYBERUSDT',
  'TIAUSDT','MNTUSDT','KASUSDT','ORDIUSDT','SATSUDT','ACEUSDT','NFPUSDT',
  'AIUSDT','XAIUSDT','WIFUSDT','JUPUSDT','STRKUSDT','PIXELUSDT','PORTALUSDT',
  'PYTHUSDT','BONKUSDT','BOMEUSDT','AEVOUSDT','MEMEUSDT','CATIUSDT','EIGENUSDT',
  'NOTUSDT','IOUSDT','LISTAUSDT','ZKUSDT','BBUSDT','TURBOUSDT','DOGSUSDT',
  'GOATUSDT','POPCATUSDT','ACTUSDT','MEUSDT','MOVEUSDT','VIRTUALUSDT',
  'DRIFTUSDT','ZEREBROUSDT','AIXBTUSDT','FARTCOINUSDT','TRUMPUSDT',
]);

// ─── Fetch OHLC for a new coin ────────────────────────────────────────────────
async function fetchCoinCandles(symbol) {
  try {
    const [r1h, r15m] = await Promise.all([
      axios.get(`${BINANCE_BASE}/klines`, {
        params: { symbol, interval: '1h', limit: 100 },
        timeout: 10000,
      }),
      axios.get(`${BINANCE_BASE}/klines`, {
        params: { symbol, interval: '15m', limit: 50 },
        timeout: 10000,
      }),
    ]);
    const map = c => ({
      time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
      low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
    });
    return { candles1h: r1h.data.map(map), candles15m: r15m.data.map(map) };
  } catch {
    return null;
  }
}

// ─── Technical Analysis for New Listings ─────────────────────────────────────
// Adapted for coins with limited history (no 200x 4H candles available)
function analyzeNewListing(symbol, ticker, candles1h, candles15m) {
  const n1  = candles1h.length;
  const n15 = candles15m.length;

  // Need at least 20 candles for any meaningful analysis
  if (n1 < 20) {
    return {
      signal: 'WATCH',
      reason: `Only ${n1} candles available — too early for technical analysis`,
      earlyStage: true,
    };
  }

  const closes1h   = candles1h.map(c => c.close);
  const entryPrice = candles15m.length > 0 ? candles15m[n15 - 1].close : closes1h[n1 - 1];

  // ── Indicators (adapted for limited history) ──
  const emaPeriodFast = Math.min(20, Math.floor(n1 / 2));
  const emaPeriodSlow = Math.min(50, Math.floor(n1 * 0.8));

  const emaFast   = ema(closes1h, emaPeriodFast)[n1 - 1];
  const emaSlow   = ema(closes1h, emaPeriodSlow)[n1 - 1];
  const rsiArr    = rsi(closes1h, Math.min(14, n1 - 2));
  const rsiNow    = rsiArr[n1 - 1];
  const srsi      = stochRsi(closes1h, Math.min(14, n1 - 2));
  const atrArr    = atr(candles1h, Math.min(14, n1 - 2));
  const atrNow    = atrArr[n1 - 1];
  const bbArr     = bollingerBands(closes1h, Math.min(20, n1 - 1));
  const bbNow     = bbArr[n1 - 1];
  const vwapArr   = vwap(candles1h);
  const vwapNow   = vwapArr[n1 - 1];
  const obvArr    = obv(candles1h);
  const obvEma    = ema(obvArr, Math.min(10, n1 - 1));
  const obvTrend  = obvArr[n1 - 1] > (obvEma[n1 - 1] || 0) ? 'BULLISH' : 'BEARISH';

  // 15M patterns
  const patterns   = n15 >= 3 ? detectPatterns(candles15m) : [];
  const bullishPat = patterns.filter(p => p.bullish === true);
  const bearishPat = patterns.filter(p => p.bullish === false);

  // Volume surge check
  const avgVol   = volumeAvg(candles1h, Math.min(10, n1 - 1));
  const lastVol  = candles1h[n1 - 1].volume;
  const volSurge = avgVol > 0 && lastVol > avgVol * 2;

  // ── Scoring (max 12 for new listings — fewer confirmations available) ──
  let score = 0;
  const factors = [];
  const warnings = [];

  // Trend (0–3)
  const inUptrend = emaFast && emaSlow && emaFast > emaSlow;
  if (inUptrend) {
    score += 2; factors.push(`EMA${emaPeriodFast} above EMA${emaPeriodSlow} — short-term uptrend`);
  } else {
    warnings.push('Short-term EMAs bearish — wait for trend confirmation');
  }
  if (entryPrice > (vwapNow || 0)) { score += 1; factors.push('Price above VWAP — buyers in control'); }

  // Momentum (0–4)
  if (rsiNow !== undefined) {
    if (rsiNow >= 40 && rsiNow <= 65)      { score += 2; factors.push(`RSI ${rsiNow.toFixed(1)} — healthy momentum (buy zone)`); }
    else if (rsiNow > 75)                  { score -= 1; warnings.push(`RSI ${rsiNow.toFixed(1)} — severely overbought, high dump risk`); }
    else if (rsiNow < 35)                  { score += 1; factors.push(`RSI ${rsiNow.toFixed(1)} — oversold, potential bounce`); }
  }
  if (srsi.k !== undefined && srsi.k < 30)  { score += 1; factors.push(`StochRSI ${srsi.k.toFixed(1)} — oversold entry zone`); }
  if (srsi.kCrossedAboveD)                   { score += 1; factors.push('StochRSI bullish cross — momentum turning up'); }

  // Volume (0–3)
  if (obvTrend === 'BULLISH')               { score += 2; factors.push('OBV rising — accumulation confirmed'); }
  if (volSurge)                             { score += 1; factors.push('Volume 2x above average — strong interest'); }

  // Patterns (0–2)
  if (bearishPat.length > 0) {
    score -= bearishPat.reduce((s, p) => s + p.strength, 0);
    warnings.push(`Bearish 15M patterns: ${bearishPat.map(p => p.name).join(', ')}`);
  }
  if (bullishPat.length > 0) {
    score += Math.min(bullishPat.reduce((s, p) => s + p.strength, 0), 2);
    factors.push(`Bullish 15M patterns: ${bullishPat.map(p => p.name).join(', ')}`);
  }

  // Volatility context
  if (bbNow && bbNow.percentB < 0.3)        { score += 1; factors.push(`BB %B ${(bbNow.percentB * 100).toFixed(0)}% — near lower band (good entry)`); }

  // ── Build trade plan ──
  const stopLoss  = calcATRStop({ entryPrice, atrValue: atrNow, multiplier: 2.0 }); // wider stop for new coins (more volatile)
  const tps       = stopLoss ? calcTakeProfits({ entryPrice, stopLoss }) : null;
  const rr        = tps && stopLoss ? calcRiskReward({ entryPrice, stopLoss, takeProfit: tps.tp1.price }) : null;

  const confidence = Math.min(100, Math.round((Math.max(score, 0) / 12) * 100));
  const signal     = score >= 6 && inUptrend && (rr === null || rr >= 1.5) ? 'BUY' : 'WATCH';

  return {
    signal,
    score,
    confidence,
    factors,
    warnings,
    patterns,
    earlyStage: n1 < 50,
    candleCount: n1,
    entryPrice,
    stopLoss,
    takeProfits: tps,
    riskReward:  rr,
    indicators: {
      rsi:       rsiNow ? parseFloat(rsiNow.toFixed(2)) : null,
      stochRsiK: srsi.k ? parseFloat(srsi.k.toFixed(2)) : null,
      emaFast:   emaFast ? parseFloat(emaFast.toFixed(6)) : null,
      emaSlow:   emaSlow ? parseFloat(emaSlow.toFixed(6)) : null,
      atr:       atrNow  ? parseFloat(atrNow.toFixed(6)) : null,
      vwap:      vwapNow ? parseFloat(vwapNow.toFixed(6)) : null,
      obvTrend,
      bbPercentB: bbNow ? parseFloat(bbNow.percentB.toFixed(3)) : null,
    },
  };
}

// ─── Risk Flag Detector ───────────────────────────────────────────────────────
function assessRisk(t) {
  const flags    = [];
  const vol      = parseFloat(t.quoteVolume);
  const change   = parseFloat(t.priceChangePercent);
  const count    = parseInt(t.count, 10);
  const price    = parseFloat(t.lastPrice);
  const high     = parseFloat(t.highPrice);
  const low      = parseFloat(t.lowPrice);

  if (vol < 500_000)              flags.push('LOW_LIQUIDITY');
  if (change < -40)               flags.push('POSSIBLE_DUMP');
  if (count < 500)                flags.push('VERY_LOW_ACTIVITY');
  if (price < 0.0001)             flags.push('MICRO_CAP_EXTREME');
  if (high > 0 && low > 0 && high / low > 5) flags.push('EXTREME_VOLATILITY');
  if (change > 100 && count < 2000) flags.push('POSSIBLE_WASH_TRADE');
  return flags;
}

// ─── Pump Scorer (first pass — no OHLC needed) ───────────────────────────────
function scoreTicker(t) {
  let score = 0;
  const factors = [];

  const priceChange = parseFloat(t.priceChangePercent);
  const volume      = parseFloat(t.quoteVolume);
  const count       = parseInt(t.count, 10);
  const lastPrice   = parseFloat(t.lastPrice);
  const high24h     = parseFloat(t.highPrice);
  const low24h      = parseFloat(t.lowPrice);
  const rangePos    = high24h > low24h ? (lastPrice - low24h) / (high24h - low24h) : 0.5;

  if (priceChange > 150)      { score += 5; factors.push(`+${priceChange.toFixed(0)}% — parabolic`); }
  else if (priceChange > 80)  { score += 4; factors.push(`+${priceChange.toFixed(0)}% — explosive`); }
  else if (priceChange > 40)  { score += 3; factors.push(`+${priceChange.toFixed(0)}% — strong pump`); }
  else if (priceChange > 15)  { score += 2; factors.push(`+${priceChange.toFixed(0)}% — notable move`); }
  else if (priceChange > 5)   { score += 1; factors.push(`+${priceChange.toFixed(0)}% — early move`); }

  if (volume > 50_000_000)    { score += 4; factors.push(`$${(volume/1e6).toFixed(0)}M vol`); }
  else if (volume > 10_000_000){ score += 3; factors.push(`$${(volume/1e6).toFixed(1)}M vol`); }
  else if (volume > 2_000_000) { score += 2; factors.push(`$${(volume/1e6).toFixed(1)}M vol`); }
  else if (volume > 500_000)   { score += 1; factors.push(`$${(volume/1e3).toFixed(0)}K vol`); }

  if (count > 200_000)        { score += 2; factors.push(`${count.toLocaleString()} trades — viral`); }
  else if (count > 50_000)    { score += 1; factors.push(`${count.toLocaleString()} trades`); }

  if (rangePos > 0.80)        { score += 1; factors.push('Near 24H high'); }

  return { score, factors, priceChange, volume, count, lastPrice, high24h, low24h, rangePos };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Fetch all Binance tickers
    const [tickerResp, exchangeResp, krakenResp] = await Promise.allSettled([
      axios.get(`${BINANCE_BASE}/ticker/24hr`, { timeout: 15000 }),
      axios.get(`${BINANCE_BASE}/exchangeInfo`, { timeout: 15000 }),
      axios.get(`${KRAKEN_BASE}/AssetPairs`, { timeout: 10000 }),
    ]);

    if (tickerResp.status === 'rejected') {
      return res.status(500).json({ success: false, error: 'Binance API unavailable' });
    }

    const allTickers = tickerResp.value.data;
    const allSymbols = exchangeResp.status === 'fulfilled'
      ? new Set(exchangeResp.value.data.symbols.map(s => s.symbol))
      : new Set(allTickers.map(t => t.symbol));

    const krakenSymbols = new Set();
    if (krakenResp.status === 'fulfilled') {
      Object.values(krakenResp.value.data.result || {}).forEach(p => {
        krakenSymbols.add(p.altname);
        krakenSymbols.add((p.base || '').replace(/^[XZ]/, ''));
      });
    }

    // 2. Filter to new USDT candidates with minimum liquidity
    const candidates = allTickers.filter(t =>
      t.symbol.endsWith('USDT') &&
      !ESTABLISHED.has(t.symbol) &&
      allSymbols.has(t.symbol) &&
      parseFloat(t.quoteVolume) >= 500_000 &&
      !assessRisk(t).includes('POSSIBLE_DUMP')
    );

    // 3. First-pass scoring (no OHLC — fast)
    const firstPass = candidates
      .map(t => {
        const riskFlags = assessRisk(t);
        const { score, factors, priceChange, volume, count, lastPrice, high24h, low24h, rangePos } = scoreTicker(t);
        const onKraken  = krakenSymbols.has(t.symbol.replace('USDT', ''));
        if (onKraken) score + 1;
        return {
          symbol: t.symbol,
          price: lastPrice, priceChange, volume, tradeCount: count,
          high24h, low24h, rangePos,
          pumpScore: score,
          pumpFactors: factors,
          pumpRating: score >= 9 ? 'HOT' : score >= 6 ? 'WARM' : score >= 3 ? 'WATCH' : 'COLD',
          riskFlags,
          onKraken,
        };
      })
      .filter(c => c.pumpRating === 'HOT' || c.pumpRating === 'WARM')
      .sort((a, b) => b.pumpScore - a.pumpScore)
      .slice(0, 15); // Only run deep analysis on top 15

    // 4. Deep analysis — fetch OHLC and generate BUY signals
    const results = [];

    for (const coin of firstPass) {
      const ohlc = await fetchCoinCandles(coin.symbol);

      if (!ohlc) {
        results.push({ ...coin, signal: 'WATCH', reason: 'Could not fetch candle data' });
        continue;
      }

      const analysis = analyzeNewListing(
        coin.symbol, coin,
        ohlc.candles1h, ohlc.candles15m
      );

      const result = {
        symbol:      coin.symbol,
        exchange:    'Binance',
        price:       coin.price,
        priceChange: coin.priceChange,
        volume:      coin.volume,
        tradeCount:  coin.tradeCount,
        pumpRating:  coin.pumpRating,
        pumpScore:   coin.pumpScore,
        pumpFactors: coin.pumpFactors,
        riskFlags:   coin.riskFlags,
        onKraken:    coin.onKraken,
        ...analysis,
        scannedAt:   new Date().toISOString(),
      };

      results.push(result);

      // 5. Send Telegram alert for BUY signals only
      if (analysis.signal === 'BUY' && !isDuplicateSignal(coin.symbol, 'LISTING_BUY')) {
        setImmediate(() => {
          try {
            if (typeof sendListingBuyAlert === 'function') {
              sendListingBuyAlert(result).catch(e => console.error('[TG LISTING]', e.message));
              markSignalFired(coin.symbol, 'LISTING_BUY');
            }
          } catch (e) {
            console.error('[TG LISTING] Alert error:', e.message);
          }
        });
      }
    }

    // Sort: BUY first, then WATCH, by confidence
    results.sort((a, b) => {
      if (a.signal === 'BUY' && b.signal !== 'BUY') return -1;
      if (b.signal === 'BUY' && a.signal !== 'BUY') return  1;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    return res.status(200).json({
      success:      true,
      totalScanned: candidates.length,
      buySignals:   results.filter(r => r.signal === 'BUY').length,
      watchList:    results.filter(r => r.signal === 'WATCH').length,
      results,
      scannedAt:    new Date().toISOString(),
      note: 'BUY signals include exact Entry, Stop Loss, TP1/TP2/TP3. New listings use 2x ATR stop (wider — more volatile). Max risk 1-2% of account.',
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};