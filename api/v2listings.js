/**
 * V2 New Listing Scanner
 * Detects coins newly / recently listed on Binance and scores them for
 * pump potential using volume surge, price momentum, and order flow.
 *
 * Strategy:
 *  1. Pull all Binance USDT pairs with 24h ticker data.
 *  2. Exclude well-known established coins (list below).
 *  3. Score remaining coins for pump signals.
 *  4. Also check Kraken pairs for any appearing there recently.
 */

const axios = require('axios');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';

// ─── Established coins to exclude from "new listing" detection ───────────────
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
  'STMXUSDT','BLZUSDT','CVCUSDT','DUSKUSDT','FORTHUSDT','BURGERUSDT',
  'BAKEUSDT','XVSUSDT','ALPACAUSDT','TWTUSDT','CFXUSDT','ARUSDT','ANKRUSDT',
  'CTKUSDT','HARDUSDT','PROSUSDT','TOMUSDT','BELUSDT','WINGUSDT','XEMUSDT',
  'MDTUSDT','SUPERUSDT','BADGERUSDT','DFUSDT','OXTUSDT','DIAUSDT','PNTUSDT',
  'DREPUSDT','TKOUSDT','LITUSDT','SFPUSDT','REEFUSDT','OGUSDT','JSTUSDT',
  'SXPUSDT','GRTUSDT','INJUSDT','ALPHAUSDT','AIONUSDT','MBLUSDT','CREAMUSDT',
  'LPTUSDT','NUUSDT','XVGUSDT','YFIIUSDT','NKNUSDT','STOUSDT','DATAUSDT',
  'RIFUSDT','PONDUSDT','ALICEUSDT','CHRUSDT','ATAGUSDT','TVKUSDT','WNXMUSDT',
  'ERNUSDT','KLAYUSDT','PHBUSDT','DEXEUSDT','MITHUSDT','MLNUSDT','FORTHUSDT',
  'AGLDUSDT','RADUSDT','BETAUSDT','RAREUSDT','LAQUSDT','CLVUSDT','QNTUSDT',
  'FLOWUSDT','MOVRUSDT','CITYUSDT','LAZIOUSDT','ALPHSUSDT','ENJ2USDT',
  // 2022 era
  'APTUSDT','GMTUSDT','LDOUSDT','STGUSDT','SPELLUSDT','LOOMUSDT','APEUSDT',
  'GALUSDT','REIUSDT','OPUSDT','ASTRUSDT','HOOKUSDT','MAGICUSDT','HFTUSDT',
  'PHBUSDT','RPLUSDT','MUBIUSDT','GLMUSDT','TUSDT','ACHUSDT','HIGHUSDT',
  // 2023 era
  'ARBUSDT','SUIUSDT','PEPEUSDT','WLDUSDT','SEIUSDT','CYBERUSDT','TIAUSDT',
  'MNTUSDT','KASUSDT','ORDIUSDT','SATSUDT','ACEUSDT','NFPUSDT','AIUSDT',
  'XAIUSDT','WIFUSDT','JUPUSDT','STRKUSDT','PIXELUSDT','PORTALUSDT','PYTHUSDT',
  'BONKUSDT','BOMEUSDT','AEVOUSDT','MEMEUSDT','CATIUSDT','EIGENUSDT',
  // 2024 era
  'NOTUSDT','IOUSDT','LISTAUSDT','ZKUSDT','BBUSDT','TURBOUSDT','DOGSUSDT',
  'GOATUSDT','POPCATUSDT','PONKEUSDT','ACTUSDT','MEUSDT','MOVEUSDT','VIRTUALUSDT',
  'DRIFTUSDT','ZEREBROUSDT','AIXBTUSDT','FARTCOINUSDT','TRUMP','TRUMPUSDT',
]);

// ─── Pump Scorer ─────────────────────────────────────────────────────────────

