require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchHistoricalKlines } = require('./src/services/binanceService');
const { runBacktest } = require('./src/services/backtestService');

const symbols = (process.env.BINANCE_SYMBOLS || process.env.BINANCE_SYMBOL || 'SOLUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const outputFile = path.resolve(process.cwd(), 'backtest-results.json');

async function runBacktestCommand() {
  try {
    const resultSets = [];

    for (const symbol of symbols) {
      console.log(`Running multi-timeframe backtest for ${symbol}...`);
      const [fourHour, oneHour, fifteenMin] = await Promise.all([
        fetchHistoricalKlines(symbol, '4h', 500),
        fetchHistoricalKlines(symbol, '1h', 1500),
        fetchHistoricalKlines(symbol, '15m', 8000)
      ]);

      const results = runBacktest({ fourHour, oneHour, fifteenMin }, 10000);
      resultSets.push({ symbol, ...results });

      console.log(`=== BACKTEST RESULTS: ${symbol} ===`);
      console.log(`Total trades: ${results.totalTrades}`);
      console.log(`Wins: ${results.wins}`);
      console.log(`Losses: ${results.losses}`);
      console.log(`Win rate: ${results.winRate.toFixed(2)}%`);
      console.log(`Profit factor: ${results.profitFactor.toFixed(2)}`);
      console.log(`Net profit: $${results.netProfit.toFixed(2)}`);
      console.log(`Final equity: $${results.equity.toFixed(2)}`);
      console.log(`Max drawdown: ${results.maxDrawdown.toFixed(2)}%`);
    }

    fs.writeFileSync(outputFile, JSON.stringify(resultSets, null, 2));
    console.log(`Saved detailed backtest results to ${outputFile}`);
  } catch (error) {
    console.error('Backtest failed:', error.message || error);
  }
}

runBacktestCommand();
