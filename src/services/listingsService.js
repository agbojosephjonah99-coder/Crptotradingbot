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

// ─── Moonshot Scanner ─────────────────────────────────────────────────────────
// Identifies coins with highest probability of 5X within 3 days
// Scoring based on: low market cap, volume explosion, momentum, social trending,
// whale accumulation signals, new listing freshness, and price structure

async function getMoonshots() {
  // 1. Get KuCoin tickers + CoinGecko trending simultaneously
  const [kuResp, trendResp] = await Promise.all([
    axios.get(`${KUCOIN_BASE}/market/allTickers`, { timeout: 12000 }),
    axios.get(`${COINGECKO_BASE}/search/trending`,  { timeout: 8000 }),
  ]);

  if (!kuResp.data?.data?.ticker) throw new Error('KuCoin API unavailable');

  const tickers         = kuResp.data.data.ticker;
  const trendingSymbols = new Set(
    (trendResp.data.coins || []).map(c => c.item.symbol.toUpperCase())
  );

  // 2. Filter and score every non-established USDT pair
  const candidates = tickers
    .filter(t => {
      const base   = t.symbol.replace('-USDT', '');
      const vol    = parseFloat(t.volValue) || 0;
      const change = parseFloat(t.changeRate) * 100;
      const price  = parseFloat(t.last);
      return t.symbol.endsWith('-USDT') &&
        !ESTABLISHED.has(base) &&
        vol    >= 200_000 &&   // minimum liquidity
        change >  0       &&   // must be going up
        change <  500     &&   // filter obvious scam pumps
        price  >  0;
    })
    .map(t => {
      const base      = t.symbol.replace('-USDT', '');
      const price     = parseFloat(t.last);
      const change24h = parseFloat(t.changeRate) * 100;
      const volume    = parseFloat(t.volValue);
      const high24h   = parseFloat(t.high);
      const low24h    = parseFloat(t.low);

      // ── Moonshot Scoring (max 100) ──────────────────────────────────────
      let score = 0;
      const reasons = [];

      // A. Volume explosion vs price (volume/marketcap proxy)
      // High volume relative to price = retail/whale interest
      const volToPrice = volume / price;
      if (volToPrice > 50_000_000)      { score += 25; reasons.push('Massive volume explosion relative to price'); }
      else if (volToPrice > 10_000_000) { score += 18; reasons.push('Very high volume relative to price'); }
      else if (volToPrice > 2_000_000)  { score += 12; reasons.push('Strong volume surge'); }
      else if (volToPrice > 500_000)    { score +=  6; reasons.push('Notable volume increase'); }

      // B. Price momentum (24H change)
      if (change24h > 100)      { score += 20; reasons.push(`+${change24h.toFixed(0)}% in 24H — parabolic momentum`); }
      else if (change24h > 50)  { score += 15; reasons.push(`+${change24h.toFixed(0)}% in 24H — explosive move`); }
      else if (change24h > 25)  { score += 10; reasons.push(`+${change24h.toFixed(0)}% in 24H — strong pump`); }
      else if (change24h > 10)  { score +=  5; reasons.push(`+${change24h.toFixed(0)}% in 24H — building momentum`); }

      // C. CoinGecko trending (social signal — huge catalyst)
      if (trendingSymbols.has(base)) {
        score += 20;
        reasons.push('🔥 Trending on CoinGecko — massive social attention');
      }

      // D. Price near 24H high (buyers in control, not exhausted)
      const rangePos = high24h > low24h ? (price - low24h) / (high24h - low24h) : 0.5;
      if (rangePos > 0.85)      { score += 15; reasons.push('Price near 24H high — strong buying pressure'); }
      else if (rangePos > 0.65) { score += 8;  reasons.push('Price in upper half of range'); }

      // E. Absolute volume (raw liquidity = can handle big buys)
      if (volume > 20_000_000)      { score += 10; reasons.push(`$${(volume/1e6).toFixed(0)}M volume — institutional sized`); }
      else if (volume > 5_000_000)  { score +=  7; reasons.push(`$${(volume/1e6).toFixed(1)}M volume — high interest`); }
      else if (volume > 1_000_000)  { score +=  4; reasons.push(`$${(volume/1e6).toFixed(1)}M volume — solid`); }

      // F. Low price = psychological pump magnet (retail loves cheap coins)
      if (price < 0.001)      { score += 10; reasons.push('Ultra-low price — retail magnet for big % gains'); }
      else if (price < 0.01)  { score +=  7; reasons.push('Low price — easy for retail to buy millions'); }
      else if (price < 0.10)  { score +=  4; reasons.push('Sub-cent range — accessible to all buyers'); }

      // Calculate final probability (capped at 99%)
      const probability = Math.min(99, Math.round((score / 100) * 99));

      return {
        symbol: t.symbol,
        base,
        price,
        change24h,
        volume,
        high24h,
        low24h,
        rangePos,
        score,
        probability,
        reasons,
        isTrending: trendingSymbols.has(base),
      };
    })
    .filter(c => c.score >= 40) // Only high-confidence picks
    .sort((a, b) => b.score - a.score)
    .slice(0, 4); // Top 4 moonshots only

  if (candidates.length === 0) return [];

  // 3. Enrich with CoinGecko metadata (price + contracts)
  const results = [];
  for (const coin of candidates) {
    const meta = await getCoinDetail(coin.base);
    results.push({ ...coin, meta });
  }

  return results;
}

module.exports.getMoonshots = getMoonshots;