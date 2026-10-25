const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const DAY = 86_400_000;
const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'A'.repeat(64), SECRET = 'b'.repeat(64);

/** Steady uptrend: every day's close is a new 20-day high (a breakout signal today). */
function trendDaily(limit, growth = 0.003) {
  const end = Math.floor(Date.now() / DAY) * DAY; // today 00:00 UTC → last candle = yesterday (closed)
  const out = [];
  let prev = 100;
  for (let i = 0; i < limit; i++) {
    const close = 100 * (1 + growth) ** i;
    out.push({ time: end - (limit - i) * DAY, open: prev, high: close * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1 });
    prev = close;
  }
  return out;
}
const lastClose = (limit = 300) => trendDaily(limit).at(-1).close;

function setup({ strategyFile = null } = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: strategyFile || path.join(os.tmpdir(), 'no-such-strategy.json') });
  delete process.env.AUTOBUY_UNIVERSE;
  const price = lastClose() * 1.002;
  const net = mockNet({
    price,
    klines: (sym, interval, limit) => (interval === '1d' ? trendDaily(limit) : interval === '1m'
      ? [{ time: Date.now() - 60_000, open: price, high: price, low: price, close: price, volume: 1 }]
      : trendDaily(limit).map((c, i) => ({ ...c, time: Date.now() - (limit - i) * 3_600_000 }))),
  });
  return { net, price, ab: require('../src/services/autoBuyer'), practice: require('../src/services/practiceService') };
}

test('strategies: donchian breakout fires on a new 20-day high; the trailing stop only rises', () => {
  const { STRATEGIES, prepare } = require('../src/strategies');
  const ind = prepare(trendDaily(120));
  const s = STRATEGIES.donchian, p = { entryN: 20, exitN: 10 };
  const i = ind.c.length - 1;
  assert.equal(s.entry(ind, i, p), true);
  const stop = s.initialStop(ind, i, p, ind.close[i]);
  assert.ok(stop < ind.close[i] && stop > ind.close[i] * 0.9);
  assert.ok(s.trail(ind, i, p) > s.trail(ind, i - 5, p), 'in an uptrend the trail moves up');
});

test('sizing: 1% of the account at risk, capped at 20% per coin, max 5 open, pause after a 3% drop', () => {
  const { size } = require('../src/services/autoBuyer');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 90, open: 0 }).usd, 1000, '$100 risk / 10% stop = $1,000');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 99, open: 0 }).usd, 2000, 'tight stop → capped at 20%');
  assert.match(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 90, open: 5 }).skip, /max 5/);
  assert.match(size({ equity: 9_600, cash: 9_600, entry: 100, stop: 90, open: 0, lastEquity: 10_000 }).skip, /fell 4%/);
});

test('daily run: house forward test + opted-in users buy with play money; once per day; no double buys', async () => {
  const { net, ab, practice } = setup();
  await ab.setPractice('2000', true);
  const allowed = new Set(['1000', '2000', '3000']);
  const send = async (id, text) => net.sent.push({ chat_id: id, text });

  const r = await ab.runDaily({ allowed, send, now: new Date(Math.floor(Date.now() / DAY) * DAY + 10 * 60_000) });
  assert.equal(r.strategy, 'donchian:20-10:btc', 'fallback strategy until `npm run lab` picks one');
  assert.ok(r.signals >= 5);
  assert.equal(r.practice, 2, 'house + the one user who opted in');

  const house = await practice.summary('house');
  assert.equal(house.positions.length, 5, 'max 5 positions');
  assert.ok(house.positions.every(p => p.auto && p.stopLossPrice > 0));
  assert.ok(house.positions.every(p => p.cost <= 2000.01), 'no position above 20%');
  assert.ok(net.sent.some(m => m.chat_id === '2000' && /PRACTICE · 🤖 \*Auto-bought/.test(m.text)));
  assert.ok(!net.sent.some(m => m.chat_id === '3000'), 'users who did not opt in get nothing');
  assert.ok(!net.sent.some(m => m.chat_id === 'house'), 'the house account sends no messages');

  assert.equal((await ab.runDaily({ allowed, send })).skipped, 'already ran today');
  await ab.runDaily({ allowed, send, force: true });
  assert.equal((await practice.summary('house')).positions.length, 5, 'forced re-run does not buy the same coins twice');
});

test('admin pause stops all auto-buying', async () => {
  const { ab } = setup();
  await ab.pause(true);
  assert.equal((await ab.runDaily({ force: true })).skipped, 'paused by admin');
});

