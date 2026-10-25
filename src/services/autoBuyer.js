/**
 * ─── Auto-buy ─────────────────────────────────────────────────────────────────
 * Once a day, just after the daily candle closes (00:05 UTC, from the 30-min
 * monitor), the bot checks the chosen strategy on the coin list and buys the
 * coins that signal — using exactly the rules `npm run lab` tested.
 *
 *  PRACTICE (play money) — anyone can switch it on: `autobuy on`.
 *  HOUSE    — a practice account the bot always runs. Its results are the
 *             public forward test: how the strategy does from today on, on
 *             data nobody could have tuned it to.
 *  LIVE     — LOCKED. The admin can unlock it only when:
 *               1. `npm run lab` gave the strategy a PASS, and
 *               2. the house account has run 8+ weeks, 20+ closed trades,
 *                  and made money after fees.
 *             Then each user still opts in themselves (`autobuy live on`).
 *
 * Safety limits on every account (src/config/autobuy.js): 1% of the account at
 * risk per trade, no position above 20%, at most 5 auto positions, and no new
 * buys after the account fell 3%+ since the previous day. Admin kill switch:
 * `autobuy pause`.
 *
 * Positions are managed by a trailing stop only (moved up at each daily run);
 * practice and live sell at the stop exactly like the backtest.
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/redis');
const { fetchKlines, fetchPrice } = require('../lib/market');
const { mapLimit } = require('../lib/concurrency');
const { STRATEGIES, prepare, makeContext } = require('../strategies');
const cfg = require('../config/autobuy');
const practice = require('./practiceService');
const ps = require('./positionStore');
const accounts = require('./tradingAccounts');
const autoTrader = require('./autoTrader');
const { floorToStep, toFixedStep } = require('../lib/binanceTrade');

const HOUSE = 'house';
const K = {
  users: 'cryptobot:autobuy:users',
  live: 'cryptobot:autobuy:live',
  flags: 'cryptobot:autobuy:flags',
  day: (d) => `cryptobot:autobuy:day:${d}`,
  lastEq: (c) => `cryptobot:autobuy:lasteq:${c}`,
  signals: 'cryptobot:autobuy:signals',
};

class AutoBuyError extends Error {}
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

// ─── Strategy in use ──────────────────────────────────────────────────────────
function loadResearch() {
  const file = process.env.AUTO_STRATEGY_FILE || path.join(__dirname, '..', '..', cfg.STRATEGY_FILE);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function currentStrategy() {
  const res = loadResearch();
  const pick = res?.pick;
  if (pick && STRATEGIES[pick.family]) {
    return { family: pick.family, params: pick.params, id: pick.id, label: pick.label, name: pick.name, verdict: res.verdict, why: pick.why, test: pick.test, portfolioTest: pick.portfolioTest, period: res.period, tested: true };
  }
  const f = cfg.FALLBACK;
  return { ...f, name: STRATEGIES[f.family].name, label: `${STRATEGIES[f.family].name} — ${STRATEGIES[f.family].describe(f.params)}`, verdict: 'NOT TESTED', why: 'not tested yet — run `npm run lab`', tested: false };
}

// ─── Signals (one computation per day, shared by everyone) ───────────────────
async function computeSignals(strategy) {
  const syms = cfg.universe();
  if (!syms.includes('BTCUSDT')) syms.unshift('BTCUSDT');
  const prepared = {};
  await mapLimit(syms, 5, async (s) => {
    try {
      const c = await fetchKlines(s, '1d', 300, { closedOnly: true, exchange: 'binance' });
      if (c.length >= 120) prepared[s] = Object.assign(prepare(c), { symbol: s });
    } catch { /* coin skipped today */ }
  });
  if (!prepared.BTCUSDT) throw new AutoBuyError('no BTC daily data — skipped today');
  const ctx = makeContext(prepared, prepared.BTCUSDT);
  const s = STRATEGIES[strategy.family];
  const p = strategy.params;
  const buys = [];
  for (const sym of cfg.universe()) {
    const ind = prepared[sym];
    if (!ind) continue;
    const i = ind.c.length - 1;
    if (i < s.warmup) continue;
    if (p.regime && !ctx.btcUp(ind.c[i].time)) continue;
    if (!s.entry(ind, i, p, ctx)) continue;
    const ref = ind.close[i];
    const stop = s.initialStop(ind, i, p, ref);
    if (Number.isFinite(stop) && stop > 0 && stop < ref) buys.push({ symbol: sym, close: ref, stop, stopPct: r2((1 - stop / ref) * 100) });
  }
  return { prepared, buys, regimeUp: ctx.btcUp(prepared.BTCUSDT.c[prepared.BTCUSDT.c.length - 1].time) };
}

