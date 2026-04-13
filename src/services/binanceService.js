const axios = require('axios');
const { parseKlines } = require('../utils/helpers');

const BASE_URL = 'https://api.binance.com/api/v3';
const INTERVAL_MS = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '2h': 7200000,
  '4h': 14400000,
  '6h': 21600000,
  '8h': 28800000,
  '12h': 43200000,
  '1d': 86400000
};

async function fetchHistoricalKlines(symbol, interval, limit = 500, startTime = null) {
  const result = [];
  const batchLimit = 1000;
  let remaining = limit;
  let nextStartTime = startTime;

  if (!INTERVAL_MS[interval]) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  if (!nextStartTime && limit > batchLimit) {
    nextStartTime = Date.now() - INTERVAL_MS[interval] * limit;
  }

  while (remaining > 0) {
    const requestLimit = Math.min(batchLimit, remaining);
    const params = { symbol, interval, limit: requestLimit };
    if (nextStartTime) params.startTime = nextStartTime;

    const response = await axios.get(`${BASE_URL}/klines`, { params });
    const page = parseKlines(response.data);

    if (!page.length) break;
    result.push(...page);
    remaining -= page.length;

    if (page.length < requestLimit) break;
    const lastTimestamp = response.data[response.data.length - 1][0];
    nextStartTime = lastTimestamp + INTERVAL_MS[interval];
  }

  return result.slice(-limit);
}

async function fetchLatestPrice(symbol) {
  const response = await axios.get(`${BASE_URL}/ticker/price`, {
    params: { symbol }
  });
  return Number(response.data.price);
}

module.exports = {
  fetchHistoricalKlines,
  fetchLatestPrice
};
