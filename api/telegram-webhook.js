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

// ─── Persistent MENU button (always visible at bottom of chat) ───────────────
const PERSISTENT_MENU = {
  keyboard: [[{ text: '📋 MENU' }]],
  resize_keyboard:   true,
  persistent:        true,
  input_field_placeholder: 'Tap MENU or type a command...',
};

// ─── Inline command buttons (shown when MENU is tapped) ───────────────────────
const INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '🔍 Scan Now',      callback_data: 'scan'        },
      { text: '🌕 Moonshots',     callback_data: 'moonshots'   },
    ],
    [
      { text: '🚀 New Listings',  callback_data: 'newlistings' },
      { text: '📊 My Positions',  callback_data: 'positions'   },
    ],
    [
      { text: '💰 Buy a Coin',    callback_data: 'buy_help'    },
      { text: '💸 Sell a Coin',   callback_data: 'sell_help'   },
    ],
    [
      { text: '📖 Help',          callback_data: 'help'        },
    ],
  ],
};

// ─── Send reply (always sets persistent MENU button) ─────────────────────────
async function reply(chatId, text, showInlineMenu = false) {
  if (!BOT_TOKEN) { console.error('[Webhook] BOT_TOKEN not set'); return; }
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:      chatId,
        text,
        parse_mode:   'Markdown',
        disable_web_page_preview: true,
        reply_markup: showInlineMenu ? INLINE_MENU : PERSISTENT_MENU,
      },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[Webhook] Reply failed:', e.message);
  }
}

// ─── Send long message in chunks ──────────────────────────────────────────────
async function replyChunked(chatId, text, showInlineMenu = false) {
  const MAX = 4000;
  if (text.length <= MAX) {
    await reply(chatId, text, showInlineMenu);
    return;
  }
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
  for (let i = 0; i < chunks.length; i++) {
    await reply(chatId, chunks[i], i === chunks.length - 1 ? showInlineMenu : false);
  }
}

// ─── Answer callback query (when button is tapped) ────────────────────────────
async function answerCallback(callbackQueryId) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      { callback_query_id: callbackQueryId },
      { timeout: 5000 }
    );
  } catch (e) {
    console.error('[Webhook] answerCallback failed:', e.message);
  }
}