/** New trailing stop for a position, or null if it shouldn't move. */
function trailFor(prepared, strategy, pos) {
  const ind = prepared[pos.symbol];
  if (!ind) return null;
  const i = ind.c.length - 1;
  const highestClose = Math.max(pos.highestClose || 0, ind.close[i]);
  const t = STRATEGIES[strategy.family].trail(ind, i, strategy.params, { highestClose });
  return { highestClose, stop: Number.isFinite(t) && t > (pos.stopLossPrice || 0) && t < ind.close[i] ? t : null };
}

/** How many dollars to put in, or a reason not to. */
function size({ equity, cash, entry, stop, open, lastEquity }) {
  const L = cfg.LIMITS;
  if (open >= L.maxOpen) return { skip: `already ${open} auto positions (max ${L.maxOpen})` };
  if (lastEquity && equity < lastEquity * (1 - L.dailyLossPct / 100)) return { skip: `account fell ${r2((1 - equity / lastEquity) * 100)}% since yesterday — no new buys today` };
  const riskUsd = equity * (L.riskPct / 100);
  let usd = (riskUsd / (entry - stop)) * entry;
  usd = Math.min(usd, equity * (L.maxPositionPct / 100), cash * 0.98);
  if (usd < L.minOrderUsd) return { skip: 'not enough cash for the minimum order' };
  return { usd: r2(usd) };
}

// ─── Flags / settings ─────────────────────────────────────────────────────────
async function flags() {
  return store.hashToObject(await store.cmd('HGETALL', K.flags));
}
const isPaused = async () => (await flags()).paused === '1';
const isLiveUnlocked = async () => (await flags()).liveUnlocked === '1';

async function setPractice(chatId, on) {
  await store.cmd(on ? 'SADD' : 'SREM', K.users, String(chatId));
  if (on) await practice.getAccount(chatId); // make sure the account exists
  return on;
}
async function setLive(chatId, on) {
  if (on) {
    if (!(await isLiveUnlocked())) throw new AutoBuyError('Live auto-buy is still locked — it unlocks only after the strategy passes the tests and 8 weeks of profitable practice. See `autobuy`.');
    const st = await accounts.getStatus(chatId);
    if (!st.connected || !st.enabled) throw new AutoBuyError('Connect your Binance account and turn on automated exits first: `golive`.');
  }
  await store.cmd(on ? 'SADD' : 'SREM', K.live, String(chatId));
  return on;
}

/** Forward test (house account) + research verdict → can live be unlocked? */
async function gateStatus() {
  const strategy = currentStrategy();
  const acct = await practice.getAccount(HOUSE, { create: false });
  const trades = acct ? await practice.getTrades(HOUSE) : [];
  const days = acct ? Math.floor((Date.now() - new Date(acct.createdAt).getTime()) / 86_400_000) : 0;
  const pnl = r2(trades.reduce((s, t) => s + (t.pnlDollar || 0), 0));
  let equity = acct?.cash ?? null;
  try { if (acct) equity = (await practice.summary(HOUSE)).equity; } catch { /* keep cash */ }
  const G = cfg.GATE;
  const checks = {
    research: strategy.verdict === G.researchVerdict,
    days: days >= G.forwardDays,
    trades: trades.length >= G.forwardTrades,
    profit: acct ? equity > acct.start : false,
  };
  return {
    strategy, forward: { startedAt: acct?.createdAt || null, days, closedTrades: trades.length, pnlUsd: pnl, equity, start: acct?.start ?? practice.START,
      winRatePct: trades.length ? r2(trades.filter(t => t.pnlDollar > 0).length / trades.length * 100) : null },
    checks, eligible: Object.values(checks).every(Boolean), unlocked: await isLiveUnlocked(), paused: await isPaused(),
    needs: { days: G.forwardDays, trades: G.forwardTrades },
  };
}

async function unlock(adminId) {
  const g = await gateStatus();
  if (!g.eligible) throw new AutoBuyError('Not yet: ' + Object.entries(g.checks).filter(([, ok]) => !ok).map(([k]) => ({ research: 'the strategy needs a PASS from `npm run lab`', days: `the forward test needs ${g.needs.days} days (now ${g.forward.days})`, trades: `it needs ${g.needs.trades} closed trades (now ${g.forward.closedTrades})`, profit: 'it must be in profit after fees' }[k])).join('; '));
  await store.cmd('HSET', K.flags, 'liveUnlocked', '1', 'unlockedAt', new Date().toISOString(), 'unlockedBy', String(adminId));
  return g;
}
async function lock() { await store.cmd('HSET', K.flags, 'liveUnlocked', '0'); }
async function pause(on) { await store.cmd('HSET', K.flags, 'paused', on ? '1' : '0'); }

