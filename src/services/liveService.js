require('dotenv').config();
const { fetchHistoricalKlines, fetchLatestPrice } = require('./binanceService');
const { evaluateSignal } = require('./signalService');
const { sendSignalAlert } = require('./telegramService');
const { saveSignals } = require('./storageService');

function getSymbols() {
  const envSymbols = process.env.BINANCE_SYMBOLS || process.env.BINANCE_SYMBOL || 'SOLUSDT';
  return envSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

async function evaluateSymbol(symbol) {
  const [fourHour, oneHour, fifteenMin] = await Promise.all([
    fetchHistoricalKlines(symbol, '4h', 250),
    fetchHistoricalKlines(symbol, '1h', 120),
    fetchHistoricalKlines(symbol, '15m', 20)
  ]);

  const signalData = evaluateSignal({ fourHour, oneHour, fifteenMin });
  const marketPrice = await fetchLatestPrice(symbol);

  signalData.symbol = symbol;
  signalData.price = marketPrice;

  return signalData;
}

async function runLiveCheck() {
  const symbols = getSymbols();
  const results = [];

  for (const symbol of symbols) {
    try {
      const signalData = await evaluateSymbol(symbol);
      console.log(`=== ${symbol} MTF SIGNAL ===`);
      console.log(`Signal: ${signalData.signal}`);
      console.log(`Score: ${signalData.score}`);
      console.log(`Trend: ${signalData.trend}`);
      console.log(`Price: ${signalData.price.toFixed(2)}`);
      console.log(`RSI: ${signalData.rsi?.toFixed(2)}`);
      console.log(`EMA50: ${signalData.ema50?.toFixed(2)}`);
      console.log(`EMA200: ${signalData.ema200?.toFixed(2)}`);
      console.log(`Confirmed: ${signalData.confirmationType}`);
      console.log(`Time: ${signalData.time}`);

      if (signalData.signal === 'BUY' || signalData.signal === 'SELL') {
        await sendSignalAlert(signalData);
        console.log('Telegram alert sent.');
      } else {
        console.log('No alert sent for WAIT signal.');
      }

      results.push(signalData);
    } catch (error) {
      console.error(`Live check failed for ${symbol}:`, error.message || error);
      results.push({ symbol, signal: 'ERROR', error: error.message || 'unknown error' });
    }
  }

  saveSignals(results, 'signals.json');
  return results;
}

module.exports = {
  runLiveCheck,
  getSymbols
};
