/**
 * Daily movers strategy: the whole Binance market, every day, 1% trailing stop.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const DAY = 86_400_000;
const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'A'.repeat(64), SECRET = 'b'.repeat(64);

// Yesterday's move for each coin (the last closed daily candle vs the one before)
const MOVES = { AAAUSDT: 0.25, BBBUSDT: 0.18, CCCUSDT: 0.12, DDDUSDT: 0.05, EEEUSDT: -0.03, BTCUSDT: 0.01 };

function daily(limit, move = 0.01) {
  const end = Math.floor(Date.now() / DAY) * DAY;
  const out = [];
  let prev = 100;
  for (let i = 0; i < limit; i++) {
    const close = i === limit - 1 ? prev * (1 + move) : 100 * 1.001 ** i;
    out.push({ time: end - (limit - i) * DAY, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1 });
    prev = close;
  }
  return out;
}

function tickers() {
  const now = Date.now();
  const row = (symbol, change, vol) => ({ symbol, priceChangePercent: String(change), quoteVolume: String(vol), lastPrice: '100', count: 1000, closeTime: now });
  return [
    ...Object.entries(MOVES).map(([s, m]) => row(s, m * 100, 50_000_000)),
    row('USDCUSDT', 0.01, 900_000_000), // stablecoin: never a "coin"
    row('TINYUSDT', 90, 100_000),       // too little trading
    row('ETHBTC', 5, 90_000_000),       // not a USDT pair
  ];
}

function setup({ price = null } = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  delete process.env.AUTOBUY_UNIVERSE;
  const state = { price: price ?? 130 };
  const net = mockNet({
    price: state.price,
    klines: (sym, interval, limit) => (interval === '1d' ? daily(limit, MOVES[sym] ?? 0.01)
      : [{ time: Date.now() - 60_000, open: state.price, high: state.price, low: state.price, close: state.price, volume: 1 }]),
    extra: (method, url) => {
      if (url.includes('/ticker/24hr')) return { data: tickers() };
      if (url.includes('/ticker/price')) return { data: { price: String(state.price) } };
      return undefined;
    },
  });
  return { net, state, ab: require('../src/services/autoBuyer'), practice: require('../src/services/practiceService') };
}

const afterClose = () => new Date(Math.floor(Date.now() / DAY) * DAY + 10 * 60_000);

test('daily movers: ranks by yesterday\'s move; the stop is exactly 1% below the entry', () => {
  const { STRATEGIES, prepare, makeContext } = require('../src/strategies');
  const s = STRATEGIES.dailyTop, p = { topN: 3, stopPct: 1 };
  const prepared = {};
  for (const [sym, m] of Object.entries(MOVES)) prepared[sym] = Object.assign(prepare(daily(30, m)), { symbol: sym });
  const ctx = makeContext(prepared, prepared.BTCUSDT);
  const i = 29;
  assert.equal(s.entry(prepared.AAAUSDT, i, p, ctx), true);
  assert.equal(s.entry(prepared.CCCUSDT, i, p, ctx), true);
  assert.equal(s.entry(prepared.DDDUSDT, i, p, ctx), false, '#4 is not bought');
  assert.equal(s.initialStop(prepared.AAAUSDT, i, p, 200), 198);
  assert.match(s.explain(prepared.AAAUSDT, i, p, ctx).text, /#1 of the market .*\+25\.0%/);
});

test('market list: real USDT coins with enough trading only (no stablecoins, no tiny coins)', async () => {
  setup();
  const { getMarketUniverse } = require('../src/services/listingsService');
  const m = await getMarketUniverse();
  assert.ok(m.symbols.includes('AAAUSDT') && m.symbols.includes('BTCUSDT'));
  assert.ok(!m.symbols.includes('USDCUSDT') && !m.symbols.includes('TINYUSDT') && !m.symbols.includes('ETHBTC'));
  assert.equal(m.total, Object.keys(MOVES).length);
});

test('admin switches to daily movers: the house restarts; the daily run buys the top 3 of the whole market with a 1% stop', async () => {
  const { net, ab, practice } = setup();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());

  await say('autobuy strategy');
  assert.match(net.sent.at(-1).text, /Daily movers/);
  await say('autobuy strategy daily');
  assert.match(net.sent.at(-1).text, /Switch auto-buy to Daily movers/);
  assert.equal((await ab.activeStrategy()).family, 'donchian', 'nothing changes before confirming');
  await say('autobuy strategy daily confirm');
  assert.match(net.sent.at(-1).text, /strategy set:\* Daily movers/);
  assert.match(net.sent.at(-1).text, /NOT TESTED/);
  assert.equal((await ab.activeStrategy()).family, 'dailyTop');

  await ab.setPractice('2000', true);
  const send = async (id, text) => net.sent.push({ chat_id: id, text });
  const r = await ab.runDaily({ allowed: new Set(['1000', '2000']), send, now: afterClose() });
  assert.equal(r.strategy, 'dailyTop:3-1');
  assert.equal(r.signals, 3);

  for (const id of ['house', '2000']) {
    const s = await practice.summary(id);
    assert.deepEqual(s.positions.map(p => p.symbol).sort(), ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'], 'the 3 biggest risers, whatever list they are on');
    for (const p of s.positions) {
      assert.ok(Math.abs(p.stopLossPrice / p.buyPrice - 0.99) < 1e-9, 'stop exactly 1% below the price paid');
      assert.equal(p.trailPct, 0.01);
      assert.ok(p.cost <= 2000.01, 'still max 20% of the account per coin');
    }
  }
  const msg = net.sent.find(m => m.chat_id === '2000' && /Auto-bought AAA/.test(m.text))?.text;
  assert.ok(msg, 'the user is told about each buy');
  assert.match(msg, /−1%/);
  assert.match(msg, /not proven/);
  assert.match(msg, /whole Binance market: 6 coins/);
  assert.ok(!/BTC is below/.test(net.sent.map(m => m.text).join('\n')), 'no BTC market filter with this strategy');
});

test('practice: the 1% stop follows the price up, never down, and sells when the price falls to it', async () => {
  const { ab, practice, state } = setup();
  await ab.setStrategy('daily');
  const strategy = await ab.activeStrategy();
  state.price = 100;
  await practice.buy('2000', { symbol: 'AAAUSDT', amount: 1000, stop: 99, strategy, trailPct: 0.01 });
  let [p] = await practice.getPositions('2000');
  const firstStop = p.stopLossPrice;

  state.price = 110; // up 10%
  let msgs = await practice.syncUser('2000');
  [p] = await practice.getPositions('2000');
  assert.ok(Math.abs(p.stopLossPrice - 108.9) < 1e-9, 'stop moved to 1% below the new best price');
  assert.ok(msgs.some(m => /stop is now above your buy price/.test(m)));

  state.price = 109.5; // small dip, still above the stop
  await practice.syncUser('2000');
  [p] = await practice.getPositions('2000');
  assert.ok(Math.abs(p.stopLossPrice - 108.9) < 1e-9, 'the stop never moves down');
  assert.ok(p.stopLossPrice > firstStop);

  state.price = 108; // falls through the stop
  msgs = await practice.syncUser('2000');
  assert.equal((await practice.getPositions('2000')).length, 0, 'sold');
  const [t] = await practice.getTrades('2000');
  assert.ok(t.pnlDollar > 0, 'the trailing stop kept a profit');
});

test('real money: quick check moves the stop up as the price rises (only up)', () => {
  const { trailUpdate } = require('../api/v2quickcheck');
  const pos = { buyPrice: 100, stopLossPrice: 99, trailPct: 0.01 };
  assert.deepEqual(trailUpdate(pos, 105), { highWater: 105, stopLossPrice: 103.95, stopStage: 'trail' });
  assert.equal(trailUpdate({ ...pos, highWater: 105, stopLossPrice: 103.95 }, 104), null, 'lower price: no change');
  assert.equal(trailUpdate({ buyPrice: 100, stopLossPrice: 90 }, 150), null, 'positions without a fixed % trail are untouched');
});

test('real money: daily movers buys on Binance and puts the stop order 1% below the price paid', async () => {
  const { ab, state } = setup();
  const store = require('../src/lib/redis');
  await ab.setStrategy('daily');
  const orders = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '5000' }, ...['AAA', 'BBB', 'CCC'].map(a => ({ asset: a, free: '99' }))] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      orders.push(p);
      if (p.side === 'BUY') { const q = Number(p.quoteOrderQty) / state.price; return { data: { orderId: orders.length, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [] } }; }
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
  assert.deepEqual(buys.map(b => b.symbol).sort(), ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  assert.equal(stops.length, 3);
  assert.ok(stops.every(s => Number(s.stopPrice) === 128.7), 'stop at 1% below the $130 fill');
  const pos = Object.values(await require('../src/services/positionStore').getAllPositions('2000'));
  assert.ok(pos.every(p => p.strategy === 'dailyTop:3-1' && p.trailPct === 0.01));
});

test('switching strategy: coins already held keep their own stop rules', async () => {
  const { ab } = setup();
  await ab.setStrategy('daily');
  const active = await ab.activeStrategy();
  const trail = ab.makeTrailer(active, { prepared: {} });
  // A breakout position (bought before the switch) is trailed by breakout's rule, not the 1% rule
  const breakout = await trail({ symbol: 'DDDUSDT', strategy: 'donchian:55-20:btc', stopLossPrice: 1, highestClose: 1 });
  assert.ok(breakout && breakout.stop / breakout.highestClose < 0.97, 'breakout stop: the 20-day low, far from 1%');
  const d = await trail({ symbol: 'DDDUSDT', strategy: 'dailyTop:3-1', stopLossPrice: 1, highestClose: 1 });
  assert.ok(d && Math.abs(d.stop / d.highestClose - 0.99) < 1e-9, 'daily positions are trailed by the 1% rule');
  assert.equal(await trail({ symbol: 'DDDUSDT', strategy: 'something-else', stopLossPrice: 1 }), null, 'unknown strategies are left alone');
});

test('switching back to breakout restores the lab pick', async () => {
  const { ab } = setup();
  await ab.setStrategy('daily');
  await ab.setStrategy('breakout');
  assert.equal((await ab.activeStrategy()).id, 'donchian:55-20:btc');
  await assert.rejects(ab.setStrategy('yolo'), /Unknown strategy/);
});

test('a coin is auto-bought at most once per account per day, even after it was sold and `autobuy run` is sent again', async () => {
  const { ab, practice, state, net } = setup();
  await ab.setStrategy('daily');
  await ab.setPractice('2000', true);
  const send = async (id, text) => net.sent.push({ chat_id: id, text });
  const allowed = new Set(['2000']);
  await ab.runDaily({ allowed, send, now: afterClose() });
  assert.equal((await practice.getPositions('2000')).length, 3);

  // The 1% stops are hit (price 130 → 128): everything is sold
  state.price = 128;
  await practice.syncUser('2000');
  assert.equal((await practice.getPositions('2000')).length, 0);
  assert.equal((await practice.getTrades('2000')).length, 3);

  // The admin runs the check again the same day
  state.price = 130;
  await ab.runDaily({ allowed, send, force: true });
  assert.equal((await practice.getPositions('2000')).length, 0, 'nothing bought again today');
  assert.ok(net.sent.some(m => m.chat_id === '2000' && /already auto-bought today/.test(m.text)), 'the user is told why');
  assert.equal((await practice.getPositions('house')).length, 3, 'the house account kept its 3 and bought no more');
});

test('two checks running at the same moment cannot both buy the same coin', async () => {
  const { ab, practice } = setup();
  await ab.setStrategy('daily');
  await ab.setPractice('2000', true);
  const allowed = new Set(['2000']);
  await Promise.all([
    ab.runDaily({ allowed, force: true, send: async () => {} }),
    ab.runDaily({ allowed, force: true, send: async () => {} }),
  ]);
  for (const id of ['2000', 'house']) {
    const syms = (await practice.getPositions(id)).map(p => p.symbol);
    assert.equal(syms.length, new Set(syms).size, `${id}: no coin twice`);
    assert.equal(syms.length, 3);
  }
});

test('the next day the same coin can be bought again (once per day, not once ever)', async () => {
  const { ab, practice, state } = setup();
  await ab.setStrategy('daily');
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const store = require('../src/lib/redis');
  await store.cmd('SET', `cryptobot:autobuy:bought:${yesterday}:p:house:AAAUSDT`, '1');
  state.price = 130;
  await ab.runDaily({ allowed: new Set(), force: true, send: async () => {} });
  assert.ok((await practice.getPositions('house')).some(p => p.symbol === 'AAAUSDT'));
});

// ─── Strongest coins at 2% risk ───────────────────────────────────────────────
function labFile() {
  const fs = require('fs');
  const file = path.join(os.tmpdir(), `lab-momentum-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    verdict: 'PASS', period: { from: '2018-08-10', split: '2023-12-11', to: '2026-10-26' },
    pick: { family: 'donchian', params: { entryN: 55, exitN: 20, regime: true }, id: 'donchian:55-20:btc', label: 'Breakout', name: 'Breakout to a new high', test: { trades: 108, expectancyR: 0.403 } },
    families: [{ family: 'momentum', chosen: { id: 'momentum:56-3-4:btc', params: { lookback: 56, topN: 3, k: 4, regime: true } }, verdict: 'PASS', test: { trades: 101, expectancyR: 0.399 } }],
    comparisons: { risk2: { momentum: { taken: 78, returnPct: 68.8, maxDrawdownPct: 16.3 } } },
  }));
  return file;
}

test('sizing at 2% risk: twice the amount of 1%, still capped at 20% of the account', () => {
  const { size } = require('../src/services/autoBuyer');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 80, open: 0 }).usd, 500, '1%: $100 / 20% stop');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 80, open: 0, riskPct: 2 }).usd, 1000, '2%: $200 / 20% stop');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 95, open: 0, riskPct: 2 }).usd, 2000, 'capped at 20%');
});

test('admin switches to strongest coins at 2%: the lab\'s settings and verdict, 2% risk, buys the top 3 of the 15 coins', async () => {
  const { net, ab, practice, state } = setup();
  state.price = daily(300, 0.01).at(-1).close * 1.001; // just above yesterday's close
  process.env.AUTO_STRATEGY_FILE = labFile();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('autobuy strategy momentum confirm');
  const reply = net.sent.at(-1).text;
  assert.match(reply, /Strongest coins/);
  assert.match(reply, /Lab verdict: PASS/);
  assert.match(reply, /\+68\.8% with a worst drop of 16\.3%/);

  const st = await ab.activeStrategy();
  assert.equal(st.id, 'momentum:56-3-4:btc');
  assert.equal(st.riskPct, 2);
  assert.deepEqual(st.params, { lookback: 56, topN: 3, k: 4, regime: true });

  await ab.setPractice('2000', true);
  const sent = [];
  const r = await ab.runDaily({ allowed: new Set(['2000']), send: async (id, text) => sent.push({ id, text }), now: afterClose() });
  assert.equal(r.strategy, 'momentum:56-3-4:btc');
  const pos = await practice.getPositions('2000');
  assert.equal(pos.length, 3, 'top 3 coins');
  assert.ok(pos.every(p => p.strategy === 'momentum:56-3-4:btc' && !p.trailPct), 'trailing ATR stop, not the 1% rule');
  const m = sent.find(x => /Auto-bought/.test(x.text)).text;
  assert.match(m, /Strongest coins: #\d of the list by 56-day return/);
  assert.match(m, /Strategy test: PASSED/);
  assert.ok(!/not proven/.test(m));
});

test('strongest coins waits while BTC is below its 100-day average', async () => {
  const { ab, practice } = setup();
  process.env.AUTO_STRATEGY_FILE = labFile();
  await ab.setStrategy('momentum');
  // Every coin (BTC included) in a long fall
  const fall = (limit) => { const end = Math.floor(Date.now() / DAY) * DAY; return Array.from({ length: limit }, (_, i) => { const c = 100 * 0.997 ** i; return { time: end - (limit - i) * DAY, open: c / 0.997, high: c / 0.997 * 1.001, low: c * 0.999, close: c, volume: 1 }; }); };
  mockNet({ price: 40, klines: (sym, interval, limit) => fall(limit) });
  const r = await ab.runDaily({ allowed: new Set(), force: true, send: async () => {} });
  assert.equal(r.signals, 0);
  assert.equal((await practice.getPositions('house')).length, 0);
});


test('🧭 Strategy button: in the admin menu (not for users); tap a strategy, confirm, switched', async () => {
  const { net, ab } = setup();
  const say = (id, text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id }, from: {}, text } } }), fakeRes());
  const tap = (id, data) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q', data, from: {}, message: { chat: { id }, message_id: 1 } } } }), fakeRes());
  const buttons = (m) => (m.reply_markup?.inline_keyboard || []).flat().map(x => x.callback_data);

  await say(1000, 'menu');
  assert.ok(net.sent.some(m => buttons(m).includes('autobuy strategy')), 'admin menu has 🧭 Strategy');
  require('../src/services/userService');
  net.sent.length = 0;

  await tap(1000, 'autobuy strategy');
  const picker = net.sent.at(-1);
  assert.match(picker.text, /✅ \*Breakout \(1% risk\)\* — \*in use\*/);
  assert.ok(['autobuy strategy breakout', 'autobuy strategy momentum', 'autobuy strategy daily'].every(d => buttons(picker).includes(d)));

  await tap(1000, 'autobuy strategy momentum');
  assert.ok(buttons(net.sent.at(-1)).includes('autobuy strategy momentum confirm'));
  assert.equal(await ab.strategyKey(), 'breakout', 'not switched before confirming');
  await tap(1000, 'autobuy strategy momentum confirm');
  assert.equal(await ab.strategyKey(), 'momentum');
  assert.ok(buttons(net.sent.at(-1)).includes('autobuy run'), 'offers to run the check now');

  await tap(1000, 'autobuy strategy momentum');
  assert.match(net.sent.at(-1).text, /already the strategy in use/);

  // A normal user can't switch
  await tap(2000, 'autobuy strategy daily confirm');
  assert.equal(await ab.strategyKey(), 'momentum');
});
