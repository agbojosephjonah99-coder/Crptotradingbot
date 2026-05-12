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
  getAllPositions, getPositionsBySymbol, addPosition,
  removePositionById, removeAllBySymbol, updateLastChecked,
} = require('../src/services/positionStore');
const { recordTrade, getMonthlyStats } = require('../src/services/profitTracker');
const { adviseSplit, compoundingAdvice, targetProgress } = require('../src/services/portfolioAdvisor');

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
      { text: '🔍 Scan Now',       callback_data: 'scan'        },
      { text: '🌕 Moonshots',      callback_data: 'moonshots'   },
    ],
    [
      { text: '🚀 New Listings',   callback_data: 'newlistings' },
      { text: '📊 My Positions',   callback_data: 'positions'   },
    ],
    [
      { text: '💰 Buy a Coin',     callback_data: 'buy_help'    },
      { text: '💸 Record a Sale',  callback_data: 'sold_help'   },
    ],
    [
      { text: '💼 Split Capital',  callback_data: 'split_help'  },
      { text: '📈 My Profits',     callback_data: 'profit'      },
    ],
    [
      { text: '📖 Help',           callback_data: 'help'        },
      { text: '📚 User Manual',    callback_data: 'manual'      },
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
        `\`pending\`   — view pending requests`,
        `\`users\`     — view approved users`,
        `\`block ID\`  — block a user`,
        `\`remove ID\` — remove a user`,
        `\`invite\`    — get your invite link`,
      ].join('\n'), {
        keyboard: [
          [{ text: '📋 MENU' }, { text: '🔗 Invite Link' }],
          [{ text: '⏳ Pending' }, { text: '👥 Users' }],
        ],
        resize_keyboard: true,
        persistent: true,
        input_field_placeholder: 'Tap a button or type a command...',
      });
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

  // ── ADMIN KEYBOARD BUTTON SHORTCUTS ─────────────────────────────────────
  if (text.trim() === '🔗 Invite Link') {
    await handleMessage(chatId, 'invite', from);
    return;
  }
  if (text.trim() === '⏳ Pending') {
    await handleMessage(chatId, 'pending', from);
    return;
  }
  if (text.trim() === '👥 Users') {
    await handleMessage(chatId, 'users', from);
    return;
  }

  // ── ADMIN ONLY COMMANDS ──────────────────────────────────────────────────
  if (isAdmin(chatId)) {

    if (cmd === 'invite') {
      const BOT_USERNAME = process.env.BOT_USERNAME || 'JijazyBot';
      await reply(chatId, [
        `🔗 *Your Bot Invite Links*`,
        ``,
        `*General invite:*`,
        `https://t.me/${BOT_USERNAME}?start=welcome`,
        ``,
        `*For WhatsApp:*`,
        `https://t.me/${BOT_USERNAME}?start=whatsapp`,
        ``,
        `*For Twitter/X:*`,
        `https://t.me/${BOT_USERNAME}?start=twitter`,
        ``,
        `_Share any of these links. When someone clicks it,_`,
        `_they see the welcome message and you get an_`,
        `_Approve/Reject notification instantly._`,
        ``,
        `💡 Add \`BOT_USERNAME\` to your Vercel env vars`,
        `with your bot's username (without the @)`,
      ].join('\n'));
      return;
    }

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
      `\`buy SOL 92.50 10%\` — alert at 10% profit`,
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
    let quantity = null, targetMultiple = null, targetPct = null;

    // Helper: parse a target token — supports "2x", "10%", "10.5%"
    function parseTarget(token) {
      const t = token.toString().toLowerCase().trim();
      if (t.endsWith('%')) {
        const pct = parseFloat(t);
        if (!isNaN(pct) && pct > 0) {
          targetPct = pct;
          targetMultiple = 1 + pct / 100;
        }
      } else if (t.endsWith('x')) {
        const mult = parseFloat(t);
        if (!isNaN(mult) && mult > 0) targetMultiple = mult;
      }
    }

    if (parts[3]) {
      const p3 = parts[3].toString().toLowerCase();
      if (p3.endsWith('x') || p3.endsWith('%')) parseTarget(p3);
      else quantity = parseFloat(p3);
    }
    if (parts[4]) parseTarget(parts[4]);

    if (!rawSymbol || isNaN(buyPrice) || buyPrice <= 0) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`buy SOL 92.50\``,
        `\`buy SOL 92.50 10%\`  ← alert at 10% profit`,
        `\`buy SOL 92.50 2x\`   ← alert at 2X`,
        `\`buy SOL 92.50 5x\`   ← alert at 5X`,
        `\`buy SOL 92.50 10 10%\` ← 10 units + 10% target`,
        `\`buy SOL 92.50 10 5x\` ← 10 units + 5X target`,
      ].join('\n'));
      return;
    }

    const symbol      = normaliseSymbol(rawSymbol);
    const targetPrice = targetMultiple ? buyPrice * targetMultiple : null;
    await addPosition({ chatId, symbol, buyPrice, quantity, targetMultiple });

    // Check how many entries already exist for this coin
    const existing = await getPositionsBySymbol(chatId, symbol);
    const entryNum = existing.length + 1;

    // Build a human-friendly target label e.g. "10% profit" or "2X"
    const targetLabel = targetPct != null
      ? `${targetPct}% profit`
      : targetMultiple ? `${targetMultiple}X` : null;

    await reply(chatId, [
      `✅ *Buy #${entryNum} Registered — ${symbol}*`,
      existing.length > 0 ? `📌 _You now have ${entryNum} separate entries for ${symbol}_` : '',
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      quantity    ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      targetLabel ? `🎯 *Target:*   ${targetLabel} = \`$${targetPrice.toFixed(6)}\`` : '',
      ``,
      `You will be alerted when:`,
      targetLabel ? `  🎯 Price hits \`$${targetPrice.toFixed(6)}\` (${targetLabel}) → SELL NOW` : '',
      `  🔴 Stop loss hit → exit immediately`,
      `  🟢 TP1 / TP2 / TP3 hit → take partial profit`,
      `  ⚪ Hold update every 4 hours`,
      ``,
      `Each entry is monitored independently.`,
      `\`positions\` to see all your entries`,
    ].filter(Boolean).join('\n'));
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  if (cmd === 'sell' || cmd === 'remove' || cmd === 'sold') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`sell SOL\``); return; }
    const symbol   = normaliseSymbol(rawSymbol);
    const entries  = await getPositionsBySymbol(chatId, symbol);

    if (entries.length === 0) {
      await reply(chatId, `⚠️ *${symbol}* not in your positions.`);
      return;
    }

    // Only one entry — remove it directly
    if (entries.length === 1) {
      await removePositionById(chatId, entries[0].positionId);
      await reply(chatId, `✅ *${symbol}* removed. Good trade! 💸`);
      return;
    }

    // Multiple entries — show them and ask which to remove
    const lines = [
      `📌 *You have ${entries.length} entries for ${symbol}*`,
      ``,
      `Which one did you sell?`,
      ``,
    ];
    entries.forEach((pos, i) => {
      lines.push(`*Entry ${i + 1}:*`);
      lines.push(`  Price: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      if (pos.targetMultiple) lines.push(`  Target: ${pos.targetMultiple}X`);
      lines.push(`  Added: ${new Date(pos.addedAt).toUTCString()}`);
      lines.push(`  To remove: \`sellentry ${pos.positionId}\``);
      lines.push(``);
    });
    lines.push(`To remove ALL ${symbol} entries: \`sellall ${symbol}\``);
    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── SELLENTRY (remove specific entry by ID) ───────────────────────────────
  if (cmd === 'sellentry' && parts[1]) {
    const positionId = parts[1];
    const removed    = await removePositionById(chatId, positionId);
    await reply(chatId, removed
      ? `✅ Entry removed. Good trade! 💸`
      : `⚠️ Entry not found. Type \`positions\` to see your entries.`
    );
    return;
  }

  // ── SELLALL (remove all entries for a coin) ───────────────────────────────
  if (cmd === 'sellall' && parts[1]) {
    const symbol  = normaliseSymbol(parts[1]);
    const removed = await removeAllBySymbol(chatId, symbol);
    await reply(chatId, removed > 0
      ? `✅ All ${removed} ${symbol} entries removed. Great trading! 💸`
      : `⚠️ No ${symbol} positions found.`
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

    // Group by symbol
    const grouped = {};
    for (const pos of entries) {
      if (!grouped[pos.symbol]) grouped[pos.symbol] = [];
      grouped[pos.symbol].push(pos);
    }

    const lines = [`📊 *Your Open Positions (${entries.length} total)*`, ``];

    for (const [symbol, coinEntries] of Object.entries(grouped)) {
      if (coinEntries.length === 1) {
        const pos = coinEntries[0];
        lines.push(`*${symbol}*`);
        lines.push(`  Entry: \`$${pos.buyPrice}\``);
        if (pos.quantity)       lines.push(`  Qty: ${pos.quantity}`);
        if (pos.targetMultiple) lines.push(`  Target: ${pos.targetMultiple}X = \`$${pos.targetPrice?.toFixed(6)}\``);
        lines.push(`  Status: ${pos.lastRecommendation || 'Pending first check'}`);
        lines.push(``);
      } else {
        // Multiple entries for same coin
        lines.push(`*${symbol}* — ${coinEntries.length} entries`);
        coinEntries.forEach((pos, i) => {
          lines.push(`  *Entry ${i + 1}:* \`$${pos.buyPrice}\`` +
            (pos.targetMultiple ? ` → ${pos.targetMultiple}X` : '') +
            (pos.quantity ? ` | Qty: ${pos.quantity}` : ''));
          lines.push(`    Status: ${pos.lastRecommendation || 'Pending'}`);
        });
        lines.push(``);
      }
    }

    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── CHECK ─────────────────────────────────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`check SOL\``); return; }
    const symbol  = normaliseSymbol(rawSymbol);
    const entries = await getPositionsBySymbol(chatId, symbol);

    if (entries.length === 0) {
      await reply(chatId, `⚠️ *${symbol}* not in positions.\n\nAdd it: \`buy ${symbol} YOUR_PRICE\``);
      return;
    }

    await reply(chatId, `🔍 Checking *${symbol}* (${entries.length} entr${entries.length > 1 ? 'ies' : 'y'})...`);

    try {
      const adv = require('./v2advice');
      const { candles1h, candles4h, currentPrice } = await adv.fetchCurrentData(symbol);

      for (let i = 0; i < entries.length; i++) {
        const pos    = entries[i];
        const advice = adv.buildAdvice({ symbol, buyPrice: pos.buyPrice, currentPrice, candles1h, candles4h });
        const tp1    = advice.tradePlan?.takeProfits?.tp1;
        const tp2    = advice.tradePlan?.takeProfits?.tp2;
        const tp3    = advice.tradePlan?.takeProfits?.tp3;
        const sl     = advice.tradePlan?.stopLoss;
        const emoji  = { STOP_LOSS:'🔴',TAKE_PROFIT:'🟢',TRAIL_STOP:'🟡',CLOSE_PARTIAL:'🟠',HOLD:'⚪' }[advice.recommendation] || '⚪';

        const lines = [
          entries.length > 1 ? `*Entry ${i + 1} of ${entries.length}*` : '',
          `${emoji} *${advice.recommendation} — ${symbol}*`,
          ``,
          `💰 *Bought:* \`$${pos.buyPrice}\``,
          pos.quantity ? `📦 *Qty:* ${pos.quantity}` : '',
          `📊 *Now:*    \`$${Number(advice.currentPrice).toFixed(6)}\``,
          `📈 *P&L:*    ${advice.pnlDisplay}`,
          pos.targetMultiple ? `🎯 *${pos.targetMultiple}X:* \`$${pos.targetPrice?.toFixed(6)}\`` : '',
          ``,
          ...(advice.reasons || []).map(r => `  ${r}`),
          ``,
          ...(advice.actions || []).map(a => `  👉 ${a}`),
          ``,
          sl  ? `🛡 Stop: \`$${Number(sl).toFixed(6)}\`` : '',
          tp1 ? `🎯 TP1:  \`$${Number(tp1.price).toFixed(6)}\`` : '',
          tp2 ? `🎯 TP2:  \`$${Number(tp2.price).toFixed(6)}\`` : '',
          tp3 ? `🎯 TP3:  \`$${Number(tp3.price).toFixed(6)}\`` : '',
        ].filter(Boolean).join('\n');

        await reply(chatId, lines);
      }
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── MANUAL ───────────────────────────────────────────────────────────────
  if (cmd === 'manual' || cmd === 'guide') {
    // Send manual in chunks — it is long
    const sections = [

      // ── Section 1 ──
      [`📚 *CryptoBot V2 — User Manual*`,
      ``,
      `━━━ *WHAT IS CRYPTOBOT V2?* ━━━`,
      ``,
      `CryptoBot V2 is a private crypto intelligence bot that runs inside Telegram. It scans the market 24/7, finds high-probability trading setups, and sends you precise alerts telling you exactly when to buy, when to take profit, and when to cut losses.`,
      ``,
      `It connects to live market data, runs professional-grade technical analysis across multiple timeframes, and delivers the results straight to your Telegram. No charts. No guesswork.`,
      ].join('\n'),

      // ── Section 2 ──
      [`💎 *WHAT YOU STAND TO GAIN*`,
      ``,
      `✅ *Never miss a profitable entry*`,
      `The bot scans every 30 minutes. When a high-confidence setup appears you get an instant alert with entry price, stop loss and 3 take-profit targets.`,
      ``,
      `✅ *Know exactly when to sell*`,
      `The bot monitors your positions and alerts you at TP1, TP2, TP3 and your custom target (2X, 3X, 5X).`,
      ``,
      `✅ *Losses stay small*`,
      `Every trade comes with an ATR-based stop loss. If price hits it you get an immediate exit alert before the loss gets worse.`,
      ``,
      `✅ *Institutional-grade analysis*`,
      `ADX, Stochastic RSI, Bollinger Bands, OBV, VWAP, ATR — the same tools professional traders use.`,
      ``,
      `✅ *New coin opportunities*`,
      `Get newly listed coins with contract addresses, probability scores and trade plans delivered to you.`,
      ``,
      `✅ *You stay in control*`,
      `The bot never touches your money. It is read-only intelligence. You decide every trade.`,
      ].join('\n'),

      // ── Section 3 ──
      [`📋 *THE MENU — ALL COMMANDS*`,
      ``,
      `🔍 *Scan Now*`,
      `Scans the entire market immediately for high-probability pump coins. Returns probability score, factor breakdown, contract address and suggested buy commands.`,
      ``,
      `🌕 *Moonshots*`,
      `Same as Scan — finds coins with the best chance of 2X-5X within 3 days using 7-factor analysis.`,
      ``,
      `🚀 *New Listings*`,
      `Hot newly listed coins with their contract address on every blockchain, current price, 24H stats and a CoinGecko verification link.`,
      ``,
      `📊 *My Positions*`,
      `All your registered trades, entry prices, targets and current monitoring status.`,
      ``,
      `💰 *Buy a Coin*`,
      `Register a trade so the bot monitors it for you.`,
      ``,
      `💸 *Sell a Coin*`,
      `Remove a position after you exit on your exchange.`,
      ].join('\n'),

      // ── Section 4 ──
      [`💰 *HOW TO REGISTER A BUY*`,
      ``,
      `After buying on your exchange, tell the bot:`,
      ``,
      `Track only:`,
      `\`buy SOL 92.50\``,
      ``,
      `With percentage profit target:`,
      `\`buy SOL 92.50 10%\` ← alert at 10% profit`,
      `\`buy SOL 92.50 25%\` ← alert at 25% profit`,
      ``,
      `With multiplier target:`,
      `\`buy SOL 92.50 2x\` ← alert at 2X`,
      `\`buy SOL 92.50 5x\` ← alert at 5X`,
      ``,
      `With quantity + target:`,
      `\`buy SOL 92.50 10 10%\` ← 10 units + 10% target`,
      `\`buy SOL 92.50 10 5x\`  ← 10 units + 5X target`,
      ``,
      `Any coin works:`,
      `\`buy BTC 80000 2x\``,
      `\`buy ETH 2300 3x\``,
      `\`buy BILL 0.107893 2x\``,
      ``,
      `After TP1 hits → move stop to your entry price.`,
      `You now cannot lose money on that trade.`,
      ].join('\n'),

      // ── Section 5 ──
      [`🔔 *YOUR ALERTS EXPLAINED*`,
      ``,
      `⚪ *HOLD* — every 4 hours`,
      `Trade is progressing normally. Stay in. No action needed.`,
      ``,
      `🟢 *TP1 HIT* — first target`,
      `Sell 40% of position. Move stop to entry price.`,
      ``,
      `🟢🟢 *TP2 HIT* — second target`,
      `Sell 35% of remaining position.`,
      ``,
      `🟢🟢🟢 *TP3 HIT* — third target`,
      `Sell remaining 25%.`,
      ``,
      `🚨🎯 *2X/5X TARGET HIT*`,
      `SELL NOW. Open exchange immediately. Sell 60% at market. Move stop on remaining 40% to entry.`,
      ``,
      `🔴 *STOP LOSS HIT*`,
      `EXIT 100% IMMEDIATELY. No hesitation. Small loss now prevents catastrophic loss later.`,
      ].join('\n'),

      // ── Section 6 ──
      [`📊 *THE PROBABILITY SCORE*`,
      ``,
      `Every scan result shows a probability score built from 7 factors:`,
      ``,
      `  Volume Quality — real or fake trading?`,
      `  Price Structure — early move or already topped?`,
      `  Market Cap Risk — too small to be safe?`,
      `  Liquidity Health — can you exit safely?`,
      `  Momentum Trend — buying accelerating or fading?`,
      `  Social Signal — real interest on CoinGecko?`,
      `  Red Flag Detector — signs of manipulation?`,
      ``,
      `🟢 80%+ = VERY HIGH — all signals aligned`,
      `🟡 65-79% = HIGH — most signals positive`,
      `🟠 50-64% = MODERATE — size down`,
      `🔴 Below 50% = Skip`,
      ``,
      `⚠️ Even 80% does not guarantee profit. Markets can change due to news or whale activity. Always manage risk.`,
      ].join('\n'),

      // ── Section 7 ──
      [`🛡 *RISK MANAGEMENT RULES*`,
      ``,
      `These rules protect your account:`,
      ``,
      `1️⃣ Never risk more than 2% per trade`,
      `   $1,000 account = max $20 at risk per trade`,
      ``,
      `2️⃣ Always honour the stop loss`,
      `   If price hits stop → exit immediately`,
      ``,
      `3️⃣ Take partial profits`,
      `   Sell at TP1, TP2, TP3 — don't hold for all or nothing`,
      ``,
      `4️⃣ New listings = 1% max`,
      `   Higher risk coins get smaller positions`,
      ``,
      `5️⃣ Never average down`,
      `   If price drops to stop loss — exit, don't buy more`,
      ``,
      `6️⃣ Only trade money you can afford to lose`,
      `   Crypto is volatile. Never risk essential funds.`,
      ].join('\n'),

      // ── Section 8 ──
      [`❓ *COMMON QUESTIONS*`,
      ``,
      `*Does the bot buy/sell for me?*`,
      `No. It is read-only. You execute all trades on your exchange.`,
      ``,
      `*How often does it check my positions?*`,
      `Every 30 minutes.`,
      ``,
      `*What is a contract address?*`,
      `The unique identifier of a token on the blockchain. Always verify it on CoinGecko before buying a new coin to avoid fake tokens.`,
      ``,
      `*Can the bot guarantee profits?*`,
      `No tool can guarantee profits in crypto. The bot improves your odds with quality setups and systematic exits. Losses are normal — the goal is winning trades to outperform losing ones over time.`,
      ``,
      `*How do I check my positions?*`,
      `Tap 📊 My Positions or type \`positions\``,
      ``,
      `*How do I remove a position after selling?*`,
      `Type \`sell COIN\` e.g. \`sell SOL\``,
      ``,
      `_CryptoBot V2 — Built for serious traders_`,
      `_Nothing here is financial advice. Trade responsibly._`,
      ].join('\n'),

    ];

    for (const section of sections) {
      await reply(chatId, section, false);
    }

    await reply(chatId, `✅ *End of Manual*\n\nTap *📋 MENU* to start trading.`, true);
    return;
  }

  // ── PROFIT TRACKER ───────────────────────────────────────────────────────
  if (cmd === 'profit' || cmd === 'stats' || cmd === 'pnl') {
    const stats = await getMonthlyStats(chatId);

    if (!stats.allTime) {
      await reply(chatId, [
        `📊 *No closed trades yet*`,
        ``,
        `When you close a trade, use:`,
        `\`sold SYMBOL BUYPRICE SELLPRICE\``,
        `\`sold SOL 92.50 185.00\``,
        ``,
        `The bot will record the trade and track your profit.`,
      ].join('\n'));
      return;
    }

    const m  = stats.thisMonth;
    const at = stats.allTime;

    // Monthly target progress ($50 on $10 capital)
    const progress = stats.thisMonth
      ? targetProgress(10, 50, stats.thisMonth.totalPnlDollar)
      : null;

    const lines = [
      `📊 *Your Trading Stats*`,
      ``,
      `━━━ *THIS MONTH* ━━━`,
      m ? [
        `💰 P&L: ${m.totalPnlDollar >= 0 ? '+' : ''}$${m.totalPnlDollar.toFixed(2)}`,
        `📈 Total % gain: ${m.totalPnlPct >= 0 ? '+' : ''}${m.totalPnlPct}%`,
        `🎯 Win Rate: ${m.winRate}% (${m.wins}W / ${m.losses}L)`,
        `🔢 Trades: ${m.totalTrades}`,
        `📐 Avg multiple: ${m.avgMultiple}X`,
        m.bestTrade  ? `🏆 Best: ${m.bestTrade.symbol} +${m.bestTrade.pnlPct}%` : '',
        m.worstTrade ? `💔 Worst: ${m.worstTrade.symbol} ${m.worstTrade.pnlPct}%` : '',
      ].filter(Boolean).join('\n') : 'No trades this month yet',
      ``,
      progress ? [
        `━━━ *$50 MONTHLY TARGET* ━━━`,
        `Progress: ${progress.pct}% complete`,
        `Earned: $${stats.thisMonth.totalPnlDollar.toFixed(2)} of $50`,
        `Still need: $${progress.remaining.toFixed(2)} more`,
        progress.remaining > 0
          ? `Need your capital to ${progress.neededMultiple}X from here`
          : `🎉 TARGET REACHED!`,
      ].join('\n') : '',
      ``,
      `━━━ *ALL TIME* ━━━`,
      `💰 Total P&L: ${at.totalPnlDollar >= 0 ? '+' : ''}$${at.totalPnlDollar.toFixed(2)}`,
      `🎯 Win Rate: ${at.winRate}% (${at.wins}W / ${at.losses}L)`,
      `🔢 Total Trades: ${at.totalTrades}`,
      ``,
      `━━━ *RECENT TRADES* ━━━`,
      ...(stats.recentTrades || []).map(t =>
        `${t.outcome === 'WIN' ? '🟢' : '🔴'} ${t.symbol}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}% (${t.multiple}X)${t.pnlDollar ? ' | $' + t.pnlDollar.toFixed(2) : ''}`
      ),
    ].filter(Boolean).join('\n');

    await reply(chatId, lines);
    return;
  }

  // ── SOLD (record a closed trade) ─────────────────────────────────────────
  if (cmd === 'sold' && parts[1] && parts[2] && parts[3]) {
    const symbol    = normaliseSymbol(parts[1]);
    const buyPrice  = parseFloat(parts[2]);
    const sellPrice = parseFloat(parts[3]);
    const quantity  = parts[4] ? parseFloat(parts[4]) : null;

    if (isNaN(buyPrice) || isNaN(sellPrice)) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`sold SYMBOL BUYPRICE SELLPRICE\``,
        `\`sold SOL 92.50 185.00\``,
        `\`sold SOL 92.50 185.00 10\` ← with quantity`,
      ].join('\n'));
      return;
    }

    // Find matching position to get targetMultiple
    const positions = await getPositionsBySymbol(chatId, symbol);
    const matchPos  = positions.find(p => Math.abs(p.buyPrice - buyPrice) < buyPrice * 0.01);
    const targetMultiple = matchPos?.targetMultiple || null;

    const trade  = await recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity, targetMultiple });
    const pnlSign = trade.pnlPct >= 0 ? '+' : '';

    // Compounding advice
    const compound = quantity
      ? compoundingAdvice(buyPrice * quantity, trade.pnlDollar || 0)
      : null;

    const lines = [
      `${trade.outcome === 'WIN' ? '🟢' : '🔴'} *Trade Recorded — ${symbol}*`,
      ``,
      `💰 *Bought at:* \`$${buyPrice}\``,
      `💰 *Sold at:*   \`$${sellPrice}\``,
      `📈 *Result:*    ${pnlSign}${trade.pnlPct}% (${trade.multiple}X)`,
      quantity ? `💵 *P&L:*       ${pnlSign}$${trade.pnlDollar?.toFixed(2)}` : '',
      ``,
      trade.outcome === 'WIN' ? `🎉 Winning trade! Great discipline.` : `📉 Losing trade. The stop loss protected you from worse.`,
      ``,
      compound && compound.reinvest > 0 ? [
        `━━━ *COMPOUNDING ADVICE* ━━━`,
        `Keep safe (20%):   $${compound.safeProfit} — never risk this again`,
        `Reinvest (80%):    $${compound.reinvest} — into next trade`,
        `New capital:       $${compound.newCapital}`,
      ].join('\n') : '',
      ``,
      `Type \`profit\` to see your full stats.`,
    ].filter(Boolean).join('\n');

    await reply(chatId, lines);

    // Also remove position if it exists
    if (matchPos) await removePositionById(chatId, matchPos.positionId);
    return;
  }

  // ── SPLIT (portfolio allocation advisor) ──────────────────────────────────
  if (cmd === 'split' || cmd === 'allocate') {
    const capital = parts[1] ? parseFloat(parts[1]) : 10;

    if (isNaN(capital) || capital <= 0) {
      await reply(chatId, `❌ Example: \`split 10\` or \`split 50\``);
      return;
    }

    await reply(chatId, `🔍 Scanning for best coins to split $${capital} across...`);

    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const coins    = await getMoonshots();
      const filtered = coins.filter(c => c.probability >= 55);

      if (filtered.length === 0) {
        await reply(chatId, `😴 No high-confidence coins right now. Try again in 30 minutes.`);
        return;
      }

      const splits = adviseSplit(filtered, capital);
      const progress = targetProgress(capital, 50, 0);

      const lines = [
        `💼 *Portfolio Split for $${capital}*`,
        ``,
        `Based on current market scan — here is exactly how to split your capital:`,
        ``,
      ];

      splits.forEach((s, i) => {
        const priceStr = s.entryPrice < 0.01
          ? s.entryPrice?.toFixed(8)
          : s.entryPrice?.toFixed(4);
        lines.push(`*${i + 1}. ${s.symbol}* — ${s.probability}% confidence (${s.band})`);
        lines.push(`  💰 Allocate: \`$${s.allocation}\` (${s.allocationPct}%)`);
        lines.push(`  🛡 Max loss: \`$${s.maxLoss}\` (stop loss at -15%)`);
        lines.push(`  🎯 2X target: \`$${s.target2x}\``);
        lines.push(`  🎯 3X target: \`$${s.target3x}\``);
        if (priceStr) lines.push(`  📝 \`buy ${s.symbol} ${priceStr} 2x\``);
        lines.push(`  _${s.reasoning}_`);
        lines.push(``);
      });

      lines.push(`━━━ *RULES FOR $${capital}* ━━━`);
      lines.push(`  • Max 3 coins open at any time`);
      lines.push(`  • Never risk more than $${(capital * 0.15).toFixed(2)} per trade`);
      lines.push(`  • When any trade hits 2X → sell 60% immediately`);
      lines.push(`  • After a win → reinvest 80%, bank 20%`);
      lines.push(`  • $50 target needs your $${capital} to ${progress.neededMultiple}X total`);

      await replyChunked(chatId, lines.join('\n'));
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
      `*Track only:*`,
      `\`buy SOL 92.50\``,
      ``,
      `*Percentage profit targets:*`,
      `\`buy SOL 92.50 10%\`    — alert at 10% profit`,
      `\`buy SOL 92.50 25%\`    — alert at 25% profit`,
      `\`buy SOL 92.50 10 10%\` — 10 units + 10% target`,
      ``,
      `*Multiplier targets:*`,
      `\`buy BTC 80000 2x\`     — alert at 2X`,
      `\`buy ETH 2300 5x\`      — alert at 5X`,
      `\`buy SOL 92.50 10 2x\`  — 10 units + 2X`,
    ].join('\n'));
    return;
  }

  if (cmd === 'sell_guide') {
    await reply(chatId, [
      `💸 *How to Remove a Position*`,
      ``,
      `\`sell SOL\``,
      `\`sell BTC\``,
      ``,
      `Type \`positions\` to see your entries first.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'sold_guide') {
    await reply(chatId, [
      `💰 *Record a Completed Sale*`,
      ``,
      `After selling on your exchange, record it so`,
      `the bot tracks your profit:`,
      ``,
      `\`sold SYMBOL BUYPRICE SELLPRICE\``,
      ``,
      `Examples:`,
      `\`sold SOL 92.50 185.00\``,
      `\`sold BILL 0.107893 0.215786\``,
      `\`sold ETH 2300 4600 0.5\` ← with quantity`,
      ``,
      `The bot will show your P&L, record the trade`,
      `and give you compounding advice.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'split_guide') {
    await reply(chatId, [
      `💼 *Split Capital Across Best Coins*`,
      ``,
      `Scans the market and tells you exactly how to`,
      `split your money for maximum return:`,
      ``,
      `\`split 10\`  ← split $10`,
      `\`split 50\`  ← split $50`,
      `\`split 100\` ← split $100`,
      ``,
      `Returns the top 3 coins right now with exact`,
      `allocation amounts, stop loss levels and targets.`,
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
        sold_help:   'sold_guide',
        split_help:  'split_guide',
        profit:      'profit',
        manual:      'manual',
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