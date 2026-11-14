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
const { STRATEGIES, prepare, makeContext, fmtUsd } = require('../strategies');
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
  running: 'cryptobot:lock:autobuy',
  tries: (d) => `cryptobot:autobuy:tries:${d}`,
  did: (d, id) => `cryptobot:autobuy:did:${d}:${id}`,
  bought: (d, id, sym) => `cryptobot:autobuy:bought:${d}:${id}:${sym}`,
};

class AutoBuyError extends Error {}
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

// ─── Strategy in use ──────────────────────────────────────────────────────────
function loadResearch() {
  const file = process.env.AUTO_STRATEGY_FILE || path.join(__dirname, '..', '..', cfg.STRATEGY_FILE);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The lab's pick (or the tested fallback). This is what runs unless the admin chose another strategy. */
function currentStrategy() {
  const res = loadResearch();
  const pick = res?.pick;
  if (pick && STRATEGIES[pick.family]) {
    return { family: pick.family, params: pick.params, id: pick.id, label: pick.label, name: pick.name, verdict: res.verdict, why: pick.why, test: pick.test, portfolioTest: pick.portfolioTest, period: res.period, tested: true };
  }
  const f = cfg.FALLBACK;
  return { ...f, name: STRATEGIES[f.family].name, label: `${STRATEGIES[f.family].name} — ${STRATEGIES[f.family].describe(f.params)}, only while BTC is above its 100-day average`, verdict: 'NOT TESTED', why: 'the saved lab result (data/auto-strategy.json) is missing — run `npm run lab -- --days 3000` and commit it', tested: false, missingFile: true };
}

/**
 * Strategies the admin can choose with `autobuy strategy NAME`:
 *   breakout  the lab's pick (default)
 *   daily     daily movers: the whole market, every day, 1% stop — NOT proven
 */
function dailyStrategy() {
  const family = 'dailyTop';
  const params = { ...STRATEGIES[family].grid[0], regime: false };
  const s = STRATEGIES[family];
  // If `npm run lab` has tested it, show that result (it is never the lab's pick)
  const lab = loadResearch()?.families?.find(f => f.family === family && f.chosen);
  return {
    family, params, id: `${family}:${params.topN}-${params.stopPct}`, name: s.name,
    label: `${s.name} — ${s.describe(params)}`,
    verdict: lab?.verdict || 'NOT TESTED', test: lab?.test || null, period: lab ? loadResearch()?.period : null,
    why: 'chosen by the admin; not proven to make money after fees', tested: !!lab, chosenByAdmin: true, market: true,
  };
}
/**
 * Strongest coins at 2% risk: the lab's "momentum" family with the settings the
 * lab chose for it (it PASSED on its own), sized at 2% of the account per trade.
 * The lab's 2%-risk comparison is the evidence: +68.8%, worst drop 16.3% on the
 * unseen period (Oct 2026 run) — vs +21.5% / 4.2% for breakout at 1%.
 */
const MOMENTUM_FALLBACK = { id: 'momentum:56-3-4:btc', params: { lookback: 56, topN: 3, k: 4, regime: true } };
function momentumStrategy() {
  const family = 'momentum';
  const res = loadResearch();
  const lab = res?.families?.find(f => f.family === family && f.chosen);
  const chosen = lab?.chosen || MOMENTUM_FALLBACK;
  const s = STRATEGIES[family];
  const riskPct = 2;
  return {
    family, params: chosen.params, id: chosen.id, name: `${s.name} (${riskPct}% risk)`,
    label: `${s.name} — ${s.describe(chosen.params)}${chosen.params.regime ? ', only while BTC is above its 100-day average' : ''}; ${riskPct}% of the account at risk per trade`,
    verdict: lab?.verdict || 'NOT TESTED', test: lab?.test || null, period: res?.period || null,
    portfolio2: res?.comparisons?.risk2?.[family] || null,
    why: 'chosen by the admin from the lab results', tested: !!lab, chosenByAdmin: true, riskPct,
  };
}
const STRATEGY_CHOICES = { breakout: currentStrategy, daily: dailyStrategy, momentum: momentumStrategy };

/** The strategy auto-buy runs today: the admin's choice, else the lab's pick. */
async function activeStrategy() {
  const f = await flags().catch(() => ({}));
  const pick = STRATEGY_CHOICES[f.strategy];
  return pick ? pick() : currentStrategy();
}

/** Which choice is in use: 'breakout' (default), 'momentum' or 'daily'. */
async function strategyKey() {
  const f = await flags().catch(() => ({}));
  return STRATEGY_CHOICES[f.strategy] ? f.strategy : 'breakout';
}

/**
 * Admin: switch strategy. The house forward test starts again from $10,000,
 * because its results must belong to the strategy that is running.
 */
async function setStrategy(name) {
  const key = String(name || '').toLowerCase();
  if (!STRATEGY_CHOICES[key]) throw new AutoBuyError(`Unknown strategy "${name}". Choose: ${Object.keys(STRATEGY_CHOICES).join(', ')}`);
  await store.cmd('HSET', K.flags, 'strategy', key);
  await practice.reset(HOUSE).catch(() => {});
  return STRATEGY_CHOICES[key]();
}

/** For strategies with a fixed % stop (daily movers): that %, as a fraction; else null. */
function fixedPct(strategy) {
  const f = STRATEGIES[strategy?.family]?.fixedStopPct;
  const v = f ? Number(f(strategy.params)) : NaN;
  return v > 0 && v < 50 ? v / 100 : null;
}

// ─── Signals (one computation per day, shared by everyone) ───────────────────
async function computeSignals(strategy, { symbols = null } = {}) {
  const S = STRATEGIES[strategy.family];
  let list = symbols;
  let market = null;
  if (!list) {
    if (S.market) {
      market = await require('./listingsService').getMarketUniverse().catch(err => { throw new AutoBuyError(`couldn't read the Binance market: ${err.message}`); });
      list = market.symbols;
    } else list = cfg.universe();
  }
  const minLen = S.minCandles || 120;
  const syms = [...new Set(['BTCUSDT', ...list])];
  const prepared = {};
  await mapLimit(syms, 8, async (s) => {
    try {
      const c = await fetchKlines(s, '1d', S.market && s !== 'BTCUSDT' ? 60 : 300, { closedOnly: true, exchange: 'binance' });
      if (c.length >= minLen) prepared[s] = Object.assign(prepare(c), { symbol: s });
    } catch { /* coin skipped today */ }
  });
  if (!prepared.BTCUSDT) throw new AutoBuyError('no BTC daily data — skipped today');
  const ctx = makeContext(prepared, prepared.BTCUSDT);
  const s = STRATEGIES[strategy.family];
  const p = strategy.params;
  const buys = [];
  const analysis = {};
  const btcLast = prepared.BTCUSDT.c[prepared.BTCUSDT.c.length - 1];
  const btc = ctx.btcAt(btcLast.time);
  const regimeUp = ctx.btcUp(btcLast.time);
  // Wording only — a formatting problem must never stop the day's check
  let regimeText = 'BTC\'s 100-day average isn\'t available';
  try {
    if (btc && btc.sma100) regimeText = `BTC ${fmtUsd(btc.close)} is ${regimeUp ? 'above' : 'below'} its 100-day average ${fmtUsd(btc.sma100)}`;
  } catch { regimeText = `BTC is ${regimeUp ? 'above' : 'below'} its 100-day average`; }
  for (const sym of list) {
    const ind = prepared[sym];
    if (!ind) { analysis[sym] = { signal: false, reason: 'not enough daily price history on Binance' }; continue; }
    const i = ind.c.length - 1;
    const ref = ind.close[i];
    const stop = i >= 20 ? s.initialStop(ind, i, p, ref) : null;
    const base = { close: ref, stop: Number.isFinite(stop) && stop > 0 && stop < ref ? stop : null, date: new Date(ind.c[i].time).toISOString().slice(0, 10) };
    if (base.stop) base.stopPct = r2((1 - base.stop / ref) * 100);
    if (i < s.warmup) { analysis[sym] = { ...base, signal: false, reason: 'too new — not enough price history for the strategy' }; continue; }
    let ex = { text: null, gap: null };
    try { if (s.explain) ex = s.explain(ind, i, p, ctx); } catch { /* explanation is extra */ }
    base.why = ex.text;
    base.gapPct = Number.isFinite(ex.gap) ? r2(ex.gap * 100) : null;
    if (Number.isFinite(ex.rank)) base.rank = ex.rank;
    if (Number.isFinite(ex.movePct)) base.movePct = r2(ex.movePct * 100);
    if (p.regime && !ctx.btcUp(ind.c[i].time)) { analysis[sym] = { ...base, signal: false, reason: 'the market filter is off: BTC is below its 100-day average' }; continue; }
    if (!s.entry(ind, i, p, ctx)) { analysis[sym] = { ...base, signal: false, reason: `no buy signal today (the strategy needs: ${s.describe(p).split(';')[0]})` }; continue; }
    analysis[sym] = { ...base, signal: true, reason: 'the strategy has a buy signal today' };
    if (base.stop) buys.push({ symbol: sym, close: ref, stop: base.stop, stopPct: base.stopPct, why: base.why, rank: base.rank });
  }
  // Ranked strategies buy the best-ranked first (the 5-position limit may stop the rest)
  buys.sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity));
  return { prepared, buys, analysis, regimeUp, regimeText, regimeOn: !!p.regime, symbols: list, marketSize: market?.total ?? null, minVolUsd: market?.minVolUsd ?? null };
}

