/**
 * ─── Telegram Webhook Handler ─────────────────────────────────────────────────
 * Commands:
 *  help          → show all commands with coin examples
 *  buy SOL 92.50 → register a buy
 *  sell SOL      → remove position
 *  positions     → list open trades
 *  check SOL     → instant advice
 *  newlistings   → hot newly listed coins likely to pump (with contract address)
 */

const axios  = require('axios');
const { addPosition, removePosition, getAllPositions, getPosition } = require('../src/services/positionStore');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Send reply ───────────────────────────────────────────────────────────────
async function reply(chatId, text) {
  if (!BOT_TOKEN) { console.error('[Webhook] BOT_TOKEN not set'); return; }
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[Webhook] Reply failed:', e.message);
  }
}

// ─── Send long message in chunks (Telegram has 4096 char limit) ───────────────
async function replyChunked(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) { await reply(chatId, text); return; }
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line).length > MAX) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) await reply(chatId, chunk);
}

function normaliseSymbol(raw) {
  const u = raw.toUpperCase().trim();
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

// ─── Fetch newly listed coins with pump potential + contract addresses ─────────
async function fetchNewListings() {
  const BINANCE_BASE   = 'https://api.binance.com/api/v3';
  const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

  const ESTABLISHED = new Set([
    'BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','ADAUSDT','SOLUSDT','DOGEUSDT',
    'DOTUSDT','MATICUSDT','LTCUSDT','LINKUSDT','AVAXUSDT','UNIUSDT','ATOMUSDT',
    'ETCUSDT','XLMUSDT','ALGOUSDT','VETUSDT','TRXUSDT','FILUSDT','AAVEUSDT',
    'MKRUSDT','COMPUSDT','YFIUSDT','SUSHIUSDT','CRVUSDT','SNXUSDT','RUNEUSDT',
    'ICPUSDT','NEARUSDT','FTMUSDT','SANDUSDT','MANAUSDT','AXSUSDT','GALAUSDT',
    'ENJUSDT','CHZUSDT','BATUSDT','GRTUSDT','INJUSDT','APTUSDT','GMTUSDT',
    'LDOUSDT','APEUSDT','OPUSDT','ARBUSDT','SUIUSDT','PEPEUSDT','WLDUSDT',
    'SEIUSDT','TIAUSDT','KASUSDT','ORDIUSDT','WIFUSDT','JUPUSDT','BONKUSDT',
    'PYTHUSDT','BOMEUSDT','MEMEUSDT','NOTUSDT','ZKUSDT','TURBOUSDT','DOGSUSDT',
    'GOATUSDT','POPCATUSDT','MEUSDT','MOVEUSDT','VIRTUALUSDT','TRUMPUSDT',
    'EIGENUSDT','CATIUSDT','STRKUSDT','PIXELUSDT','PORTALUSDT','AEVOUSDT',
  ]);

  // 1. Fetch all tickers + exchange info
  const [tickerResp, infoResp] = await Promise.all([
    axios.get(`${BINANCE_BASE}/ticker/24hr`, { timeout: 15000 }),
    axios.get(`${BINANCE_BASE}/exchangeInfo`, { timeout: 15000 }),
  ]);

  const allTickers  = tickerResp.data;
  const baseAssetMap = {};
  infoResp.data.symbols.forEach(s => { baseAssetMap[s.symbol] = s.baseAsset; });

  // 2. Filter to new coins with good volume
  const candidates = allTickers
    .filter(t =>
      t.symbol.endsWith('USDT') &&
      !ESTABLISHED.has(t.symbol) &&
      parseFloat(t.quoteVolume) >= 500_000 &&
      parseFloat(t.priceChangePercent) > 5 &&
      parseFloat(t.priceChangePercent) < 200 // exclude obvious dumps/scams
    )
    .map(t => ({
      symbol:      t.symbol,
      baseAsset:   baseAssetMap[t.symbol] || t.symbol.replace('USDT', ''),
      price:       parseFloat(t.lastPrice),
      change24h:   parseFloat(t.priceChangePercent),
      volume:      parseFloat(t.quoteVolume),
      tradeCount:  parseInt(t.count, 10),
      high24h:     parseFloat(t.highPrice),
      low24h:      parseFloat(t.lowPrice),
    }))
    .sort((a, b) => {
      // Score: weighted mix of volume + momentum + activity
      const scoreA = (a.volume / 1e6) * 0.4 + a.change24h * 0.4 + (a.tradeCount / 10000) * 0.2;
      const scoreB = (b.volume / 1e6) * 0.4 + b.change24h * 0.4 + (b.tradeCount / 10000) * 0.2;
      return scoreB - scoreA;
    })
    .slice(0, 5); // Top 5 only to avoid Telegram spam

  if (candidates.length === 0) return [];

  // 3. Fetch contract addresses from CoinGecko for each
  const results = [];
  for (const coin of candidates) {
    let contractInfo = null;
    try {
      const searchResp = await axios.get(`${COINGECKO_BASE}/search`, {
        params: { query: coin.baseAsset },
        timeout: 6000,
      });
      const match = (searchResp.data.coins || [])
        .find(c => c.symbol.toUpperCase() === coin.baseAsset.toUpperCase());

      if (match) {
        const detailResp = await axios.get(`${COINGECKO_BASE}/coins/${match.id}`, {
          params: { localization: false, tickers: false, market_data: false,
                    community_data: false, developer_data: false },
          timeout: 6000,
        });
        const platforms  = detailResp.data.platforms || {};
        const contracts  = Object.entries(platforms)
          .filter(([, addr]) => addr && addr.length > 5)
          .map(([chain, addr]) => ({ chain, addr }));

        contractInfo = {
          name:      detailResp.data.name,
          contracts,
          cgUrl:     `https://coingecko.com/en/coins/${match.id}`,
        };
      }
    } catch {}

    results.push({ ...coin, contractInfo });
  }

  return results;
}

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleMessage(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help' || cmd === '/start' || cmd === '/help') {
    await reply(chatId, [
      `🤖 *CryptoBot V2 — Command Guide*`,
      ``,
      `━━━ *REGISTER A BUY* ━━━`,
      `\`buy SOL 92.50\``,
      `\`buy BTC 80000\``,
      `\`buy ETH 2300\``,
      `\`buy BNB 580\``,
      `\`buy XRP 2.10\``,
      `\`buy AVAX 25.50\``,
      `\`buy LINK 13.40\``,
      `\`buy INJ 18.20\``,
      `\`buy SUI 3.50\``,
      `\`buy ARB 0.85\``,
      `_Add quantity: \`buy SOL 92.50 10\`_`,
      ``,
      `━━━ *MANAGE POSITIONS* ━━━`,
      `\`positions\` — see all open trades`,
      `\`check SOL\` — get instant advice`,
      `\`sell SOL\` — remove after you exit`,
      ``,
      `━━━ *NEW LISTINGS* ━━━`,
      `\`newlistings\` — hot new coins likely`,
      `to pump in 1-3 days with contract`,
      `addresses so you know what to buy`,
      ``,
      `━━━ *AUTO ALERTS (every hour)* ━━━`,
      `🔴 Stop Loss hit → exit now`,
      `🎯 Take Profit → sell partial`,
      `🟡 Trail stop → protect gains`,
      `⚪ Hold → stay in trade`,
    ].join('\n'));
    return;
  }

  // ── NEW LISTINGS ──────────────────────────────────────────────────────────
  if (cmd === 'newlistings' || cmd === 'listings' || cmd === 'new') {
    await reply(chatId, `🔍 Scanning for hot new listings... give me 20 seconds.`);

    try {
      const listings = await fetchNewListings();

      if (listings.length === 0) {
        await reply(chatId, `😴 No strong new listing signals right now. Check back in 30 minutes.`);
        return;
      }

      for (const coin of listings) {
        const ci = coin.contractInfo;
        const rangePos = coin.high24h > coin.low24h
          ? ((coin.price - coin.low24h) / (coin.high24h - coin.low24h) * 100).toFixed(0)
          : 50;

        const lines = [
          `🔥 *${ci?.name || coin.baseAsset} (${coin.symbol})*`,
          ``,
          `💰 *Price:* \`$${coin.price < 0.01 ? coin.price.toFixed(8) : coin.price.toFixed(4)}\``,
          `📈 *24H Change:* +${coin.change24h.toFixed(2)}%`,
          `💵 *Volume:* $${(coin.volume / 1e6).toFixed(2)}M`,
          `🔢 *Trades:* ${coin.tradeCount.toLocaleString()}`,
          `📊 *Position in range:* ${rangePos}% of 24H range`,
          ``,
        ];

        if (ci?.contracts?.length > 0) {
          lines.push(`📋 *Contract Addresses:*`);
          ci.contracts.slice(0, 3).forEach(c => {
            const chainLabel = {
              'ethereum': 'Ethereum (ERC-20)',
              'binance-smart-chain': 'BNB Chain (BEP-20)',
              'solana': 'Solana (SPL)',
              'arbitrum-one': 'Arbitrum',
              'base': 'Base',
              'polygon-pos': 'Polygon',
              'avalanche': 'Avalanche',
              'sui': 'Sui',
              'tron': 'Tron (TRC-20)',
              'ton': 'TON',
            }[c.chain] || c.chain;
            lines.push(`  *${chainLabel}:*`);
            lines.push(`  \`${c.addr}\``);
          });
          lines.push(`⚠️ _Verify address on CoinGecko before buying_`);
          if (ci.cgUrl) lines.push(`🔗 ${ci.cgUrl}`);
        } else {
          lines.push(`⚠️ *Contract address not found — verify manually*`);
          if (ci?.cgUrl) lines.push(`🔗 ${ci.cgUrl}`);
        }

        lines.push(``);
        lines.push(`📝 *To track this coin:*`);
        lines.push(`\`buy ${coin.symbol} ${coin.price < 0.01 ? coin.price.toFixed(8) : coin.price.toFixed(4)}\``);
        lines.push(`⚠️ _New listings = HIGH RISK. Max 1-2% of account_`);

        await replyChunked(chatId, lines.join('\n'));
      }

      await reply(chatId, `✅ Scan complete. Type \`buy SYMBOL PRICE\` to track any of these.`);

    } catch (err) {
      await reply(chatId, `❌ Error fetching listings: ${err.message}`);
    }
    return;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  if (cmd === 'buy') {
    const rawSymbol = parts[1];
    const buyPrice  = parseFloat(parts[2]);
    const quantity  = parts[3] ? parseFloat(parts[3]) : null;

    if (!rawSymbol || isNaN(buyPrice) || buyPrice <= 0) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`buy SOL 92.50\``,
        `\`buy BTC 80000\``,
        `\`buy SOL 92.50 10\` _(with quantity)_`,
      ].join('\n'));
      return;
    }

    const symbol = normaliseSymbol(rawSymbol);
    await addPosition({ symbol, buyPrice, quantity });

    await reply(chatId, [
      `✅ *Position Registered — ${symbol}*`,
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      quantity ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      ``,
      `Monitoring every hour. You'll get alerts for:`,
      `🔴 Stop Loss | 🎯 Take Profit | 🟡 Trail Stop | ⚪ Hold`,
      ``,
      `Instant check anytime: \`check ${symbol}\``,
    ].filter(Boolean).join('\n'));
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  if (cmd === 'sell' || cmd === 'remove' || cmd === 'sold') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ \`sell SOLUSDT\``); return; }
    const symbol  = normaliseSymbol(rawSymbol);
    const removed = await removePosition(symbol);
    await reply(chatId, removed
      ? `✅ *${symbol}* removed. Good trade! 💸`
      : `⚠️ *${symbol}* not in your positions.`
    );
    return;
  }

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  if (cmd === 'positions' || cmd === 'pos' || cmd === 'portfolio') {
    const all     = await getAllPositions();
    const entries = Object.values(all);

    if (entries.length === 0) {
      await reply(chatId, `📭 *No open positions*\n\nAdd one: \`buy SOL 92.50\``);
      return;
    }

    const lines = [`📊 *Open Positions*`, ``];
    for (const pos of entries) {
      lines.push(`*${pos.symbol}*`);
      lines.push(`  Entry: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      lines.push(`  Status: ${pos.lastRecommendation || 'Pending first check'}`);
      lines.push(`  Checked: ${pos.lastChecked ? new Date(pos.lastChecked).toUTCString() : 'Not yet'}`);
      lines.push(``);
    }
    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── CHECK ─────────────────────────────────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ \`check SOLUSDT\``); return; }
    const symbol = normaliseSymbol(rawSymbol);
    const pos    = await getPosition(symbol);

    if (!pos) {
      await reply(chatId, `⚠️ *${symbol}* not in positions.\n\nAdd it: \`buy ${symbol} YOUR_PRICE\``);
      return;
    }

    await reply(chatId, `🔍 Checking *${symbol}*...`);

    try {
      const adviceModule = require('./v2advice');
      const { candles1h, candles4h, currentPrice } = await adviceModule.fetchCurrentData(symbol);
      const advice = adviceModule.buildAdvice({
        symbol, buyPrice: pos.buyPrice, currentPrice,
        candles1h, candles4h,
        accountSize: pos.accountSize, riskPct: pos.riskPct,
      });

      const tp1 = advice.tradePlan?.takeProfits?.tp1;
      const tp2 = advice.tradePlan?.takeProfits?.tp2;
      const tp3 = advice.tradePlan?.takeProfits?.tp3;
      const sl  = advice.tradePlan?.stopLoss;
      const emoji = { STOP_LOSS:'🔴', TAKE_PROFIT:'🟢', TRAIL_STOP:'🟡', CLOSE_PARTIAL:'🟠', HOLD:'⚪' }[advice.recommendation] || '⚪';

      const lines = [
        `${emoji} *${advice.recommendation} — ${symbol}*`,
        ``,
        `💰 *Bought:* \`$${pos.buyPrice}\``,
        `📊 *Now:*    \`$${Number(advice.currentPrice).toFixed(4)}\``,
        `📈 *P&L:*    ${advice.pnlDisplay}`,
        ``,
        ...(advice.reasons || []).map(r => `  ${r}`),
        ``,
        ...(advice.actions || []).map(a => `  👉 ${a}`),
        ``,
        sl  ? `🛡 Stop Loss: \`$${Number(sl).toFixed(4)}\`` : '',
        tp1 ? `🎯 TP1 (40%): \`$${Number(tp1.price).toFixed(4)}\`` : '',
        tp2 ? `🎯 TP2 (35%): \`$${Number(tp2.price).toFixed(4)}\`` : '',
        tp3 ? `🎯 TP3 (25%): \`$${Number(tp3.price).toFixed(4)}\`` : '',
        ``,
        `RSI: ${advice.indicators?.rsi || 'N/A'} | Trend: ${advice.indicators?.macroTrend || 'N/A'}`,
        `⏰ ${new Date().toUTCString()}`,
      ].filter(Boolean).join('\n');

      await reply(chatId, lines);
    } catch (err) {
      await reply(chatId, `❌ Error fetching ${symbol}: ${err.message}`);
    }
    return;
  }

  // ── Unknown ───────────────────────────────────────────────────────────────
  await reply(chatId, `❓ Unknown command.\n\nType \`help\` to see all commands.`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const { message } = req.body || {};
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = message.chat?.id?.toString();
    const text   = message.text;

    console.log(`[Webhook] From ${chatId}: ${text}`);

    if (CHAT_ID && chatId !== CHAT_ID.toString()) {
      console.warn(`[Webhook] Rejected from unknown chatId: ${chatId}`);
      return res.status(200).json({ ok: true });
    }

    await handleMessage(chatId, text);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(200).json({ ok: true });
  }
};