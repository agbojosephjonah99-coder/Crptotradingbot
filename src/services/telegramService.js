/**
 * ─── Enhanced Telegram Alert Service ─────────────────────────────────────────
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

  const tp1  = result.takeProfits?.tp1;
  const tp2  = result.takeProfits?.tp2;
  const tp3  = result.takeProfits?.tp3;
  const sl   = result.stopLoss;
  const rr   = result.riskReward;
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
    rr  ? `⚖️ *Risk:Reward:* ${rr}:1` : '',
    ``,
    `📊 *Confidence:* ${conf}% |${confBar}|`,
    `📈 *Score:* ${result.score}/15`,
    ``,
    `🔍 *Why:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    ``,
    `⚠️ *After TP1 → move stop to breakeven*`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await _send(lines);
  markSignalFired(result.symbol, 'BUY');
  console.log(`[Telegram] BUY alert sent — ${result.symbol}`);
}

// ─── New Listing BUY Signal (v2listings) — includes name + contracts ──────────
async function sendListingBuyAlert(result) {
  if (result.signal !== 'BUY') return;

  const tp1 = result.takeProfits?.tp1;
  const tp2 = result.takeProfits?.tp2;
  const tp3 = result.takeProfits?.tp3;
  const sl  = result.stopLoss;
  const rr  = result.riskReward;

  // ── Coin identity section ──────────────────────────────────────────────────
  const identityLines = [];
  identityLines.push(`🪙 *Coin Name:* ${result.coinName || result.baseAsset}`);
  identityLines.push(`🔤 *Ticker:* ${result.baseAsset}`);

  if (result.description) {
    identityLines.push(`📄 *What it is:* ${result.description}`);
  }

  if (result.contracts && result.contracts.length > 0) {
    identityLines.push(`\n📋 *Contract Addresses:*`);
    result.contracts.forEach(c => {
      identityLines.push(`  *${c.chainLabel}:*`);
      identityLines.push(`  \`${c.address}\``);
    });
    identityLines.push(`\n⚠️ *Always verify the contract address on the official CoinGecko page before buying*`);
  } else if (result.isNativeAsset) {
    identityLines.push(`ℹ️ *Native chain asset — no contract address (like BTC, ETH, SOL)*`);
  } else {
    identityLines.push(`⚠️ *Contract address not found — verify manually before buying*`);
  }

  if (result.coingeckoUrl) {
    identityLines.push(`🔗 *CoinGecko:* ${result.coingeckoUrl}`);
  }

  // ── Risk flags ─────────────────────────────────────────────────────────────
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
    `  • Volume drops below $200K → EXIT (liquidity gone)`,
    ``,
    `⚠️ *New listings = HIGH RISK. Max 1-2% of account.*`,
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

  await _send(lines);
  markSignalFired(result.symbol, 'BEARISH_ALERT');
}

// ─── Connection Test ──────────────────────────────────────────────────────────
async function sendTestMessage() {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Telegram credentials not set');
  await _send([
    `✅ *CryptoBot V2 Connected*`,
    ``,
    `Watchlist: ${process.env.BINANCE_SYMBOLS || 'SOLUSDT,BTCUSDT,ETHUSDT'}`,
    ``,
    `Active alerts:`,
    `  • 🟢 Watchlist BUY signals`,
    `  • 🚀 New listing BUY signals (with coin name + contract address)`,
    `  • 🔴 Bearish alerts`,
  ].join('\n'));
}

module.exports = {
  sendBuyAlert,
  sendBearishAlert,
  sendListingBuyAlert,
  sendTestMessage,
};