test('live auto-buy: closed until the admin opens it; an early opening is recorded and shown; the full gate is tracked', async () => {
  const file = path.join(os.tmpdir(), `strategy-pass-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ verdict: 'PASS', period: {}, pick: { family: 'donchian', params: { entryN: 20, exitN: 10, regime: true }, id: 'donchian:20-10:btc', label: 'test', name: 'Breakout', why: 'ok', test: { trades: 40, expectancyR: 0.3 } } }));
  const { ab } = setup({ strategyFile: file });
  const store = require('../src/lib/redis');

  await assert.rejects(ab.setLive('2000', true), /hasn't been opened/);
  const early = await ab.unlock('1000');
  assert.equal(early.early, true, 'admin can open it before the forward test is done…');
  assert.ok(early.missing.some(m => /days of forward testing/.test(m)), '…and is told exactly what is still missing');
  assert.equal((await ab.gateStatus()).unlockedEarly, true);
  await ab.lock();

  // Simulate a profitable 60-day forward test with 20 closed trades
  await store.cmd('HSET', 'cryptobot:practice:house', 'cash', '11000', 'start', '10000', 'createdAt', new Date(Date.now() - 60 * DAY).toISOString(), 'resets', '0');
  for (let k = 0; k < 20; k++) await store.cmd('RPUSH', 'cryptobot:practicetrades:house', JSON.stringify({ pnlDollar: 50 }));
  const g = await ab.gateStatus();
  assert.deepEqual(g.checks, { research: true, days: true, trades: true, profit: true });
  assert.equal((await ab.unlock('1000')).early, false);
  assert.equal(await ab.isLiveUnlocked(), true);
  await assert.rejects(ab.setLive('2000', true), /Connect your Binance account/, 'each user still needs their own connected account');
});

test('live run (when unlocked): market buy on Binance, position saved with the strategy stop, stop order placed', async () => {
  const { ab, price } = setup();
  const store = require('../src/lib/redis');
  const orders = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '5000' }, { asset: 'SOL', free: '9.99' }, { asset: 'BTC', free: '9.99' }, { asset: 'ETH', free: '9.99' }, { asset: 'BNB', free: '9.99' }, { asset: 'XRP', free: '9.99' }] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      orders.push(p);
      if (p.side === 'BUY') { const q = Number(p.quoteOrderQty) / price; return { data: { orderId: orders.length, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [{ commission: String(q * 0.001), commissionAsset: p.symbol.replace('USDT', '') }] } }; }
      return { data: { orderId: orders.length, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' } };
    }
    if (u.pathname === '/api/v3/order' && method === 'GET') return { data: { orderId: p.orderId, status: 'NEW', executedQty: '0' } };
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo')
    ? Promise.resolve({ data: { symbols: [{ symbol: cfg.params.symbol, status: 'TRADING', baseAsset: cfg.params.symbol.replace('USDT', ''), orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));

  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  await store.cmd('HSET', 'cryptobot:autobuy:flags', 'liveUnlocked', '1');
  await ab.setLive('2000', true);
  await ab.runDaily({ allowed: new Set(['2000']), force: true, send: async () => {} });

  const buys = orders.filter(o => o.side === 'BUY');
  const stops = orders.filter(o => o.type === 'STOP_LOSS_LIMIT');
  assert.equal(buys.length, 5);
  assert.ok(buys.every(b => Number(b.quoteOrderQty) <= 1000.01), '20% cap of a $5,000 account');
  assert.equal(stops.length, 5, 'every live buy gets a stop order on Binance straight away');
  const pos = Object.values(await require('../src/services/positionStore').getAllPositions('2000'));
  assert.ok(pos.every(p => p.strategy === 'donchian:20-10:btc' && p.stopStage === 'trail' && p.exchange === 'binance'));
});

test('monitor gives auto-bought positions no take-profits (trailing stop only)', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const c = trendDaily(260).map((x, i) => ({ ...x, time: Date.now() - (260 - i) * 3_600_000 }));
  const pos = { symbol: 'SOLUSDT', buyPrice: 100, stopLossPrice: 90, strategy: 'donchian:20-10:btc', positionId: 'x' };
  const r = evaluatePosition(pos, { candles1h: c, candles4h: c, currentPrice: 150 });
  assert.equal(r.updates.takeProfits, undefined);
  assert.ok(!/TP\d/.test(r.recommendation));
});

test('bot: autobuy status, on/off, live stays locked', async () => {
  const { net } = setup();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('autobuy');
  assert.match(net.sent.at(-1).text, /NOT TESTED YET/);
  assert.match(net.sent.at(-1).text, /Live auto-buy:\* 🔒 not open yet/);
  await say('autobuy on');
  assert.match(net.sent.at(-1).text, /Practice auto-buy ON/);
  await say('autobuy live on');
  assert.match(net.sent.at(-1).text, /hasn't been opened/);
});

test('admin opens auto-buy early; golive "Turn on auto-trading" turns on buying AND selling, with an unproven warning', async () => {
  const { net } = setup();
  const axios = require('axios');
  axios.request = async ({ url }) => (url.includes('apiRestrictions') ? { data: { enableWithdrawals: false } } : { data: { canTrade: true, balances: [{ asset: 'USDT', free: '100', locked: '0' }] } });
  await require('../src/services/tradingAccounts').connect('1000', { apiKey: KEY, apiSecret: SECRET, live: true });
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('autobuy unlock');
  assert.match(net.sent.at(-1).text, /Opened \*early\*/);
  await say('golive on');
  assert.match(net.sent.at(-1).text, /Buys:\* once a day/);
  assert.match(net.sent.at(-1).text, /Not proven yet/);
  await say('golive on confirm');
  assert.match(net.sent.find(m => /Auto-trading is ON/.test(m.text)).text, /buys the coins that signal/);
  const st = await require('../src/services/autoBuyer').userStatus('1000');
  assert.equal(st.liveOn, true);
  assert.equal((await require('../src/services/tradingAccounts').getStatus('1000')).enabled, true);
  await say('golive off');
  assert.equal((await require('../src/services/autoBuyer').userStatus('1000')).liveOn, false);
});

test('menu message is deleted when one of its buttons is tapped', async () => {
  const { net } = setup();
  const axios = require('axios');
  const deleted = [];
  const post = axios.post;
  axios.post = async (url, body, cfg) => (url.endsWith('/deleteMessage') ? (deleted.push(body.message_id), { data: { ok: true, result: true } }) : post(url, body, cfg));
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q1', data: 'practice', from: {}, message: { message_id: 55, chat: { id: 1000 }, text: 'What would you like to do?\n\nTap a button below:' } } } }), fakeRes());
  assert.deepEqual(deleted, [55]);
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q2', data: 'practice', from: {}, message: { message_id: 56, chat: { id: 1000 }, text: 'Practice account …' } } } }), fakeRes());
  assert.deepEqual(deleted, [55], 'other messages with buttons are kept');
  assert.ok(net.sent.length > 0);
});

test('closed trades show today\'s running profit', () => {
  const { todayLine } = require('../src/services/profitTracker');
  const now = new Date().toISOString();
  const line = todayLine([{ closedAt: now, pnlDollar: 12.5 }, { closedAt: now, pnlDollar: -2.5 }, { closedAt: '2020-01-01T00:00:00Z', pnlDollar: 99 }]);
  assert.match(line, /2 closed trades · 1 won · \+\$10\.00/);
});

test('strategy lab: on random prices nothing passes', () => {
  const { research } = require('../src/services/strategyLab');
  const walk = (seed) => { let s = seed, px = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; return Array.from({ length: 1200 }, (_, i) => { const o = px; px *= Math.exp((rnd() - 0.5) * 0.08); return { time: Date.UTC(2022, 0, 1) + i * DAY, open: o, high: Math.max(o, px) * 1.01, low: Math.min(o, px) * 0.99, close: px, volume: 1 }; }); };
  const data = {}; ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'].forEach((s, k) => { data[s] = walk(97 + k * 7919); });
  const out = research(data);
  assert.notEqual(out.verdict, 'PASS');
  assert.ok(out.families.length === 3 && out.variants.length === 22);
});

test('buynow (practice): tells you whether the strategy agrees, buys after you confirm, managed by the trailing stop', async () => {
  const { net, practice } = setup();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('practice buynow SOL 500');
  const ask = net.sent.at(-1);
  assert.match(ask.text, /The strategy agrees/);
  assert.equal(ask.reply_markup.inline_keyboard[0][0].callback_data, 'practice buynow SOL 500 confirm');
  assert.equal((await practice.summary('1000')).positions.length, 0, 'nothing bought before confirming');
  await say('practice buynow SOL 500 confirm');
  assert.match(net.sent.at(-1).text, /Bought .* SOL/);
  const [p] = (await practice.summary('1000')).positions;
  assert.equal(p.auto, true);
  assert.ok(p.stopLossPrice > 0);
  await say('practice buynow SOL 5000 confirm');
  assert.match(net.sent.at(-1).text, /more than 20%/);
});

test('buynow (practice): a coin without a signal gets an honest warning', async () => {
  const { net } = setup();
  // Falling coin: no breakout
  const axios = require('axios');
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/klines') && cfg?.params?.symbol === 'ADAUSDT' && cfg.params.interval === '1d'
    ? Promise.resolve({ data: trendDaily(cfg.params.limit, -0.003).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) })
    : get(url, cfg));
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'practice buynow ADA 100' } } }), fakeRes());
  assert.match(net.sent.at(-1).text, /wouldn't buy ADA today/);
  assert.match(net.sent.at(-1).text, /isn't backed by the test results/);
});

test('end-of-day summary: profit → congratulations; loss → apology + encouragement; only once per day', async () => {
  const { ab } = setup();
  const loss = ab.dailyMessage('2026-10-25', { count: 3, wins: 1, pnlUsd: -12.4 }, { count: 0 });
  assert.match(loss, /I'm sorry — today ended at a loss/);
  assert.match(loss, /look for better chances tomorrow/);
  assert.match(loss, /golive off/);
  assert.match(loss, /-\$12\.40/);
  const win = ab.dailyMessage('2026-10-25', { count: 2, wins: 2, pnlUsd: 20 }, { count: 1, wins: 1, pnlUsd: 5 });
  assert.match(win, /profitable day/);
  assert.match(win, /PRACTICE \(play money\):\* 1 trade closed/);

  // Wired into the daily run, for users who closed trades during the day
  const store = require('../src/lib/redis');
  const dayStart = Math.floor(Date.now() / DAY) * DAY;
  const yesterday = new Date(dayStart - 3 * 3_600_000).toISOString();
  await store.cmd('RPUSH', 'cryptobot:tradelist:2000', JSON.stringify({ symbol: 'SOLUSDT', closedAt: yesterday, pnlDollar: -8, pnlPct: -2 }));
  const sent = [];
  const allowed = new Set(['1000', '2000']);
  const r = await ab.runDaily({ allowed, send: async (id, text) => sent.push({ id, text }), now: new Date(dayStart + 10 * 60_000) });
  assert.equal(r.summaries, 1);
  assert.ok(sent.some(m => m.id === '2000' && /sorry/.test(m.text)));
  const again = await ab.runDaily({ allowed, send: async (id, text) => sent.push({ id, text }), force: true });
  assert.equal(again.summaries, 0, 'a forced re-run never repeats the summary');
});

test('buynow (live): buys on Binance and places the stop order — even before auto-buy is opened', async () => {
  const { price } = setup();
  const axios = require('axios');
  const orders = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '500', locked: '0' }, { asset: 'SOL', free: '0.5', locked: '0' }] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      orders.push(p);
      if (p.side === 'BUY') { const q = Number(p.quoteOrderQty) / price; return { data: { orderId: 1, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [] } }; }
      return { data: { orderId: 2, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' } };
    }
    if (u.pathname === '/api/v3/order') return { data: { orderId: p.orderId, status: 'NEW', executedQty: '0' } };
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo')
    ? Promise.resolve({ data: { symbols: [{ symbol: 'SOLUSDT', status: 'TRADING', baseAsset: 'SOL', orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));
  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  const ab = require('../src/services/autoBuyer');
  await assert.rejects(ab.buyNow('2000', { symbol: 'SOL', amount: 900, mode: 'live' }), /USDT in your Spot wallet/);
  const r = await ab.buyNow('2000', { symbol: 'SOL', amount: 100, mode: 'live' });
  assert.equal(r.analysis.signal, true);
  assert.equal(orders.filter(o => o.side === 'BUY').length, 1);
  assert.equal(orders.filter(o => o.type === 'STOP_LOSS_LIMIT').length, 1, 'stop order placed straight away');
  const [pos] = Object.values(await require('../src/services/positionStore').getAllPositions('2000'));
  assert.equal(pos.strategy, 'donchian:20-10:btc');
  assert.equal(pos.boughtWithSignal, true);
});

test('minimum order is Binance\'s $5: auto-buy needs ~$50 (1% risk, ~10% stop); Buy Now needs ~$25 (20% cap)', () => {
  const { size } = require('../src/services/autoBuyer');
  assert.equal(size({ equity: 50, cash: 50, entry: 100, stop: 90, open: 0 }).usd, 5, '1% risk of $50 with a 10% stop = a $5 buy');
  assert.match(size({ equity: 25, cash: 25, entry: 100, stop: 90, open: 0 }).skip, /minimum order/);
});
