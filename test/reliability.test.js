const test = require('node:test');
const assert = require('node:assert/strict');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const update = (id, text, chat = 1000) => ({ update_id: id, message: { chat: { id: chat }, from: { first_name: 'T' }, text } });

test('webhook: the same Telegram update is only processed once', async () => {
  resetEnv();
  const net = mockNet();
  const handler = require('../api/telegram-webhook');
  const r1 = fakeRes(); await handler(fakeReq({ method: 'POST', body: update(77, 'help') }), r1);
  const r2 = fakeRes(); await handler(fakeReq({ method: 'POST', body: update(77, 'help') }), r2);
  assert.equal(r2.body.duplicate, true);
  assert.equal(net.sent.length, 1);
});

test('webhook on Vercel: replies immediately, finishes the work in the background', async () => {
  resetEnv({ VERCEL: '1' });
  let release;
  const gate = new Promise(r => { release = r; });
  const net = mockNet({ telegram: async (method) => { if (method === 'sendMessage') await gate; return null; } });
  const handler = require('../api/telegram-webhook');
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: update(78, 'help') }), res);
  assert.equal(res.statusCode, 200, 'responded while the reply was still being sent');
  assert.equal(net.sent.length, 0);
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(net.sent.length, 1);
  delete process.env.VERCEL;
});

test('monitor: market data fetched once per coin, not once per position', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  const users = require('../src/services/userService');
  const positions = require('../src/services/positionStore');
  await users.registerUser({ chatId: '2000' }); await users.approveUser('2000');
  await positions.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100 });
  await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 98 });
  await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 97 });
  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq(), res);
  assert.equal(res.body.checked, 3);
  const h1Calls = net.calls.filter(c => c.url.includes('/klines') && c.a?.params?.interval === '1h');
  assert.equal(h1Calls.length, 1);
});

test('monitor: overlapping runs are skipped instead of double-alerting', async () => {
  resetEnv();
  mockNet();
  await require('../src/lib/redis').lock('cryptobot:lock:monitor', 60);
  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq(), res);
  assert.match(res.body.skipped, /still in progress/);
});

test('moonshot scan: one batch CoinGecko call instead of two per coin', async () => {
  resetEnv();
  const coins = Array.from({ length: 30 }, (_, i) => `C${i}X`);
  const net = mockNet({
    extra: (method, url, cfg) => {
      if (url.includes('/market/allTickers')) {
        return { data: { data: { ticker: coins.map((b, i) => ({ symbol: `${b}-USDT`, volValue: String(5e6 - i * 1e5), changeRate: '0.25', last: '1.5', high: '1.6', low: '1.0', count: '120000' })) } } };
      }
      if (url.includes('/coins/markets')) {
        return { data: cfg.params.symbols.split(',').map(s => ({ id: `${s}-id`, symbol: s, name: s.toUpperCase(), current_price: 1.5, market_cap: 50e6, total_volume: 5e6 })) };
      }
      if (url.includes('/market/candles')) {
        return { data: { data: Array.from({ length: 24 }, (_, i) => [String(i), '1', String(1 + i * 0.01), '1.3', '0.9', String(1000 + i * 200), '0']) } };
      }
      if (url.includes('/search/trending')) return { data: { coins: [] } };
      if (/\/coins\/[^/]+-id$/.test(url)) return { data: { id: 'x', name: 'X', symbol: 'x', platforms: { ethereum: '0x1234567890' }, market_data: {} } };
      return undefined;
    },
  });
  const { getMoonshots } = require('../src/services/listingsService');
  const picks = await getMoonshots();
  const gecko = net.calls.filter(c => c.url.includes('coingecko'));
  const batch = gecko.filter(c => c.url.includes('/coins/markets')).length;
  const details = gecko.filter(c => /\/coins\/[^/]+-id$/.test(c.url)).length;
  assert.equal(batch, 1);
  assert.ok(details <= 5, `detail calls: ${details}`);
  assert.ok(gecko.length <= 7, `total CoinGecko calls: ${gecko.length} (was ~60)`);
  for (const p of picks) assert.ok(p.meta.contracts.length > 0, 'shown coins get contract addresses');
});

test('retries: a 429 is retried and then succeeds', async () => {
  const axios = require('axios');
  let n = 0;
  axios.get = async () => {
    n++;
    if (n === 1) { const e = new Error('rate limited'); e.response = { status: 429, headers: { 'retry-after': '0' } }; throw e; }
    return { data: 'ok' };
  };
  const { getWithRetry } = require('../src/lib/http');
  const r = await getWithRetry('https://x.test', {}, { baseDelayMs: 1 });
  assert.equal(r.data, 'ok');
  assert.equal(n, 2);
});

test('Binance blocked → the public data mirror is used', async () => {
  resetEnv();
  const axios = require('axios');
  const seen = [];
  axios.get = async (url) => {
    seen.push(url);
    if (url.startsWith('https://api.binance.com')) { const e = new Error('451'); e.response = { status: 451 }; throw e; }
    return { data: [] };
  };
  const { binanceGet } = require('../src/lib/market');
  await binanceGet('/ticker/24hr');
  assert.ok(seen.some(u => u.startsWith('https://data-api.binance.vision/api/v3/ticker/24hr')));
});

test('health: reports each service; storage missing → 503', async () => {
  resetEnv();
  mockNet({ extra: (m, url) => (/ping|Time|timestamp/.test(url) ? { data: {} } : undefined) });
  let res = fakeRes();
  await require('../api/health')(fakeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.summary.storage, 'DOWN');
  assert.equal(res.body.summary.marketData, 'Binance');
  assert.equal(res.body.checks.telegram.ok, true);
  assert.ok(!JSON.stringify(res.body).includes('TEST_TOKEN'));
});
