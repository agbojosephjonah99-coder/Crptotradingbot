/**
 * ─── Telegram Webhook Handler (Multi-User + Admin Approval) ──────────────────
 * POST /api/telegram-webhook
 *
 * FLOW:
 *  New user → /start → pending request sent to admin
 *  Admin → taps Approve → user gets welcome + full access
 *  Admin → taps Reject  → user gets rejection message
 *
 * ADMIN ONLY COMMANDS:
 *  users    → list all approved users
 *  pending  → list pending requests
 *  block ID → block a user
 *  remove ID → remove a user
 */

const axios = require('axios');
const {
  getUser, isApproved, isBlocked,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, formatName,
} = require('../src/services/userService');
const {
  getAllPositions, getPosition, addPosition,
  removePosition, updateLastChecked,
} = require('../src/services/positionStore');

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID    = process.env.TELEGRAM_CHAT_ID;

// ─── Persistent MENU button ───────────────────────────────────────────────────
const PERSISTENT_MENU = {
  keyboard:    [[{ text: '📋 MENU' }]],
  resize_keyboard:          true,
  persistent:               true,
  input_field_placeholder:  'Tap MENU or type a command...',
};

// ─── Inline command buttons ───────────────────────────────────────────────────
const INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '🔍 Scan Now',     callback_data: 'scan'        },
      { text: '🌕 Moonshots',    callback_data: 'moonshots'   },
    ],
    [
      { text: '🚀 New Listings', callback_data: 'newlistings' },
      { text: '📊 My Positions', callback_data: 'positions'   },
    ],
    [
      { text: '💰 Buy a Coin',   callback_data: 'buy_help'    },
      { text: '💸 Sell a Coin',  callback_data: 'sell_help'   },
    ],
    [
      { text: '📖 Help',         callback_data: 'help'        },
    ],
  ],
};

// ─── Send message ─────────────────────────────────────────────────────────────
async function send(chatId, text, markup) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:      chatId,
        text,
        parse_mode:   'Markdown',
        disable_web_page_preview: true,
        reply_markup: markup || PERSISTENT_MENU,
      },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[Webhook] Send failed:', e.message);
  }
}

async function reply(chatId, text, showInline = false) {
  await send(chatId, text, showInline ? INLINE_MENU : PERSISTENT_MENU);
}

async function replyChunked(chatId, text, showInline = false) {
  const MAX = 4000;
  if (text.length <= MAX) { await reply(chatId, text, showInline); return; }
  const chunks = [];
  let current  = '';
  for (const line of text.split('\n')) {
    if ((current + line).length > MAX) { chunks.push(current); current = ''; }
    current += line + '\n';
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length; i++) {
    await reply(chatId, chunks[i], i === chunks.length - 1 ? showInline : false);
  }
}

async function answerCallback(id) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      { callback_query_id: id },
      { timeout: 5000 }
    );
  } catch {}
}