function normaliseSymbol(raw) {
  const u = raw.toUpperCase().trim();
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

// ─── Fetch newly listed coins (uses KuCoin — no geo-restrictions) ────────────
async function fetchNewListings() {
  const { getNewListingsWithMetadata } = require('../src/services/listingsService');
  return await getNewListingsWithMetadata();
}


// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleMessage(chatId, text) {
  // Strip leading slash so /buy works same as buy
  const cleanText = text.trim().startsWith('/') ? text.trim().slice(1) : text.trim();
  const parts = cleanText.split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  // ── MENU (tapping the MENU button) ──────────────────────────────────────
  if (cmd === 'menu' || cmd === '📋 menu' || text.trim() === '📋 MENU') {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text:       '*What would you like to do?*\n\nTap a button below:',
        parse_mode: 'Markdown',
        reply_markup: INLINE_MENU,
      },
      { timeout: 8000 }
    ).catch(e => console.error('[Webhook] Menu reply failed:', e.message));
    return;
  }

  // ── START (first time / re-trigger menu) ────────────────────────────────
  if (cmd === 'start') {
    // Send persistent keyboard first
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text:       '👋 *Welcome to CryptoBot V2!*\n\nTap the *📋 MENU* button below to get started.',
        parse_mode: 'Markdown',
        reply_markup: PERSISTENT_MENU,
      },
      { timeout: 8000 }
    ).catch(e => console.error('[Webhook] Start failed:', e.message));
    return;
  }

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
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
      const { hotCoins, trending } = await fetchNewListings();

      if (hotCoins.length === 0 && trending.length === 0) {
        await reply(chatId, `😴 No strong new listing signals right now. Check back in 30 minutes.`);
        return;
      }

      // Send hot coins from KuCoin
      if (hotCoins.length > 0) {
        await reply(chatId, `🔥 *Top New Listings with Pump Potential*\n_Sourced from KuCoin — verified on CoinGecko_`);

        for (const coin of hotCoins.slice(0, 5)) {
          const meta     = coin.meta;
          const rangePos = coin.high24h > coin.low24h
            ? ((coin.price - coin.low24h) / (coin.high24h - coin.low24h) * 100).toFixed(0)
            : 50;
          const priceStr = coin.price < 0.01 ? coin.price.toFixed(8) : coin.price.toFixed(4);

          const lines = [
            `🚀 *${meta?.name || coin.base} (${coin.base}/USDT)*`,
            ``,
            `💰 *Price:* \`$${priceStr}\``,
            `📈 *24H Change:* +${coin.change24h.toFixed(2)}%`,
            `💵 *Volume:* $${(coin.volume / 1e6).toFixed(2)}M`,
            `📊 *In 24H range:* ${rangePos}%`,
            meta?.description ? `📄 _${meta.description.slice(0, 100)}..._` : '',
            ``,
          ];

          if (meta?.contracts?.length > 0) {
            lines.push(`📋 *Contract Addresses:*`);
            meta.contracts.slice(0, 3).forEach(c => {
              lines.push(`  *${c.chainLabel}:*`);
              lines.push(`  \`${c.address}\``);
            });
            lines.push(`⚠️ _Always verify on CoinGecko before buying_`);
            if (meta.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
          } else if (meta?.isNativeAsset) {
            lines.push(`ℹ️ _Native chain asset — no contract address_`);
            if (meta.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
          } else {
            lines.push(`⚠️ _Contract not found — verify manually before buying_`);
            if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
          }

          lines.push(``);
          lines.push(`📝 *Track this:* \`buy ${coin.base} ${priceStr}\``);
          lines.push(`⚠️ _HIGH RISK — max 1-2% of account_`);

          await replyChunked(chatId, lines.filter(Boolean).join('\n'));
        }
      }

      // Send CoinGecko trending coins with full details
      if (trending.length > 0) {
        await reply(chatId, `🌊 *CoinGecko Trending Coins*\n_These often pump within 24-72h of trending_`);

        for (const c of trending) {
          const priceStr = c.currentPrice
            ? (c.currentPrice < 0.01 ? c.currentPrice.toFixed(8) : c.currentPrice.toFixed(4))
            : 'N/A';
          const changeStr = c.priceChange24h
            ? `${c.priceChange24h >= 0 ? '+' : ''}${c.priceChange24h.toFixed(2)}%`
            : 'N/A';
          const volStr = c.volume24h
            ? `$${(c.volume24h / 1e6).toFixed(2)}M`
            : 'N/A';
          const mcapStr = c.marketCap
            ? `$${(c.marketCap / 1e6).toFixed(1)}M`
            : 'N/A';

          const tLines = [
            `🌊 *${c.name} (${c.symbol})*`,
            ``,
            `💰 *Price:*      \`$${priceStr}\``,
            `📈 *24H Change:* ${changeStr}`,
            `💵 *Volume:*     ${volStr}`,
            `🏦 *Market Cap:* ${mcapStr}`,
            c.description ? `📄 _${c.description}_` : '',
            ``,
          ];

          if (c.contracts?.length > 0) {
            tLines.push(`📋 *Contract Addresses:*`);
            c.contracts.slice(0, 3).forEach(ct => {
              tLines.push(`  *${ct.chainLabel}:*`);
              tLines.push(`  \`${ct.address}\``);
            });
            tLines.push(`⚠️ _Verify on CoinGecko before buying_`);
          } else if (c.isNativeAsset) {
            tLines.push(`ℹ️ _Native asset — no contract address_`);
          } else {
            tLines.push(`⚠️ _Contract not found — verify manually_`);
          }

          tLines.push(``);
          tLines.push(`🔗 ${c.cgUrl}`);
          if (c.currentPrice) {
            tLines.push(`📝 *Track it:* \`buy ${c.symbol} ${priceStr}\``);
          }
          tLines.push(`⚠️ _HIGH RISK — max 1-2% of account_`);

          await replyChunked(chatId, tLines.filter(Boolean).join('\n'));
        }
      }

      await reply(chatId, `✅ Done. Use \`buy SYMBOL PRICE\` to track any coin.`);

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

  // ── SCAN (manual moonshot trigger) ──────────────────────────────────────
  if (cmd === 'scan' || cmd === 'search' || cmd === 'find') {
    await reply(chatId, [
      `🔍 *Scanning entire market for 99% pump candidates...*`,
      ``,
      `Checking volume, momentum, social trending,`,
      `whale activity and price structure.`,
      `Give me 30 seconds...`,
    ].join('\n'));

    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const moonshots = await getMoonshots();

      if (moonshots.length === 0) {
        await reply(chatId, [
          `😴 *No high-confidence picks right now*`,
          ``,
          `The scanner checked the entire market and nothing`,
          `is meeting the 99% confidence threshold at this moment.`,
          ``,
          `Try again in 30-60 minutes. Markets change fast.`,
        ].join('\n'));
        return;
      }

      await reply(chatId, `✅ *Found ${moonshots.length} high-confidence pick${moonshots.length > 1 ? 's' : ''} — ${new Date().toUTCString()}*`);

      for (const coin of moonshots) {
        const meta     = coin.meta;
        const priceStr = coin.price < 0.001
          ? coin.price.toFixed(8)
          : coin.price < 0.01
            ? coin.price.toFixed(6)
            : coin.price.toFixed(4);

        const cgPrice = meta?.currentPrice
          ? (meta.currentPrice < 0.001
              ? meta.currentPrice.toFixed(8)
              : meta.currentPrice.toFixed(4))
          : priceStr;

        const t2x = (parseFloat(cgPrice) * 2).toFixed(6);
        const t3x = (parseFloat(cgPrice) * 3).toFixed(6);
        const t4x = (parseFloat(cgPrice) * 4).toFixed(6);
        const t5x = (parseFloat(cgPrice) * 5).toFixed(6);

        const bandEmoji = {
          'VERY HIGH': '🟢', 'HIGH': '🟡',
          'MODERATE': '🟠', 'LOW': '🔴', 'VERY LOW': '⛔',
        }[coin.band] || '⚪';

        const lines = [
          `🌕 *${meta?.name || coin.base} (${coin.base}/USDT)*`,
          ``,
          `${bandEmoji} *Pump Probability: ${coin.probability}% — ${coin.band} CONFIDENCE*`,
          ``,
          `💰 *Current Price:* \`$${cgPrice}\``,
          `📈 *24H Change:*    +${coin.change24h.toFixed(2)}%`,
          `💵 *24H Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
          meta?.marketCap ? `🏦 *Market Cap:*    $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
          coin.isTrending ? `🔥 *TRENDING on CoinGecko right now*` : '',
          ``,
          `🎯 *PROFIT TARGETS:*`,
          `  2X → \`$${t2x}\` (+100%)`,
          `  3X → \`$${t3x}\` (+200%)`,
          `  4X → \`$${t4x}\` (+300%)`,
          `  5X → \`$${t5x}\` (+400%)`,
          ``,
          `📊 *Factor Breakdown:*`,
          `  Volume Quality:   ${coin.factors?.volumeQuality?.score || 0}/${coin.factors?.volumeQuality?.max || 20}`,
          `  Price Structure:  ${coin.factors?.priceStructure?.score || 0}/${coin.factors?.priceStructure?.max || 20}`,
          `  Market Cap Risk:  ${coin.factors?.marketCapRisk?.score || 0}/${coin.factors?.marketCapRisk?.max || 15}`,
          `  Liquidity:        ${coin.factors?.liquidity?.score || 0}/${coin.factors?.liquidity?.max || 15}`,
          `  Momentum:         ${coin.factors?.momentum?.score || 0}/${coin.factors?.momentum?.max || 15}`,
          `  Social Signal:    ${coin.factors?.socialSignal?.score || 0}/${coin.factors?.socialSignal?.max || 10}`,
          coin.factors?.redFlagPenalty < 0 ? `  Red Flag Penalty: ${coin.factors.redFlagPenalty}` : '',
          ``,
          coin.greenSignals?.length > 0 ? `✅ *What looks good:*` : '',
          ...(coin.greenSignals || []).slice(0, 4).map(g => `  • ${g}`),
          ``,
          coin.redFlags?.length > 0 ? `⚠️ *Risk warnings:*` : '',
          ...(coin.redFlags || []).slice(0, 4).map(f => `  • ${f}`),
          ``,
          `💼 *Recommended position size:* ${coin.positionAdvice}`,
          ``,
        ];

        // Contract addresses
        if (meta?.contracts?.length > 0) {
          lines.push(`📋 *Contract Addresses:*`);
          meta.contracts.slice(0, 3).forEach(ct => {
            lines.push(`  *${ct.chainLabel}:*`);
            lines.push(`  \`${ct.address}\``);
          });
          lines.push(`⚠️ _Verify on CoinGecko before buying_`);
        } else if (meta?.isNativeAsset) {
          lines.push(`ℹ️ _Native asset — no contract address_`);
        } else {
          lines.push(`⚠️ _Contract not found — verify on CoinGecko_`);
        }

        if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);

        lines.push(``);
        lines.push(`── *TRACK THIS COIN* ──`);
        lines.push(`\`buy ${coin.base} ${cgPrice} 2x\` ← alert when 2X`);
        lines.push(`\`buy ${coin.base} ${cgPrice} 3x\` ← alert when 3X`);
        lines.push(`\`buy ${coin.base} ${cgPrice} 5x\` ← alert when 5X`);
        lines.push(`⚠️ _HIGH RISK — max 1-2% of account only_`);

        await replyChunked(chatId, lines.filter(Boolean).join('\n'));
      }

    } catch (err) {
      await reply(chatId, `❌ Scan failed: ${err.message}`);
    }
    return;
  }

  // ── MOONSHOTS ─────────────────────────────────────────────────────────────
  if (cmd === 'moonshots' || cmd === 'moon' || cmd === '5x') {
    await reply(chatId, `🚀 Scanning for 5X moonshot candidates... give me 30 seconds.`);

    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const moonshots = await getMoonshots();

      if (moonshots.length === 0) {
        await reply(chatId, [
          `😴 *No moonshot candidates right now*`,
          ``,
          `The market doesn't have any coins meeting the high-confidence`,
          `criteria at this moment. Check back in 1-2 hours.`,
          ``,
          `_Criteria: volume explosion + strong momentum + social trending_`,
        ].join('\n'));
        return;
      }

      await reply(chatId, `🎯 *Found ${moonshots.length} high-probability 5X candidate${moonshots.length > 1 ? 's' : ''}*`);

      for (const coin of moonshots) {
        const meta     = coin.meta;
        const priceStr = coin.price < 0.001
          ? coin.price.toFixed(8)
          : coin.price < 0.01
            ? coin.price.toFixed(6)
            : coin.price.toFixed(4);

        const cgPrice = meta?.currentPrice
          ? (meta.currentPrice < 0.001 ? meta.currentPrice.toFixed(8) : meta.currentPrice.toFixed(4))
          : null;

        const lines = [
          `🌕 *${meta?.name || coin.base} (${coin.base}/USDT)*`,
          ``,
          `⚡ *This coin has a ${coin.probability}% chance of a 5X increase within 3 days. BUY NOW.*`,
          ``,
          `💰 *Current Price:* \`$${cgPrice || priceStr}\``,
          `📈 *24H Change:*    +${coin.change24h.toFixed(2)}%`,
          `💵 *24H Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
          meta?.marketCap ? `🏦 *Market Cap:*    $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
          `📊 *Momentum Score:* ${coin.score}/100`,
          coin.isTrending ? `🔥 *TRENDING on CoinGecko right now*` : '',
          ``,
          `📋 *Why this coin:*`,
          ...coin.reasons.map(r => `  ✅ ${r}`),
          ``,
        ];

        // Contract addresses
        if (meta?.contracts?.length > 0) {
          lines.push(`📋 *Contract Addresses:*`);
          meta.contracts.slice(0, 3).forEach(ct => {
            lines.push(`  *${ct.chainLabel}:*`);
            lines.push(`  \`${ct.address}\``);
          });
          lines.push(`⚠️ _Always verify on CoinGecko before buying_`);
        } else if (meta?.isNativeAsset) {
          lines.push(`ℹ️ _Native chain asset — no contract address needed_`);
        } else {
          lines.push(`⚠️ _Contract address not found — verify on CoinGecko_`);
        }

        if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);

        lines.push(``);
        lines.push(`── *TRADE PLAN* ──`);
        lines.push(`📝 *Track it:* \`buy ${coin.base} ${cgPrice || priceStr}\``);
        lines.push(`🔴 *Exit rule:* If down 15% from entry → cut losses immediately`);
        lines.push(`🎯 *Target:* 5X from entry price = \`$${(parseFloat(cgPrice || priceStr) * 5).toFixed(4)}\``);
        lines.push(`⚠️ _This is a HIGH RISK, HIGH REWARD setup. Max 1-2% of account only._`);

        await replyChunked(chatId, lines.filter(Boolean).join('\n'));
      }

    } catch (err) {
      await reply(chatId, `❌ Moonshot scan failed: ${err.message}`);
    }
    return;
  }

  // ── BUY GUIDE (from button) ──────────────────────────────────────────────
  if (cmd === 'buy_guide') {
    await reply(chatId, [
      `💰 *How to Register a Buy*`,
      ``,
      `*Basic — just track the coin:*`,
      `\`buy SOL 92.50\``,
      `\`buy BTC 80000\``,
      `\`buy ETH 2300\``,
      ``,
      `*With a 2X target alert:*`,
      `\`buy SOL 92.50 2x\``,
      ``,
      `*With a 5X target alert:*`,
      `\`buy SOL 92.50 5x\``,
      ``,
      `*With quantity + target:*`,
      `\`buy SOL 92.50 10 5x\``,
      ``,
      `_Type your buy command now ↓_`,
    ].join('\n'), true);
    return;
  }

  // ── SELL GUIDE (from button) ──────────────────────────────────────────────
  if (cmd === 'sell_guide') {
    await reply(chatId, [
      `💸 *How to Remove a Position*`,
      ``,
      `After you sell on the exchange, tell the bot:`,
      ``,
      `\`sell SOL\``,
      `\`sell BTC\``,
      `\`sell ETH\``,
      ``,
      `_This removes it from monitoring._`,
      ``,
      `To see all positions first:`,
      `\`positions\``,
    ].join('\n'), true);
    return;
  }

  // ── Unknown ───────────────────────────────────────────────────────────────
  await reply(chatId, `❓ Unknown command.\n\nUse the menu buttons below or type \`help\`.`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const body = req.body || {};

    // ── Handle button taps (callback_query) ──────────────────────────────────
    if (body.callback_query) {
      const cq     = body.callback_query;
      const chatId = cq.message?.chat?.id?.toString();
      const data   = cq.data;

      if (CHAT_ID && chatId !== CHAT_ID.toString()) {
        return res.status(200).json({ ok: true });
      }

      // Acknowledge the button tap first
      res.status(200).json({ ok: true });
      await answerCallback(cq.id);

      // Map button data to command text
      const commandMap = {
        scan:        'scan',
        moonshots:   'moonshots',
        newlistings: 'newlistings',
        positions:   'positions',
        help:        'help',
        buy_help:    'buy_guide',
        sell_help:   'sell_guide',
      };

      const cmd = commandMap[data] || data;
      await handleMessage(chatId, cmd);
      return;
    }

    // ── Handle regular text messages ─────────────────────────────────────────
    const { message } = body;
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