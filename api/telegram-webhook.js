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
 *  remove ID → remove a user (numeric chat ID; `remove SOL` still removes a position)
 *
 * SECURITY: requests must carry Telegram's secret-token header
 * (TELEGRAM_WEBHOOK_SECRET, registered by /api/set-commands). Without it anyone
 * could POST a fake update "from" the admin chat ID and get admin powers.
 *
 * FIXES: `sold SOL 92.5 185` now records the trade (it used to be swallowed by
 * the `sell` handler), "Buy #N" numbering, admin `remove` vs position `remove`,
 * `/cmd@BotName` in groups, trade plan locked at buy time.
 */

const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const { dashboardLink, revokeAll } = require('../src/lib/dashAuth');
const { deferUntilAfterResponse } = require('../src/lib/background');
const { verifyTelegramWebhook } = require('../src/lib/auth');
const { normaliseSymbol, fetchPrice, resolveExchange } = require('../src/lib/market');
const { PROVIDERS, normaliseExchange } = require('../src/lib/exchanges');
const EXCHANGE_LIST = 'Binance, Bybit, OKX, Gate, MEXC, KuCoin, Kraken';
const { fetchCurrentData, buildAdvice, planFromAdvice } = require('../src/services/adviceService');
const {
  getUser, isApproved, isBlocked,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, formatName,
} = require('../src/services/userService');
const {
  getAllPositions, getPositionsBySymbol, addPosition, updatePosition,
  removePositionById, removeAllBySymbol,
} = require('../src/services/positionStore');
const { recordTrade, getMonthlyStats, getAllTrades, todayLine } = require('../src/services/profitTracker');
const { adviseSplit, compoundingAdvice, targetProgress } = require('../src/services/portfolioAdvisor');
const accounts = require('../src/services/tradingAccounts');
const autoTrader = require('../src/services/autoTrader');
const subs = require('../src/services/subscriptionService');
const practice = require('../src/services/practiceService');
const autoBuyer = require('../src/services/autoBuyer');
const box = require('../src/lib/secretBox');
const { tradingIps } = require('../src/lib/binanceTrade');
const { baseUrl } = require('../src/lib/dashAuth');

// Commands that work while a subscription has ended (paid access only)
const FREE_COMMANDS = new Set(['subscribe', 'renew', 'pay', 'account', 'subscription', 'plan', 'help', 'menu', 'dashboard', 'autotrade', 'sell', 'sellentry', 'sellall', 'remove']);

const adminId = () => process.env.TELEGRAM_CHAT_ID;
const esc = tg.escapeMd;
const nameOf = (user) => esc(formatName(user));

// ─── Persistent MENU button ───────────────────────────────────────────────────
const PERSISTENT_MENU = {
  keyboard:    [[{ text: '📋 MENU' }]],
  resize_keyboard:          true,
  persistent:               true,
  input_field_placeholder:  'Tap MENU or type a command...',
};

// ─── Inline command buttons (every feature, grouped) ─────────────────────────
const b = (text, data) => ({ text, callback_data: data });
const MENU_ROWS = [
  // Your trades
  [b('📊 My Positions', 'positions'),     b('💰 Add a Buy', 'buy_help')],
  [b('🧾 Record a Sale', 'sold_help'),     b('🗑 Stop Tracking', 'sell_help')],
  [b('🛡 Change a Stop', 'setstop_help'),  b('🔎 Check a Coin', 'check_help')],
  [b('📈 My Profits', 'profit'),           b('💼 Split Capital', 'split_help')],
  // Automation & practice
  [b('🤖 Auto-trading', 'golive'),         b('🛒 Auto-buy', 'autobuy')],
  [b('💰 Binance Balance', 'balance'),     b('🎮 Practice', 'practice')],
  // Market
  [b('🔍 Scan Now', 'scan'),               b('🌕 Moonshots', 'moonshots')],
  [b('🚀 New Listings', 'newlistings'),    b('🖥 My Dashboard', 'dashboard')],
  // Account & help
  [b('💳 My Account', 'account'),          b('📖 All Commands', 'help')],
  [b('📚 User Manual', 'manual')],
];
const ADMIN_ROWS = [
  [b('⏳ Pending', 'pending'),   b('👥 Users', 'users')],
  [b('💳 Subscribers', 'subs'),  b('🔗 Invite Links', 'invite')],
];
const INLINE_MENU = { inline_keyboard: MENU_ROWS };
const menuFor = (chatId) => ({ inline_keyboard: isAdmin(chatId) ? [...MENU_ROWS, ...ADMIN_ROWS] : MENU_ROWS });

const MENU_TEXT = (admin) => [
  `*📋 Menu* — tap any button`,
  ``,
  `*Row 1–4:* your trades · *5–6:* auto-trading, practice & balance`,
  `*7–8:* market scans & dashboard · *9–10:* account & help${admin ? `\n*Last rows:* admin` : ''}`,
].join('\n');

// ─── Send helpers (shared Telegram client, Markdown-safe) ───────────────────
async function send(chatId, text, markup) {
  return tg.send(chatId, text, { markup: markup || PERSISTENT_MENU });
}

async function reply(chatId, text, showInline = false) {
  return send(chatId, text, showInline ? menuFor(chatId) : PERSISTENT_MENU);
}

async function replyChunked(chatId, text, showInline = false) {
  return tg.sendLong(chatId, text, { markup: showInline ? menuFor(chatId) : PERSISTENT_MENU });
}

const answerCallback = tg.answerCallback;

function isAdmin(chatId) {
  const admin = adminId();
  return !!admin && chatId?.toString() === admin.toString();
}

const isChatId = (v) => /^-?\d{3,}$/.test(String(v || ''));

