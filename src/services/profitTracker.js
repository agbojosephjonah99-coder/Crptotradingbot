/**
 * ─── Profit Tracker ───────────────────────────────────────────────────────────
 * Tracks every closed trade and calculates total P&L per user.
 * Stored under: cryptobot:trades:{chatId}  (unchanged key)
 */

const store = require('../lib/redis');

function tradeKey(chatId) { return `cryptobot:trades:${chatId}`; }

async function getAllTrades(chatId) {
  try { return (await store.getJSON(tradeKey(chatId), [])) || []; }
  catch (err) { console.error('[ProfitTracker] read failed:', err.message); return []; }
}

// ─── Record a closed trade ────────────────────────────────────────────────────
async function recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity, targetMultiple }) {
  const buy  = parseFloat(buyPrice);
  const sell = parseFloat(sellPrice);
  const qty  = quantity ? parseFloat(quantity) : null;

  const pnlPct    = ((sell - buy) / buy) * 100;
  const multiple  = sell / buy;
  const pnlDollar = qty ? (sell - buy) * qty : null;
  const now       = new Date();

  const trade = {
    id:             `${symbol}:${now.getTime()}`,
    symbol,
    buyPrice:       buy,
    sellPrice:      sell,
    quantity:       qty,
    pnlPct:         parseFloat(pnlPct.toFixed(2)),
    multiple:       parseFloat(multiple.toFixed(2)),
    // keep 0 as 0 (a breakeven trade with quantity is still a $0 result)
    pnlDollar:      pnlDollar !== null ? parseFloat(pnlDollar.toFixed(4)) : null,
    targetMultiple: targetMultiple || null,
    targetHit:      targetMultiple ? multiple >= parseFloat(targetMultiple) : false,
    outcome:        pnlPct >= 0 ? 'WIN' : 'LOSS',
    closedAt:       now.toISOString(),
    month:          now.toISOString().slice(0, 7), // e.g. "2026-05"
  };

  await store.update(tradeKey(chatId), [], trades => {
    const list = Array.isArray(trades) ? trades : [];
    list.push(trade);
    return list;
  });

  return trade;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function calcStats(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  const totalPnlDollar = trades.reduce((s, t) => s + (t.pnlDollar || 0), 0);
  const avgMultiple    = trades.reduce((s, t) => s + t.multiple, 0) / trades.length;
  const bestTrade      = trades.reduce((best, t) => (!best || t.pnlPct > best.pnlPct ? t : best), null);
  const worstTrade     = trades.reduce((worst, t) => (!worst || t.pnlPct < worst.pnlPct ? t : worst), null);

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

function previousMonth(now = new Date()) {
  // Use the 1st of the month so e.g. 31 March doesn't roll back into March.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

async function getMonthlyStats(chatId) {
  const trades    = await getAllTrades(chatId);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = previousMonth();

  return {
    thisMonth:    calcStats(trades.filter(t => t.month === thisMonth)),
    lastMonth:    calcStats(trades.filter(t => t.month === lastMonth)),
    allTime:      calcStats(trades),
    recentTrades: trades.slice(-5).reverse(),
  };
}

module.exports = { recordTrade, getAllTrades, getMonthlyStats, calcStats, previousMonth };