// ─── Plain-words explanations for every buy ──────────────────────────────────
const coinOf = (sym) => sym.replace(/USDT$/, '');

/** "Why the bot bought X" — the signal, the market filter and the test result. */
function whyLines(b, strategy, sig) {
  const lines = [];
  if (b.why) lines.push(`• ${b.why}`);
  if (sig.regimeOn) lines.push(`• Market filter: ${sig.regimeText} — the strategy only buys while BTC is in an up-trend`);
  const t = strategy.test;
  if (strategy.chosenByAdmin && !(strategy.tested && t)) lines.push(`• Strategy test: ⚠️ not proven — chosen by the admin; no test has shown it makes money after fees`);
  else if (strategy.tested && t) lines.push(`• Strategy test: ${strategy.verdict === 'PASS' ? 'PASSED' : strategy.verdict} — on ${t.trades} past trades it was never tuned on, each trade made on average ${t.expectancyR >= 0 ? '+' : ''}${Number(t.expectancyR).toFixed(2)}× the amount it risked, after fees (losing trades included)`);
  else lines.push(`• Strategy test: not tested yet (the saved lab results are missing)`);
  if (sig.marketSize) lines.push(`• Picked from the whole Binance market: ${sig.marketSize} coins with $${Math.round((sig.minVolUsd || 0) / 1e6)}M+ traded in a day`);
  return lines;
}

