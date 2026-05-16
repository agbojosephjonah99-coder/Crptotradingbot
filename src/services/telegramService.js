/**
 * ─── Telegram Alert Service ───────────────────────────────────────────────────
 *
 * TWO-CHANNEL SYSTEM:
 *
 *  ACTION channel  → TELEGRAM_CHAT_ID (your private bot chat)
 *    • BUY signals from scanner (v2scan / liveService)
 *    • New listing BUY signals
 *    • Bearish alerts
 *    • Stop loss, TP1/TP2/TP3, custom target hit (from v2monitor)
 *    • Big milestones: 50%, 100%, 150%...
 *
 *  INFO channel    → TELEGRAM_INFO_CHANNEL_ID (quiet Telegram channel)
 *    • 10%, 20%, 30%, 40% milestones
 *    • HOLD updates every 4 hours
 *    • New listing info alerts (v2listings-alert)
 *
 *  If TELEGRAM_INFO_CHANNEL_ID is not set, info alerts fall back to main chat.
 */

const axios = require('axios');
const { isDuplicateSignal, markSignalFired } = require('./riskService');

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ACTION_CHAT  = process.env.TELEGRAM_CHAT_ID;          // main private chat
const INFO_CHANNEL = process.env.TELEGRAM_INFO_CHANNEL_ID;  // quiet info channel

// ─── Core send helpers ────────────────────────────────────────────────────────

// Send to the ACTION channel (main chat) — requires immediate attention
async function sendAction(text, overrideChatId) {
  const chatId = overrideChatId || ACTION_CHAT;
  if (!BOT_TOKEN || !chatId) {
    console.warn('[Telegram] Missing credentials — skipping action alert');
    return;
  }
  const resp = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 10000 }
  );
  if (!resp.data.ok) throw new Error(`Telegram error: ${JSON.stringify(resp.data)}`);
  return resp.data;
}

// Send to the INFO channel — low priority, no action needed
async function sendInfo(text, overrideChatId) {
  const chatId = overrideChatId || INFO_CHANNEL || ACTION_CHAT; // fallback to main if not set
  if (!BOT_TOKEN || !chatId) {
    console.warn('[Telegram] Missing credentials — skipping info alert');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error('[Telegram] Info send failed:', e.message);
  }
}

// Legacy alias — used by old code that calls _send() directly
async function _send(text) { return sendAction(text); }

// ─── BUY Signal (v2scan / liveService) → CHANNEL ────────────────────────────
// Scanner signals are market-wide, not personal trades.
// They go to the channel so your main chat stays focused on your own positions.
async function sendBuyAlert(result) {
  if (result.signal !== 'BUY') return;
  if (result.score < 7) return;
  if (isDuplicateSignal(result.symbol, 'BUY')) {
    console.log(`[Telegram] Dedup: ${result.symbol} BUY already sent within 4h`);
    return;
  }

  const tp1     = result.takeProfits?.tp1;
  const tp2     = result.takeProfits?.tp2;
  const tp3     = result.takeProfits?.tp3;
  const sl      = result.stopLoss;
  const rr      = result.riskReward;
  const conf    = result.confidence;
  const confBar = '█'.repeat(Math.round(conf / 10)) + '░'.repeat(10 - Math.round(conf / 10));

  const lines = [
    `🟢 *BUY SIGNAL — ${result.symbol}*`,
    ``,
    `💰 *Entry:*    \`$${Number(result.price).toFixed(4)}\``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(4)}\` _(1.5x ATR)_` : '',
    ``,
    tp1 ? `🎯 *TP1 (sell 40%):* \`$${Number(tp1.price).toFixed(4)}\` — ${tp1.ratio}` : '',
    tp2 ? `🎯 *TP2 (sell 35%):* \`$${Number(tp2.price).toFixed(4)}\` — ${tp2.ratio}` : '',
    tp3 ? `🎯 *TP3 (sell 25%):* \`$${Number(tp3.price).toFixed(4)}\` — ${tp3.ratio}` : '',
    rr  ? `⚖️ *Risk:Reward:* ${rr}:1` : '',
    ``,
    `📊 *Confidence:* ${conf}% |${confBar}|`,
    `📈 *Score:* ${result.score}/15`,
    ``,
    `🔍 *Why:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    ``,
    `⚠️ *After TP1 → move stop to breakeven*`,
    `📝 Quick buy: \`buy ${result.symbol} ${Number(result.price).toFixed(4)}\``,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await sendInfo(lines);   // → channel (market-wide signal, not a personal trade)
  markSignalFired(result.symbol, 'BUY');
  console.log(`[Telegram] BUY alert sent → CHANNEL — ${result.symbol}`);
}

