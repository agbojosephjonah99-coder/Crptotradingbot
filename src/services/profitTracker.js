/**
 * ─── Profit Tracker ───────────────────────────────────────────────────────────
 * Tracks every closed trade and calculates total P&L per user.
 * Stored in Upstash Redis under: cryptobot:trades:{chatId}
 */

const axios = require('axios');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash    = !!(UPSTASH_URL && UPSTASH_TOKEN);
const memoryStore   = {};

async function upstashGet(key) {
  const r = await axios.get(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 5000,
  });
  return r.data.result ? JSON.parse(r.data.result) : null;
}

async function upstashSet(key, value) {
  await axios.post(`${UPSTASH_URL}/set/${key}`, JSON.stringify(value), {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 5000,
  });
}

function tradeKey(chatId) { return `cryptobot:trades:${chatId}`; }

async function getAllTrades(chatId) {
  try {
    if (useUpstash) return (await upstashGet(tradeKey(chatId))) || [];
    return memoryStore[chatId] || [];
  } catch { return []; }
}

// ─── Record a closed trade ────────────────────────────────────────────────────
async function recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity, targetMultiple }) {
  const trades   = await getAllTrades(chatId);
  const pnlPct   = ((sellPrice - buyPrice) / buyPrice) * 100;
  const multiple = sellPrice / buyPrice;
  const pnlDollar = quantity ? (sellPrice - buyPrice) * quantity : null;

  const trade = {
    id:             `${symbol}:${Date.now()}`,
    symbol,
    buyPrice:       parseFloat(buyPrice),
    sellPrice:      parseFloat(sellPrice),
    quantity:       quantity ? parseFloat(quantity) : null,
    pnlPct:         parseFloat(pnlPct.toFixed(2)),
    multiple:       parseFloat(multiple.toFixed(2)),
    pnlDollar:      pnlDollar ? parseFloat(pnlDollar.toFixed(4)) : null,
    targetMultiple: targetMultiple || null,
    targetHit:      targetMultiple ? multiple >= parseFloat(targetMultiple) : false,
    outcome:        pnlPct >= 0 ? 'WIN' : 'LOSS',
    closedAt:       new Date().toISOString(),
    month:          new Date().toISOString().slice(0, 7), // e.g. "2026-05"
  };

  trades.push(trade);

  if (useUpstash) await upstashSet(tradeKey(chatId), trades);
  else memoryStore[chatId] = trades;

  return trade;
}

// ─── Get stats for a period ───────────────────────────────────────────────────
function calcStats(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  const totalPnlDollar = trades.reduce((s, t) => s + (t.pnlDollar || 0), 0);
  const avgMultiple    = trades.reduce((s, t) => s + t.multiple, 0) / trades.length;
  const bestTrade      = trades.reduce((best, t) => t.pnlPct > (best?.pnlPct || -Infinity) ? t : best, null);
  const worstTrade     = trades.reduce((worst, t) => t.pnlPct < (worst?.pnlPct || Infinity) ? t : worst, null);

  return {
    totalTrades:    trades.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalPnlPct:    parseFloat(trades.reduce((s, t) => s + t.pnlPct, 0).toFixed(2)),
    totalPnlDollar: parseFloat(totalPnlDollar.toFixed(4)),
    avgMultiple:    parseFloat(avgMultiple.toFixed(2)),
    bestTrade,
    worstTrade,
  };
}

async function getMonthlyStats(chatId) {
  const trades     = await getAllTrades(chatId);
  const thisMonth  = new Date().toISOString().slice(0, 7);
  const lastMonth  = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);

  return {
    thisMonth:  calcStats(trades.filter(t => t.month === thisMonth)),
    lastMonth:  calcStats(trades.filter(t => t.month === lastMonth)),
    allTime:    calcStats(trades),
    recentTrades: trades.slice(-5).reverse(),
  };
}

module.exports = { recordTrade, getAllTrades, getMonthlyStats };