function sizeLine(z, equity) {
  const cap = z.capped === 'position' ? ` (capped at ${cfg.LIMITS.maxPositionPct}% of the account for one coin)` : z.capped === 'cash' ? ' (all the cash available)' : '';
  const pctOfAcct = equity > 0 ? r2((z.riskUsd / equity) * 100) : cfg.LIMITS.riskPct;
  return `*Why this amount:* if the stop is hit you lose about ${usd(z.riskUsd)} — ${pctOfAcct}% of your ${usd(equity)} account${cap}.`;
}

/** The full "auto-bought" message (practice, house or real). */
function buyMessage({ mode, b, strategy, sig, z, equity, price, qty }) {
  const coin = coinOf(b.symbol);
  const head = mode === 'live' ? `💰 REAL · 🤖 *Auto-bought ${coin}* on Binance`
    : mode === 'house' ? `🏠 HOUSE forward test · 🤖 *Auto-bought ${coin}* (play money)`
    : `🎮 PRACTICE · 🤖 *Auto-bought ${coin}* (play money)`;
  const stopPct = r2((1 - b.stop / price) * 100);
  return [
    head,
    `${+Number(qty).toFixed(8)} ${coin} at ~$${fmtP(price)} (${usd(z.usd)}) · stop $${fmtP(b.stop)} (−${stopPct}%)`,
    ``,
    `*Why the bot bought ${coin}:*`,
    ...whyLines(b, strategy, sig),
    ``,
    sizeLine(z, equity),
    `*How it sells:* ${STRATEGIES[strategy.family].exitText ? STRATEGIES[strategy.family].exitText(strategy.params) : 'by a trailing stop that only moves up'}.`,
  ].join('\n');
}

/** Why nothing was bought today — the market filter, or the coins closest to a signal. */
function noBuyMessage(date, strategy, sig) {
  const lines = [`🛒 *Auto-buy check — ${date}*`, ``, `No coin to buy today.`];
  if (sig.regimeOn && !sig.regimeUp) {
    lines.push(`*Why:* ${sig.regimeText}. The strategy only buys while BTC is above it, to stay out of falling markets.`);
  } else {
    lines.push(`*Why:* none of the ${Object.keys(sig.analysis).length} coins gave a buy signal (${STRATEGIES[strategy.family].describe(strategy.params).split(';')[0]}).`);
    const near = Object.entries(sig.analysis).filter(([, a]) => a.gapPct > 0).sort((x, y) => x[1].gapPct - y[1].gapPct).slice(0, 3);
    if (near.length) lines.push(`*Closest:* ${near.map(([s, a]) => `${coinOf(s)} needs +${a.gapPct}%`).join(' · ')}`);
  }
  lines.push(``, STRATEGIES[strategy.family].market
    ? `_Next check: tomorrow just after 1am Lagos time._`
    : `_Signals are rare with this strategy — in testing about 3 a month across all coins, with some weeks having none. Waiting is part of the plan. Next check: tomorrow just after 1am Lagos time._`);
  return lines.join('\n');
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

/**
 * Trails each held position with ITS OWN strategy (a coin bought by breakout
 * keeps its breakout stop after the admin switches to daily movers, and the
 * other way round). Coins missing from today's data are fetched once.
 */
function makeTrailer(active, sig) {
  const lab = currentStrategy();
  const known = new Map([[cfg.FALLBACK.id, { ...cfg.FALLBACK }], [MOMENTUM_FALLBACK.id, { family: 'momentum', ...MOMENTUM_FALLBACK }], [lab.id, lab], [dailyStrategy().id, dailyStrategy()], [momentumStrategy().id, momentumStrategy()], [active.id, active]]);
  const cache = new Map();
  return async (pos) => {
    const strat = known.get(pos.strategy);
    if (!strat || !STRATEGIES[strat.family]) return null;
    const need = Math.max(STRATEGIES[strat.family].warmup || 0, 21);
    let ind = strat.id === active.id ? sig.prepared[pos.symbol] : null;
    if (!ind || ind.c.length < need) {
      if (!cache.has(pos.symbol)) {
        cache.set(pos.symbol, fetchKlines(pos.symbol, '1d', 300, { closedOnly: true, exchange: 'binance' })
          .then(c => (c.length ? Object.assign(prepare(c), { symbol: pos.symbol }) : null)).catch(() => null));
      }
      ind = await cache.get(pos.symbol);
    }
    return ind ? trailFor({ [pos.symbol]: ind }, strat, pos) : null;
  };
}

/**
 * Auto-buy buys a coin at most ONCE per account per day. Holding the coin isn't
 * enough of a check: with a tight stop (daily movers) a coin is often sold within
 * hours, and a second check the same day (`autobuy run`, a retry, or two checks
 * at the same moment) would buy it again. This claim is atomic (SET NX), so two
 * checks running together can't both get it. Released if the buy fails.
 */
async function claimBuy(date, accountId, symbol) {
  return (await store.cmd('SET', K.bought(date, accountId, symbol), '1', 'NX', 'EX', 3 * 86400).catch(() => 'OK')) === 'OK';
}
async function releaseBuy(date, accountId, symbol) {
  await store.cmd('DEL', K.bought(date, accountId, symbol)).catch(() => {});
}

/** How many dollars to put in, or a reason not to. */
function size({ equity, cash, entry, stop, open, lastEquity, riskPct = null }) {
  const L = { ...cfg.LIMITS, ...(riskPct > 0 && riskPct <= 5 ? { riskPct } : {}) };
  if (open >= L.maxOpen) return { skip: `already ${open} auto positions (max ${L.maxOpen})` };
  if (lastEquity && equity < lastEquity * (1 - L.dailyLossPct / 100)) return { skip: `account fell ${r2((1 - equity / lastEquity) * 100)}% since yesterday — no new buys today` };
  const riskUsd = equity * (L.riskPct / 100);
  const wanted = (riskUsd / (entry - stop)) * entry;
  const maxPos = equity * (L.maxPositionPct / 100);
  const maxCash = cash * 0.98;
  const usd = Math.min(wanted, maxPos, maxCash);
  if (usd < L.minOrderUsd) return { skip: 'not enough cash for the minimum order' };
  const capped = usd < wanted - 0.005 ? (usd === maxCash ? 'cash' : 'position') : null;
  // What is actually at risk if the stop is hit (smaller when the size was capped)
  return { usd: r2(usd), riskUsd: r2(usd * (1 - stop / entry)), capped };
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
    if (!(await isLiveUnlocked())) throw new AutoBuyError('Live auto-buy hasn\'t been opened by the admin yet. See `autobuy` for the forward-test progress.');
    const st = await accounts.getStatus(chatId);
    if (!st.connected || !st.enabled) throw new AutoBuyError('Connect your Binance account and turn on automated exits first: `golive`.');
  }
  await store.cmd(on ? 'SADD' : 'SREM', K.live, String(chatId));
  return on;
}