// ─── New Listing BUY Signal → MAIN CHAT ──────────────────────────────────────
// Listings are personal — you need to act on them immediately.
async function sendListingBuyAlert(result) {
  if (result.signal !== 'BUY') return;

  const tp1 = result.takeProfits?.tp1;
  const tp2 = result.takeProfits?.tp2;
  const tp3 = result.takeProfits?.tp3;
  const sl  = result.stopLoss;
  const rr  = result.riskReward;

  // ── Coin identity ──────────────────────────────────────────────────────────
  const identityLines = [];
  identityLines.push(`🪙 *Coin Name:* ${result.coinName || result.baseAsset}`);
  identityLines.push(`🔤 *Ticker:* ${result.baseAsset}`);
  if (result.description) {
    identityLines.push(`📄 *What it is:* ${result.description}`);
  }

  // ── Contract addresses ─────────────────────────────────────────────────────
  if (result.contracts && result.contracts.length > 0) {
    identityLines.push(`\n📋 *Contract Addresses:*`);
    result.contracts.forEach(c => {
      identityLines.push(`  *${c.chainLabel}:*`);
      identityLines.push(`  \`${c.address}\``);
    });
    identityLines.push(`\n⚠️ *Always verify on CoinGecko before buying*`);
  } else if (result.isNativeAsset) {
    identityLines.push(`ℹ️ *Native asset — no contract address (like BTC, ETH, SOL)*`);
  } else {
    identityLines.push(`⚠️ *Contract address not found — verify manually before buying*`);
  }

  if (result.coingeckoUrl) {
    identityLines.push(`🔗 *CoinGecko:* ${result.coingeckoUrl}`);
  }

  const riskLine = result.riskFlags?.length > 0
    ? `⚠️ *Risk Flags:* ${result.riskFlags.join(', ')}`
    : `✅ No major risk flags`;

  const lines = [
    `🚀 *NEW LISTING BUY — ${result.symbol}*`,
    ``,
    ...identityLines,
    ``,
    `── *MARKET DATA* ──`,
    `📊 *24H Change:* ${result.priceChange >= 0 ? '+' : ''}${Number(result.priceChange).toFixed(2)}%`,
    `💵 *Volume:* $${(result.volume / 1e6).toFixed(2)}M`,
    `🔥 *Pump Rating:* ${result.pumpRating} (pump score ${result.pumpScore})`,
    result.earlyStage ? `⚡ *Early Stage* — only ${result.candleCount} candles of history` : '',
    ``,
    `── *TRADE PLAN* ──`,
    `💰 *Entry:*    \`$${Number(result.entryPrice).toFixed(6)}\``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(6)}\` _(2x ATR)_` : '',
    ``,
    tp1 ? `🎯 *TP1 (sell 40%):* \`$${Number(tp1.price).toFixed(6)}\` — ${tp1.ratio}` : '',
    tp2 ? `🎯 *TP2 (sell 35%):* \`$${Number(tp2.price).toFixed(6)}\` — ${tp2.ratio}` : '',
    tp3 ? `🎯 *TP3 (sell 25%):* \`$${Number(tp3.price).toFixed(6)}\` — ${tp3.ratio}` : '',
    rr  ? `⚖️ *Risk:Reward:* ${rr}:1` : '',
    ``,
    `📐 *Technical Reasons:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    result.warnings?.length > 0 ? `\n⚠️ *Warnings:*` : '',
    ...(result.warnings || []).map(w => `  • ${w}`),
    ``,
    riskLine,
    result.onKraken ? `✅ Also on Kraken — cross-exchange validated` : '',
    ``,
    `🔴 *SELL RULES:*`,
    `  • Stop Loss hit → EXIT 100% immediately`,
    `  • TP1 hit → sell 40%, move stop to breakeven`,
    `  • TP2 hit → sell 35%, trail stop below TP1`,
    `  • TP3 hit → sell remaining 25%`,
    `  • Volume drops below $200K → EXIT`,
    ``,
    `⚠️ *New listings = HIGH RISK. Max 1-2% of account.*`,
    `📝 Quick buy: \`buy ${result.symbol} ${Number(result.entryPrice).toFixed(6)}\``,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await sendAction(lines);  // → main chat (personal trade decision needed)
  console.log(`[Telegram] NEW LISTING BUY → MAIN CHAT — ${result.symbol}`);
}

