/**
 * ─── Enhanced Telegram Alert Service ─────────────────────────────────────────
 * Handles all alert types:
 *  - sendBuyAlert        → watchlist BUY signal (v2scan)
 *  - sendBearishAlert    → watchlist BEARISH alert (v2scan)
 *  - sendListingBuyAlert → new listing BUY signal (v2listings) ← NEW
 *  - sendListingAlert    → hot listing pump (v2listings)
 *  - sendDailySummary    → daily recap
 *  - sendTestMessage     → connection test
 */

const axios = require('axios');
const { isDuplicateSignal, markSignalFired } = require('./riskService');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function _send(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] Missing credentials — skipping alert');
    return;
  }
  const resp = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    { chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 10000 }
  );
  if (!resp.data.ok) throw new Error(`Telegram error: ${JSON.stringify(resp.data)}`);
  return resp.data;
}

// ─── Watchlist BUY Signal (v2scan) ───────────────────────────────────────────
async function sendBuyAlert(result) {
  if (result.signal !== 'BUY') return;
  if (result.score < 7) return;
  if (isDuplicateSignal(result.symbol, 'BUY')) {
    console.log(`[Telegram] Dedup: ${result.symbol} BUY already sent within 4h`);
    return;
  }

  const tp1 = result.takeProfits?.tp1;
  const tp2 = result.takeProfits?.tp2;
  const tp3 = result.takeProfits?.tp3;
  const sl  = result.stopLoss;
  const rr  = result.riskReward;
  const conf = result.confidence;
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
    rr  ? `⚖️ *Risk:Reward:*  ${rr}:1` : '',
    ``,
    `📊 *Confidence:* ${conf}% |${confBar}|`,
    `📈 *Score:* ${result.score}/15`,
    ``,
    `🔍 *Why:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    ``,
    `⚠️ *After TP1 hits → move stop to breakeven ($${Number(result.price).toFixed(4)})*`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await _send(lines);
  markSignalFired(result.symbol, 'BUY');
  console.log(`[Telegram] BUY alert sent — ${result.symbol}`);
}

// ─── New Listing BUY Signal (v2listings) ─────────────────────────────────────
async function sendListingBuyAlert(result) {
  if (result.signal !== 'BUY') return;

  const tp1 = result.takeProfits?.tp1;
  const tp2 = result.takeProfits?.tp2;
  const tp3 = result.takeProfits?.tp3;
  const sl  = result.stopLoss;
  const rr  = result.riskReward;

  const riskLine = result.riskFlags?.length > 0
    ? `⚠️ *Risk Flags:* ${result.riskFlags.join(', ')}`
    : '✅ No major risk flags';

  const lines = [
    `🚀 *NEW LISTING BUY — ${result.symbol}*`,
    ``,
    `📊 *24H Change:* ${result.priceChange >= 0 ? '+' : ''}${Number(result.priceChange).toFixed(2)}%`,
    `💵 *Volume:* $${(result.volume / 1e6).toFixed(2)}M`,
    `🔥 *Pump Rating:* ${result.pumpRating} (score ${result.pumpScore})`,
    result.earlyStage ? `⚡ *Early Stage* — only ${result.candleCount} candles of history` : '',
    ``,
    `── *TRADE PLAN* ──`,
    `💰 *Entry:*    \`$${Number(result.entryPrice).toFixed(6)}\``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(6)}\` _(2x ATR — wider for new coins)_` : '',
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
    result.onKraken ? `✅ Also listed on Kraken — cross-exchange validated` : '',
    ``,
    `🔴 *SELL RULES:*`,
    `  • Hit Stop Loss → EXIT 100% immediately, no hesitation`,
    `  • Hit TP1 → sell 40%, move stop to breakeven`,
    `  • Hit TP2 → sell 35%, trail stop below TP1`,
    `  • Hit TP3 → sell remaining 25%`,
    `  • If 24H volume drops below $200K → EXIT immediately (liquidity gone)`,
    ``,
    `⚠️ *New listings are HIGH RISK. Use max 1-2% of account.*`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await _send(lines);
  console.log(`[Telegram] NEW LISTING BUY sent — ${result.symbol}`);
}

// ─── Bearish Alert ────────────────────────────────────────────────────────────
async function sendBearishAlert(result) {
  if (result.signal !== 'BEARISH_ALERT') return;
  if (result.score < 3) return;
  if (isDuplicateSignal(result.symbol, 'BEARISH_ALERT')) return;

  const lines = [
    `🔴 *BEARISH ALERT — ${result.symbol}*`,
    ``,
    `⚠️ This is NOT a short signal. If you hold ${result.symbol}: check your stop loss.`,
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

  await _send(lines);
  markSignalFired(result.symbol, 'BEARISH_ALERT');
}

// ─── Hot Listing Alert (pump only, no trade plan) ─────────────────────────────
async function sendListingAlert(coin) {
  if (coin.pumpRating !== 'HOT') return;
  if (isDuplicateSignal(coin.symbol, 'LISTING')) return;

  const lines = [
    `🔥 *HOT NEW LISTING — ${coin.symbol}*`,
    `💰 Price: \`$${Number(coin.price).toFixed(6)}\``,
    `📈 24H: ${coin.priceChange >= 0 ? '+' : ''}${Number(coin.priceChange).toFixed(2)}%`,
    `💵 Volume: $${(coin.volume / 1e6).toFixed(2)}M`,
    `⭐ Score: ${coin.score}/12`,
    ``,
    `*Factors:*`,
    ...(coin.factors || []).map(f => `  • ${f}`),
    ``,
    `⚠️ Pump alert only — run /api/v2listings for full trade plan.`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await _send(lines);
  markSignalFired(coin.symbol, 'LISTING');
}

// ─── Daily Summary ────────────────────────────────────────────────────────────
async function sendDailySummary({ scannedCount, buyCount, bearishCount, hotListings, topSignals }) {
  const lines = [
    `📊 *Daily Bot Summary*`,
    `🔍 Coins scanned: ${scannedCount}`,
    `🟢 BUY signals: ${buyCount}`,
    `🔴 Bearish alerts: ${bearishCount}`,
    `🔥 Hot new listings: ${hotListings}`,
    topSignals?.length > 0 ? `\n*Top Signals:*` : '',
    ...(topSignals || []).slice(0, 5).map(s => `  • ${s.symbol} — ${s.signal} (${s.confidence}% conf)`),
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await _send(lines);
}

// ─── Connection Test ──────────────────────────────────────────────────────────
async function sendTestMessage() {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set');
  }
  await _send([
    `✅ *CryptoBot V2 Connected*`,
    ``,
    `Watchlist: ${process.env.BINANCE_SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT'}`,
    ``,
    `Active alerts:`,
    `  • 🟢 BUY signals (watchlist)`,
    `  • 🚀 New listing BUY signals`,
    `  • 🔴 Bearish alerts`,
    `  • 🔥 Hot pump alerts`,
    ``,
    `Bot is live and scanning.`,
  ].join('\n'));
}

module.exports = {
  sendBuyAlert,
  sendBearishAlert,
  sendListingBuyAlert,
  sendListingAlert,
  sendDailySummary,
  sendTestMessage,
};