/** Forward test (house account) + research verdict → can live be unlocked? */
async function gateStatus() {
  const strategy = await activeStrategy();
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
    unlockedEarly: (await flags()).early === '1',
    needs: { days: G.forwardDays, trades: G.forwardTrades },
  };
}

/** What's still missing from the forward test, in plain words. */
function missing(g) {
  return Object.entries(g.checks).filter(([, ok]) => !ok).map(([k]) => ({
    research: 'the strategy needs a PASS from `npm run lab`',
    days: `${g.needs.days}+ days of forward testing (now ${g.forward.days})`,
    trades: `${g.needs.trades}+ closed trades (now ${g.forward.closedTrades})`,
    profit: 'a profit after fees',
  }[k]));
}

/**
 * The admin opens live auto-buy. Allowed before the forward test is complete
 * (the admin's choice, e.g. to test it on their own money first) — but it's
 * recorded as early, and everyone sees the forward-test status before opting in.
 */
async function unlock(adminId) {
  const g = await gateStatus();
  await store.cmd('HSET', K.flags, 'liveUnlocked', '1', 'unlockedAt', new Date().toISOString(), 'unlockedBy', String(adminId), 'early', g.eligible ? '0' : '1');
  return { ...g, early: !g.eligible, missing: missing(g) };
}
async function lock() { await store.cmd('HSET', K.flags, 'liveUnlocked', '0'); }
async function pause(on) { await store.cmd('HSET', K.flags, 'paused', on ? '1' : '0'); }

async function userStatus(chatId) {
  const [pr, lv, g] = await Promise.all([
    store.cmd('SISMEMBER', K.users, String(chatId)), store.cmd('SISMEMBER', K.live, String(chatId)), gateStatus(),
  ]);
  const last = await store.getJSON(K.signals, null);
  const universe = STRATEGIES[g.strategy.family].market ? ['the whole Binance market'] : cfg.universe().map(s => s.replace(/USDT$/, ''));
  return { practiceOn: !!pr, liveOn: !!lv, ...g, lastRun: last, limits: cfg.LIMITS, universe };
}

/**
 * What a user who switches auto-buy on right now should know about today:
 * has today's check run, what did it find, and when is their first check.
 */
async function todayCheck(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const last = await store.getJSON(K.signals, null);
  const ranToday = last && last.date === date;
  if (!ranToday) {
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const when = mins < cfg.DAILY_RUN_AFTER_UTC_MINUTES ? 'just after 1am Lagos time (in a few minutes)' : 'within the next 30 minutes (today\'s check hasn\'t run yet)';
    return { ranToday: false, text: `*Your first check:* ${when}.` };
  }
  const lines = [`*Today's check already ran (${date}):* `];
  if (last.buys?.length) {
    const coins = last.buys.map(b => b.coin);
    lines[0] += `buy signal${coins.length > 1 ? 's' : ''} for ${coins.join(', ')}.`;
    lines.push(`Those were bought for accounts that had auto-buy on. To try ${coins.length > 1 ? 'one' : 'it'} now: \`practice buynow ${coins[0]} 500\`.`);
  } else {
    lines[0] += `no buy signals${last.regimeUp === false && last.regimeOn !== false ? ' — BTC is below its 100-day average, so the strategy is waiting' : ''}.`;
  }
  lines.push(`*Your first check:* tomorrow just after 1am Lagos time.`);
  return { ranToday: true, signals: last.buys?.length || 0, text: lines.join('\n') };
}

