/**
 * ─── Paid access (optional) ───────────────────────────────────────────────────
 * Off unless PAID_ACCESS_ENABLED=true. When on, approved users also need an
 * active subscription to use the bot and dashboard and to get position alerts.
 * The admin never pays. The admin can give free time with `grant`.
 *
 * Payments: Paystack. A payment only counts after Paystack's verify API says
 * it succeeded for the right amount and currency (the webhook and the return
 * link are just triggers to check). Each payment reference is credited once.
 *
 * Env:
 *   PAID_ACCESS_ENABLED     true to require a subscription
 *   PAYSTACK_SECRET_KEY     sk_test_… / sk_live_…  (Paystack → Settings → API Keys)
 *   SUBSCRIPTION_PRICE      price per period in normal units, e.g. 5000 (default 5000)
 *   SUBSCRIPTION_CURRENCY   NGN (default), GHS, ZAR, KES, USD
 *   SUBSCRIPTION_DAYS       days per payment (default 30)
 *
 * Storage:
 *   cryptobot:sub:{chatId}        HASH paidUntil, email, plan, lastRef, remindedFor, expiredFor, grantedBy
 *   cryptobot:payref:{reference}  STRING chatId (set when the payment link is made, 7 days)
 *   cryptobot:paidref:{reference} STRING '1' — credited (SET NX → never twice)
 *   cryptobot:payments            LIST of JSON receipts (newest last)
 */

const axios = require('axios');
const crypto = require('crypto');
const store = require('../lib/redis');
const users = require('./userService');

const PAYSTACK = 'https://api.paystack.co';
const subKey = (chatId) => `cryptobot:sub:${chatId}`;
const DAY = 86_400_000;

class PaymentError extends Error {}

// ─── Settings: set by the admin in the bot (💳 Subscriptions), env vars as defaults
// cryptobot:settings HASH paidAccess '1'|'0', price, currency, days
const SETTINGS = 'cryptobot:settings';
let cache = { at: 0, v: {} };

/** Refresh settings from storage (cached 15 s). Every entry point calls this first. */
async function loadSettings({ force = false } = {}) {
  if (!force && Date.now() - cache.at < 15_000) return cache.v;
  try { cache = { at: Date.now(), v: store.hashToObject(await store.cmd('HGETALL', SETTINGS)) }; } catch { /* keep last */ }
  return cache.v;
}
const _resetSettingsCache = () => { cache = { at: 0, v: {} }; };

function enabled() {
  if (cache.v.paidAccess === '1') return true;
  if (cache.v.paidAccess === '0') return false;
  return String(process.env.PAID_ACCESS_ENABLED || '').toLowerCase() === 'true';
}
function plan() {
  const v = cache.v;
  const num = (x) => (Number(x) > 0 ? Number(x) : null);
  const price = num(v.price) ?? num(process.env.SUBSCRIPTION_PRICE) ?? 5000;
  const days = Math.round(num(v.days) ?? num(process.env.SUBSCRIPTION_DAYS) ?? 30);
  const currency = String(v.currency || process.env.SUBSCRIPTION_CURRENCY || 'NGN').toUpperCase();
  return { price, currency, days, amountMinor: Math.round(price * 100) };
}

async function setPaidAccess(on) {
  await store.cmd('HSET', SETTINGS, 'paidAccess', on ? '1' : '0');
  await loadSettings({ force: true });
  return enabled();
}

const CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES', 'USD'];
async function setPlan({ price, days, currency } = {}) {
  const fields = [];
  if (price !== undefined) { const p = Number(String(price).replace(/[,₦$]/g, '')); if (!(p > 0)) throw new PaymentError('Price must be a positive number, e.g. 5000'); fields.push('price', String(p)); }
  if (days !== undefined) { const d = Math.round(Number(days)); if (!(d >= 1 && d <= 3660)) throw new PaymentError('Days must be between 1 and 3660'); fields.push('days', String(d)); }
  if (currency !== undefined) { const c = String(currency).toUpperCase(); if (!CURRENCIES.includes(c)) throw new PaymentError(`Currency must be one of ${CURRENCIES.join(', ')} (what Paystack supports)`); fields.push('currency', c); }
  if (fields.length) await store.cmd('HSET', SETTINGS, ...fields);
  await loadSettings({ force: true });
  return plan();
}

