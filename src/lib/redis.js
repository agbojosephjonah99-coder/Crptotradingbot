/**
 * ─── Storage (single shared copy) ────────────────────────────────────────────
 * Upstash Redis over REST when UPSTASH_REDIS_REST_URL + _TOKEN are set,
 * otherwise an in-memory store (fine for local testing; lost on restart).
 *
 * Values are stored as JSON strings under the same keys as before, so data
 * written by the previous version is read back unchanged.
 */

const axios = require('axios');

const memory = new Map();

function isEnabled() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function command(args, timeout = 8000) {
  const resp = await axios.post(process.env.UPSTASH_REDIS_REST_URL, args, {
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout,
  });
  if (resp.data && resp.data.error) throw new Error(`Upstash: ${resp.data.error}`);
  return resp.data ? resp.data.result : null;
}

/** Read a JSON value. Returns `fallback` if missing. Throws on storage errors. */
async function getJSON(key, fallback = null) {
  let raw;
  if (isEnabled()) raw = await command(['GET', key]);
  else raw = memory.has(key) ? memory.get(key) : null;
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function setJSON(key, value) {
  const raw = JSON.stringify(value);
  if (isEnabled()) await command(['SET', key, raw]);
  else memory.set(key, raw);
}

async function del(key) {
  if (isEnabled()) await command(['DEL', key]);
  else memory.delete(key);
}

/** Keys matching a glob pattern (only `*` wildcards are needed here). */
async function keys(pattern) {
  if (isEnabled()) return (await command(['KEYS', pattern])) || [];
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return [...memory.keys()].filter(k => re.test(k));
}

/**
 * Read-modify-write helper: loads the value, passes it to `mutate`, saves the
 * result. Keeps every caller's update logic in one place.
 */
async function update(key, fallback, mutate) {
  const current = await getJSON(key, fallback);
  const next = await mutate(current);
  await setJSON(key, next === undefined ? current : next);
  return next === undefined ? current : next;
}

function _resetMemory() { memory.clear(); }

module.exports = { isEnabled, getJSON, setJSON, del, keys, update, _resetMemory };