// ─── Practice accounts ────────────────────────────────────────────────────────
async function runPracticeAccount(chatId, strategy, sig, { buy = true, trail = makeTrailer(strategy, sig), date = today() } = {}) {
  const msgs = [];
  const bought = [];
  const fp = fixedPct(strategy);
  // 1) Trail the stops of auto-bought positions
  for (const p of (await practice.getPositions(chatId)).filter(x => x.auto)) {
    const t = await trail(p);
    if (t) await practice.raiseStop(chatId, p.id, t.stop ?? p.stopLossPrice, t.highestClose);
    if (t?.stop) msgs.push(`🎮🤖 ${p.symbol.replace('USDT', '')}: trailing stop raised to $${fmtP(t.stop)}`);
  }
  // 2) New buys
  if (!buy || !sig.buys.length) return Object.assign(msgs, { bought });
  const s = await practice.summary(chatId);
  const lastEquity = Number(await store.cmd('GET', K.lastEq(chatId))) || null;
  const held = new Set(s.positions.filter(p => p.auto).map(p => p.symbol));
  let open = held.size, cash = s.cash;
  for (const b of sig.buys) {
    if (held.has(b.symbol)) continue;
    const z = size({ equity: s.equity, cash, entry: b.close, stop: b.stop, open, lastEquity, riskPct: strategy.riskPct });
    if (z.skip) { msgs.push(`🎮🤖 Skipped ${b.symbol.replace('USDT', '')}: ${z.skip}`); if (/max|fell/.test(z.skip)) break; continue; }
    if (!(await claimBuy(date, `p:${chatId}`, b.symbol))) { msgs.push(`🎮🤖 Skipped ${coinOf(b.symbol)}: already auto-bought today (once per coin per day)`); continue; }
    try {
      const live = await fetchPrice(b.symbol, { exchange: 'binance' });
      const stop = fp && live ? live * (1 - fp) : b.stop; // a fixed % stop is set from today's price, not yesterday's close
      if (!live || stop >= live) { await releaseBuy(date, `p:${chatId}`, b.symbol); msgs.push(`🎮🤖 Skipped ${b.symbol.replace('USDT', '')}: price already at the stop`); continue; }
      const { position, cash: left } = await practice.buy(chatId, { symbol: b.symbol, amount: z.usd, stop, strategy, why: b.why, trailPct: fp });
      cash = left; open++; held.add(b.symbol);
      bought.push(coinOf(b.symbol));
      msgs.push(buyMessage({ mode: chatId === HOUSE ? 'house' : 'practice', b: { ...b, stop: position.stopLossPrice }, strategy, sig, z, equity: s.equity, price: position.buyPrice, qty: position.quantity }));
    } catch (err) { await releaseBuy(date, `p:${chatId}`, b.symbol); msgs.push(`🎮🤖 Couldn't buy ${b.symbol.replace('USDT', '')}: ${err.message}`); }
  }
  await store.cmd('SET', K.lastEq(chatId), String(s.equity));
  return Object.assign(msgs, { bought });
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

/** Market-buy on Binance, save the position with the strategy's stop, put the stop order on Binance. */
async function liveBuy(chatId, c, { symbol, usd: spend, stop, strategy, autoBought = false, signal = null, why = null, trailPct = null }) {
  const rules = await c.symbolRules(symbol);
  const o = await c.marketBuy(symbol, Number(spend).toFixed(2), `cb-${autoBought ? 'ab' : 'bn'}-${Date.now().toString(36)}`);
  const qtyGross = Number(o.executedQty) || 0;
  if (!(qtyGross > 0)) throw new Error('order not filled');
  const feeInCoin = (o.fills || []).filter(f => f.commissionAsset === rules.baseAsset).reduce((t, f) => t + Number(f.commission), 0);
  const qty = floorToStep(qtyGross - feeInCoin, rules.stepSize);
  const avg = Number(o.cummulativeQuoteQty) / qtyGross;
  if (trailPct) stop = avg * (1 - trailPct); // fixed % stop: from the price actually paid
  const pos = await ps.addPosition({ chatId, symbol, buyPrice: avg, quantity: Number(toFixedStep(qty, rules.stepSize)), stopLossPrice: stop, exchange: 'binance' });
  await ps.updatePosition(chatId, pos.positionId, { strategy: strategy.id, stopStage: 'trail', stopSource: 'strategy', highestClose: avg, autoBought, ...(trailPct ? { trailPct, highWater: avg } : {}), ...(signal !== null ? { boughtWithSignal: signal } : {}), ...(why ? { buyReason: why } : {}) });
  await autoTrader.sync(chatId, pos.positionId); // puts the stop order on Binance
  return { qty, avg, stop, positionId: pos.positionId };
}

async function runLiveAccount(chatId, strategy, sig, { buy = true, trail = makeTrailer(strategy, sig), date = today() } = {}) {
  const msgs = [];
  const bought = [];
  const fp = fixedPct(strategy);
  const c = await accounts.getActiveClient(chatId);
  if (!c) return Object.assign(buy ? [`🤖 Live auto-buy skipped: auto-trading is off. Send \`golive\`.`] : [], { bought });
  const mine = Object.values(await ps.getAllPositions(chatId)).filter(p => p.strategy);
  // 1) Trail stops; autoTrader moves the Binance stop order
  for (const p of mine) {
    const t = await trail(p);
    if (!t) continue;
    await ps.updatePosition(chatId, p.positionId, { highestClose: t.highestClose, ...(t.stop ? { stopLossPrice: t.stop, stopStage: 'trail' } : {}) });
    if (t.stop) await autoTrader.sync(chatId, p.positionId);
  }
  if (!buy || !sig.buys.length) return Object.assign(msgs, { bought });
  // 2) New buys
  const { usdt, equity } = await liveEquity(c, mine);
  const lastEquity = Number(await store.cmd('GET', K.lastEq(`live:${chatId}`))) || null;
  const held = new Set(mine.map(p => p.symbol));
  // Leave alone the USDT a weekly savings buy due within a day will need
  const reserved = await require('./savingsPlan').reservedUsd(chatId).catch(() => 0);
  let open = held.size, cash = Math.max(0, usdt - reserved);
  for (const b of sig.buys) {
    if (held.has(b.symbol)) continue;
    const z = size({ equity, cash, entry: b.close, stop: b.stop, open, lastEquity, riskPct: strategy.riskPct });
    if (z.skip) { msgs.push(`🤖 Skipped ${b.symbol.replace('USDT', '')}: ${z.skip}`); if (/max|fell/.test(z.skip)) break; continue; }
    if (!(await claimBuy(date, `l:${chatId}`, b.symbol))) { msgs.push(`🤖 Skipped ${coinOf(b.symbol)}: already auto-bought today (once per coin per day)`); continue; }
    try {
      const { qty, avg, stop } = await liveBuy(chatId, c, { symbol: b.symbol, usd: z.usd, stop: b.stop, strategy, autoBought: true, why: b.why, trailPct: fp });
      cash -= z.usd; open++; held.add(b.symbol);
      bought.push(coinOf(b.symbol));
      msgs.push(buyMessage({ mode: 'live', b: { ...b, stop }, strategy, sig, z, equity, price: avg, qty }));
    } catch (err) { await releaseBuy(date, `l:${chatId}`, b.symbol); msgs.push(`⚠️ Auto-buy ${b.symbol.replace('USDT', '')} failed: ${err.message}`); }
  }
  await store.cmd('SET', K.lastEq(`live:${chatId}`), String(equity));
  return Object.assign(msgs, { bought });
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
  const admin = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID) : null;

  // The day only counts as done once the check has SUCCEEDED. A failed check
  // (no prices, a timeout) is retried by the next monitor run, up to 6 times.
  if (!force) {
    if (await store.cmd('GET', K.day(date))) return { skipped: 'already ran today' };
    if (!(await store.lock(K.running, 300).catch(() => true))) return { skipped: 'already running' };
  }
  const tries = force ? 0 : Number(await store.cmd('INCR', K.tries(date)).catch(() => 1)) || 1;
  if (!force && tries === 1) await store.cmd('EXPIRE', K.tries(date), 3 * 86400).catch(() => {});
  if (!force && tries > MAX_TRIES) { await store.cmd('DEL', K.running).catch(() => {}); return { skipped: `gave up after ${MAX_TRIES} failed tries today` }; }

  try {
    const strategy = await activeStrategy();
    let sig;
    try {
      sig = await computeSignals(strategy);
    } catch (err) {
      const head = force ? `${date}, your \`autobuy run\`` : `${date}, try ${tries} of ${MAX_TRIES}`;
      const next = force ? 'Nothing was bought. Send `autobuy run` to try again.'
        : tries < MAX_TRIES ? 'It will try again in about 30 minutes.' : 'No more automatic tries today — send `autobuy run` to try by hand.';
      if (admin) await send(admin, `⚠️ *Auto-buy check failed* (${head}): ${err.message}\n${next}`).catch(() => {});
      throw err;
    }
    await store.setJSON(K.signals, { date, at: new Date().toISOString(), strategy: strategy.id, verdict: strategy.verdict, regimeUp: sig.regimeUp, regimeOn: sig.regimeOn, regimeText: sig.regimeText, marketSize: sig.marketSize, buys: sig.buys.map(b => ({ coin: coinOf(b.symbol), stopPct: b.stopPct, why: b.why })) });

    const out = { date, strategy: strategy.id, signals: sig.buys.length, practice: 0, live: 0, summaries: 0, bought: {} };
    const trail = makeTrailer(strategy, sig); // shared, so each coin's history is fetched once
    // Each account is handled once a day, even if a retry runs after a timeout
    const once = async (id) => force || (await store.cmd('SET', K.did(date, id), '1', 'NX', 'EX', 3 * 86400).catch(() => 'OK')) === 'OK';

    // End of the trading day: everyone's result for the day that just closed
    if (!force && (await once('summaries'))) out.summaries = await sendDailySummaries({ allowed, send, now }).catch(err => { console.error('[AutoBuy] summary', err.message); return 0; });

    // Practice: trail every strategy position; buy only for the house + users who switched auto-buy on
    const practiceOn = new Set(((await store.cmd('SMEMBERS', K.users)) || []).map(String));
    const practiceIds = [HOUSE, ...(await practice.allUsers()).filter(id => id !== HOUSE && allowed.has(String(id)))];
    for (const id of practiceIds) {
      if (!(await once(`p:${id}`))) continue;
      try {
        const msgs = await runPracticeAccount(id, strategy, sig, { buy: id === HOUSE || practiceOn.has(String(id)), trail, date });
        // The house account sends no messages of its own: its buys are listed in
        // the admin's daily report (🏠 house: …) and its results in `autobuy`.
        if (id !== HOUSE) for (const m of msgs) await send(id, m);
        if (msgs.bought?.length) out.bought[id === HOUSE ? 'house' : `practice:${id}`] = msgs.bought;
        out.practice++;
      } catch (err) { console.error('[AutoBuy] practice', id, err.message); }
    }

    // Live: trail every strategy position (incl. `buynow` buys); auto-buy only when opened + opted in
    const unlocked = await isLiveUnlocked();
    const liveOn = new Set(((await store.cmd('SMEMBERS', K.live)) || []).map(String));
    for (const id of allowed) {
      const hasStrategyPos = Object.values(await ps.getAllPositions(id)).some(p => p.strategy);
      const buy = unlocked && liveOn.has(String(id));
      if (!hasStrategyPos && !buy) continue;
      if (!(await once(`l:${id}`))) continue;
      try {
        const msgs = await runLiveAccount(id, strategy, sig, { buy, trail, date });
        for (const m of msgs) await send(id, m);
        if (msgs.bought?.length) out.bought[`live:${id}`] = msgs.bought;
        out.live++;
      } catch (err) { console.error('[AutoBuy] live', id, err.message); await send(id, `⚠️ Auto-trading problem: ${err.message}`); }
    }

    // Everyone with auto-buy on who got nothing today hears why (once a day)
    if (!sig.buys.length) {
      const watchers = new Set([...practiceOn, ...(unlocked ? liveOn : [])].filter(id => allowed.has(id) && id !== admin));
      const text = noBuyMessage(date, strategy, sig);
      for (const id of watchers) if (await once(`n:${id}`)) await send(id, text).catch(() => {});
    }

    // The admin's daily report: signals with reasons, and what each account bought
    if (admin && (await once('report'))) await send(admin, adminReport(date, strategy, sig, out)).catch(() => {});

    if (!force) await store.cmd('SET', K.day(date), '1', 'EX', 3 * 86400);
    return out;
  } finally {
    if (!force) await store.cmd('DEL', K.running).catch(() => {});
  }
}