/** "31/12/2026", "31-12-2026", "2026-12-31", "31 Dec 2026" → end of that day, Lagos time. */
function parseDate(text) {
  const t = String(text || '').trim();
  let y, m, d;
  let r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) [, y, m, d] = r.map(Number);
  else if ((r = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = r.map(Number);
  else if ((r = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/i))) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(r[2].toLowerCase());
    if (mi < 0) return null;
    d = Number(r[1]); m = mi + 1; y = Number(r[3]);
  } else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2100)) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T23:59:59+01:00`;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null; // e.g. 31/02
  return new Date(iso);
}

/** Give access until an exact date (replaces whatever they had). */
async function setUntil(chatId, date, { grantedBy = null } = {}) {
  const dt = date instanceof Date ? date : parseDate(date);
  if (!dt || isNaN(dt)) throw new PaymentError('Send a date like 31/12/2026');
  if (dt.getTime() <= Date.now()) throw new PaymentError('That date is in the past');
  await store.cmd('HSET', subKey(chatId), 'paidUntil', dt.toISOString(), ...(grantedBy ? ['grantedBy', String(grantedBy)] : []));
  return dt.toISOString();
}

/** Give days to every approved user who has no active subscription (before switching paid access on). */
async function giveAllWithout(days, { grantedBy = null } = {}) {
  let n = 0;
  for (const u of await users.getUsersByStatus('approved')) {
    if (users.isAdminId(u.chatId)) continue;
    if ((await getSub(u.chatId)).active) continue;
    await extend(u.chatId, days, { grantedBy });
    n++;
  }
  return n;
}

async function countWithoutAccess() {
  let n = 0;
  for (const u of await users.getUsersByStatus('approved')) if (!users.isAdminId(u.chatId) && !(await getSub(u.chatId)).active) n++;
  return n;
}
const priceLabel = () => { const p = plan(); return `${p.currency} ${p.price.toLocaleString('en-US')} / ${p.days} days`; };

async function getSub(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', subKey(chatId)));
  const until = h.paidUntil ? new Date(h.paidUntil).getTime() : 0;
  return {
    paidUntil: h.paidUntil || null,
    active: until > Date.now(),
    daysLeft: until > Date.now() ? Math.ceil((until - Date.now()) / DAY) : 0,
    email: h.email || null,
    lastRef: h.lastRef || null,
    remindedFor: h.remindedFor || null,
    expiredFor: h.expiredFor || null,
  };
}

/** Can this user use the bot right now? */
async function hasAccess(chatId) {
  await loadSettings();
  if (!enabled() || users.isAdminId(chatId)) return true;
  return (await getSub(chatId)).active;
}

async function status(chatId) {
  await loadSettings();
  const s = await getSub(chatId);
  return {
    required: enabled() && !users.isAdminId(chatId),
    isAdmin: users.isAdminId(chatId),
    active: !enabled() || users.isAdminId(chatId) || s.active,
    paidUntil: s.paidUntil,
    daysLeft: s.daysLeft,
    email: s.email,
    price: priceLabel(),
    paymentsReady: !!process.env.PAYSTACK_SECRET_KEY,
  };
}

/** Approved users (and the admin) who currently have access — for alerts. */
async function getChatIdsWithAccess() {
  await loadSettings();
  const ids = await users.getAllActiveChatIds();
  if (!enabled()) return ids;
  const out = [];
  for (const id of ids) if (await hasAccess(id)) out.push(id);
  return out;
}

// ─── Paystack ─────────────────────────────────────────────────────────────────
function paystack(method, path, data) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaymentError('Payments are not set up yet (admin: add PAYSTACK_SECRET_KEY).');
  return axios.request({ method, url: `${PAYSTACK}${path}`, data, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    .then(r => r.data)
    .catch(err => { throw new PaymentError(`Paystack: ${err?.response?.data?.message || err.message}`); });
}

const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(e || '').trim());

/** Create a Paystack payment link for one period. */
async function startCheckout(chatId, { email, callbackUrl }) {
  await loadSettings();
  const s = await getSub(chatId);
  email = String(email || s.email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new PaymentError('Send your email for the receipt, e.g. `subscribe you@example.com`');
  const p = plan();
  const reference = `cb_${chatId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const r = await paystack('POST', '/transaction/initialize', {
    email, amount: p.amountMinor, currency: p.currency, reference,
    callback_url: callbackUrl,
    metadata: { chatId: String(chatId), days: p.days, custom_fields: [{ display_name: 'Telegram ID', variable_name: 'chat_id', value: String(chatId) }] },
  });
  if (!r?.status || !r.data?.authorization_url) throw new PaymentError('Paystack did not return a payment link — try again.');
  await store.pipeline([
    ['SET', `cryptobot:payref:${reference}`, String(chatId), 'EX', 7 * 86400],
    ['HSET', subKey(chatId), 'email', email, 'lastRef', reference],
  ]);
  return { url: r.data.authorization_url, reference, price: priceLabel() };
}

