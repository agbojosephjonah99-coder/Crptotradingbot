/**
 * ─── Position Store ───────────────────────────────────────────────────────────
 * Stores your open trades persistently using Upstash Redis (free tier).
 *
 * SETUP (one time):
 *  1. Go to https://upstash.com → create a free Redis database
 *  2. Copy the REST URL and REST Token
 *  3. Add to Vercel environment variables:
 *     UPSTASH_REDIS_REST_URL  = https://your-db.upstash.io
 *     UPSTASH_REDIS_REST_TOKEN = your_token
 *
 * If Upstash is not configured, falls back to in-memory storage
 * (positions will reset on Vercel cold starts — fine for testing).
 */

const axios = require('axios');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const POSITIONS_KEY = 'cryptobot:positions';

// In-memory fallback
const memoryStore = new Map();

const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

// ─── Upstash helpers ──────────────────────────────────────────────────────────
async function upstashGet(key) {
  const r = await axios.get(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 5000,
  });
  return r.data.result ? JSON.parse(r.data.result) : null;
}

async function upstashSet(key, value) {
  await axios.post(`${UPSTASH_URL}/set/${key}`,
    JSON.stringify(value),
    {
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getAllPositions() {
  try {
    if (useUpstash) {
      const data = await upstashGet(POSITIONS_KEY);
      return data || {};
    }
    return Object.fromEntries(memoryStore);
  } catch (err) {
    console.error('[PositionStore] getAllPositions error:', err.message);
    return {};
  }
}

async function getPosition(symbol) {
  const all = await getAllPositions();
  return all[symbol.toUpperCase()] || null;
}

async function addPosition({ symbol, buyPrice, quantity, accountSize, riskPct }) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();

  all[sym] = {
    symbol:      sym,
    buyPrice:    parseFloat(buyPrice),
    quantity:    quantity ? parseFloat(quantity) : null,
    accountSize: accountSize ? parseFloat(accountSize) : null,
    riskPct:     riskPct   ? parseFloat(riskPct)   : 1,
    addedAt:     new Date().toISOString(),
    lastChecked: null,
    lastRecommendation: null,
  };

  if (useUpstash) {
    await upstashSet(POSITIONS_KEY, all);
  } else {
    memoryStore.set(sym, all[sym]);
  }

  return all[sym];
}

async function removePosition(symbol) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();

  if (!all[sym]) return false;

  delete all[sym];

  if (useUpstash) {
    await upstashSet(POSITIONS_KEY, all);
  } else {
    memoryStore.delete(sym);
  }

  return true;
}

async function updateLastChecked(symbol, recommendation) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();
  if (!all[sym]) return;

  all[sym].lastChecked        = new Date().toISOString();
  all[sym].lastRecommendation = recommendation;

  if (useUpstash) {
    await upstashSet(POSITIONS_KEY, all);
  } else {
    memoryStore.set(sym, all[sym]);
  }
}

module.exports = {
  getAllPositions,
  getPosition,
  addPosition,
  removePosition,
  updateLastChecked,
  isUsingUpstash: useUpstash,
};