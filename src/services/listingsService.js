/**
 * ─── New Listings Service (KuCoin + CoinGecko) ───────────────────────────────
 * Uses KuCoin (no geo-restrictions) for market data
 * Uses CoinGecko for coin name + contract addresses
 *
 * WHY KUCOIN:
 *  Binance returns 451 (geo-blocked) from Vercel US servers.
 *  KuCoin has no such restriction and lists many new coins early.
 */

const axios = require('axios');

const KUCOIN_BASE    = 'https://api.kucoin.com/api/v1';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// Known established coins to exclude
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

// ─── Fetch hot new coins from KuCoin ─────────────────────────────────────────
async function getKuCoinNewListings() {
  // Get all tickers
  const r = await axios.get(`${KUCOIN_BASE}/market/allTickers`, { timeout: 12000 });
  if (!r.data?.data?.ticker) throw new Error('KuCoin API error');

  const tickers = r.data.data.ticker;

  // Filter to USDT pairs, exclude established, require volume
  const candidates = tickers
    .filter(t => {
      const base    = t.symbol.replace('-USDT', '');
      const vol     = parseFloat(t.volValue) || 0;   // USD volume
      const change  = parseFloat(t.changeRate) * 100; // 24H change %
      return t.symbol.endsWith('-USDT') &&
        !ESTABLISHED.has(base) &&
        vol >= 300_000 &&        // min $300K volume
        change > 3 &&            // must be moving up
        change < 300 &&          // exclude obvious scam pumps
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
      // Score: volume weight + momentum
      const score = c => (c.volume / 1e6) * 0.5 + c.change24h * 0.3 + (c.high24h > 0 ? (c.price / c.high24h) * 100 * 0.2 : 0);
      return score(b) - score(a);
    })
    .slice(0, 8); // Top 8 candidates

  return candidates;
}

// ─── Get coin metadata from CoinGecko ────────────────────────────────────────
async function getCoinMetadata(baseAsset) {
  try {
    const searchResp = await axios.get(`${COINGECKO_BASE}/search`, {
      params: { query: baseAsset },
      timeout: 6000,
    });

    const coins = searchResp.data.coins || [];
    const match = coins.find(c => c.symbol.toUpperCase() === baseAsset.toUpperCase()) || coins[0];
    if (!match) return null;

    const detailResp = await axios.get(`${COINGECKO_BASE}/coins/${match.id}`, {
      params: { localization: false, tickers: false, market_data: true,
                community_data: false, developer_data: false },
      timeout: 6000,
    });

    const coin      = detailResp.data;
    const platforms = coin.platforms || {};
    const contracts = Object.entries(platforms)
      .filter(([, addr]) => addr && addr.length > 5)
      .map(([chain, addr]) => ({ chain, addr }));

    const CHAIN_LABELS = {
      'ethereum':              'Ethereum (ERC-20)',
      'binance-smart-chain':   'BNB Chain (BEP-20)',
      'solana':                'Solana (SPL)',
      'arbitrum-one':          'Arbitrum',
      'base':                  'Base',
      'polygon-pos':           'Polygon',
      'avalanche':             'Avalanche (C-Chain)',
      'sui':                   'Sui',
      'tron':                  'Tron (TRC-20)',
      'ton':                   'TON',
      'optimistic-ethereum':   'Optimism',
    };

    return {
      id:          coin.id,
      name:        coin.name,
      symbol:      coin.symbol?.toUpperCase(),
      description: (coin.description?.en || '').split('.')[0],
      contracts:   contracts.map(c => ({
        chain:      c.chain,
        chainLabel: CHAIN_LABELS[c.chain] || c.chain,
        address:    c.addr,
      })),
      isNativeAsset: contracts.length === 0,
      cgUrl:       `https://www.coingecko.com/en/coins/${coin.id}`,
      marketCap:   coin.market_data?.market_cap?.usd || null,
      athChange:   coin.market_data?.ath_change_percentage?.usd || null,
    };
  } catch (err) {
    console.warn(`[CoinGecko] ${baseAsset}:`, err.message);
    return null;
  }
}

// ─── Also get CoinGecko trending coins (often pump within 24-72h) ─────────────
async function getCoinGeckoTrending() {
  try {
    const r = await axios.get(`${COINGECKO_BASE}/search/trending`, { timeout: 8000 });
    return (r.data.coins || []).slice(0, 5).map(c => ({
      name:   c.item.name,
      symbol: c.item.symbol,
      rank:   c.item.market_cap_rank,
      cgId:   c.item.id,
      cgUrl:  `https://www.coingecko.com/en/coins/${c.item.id}`,
      thumb:  c.item.thumb,
      score:  c.item.score,
    }));
  } catch {
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function getNewListingsWithMetadata() {
  const [kuCoinCoins, trending] = await Promise.all([
    getKuCoinNewListings(),
    getCoinGeckoTrending(),
  ]);

  // Enrich KuCoin coins with CoinGecko metadata
  const enriched = [];
  for (const coin of kuCoinCoins) {
    const meta = await getCoinMetadata(coin.base);
    enriched.push({ ...coin, meta, source: 'KuCoin' });
  }

  return { hotCoins: enriched, trending };
}

module.exports = { getNewListingsWithMetadata, getCoinGeckoTrending };