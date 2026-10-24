/**
 * GET /api/signal — legacy endpoint (linked from the landing page).
 *
 * Previously this ran its own older copy of the strategy with its own EMA/RSI
 * code. It now returns the same results as /api/v2scan so there is only one
 * strategy in the codebase. Alerts follow the same CRON_SECRET rule.
 */

const { scanSymbols } = require('../src/services/scanEngine');
const { sendSignalAlert } = require('../src/services/telegramService');
const { configuredSymbols } = require('../src/lib/market');
const { cors, mayAlert } = require('../src/lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const results = await scanSymbols(configuredSymbols('SOLUSDT'));
    if (mayAlert(req)) {
      for (const r of results) {
        try { await sendSignalAlert(r); }
        catch (err) { console.error('Telegram notification failed:', err.message); }
      }
    }
    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Signal API Error:', error.message);
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
