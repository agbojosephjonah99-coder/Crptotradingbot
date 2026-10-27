/**
 * Auto-buy settings: which coins, how much risk, and what it takes to unlock
 * real-money buying. Coins can be overridden with AUTOBUY_UNIVERSE=BTC,ETH,…
 */
const DEFAULT_UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'NEAR', 'ATOM', 'UNI'];

function universe() {
  const env = (process.env.AUTOBUY_UNIVERSE || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return (env.length ? env : DEFAULT_UNIVERSE).map(s => (s.endsWith('USDT') ? s : `${s}USDT`));
}

module.exports = {
  universe,
  // Safety limits (practice AND live)
  LIMITS: {
    riskPct: 1,          // % of the account lost if a trade hits its first stop
    maxPositionPct: 20,  // no single coin bigger than this % of the account
    maxOpen: 5,          // at most this many auto-bought positions at once
    dailyLossPct: 3,     // if the account fell this much today, no new buys today
    minOrderUsd: 5,      // Binance's own Spot minimum for most USDT pairs (some coins need more; Binance's rule is checked too)
  },
  // What live auto-buy needs before the admin can unlock it
  GATE: {
    researchVerdict: 'PASS', // from `npm run lab` → data/auto-strategy.json
    forwardDays: 56,         // the house practice account has run for 8+ weeks
    forwardTrades: 20,       // with at least 20 closed trades
    forwardProfit: true,     // and made money after fees
  },
  // Used only if data/auto-strategy.json (the saved `npm run lab` result) is missing.
  // These are the settings that PASSED the 3,000-day lab test (Oct 2026), so a
  // missing file never switches the bot to an untested strategy. Without the
  // file the verdict still shows "NOT TESTED", so live auto-buy can't be unlocked
  // on it, and the health check and the admin's daily report warn about it.
  FALLBACK: { family: 'donchian', params: { entryN: 55, exitN: 20, regime: true }, id: 'donchian:55-20:btc' },
  STRATEGY_FILE: 'data/auto-strategy.json',
  DAILY_RUN_AFTER_UTC_MINUTES: 5, // run each day at 00:05 UTC or later (after the daily candle closes)
};
