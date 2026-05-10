/**
 * ─── Position Store (Multi-User + Multi-Entry per Coin) ──────────────────────
 * Each buy is stored as a unique entry using symbol:timestamp as key.
 * This allows multiple buys of the same coin at different prices.
 *
 * Key format: cryptobot:positions:{chatId}
 * Position ID: {SYMBOL}:{timestamp}  e.g. SOLUSDT:1715123456789
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
    headers: {
      Authorization:  `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

function posKey(chatId) {
  return `cryptobot:positions:${chatId}`;
}

// ─── Get all positions for a user ─────────────────────────────────────────────
async function getAllPositions(chatId) {
  try {
    if (useUpstash) return (await upstashGet(posKey(chatId))) || {};
    return memoryStore[chatId] || {};
  } catch { return {}; }
}

// ─── Get all positions for a specific symbol (returns array) ──────────────────
async function getPositionsBySymbol(chatId, symbol) {
  const all = await getAllPositions(chatId);
  return Object.values(all).filter(p => p.symbol === symbol.toUpperCase());
}

// ─── Get a single position by its unique ID ───────────────────────────────────
async function getPositionById(chatId, positionId) {
  const all = await getAllPositions(chatId);
  return all[positionId] || null;
}

// ─── Add a new position (always creates a new entry) ──────────────────────────
async function addPosition({ chatId, symbol, buyPrice, quantity, accountSize, riskPct, targetMultiple }) {
  const sym    = symbol.toUpperCase();
  const all    = await getAllPositions(chatId);
  const target = targetMultiple ? parseFloat(targetMultiple) : null;

  // Unique ID = SYMBOL:timestamp — allows multiple buys of same coin
  const positionId = `${sym}:${Date.now()}`;

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
    addedAt:            new Date().toISOString(),
    lastChecked:        null,
    lastRecommendation: null,
    highestPrice:       parseFloat(buyPrice),
  };

  if (useUpstash) await upstashSet(posKey(chatId), all);
  else {
    memoryStore[chatId] = memoryStore[chatId] || {};
    memoryStore[chatId][positionId] = all[positionId];
  }

  return all[positionId];
}

// ─── Update a position by ID ───────────────────────────────────────────────────
async function updatePosition(chatId, positionId, updates) {
  const all = await getAllPositions(chatId);
  if (!all[positionId]) return;
  all[positionId] = { ...all[positionId], ...updates };
  if (useUpstash) await upstashSet(posKey(chatId), all);
  else if (memoryStore[chatId]) memoryStore[chatId][positionId] = all[positionId];
}

// ─── Remove a position by ID ───────────────────────────────────────────────────
async function removePositionById(chatId, positionId) {
  const all = await getAllPositions(chatId);
  if (!all[positionId]) return false;
  delete all[positionId];
  if (useUpstash) await upstashSet(posKey(chatId), all);
  else delete memoryStore[chatId]?.[positionId];
  return true;
}

// ─── Remove ALL positions for a symbol ────────────────────────────────────────
async function removeAllBySymbol(chatId, symbol) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions(chatId);
  let removed = 0;
  for (const [id, pos] of Object.entries(all)) {
    if (pos.symbol === sym) { delete all[id]; removed++; }
  }
  if (removed > 0) {
    if (useUpstash) await upstashSet(posKey(chatId), all);
    else memoryStore[chatId] = all;
  }
  return removed;
}

// ─── Update lastChecked on a position ─────────────────────────────────────────
async function updateLastChecked(chatId, positionId, recommendation) {
  await updatePosition(chatId, positionId, {
    lastChecked:        new Date().toISOString(),
    lastRecommendation: recommendation,
  });
}

// ─── Get ALL positions across ALL users (for monitor) ─────────────────────────
async function getAllUsersPositions() {
  try {
    if (!useUpstash) {
      const all = [];
      for (const positions of Object.values(memoryStore)) {
        for (const pos of Object.values(positions)) all.push(pos);
      }
      return all;
    }

    const r = await axios.get(`${UPSTASH_URL}/keys/cryptobot:positions:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 8000,
    });

    const keys = r.data.result || [];
    const all  = [];

    for (const key of keys) {
      const positions = await upstashGet(key);
      if (positions) {
        for (const pos of Object.values(positions)) all.push(pos);
      }
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
  isUsingUpstash: useUpstash,
};