function scoreTicker(t) {
  let score = 0;
  const factors = [];
  const priceChange = parseFloat(t.priceChangePercent);
  const volume      = parseFloat(t.quoteVolume);   // USD volume
  const count       = parseInt(t.count, 10);        // number of trades
  const high24h     = parseFloat(t.highPrice);
  const low24h      = parseFloat(t.lowPrice);
  const lastPrice   = parseFloat(t.lastPrice);

  // Price momentum
  if (priceChange > 100)      { score += 5; factors.push(`+${priceChange.toFixed(0)}% (explosive pump)`); }
  else if (priceChange > 50)  { score += 4; factors.push(`+${priceChange.toFixed(0)}% (strong pump)`); }
  else if (priceChange > 20)  { score += 2; factors.push(`+${priceChange.toFixed(0)}% (moderate surge)`); }
  else if (priceChange > 10)  { score += 1; factors.push(`+${priceChange.toFixed(0)}% (early move)`); }
  else if (priceChange < -20) { score -= 1; factors.push(`${priceChange.toFixed(0)}% (dumping)`); }

  // Volume (USD)
  if (volume > 50_000_000)    { score += 4; factors.push(`$${(volume/1e6).toFixed(0)}M volume (massive)`); }
  else if (volume > 10_000_000){ score += 3; factors.push(`$${(volume/1e6).toFixed(1)}M volume (high)`); }
  else if (volume > 1_000_000) { score += 2; factors.push(`$${(volume/1e6).toFixed(1)}M volume`); }
  else if (volume > 100_000)   { score += 1; factors.push(`$${(volume/1e3).toFixed(0)}K volume`); }
  else                         { score -= 2; factors.push('Low volume (<$100K) — risky'); }

  // Trade count (social/retail interest)
  if (count > 100_000)  { score += 2; factors.push(`${count.toLocaleString()} trades (viral activity)`); }
  else if (count > 20_000) { score += 1; factors.push(`${count.toLocaleString()} trades`); }

  // Price position in 24h range (closer to high = strong buying)
  const rangePos = high24h > low24h ? (lastPrice - low24h) / (high24h - low24h) : 0.5;
  if (rangePos > 0.85)       { score += 1; factors.push('Near 24H high (strong buyers)'); }
  else if (rangePos < 0.15)  { score -= 1; factors.push('Near 24H low (sellers in control)'); }

  const confidence = Math.min(100, Math.max(0, Math.round((score / 12) * 100)));

  return {
    score,
    confidence,
    factors,
    priceChange,
    volume,
    count,
    lastPrice,
    high24h,
    low24h,
    rangePos,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Fetch all Binance 24hr tickers
    const [tickerResp, exchangeResp] = await Promise.all([
      axios.get(`${BINANCE_BASE}/ticker/24hr`, { timeout: 15000 }),
      axios.get(`${BINANCE_BASE}/exchangeInfo`, { timeout: 15000 }),
    ]);

    const allTickers = tickerResp.data;
    const allSymbols = new Set(exchangeResp.data.symbols.map(s => s.symbol));

    // 2. Filter to USDT pairs not in established list
    const candidates = allTickers.filter(t => {
      const sym = t.symbol;
      return sym.endsWith('USDT') &&
        !ESTABLISHED.has(sym) &&
        allSymbols.has(sym) &&
        parseFloat(t.quoteVolume) > 50_000;  // Min $50K volume to filter dust
    });

    // 3. Score each candidate
    const scored = candidates.map(t => {
      const { score, confidence, factors, priceChange, volume, count, lastPrice, high24h, low24h } = scoreTicker(t);
      return {
        symbol: t.symbol,
        exchange: 'Binance',
        price: lastPrice,
        priceChange,
        volume,
        tradeCount: count,
        high24h,
        low24h,
        score,
        confidence,
        factors,
        pumpRating: score >= 8 ? 'HOT' : score >= 5 ? 'WARM' : score >= 2 ? 'WATCH' : 'COLD',
        scannedAt: new Date().toISOString(),
      };
    });

    // 4. Sort by score descending, take top 20
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    // 5. Kraken new listings (simpler: compare Kraken pairs vs known)
    let krakenNew = [];
    try {
      const krakenResp = await axios.get(`${KRAKEN_BASE}/AssetPairs`, { timeout: 10000 });
      const krakenPairs = Object.values(krakenResp.data.result || {});
      krakenNew = krakenPairs
        .filter(p => p.quote === 'ZUSD' || p.quote === 'USD')
        .filter(p => {
          // Convert to USDT name and check if established
          const base = p.base.replace(/^[XZ]/, '');  // Kraken prefixes
          return !ESTABLISHED.has(`${base}USDT`) && !ESTABLISHED.has(`${base}USD`);
        })
        .map(p => ({ krakenPair: p.altname, base: p.base.replace(/^[XZ]/, ''), exchange: 'Kraken' }))
        .slice(0, 10);
    } catch {
      // Kraken secondary — failure is acceptable
    }

    res.status(200).json({
      success: true,
      totalScanned: candidates.length,
      topListings: top,
      krakenNew,
      scannedAt: new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
