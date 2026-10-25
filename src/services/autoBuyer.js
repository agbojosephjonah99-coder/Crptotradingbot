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
async function computeSignals(strategy, { symbols = null } = {}) {
  const list = symbols || cfg.universe();
  const syms = [...new Set(['BTCUSDT', ...list])];
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
  const analysis = {};
  for (const sym of list) {
    const ind = prepared[sym];
    if (!ind) { analysis[sym] = { signal: false, reason: 'not enough daily price history on Binance' }; continue; }
    const i = ind.c.length - 1;
    const ref = ind.close[i];
    const stop = i >= 20 ? s.initialStop(ind, i, p, ref) : null;
    const base = { close: ref, stop: Number.isFinite(stop) && stop > 0 && stop < ref ? stop : null };
    if (base.stop) base.stopPct = r2((1 - base.stop / ref) * 100);
    if (i < s.warmup) { analysis[sym] = { ...base, signal: false, reason: 'too new — not enough price history for the strategy' }; continue; }
    if (p.regime && !ctx.btcUp(ind.c[i].time)) { analysis[sym] = { ...base, signal: false, reason: 'the market filter is off: BTC is below its 100-day average' }; continue; }
    if (!s.entry(ind, i, p, ctx)) { analysis[sym] = { ...base, signal: false, reason: `no buy signal today (the strategy needs: ${s.describe(p).split(';')[0]})` }; continue; }
    analysis[sym] = { ...base, signal: true, reason: 'the strategy has a buy signal today' };
    if (base.stop) buys.push({ symbol: sym, close: ref, stop: base.stop, stopPct: base.stopPct });
  }
  return { prepared, buys, analysis, regimeUp: ctx.btcUp(prepared.BTCUSDT.c[prepared.BTCUSDT.c.length - 1].time) };
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
    if (!(await isLiveUnlocked())) throw new AutoBuyError('Live auto-buy hasn\'t been opened by the admin yet. See `autobuy` for the forward-test progress.');
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
  return { practiceOn: !!pr, liveOn: !!lv, ...g, lastRun: last, limits: cfg.LIMITS, universe: cfg.universe().map(s => s.replace(/USDT$/, '')) };
}