const MAX_TRIES = 6;

function adminReport(date, strategy, sig, out) {
  const warn = strategy.chosenByAdmin ? (strategy.verdict === 'PASS' ? '' : ` — ⚠️ chosen by you, lab verdict: ${strategy.verdict}`) : strategy.tested ? '' : ' — ⚠️ NOT TESTED: data/auto-strategy.json is missing, run `npm run lab`';
  const lines = [`📋 *Auto-buy daily check — ${date}*`, `_${strategy.label}${warn}_`, ``];
  if (sig.regimeOn) lines.push(`${sig.regimeUp ? '🟢' : '🔴'} Market filter: ${sig.regimeText}`);
  if (sig.buys.length) {
    lines.push(`✅ *Buy signals (${sig.buys.length}):*`);
    for (const b of sig.buys) lines.push(`• *${coinOf(b.symbol)}* — ${b.why || 'signal'} · stop −${b.stopPct}%`);
  } else {
    lines.push(noBuyMessage(date, strategy, sig).split('\n').slice(3, 5).join('\n'));
  }
  const who = Object.entries(out.bought);
  lines.push(``, who.length
    ? `🛒 *Bought:* ${who.map(([k, coins]) => `${k === 'house' ? '🏠 house' : k.startsWith('live:') ? `💰 ${k.slice(5)}` : `🎮 ${k.slice(9)}`}: ${coins.join(', ')}`).join(' · ')}`
    : `🛒 Nothing bought today.`);
  lines.push(`_${out.practice} practice account(s) checked · ${out.live} live account(s)_`);
  return lines.filter(x => x !== '').join('\n');
}

