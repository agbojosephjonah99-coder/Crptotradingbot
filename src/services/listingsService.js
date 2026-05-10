/**
 * ─── Listings Service ─────────────────────────────────────────────────────────
 * KuCoin for market data + CoinGecko for metadata + probabilityEngine for scoring
 */

const axios = require('axios');
const { calculateProbability } = require('./probabilityEngine');

const KUCOIN_BASE    = 'https://api.kucoin.com/api/v1';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

const ESTABLISHED = new Set([
  'BTC','ETH','BNB','XRP','ADA','SOL','DOGE','DOT','MATIC','LTC',
  'LINK','AVAX','UNI','ATOM','ETC','XLM','ALGO','VET','TRX','FIL',
  'AAVE','MKR','COMP','YFI','SUSHI','CRV','SNX','RUNE','ICP','NEAR',
  'FTM','SAND','MANA','AXS','GALA','ENJ','CHZ','BAT','GRT','INJ',
  'APT','GMT','LDO','STG','APE','OP','ARB','SUI','PEPE','WLD','SEI',
  'TIA','KAS','ORDI','WIF','JUP','BONK','PYTH','BOME','MEME','NOT',
  'ZK','TURBO','DOGS','GOAT','POPCAT','ME','MOVE','VIRTUAL','TRUMP',
  'EIGEN','CATI','STRK','PIXEL','PORTAL','AEVO','ACT','DRIFT',
]);

const CHAIN_LABELS = {
  'ethereum':            'Ethereum (ERC-20)',
  'binance-smart-chain': 'BNB Chain (BEP-20)',
  'solana':              'Solana (SPL)',
  'arbitrum-one':        'Arbitrum',
  'base':                'Base',
  'polygon-pos':         'Polygon',
  'avalanche':           'Avalanche',
  'sui':                 'Sui',
  'tron':                'Tron (TRC-20)',
  'ton':                 'TON',
  'optimistic-ethereum': 'Optimism',
};

// ─── CoinGecko full detail ────────────────────────────────────────────────────
async function getCoinDetail(symbolOrId, isId = false) {
  try {
    let cgId = symbolOrId;
    if (!isId) {
      const s = await axios.get(`${COINGECKO_BASE}/search`, {
        params: { query: symbolOrId }, timeout: 6000,
      });
      const match = (s.data.coins || []).find(c => c.symbol.toUpperCase() === symbolOrId.toUpperCase())
        || s.data.coins?.[0];
      if (!match) return null;
      cgId = match.id;
    }

    const r = await axios.get(`${COINGECKO_BASE}/coins/${cgId}`, {
      params: { localization: false, tickers: false, market_data: true,
                community_data: false, developer_data: false },
      timeout: 8000,
    });

    const coin      = r.data;
    const md        = coin.market_data || {};
    const platforms = coin.platforms   || {};
    const contracts = Object.entries(platforms)
      .filter(([, a]) => a && a.length > 5)
      .map(([chain, address]) => ({
        chain, address,
        chainLabel: CHAIN_LABELS[chain] || chain,
      }));

    return {
      id:            coin.id,
      name:          coin.name,
      symbol:        coin.symbol?.toUpperCase(),
      description:   (coin.description?.en || '').split('.')[0].slice(0, 120),
      currentPrice:  md.current_price?.usd        || null,
      priceChange24h: md.price_change_percentage_24h || null,
      marketCap:     md.market_cap?.usd            || null,
      volume24h:     md.total_volume?.usd          || null,
      contracts,
      isNativeAsset: contracts.length === 0,
      cgUrl:         `https://www.coingecko.com/en/coins/${coin.id}`,
    };
  } catch { return null; }
}

// ─── KuCoin tickers ───────────────────────────────────────────────────────────
async function getKuCoinTickers() {
  const r = await axios.get(`${KUCOIN_BASE}/market/allTickers`, { timeout: 12000 });
  if (!r.data?.data?.ticker) throw new Error('KuCoin API unavailable');

  return r.data.data.ticker
    .filter(t => {
      const base   = t.symbol.replace('-USDT', '');
      const vol    = parseFloat(t.volValue) || 0;
      const change = parseFloat(t.changeRate) * 100;
      return t.symbol.endsWith('-USDT') &&
        !ESTABLISHED.has(base) &&
        vol    >= 200_000 &&
        change >  0       &&
        change <  600     &&
        parseFloat(t.last) > 0;
    })
    .map(t => ({
      kuCoinSymbol: t.symbol,
      base:         t.symbol.replace('-USDT', ''),
      price:        parseFloat(t.last),
      change24h:    parseFloat(t.changeRate) * 100,
      volume:       parseFloat(t.volValue),
      high24h:      parseFloat(t.high),
      low24h:       parseFloat(t.low),
      tradeCount:   parseInt(t.count || 0, 10),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 30); // Pre-filter top 30 by volume for deep analysis
}

// ─── CoinGecko trending ───────────────────────────────────────────────────────
async function getTrendingWithDetails() {
  const r       = await axios.get(`${COINGECKO_BASE}/search/trending`, { timeout: 8000 });
  const coins   = (r.data.coins || []).slice(0, 5);
  const detailed = [];
  for (const c of coins) {
    const detail = await getCoinDetail(c.item.id, true);
    if (detail) detailed.push({ ...detail, trendScore: c.item.score });
  }
  return detailed;
}

// ─── Main: getMoonshots ───────────────────────────────────────────────────────
async function getMoonshots() {
  // Get KuCoin tickers + trending symbols simultaneously
  const [tickers, trendResp] = await Promise.all([
    getKuCoinTickers(),
    axios.get(`${COINGECKO_BASE}/search/trending`, { timeout: 8000 }).catch(() => ({ data: { coins: [] } })),
  ]);

  const trendingSymbols = new Set(
    (trendResp.data.coins || []).map(c => c.item.symbol.toUpperCase())
  );

  // Deep analysis: enrich top candidates with metadata + probability
  const results = [];

  for (const coin of tickers) {
    // Fetch CoinGecko metadata
    const meta = await getCoinDetail(coin.base);

    // Run full 7-factor probability analysis
    const prob = await calculateProbability(coin, meta, trendingSymbols);

    // Only include if probability >= 55% (cuts out trash)
    if (prob.probability < 55) continue;

    results.push({
      ...coin,
      meta,
      probability:    prob.probability,
      band:           prob.band,
      positionAdvice: prob.positionAdvice,
      factors:        prob.factors,
      greenSignals:   prob.greenSignals,
      redFlags:       prob.redFlags,
      skipReason:     prob.skipReason,
      isTrending:     trendingSymbols.has(coin.base.toUpperCase()),
    });
  }

  // Sort by probability descending
  return results.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

// ─── Main: getNewListingsWithMetadata ─────────────────────────────────────────
async function getNewListingsWithMetadata() {
  const [tickers, trending] = await Promise.all([
    getKuCoinTickers(),
    getTrendingWithDetails(),
  ]);

  const hotCoins = [];
  for (const coin of tickers.slice(0, 10)) {
    const meta = await getCoinDetail(coin.base);
    hotCoins.push({ ...coin, meta });
  }

  return { hotCoins, trending };
}

module.exports = { getMoonshots, getNewListingsWithMetadata };