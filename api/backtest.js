/**
 * GET /api/backtest — backtests the signalService strategy for BINANCE_SYMBOLS.
 *
 * Previously this file had its own copy of the backtester (which used SMAs
 * labelled as EMAs). It now uses the shared src/services/backtestService.js,
 * the same code as `node backtest.js`, with the look-ahead fix.
 *
 * Note: this backtests the simple EMA/RSI pullback strategy in signalService,
 * not the v2scan engine — see README "Known limitations".
 */

const { fetchKlines, configuredSymbols } = require('../src/lib/market');
const { runBacktest } = require('../src/services/backtestService');
const { cors } = require('../src/lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const resultSets = [];
    for (const symbol of configuredSymbols('SOLUSDT')) {
      try {
        // 720 per timeframe keeps this inside serverless time limits and works on the Kraken fallback too
        const [fourHour, oneHour, fifteenMin] = await Promise.all([
          fetchKlines(symbol, '4h', 720),
          fetchKlines(symbol, '1h', 720),
          fetchKlines(symbol, '15m', 720),
        ]);
        const r = runBacktest({ fourHour, oneHour, fifteenMin }, 10000);
        // equity curve is large — return a summary plus trades
        const { balanceHistory, ...summary } = r;
        resultSets.push({ symbol, ...summary, profitFactor: isFinite(r.profitFactor) ? r.profitFactor : null });
      } catch (err) {
        resultSets.push({ symbol, error: err.message });
      }
    }
    return res.status(200).json({ success: true, results: resultSets });
  } catch (error) {
    console.error('Backtest API Error:', error.message);
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
