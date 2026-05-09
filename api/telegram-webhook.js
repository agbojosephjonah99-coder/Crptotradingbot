/**
 * ─── Telegram Webhook Handler ─────────────────────────────────────────────────
 * POST /api/telegram-webhook
 *
 * SETUP (one time after deploying):
 *  Register your webhook URL with Telegram by visiting this in your browser:
 *  https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://YOUR-VERCEL-URL.vercel.app/api/telegram-webhook
 *
 * COMMANDS:
 *  buy SOLUSDT 92.50          → Register a buy at $92.50
 *  buy SOL 92.50              → Same (auto-adds USDT)
 *  buy SOL 92.50 10           → Buy 10 units at $92.50
 *  sell SOLUSDT               → Remove position (you sold manually)
 *  positions                  → List all open positions
 *  check SOLUSDT              → Get instant advice on one coin
 *  help                       → Show all commands
 */

const { addPosition, removePosition, getAllPositions } = require('../src/services/positionStore');
const { buildAdvice, fetchCurrentData }                = require('./v2advice');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Send reply back to Telegram ─────────────────────────────────────────────
const axios = require('axios');

async function reply(chatId, text) {
  if (!BOT_TOKEN) return;
  await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 10000 }
  ).catch(e => console.error('[Webhook reply]', e.message));
}

// ─── Normalise symbol ─────────────────────────────────────────────────────────
function normaliseSymbol(raw) {
  const u = raw.toUpperCase().trim();
  if (u.endsWith('USDT')) return u;
  return `${u}USDT`;
}