async function userStatus(chatId) {
  const [pr, lv, g] = await Promise.all([
    store.cmd('SISMEMBER', K.users, String(chatId)), store.cmd('SISMEMBER', K.live, String(chatId)), gateStatus(),
  ]);
  const last = await store.getJSON(K.signals, null);
  return { practiceOn: !!pr, liveOn: !!lv, ...g, lastRun: last, limits: cfg.LIMITS, universe: cfg.universe().map(s => s.replace(/USDT$/, '')) };
}

// ─── Practice accounts ────────────────────────────────────────────────────────
async function runPracticeAccount(chatId, strategy, sig) {
  const msgs = [];
  // 1) Trail the stops of auto-bought positions
  for (const p of (await practice.getPositions(chatId)).filter(x => x.auto)) {
    const t = trailFor(sig.prepared, strategy, p);
    if (t) await practice.raiseStop(chatId, p.id, t.stop ?? p.stopLossPrice, t.highestClose);
    if (t?.stop) msgs.push(`🎮🤖 ${p.symbol.replace('USDT', '')}: trailing stop raised to $${fmtP(t.stop)}`);
  }
  // 2) New buys
  if (!sig.buys.length) return msgs;
  const s = await practice.summary(chatId);
  const lastEquity = Number(await store.cmd('GET', K.lastEq(chatId))) || null;
  const held = new Set(s.positions.filter(p => p.auto).map(p => p.symbol));
  let open = held.size, cash = s.cash;
  for (const b of sig.buys) {
    if (held.has(b.symbol)) continue;
    const z = size({ equity: s.equity, cash, entry: b.close, stop: b.stop, open, lastEquity });
    if (z.skip) { msgs.push(`🎮🤖 Skipped ${b.symbol.replace('USDT', '')}: ${z.skip}`); if (/max|fell/.test(z.skip)) break; continue; }
    try {
      const live = await fetchPrice(b.symbol, { exchange: 'binance' });
      if (!live || b.stop >= live) { msgs.push(`🎮🤖 Skipped ${b.symbol.replace('USDT', '')}: price already at the stop`); continue; }
      const { position, cash: left } = await practice.buy(chatId, { symbol: b.symbol, amount: z.usd, stop: b.stop, strategy });
      cash = left; open++; held.add(b.symbol);
      msgs.push(`🎮🤖 *Auto-bought (practice) ${b.symbol.replace('USDT', '')}:* ${usd(z.usd)} at $${fmtP(position.buyPrice)} · stop $${fmtP(b.stop)} (−${b.stopPct}%, risk ≈ ${cfg.LIMITS.riskPct}% of the account)`);
    } catch (err) { msgs.push(`🎮🤖 Couldn't buy ${b.symbol.replace('USDT', '')}: ${err.message}`); }
  }
  await store.cmd('SET', K.lastEq(chatId), String(s.equity));
  return msgs;
}

// ─── Live accounts (only when unlocked) ──────────────────────────────────────
async function liveEquity(c, positions) {
  const usdt = await c.freeBalance('USDT');
  let inCoins = 0;
  for (const p of positions) {
    const px = await fetchPrice(p.symbol, { exchange: 'binance' }).catch(() => null);
    if (px) inCoins += (p.auto?.remainingQty ?? p.quantity) * px;
  }
  return { usdt, equity: usdt + inCoins };
}

