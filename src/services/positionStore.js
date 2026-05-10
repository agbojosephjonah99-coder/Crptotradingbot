/**
 * ─── Position Store ───────────────────────────────────────────────────────────
 * Stores open trades with optional target (e.g. 5X)
 * Uses Upstash Redis if configured, otherwise in-memory fallback.
 *
 * SETUP (free):
 *  1. https://upstash.com → create free Redis DB
 *  2. Add to Vercel env vars:
 *     UPSTASH_REDIS_REST_URL
 *     UPSTASH_REDIS_REST_TOKEN
 */

const axios = require('axios');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const POSITIONS_KEY = 'cryptobot:positions';
const memoryStore   = new Map();
const useUpstash    = !!(UPSTASH_URL && UPSTASH_TOKEN);

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

async function getAllPositions() {
  try {
    if (useUpstash) return (await upstashGet(POSITIONS_KEY)) || {};
    return Object.fromEntries(memoryStore);
  } catch { return {}; }
}

async function getPosition(symbol) {
  const all = await getAllPositions();
  return all[symbol.toUpperCase()] || null;
}

async function addPosition({ symbol, buyPrice, quantity, accountSize, riskPct, targetMultiple }) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();

  // targetMultiple: e.g. 5 means alert at 5X, 2 means alert at 2X
  const target = targetMultiple ? parseFloat(targetMultiple) : null;

  all[sym] = {
    symbol:             sym,
    buyPrice:           parseFloat(buyPrice),
    quantity:           quantity    ? parseFloat(quantity)    : null,
    accountSize:        accountSize ? parseFloat(accountSize) : null,
    riskPct:            riskPct     ? parseFloat(riskPct)     : 1,
    targetMultiple:     target,
    targetPrice:        target ? parseFloat(buyPrice) * target : null,
    targetHit:          false,   // flag so we only alert once
    stopLossHit:        false,
    addedAt:            new Date().toISOString(),
    lastChecked:        null,
    lastRecommendation: null,
    highestPrice:       parseFloat(buyPrice), // track ATH for trailing stop
  };

  if (useUpstash) await upstashSet(POSITIONS_KEY, all);
  else memoryStore.set(sym, all[sym]);

  return all[sym];
}

async function updatePosition(symbol, updates) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();
  if (!all[sym]) return;
  all[sym] = { ...all[sym], ...updates };
  if (useUpstash) await upstashSet(POSITIONS_KEY, all);
  else memoryStore.set(sym, all[sym]);
}

async function removePosition(symbol) {
  const sym = symbol.toUpperCase();
  const all = await getAllPositions();
  if (!all[sym]) return false;
  delete all[sym];
  if (useUpstash) await upstashSet(POSITIONS_KEY, all);
  else memoryStore.delete(sym);
  return true;
}

async function updateLastChecked(symbol, recommendation) {
  await updatePosition(symbol, {
    lastChecked:        new Date().toISOString(),
    lastRecommendation: recommendation,
  });
}

module.exports = {
  getAllPositions, getPosition, addPosition,
  updatePosition, removePosition, updateLastChecked,
  isUsingUpstash: useUpstash,
};