// ─── Buy now (the user picks the coin; the strategy manages the exit) ────────
/** Does the strategy agree with buying this coin today? */
async function analyseCoin(symbol) {
  const strategy = await activeStrategy();
  const sym = String(symbol).toUpperCase().replace(/USDT$/, '') + 'USDT';
  if (STRATEGIES[strategy.family].market) {
    // Ranking needs the whole market: use today's saved picks instead of re-scanning it
    const sig = await computeSignals(strategy, { symbols: [sym] });
    const a = sig.analysis[sym] || {};
    const last = await store.getJSON(K.signals, null);
    const picked = !!(last && last.date === today() && last.strategy === strategy.id && last.buys?.some(b => b.coin === coinOf(sym)));
    return { strategy, symbol: sym, ...a, signal: picked && !!a.stop,
      reason: picked ? 'one of today\'s picks' : (a.reason && !a.stop ? a.reason : 'not one of today\'s picks (the bot buys the coins that rose most yesterday)') };
  }
  // Momentum ranks need the whole coin list; the others need just the coin (+ BTC)
  const symbols = STRATEGIES[strategy.family].cross ? [...new Set([...cfg.universe(), sym])] : [sym];
  const sig = await computeSignals(strategy, { symbols });
  return { strategy, symbol: sym, ...sig.analysis[sym] };
}

/**
 * Buy a coin the user chose, now, and manage it with the strategy's stop.
 * mode 'practice' uses play money; 'live' buys on the user's Binance account.
 */
