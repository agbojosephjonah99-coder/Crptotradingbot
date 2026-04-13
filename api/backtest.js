const { fetchHistoricalKlines } = require('../src/services/binanceService');
const { runBacktest } = require('../src/services/backtestService');

const symbols = (process.env.BINANCE_SYMBOLS || process.env.BINANCE_SYMBOL || 'SOLUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

module.exports = async (req, res) => {
  try {
    const resultSets = [];

    for (const symbol of symbols) {
      const [fourHour, oneHour, fifteenMin] = await Promise.all([
        fetchHistoricalKlines(symbol, '4h', 500),
        fetchHistoricalKlines(symbol, '1h', 1500),
        fetchHistoricalKlines(symbol, '15m', 8000)
      ]);

      const results = runBacktest({ fourHour, oneHour, fifteenMin }, 10000);
      resultSets.push({ symbol, ...results });
    }

    res.status(200).json({ success: true, results: resultSets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
