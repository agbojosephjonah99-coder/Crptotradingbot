/**
 * ─── Telegram Webhook Handler (Fixed) ────────────────────────────────────────
 * POST /api/telegram-webhook
 *
 * FIX: Process message and send reply BEFORE calling res.end()
 * Previous version killed the function before reply could complete.
 */

const axios  = require('axios');
const { addPosition, removePosition, getAllPositions, getPosition } = require('../src/services/positionStore');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Send reply ───────────────────────────────────────────────────────────────
async function reply(chatId, text) {
  if (!BOT_TOKEN) {
    console.error('[Webhook] BOT_TOKEN not set');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
    console.log(`[Webhook] Reply sent to ${chatId}`);
  } catch (e) {
    console.error('[Webhook] Reply failed:', e.message);
  }
}

// ─── Normalise symbol ─────────────────────────────────────────────────────────
function normaliseSymbol(raw) {
  const u = raw.toUpperCase().trim();
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleMessage(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  // ── HELP ──────────────────────────────────────────────────────────────────
  if (cmd === 'help' || cmd === '/start' || cmd === '/help') {
    await reply(chatId, [
      `🤖 *CryptoBot V2 Commands*`,
      ``,
      `*Register a buy:*`,
      `\`buy SOLUSDT 92.50\``,
      `\`buy SOL 92.50\``,
      `\`buy SOL 92.50 10\` _(with quantity)_`,
      ``,
      `*Remove after you sell:*`,
      `\`sell SOLUSDT\``,
      ``,
      `*View all open positions:*`,
      `\`positions\``,
      ``,
      `*Get instant advice:*`,
      `\`check SOLUSDT\``,
      ``,
      `*Automatic alerts every hour:*`,
      `🔴 Stop Loss hit → exit now`,
      `🎯 Take Profit → sell partial`,
      `🟡 Trail stop → protect gains`,
      `⚪ Hold → stay in trade`,
    ].join('\n'));
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
        `Correct usage:`,
        `\`buy SOL 92.50\``,
        `\`buy SOLUSDT 92.50\``,
        `\`buy SOL 92.50 10\` _(10 units)_`,
      ].join('\n'));
      return;
    }

    const symbol   = normaliseSymbol(rawSymbol);
    const position = await addPosition({ symbol, buyPrice, quantity });

    await reply(chatId, [
      `✅ *Position Registered — ${symbol}*`,
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      quantity ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      ``,
      `The bot will monitor this every hour and alert you when to:`,
      `  • 🔴 Exit (stop loss hit)`,
      `  • 🎯 Take profit (TP1 / TP2 / TP3)`,
      `  • 🟡 Tighten stop (overbought)`,
      `  • ⚪ Hold (trend still healthy)`,
      ``,
      `To remove when you exit: \`sell ${symbol}\``,
      `For instant check: \`check ${symbol}\``,
    ].filter(Boolean).join('\n'));
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  if (cmd === 'sell' || cmd === 'remove' || cmd === 'sold') {
    const rawSymbol = parts[1];
    if (!rawSymbol) {
      await reply(chatId, `❌ Specify a coin: \`sell SOLUSDT\``);
      return;
    }
    const symbol  = normaliseSymbol(rawSymbol);
    const removed = await removePosition(symbol);

    await reply(chatId, removed
      ? `✅ *${symbol}* removed from positions. Good trade! 💸`
      : `⚠️ *${symbol}* not found in your open positions.`
    );
    return;
  }

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  if (cmd === 'positions' || cmd === 'pos' || cmd === 'portfolio') {
    const all     = await getAllPositions();
    const entries = Object.values(all);

    if (entries.length === 0) {
      await reply(chatId, [
        `📭 *No open positions*`,
        ``,
        `To add one: \`buy SOL 92.50\``,
      ].join('\n'));
      return;
    }

    const lines = [`📊 *Your Open Positions*`, ``];
    for (const pos of entries) {
      lines.push(`*${pos.symbol}*`);
      lines.push(`  Entry: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      lines.push(`  Status: ${pos.lastRecommendation || 'Pending first check'}`);
      lines.push(`  Last checked: ${pos.lastChecked ? new Date(pos.lastChecked).toUTCString() : 'Not yet'}`);
      lines.push(``);
    }
    lines.push(`_Monitored every hour automatically_`);
    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── CHECK ─────────────────────────────────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) {
      await reply(chatId, `❌ Specify a coin: \`check SOLUSDT\``);
      return;
    }
    const symbol = normaliseSymbol(rawSymbol);
    const pos    = await getPosition(symbol);

    if (!pos) {
      await reply(chatId, [
        `⚠️ *${symbol}* not in your positions.`,
        ``,
        `Add it first: \`buy ${symbol} YOUR_BUY_PRICE\``,
      ].join('\n'));
      return;
    }

    await reply(chatId, `🔍 Checking *${symbol}*... give me a moment.`);

    try {
      const adviceModule   = require('./v2advice');
      const { candles1h, candles4h, currentPrice, exchange } = await adviceModule.fetchCurrentData(symbol);
      const advice         = adviceModule.buildAdvice({
        symbol,
        buyPrice:    pos.buyPrice,
        currentPrice,
        candles1h,
        candles4h,
        accountSize: pos.accountSize,
        riskPct:     pos.riskPct,
      });

      const tp1 = advice.tradePlan?.takeProfits?.tp1;
      const tp2 = advice.tradePlan?.takeProfits?.tp2;
      const tp3 = advice.tradePlan?.takeProfits?.tp3;
      const sl  = advice.tradePlan?.stopLoss;

      const emoji = {
        STOP_LOSS: '🔴', TAKE_PROFIT: '🟢',
        TRAIL_STOP: '🟡', CLOSE_PARTIAL: '🟠', HOLD: '⚪',
      }[advice.recommendation] || '⚪';

      const lines = [
        `${emoji} *${advice.recommendation} — ${symbol}*`,
        ``,
        `💰 *Bought at:* \`$${pos.buyPrice}\``,
        `📊 *Now:*       \`$${Number(advice.currentPrice).toFixed(4)}\``,
        `📈 *P&L:*       ${advice.pnlDisplay}`,
        ``,
        `── *What to do* ──`,
        ...(advice.reasons || []).map(r => `  ${r}`),
        ``,
        ...(advice.actions || []).map(a => `  👉 ${a}`),
        ``,
        sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(4)}\`` : '',
        tp1 ? `🎯 *TP1 (40%):* \`$${Number(tp1.price).toFixed(4)}\`` : '',
        tp2 ? `🎯 *TP2 (35%):* \`$${Number(tp2.price).toFixed(4)}\`` : '',
        tp3 ? `🎯 *TP3 (25%):* \`$${Number(tp3.price).toFixed(4)}\`` : '',
        ``,
        `📐 RSI: ${advice.indicators?.rsi || 'N/A'} | Trend: ${advice.indicators?.macroTrend || 'N/A'}`,
        `⏰ ${new Date().toUTCString()}`,
      ].filter(Boolean).join('\n');

      await reply(chatId, lines);

    } catch (err) {
      await reply(chatId, `❌ Could not fetch data for ${symbol}: ${err.message}`);
    }
    return;
  }

  // ── Unknown ───────────────────────────────────────────────────────────────
  await reply(chatId, `❓ Unknown command. Type \`help\` to see all commands.`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const { message } = req.body || {};
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = message.chat?.id?.toString();
    const text   = message.text;

    console.log(`[Webhook] Message from ${chatId}: ${text}`);

    // Security check
    if (CHAT_ID && chatId !== CHAT_ID.toString()) {
      console.warn(`[Webhook] Rejected message from unknown chatId: ${chatId}`);
      return res.status(200).json({ ok: true });
    }

    // FIX: Process message FIRST, then end response
    // Do NOT call res.end() before handleMessage completes
    await handleMessage(chatId, text);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(200).json({ ok: true });
  }
};