/**
 * Ask Paystack whether a payment succeeded and, if so, extend the owner's
 * subscription exactly once. Safe to call any number of times.
 * @returns {{credited: boolean, already?: boolean, chatId?: string, paidUntil?: string, reason?: string}}
 */
async function confirmPayment(reference) {
  await loadSettings();
  reference = String(reference || '').trim();
  if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) return { credited: false, reason: 'bad reference' };
  const owner = await store.cmd('GET', `cryptobot:payref:${reference}`);
  if (!owner) return { credited: false, reason: 'unknown reference' };

  const r = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const d = r?.data || {};
  if (d.status !== 'success') return { credited: false, chatId: owner, reason: `payment ${d.status || 'not found'}` };
  const p = plan();
  if (String(d.currency).toUpperCase() !== p.currency || Number(d.amount) < p.amountMinor) {
    return { credited: false, chatId: owner, reason: `paid ${d.currency} ${Number(d.amount) / 100}, expected ${p.currency} ${p.price}` };
  }
  if (d.metadata?.chatId && String(d.metadata.chatId) !== String(owner)) return { credited: false, reason: 'reference belongs to another user' };

  // Credit once, even if the webhook, the return link and `subscribe check` all arrive together
  if ((await store.cmd('SET', `cryptobot:paidref:${reference}`, '1', 'NX')) !== 'OK') {
    return { credited: false, already: true, chatId: owner, paidUntil: (await getSub(owner)).paidUntil };
  }
  const paidUntil = await extend(owner, p.days, { reference });
  await store.cmd('RPUSH', 'cryptobot:payments', JSON.stringify({
    reference, chatId: owner, amount: Number(d.amount) / 100, currency: d.currency, days: p.days,
    paidAt: d.paid_at || new Date().toISOString(), paidUntil,
  }));
  return { credited: true, chatId: owner, paidUntil };
}

/** Add days to a subscription (from now, or from the current end if still active). */
async function extend(chatId, days, { reference = null, grantedBy = null } = {}) {
  const s = await getSub(chatId);
  const from = s.active ? new Date(s.paidUntil).getTime() : Date.now();
  const paidUntil = new Date(from + days * DAY).toISOString();
  await store.cmd('HSET', subKey(chatId), 'paidUntil', paidUntil, ...(reference ? ['lastRef', reference] : []), ...(grantedBy ? ['grantedBy', String(grantedBy)] : []));
  return paidUntil;
}

