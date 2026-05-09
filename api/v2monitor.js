/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor
 *
 * Called by Vercel cron every hour.
 * Loops through all open positions, runs v2advice logic,
 * and sends Telegram alerts when action is needed.
 */

const { getAllPositions, updateLastChecked } = require('../src/services/positionStore');
const { sendPositionAlert }                 = require('../src/services/telegramService');

// Reuse the advice logic from v2advice
const { fetchCurrentData, buildAdvice } = require('./v2advice');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const positions = await getAllPositions();
    const entries   = Object.values(positions);

    if (entries.length === 0) {
      return res.status(200).json({ success: true, message: 'No open positions to monitor' });
    }

    const results = [];

    for (const pos of entries) {
      try {
        const { candles1h, candles4h, currentPrice, exchange } = await fetchCurrentData(pos.symbol);

        const advice = buildAdvice({
          symbol:      pos.symbol,
          buyPrice:    pos.buyPrice,
          currentPrice,
          candles1h,
          candles4h,
          accountSize: pos.accountSize,
          riskPct:     pos.riskPct,
        });
        advice.exchange = exchange;

        // Always alert on critical actions
        // Only alert HOLD once every 4 hours (not every single hour)
        const shouldAlert = advice.recommendation !== 'HOLD' ||
          !pos.lastChecked ||
          (Date.now() - new Date(pos.lastChecked).getTime()) > 4 * 60 * 60 * 1000;

        if (shouldAlert) {
          await sendPositionAlert(pos, advice);
        }

        await updateLastChecked(pos.symbol, advice.recommendation);

        results.push({
          symbol:         pos.symbol,
          recommendation: advice.recommendation,
          pnl:            advice.pnlDisplay,
          alerted:        shouldAlert,
        });

      } catch (err) {
        console.error(`[Monitor] Error checking ${pos.symbol}:`, err.message);
        results.push({ symbol: pos.symbol, error: err.message });
      }
    }

    return res.status(200).json({
      success:   true,
      checked:   results.length,
      results,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};