// ─── Command Parser ───────────────────────────────────────────────────────────
async function handleMessage(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  // ── BUY ──────────────────────────────────────────────────────────────────
  if (cmd === 'buy') {
    const rawSymbol = parts[1];
    const buyPrice  = parseFloat(parts[2]);
    const quantity  = parts[3] ? parseFloat(parts[3]) : null;

    if (!rawSymbol || isNaN(buyPrice) || buyPrice <= 0) {
      return reply(chatId, [
        `❌ *Invalid buy command*`,
        ``,
        `Correct format:`,
        `\`buy SOLUSDT 92.50\``,
        `\`buy SOL 92.50\``,
        `\`buy SOL 92.50 10\` _(with quantity)_`,
      ].join('\n'));
    }

    const symbol = normaliseSymbol(rawSymbol);

    // Fetch current price to confirm entry
    let currentPrice = null;
    try {
      const data  = await fetchCurrentData(symbol);
      currentPrice = data.currentPrice;
    } catch {}

    const position = await addPosition({ symbol, buyPrice, quantity });

    const lines = [
      `✅ *Position Registered — ${symbol}*`,
      ``,
      `💰 *Your Buy Price:* \`$${buyPrice}\``,
      currentPrice ? `📊 *Current Price:* \`$${currentPrice.toFixed(4)}\`` : '',
      quantity     ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      ``,
      `The bot will now monitor this position every hour and alert you when to:`,
      `  • 🔴 Exit (stop loss hit)`,
      `  • 🎯 Take profit (TP1 / TP2 / TP3)`,
      `  • 🟡 Tighten stop (overbought)`,
      `  • ⚪ Hold (trend still healthy)`,
      ``,
      `_To remove this position when you sell: type_ \`sell ${symbol}\``,
    ].filter(Boolean).join('\n');

    return reply(chatId, lines);
  }

  // ── SELL / REMOVE ─────────────────────────────────────────────────────────
  if (cmd === 'sell' || cmd === 'remove' || cmd === 'sold') {
    const rawSymbol = parts[1];
    if (!rawSymbol) {
      return reply(chatId, `❌ Specify a coin: \`sell SOLUSDT\``);
    }
    const symbol  = normaliseSymbol(rawSymbol);
    const removed = await removePosition(symbol);

    if (removed) {
      return reply(chatId, `✅ *${symbol}* removed from your positions. Good trade! 💸`);
    } else {
      return reply(chatId, `⚠️ *${symbol}* not found in your open positions.`);
    }
  }

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  if (cmd === 'positions' || cmd === 'pos' || cmd === 'portfolio') {
    const all = await getAllPositions();
    const entries = Object.values(all);

    if (entries.length === 0) {
      return reply(chatId, [
        `📭 *No open positions*`,
        ``,
        `To add one: \`buy SOLUSDT 92.50\``,
      ].join('\n'));
    }

    const lines = [`📊 *Your Open Positions*`, ``];
    for (const pos of entries) {
      lines.push(`*${pos.symbol}*`);
      lines.push(`  Entry: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      lines.push(`  Last check: ${pos.lastChecked ? new Date(pos.lastChecked).toUTCString() : 'Not yet checked'}`);
      lines.push(`  Status: ${pos.lastRecommendation || 'Pending first check'}`);
      lines.push(``);
    }
    lines.push(`_Positions checked every hour automatically._`);

    return reply(chatId, lines.join('\n'));
  }

  // ── CHECK (instant advice on demand) ─────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) {
      return reply(chatId, `❌ Specify a coin: \`check SOLUSDT\``);
    }
    const symbol = normaliseSymbol(rawSymbol);

    // Get from store if exists
    const { getPosition } = require('../src/services/positionStore');
    const pos = await getPosition(symbol);

    if (!pos) {
      return reply(chatId, [
        `⚠️ *${symbol}* not in your positions.`,
        ``,
        `Add it first: \`buy ${symbol} YOUR_BUY_PRICE\``,
      ].join('\n'));
    }

    await reply(chatId, `🔍 Checking ${symbol}... one moment.`);

    try {
      const { candles1h, candles4h, currentPrice, exchange } = await fetchCurrentData(symbol);
      const advice = buildAdvice({
        symbol,
        buyPrice:   pos.buyPrice,
        currentPrice,
        candles1h,
        candles4h,
        accountSize: pos.accountSize,
        riskPct:     pos.riskPct,
      });
      advice.exchange = exchange;

      const { sendPositionAlert } = require('../src/services/telegramService');
      await sendPositionAlert(pos, advice, chatId);
    } catch (err) {
      return reply(chatId, `❌ Could not fetch data for ${symbol}: ${err.message}`);
    }

    return;
  }

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help' || cmd === '/start' || cmd === '/help') {
    return reply(chatId, [
      `🤖 *CryptoBot V2 Commands*`,
      ``,
      `*Register a buy:*`,
      `\`buy SOLUSDT 92.50\``,
      `\`buy SOL 92.50 10\` _(with quantity)_`,
      ``,
      `*Remove a position (after you sell):*`,
      `\`sell SOLUSDT\``,
      ``,
      `*View all open positions:*`,
      `\`positions\``,
      ``,
      `*Get instant advice on a position:*`,
      `\`check SOLUSDT\``,
      ``,
      `*Automatic alerts every hour:*`,
      `🔴 Stop Loss hit → exit now`,
      `🎯 Take Profit → sell partial`,
      `🟡 Trail stop → protect gains`,
      `⚪ Hold → all good, stay in`,
    ].join('\n'));
  }

  // ── Unknown command ───────────────────────────────────────────────────────
  return reply(chatId, `❓ Unknown command. Type \`help\` to see all commands.`);
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Telegram sends POST requests
  if (req.method !== 'POST') return res.status(200).end();

  try {
    const { message } = req.body || {};
    if (!message || !message.text) return res.status(200).end();

    const chatId = message.chat?.id?.toString();
    const text   = message.text;

    // Security — only respond to your own chat ID
    if (CHAT_ID && chatId !== CHAT_ID.toString()) {
      console.warn(`[Webhook] Rejected message from unknown chatId: ${chatId}`);
      return res.status(200).end();
    }

    // Handle async — Telegram expects 200 quickly
    res.status(200).end();
    await handleMessage(chatId, text);

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    res.status(200).end(); // Always 200 to Telegram
  }
};