function normaliseSymbol(raw) {
  const u = raw.toUpperCase().trim();
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

function isAdmin(chatId) {
  return chatId?.toString() === ADMIN_ID?.toString();
}

// ─── Notify admin of new access request ───────────────────────────────────────
async function notifyAdminNewRequest(user) {
  if (!ADMIN_ID) return;
  const name = formatName(user);
  await send(ADMIN_ID, [
    `🔔 *New Access Request*`,
    ``,
    `👤 *Name:* ${name}`,
    `🆔 *Chat ID:* \`${user.chatId}\``,
    `⏰ ${new Date().toUTCString()}`,
    ``,
    `Tap a button to approve or reject:`,
  ].join('\n'), {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${user.chatId}` },
      { text: '❌ Reject',  callback_data: `reject:${user.chatId}`  },
    ]],
  });
}

// ─── Handle admin approval callbacks ─────────────────────────────────────────
async function handleApproval(action, targetId, adminChatId) {
  if (!isAdmin(adminChatId)) return;

  if (action === 'approve') {
    const ok = await approveUser(targetId);
    if (ok) {
      // Notify admin
      const user = await getUser(targetId);
      await reply(adminChatId, `✅ *${formatName(user)}* has been approved.`);
      // Welcome the new user
      await send(targetId, [
        `🎉 *Your access has been approved!*`,
        ``,
        `Welcome to CryptoBot V2. You now have full access.`,
        ``,
        `Tap the *📋 MENU* button below to get started.`,
      ].join('\n'), PERSISTENT_MENU);
    }
  }

  if (action === 'reject') {
    const user = await getUser(targetId);
    await blockUser(targetId);
    await reply(adminChatId, `❌ *${formatName(user)}* has been rejected.`);
    await send(targetId, [
      `❌ *Access Denied*`,
      ``,
      `Your request to use CryptoBot V2 was not approved.`,
    ].join('\n'), { remove_keyboard: true });
  }
}

// ─── Main command handler ─────────────────────────────────────────────────────
async function handleMessage(chatId, text, from) {
  const cleanText = text.trim().startsWith('/') ? text.trim().slice(1) : text.trim();
  const parts     = cleanText.split(/\s+/);
  const cmd       = parts[0]?.toLowerCase();

  // ── START / New user flow ────────────────────────────────────────────────
  if (cmd === 'start') {
    // Deep link parameter — e.g. /start welcome or /start ref_john
    const param = parts[1] || '';

    if (isAdmin(chatId)) {
      await send(chatId, [
        `👑 *Welcome back, Admin!*`,
        ``,
        `Tap *📋 MENU* to access all commands.`,
        ``,
        `*Admin commands:*`,
        `\`pending\` — view pending requests`,
        `\`users\`   — view approved users`,
        `\`block ID\`  — block a user`,
        `\`remove ID\` — remove a user`,
      ].join('\n'), PERSISTENT_MENU);
      return;
    }

    const blocked = await isBlocked(chatId);
    if (blocked) {
      await send(chatId, `❌ You do not have access to this bot.`, { remove_keyboard: true });
      return;
    }

    const approved = await isApproved(chatId);
    if (approved) {
      await send(chatId, [
        `👋 *Welcome back!*`,
        ``,
        `Tap *📋 MENU* to get started.`,
      ].join('\n'), PERSISTENT_MENU);
      return;
    }

    // New user — show welcome message then request access
    const user = await registerUser({
      chatId,
      firstName: from?.first_name || '',
      lastName:  from?.last_name  || '',
      username:  from?.username   || '',
      param,    // store how they found the bot
    });

    await send(chatId, [
      `🤖 *Welcome to CryptoBot V2!*`,
      ``,
      `📊 *What this bot does:*`,
      `  • Scans the market for high-probability pump coins`,
      `  • Finds newly listed coins with contract addresses`,
      `  • Alerts you exactly when to buy and sell`,
      `  • Monitors your positions 24/7`,
      `  • Sends instant alerts when your 2X or 5X target is hit`,
      ``,
      `🔒 *This is a private bot.*`,
      `Your access request has been sent to the admin.`,
      `You will be notified here as soon as you are approved.`,
      ``,
      `⏳ *Please wait for approval...*`,
    ].join('\n'), { remove_keyboard: true });

    await notifyAdminNewRequest(user);
    return;
  }

  // ── Check access for all other commands ──────────────────────────────────
  if (!isAdmin(chatId)) {
    const blocked  = await isBlocked(chatId);
    const approved = await isApproved(chatId);

    if (blocked) {
      await send(chatId, `❌ You do not have access to this bot.`);
      return;
    }

    if (!approved) {
      const existing = await getUser(chatId);
      if (!existing) {
        // Unregistered — prompt to start
        await send(chatId, `👋 Please type /start to request access.`);
      } else {
        await send(chatId, `⏳ Your request is pending admin approval. Please wait.`);
      }
      return;
    }
  }

  // ── ADMIN ONLY COMMANDS ──────────────────────────────────────────────────
  if (isAdmin(chatId)) {

    if (cmd === 'pending') {
      const pending = await getUsersByStatus('pending');
      if (pending.length === 0) {
        await reply(chatId, `📭 No pending requests.`);
        return;
      }
      const lines = [`⏳ *Pending Requests (${pending.length})*`, ``];
      pending.forEach(u => {
        lines.push(`👤 *${formatName(u)}*`);
        lines.push(`   ID: \`${u.chatId}\``);
        lines.push(`   Requested: ${new Date(u.requestedAt).toUTCString()}`);
        lines.push(``);
      });
      lines.push(`To approve: \`approve CHATID\``);
      lines.push(`To reject:  \`block CHATID\``);
      await reply(chatId, lines.join('\n'));
      return;
    }

    if (cmd === 'users') {
      const approved = await getUsersByStatus('approved');
      if (approved.length === 0) {
        await reply(chatId, `📭 No approved users yet.`);
        return;
      }
      const lines = [`✅ *Approved Users (${approved.length})*`, ``];
      approved.forEach(u => {
        lines.push(`👤 *${formatName(u)}*`);
        lines.push(`   ID: \`${u.chatId}\``);
        lines.push(`   Since: ${new Date(u.approvedAt || u.requestedAt).toUTCString()}`);
        lines.push(``);
      });
      await reply(chatId, lines.join('\n'));
      return;
    }

    if (cmd === 'approve' && parts[1]) {
      const ok   = await approveUser(parts[1]);
      const user = await getUser(parts[1]);
      if (ok && user) {
        await reply(chatId, `✅ *${formatName(user)}* approved.`);
        await send(parts[1], [
          `🎉 *Your access has been approved!*`,
          ``,
          `Welcome to CryptoBot V2. Tap *📋 MENU* to get started.`,
        ].join('\n'), PERSISTENT_MENU);
      } else {
        await reply(chatId, `⚠️ User \`${parts[1]}\` not found.`);
      }
      return;
    }

    if (cmd === 'block' && parts[1]) {
      const user = await getUser(parts[1]);
      await blockUser(parts[1]);
      await reply(chatId, `🚫 User \`${parts[1]}\` blocked.`);
      if (user) await send(parts[1], `❌ Your access to CryptoBot V2 has been revoked.`, { remove_keyboard: true });
      return;
    }

    if (cmd === 'remove' && parts[1]) {
      const ok = await removeUser(parts[1]);
      await reply(chatId, ok ? `🗑 User \`${parts[1]}\` removed.` : `⚠️ User not found.`);
      return;
    }
  }

  // ── MENU ─────────────────────────────────────────────────────────────────
  if (cmd === 'menu' || text.trim() === '📋 MENU') {
    await send(chatId, `*What would you like to do?*\n\nTap a button below:`, INLINE_MENU);
    return;
  }

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    await reply(chatId, [
      `🤖 *CryptoBot V2 — Commands*`,
      ``,
      `━━━ *SCAN & SIGNALS* ━━━`,
      `\`scan\` — find high-probability pump coins now`,
      `\`moonshots\` — coins likely to 2X-5X in 3 days`,
      `\`newlistings\` — new coins with contract addresses`,
      ``,
      `━━━ *YOUR TRADES* ━━━`,
      `\`buy SOL 92.50\` — track a buy`,
      `\`buy SOL 92.50 2x\` — alert at 2X`,
      `\`buy SOL 92.50 5x\` — alert at 5X`,
      `\`sell SOL\` — remove after you exit`,
      `\`positions\` — view all open trades`,
      `\`check SOL\` — instant advice`,
      ``,
      `━━━ *AUTO ALERTS* ━━━`,
      `🔴 Stop Loss | 🟢 TP1/TP2/TP3`,
      `🎯 2X/5X Target | ⚪ Hold`,
    ].join('\n'));
    return;
  }

  // ── SCAN ─────────────────────────────────────────────────────────────────
  if (cmd === 'scan' || cmd === 'search' || cmd === 'find') {
    await reply(chatId, `🔍 Scanning market for high-probability coins... 30 seconds.`);
    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const moonshots = await getMoonshots();

      if (moonshots.length === 0) {
        await reply(chatId, `😴 No high-confidence picks right now. Try again in 30-60 minutes.`);
        return;
      }

      await reply(chatId, `✅ *Found ${moonshots.length} pick${moonshots.length > 1 ? 's' : ''}*`);

      for (const coin of moonshots) {
        const meta     = coin.meta;
        const priceStr = coin.price < 0.001 ? coin.price.toFixed(8)
          : coin.price < 0.01 ? coin.price.toFixed(6) : coin.price.toFixed(4);
        const cgPrice  = meta?.currentPrice
          ? (meta.currentPrice < 0.001 ? meta.currentPrice.toFixed(8) : meta.currentPrice.toFixed(4))
          : priceStr;

        const t2x = (parseFloat(cgPrice) * 2).toFixed(6);
        const t3x = (parseFloat(cgPrice) * 3).toFixed(6);
        const t5x = (parseFloat(cgPrice) * 5).toFixed(6);

        const bandEmoji = { 'VERY HIGH':'🟢','HIGH':'🟡','MODERATE':'🟠','LOW':'🔴' }[coin.band] || '⚪';

        const lines = [
          `🌕 *${meta?.name || coin.base} (${coin.base})*`,
          ``,
          `${bandEmoji} *Probability: ${coin.probability}% — ${coin.band}*`,
          ``,
          `💰 *Price:*     \`$${cgPrice}\``,
          `📈 *24H:*       +${coin.change24h.toFixed(2)}%`,
          `💵 *Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
          meta?.marketCap ? `🏦 *Market Cap:* $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
          coin.isTrending ? `🔥 *Trending on CoinGecko*` : '',
          ``,
          `🎯 *Targets:*`,
          `  2X → \`$${t2x}\``,
          `  3X → \`$${t3x}\``,
          `  5X → \`$${t5x}\``,
          ``,
          `📊 *Factor Scores:*`,
          `  Volume:    ${coin.factors?.volumeQuality?.score || 0}/${coin.factors?.volumeQuality?.max || 20}`,
          `  Structure: ${coin.factors?.priceStructure?.score || 0}/${coin.factors?.priceStructure?.max || 20}`,
          `  Liquidity: ${coin.factors?.liquidity?.score || 0}/${coin.factors?.liquidity?.max || 15}`,
          `  Momentum:  ${coin.factors?.momentum?.score || 0}/${coin.factors?.momentum?.max || 15}`,
          ``,
          (coin.greenSignals || []).length > 0 ? `✅ *Signals:*` : '',
          ...(coin.greenSignals || []).slice(0, 3).map(g => `  • ${g}`),
          (coin.redFlags || []).length > 0 ? `\n⚠️ *Warnings:*` : '',
          ...(coin.redFlags || []).slice(0, 3).map(f => `  • ${f}`),
          ``,
        ];

        if (meta?.contracts?.length > 0) {
          lines.push(`📋 *Contract Addresses:*`);
          meta.contracts.slice(0, 3).forEach(ct => {
            lines.push(`  *${ct.chainLabel}:*`);
            lines.push(`  \`${ct.address}\``);
          });
          lines.push(`⚠️ _Verify on CoinGecko before buying_`);
        } else {
          lines.push(`⚠️ _Verify contract on CoinGecko_`);
        }

        if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
        lines.push(``);
        lines.push(`💼 *Position size:* ${coin.positionAdvice}`);
        lines.push(`📝 \`buy ${coin.base} ${cgPrice} 2x\``);
        lines.push(`📝 \`buy ${coin.base} ${cgPrice} 5x\``);

        await replyChunked(chatId, lines.filter(Boolean).join('\n'));
      }
    } catch (err) {
      await reply(chatId, `❌ Scan failed: ${err.message}`);
    }
    return;
  }

  // ── MOONSHOTS ─────────────────────────────────────────────────────────────
  if (cmd === 'moonshots' || cmd === 'moon' || cmd === '5x') {
    await handleMessage(chatId, 'scan', from);
    return;
  }

  // ── NEW LISTINGS ──────────────────────────────────────────────────────────
  if (cmd === 'newlistings' || cmd === 'listings' || cmd === 'new') {
    await reply(chatId, `🔍 Scanning new listings... 20 seconds.`);
    try {
      const { getNewListingsWithMetadata } = require('../src/services/listingsService');
      const { hotCoins, trending }         = await getNewListingsWithMetadata();

      if (hotCoins.length === 0 && trending.length === 0) {
        await reply(chatId, `😴 No strong new listings right now. Check back soon.`);
        return;
      }

      if (hotCoins.length > 0) {
        await reply(chatId, `🔥 *Top New Listings*`);
        for (const coin of hotCoins.slice(0, 5)) {
          const meta     = coin.meta;
          const priceStr = coin.price < 0.01 ? coin.price.toFixed(8) : coin.price.toFixed(4);
          const lines    = [
            `🚀 *${meta?.name || coin.base} (${coin.base})*`,
            `💰 Price: \`$${priceStr}\``,
            `📈 24H: +${coin.change24h.toFixed(2)}%`,
            `💵 Volume: $${(coin.volume / 1e6).toFixed(2)}M`,
            meta?.description ? `📄 _${meta.description.slice(0, 100)}_` : '',
            ``,
          ];
          if (meta?.contracts?.length > 0) {
            lines.push(`📋 *Contracts:*`);
            meta.contracts.slice(0, 2).forEach(ct => {
              lines.push(`  *${ct.chainLabel}:* \`${ct.address}\``);
            });
          }
          if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
          lines.push(`📝 \`buy ${coin.base} ${priceStr}\``);
          await replyChunked(chatId, lines.filter(Boolean).join('\n'));
        }
      }

      if (trending.length > 0) {
        await reply(chatId, `🌊 *CoinGecko Trending*`);
        for (const c of trending.slice(0, 3)) {
          const p = c.currentPrice ? (c.currentPrice < 0.01 ? c.currentPrice.toFixed(8) : c.currentPrice.toFixed(4)) : 'N/A';
          const lines = [
            `🌊 *${c.name} (${c.symbol})*`,
            `💰 Price: \`$${p}\``,
            `📈 24H: ${c.priceChange24h ? (c.priceChange24h >= 0 ? '+' : '') + c.priceChange24h.toFixed(2) + '%' : 'N/A'}`,
            `💵 Volume: ${c.volume24h ? '$' + (c.volume24h / 1e6).toFixed(2) + 'M' : 'N/A'}`,
            ``,
          ];
          if (c.contracts?.length > 0) {
            lines.push(`📋 *Contracts:*`);
            c.contracts.slice(0, 2).forEach(ct => {
              lines.push(`  *${ct.chainLabel}:* \`${ct.address}\``);
            });
          }
          if (c.cgUrl) lines.push(`🔗 ${c.cgUrl}`);
          if (c.currentPrice) lines.push(`📝 \`buy ${c.symbol} ${p}\``);
          await replyChunked(chatId, lines.filter(Boolean).join('\n'));
        }
      }
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  if (cmd === 'buy') {
    const rawSymbol = parts[1];
    const buyPrice  = parseFloat(parts[2]);
    let quantity = null, targetMultiple = null;
    if (parts[3]) {
      const p3 = parts[3].toString().toLowerCase();
      if (p3.endsWith('x')) targetMultiple = parseFloat(p3);
      else quantity = parseFloat(p3);
    }
    if (parts[4]) {
      const p4 = parts[4].toString().toLowerCase();
      if (p4.endsWith('x')) targetMultiple = parseFloat(p4);
    }

    if (!rawSymbol || isNaN(buyPrice) || buyPrice <= 0) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`buy SOL 92.50\``,
        `\`buy SOL 92.50 2x\` ← alert at 2X`,
        `\`buy SOL 92.50 5x\` ← alert at 5X`,
        `\`buy SOL 92.50 10 5x\` ← 10 units + 5X`,
      ].join('\n'));
      return;
    }

    const symbol      = normaliseSymbol(rawSymbol);
    const targetPrice = targetMultiple ? buyPrice * targetMultiple : null;
    await addPosition({ chatId, symbol, buyPrice, quantity, targetMultiple });

    await reply(chatId, [
      `✅ *Position Registered — ${symbol}*`,
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      quantity      ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      targetMultiple ? `🎯 *Target:*    ${targetMultiple}X = \`$${targetPrice.toFixed(6)}\`` : '',
      ``,
      `You will be alerted when:`,
      targetMultiple ? `  🎯 Price hits $${targetPrice.toFixed(6)} (${targetMultiple}X) → SELL NOW` : '',
      `  🔴 Stop loss hit → exit immediately`,
      `  🟢 TP1 / TP2 / TP3 hit → take partial profit`,
      `  ⚪ Hold update every 4 hours`,
      ``,
      `\`check ${symbol}\` for instant advice anytime`,
    ].filter(Boolean).join('\n'));
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  if (cmd === 'sell' || cmd === 'remove' || cmd === 'sold') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`sell SOL\``); return; }
    const symbol  = normaliseSymbol(rawSymbol);
    const removed = await removePosition(chatId, symbol);
    await reply(chatId, removed
      ? `✅ *${symbol}* removed. Good trade! 💸`
      : `⚠️ *${symbol}* not in your positions.`
    );
    return;
  }

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  if (cmd === 'positions' || cmd === 'pos') {
    const all     = await getAllPositions(chatId);
    const entries = Object.values(all);
    if (entries.length === 0) {
      await reply(chatId, `📭 *No open positions*\n\nAdd one: \`buy SOL 92.50\``);
      return;
    }
    const lines = [`📊 *Your Open Positions*`, ``];
    for (const pos of entries) {
      lines.push(`*${pos.symbol}*`);
      lines.push(`  Entry: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      if (pos.targetMultiple) lines.push(`  Target: ${pos.targetMultiple}X = \`$${pos.targetPrice?.toFixed(6)}\``);
      lines.push(`  Status: ${pos.lastRecommendation || 'Pending first check'}`);
      lines.push(``);
    }
    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── CHECK ─────────────────────────────────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`check SOL\``); return; }
    const symbol = normaliseSymbol(rawSymbol);
    const pos    = await getPosition(chatId, symbol);
    if (!pos) {
      await reply(chatId, `⚠️ *${symbol}* not in positions.\n\nAdd it: \`buy ${symbol} YOUR_PRICE\``);
      return;
    }
    await reply(chatId, `🔍 Checking *${symbol}*...`);
    try {
      const adv = require('./v2advice');
      const { candles1h, candles4h, currentPrice } = await adv.fetchCurrentData(symbol);
      const advice = adv.buildAdvice({ symbol, buyPrice: pos.buyPrice, currentPrice, candles1h, candles4h });
      const tp1 = advice.tradePlan?.takeProfits?.tp1;
      const tp2 = advice.tradePlan?.takeProfits?.tp2;
      const tp3 = advice.tradePlan?.takeProfits?.tp3;
      const sl  = advice.tradePlan?.stopLoss;
      const emoji = { STOP_LOSS:'🔴',TAKE_PROFIT:'🟢',TRAIL_STOP:'🟡',CLOSE_PARTIAL:'🟠',HOLD:'⚪' }[advice.recommendation] || '⚪';
      const lines = [
        `${emoji} *${advice.recommendation} — ${symbol}*`,
        ``,
        `💰 *Bought:* \`$${pos.buyPrice}\``,
        `📊 *Now:*    \`$${Number(advice.currentPrice).toFixed(4)}\``,
        `📈 *P&L:*    ${advice.pnlDisplay}`,
        pos.targetMultiple ? `🎯 *${pos.targetMultiple}X target:* \`$${pos.targetPrice?.toFixed(6)}\`` : '',
        ``,
        ...(advice.reasons || []).map(r => `  ${r}`),
        ``,
        ...(advice.actions || []).map(a => `  👉 ${a}`),
        ``,
        sl  ? `🛡 Stop Loss: \`$${Number(sl).toFixed(4)}\`` : '',
        tp1 ? `🎯 TP1 (40%): \`$${Number(tp1.price).toFixed(4)}\`` : '',
        tp2 ? `🎯 TP2 (35%): \`$${Number(tp2.price).toFixed(4)}\`` : '',
        tp3 ? `🎯 TP3 (25%): \`$${Number(tp3.price).toFixed(4)}\`` : '',
      ].filter(Boolean).join('\n');
      await reply(chatId, lines);
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── BUY / SELL GUIDE ──────────────────────────────────────────────────────
  if (cmd === 'buy_guide') {
    await reply(chatId, [
      `💰 *How to Register a Buy*`,
      ``,
      `\`buy SOL 92.50\`       — track only`,
      `\`buy BTC 80000 2x\`    — alert at 2X`,
      `\`buy ETH 2300 5x\`     — alert at 5X`,
      `\`buy SOL 92.50 10 2x\` — 10 units + 2X`,
    ].join('\n'));
    return;
  }

  if (cmd === 'sell_guide') {
    await reply(chatId, [
      `💸 *How to Remove a Position*`,
      ``,
      `\`sell SOL\``,
      `\`sell BTC\``,
      `\`sell ETH\``,
      ``,
      `Type \`positions\` to see all open trades first.`,
    ].join('\n'));
    return;
  }

  // ── Unknown ───────────────────────────────────────────────────────────────
  await reply(chatId, `❓ Unknown command. Tap *📋 MENU* or type \`help\`.`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const body = req.body || {};

    // ── Button taps ───────────────────────────────────────────────────────
    if (body.callback_query) {
      const cq     = body.callback_query;
      const chatId = cq.message?.chat?.id?.toString();
      const data   = cq.data;

      await answerCallback(cq.id);

      // Admin approval buttons
      if (data.startsWith('approve:') || data.startsWith('reject:')) {
        const [action, targetId] = data.split(':');
        await handleApproval(action, targetId, chatId);
        return res.status(200).json({ ok: true });
      }

      // Menu buttons
      const commandMap = {
        scan:        'scan',
        moonshots:   'moonshots',
        newlistings: 'newlistings',
        positions:   'positions',
        help:        'help',
        buy_help:    'buy_guide',
        sell_help:   'sell_guide',
      };

      const mappedCmd = commandMap[data] || data;
      await handleMessage(chatId, mappedCmd, cq.from);
      return res.status(200).json({ ok: true });
    }

    // ── Regular messages ──────────────────────────────────────────────────
    const { message } = body;
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = message.chat?.id?.toString();
    const text   = message.text;
    const from   = message.from;

    console.log(`[Webhook] From ${chatId}: ${text}`);

    await handleMessage(chatId, text, from);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(200).json({ ok: true });
  }
};