// ─── Bearish Alert → ACTION channel ──────────────────────────────────────────
async function sendBearishAlert(result) {
  if (result.signal !== 'BEARISH_ALERT') return;
  if (result.score < 3) return;
  if (isDuplicateSignal(result.symbol, 'BEARISH_ALERT')) return;

  const lines = [
    `🔴 *BEARISH ALERT — ${result.symbol}*`,
    ``,
    `⚠️ Not a short signal. If you hold ${result.symbol}: check your stop loss.`,
    ``,
    `💰 *Price:* \`$${Number(result.price).toFixed(4)}\``,
    `📉 *Trend:* DOWNTREND (below EMA200)`,
    `📊 *RSI:* ${Number(result.rsi).toFixed(1)}`,
    result.adxValue ? `📐 *ADX:* ${Number(result.adxValue).toFixed(1)}` : '',
    ``,
    `📝 *Signals:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await sendAction(lines);
  markSignalFired(result.symbol, 'BEARISH_ALERT');
}

// ─── Connection Test ──────────────────────────────────────────────────────────
async function sendTestMessage() {
  if (!BOT_TOKEN || !ACTION_CHAT) throw new Error('Telegram credentials not set');
  await sendAction([
    `✅ *CryptoBot V2 Connected*`,
    ``,
    `MAIN CHAT (this chat):`,
    `  • 🚀 New listing BUY signals`,
    `  • 🔴 Stop loss alerts`,
    `  • 🟢 TP1 / TP2 / TP3 hit`,
    `  • 🎯 Target hit (10%–50%+ milestones)`,
    `  • ⚪ HOLD updates every 4 hours`,
    `  • 🔴 Bearish alerts`,
    ``,
    `CHANNEL (${INFO_CHANNEL || '⚠️ not set — add TELEGRAM_INFO_CHANNEL_ID'}):`,
    `  • 🟢 BUY signals from market scanner`,
  ].join('\n'));
}

// ─── Position Alert (v2monitor / check command) ───────────────────────────────
// ACTION types: STOP_LOSS, TAKE_PROFIT, TARGET_HIT, big milestones (50%+)
// INFO types:   HOLD, small milestones (10%-40%)
async function sendPositionAlert(position, advice, overrideChatId) {
  const actionChatId = overrideChatId || ACTION_CHAT;

  const tp1 = advice.tradePlan?.takeProfits?.tp1;
  const tp2 = advice.tradePlan?.takeProfits?.tp2;
  const tp3 = advice.tradePlan?.takeProfits?.tp3;
  const sl  = advice.tradePlan?.stopLoss;

  const emoji = {
    STOP_LOSS:     '🔴',
    TAKE_PROFIT:   '🟢',
    TRAIL_STOP:    '🟡',
    CLOSE_PARTIAL: '🟠',
    HOLD:          '⚪',
  }[advice.recommendation] || '⚪';

  const urgencyLabel = {
    CRITICAL: '🚨 URGENT',
    HIGH:     '⚡ High Priority',
    MEDIUM:   '⚠️ Medium Priority',
    LOW:      'ℹ️ Low Priority',
  }[advice.urgency] || '';

  const lines = [
    `${emoji} *${advice.recommendation} — ${position.symbol}*  ${urgencyLabel}`,
    ``,
    `💰 *Bought at:* \`$${position.buyPrice}\``,
    `📊 *Now:*       \`$${Number(advice.currentPrice).toFixed(4)}\``,
    `📈 *P&L:*       ${advice.pnlDisplay}`,
    position.quantity
      ? `💵 *Value:* $${(position.quantity * advice.currentPrice).toFixed(2)}`
      : '',
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
    `📐 *RSI:* ${advice.indicators?.rsi || 'N/A'} | *Trend:* ${advice.indicators?.macroTrend || 'N/A'}`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  // ALL position alerts go to main chat — these are your personal trades.
  // (stop loss, TP, target hit, milestones, hold — you need to see all of these)
  await sendAction(lines, actionChatId);
}

// ─── sendSignalAlert — used by liveService.js ────────────────────────────────
// Routes to sendBuyAlert or sendBearishAlert based on signal type
async function sendSignalAlert(result) {
  if (!result) return;
  if (result.signal === 'BUY')            return sendBuyAlert(result);
  if (result.signal === 'BEARISH_ALERT')  return sendBearishAlert(result);
  // WAIT / neutral — no alert
}

module.exports = {
  sendBuyAlert,
  sendBearishAlert,
  sendListingBuyAlert,
  sendTestMessage,
  sendPositionAlert,
  sendSignalAlert,     // used by liveService
  sendAction,
  sendInfo,
  _send,               // legacy alias
};