async function runLiveAccount(chatId, strategy, sig) {
  const msgs = [];
  const c = await accounts.getActiveClient(chatId);
  if (!c) return [`🤖 Live auto-buy skipped: automated exits are off. Send \`golive\`.`];
  const mine = Object.values(await ps.getAllPositions(chatId)).filter(p => p.strategy);
  // 1) Trail stops; autoTrader moves the Binance stop order
  for (const p of mine) {
    const t = trailFor(sig.prepared, strategy, p);
    if (!t) continue;
    await ps.updatePosition(chatId, p.positionId, { highestClose: t.highestClose, ...(t.stop ? { stopLossPrice: t.stop, stopStage: 'trail' } : {}) });
    if (t.stop) await autoTrader.sync(chatId, p.positionId);
  }
  if (!sig.buys.length) return msgs;
  // 2) New buys
  const { usdt, equity } = await liveEquity(c, mine);
  const lastEquity = Number(await store.cmd('GET', K.lastEq(`live:${chatId}`))) || null;
  const held = new Set(mine.map(p => p.symbol));
  let open = held.size, cash = usdt;
  for (const b of sig.buys) {
    if (held.has(b.symbol)) continue;
    const z = size({ equity, cash, entry: b.close, stop: b.stop, open, lastEquity });
    if (z.skip) { msgs.push(`🤖 Skipped ${b.symbol.replace('USDT', '')}: ${z.skip}`); if (/max|fell/.test(z.skip)) break; continue; }
    try {
      const rules = await c.symbolRules(b.symbol);
      const o = await c.marketBuy(b.symbol, z.usd.toFixed(2), `cb-ab-${Date.now().toString(36)}`);
      const qtyGross = Number(o.executedQty) || 0;
      if (!(qtyGross > 0)) throw new Error('order not filled');
      const feeInCoin = (o.fills || []).filter(f => f.commissionAsset === rules.baseAsset).reduce((s, f) => s + Number(f.commission), 0);
      const qty = floorToStep(qtyGross - feeInCoin, rules.stepSize);
      const avg = Number(o.cummulativeQuoteQty) / qtyGross;
      const pos = await ps.addPosition({ chatId, symbol: b.symbol, buyPrice: avg, quantity: Number(toFixedStep(qty, rules.stepSize)), stopLossPrice: b.stop, exchange: 'binance' });
      await ps.updatePosition(chatId, pos.positionId, { strategy: strategy.id, stopStage: 'trail', stopSource: 'strategy', highestClose: avg, autoBought: true });
      cash -= z.usd; open++; held.add(b.symbol);
      msgs.push(`🤖 *Auto-bought ${b.symbol.replace('USDT', '')}* on Binance: ${qty} at ~$${fmtP(avg)} (${usd(z.usd)}) · stop $${fmtP(b.stop)} (−${b.stopPct}%)`);
      await autoTrader.sync(chatId, pos.positionId); // puts the stop order on Binance
    } catch (err) { msgs.push(`⚠️ Auto-buy ${b.symbol.replace('USDT', '')} failed: ${err.message}`); }
  }
  await store.cmd('SET', K.lastEq(`live:${chatId}`), String(equity));
  return msgs;
}

// ─── The daily run ────────────────────────────────────────────────────────────
/**
 * @param opts.allowed   Set of chatIds with access (approved / paying)
 * @param opts.send      (chatId, text) => Promise
 * @param opts.force     run even if today's run already happened (admin `autobuy run`)
 */
async function runDaily({ allowed = new Set(), send = async () => {}, force = false, now = new Date() } = {}) {
  if (await isPaused()) return { skipped: 'paused by admin' };
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (!force && mins < cfg.DAILY_RUN_AFTER_UTC_MINUTES) return { skipped: 'waiting for the daily close' };
  const date = now.toISOString().slice(0, 10);
  if (!force && (await store.cmd('SET', K.day(date), '1', 'NX', 'EX', 3 * 86400)) !== 'OK') return { skipped: 'already ran today' };

  const strategy = currentStrategy();
  const sig = await computeSignals(strategy);
  await store.setJSON(K.signals, { date, at: new Date().toISOString(), strategy: strategy.id, verdict: strategy.verdict, regimeUp: sig.regimeUp, buys: sig.buys.map(b => ({ coin: b.symbol.replace('USDT', ''), stopPct: b.stopPct })) });

  const out = { date, strategy: strategy.id, signals: sig.buys.length, practice: 0, live: 0 };
  // House forward test always runs; plus every practice user who switched it on
  const practiceIds = [HOUSE, ...((await store.cmd('SMEMBERS', K.users)) || []).filter(id => allowed.has(String(id)))];
  for (const id of practiceIds) {
    try {
      const msgs = await runPracticeAccount(id, strategy, sig);
      if (id !== HOUSE) for (const m of msgs) await send(id, m);
      out.practice++;
    } catch (err) { console.error('[AutoBuy] practice', id, err.message); }
  }
  if (await isLiveUnlocked()) {
    for (const id of ((await store.cmd('SMEMBERS', K.live)) || []).filter(x => allowed.has(String(x)))) {
      try { for (const m of await runLiveAccount(id, strategy, sig)) await send(id, m); out.live++; }
      catch (err) { console.error('[AutoBuy] live', id, err.message); await send(id, `⚠️ Live auto-buy problem: ${err.message}`); }
    }
  }
  return out;
}

const fmtP = (p) => (p >= 1 ? Number(p).toFixed(4) : Number(p).toPrecision(4));
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = {
  AutoBuyError, HOUSE, currentStrategy, loadResearch, computeSignals, trailFor, size, runDaily,
  setPractice, setLive, gateStatus, unlock, lock, pause, isPaused, isLiveUnlocked, userStatus,
};
