/**
 * ─── New Listings Service (KuCoin + CoinGecko) ───────────────────────────────
 * KuCoin for market data (no geo-restrictions)
 * CoinGecko for coin name, current price, and contract addresses
 */

const axios = require('axios');

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
  'avalanche':           'Avalanche (C-Chain)',
  'sui':                 'Sui',
  'tron':                'Tron (TRC-20)',
  'ton':                 'TON',
  'optimistic-ethereum': 'Optimism',
  'fantom':              'Fantom',
};

// ─── Get full coin detail from CoinGecko (price + contracts) ─────────────────
async function getCoinDetail(symbolOrId, isId = false) {
  try {
    let cgId = symbolOrId;

    if (!isId) {
      const searchResp = await axios.get(`${COINGECKO_BASE}/search`, {
        params: { query: symbolOrId },
        timeout: 6000,
      });
      const coins = searchResp.data.coins || [];
      const match = coins.find(c => c.symbol.toUpperCase() === symbolOrId.toUpperCase()) || coins[0];
      if (!match) return null;
      cgId = match.id;
    }

    const r = await axios.get(`${COINGECKO_BASE}/coins/${cgId}`, {
      params: {
        localization:     false,
        tickers:          false,
        market_data:      true,
        community_data:   false,
        developer_data:   false,
      },
      timeout: 8000,
    });

    const coin      = r.data;
    const md        = coin.market_data || {};
    const platforms = coin.platforms   || {};

    const contracts = Object.entries(platforms)
      .filter(([, addr]) => addr && addr.length > 5)
      .map(([chain, addr]) => ({
        chain,
        chainLabel: CHAIN_LABELS[chain] || chain,
        address:    addr,
      }));

    return {
      id:            coin.id,
      name:          coin.name,
      symbol:        coin.symbol?.toUpperCase(),
      description:   (coin.description?.en || '').split('.')[0].slice(0, 120),
      currentPrice:  md.current_price?.usd   || null,
      priceChange24h: md.price_change_percentage_24h || null,
      marketCap:     md.market_cap?.usd       || null,
      volume24h:     md.total_volume?.usd     || null,
      ath:           md.ath?.usd              || null,
      athChange:     md.ath_change_percentage?.usd || null,
      contracts,
      isNativeAsset: contracts.length === 0,
      cgUrl:         `https://www.coingecko.com/en/coins/${coin.id}`,
    };
  } catch (err) {
    console.warn(`[CoinGecko] ${symbolOrId}:`, err.message);
    return null;
  }
}

// ─── Get hot new coins from KuCoin ────────────────────────────────────────────
async function getKuCoinNewListings() {
  const r = await axios.get(`${KUCOIN_BASE}/market/allTickers`, { timeout: 12000 });
  if (!r.data?.data?.ticker) throw new Error('KuCoin API unavailable');

  return r.data.data.ticker
    .filter(t => {
      const base   = t.symbol.replace('-USDT', '');
      const vol    = parseFloat(t.volValue)    || 0;
      const change = parseFloat(t.changeRate)  * 100;
      return t.symbol.endsWith('-USDT') &&
        !ESTABLISHED.has(base) &&
        vol     >= 300_000 &&
        change  >  3      &&
        change  <  300    &&
        parseFloat(t.last) > 0;
    })
    .map(t => ({
      symbol:    t.symbol,
      base:      t.symbol.replace('-USDT', ''),
      price:     parseFloat(t.last),
      change24h: parseFloat(t.changeRate) * 100,
      volume:    parseFloat(t.volValue),
      high24h:   parseFloat(t.high),
      low24h:    parseFloat(t.low),
    }))
    .sort((a, b) => {
      const score = c => (c.volume / 1e6) * 0.5 + c.change24h * 0.3 +
        (c.high24h > 0 ? (c.price / c.high24h) * 100 * 0.2 : 0);
      return score(b) - score(a);
    })
    .slice(0, 6);
}

// ─── Get CoinGecko trending + full details ────────────────────────────────────
async function getTrendingWithDetails() {
  const r = await axios.get(`${COINGECKO_BASE}/search/trending`, { timeout: 8000 });
  const coins = (r.data.coins || []).slice(0, 5);

  const detailed = [];
  for (const c of coins) {
    const detail = await getCoinDetail(c.item.id, true);
    if (detail) detailed.push({ ...detail, trendScore: c.item.score });
  }
  return detailed;
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function getNewListingsWithMetadata() {
  const [kuCoinCoins, trending] = await Promise.all([
    getKuCoinNewListings(),
    getTrendingWithDetails(),
  ]);

  // Enrich KuCoin coins with CoinGecko full detail
  const hotCoins = [];
  for (const coin of kuCoinCoins) {
    const meta = await getCoinDetail(coin.base);
    hotCoins.push({ ...coin, meta });
  }

  return { hotCoins, trending };
}

module.exports = { getNewListingsWithMetadata };