async function revoke(chatId) {
  await store.cmd('HSET', subKey(chatId), 'paidUntil', new Date(Date.now() - 1000).toISOString());
}

/** Paystack webhook: check the signature, then verify the payment with Paystack. */
async function handleWebhook(rawBody, signature) {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
  const expected = crypto.createHmac('sha512', key).update(body).digest('hex');
  const sigOk = !!signature && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  let event;
  try { event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody; } catch { event = null; }
  // The signature can fail only because the body was re-serialised; either way
  // nothing is credited unless Paystack's verify API confirms the payment.
  if (!event || event.event !== 'charge.success' || !event.data?.reference) return { ignored: true, sigOk };
  return { sigOk, ...(await confirmPayment(event.data.reference)) };
}

/**
 * Reminders, run from the monitor: 3 days before the end, and once when it ends.
 * @param send (chatId, text) => Promise
 */
async function sendReminders(send) {
  await loadSettings();
  if (!enabled()) return { reminded: 0, expired: 0 };
  let reminded = 0, expired = 0;
  for (const u of await users.getUsersByStatus('approved')) {
    const s = await getSub(u.chatId);
    if (!s.paidUntil) continue;
    const left = new Date(s.paidUntil).getTime() - Date.now();
    if (left > 0 && left <= 3 * DAY && s.remindedFor !== s.paidUntil) {
      await send(u.chatId, `⏳ *Your subscription ends in ${Math.ceil(left / DAY)} day${left > DAY ? 's' : ''}* (${new Date(s.paidUntil).toUTCString()}).\n\nRenew with \`subscribe\` — ${priceLabel()}. Time is added to what you have left.`);
      await store.cmd('HSET', subKey(u.chatId), 'remindedFor', s.paidUntil);
      reminded++;
    } else if (left <= 0 && s.expiredFor !== s.paidUntil) {
      await send(u.chatId, `🔒 *Your subscription has ended.* Position alerts are paused.\n\nRenew any time with \`subscribe\` — ${priceLabel()}.\n_Any stop orders already on your exchange stay there._`);
      await store.cmd('HSET', subKey(u.chatId), 'expiredFor', s.paidUntil);
      expired++;
    }
  }
  return { reminded, expired };
}

async function listSubscribers() {
  const out = [];
  for (const u of await users.getUsersByStatus('approved')) out.push({ user: u, sub: await getSub(u.chatId) });
  return out.sort((a, b) => String(b.sub.paidUntil || '').localeCompare(String(a.sub.paidUntil || '')));
}

module.exports = {
  PaymentError, enabled, plan, priceLabel, loadSettings, setPaidAccess, setPlan, parseDate, setUntil, giveAllWithout, countWithoutAccess, CURRENCIES, _resetSettingsCache, getSub, hasAccess, status, getChatIdsWithAccess,
  startCheckout, confirmPayment, extend, revoke, handleWebhook, sendReminders, listSubscribers, validEmail,
};

/** Tell the user (and the admin) about a credited payment. */
async function notifyCredited(result) {
  if (!result?.credited) return;
  const tg = require('../lib/telegram');
  const until = new Date(result.paidUntil).toUTCString();
  await tg.send(result.chatId, `✅ *Payment received — thank you!*\n\nYour access is active until *${until}*.\nTap *📋 MENU* to carry on.`).catch(() => {});
  const admin = process.env.TELEGRAM_CHAT_ID;
  if (admin && String(admin) !== String(result.chatId)) {
    const u = await users.getUser(result.chatId).catch(() => null);
    await tg.send(admin, `💰 ${tg.escapeMd(users.formatName(u || { chatId: result.chatId }))} paid ${priceLabel()} — active until ${until}.`).catch(() => {});
  }
}
module.exports.notifyCredited = notifyCredited;