async function buyNow(chatId, { symbol, amount, mode }) {
  const spend = Number(String(amount ?? '').replace(/[$,]/g, ''));
  if (!(spend >= cfg.LIMITS.minOrderUsd)) throw new AutoBuyError(`Enter how many dollars to spend (at least $${cfg.LIMITS.minOrderUsd}), e.g. \`buynow SOL 50\``);
  const a = await analyseCoin(symbol);
  if (!a.stop) throw new AutoBuyError(`Can't buy ${a.symbol.replace('USDT', '')} this way: ${a.reason}.`);
  const live = await fetchPrice(a.symbol, { exchange: 'binance' });
  if (!live) throw new AutoBuyError(`${a.symbol.replace('USDT', '')} isn't on Binance.`);
  const fp = fixedPct(a.strategy);
  if (fp) { a.stop = live * (1 - fp); a.stopPct = r2(fp * 100); } // fixed % stop: from today's price
  if (a.stop >= live) throw new AutoBuyError(`The price is already at the strategy's stop ($${fmtP(a.stop)}) — not a good moment to buy.`);
  const maxPct = cfg.LIMITS.maxPositionPct / 100;

  if (mode === 'practice') {
    const s = await practice.summary(chatId);
    if (spend > s.equity * maxPct + 0.01) throw new AutoBuyError(`That's more than ${cfg.LIMITS.maxPositionPct}% of your practice account — the most for one coin is ${usd(s.equity * maxPct)}.`);
    const { position } = await practice.buy(chatId, { symbol: a.symbol, amount: spend, stop: a.stop, strategy: a.strategy, trailPct: fp });
    if (fp) a.stop = position.stopLossPrice;
    return { analysis: a, price: position.buyPrice, qty: position.quantity, spend };
  }

  const c = await accounts.getActiveClient(chatId);
  if (!c) throw new AutoBuyError('Turn on auto-trading first: `golive`.');
  const mine = Object.values(await ps.getAllPositions(chatId)).filter(p => p.strategy);
  const { usdt, equity } = await liveEquity(c, mine);
  if (spend > usdt) throw new AutoBuyError(`You have ${usd(usdt)} USDT in your Spot wallet. Move more from Funding to Spot, or buy less.`);
  if (spend > equity * maxPct + 0.01) throw new AutoBuyError(`That's more than ${cfg.LIMITS.maxPositionPct}% of your account (${usd(equity)}) — the most for one coin is ${usd(equity * maxPct)}.`);
  const r = await liveBuy(chatId, c, { symbol: a.symbol, usd: spend, stop: a.stop, strategy: a.strategy, signal: a.signal, trailPct: fp });
  a.stop = r.stop;
  return { analysis: a, price: r.avg, qty: r.qty, spend };
}

/** Today's stop and signal for every coin the strategy trades. */
async function coinTable() {
  const strategy = await activeStrategy();
  if (STRATEGIES[strategy.family].market) {
    // Daily movers: the 15 coins that rose most yesterday across the market
    const sig = await computeSignals(strategy);
    const rows = sig.symbols.map(sym => ({ coin: coinOf(sym), ...sig.analysis[sym] }))
      .filter(r => Number.isFinite(r.rank)).sort((x, y) => x.rank - y.rank).slice(0, 15);
    return { strategy, regimeUp: sig.regimeUp, regimeOn: sig.regimeOn, market: true, marketSize: sig.marketSize, rows, at: new Date().toISOString() };
  }
  const symbols = cfg.universe();
  const sig = await computeSignals(strategy, { symbols });
  const rows = symbols.map(sym => ({ coin: sym.replace(/USDT$/, ''), ...sig.analysis[sym] }));
  return { strategy, regimeUp: sig.regimeUp, regimeOn: sig.regimeOn, rows, at: new Date().toISOString() };
}

// ─── End-of-day results ──────────────────────────────────────────────────────
/**
 * After the daily close, tell every user how the day went: real trades and
 * practice trades closed during the day. A losing day gets an honest apology
 * and the reassurance that the plan carries on — never pressure to trade more.
 */
async function sendDailySummaries({ allowed, send, now = new Date() }) {
  const profit = require('./profitTracker');
  const day = new Date(now.getTime() - 3_600_000); // the day that just ended
  const label = day.toISOString().slice(0, 10);
  let sent = 0;
  for (const id of allowed) {
    const real = profit.todaySummary(await profit.getAllTrades(id), day);
    const prac = (await practice.getAccount(id, { create: false })) ? profit.todaySummary(await practice.getTrades(id), day) : { count: 0 };
    if (!real.count && !prac.count) continue;
    const msg = dailyMessage(label, real, prac);
    await send(id, msg);
    sent++;
  }
  return sent;
}

function dailyMessage(label, real, prac) {
  const money = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
  const line = (d) => `${d.count} trade${d.count === 1 ? '' : 's'} closed · ${d.wins} won · *${money(d.pnlUsd)}*`;
  const lines = [`📅 *Your trading day — ${label}*`, ``];
  if (real.count) lines.push(`💰 *REAL money:* ${line(real)}`);
  if (prac.count) lines.push(`🎮 *PRACTICE (play money):* ${line(prac)}`);
  lines.push(``);
  const main = real.count ? real : prac;
  if (main.pnlUsd > 0) {
    lines.push(`🎉 A profitable day — well done for sticking to the plan.`, `I'll keep watching your open positions and look for new chances tomorrow.`);
  } else if (main.pnlUsd < 0) {
    lines.push(
      `😔 *I'm sorry — today ended at a loss.*`,
      `Losing days are a normal part of this strategy: in testing, more than half of all trades lost a little, and the winners — fewer, but bigger — made up for them over time. One day says very little.`,
      `The plan doesn't change: stops stay in place, and I'll look for better chances tomorrow. 💪`,
      real.count ? `_If you'd rather take a break, \`golive off\` pauses auto-trading any time._` : '',
    );
  } else {
    lines.push(`➖ The day closed flat. I'll keep watching and look for new chances tomorrow.`);
  }
  return lines.filter(x => x !== '').join('\n');
}

const fmtP = (p) => (p >= 1 ? Number(p).toFixed(4) : Number(p).toPrecision(4));
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = {
  AutoBuyError, HOUSE, currentStrategy, activeStrategy, setStrategy, strategyKey, dailyStrategy, momentumStrategy, fixedPct, makeTrailer, loadResearch, computeSignals, trailFor, size, runDaily,
  analyseCoin, buyNow, coinTable, sendDailySummaries, dailyMessage, buyMessage, noBuyMessage, adminReport,
  setPractice, setLive, todayCheck, gateStatus, unlock, missing, lock, pause, isPaused, isLiveUnlocked, userStatus,
};
