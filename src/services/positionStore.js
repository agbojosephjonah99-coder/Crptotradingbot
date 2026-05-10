/**
 * ─── Position Store (Multi-User) ─────────────────────────────────────────────
 * Positions stored per user chat ID.
 * Key format: cryptobot:positions:{chatId}
 */

const axios = require('axios');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash    = !!(UPSTASH_URL && UPSTASH_TOKEN);

const memoryStore = {};

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

async function getPosition(chatId, symbol) {
  const all = await getAllPositions(chatId);
  return all[symbol.toUpperCase()] || null;
}

async function addPosition({ chatId, symbol, buyPrice, quantity, accountSize, riskPct, targetMultiple }) {
  const sym  = symbol.toUpperCase();
  const all  = await getAllPositions(chatId);
  const target = targetMultiple ? parseFloat(targetMultiple) : null;

  all[sym] = {
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
  else { memoryStore[chatId] = memoryStore[chatId] || {}; memoryStore[chatId][sym] = all[sym]; }

  return all[sym];
}

async function updatePosition(chatId, symbol, updates) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions(chatId);
  if (!all[sym]) return;
  all[sym] = { ...all[sym], ...updates };
  if (useUpstash) await upstashSet(posKey(chatId), all);
  else memoryStore[chatId][sym] = all[sym];
}

async function removePosition(chatId, symbol) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions(chatId);
  if (!all[sym]) return false;
  delete all[sym];
  if (useUpstash) await upstashSet(posKey(chatId), all);
  else delete memoryStore[chatId]?.[sym];
  return true;
}

async function updateLastChecked(chatId, symbol, recommendation) {
  await updatePosition(chatId, symbol, {
    lastChecked:        new Date().toISOString(),
    lastRecommendation: recommendation,
  });
}

// ─── Get ALL positions across ALL users (for monitor) ─────────────────────────
async function getAllUsersPositions() {
  try {
    if (!useUpstash) {
      const all = [];
      for (const [chatId, positions] of Object.entries(memoryStore)) {
        for (const pos of Object.values(positions)) {
          all.push({ ...pos, chatId });
        }
      }
      return all;
    }

    // List all position keys from Upstash
    const r = await axios.get(`${UPSTASH_URL}/keys/cryptobot:positions:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 8000,
    });

    const keys = r.data.result || [];
    const all  = [];

    for (const key of keys) {
      const chatId    = key.replace('cryptobot:positions:', '');
      const positions = await upstashGet(key);
      if (positions) {
        for (const pos of Object.values(positions)) {
          all.push({ ...pos, chatId });
        }
      }
    }

    return all;
  } catch (err) {
    console.error('[PositionStore] getAllUsersPositions error:', err.message);
    return [];
  }
}

module.exports = {
  getAllPositions, getPosition, addPosition,
  updatePosition, removePosition, updateLastChecked,
  getAllUsersPositions,
  isUsingUpstash: useUpstash,
};