// ─── Practice accounts ────────────────────────────────────────────────────────
async function runPracticeAccount(chatId, strategy, sig, { buy = true } = {}) {
  const msgs = [];
  // 1) Trail the stops of auto-bought positions
  for (const p of (await practice.getPositions(chatId)).filter(x => x.auto)) {
    const t = trailFor(sig.prepared, strategy, p);
    if (t) await practice.raiseStop(chatId, p.id, t.stop ?? p.stopLossPrice, t.highestClose);
    if (t?.stop) msgs.push(`🎮🤖 ${p.symbol.replace('USDT', '')}: trailing stop raised to $${fmtP(t.stop)}`);
  }
  // 2) New buys
  if (!buy || !sig.buys.length) return msgs;
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
      msgs.push(`🎮 PRACTICE · 🤖 *Auto-bought ${b.symbol.replace('USDT', '')}* (play money): ${usd(z.usd)} at $${fmtP(position.buyPrice)} · stop $${fmtP(b.stop)} (−${b.stopPct}%, risk ≈ ${cfg.LIMITS.riskPct}% of the account)`);
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

/** Market-buy on Binance, save the position with the strategy's stop, put the stop order on Binance. */
async function liveBuy(chatId, c, { symbol, usd: spend, stop, strategy, autoBought = false, signal = null }) {
  const rules = await c.symbolRules(symbol);
  const o = await c.marketBuy(symbol, Number(spend).toFixed(2), `cb-${autoBought ? 'ab' : 'bn'}-${Date.now().toString(36)}`);
  const qtyGross = Number(o.executedQty) || 0;
  if (!(qtyGross > 0)) throw new Error('order not filled');
  const feeInCoin = (o.fills || []).filter(f => f.commissionAsset === rules.baseAsset).reduce((t, f) => t + Number(f.commission), 0);
  const qty = floorToStep(qtyGross - feeInCoin, rules.stepSize);
  const avg = Number(o.cummulativeQuoteQty) / qtyGross;
  const pos = await ps.addPosition({ chatId, symbol, buyPrice: avg, quantity: Number(toFixedStep(qty, rules.stepSize)), stopLossPrice: stop, exchange: 'binance' });
  await ps.updatePosition(chatId, pos.positionId, { strategy: strategy.id, stopStage: 'trail', stopSource: 'strategy', highestClose: avg, autoBought, ...(signal !== null ? { boughtWithSignal: signal } : {}) });
  await autoTrader.sync(chatId, pos.positionId); // puts the stop order on Binance
  return { qty, avg, positionId: pos.positionId };
}

async function runLiveAccount(chatId, strategy, sig, { buy = true } = {}) {
  const msgs = [];
  const c = await accounts.getActiveClient(chatId);
  if (!c) return buy ? [`🤖 Live auto-buy skipped: auto-trading is off. Send \`golive\`.`] : [];
  const mine = Object.values(await ps.getAllPositions(chatId)).filter(p => p.strategy);
  // 1) Trail stops; autoTrader moves the Binance stop order
  for (const p of mine) {
    const t = trailFor(sig.prepared, strategy, p);
    if (!t) continue;
    await ps.updatePosition(chatId, p.positionId, { highestClose: t.highestClose, ...(t.stop ? { stopLossPrice: t.stop, stopStage: 'trail' } : {}) });
    if (t.stop) await autoTrader.sync(chatId, p.positionId);
  }
  if (!buy || !sig.buys.length) return msgs;
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
      const { qty, avg } = await liveBuy(chatId, c, { symbol: b.symbol, usd: z.usd, stop: b.stop, strategy, autoBought: true });
      cash -= z.usd; open++; held.add(b.symbol);
      msgs.push(`💰 REAL · 🤖 *Auto-bought ${b.symbol.replace('USDT', '')}* on Binance: ${qty} at ~$${fmtP(avg)} (${usd(z.usd)}) · stop $${fmtP(b.stop)} (−${b.stopPct}%)`);
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

  const out = { date, strategy: strategy.id, signals: sig.buys.length, practice: 0, live: 0, summaries: 0 };

  // End of the trading day: everyone's result for the day that just closed
  if (!force) out.summaries = await sendDailySummaries({ allowed, send, now }).catch(err => { console.error('[AutoBuy] summary', err.message); return 0; });

  // Practice: trail every strategy position; buy only for the house + users who switched auto-buy on
  const practiceOn = new Set(((await store.cmd('SMEMBERS', K.users)) || []).map(String));
  const practiceIds = [HOUSE, ...(await practice.allUsers()).filter(id => id !== HOUSE && allowed.has(String(id)))];
  for (const id of practiceIds) {
    try {
      const msgs = await runPracticeAccount(id, strategy, sig, { buy: id === HOUSE || practiceOn.has(String(id)) });
      if (id !== HOUSE) for (const m of msgs) await send(id, m);
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
    try { for (const m of await runLiveAccount(id, strategy, sig, { buy })) await send(id, m); out.live++; }
    catch (err) { console.error('[AutoBuy] live', id, err.message); await send(id, `⚠️ Auto-trading problem: ${err.message}`); }
  }
  return out;
}

// ─── Buy now (the user picks the coin; the strategy manages the exit) ────────
/** Does the strategy agree with buying this coin today? */
async function analyseCoin(symbol) {
  const strategy = currentStrategy();
  const sym = String(symbol).toUpperCase().replace(/USDT$/, '') + 'USDT';
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
  if (a.stop >= live) throw new AutoBuyError(`The price is already at the strategy's stop ($${fmtP(a.stop)}) — not a good moment to buy.`);
  const maxPct = cfg.LIMITS.maxPositionPct / 100;

  if (mode === 'practice') {
    const s = await practice.summary(chatId);
    if (spend > s.equity * maxPct + 0.01) throw new AutoBuyError(`That's more than ${cfg.LIMITS.maxPositionPct}% of your practice account — the most for one coin is ${usd(s.equity * maxPct)}.`);
    const { position } = await practice.buy(chatId, { symbol: a.symbol, amount: spend, stop: a.stop, strategy: a.strategy });
    return { analysis: a, price: position.buyPrice, qty: position.quantity, spend };
  }

  const c = await accounts.getActiveClient(chatId);
  if (!c) throw new AutoBuyError('Turn on auto-trading first: `golive`.');
  const mine = Object.values(await ps.getAllPositions(chatId)).filter(p => p.strategy);
  const { usdt, equity } = await liveEquity(c, mine);
  if (spend > usdt) throw new AutoBuyError(`You have ${usd(usdt)} USDT in your Spot wallet. Move more from Funding to Spot, or buy less.`);
  if (spend > equity * maxPct + 0.01) throw new AutoBuyError(`That's more than ${cfg.LIMITS.maxPositionPct}% of your account (${usd(equity)}) — the most for one coin is ${usd(equity * maxPct)}.`);
  const r = await liveBuy(chatId, c, { symbol: a.symbol, usd: spend, stop: a.stop, strategy: a.strategy, signal: a.signal });
  return { analysis: a, price: r.avg, qty: r.qty, spend };
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
  AutoBuyError, HOUSE, currentStrategy, loadResearch, computeSignals, trailFor, size, runDaily,
  analyseCoin, buyNow, sendDailySummaries, dailyMessage,
  setPractice, setLive, gateStatus, unlock, missing, lock, pause, isPaused, isLiveUnlocked, userStatus,
};
