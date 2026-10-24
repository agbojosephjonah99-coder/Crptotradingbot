/**
 * ─── Position Store (Multi-User + Multi-Entry per Coin) ──────────────────────
 * Each buy is stored as a unique entry using symbol:timestamp as key.
 * This allows multiple buys of the same coin at different prices.
 *
 * Key format: cryptobot:positions:{chatId}   (unchanged — existing data still loads)
 * Position ID: {SYMBOL}:{timestamp}  e.g. SOLUSDT:1715123456789
 */

const store = require('../lib/redis');

function posKey(chatId) {
  return `cryptobot:positions:${chatId}`;
}

// ─── Get all positions for a user ─────────────────────────────────────────────
async function getAllPositions(chatId) {
  try {
    return (await store.getJSON(posKey(chatId), {})) || {};
  } catch (err) {
    console.error('[PositionStore] read failed:', err.message);
    return {};
  }
}

// ─── Get all positions for a specific symbol (returns array, oldest first) ───
async function getPositionsBySymbol(chatId, symbol) {
  const all = await getAllPositions(chatId);
  return Object.values(all)
    .filter(p => p.symbol === symbol.toUpperCase())
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
}

async function getPositionById(chatId, positionId) {
  const all = await getAllPositions(chatId);
  return all[positionId] || null;
}

// ─── Add a new position (always creates a new entry) ──────────────────────────
async function addPosition({ chatId, symbol, buyPrice, quantity, accountSize, riskPct, targetMultiple }) {
  const sym    = symbol.toUpperCase();
  const target = targetMultiple ? parseFloat(targetMultiple) : null;
  let positionId = `${sym}:${Date.now()}`;

  const all = await getAllPositions(chatId);
  while (all[positionId]) positionId = `${sym}:${Date.now() + Math.floor(Math.random() * 1000)}`;

  all[positionId] = {
    positionId,
    symbol:             sym,
    chatId:             chatId.toString(),
    buyPrice:           parseFloat(buyPrice),
    quantity:           quantity    ? parseFloat(quantity)    : null,
    accountSize:        accountSize ? parseFloat(accountSize) : null,
    riskPct:            riskPct     ? parseFloat(riskPct)     : 1,
    targetMultiple:     target,
    targetPrice:        target ? parseFloat(buyPrice) * target : null,
    targetHit:          false,
    stopLossHit:        false,
    // Trade plan is locked the first time it is calculated (see adviceService)
    stopLossPrice:      null,
    takeProfits:        null,
    addedAt:            new Date().toISOString(),
    lastChecked:        null,
    lastHoldAlertAt:    null,
    lastRecommendation: null,
    highestPrice:       parseFloat(buyPrice),
  };

  await store.setJSON(posKey(chatId), all);
  return all[positionId];
}

// ─── Update a position by ID (one read + one write) ───────────────────────────
async function updatePosition(chatId, positionId, updates) {
  if (!updates || Object.keys(updates).length === 0) return null;
  const all = await getAllPositions(chatId);
  if (!all[positionId]) return null;
  all[positionId] = { ...all[positionId], ...updates };
  await store.setJSON(posKey(chatId), all);
  return all[positionId];
}

async function removePositionById(chatId, positionId) {
  const all = await getAllPositions(chatId);
  if (!all[positionId]) return false;
  delete all[positionId];
  await store.setJSON(posKey(chatId), all);
  return true;
}

async function removeAllBySymbol(chatId, symbol) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions(chatId);
  let removed = 0;
  for (const [id, pos] of Object.entries(all)) {
    if (pos.symbol === sym) { delete all[id]; removed++; }
  }
  if (removed > 0) await store.setJSON(posKey(chatId), all);
  return removed;
}

async function updateLastChecked(chatId, positionId, recommendation) {
  return updatePosition(chatId, positionId, {
    lastChecked:        new Date().toISOString(),
    lastRecommendation: recommendation,
  });
}

// ─── Get ALL positions across ALL users (for quickcheck) ──────────────────────
async function getAllUsersPositions() {
  try {
    const keys = await store.keys('cryptobot:positions:*');
    const all  = [];
    for (const key of keys) {
      const positions = await store.getJSON(key, {});
      if (positions) for (const pos of Object.values(positions)) all.push(pos);
    }
    return all;
  } catch (err) {
    console.error('[PositionStore] getAllUsersPositions error:', err.message);
    return [];
  }
}

module.exports = {
  getAllPositions,
  getPositionsBySymbol,
  getPositionById,
  addPosition,
  updatePosition,
  removePositionById,
  removeAllBySymbol,
  updateLastChecked,
  getAllUsersPositions,
  get isUsingUpstash() { return store.isEnabled(); },
};