// ─── Notify admin of new access request ───────────────────────────────────────
async function notifyAdminNewRequest(user) {
  if (!adminId()) return;
  const name = nameOf(user);
  await send(adminId(), [
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
      await reply(adminChatId, `✅ *${nameOf(user)}* has been approved.`);
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
    await reply(adminChatId, `❌ *${nameOf(user)}* has been rejected.`);
    await send(targetId, [
      `❌ *Access Denied*`,
      ``,
      `Your request to use CryptoBot V2 was not approved.`,
    ].join('\n'), { remove_keyboard: true });
  }
}

// ─── Main command handler ─────────────────────────────────────────────────────
async function handleMessage(chatId, text, from, meta = {}) {
  const cleanText = text.trim().startsWith('/') ? text.trim().slice(1) : text.trim();
  const parts     = cleanText.split(/\s+/);
  // "/buy@MyBot SOL 1" (group chats) → "buy"
  const cmd       = parts[0]?.toLowerCase().split('@')[0];

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
        `\`approve ID\` — approve a user`,
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
      if (param === 'paid' || param === 'payfailed') { await handleSubscribe(chatId, ['check']); return; }
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
      `  • Scans the market for strong momentum setups`,
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

    // Paid access: an ended subscription only allows paying, help and closing positions
    const menuText = text.trim() === '📋 MENU' || text.trim() === '🖥 My Dashboard';
    if (!FREE_COMMANDS.has(cmd) && !menuText && !(await subs.hasAccess(chatId))) {
      await send(chatId, [
        `🔒 *Your subscription has ended.*`,
        ``,
        `Renew to use the bot again — ${subs.priceLabel()}:`,
        `\`subscribe you@example.com\` (your email is for the Paystack receipt)`,
        ``,
        `\`account\` shows your status.`,
      ].join('\n'));
      return;
    }
  }

  // ── GO-LIVE WIZARD: the next message is an API key / secret ─────────────
  if (!text.trim().startsWith('/') && /^[A-Za-z0-9]{32,128}$/.test(text.trim())) {
    if (await handleWizardKey(chatId, text.trim(), meta)) return;
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
        lines.push(`👤 *${nameOf(u)}*`);
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
        lines.push(`👤 *${nameOf(u)}*`);
        lines.push(`   ID: \`${u.chatId}\``);
        lines.push(`   Since: ${new Date(u.approvedAt || u.requestedAt).toUTCString()}`);
        lines.push(``);
      });
      await reply(chatId, lines.join('\n'));
      return;
    }

    if (cmd === 'approve' && isChatId(parts[1])) {
      const ok   = await approveUser(parts[1]);
      const user = await getUser(parts[1]);
      if (ok && user) {
        await reply(chatId, `✅ *${nameOf(user)}* approved.`);
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

    if (cmd === 'block' && isChatId(parts[1])) {
      const user = await getUser(parts[1]);
      await blockUser(parts[1]);
      await reply(chatId, `🚫 User \`${parts[1]}\` blocked.`);
      if (user) await send(parts[1], `❌ Your access to CryptoBot V2 has been revoked.`, { remove_keyboard: true });
      return;
    }

    if (cmd === 'grant' && isChatId(parts[1])) {
      const days = parseInt(parts[2], 10) || subs.plan().days;
      const until = await subs.extend(parts[1], days, { grantedBy: chatId });
      await reply(chatId, `🎁 Gave \`${parts[1]}\` ${days} days — active until ${new Date(until).toUTCString()}.`);
      await send(parts[1], `🎁 *You've been given ${days} days of access* — active until ${new Date(until).toUTCString()}.`).catch(() => {});
      return;
    }

    if (cmd === 'revoke' && isChatId(parts[1])) {
      await subs.revoke(parts[1]);
      await reply(chatId, `⛔ Subscription for \`${parts[1]}\` ended now.`);
      return;
    }

    if (cmd === 'subs' || cmd === 'subscribers') {
      const list = await subs.listSubscribers();
      const lines = [`💳 *Subscriptions* — paid access is ${subs.enabled() ? '*ON*' : '*OFF* (set PAID_ACCESS_ENABLED=true)'} · ${subs.priceLabel()}`, ``];
      for (const { user, sub } of list) {
        lines.push(`${sub.active ? '🟢' : '⚪'} ${nameOf(user)} — ${sub.active ? `until ${new Date(sub.paidUntil).toUTCString()} (${sub.daysLeft}d)` : sub.paidUntil ? 'ended' : 'never paid'}`);
      }
      if (!list.length) lines.push('No approved users yet.');
      lines.push('', '`grant ID DAYS` · `revoke ID`');
      await replyChunked(chatId, lines.join('\n'));
      return;
    }

    // Only treat `remove <numeric chat id>` as user removal; `remove SOL`
    // falls through to the position-removal command below.
    if (cmd === 'remove' && isChatId(parts[1])) {
      const ok = await removeUser(parts[1]);
      await reply(chatId, ok ? `🗑 User \`${parts[1]}\` removed.` : `⚠️ User not found.`);
      return;
    }
  }

  // ── MENU ─────────────────────────────────────────────────────────────────
  if (cmd === 'menu' || text.trim() === '📋 MENU') {
    await send(chatId, MENU_TEXT(isAdmin(chatId)), menuFor(chatId));
    return;
  }

  // ── DASHBOARD (personal login link) ────────────────────────────────────
  if (cmd === 'dashboard' || cmd === 'web' || text.trim() === '🖥 My Dashboard') {
    if ((parts[1] || '').toLowerCase() === 'logout') {
      await revokeAll(chatId);
      await reply(chatId, `🔒 All your dashboard links are now signed out. Send /dashboard for a new one.`);
      return;
    }
    const link = await dashboardLink(chatId);
    await send(chatId, [
      `🖥 *Your personal dashboard*`,
      ``,
      `Live P&L on every position, your stops and targets, trade history, and buttons to add, update or close positions.`,
      ``,
      `🔐 This link logs you in — *don't share it*. It works for 30 days.`,
      `Lost it or shared it by mistake? Send \`dashboard logout\` to sign out everywhere.`,
    ].join('\n'), { inline_keyboard: [[{ text: '🖥 Open my dashboard', url: link }]] });
    return;
  }

  // ── PRACTICE (play money, real Binance prices) ──────────────────────────
  if (cmd === 'practice' || cmd === 'paper' || cmd === 'demo') {
    await handlePractice(chatId, parts.slice(1));
    return;
  }

  // ── BALANCE (the user's own Binance Spot wallet) ────────────────────────
  if (cmd === 'balance' || cmd === 'wallet' || cmd === 'bal') {
    try {
      const b = await accounts.getBalances(chatId);
      const n = (x) => String(+Number(x).toFixed(8));
      const lines = [
        `💰 *Your Binance balance*${b.testnet ? ' (testnet — fake money)' : ''}`,
        ``,
        `*Total:* ${usd(b.totalUsd)}`,
        ``,
        ...b.assets.map(a => `• *${a.asset}*: ${n(a.free + a.locked)}${a.usd !== null && !['USDT', 'USDC', 'FDUSD'].includes(a.asset) ? ` ≈ ${usd(a.usd)}` : ''}${a.locked > 0 ? `  _(${n(a.locked)} held by open orders)_` : ''}`),
        b.hiddenDust ? `_+ ${b.hiddenDust} tiny balance${b.hiddenDust === 1 ? '' : 's'} under $1_` : '',
        ``,
        `_Spot wallet only. Coins in Funding or Earn aren't counted — move USDT to Spot for the bot to use it._`,
      ].filter(x => x !== '');
      await send(chatId, lines.join('\n'), { inline_keyboard: [[{ text: '↻ Refresh', callback_data: 'balance' }, { text: '📊 My positions', callback_data: 'positions' }]] });
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : esc(err.message)}`);
    }
    return;
  }

  // ── AUTO-BUY (practice now; live only after proven results) ─────────────
  if (cmd === 'autobuy') {
    await handleAutoBuy(chatId, parts.slice(1));
    return;
  }

  // ── GO LIVE (step-by-step Binance set-up) ───────────────────────────────
  if (cmd === 'golive' || cmd === 'live') {
    await handleGoLive(chatId, parts.slice(1));
    return;
  }

  // ── SUBSCRIPTION (paid access) ───────────────────────────────────────────
  if (cmd === 'subscribe' || cmd === 'renew' || cmd === 'pay') {
    await handleSubscribe(chatId, parts.slice(1));
    return;
  }
  if (cmd === 'account' || cmd === 'subscription' || cmd === 'plan') {
    await handleSubscribe(chatId, ['status']);
    return;
  }

  // ── AUTOTRADE (automated exits on the user's Binance account) ───────────
  if (cmd === 'autotrade' || cmd === 'autoexit' || cmd === 'autoexits') {
    await handleAutotrade(chatId, parts.slice(1), meta);
    return;
  }

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    await reply(chatId, [
      `🤖 *All commands* — or just tap *📋 MENU*`,
      ``,
      `━━━ *YOUR TRADES* ━━━`,
      `\`buy SOL 92.50\` — track a buy · add a quantity: \`buy SOL 92.50 2\``,
      `\`buy SOL 92.50 2x\` / \`10%\` — with a target · \`sl 88\` — your own stop`,
      `\`buy PEPE 0.0000098 ex mexc\` — coin on another exchange`,
      `\`positions\` — your open trades · \`check SOL\` — live advice`,
      `\`setstop SOL 90\` — change a stop`,
      `\`sold SOL 92.50 110\` — record a sale (tracks profit)`,
      `\`sell SOL\` — stop tracking (nothing recorded)`,
      `\`profit\` — your stats · \`split 100\` — split capital across top coins`,
      ``,
      `━━━ *AUTO-TRADING (real money)* ━━━`,
      `\`golive\` — connect Binance step by step, then turn on auto-trading`,
      `\`golive off\` — stop the bot buying and selling`,
      `\`balance\` — your Binance Spot wallet`,
      `\`autobuy\` — the bot's buying strategy, test results and settings`,
      ``,
      `━━━ *PRACTICE (play money)* ━━━`,
      `\`practice\` — your $10,000 practice account`,
      `\`practice buy SOL 100\` · \`practice sell SOL\` · \`practice reset\``,
      `\`autobuy on\` / \`off\` — let the bot buy with your play money`,
      ``,
      `━━━ *MARKET* ━━━`,
      `\`scan\` · \`moonshots\` — small caps with strong momentum (high risk)`,
      `\`newlistings\` — new coins with contract addresses`,
      ``,
      `━━━ *ACCOUNT* ━━━`,
      `\`dashboard\` — your web dashboard · \`dashboard logout\` — sign out everywhere`,
      subs.enabled() ? `\`account\` — your subscription · \`subscribe\` — renew` : `\`account\` — your access`,
      `\`manual\` — the full user guide`,
      isAdmin(chatId) ? `\n━━━ *ADMIN* ━━━\n\`pending\` · \`users\` · \`approve ID\` · \`block ID\` · \`remove ID\` · \`invite\`\n\`subs\` · \`grant ID DAYS\` · \`revoke ID\`\n\`autobuy run\` · \`autobuy pause\`/\`resume\` · \`autobuy unlock\`/\`lock\`` : '',
    ].filter(x => x !== '').join('\n'));
    return;
  }

  // ── SCAN ─────────────────────────────────────────────────────────────────
  if (cmd === 'scan' || cmd === 'search' || cmd === 'find') {
    await reply(chatId, `🔍 Scanning small caps for momentum... about 30 seconds.`);
    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const moonshots = await getMoonshots();

      if (moonshots.length === 0) {
        await reply(chatId, `😴 Nothing scores high enough right now. Try again in 30-60 minutes.`);
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
          `${bandEmoji} *Score: ${coin.probability}/92 — ${coin.band}*`,
          `_Heuristic score, not a probability — this scanner has not been backtested._`,
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

    // Optional exchange anywhere after the price: "ex mexc", "on mexc", "@mexc" or just "mexc"
    let wantedExchange = null;
    for (let k = 3; k < parts.length; k++) {
      const t = String(parts[k]).toLowerCase();
      if ((t === 'ex' || t === 'on') && normaliseExchange(parts[k + 1])) { wantedExchange = normaliseExchange(parts[k + 1]); parts.splice(k, 2); k--; continue; }
      const bare = normaliseExchange(t.replace(/^@/, ''));
      if (bare) { wantedExchange = bare; parts.splice(k, 1); k--; }
    }

    // Optional custom stop anywhere after the price: "sl 95", "sl95", "stop=95"
    let userStop = null;
    for (let k = 3; k < parts.length; k++) {
      const t = String(parts[k]).toLowerCase();
      const glued = t.match(/^(?:sl|stop)[:=]?(\d*\.?\d+)$/);
      if (glued) { userStop = parseFloat(glued[1]); parts.splice(k, 1); k--; continue; }
      if ((t === 'sl' || t === 'stop') && !isNaN(parseFloat(parts[k + 1]))) {
        userStop = parseFloat(parts[k + 1]); parts.splice(k, 2); k--;
      }
    }

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

    if (userStop !== null && !(userStop > 0 && userStop < buyPrice)) {
      await reply(chatId, `❌ Stop loss must be below your buy price. Example: \`buy SOL 92.50 2x sl 88\``);
      return;
    }

    // Count existing entries BEFORE adding (old code counted after → off by one)
    const existing = await getPositionsBySymbol(chatId, symbol);
    const entryNum = existing.length + 1;
    // Find where this coin trades (the exchange you named, or auto-detect)
    const found = await resolveExchange(symbol, wantedExchange);
    if (!found) {
      await reply(chatId, wantedExchange
        ? `❌ ${symbol.replace('USDT', '')}/USDT isn't available on ${PROVIDERS[wantedExchange].name}. Check the ticker, or try another exchange.`
        : `❌ Couldn't find ${symbol.replace('USDT', '')}/USDT on ${EXCHANGE_LIST}.\nCheck the ticker. If it trades elsewhere, the bot can't track it yet.`);
      return;
    }
    const newPos   = await addPosition({ chatId, symbol, buyPrice, quantity, targetMultiple, stopLossPrice: userStop, exchange: found.exchange });

    // Build a human-friendly target label e.g. "10% profit" or "2X"
    const targetLabel = targetPct != null
      ? `${targetPct}% profit`
      : targetMultiple ? `${targetMultiple}X` : null;

    // ── Send immediate confirmation ──────────────────────────────────────
    await reply(chatId, [
      `✅ *Buy #${entryNum} Registered — ${symbol}*`,
      existing.length > 0 ? `📌 _You now have ${entryNum} separate entries for ${symbol}_` : '',
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      `📍 *Prices from:* ${found.name}${wantedExchange ? '' : ' (auto-detected; add "ex mexc" etc. to choose)'}`,
      quantity    ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      targetLabel ? `🎯 *Target:*   ${targetLabel} = \`$${targetPrice.toFixed(6)}\`` : '',
      userStop    ? `🛡 *Your stop:* \`$${userStop}\` (${(((buyPrice - userStop) / buyPrice) * 100).toFixed(2)}% below entry)` : '',
      ``,
      `⏳ _Fetching live price and trade plan..._`,
    ].filter(Boolean).join('\n'));

    // ── Immediate first check — runs right now, no waiting for cron ──────
    // This is what actually starts the alerts. Without this, you'd wait
    // up to 30 mins for the cron to notice the new position.
    try {
      const { candles1h, candles4h, currentPrice } = await fetchCurrentData(symbol, { exchange: found.exchange });

      const advice = buildAdvice({
        symbol, buyPrice, currentPrice, candles1h, candles4h,
        lockedPlan: userStop ? { stopLoss: userStop, takeProfits: null } : null,
      });

      // Lock the stop loss + TPs now, so the 10-min quickcheck watches the stop
      // from the start and every later check uses the same levels.
      const plan = planFromAdvice(advice);
      if (plan) {
        await updatePosition(chatId, newPos.positionId, {
          ...plan,
          initialStopPrice: plan.stopLossPrice,
          ...(userStop ? { stopSource: 'user', stopStage: 'user' } : { stopSource: 'atr', stopStage: 'initial' }),
        });
        // Automated exits on → put the stop order on Binance now (sends its own message)
        await autoTrader.sync(chatId, newPos.positionId, { price: found.exchange === 'binance' ? currentPrice : null }).catch(() => null);
      }

      const sl  = advice.tradePlan?.stopLoss;
      const tp1 = advice.tradePlan?.takeProfits?.tp1;
      const tp2 = advice.tradePlan?.takeProfits?.tp2;
      const tp3 = advice.tradePlan?.takeProfits?.tp3;

      const pnlPct = ((currentPrice - buyPrice) / buyPrice) * 100;
      const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

      // Send the live trade plan to ACTION channel (main chat)
      await reply(chatId, [
        `📡 *Live Check — ${symbol}*`,
        ``,
        `💰 *Your entry:*  \`$${buyPrice}\``,
        `📊 *Live price:*  \`$${currentPrice.toFixed(6)}\``,
        `📈 *P&L now:*     ${pnlStr}`,
        ``,
        `🗺 *Your Trade Plan:*`,
        sl  ? `  🛡 Stop loss:  \`$${sl.toFixed(6)}\`  ← EXIT if hit` : '',
        tp1 ? `  🟢 TP1 (40%):  \`$${tp1.price.toFixed(6)}\`` : '',
        tp2 ? `  🟢 TP2 (35%):  \`$${tp2.price.toFixed(6)}\`` : '',
        tp3 ? `  🟢 TP3 (25%):  \`$${tp3.price.toFixed(6)}\`` : '',
        targetLabel ? `  🎯 Your target: \`$${targetPrice.toFixed(6)}\` (${targetLabel})` : '',
        ``,
        `📌 Milestones (every +10%) and 4-hourly HOLD updates arrive here silently.`,
        ``,
        `⏰ Next auto-check in ~30 mins via cron.`,
        `Type \`check ${symbol.replace('USDT','')}\` anytime for an instant update.`,
      ].filter(Boolean).join('\n'));

    } catch (liveErr) {
      // Live check failed — still confirmed, cron will pick it up
      console.error('[Buy live check]', liveErr.message);
      await reply(chatId, [
        ``,
        `⚠️ _Live price fetch failed (${liveErr.message}) — position is saved and will be monitored by cron._`,
        ``,
        `You will be alerted when:`,
        targetLabel ? `  🎯 Price hits \`$${targetPrice.toFixed(6)}\` (${targetLabel}) → SELL NOW` : '',
        `  🔴 Stop loss hit → exit immediately`,
        `  🟢 TP1 / TP2 / TP3 hit → take partial profit`,
        `  📊 Every 10% milestone (silent)`,
        `  ⚪ Hold update every 4 hours (silent)`,
        ``,
        `\`positions\` to see all your entries`,
      ].filter(Boolean).join('\n'));
    }
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // `sold SOL 92.5 185` (with prices) records a trade — handled further down.
  // Plain `sold SOL` keeps working as an alias for `sell SOL`.
  const isSoldRecord = cmd === 'sold' && parts[1] && parts[2] && parts[3];
  if ((cmd === 'sell' || cmd === 'remove' || cmd === 'sold') && !isSoldRecord) {
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
      await reply(chatId, [
        `✅ *${symbol}* removed. Good trade! 💸`,
        ``,
        `To track profit, record it next time with:`,
        `\`sold ${symbol.replace('USDT', '')} ${entries[0].buyPrice} SELLPRICE\``,
      ].join('\n'));
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

  // ── SETSTOP (change the saved stop of a position) ─────────────────────────
  if (cmd === 'setstop' || cmd === 'setstopid') {
    const byId = cmd === 'setstopid';
    const price = parseFloat(parts[2]);
    if (!parts[1] || isNaN(price) || price <= 0) {
      await reply(chatId, [
        `❌ *Format:*`,
        `\`setstop SOL 88.5\` — set your stop for SOL`,
        `\`setstopid SOLUSDT:1715123456789 88.5\` — one specific entry`,
      ].join('\n'));
      return;
    }

    let targets;
    if (byId) {
      const all = await getAllPositions(chatId);
      targets = all[parts[1]] ? [all[parts[1]]] : [];
    } else {
      targets = await getPositionsBySymbol(chatId, normaliseSymbol(parts[1]));
    }
    if (targets.length === 0) {
      await reply(chatId, `⚠️ No matching position. Type \`positions\` to see your entries.`);
      return;
    }
    if (targets.length > 1) {
      const lines = [`📌 *You have ${targets.length} ${targets[0].symbol} entries — which one?*`, ``];
      targets.forEach((p, i) => lines.push(`*Entry ${i + 1}* at \`$${p.buyPrice}\` → \`setstopid ${p.positionId} ${price}\``));
      await reply(chatId, lines.join('\n'));
      return;
    }

    const pos = targets[0];
    const live = await fetchPrice(pos.symbol, { exchange: pos.exchange || null });
    if (live && price >= live) {
      await reply(chatId, `❌ A stop must be below the current price (\`$${live}\`). For an immediate exit, just sell on your exchange.`);
      return;
    }
    await updatePosition(chatId, pos.positionId, { stopLossPrice: price, stopSource: 'user', stopStage: 'user', stopLossHit: false });
    const vsEntry = ((price - pos.buyPrice) / pos.buyPrice) * 100;
    await reply(chatId, [
      `🛡 *Stop updated — ${pos.symbol}*`,
      ``,
      `Entry: \`$${pos.buyPrice}\``,
      `New stop: \`$${price}\` (${vsEntry >= 0 ? '+' : ''}${vsEntry.toFixed(2)}% vs entry)`,
      pos.stopLossPrice ? `Old stop: \`$${pos.stopLossPrice}\`` : '',
      ``,
      `The 10-minute price check will alert you if it's hit.`,
    ].filter(Boolean).join('\n'));
    await autoTrader.sync(chatId, pos.positionId).catch(() => null); // moves the Binance stop order if auto-exits are on
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
        lines.push(`*${symbol}*${pos.exchange ? ` · ${PROVIDERS[pos.exchange]?.name || pos.exchange}` : ''}`);
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
      // Entries can be on different exchanges: fetch each exchange once
      const marketByEx = {};
      for (let i = 0; i < entries.length; i++) {
        const pos    = entries[i];
        const exKey  = pos.exchange || '';
        marketByEx[exKey] = marketByEx[exKey] || await fetchCurrentData(symbol, { exchange: pos.exchange || null });
        const { candles1h, candles4h, currentPrice } = marketByEx[exKey];
        const lockedPlan = pos.stopLossPrice ? { stopLoss: pos.stopLossPrice, takeProfits: pos.takeProfits || null } : null;
        const advice = buildAdvice({ symbol, buyPrice: pos.buyPrice, currentPrice, candles1h, candles4h, lockedPlan });
        if (!lockedPlan) {
          const plan = planFromAdvice(advice);
          if (plan) await updatePosition(chatId, pos.positionId, plan);
        }
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
      `CryptoBot V2 is a private crypto intelligence bot that runs inside Telegram. It scans the market 24/7, finds momentum setups, and sends you alerts with an entry, a stop loss and take-profit levels. Every BUY alert shows how that kind of signal actually performed in a backtest (fees included).`,
      ``,
      `It connects to live market data, runs professional-grade technical analysis across multiple timeframes, and delivers the results straight to your Telegram. No charts. No guesswork.`,
      ].join('\n'),

      // ── Section 2 ──
      [`💎 *WHAT YOU STAND TO GAIN*`,
      ``,
      `✅ *Get setups as they happen*`,
      `The bot scans every 30 minutes. When a setup scores high enough you get an alert with entry price, stop loss, 3 take-profit targets — and its measured backtest record.`,
      ``,
      `✅ *Know exactly when to sell*`,
      `The bot monitors your positions and alerts you at TP1, TP2, TP3 and your custom target (2X, 3X, 5X).`,
      ``,
      `✅ *Losses stay small*`,
      `Every trade comes with an ATR-based stop loss. If price hits it you get an immediate exit alert before the loss gets worse.`,
      ``,
      `✅ *Multi-indicator analysis*`,
      `ADX, Stochastic RSI, Bollinger Bands, OBV, VWAP, ATR — the same tools professional traders use.`,
      ``,
      `✅ *New coin opportunities*`,
      `Get newly listed coins with contract addresses, a heuristic score and trade plans delivered to you.`,
      ``,
      `✅ *You stay in control*`,
      `The bot never touches your money. It is read-only intelligence. You decide every trade.`,
      ].join('\n'),

      // ── Section 3 ──
      [`📋 *THE MENU — ALL COMMANDS*`,
      ``,
      `🔍 *Scan Now*`,
      `Scans small-cap coins for strong momentum. Returns a heuristic score, factor breakdown, contract address and suggested buy commands. High risk.`,
      ``,
      `🌕 *Moonshots*`,
      `Same as Scan — small caps with strong momentum, scored on 7 factors. The score is not a probability and has not been backtested.`,
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
      [`📊 *THE TWO KINDS OF SCORE*`,
      ``,
      `*Market scanner BUY alerts* show a setup score (out of 15) AND the measured backtest record for that kind of signal: number of trades, win rate and average profit per trade in R (fees included). Trust the backtest numbers, not the score.`,
      ``,
      `*Moonshot / scan results* show a heuristic score (0–92) built from 7 factors:`,
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
      `⚠️ This score is NOT a probability and has not been backtested. A high score does not mean a coin is likely to rise. Always manage risk.`,
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
      `No. No tool can guarantee profits in crypto. Check the backtest numbers in each BUY alert: if the average R is below zero, the strategy lost money in testing. Losses are normal — only risk money you can afford to lose.`,
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

    if (isNaN(buyPrice) || isNaN(sellPrice) || buyPrice <= 0 || sellPrice <= 0) {
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
    const matchPos  = positions.find(p => Math.abs(p.buyPrice - buyPrice) <= buyPrice * 0.01);
    const targetMultiple = matchPos?.targetMultiple || null;
    const qty = quantity || matchPos?.quantity || null;

    const trade  = await recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity: qty, targetMultiple });
    const pnlSign = trade.pnlPct >= 0 ? '+' : '';

    // Compounding advice
    const compound = qty
      ? compoundingAdvice(buyPrice * qty, trade.pnlDollar || 0)
      : null;

    const lines = [
      `${trade.outcome === 'WIN' ? '🟢' : '🔴'} *Trade Recorded — ${symbol}*`,
      ``,
      `💰 *Bought at:* \`$${buyPrice}\``,
      `💰 *Sold at:*   \`$${sellPrice}\``,
      `📈 *Result:*    ${pnlSign}${trade.pnlPct}% (${trade.multiple}X)`,
      trade.pnlDollar !== null ? `💵 *P&L:*       ${trade.pnlDollar >= 0 ? '+' : '-'}$${Math.abs(trade.pnlDollar).toFixed(2)}` : '',
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
      todayLine(await getAllTrades(chatId)),
      `Type \`profit\` to see your full stats.`,
    ].filter(Boolean).join('\n');

    await reply(chatId, lines);

    // Also remove position if it exists
    if (matchPos) {
      await removePositionById(chatId, matchPos.positionId);
      await reply(chatId, `🗑 Removed your open ${symbol} entry at \`$${matchPos.buyPrice}\` from monitoring.`);
    }
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
        await reply(chatId, `😴 Nothing scores high enough right now. Try again in 30 minutes.`);
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
        lines.push(`*${i + 1}. ${s.symbol}* — score ${s.probability}/92 (${s.band})`);
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

  if (cmd === 'setstop_guide') {
    await reply(chatId, [
      `🛡 *Change the stop on a position*`,
      ``,
      `\`setstop SOL 88.5\` — new stop for SOL`,
      `\`setstopid SOLUSDT:1715123456789 88.5\` — one specific entry (IDs are in \`positions\`)`,
      ``,
      `The stop must be below the current price. With auto-trading on, the bot moves your Binance stop order too.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'check_guide') {
    const coins = [...new Set(Object.values(await getAllPositions(chatId)).map(p => p.symbol.replace(/USDT$/, '')))];
    if (!coins.length) { await reply(chatId, `🔎 *Check a coin*\n\nYou have no open positions yet. Add one: \`buy SOL 150\``); return; }
    const rows = [];
    for (let i = 0; i < coins.length && i < 24; i += 3) rows.push(coins.slice(i, i + 3).map(c => b(`🔎 ${c}`, `check ${c}`)));
    await send(chatId, `🔎 *Check a coin* — live price, P&L and advice. Tap one:`, { inline_keyboard: rows });
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

// ─── Auto-buy ─────────────────────────────────────────────────────────────────
/** One line warning users when the forward test isn't complete yet. */
async function forwardWarning() {
  const g = await autoBuyer.gateStatus();
  if (g.eligible) return `✅ Forward test complete: ${g.forward.days} days, ${g.forward.closedTrades} trades, in profit.`;
  return `⚠️ *Not proven yet:* the bot's own practice run has ${g.forward.days} of ${g.needs.days} days and ${g.forward.closedTrades} of ${g.needs.trades} trades${g.forward.closedTrades ? `, ${g.forward.equity >= g.forward.start ? 'in profit' : 'currently at a loss'}` : ''}.`;
}

const VERDICT_ICON = { PASS: '✅ PASSED', PROMISING: '🟡 PROMISING (could be luck)', FAIL: '❌ FAILED', 'NOT TESTED': '⚪ NOT TESTED YET' };

async function handleAutoBuy(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  const b = (args[1] || '').toLowerCase();
  try {
    if (a === 'on') {
      await autoBuyer.setPractice(chatId, true);
      await reply(chatId, [
        `🤖 *Practice auto-buy ON*`,
        ``,
        `Every day just after midnight (UTC) the bot checks ${autoBuyer.currentStrategy().name.toLowerCase()} signals on 15 large coins and buys the ones that qualify with your *play money* — about 1% of the account at risk per trade, at most 5 at once.`,
        `It sells by a trailing stop that only moves up. You'll get a message for every buy and sale.`,
        ``,
        `\`autobuy off\` stops new buys. \`practice\` shows your results.`,
      ].join('\n'));
      return;
    }
    if (a === 'off') {
      await autoBuyer.setPractice(chatId, false);
      await reply(chatId, `⏸ Practice auto-buy OFF. Open practice positions keep their stops until they sell (or \`practice sell COIN\`).`);
      return;
    }
    if (a === 'live') {
      if (b === 'off') { await autoBuyer.setLive(chatId, false); await reply(chatId, `⏸ Live auto-buy OFF. No new buys; open positions keep their Binance stop orders.`); return; }
      if (b === 'on' && (args[2] || '').toLowerCase() === 'confirm') {
        await autoBuyer.setLive(chatId, true);
        await reply(chatId, `🟢 *Live auto-buy ON.* The bot may now buy on your Binance account, about 1% of the account at risk per trade and 5 positions at once. \`autobuy live off\` stops it any time.`);
        return;
      }
      if (b === 'on') {
        if (!(await autoBuyer.isLiveUnlocked())) throw new autoBuyer.AutoBuyError(isAdmin(chatId) ? 'Live auto-buy hasn\'t been opened yet. Send `autobuy unlock` to open it (you\'ll see what the forward test still needs).' : 'Live auto-buy hasn\'t been opened by the admin yet. Send `autobuy` to see the forward-test progress.');
        await send(chatId, [
          `⚠️ *Real money — the bot will BUY for you*`,
          ``,
          `Each day it may buy coins on your Binance account using your USDT: about 1% of the account at risk per trade, no coin above 20%, at most 5 positions, and no buying after a 3% drop in a day.`,
          await forwardWarning(),
          `Losses are possible even with a tested strategy.`,
        ].filter(Boolean).join('\n'), { inline_keyboard: [[{ text: '✅ I understand — turn on', callback_data: 'autobuy live on confirm' }], [{ text: 'Not now', callback_data: 'autobuy' }]] });
        return;
      }
    }
    // Admin controls
    if (isAdmin(chatId) && ['unlock', 'lock', 'pause', 'resume', 'run'].includes(a)) {
      if (a === 'unlock') {
        const g = await autoBuyer.unlock(chatId);
        await reply(chatId, [
          `🔓 *Live auto-buy OPEN.*`,
          g.early ? `⚠️ Opened *early* — the forward test isn't finished. Still missing: ${g.missing.join('; ')}. Everyone sees this before they switch it on.` : `✅ The forward test is complete.`,
          ``,
          `Turn it on for your own account: \`autobuy live on\` (or the button after \`golive\`). Users opt in the same way. \`autobuy lock\` closes it again.`,
        ].join('\n'));
        return;
      }
      if (a === 'lock') { await autoBuyer.lock(); await reply(chatId, `🔒 Live auto-buy locked. No new live buys.`); return; }
      if (a === 'pause') { await autoBuyer.pause(true); await reply(chatId, `🛑 Auto-buy PAUSED for everyone (practice and live). \`autobuy resume\` to restart.`); return; }
      if (a === 'resume') { await autoBuyer.pause(false); await reply(chatId, `▶️ Auto-buy resumed.`); return; }
      if (a === 'run') {
        await reply(chatId, `⏳ Running today's auto-buy check now…`);
        const allowed = new Set((await subs.getChatIdsWithAccess()).map(String));
        const r = await autoBuyer.runDaily({ allowed, force: true, send: (id, text) => tg.send(id, text) });
        await reply(chatId, `✅ Done: ${r.signals ?? 0} signal(s), ${r.practice ?? 0} practice account(s), ${r.live ?? 0} live account(s).${r.skipped ? ` (${r.skipped})` : ''}`);
        return;
      }
    }

    // Status
    const st = await autoBuyer.userStatus(chatId);
    const s = st.strategy, f = st.forward, c = st.checks;
    const tick = (ok) => (ok ? '✅' : '⬜');
    const lines = [
      `🤖 *Auto-buy* — the bot picks and buys coins by itself`,
      ``,
      `*Strategy:* ${esc(s.label)}`,
      `*Tested on past data:* ${VERDICT_ICON[s.verdict] || s.verdict}${s.test ? ` — ${s.test.trades} trades on unseen data, ${s.test.expectancyR >= 0 ? '+' : ''}${s.test.expectancyR}R per trade after fees` : ''}`,
      ``,
      `*Forward test* (the bot's own practice account, from today on):`,
      f.startedAt ? `${f.days} days · ${f.closedTrades} closed trades${f.winRatePct !== null ? ` · ${f.winRatePct}% wins` : ''} · ${f.equity >= f.start ? '+' : ''}${usd(f.equity - f.start)} on $10,000` : `starts at the next daily run`,
      ``,
      `*Live auto-buy:* ${st.unlocked ? (st.unlockedEarly && !st.eligible ? '🔓 open early (forward test not finished)' : '🔓 open') : '🔒 not open yet'}${st.paused ? ' · 🛑 paused by admin' : ''}`,
      !st.eligible ? `${tick(c.research)} strategy PASSES the test  ${tick(c.days)} ${st.needs.days}+ days  ${tick(c.trades)} ${st.needs.trades}+ trades  ${tick(c.profit)} in profit` : '',
      ``,
      `*You:* practice auto-buy ${st.practiceOn ? '🟢 ON' : '⚪ OFF'} · live auto-buy ${st.liveOn ? '🟢 ON' : '⚪ OFF'}`,
      st.lastRun ? `_Last check ${st.lastRun.date}: ${st.lastRun.buys.length ? st.lastRun.buys.map(x => x.coin).join(', ') : 'no buy signals'}${st.lastRun.regimeUp === false ? ' (BTC below its 100-day average)' : ''}_` : '',
    ];
    const kb = [[st.practiceOn ? { text: '⏸ Practice auto-buy off', callback_data: 'autobuy off' } : { text: '🟢 Practice auto-buy on', callback_data: 'autobuy on' }]];
    if (st.unlocked) kb.push([st.liveOn ? { text: '⏸ Live auto-buy off', callback_data: 'autobuy live off' } : { text: '💰 Live auto-buy on', callback_data: 'autobuy live on' }]);
    kb.push([{ text: '🎮 My practice account', callback_data: 'practice' }]);
    if (isAdmin(chatId)) lines.push('', `_Admin: \`autobuy run\` · \`autobuy pause\`/\`resume\` · \`autobuy unlock\`/\`lock\`_`);
    await send(chatId, lines.filter(x => x !== '').join('\n'), { inline_keyboard: kb });
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof autoBuyer.AutoBuyError ? err.message : `Auto-buy error: ${esc(err.message)}`}`);
  }
}

// ─── Practice mode ────────────────────────────────────────────────────────────
const usd = (n) => n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pm = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${usd(n)}`;
const signed = (n, suffix = '') => n == null ? '—' : `${n >= 0 ? '+' : ''}${n}${suffix}`;
const PRACTICE_BUTTONS = { inline_keyboard: [
  [{ text: '📊 Refresh', callback_data: 'practice' }, { text: '❓ How to buy', callback_data: 'practice help' }],
  [{ text: '🤖 Auto-buy (bot picks the coins)', callback_data: 'autobuy' }],
  [{ text: '🚀 Ready for real money? Go live', callback_data: 'golive' }],
  [{ text: '↺ Start again with $10,000', callback_data: 'practice reset' }],
] };

async function handlePractice(chatId, args) {
  const sub = (args[0] || '').toLowerCase();
  try {
    if (sub === 'buy') {
      // practice buy SOL 100 [sl 88] [2x|25%]
      const rest = args.slice(1);
      const coin = rest[0];
      const amount = parseFloat(String(rest[1] || '').replace(/[$,]/g, ''));
      let stop = null, target = null;
      for (let i = 2; i < rest.length; i++) {
        const t = rest[i].toLowerCase();
        if ((t === 'sl' || t === 'stop') && rest[i + 1]) { stop = parseFloat(rest[++i]); continue; }
        if (/^\d+(\.\d+)?(x|%)$/.test(t)) target = t;
      }
      const { position: p, cash } = await practice.buy(chatId, { symbol: coin, amount, stop, target });
      const t = p.takeProfits;
      await reply(chatId, [
        `🎮 *Practice buy — ${p.symbol.replace('USDT', '')}*`,
        ``,
        `Spent ${usd(p.cost)} → ${+p.quantity.toFixed(8)} ${p.symbol.replace('USDT', '')} at $${fmtP(p.buyPrice)}`,
        `_(live Binance price $${fmtP(p.livePriceAtBuy)} + slippage, fee ${usd(p.fees)})_`,
        ``,
        p.stopLossPrice ? `🛡 Stop: $${fmtP(p.stopLossPrice)}` : `⚠️ No stop — couldn't build a plan for this coin`,
        t?.tp1 ? `🟢 TP1 $${fmtP(t.tp1.price)} (sell 40%) · TP2 $${fmtP(t.tp2.price)} (35%) · TP3 $${fmtP(t.tp3.price)} (rest)` : '',
        p.targetPrice ? `🎯 Your target: $${fmtP(p.targetPrice)} (sell 60%)` : '',
        ``,
        `The bot handles every exit automatically, exactly like live mode, and messages you here.`,
        `💵 Practice cash left: ${usd(cash)}`,
      ].filter(Boolean).join('\n'));
      return;
    }

    if (sub === 'sell' && args[1]) {
      const { trades, cash } = await practice.sellNow(chatId, { symbol: args[1] });
      const lines = trades.filter(Boolean).map(t => `${t.symbol.replace('USDT', '')}: ${pm(t.pnlDollar)} (${signed(t.pnlPct, '%')}) after ${usd(t.fees)} fees`);
      await reply(chatId, [`🎮 *Practice — sold*`, ...lines, ``, `💵 Practice cash: ${usd(cash)}`].join('\n'));
      return;
    }

    if (sub === 'reset') {
      if ((args[1] || '').toLowerCase() !== 'confirm') {
        await send(chatId, `↺ Start again with $10,000? Your practice positions and practice history are cleared. (Real positions aren't touched.)`,
          { inline_keyboard: [[{ text: 'Yes, start again', callback_data: 'practice reset confirm' }]] });
        return;
      }
      await practice.reset(chatId);
      await reply(chatId, `🎮 Practice account reset — you have $10,000 of play money again.`);
      return;
    }

    if (sub === 'help') {
      await send(chatId, [
        `🎮 *How practice mode works*`,
        ``,
        `You get *$10,000 of play money*. Buy any Binance coin with it:`,
        `\`practice buy SOL 100\` — spend $100 on SOL`,
        `\`practice buy PEPE 50 2x\` — with your own 2x target`,
        `\`practice buy SOL 100 sl 140\` — with your own stop`,
        `\`practice sell SOL\` — sell it now at the live price`,
        ``,
        `*It's priced like the real thing:* live Binance prices, Binance's 0.1% fee on every buy and sell, a little slippage, and stops that trigger on any dip (and fill lower if the price jumps past them).`,
        `The bot sells for you at the stop and take-profits, exactly as automated exits do with real money. So your practice result is close to what real money would have done.`,
        ``,
        `_Measured so far, this strategy has lost money after fees in backtests. Practise first and see for yourself before using real money._`,
      ].join('\n'), PRACTICE_BUTTONS);
      return;
    }

    // Status
    const s = await practice.summary(chatId);
    const lines = [
      `🎮 *Practice account* — play money, real Binance prices`,
      ``,
      `💰 *Total value:* ${usd(s.equity)}  (${pm(s.returnUsd)} · ${signed(s.returnPct, '%')} since start)`,
      `💵 Cash: ${usd(s.cash)}`,
    ];
    if (s.positions.length) {
      lines.push(``, `*Open:*`);
      for (const p of s.positions) {
        lines.push(`• ${p.coin}: ${usd(p.value)} · ${signed(p.pnlPct, '%')}${p.stopLossPrice ? ` · stop $${fmtP(p.stopLossPrice)}` : ''}${p.tp1Hit ? ' · TP1 ✅' : ''}${p.tp2Hit ? ' TP2 ✅' : ''}`);
      }
    }
    if (s.stats) {
      lines.push(``, `*Closed trades:* ${s.stats.trades} · win rate ${s.stats.winRate}% · P&L ${usd(s.stats.pnlUsd)} (fees paid ${usd(s.stats.fees)})`);
    }
    if (!s.positions.length && !s.stats) lines.push(``, `No trades yet. Try: \`practice buy SOL 100\``);
    await send(chatId, lines.join('\n'), PRACTICE_BUTTONS);
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof practice.PracticeError ? err.message : `Practice error: ${esc(err.message)}`}`);
  }
}

const fmtP = (p) => (p == null ? '—' : p >= 1 ? Number(p).toFixed(4) : Number(p).toPrecision(4));

// ─── Go live: step-by-step Binance set-up with buttons ───────────────────────
const wizardKey = (chatId) => `cryptobot:wizard:${chatId}`;
const next = (label, data) => ({ inline_keyboard: [[{ text: label, callback_data: data }], [{ text: '✕ Stop for now', callback_data: 'golive cancel' }]] });

async function handleGoLive(chatId, args) {
  const step = (args[0] || '').toLowerCase();

  if (step === 'cancel') {
    await store.cmd('DEL', wizardKey(chatId));
    await reply(chatId, `👍 Stopped. Send \`golive\` any time to continue. Meanwhile you can keep practising: \`practice\`.`);
    return;
  }

  if (!box.isConfigured()) {
    await reply(chatId, `⚠️ Live trading isn't switched on for this bot yet. Practise in the meantime: \`practice\`.`);
    return;
  }

  if (step === '' || step === 'start') {
    const st = await accounts.getStatus(chatId);
    if (st.connected && !st.testnet) {
      const buyingOn = (await autoBuyer.userStatus(chatId)).liveOn;
      const on = st.enabled && buyingOn;
      await send(chatId, `✅ Your real Binance account is connected (key ${st.keyHint}).\nAuto-trading: ${on ? '🟢 ON — the bot buys and sells' : st.enabled ? '🟡 selling only (stops and take-profits)' : '⚪ OFF'}.`,
        { inline_keyboard: [[on ? { text: '⏸ Turn off auto-trading', callback_data: 'golive off' } : { text: '🤖 Turn on auto-trading', callback_data: 'golive on' }], [{ text: '💰 My balance', callback_data: 'balance' }]] });
      return;
    }
    let practiceLine = `💡 *Tip:* practise first with play money — \`practice\`.`;
    try {
      const s = await practice.summary(chatId);
      if (s.stats) practiceLine = `🎮 Your practice so far: ${s.stats.trades} closed trades, ${signed(s.returnPct, '%')} overall.`;
    } catch { /* ignore */ }
    await send(chatId, [
      `🚀 *Go live — 4 short steps*`,
      ``,
      `1. A Binance account`,
      `2. Money in it (USDT, bought with Naira)`,
      `3. A "key" that lets the bot sell for you — it can *never* withdraw your money`,
      `4. Paste the key here`,
      ``,
      `Your money stays in *your own* Binance account the whole time. The bot only places sell orders (stops and take-profits) for positions you add.`,
      ``,
      practiceLine,
      `⚠️ Real money can be lost. In backtests this strategy has lost money after fees.`,
    ].join('\n'), next('Start step 1 →', 'golive 1'));
    return;
  }

  if (step === '1') {
    await send(chatId, [
      `*Step 1 of 4 — Binance account*`,
      ``,
      `1. Install the *Binance* app (Play Store / App Store) or go to binance.com`,
      `2. Sign up with your email or phone number`,
      `3. Complete *identity verification* (photo of your NIN slip, ID card or passport + a selfie). It usually takes a few minutes.`,
      ``,
      `Already have a verified account? Tap Done.`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open Binance', url: 'https://www.binance.com/en/register' }],
      [{ text: '✅ Done — next step', callback_data: 'golive 2' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '2') {
    await send(chatId, [
      `*Step 2 of 4 — Add money (Naira → USDT)*`,
      ``,
      `In the Binance app: *Trade → P2P → Buy → USDT*, payment *Bank transfer*, currency *NGN*.`,
      `1. Pick a seller with a ✔ badge and a high completion rate`,
      `2. Enter the amount, then pay the seller from your bank app *exactly* as shown`,
      `3. Tap *Transferred, notify seller* — only after you've actually paid`,
      `4. The seller releases the USDT to you`,
      ``,
      `⚠️ *Important:* P2P coins arrive in your *Funding* wallet. Move them to *Spot*: Assets → Funding → Transfer → Funding to Spot. The bot can only see your Spot wallet.`,
      `Never send money outside the Binance P2P screen, and never share your password or codes with anyone.`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open Binance P2P (NGN)', url: 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=NGN' }],
      [{ text: '✅ Done — next step', callback_data: 'golive 3' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '3') {
    await send(chatId, [
      `*Step 3 of 4 — Create the key for the bot*`,
      ``,
      `Easiest on binance.com (phone browser or computer):`,
      `1. Tap your *profile icon → Account → API Management*`,
      `2. *Create API* → choose *System generated* → name it \`JijazyBot\` → confirm with your codes`,
      `3. Tap *Edit restrictions*:`,
      `   • IP access: choose *Restrict access to trusted IPs only*`,
      ...(tradingIps().length
        ? [
          ...tradingIps().map((ip, k) => `   • Paste IP ${k + 1}: \`${ip}\` → tap *Confirm*`),
          `     _(tap an IP above to copy it. Add them ONE AT A TIME — no commas. You need ${tradingIps().length === 1 ? 'it' : `all ${tradingIps().length}`}: with one missing, about half the bot's orders would be rejected.)_`,
        ]
        : [`     _(the bot's IP addresses aren't set up yet — ask the admin)_`]),
      `   • Check ${tradingIps().length > 1 ? 'both IPs show' : 'the IP shows'} in the list, then ✅ tick *Enable Spot & Margin Trading*`,
      `   • leave ❌ *Enable Withdrawals* OFF (the bot refuses keys that can withdraw)`,
      `4. *Save*. You'll see two codes: *API Key* and *Secret Key*. Copy both — the Secret Key is shown only once.`,
      ``,
      `_Binance only allows trading on keys locked to fixed IPs. These are the bot's own addresses, so only the bot can use your key._`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open API Management', url: 'https://www.binance.com/en/my/settings/api-management' }],
      [{ text: '✅ I have both codes', callback_data: 'golive 4' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '4') {
    await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'key' }), 'EX', 900);
    await reply(chatId, [
      `*Step 4 of 4 — Paste the codes*`,
      ``,
      `Paste your *API Key* (the first code) and send it as a message.`,
      `_I'll delete it from this chat straight away and store it encrypted._`,
    ].join('\n'));
    return;
  }

  if (step === 'off') {
    await autoBuyer.setLive(chatId, false).catch(() => {});
    await accounts.setEnabled(chatId, false).catch(() => {});
    const n = await autoTrader.cancelAll(chatId);
    await reply(chatId, `⏸ *Auto-trading OFF.* No buying or selling by the bot${n ? `; ${n} stop order${n === 1 ? '' : 's'} cancelled on Binance` : ''}. Your coins stay in your account. Alerts carry on as normal.`);
    return;
  }

  if (step === 'on') {
    const st = await accounts.getStatus(chatId);
    if (!st.connected) { await handleGoLive(chatId, ['4']); return; }
    const open = await autoBuyer.isLiveUnlocked();
    if ((args[1] || '').toLowerCase() !== 'confirm') {
      await send(chatId, [
        `⚠️ *Last check — real money*`,
        ``,
        `With auto-trading on, the bot works on *your Binance account*:`,
        open ? `🛒 *Buys:* once a day it may buy coins with your USDT — about 1% of the account at risk per trade, no coin above 20%, at most 5 at once.`
          : `🛒 *Buys:* not open yet — the admin opens buying once the strategy has proven itself. Until then the bot only sells.`,
        `🛡 *Sells:* a stop order on Binance for every position, and sales at take-profits / the trailing stop.`,
        open ? await forwardWarning() : '',
        `It can't withdraw. Turn it off any time with \`golive off\`.`,
        ``,
        `Losses are possible. Turn it on?`,
      ].filter(Boolean).join('\n'), { inline_keyboard: [
        [{ text: '✅ Yes, I understand — turn on', callback_data: 'golive on confirm' }],
        [{ text: 'Not now', callback_data: 'golive cancel' }],
      ] });
      return;
    }
    try {
      await accounts.setEnabled(chatId, true, { confirmLive: accounts.LIVE_CONFIRM });
      let buying = false;
      if (open) { await autoBuyer.setLive(chatId, true); buying = true; }
      await reply(chatId, [
        `🟢 *Auto-trading is ON*`,
        ``,
        buying ? `🛒 The bot checks the market once a day (just after 1am Lagos time) and buys the coins that signal, then manages the exits. You'll get a message for every buy, every sale, and your profit for the day.`
          : isAdmin(chatId) ? `🛡 Selling is on. Buying isn't open yet — send \`autobuy unlock\` to open it (you'll see what the forward test still needs), then \`autobuy live on\`.`
          : `🛡 Selling is on. Buying opens once the admin switches it on — you'll be able to turn it on from \`autobuy\`.`,
        `💰 Check your money any time: \`balance\``,
      ].join('\n'));
      await autoTrader.syncUser(chatId);
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError || err instanceof autoBuyer.AutoBuyError ? err.message : esc(err.message)}`);
    }
    return;
  }

  await handleGoLive(chatId, []);
}

/** A message that looks like a key arrived. Returns true if the wizard used it. */
async function handleWizardKey(chatId, value, meta) {
  const raw = await store.cmd('GET', wizardKey(chatId));
  if (!raw) return false;
  let st; try { st = JSON.parse(raw); } catch { return false; }
  if (meta.messageId) await tg.call('deleteMessage', { chat_id: chatId, message_id: meta.messageId }).catch(() => {});

  if (st.step === 'key') {
    await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'secret', key: box.encrypt(value) }), 'EX', 900);
    await reply(chatId, `✅ Got the API Key (deleted from the chat).\n\nNow paste the *Secret Key* (the second code).`);
    return true;
  }
  if (st.step === 'secret') {
    const apiKey = box.decrypt(st.key);
    if (apiKey === value) { await reply(chatId, `That's the API Key again — please paste the *Secret Key* (the second code).`); return true; }
    await reply(chatId, `⏳ Checking with Binance…`);
    try {
      await accounts.connect(chatId, { apiKey, apiSecret: value, live: true });
      await store.cmd('DEL', wizardKey(chatId));
      let balance = '';
      try {
        const c = await accounts.getAnyClient(chatId);
        const usdt = await c.freeBalance('USDT');
        balance = `\n💵 USDT in your Spot wallet: ${usdt.toFixed(2)}${usdt < 10 ? '\n⚠️ That\'s very little — remember to move USDT from Funding to Spot (step 2).' : ''}`;
      } catch { /* balance is just a nice-to-have */ }
      await send(chatId, `🔐 *Binance connected!* Key ${'…' + apiKey.slice(-4)}, withdrawals blocked.${balance}\n\nLast step: turn on auto-trading — the bot buys and sells for you.`,
        { inline_keyboard: [[{ text: '🤖 Turn on auto-trading', callback_data: 'golive on' }]] });
    } catch (err) {
      await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'key' }), 'EX', 900);
      const why = err instanceof accounts.TradingError ? err.message : err.message;
      await reply(chatId, `❌ ${esc(why)}\n\nLet's try again: paste your *API Key* (the first code). Or send \`golive 3\` to see how to create the key.`);
    }
    return true;
  }
  return false;
}

// ─── Paid access: subscribe / check / status ─────────────────────────────────
async function handleSubscribe(chatId, args) {
  const sub = (args[0] || '').toLowerCase();
  const fmtDate = (iso) => new Date(iso).toUTCString();

  if (sub === 'check') {
    const s = await subs.getSub(chatId);
    if (s.lastRef) {
      try {
        const r = await subs.confirmPayment(s.lastRef);
        if (r.credited) { await subs.notifyCredited(r); return; }
        if (!r.already && !s.active) {
          await reply(chatId, `⏳ Paystack hasn't confirmed your payment yet (${esc(r.reason || 'pending')}). If you've paid, send \`subscribe check\` again in a minute.`);
          return;
        }
      } catch (err) {
        await reply(chatId, `⚠️ Couldn't check with Paystack right now: ${esc(err.message)}`);
        return;
      }
    }
    return handleSubscribe(chatId, ['status']);
  }

  if (sub === 'status' || (!sub && !subs.enabled())) {
    const st = await subs.status(chatId);
    await reply(chatId, [
      `💳 *Your account*`,
      ``,
      !st.required ? (st.isAdmin ? `👑 Admin — free access.` : `✅ Access is free on this bot right now.`)
        : st.active ? `🟢 Active until *${fmtDate(st.paidUntil)}* (${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left)`
        : st.paidUntil ? `🔒 Ended on ${fmtDate(st.paidUntil)}` : `🔒 No subscription yet`,
      st.required ? `` : '',
      st.required ? `Price: ${st.price}` : '',
      st.required ? `Renew any time with \`subscribe\` — time is added to what you have left.` : '',
    ].filter(x => x !== '').join('\n'));
    return;
  }

  if (!subs.enabled()) { await reply(chatId, `✅ Access is free on this bot right now — nothing to pay.`); return; }
  if (isAdmin(chatId)) { await reply(chatId, `👑 You're the admin — you never pay.`); return; }

  try {
    const link = await subs.startCheckout(chatId, { email: args[0], callbackUrl: `${baseUrl()}/paid` });
    await send(chatId, [
      `💳 *Subscribe — ${link.price}*`,
      ``,
      `Tap the button to pay securely with Paystack (card, bank transfer or USSD).`,
      `When it's done you'll be brought back here and your access starts straight away.`,
      ``,
      `_Paid but nothing happened? Send_ \`subscribe check\`.`,
    ].join('\n'), { inline_keyboard: [[{ text: `💳 Pay ${link.price}`, url: link.url }]] });
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof subs.PaymentError ? err.message : `Couldn't start the payment: ${esc(err.message)}`}`);
  }
}

// ─── Automated exits: connect / on / off / status ────────────────────────────
async function handleAutotrade(chatId, args, meta = {}) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'connect') {
    // The message holds an API secret: delete it from the chat first
    if (meta.messageId) await tg.call('deleteMessage', { chat_id: chatId, message_id: meta.messageId }).catch(() => {});
    const live = (args[1] || '').toLowerCase() === 'live';
    const [apiKey, apiSecret] = live ? args.slice(2) : args.slice(1);
    if (!apiKey || !apiSecret) {
      await reply(chatId, [
        `❌ *Format:* \`autotrade connect API_KEY API_SECRET\` (test mode)`,
        `or \`autotrade connect live API_KEY API_SECRET\` (real money)`,
        ``,
        `_I deleted your message so the keys don't stay in this chat._`,
      ].join('\n'));
      return;
    }
    try {
      const s = await accounts.connect(chatId, { apiKey, apiSecret, live });
      await reply(chatId, [
        `🔐 *Binance ${s.testnet ? 'TESTNET (fake money)' : 'LIVE (real money)'} connected* — key ${s.keyHint}`,
        `_I deleted your message; the keys are stored encrypted._`,
        ``,
        `Auto-exits are still *OFF*. Turn them on with:`,
        s.testnet ? `\`autotrade on\`` : `\`autotrade on ${accounts.LIVE_CONFIRM}\``,
      ].join('\n'));
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : `Couldn't connect: ${err.message}`}\n\n_I deleted your message so the keys don't stay in this chat._`);
    }
    return;
  }

  try {
    if (sub === 'on') {
      const s = await accounts.setEnabled(chatId, true, { confirmLive: args.slice(1).join(' ') });
      await reply(chatId, [
        `🤖 *Auto-exits ON* — Binance ${s.testnet ? 'testnet (fake money)' : '*LIVE (real money)*'}${s.dryRun ? ' — DRY RUN, no real orders' : ''}`,
        ``,
        `For each Binance position that has a quantity, the bot now:`,
        `  🛡 keeps a stop order on Binance at your saved stop`,
        `  🟢 sells 40% at TP1, 35% at TP2 and the rest at TP3`,
        `  🎯 sells 60% at your own target`,
        `  🔴 sells the rest if the stop is hit`,
        `It never buys. \`sell SOL\` or Remove cancels the stop order without selling.`,
        ``,
        `⏳ Placing your stop orders now…`,
      ].join('\n'));
      const results = await autoTrader.syncUser(chatId);
      if (!results.length) await reply(chatId, `ℹ️ No eligible positions yet. Add one with a quantity on Binance, e.g. \`buy SOL 92.50 2\`.`);
      return;
    }

    if (sub === 'off') {
      await accounts.setEnabled(chatId, false);
      const n = await autoTrader.cancelAll(chatId);
      await reply(chatId, `⏸ *Auto-exits OFF.* ${n ? `Cancelled ${n} stop order${n === 1 ? '' : 's'} on Binance.` : ''} Your alerts carry on as before — you sell by hand.`);
      return;
    }

    if (sub === 'disconnect') {
      const n = await autoTrader.cancelAll(chatId);
      await accounts.removeKeys(chatId);
      await reply(chatId, `🔓 *Binance disconnected.* Keys deleted${n ? `, ${n} stop order${n === 1 ? '' : 's'} cancelled` : ''}. You can also delete the API key on Binance.`);
      return;
    }

    if (sub === 'resume' && args[1]) {
      const entries = await getPositionsBySymbol(chatId, normaliseSymbol(args[1]));
      for (const p of entries) await autoTrader.resume(chatId, p.positionId);
      await reply(chatId, entries.length ? `▶️ Auto-exits resumed for ${entries[0].symbol}.` : `⚠️ No ${normaliseSymbol(args[1])} positions.`);
      return;
    }
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : err.message}`);
    return;
  }

  // Status + how-to
  const s = await accounts.getStatus(chatId);
  await reply(chatId, [
    `🤖 *Automated exits*`,
    ``,
    !s.encryptionReady ? `⚠️ Not set up on this bot yet (admin: add TRADING_ENCRYPTION_KEY in Vercel).` : '',
    s.connected
      ? `Account: Binance ${s.testnet ? 'testnet (fake money)' : '*LIVE (real money)*'} · key ${s.keyHint}\nStatus: ${s.enabled ? '🟢 ON' : '⚪ OFF'}${s.dryRun ? ' · DRY RUN' : ''}`
      : `Status: not connected`,
    s.lastError ? `Last problem: _${esc(s.lastError)}_` : '',
    ``,
    `*What it does:* sells for you on Binance at your stop and take-profits. It *never buys* and can't withdraw.`,
    ``,
    `*Set up (test mode first):*`,
    `1. Get free testnet keys at https://testnet.binance.vision (log in with GitHub → Generate HMAC key)`,
    `2. Send \`autotrade connect API_KEY API_SECRET\``,
    `3. Send \`autotrade on\``,
    ``,
    `*Real money:* create a Binance API key with *Spot trading ON and withdrawals OFF* (keys that can withdraw are refused), then \`autotrade connect live KEY SECRET\` and \`autotrade on ${accounts.LIVE_CONFIRM}\`.`,
    ``,
    `\`autotrade off\` — stop (cancels the bot's stop orders)`,
    `\`autotrade disconnect\` — delete your keys`,
  ].filter(Boolean).join('\n'));
}

// ─── Process one Telegram update ─────────────────────────────────────────────
async function handleUpdate(body) {
  // ── Button taps ─────────────────────────────────────────────────────────
  if (body.callback_query) {
    const cq     = body.callback_query;
    const chatId = cq.message?.chat?.id?.toString();
    const data   = cq.data || '';

    await answerCallback(cq.id);
    if (!chatId) return;

    // Tapping a button in the main menu removes the menu message (keeps the chat tidy)
    if (cq.message?.message_id && /^(📋 Menu|What would you like to do\?)/.test(cq.message.text || '')) {
      await tg.call('deleteMessage', { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    }

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const [action, targetId] = data.split(':');
      await handleApproval(action, targetId, chatId);
      return;
    }

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
      setstop_help: 'setstop_guide',
      check_help:  'check_guide',
      profit:      'profit',
      manual:      'manual',
    };
    await handleMessage(chatId, commandMap[data] || data, cq.from);
    return;
  }

  // ── Regular messages ────────────────────────────────────────────────────
  const { message } = body;
  if (!message || !message.text) return;
  const chatId = message.chat?.id?.toString();
  // Never log API keys (`autotrade connect …`, or a key pasted into the go-live wizard)
  const looksSecret = /[A-Za-z0-9]{32,}/.test(message.text) || /^\/?auto(trade|exits?)(@\w+)?\s+connect/i.test(message.text.trim());
  const logText = looksSecret ? '[message with a key — not logged]' : message.text.slice(0, 80);
  console.log(`[Webhook] From ${chatId}: ${logText}`);
  await handleMessage(chatId, message.text, message.from, { messageId: message.message_id });
}

/** Telegram re-sends an update if we're slow; process each update_id once. */
async function firstTimeSeen(updateId) {
  if (updateId === undefined || updateId === null) return true;
  try {
    return (await store.cmd('SET', `cryptobot:tgupdate:${updateId}`, '1', 'NX', 'EX', 3600)) === 'OK';
  } catch {
    return true; // storage down: better to risk a duplicate than drop the message
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  if (!verifyTelegramWebhook(req)) {
    console.warn('[Webhook] Rejected request without valid secret token');
    return res.status(401).json({ ok: false });
  }

  const body = req.body || {};
  if (!(await firstTimeSeen(body.update_id))) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  const work = handleUpdate(body).catch(err => console.error('[Webhook] Error:', err.stack || err.message));

  // On Vercel: reply to Telegram immediately and keep working in the background,
  // so slow commands (scan, newlistings, split) never time out or get re-sent.
  if (deferUntilAfterResponse(work)) return res.status(200).json({ ok: true });

  await work;
  return res.status(200).json({ ok: true });
};
