/**
 * ─── Quick Price Check ────────────────────────────────────────────────────────
 * GET /api/v2quickcheck
 *
 * Runs every 10 minutes via cron-job.org
 * ONLY checks current price vs target and stop loss.
 * No candle fetching. No technical analysis. Ultra fast.
 *
 * WHY THIS EXISTS:
 *  Small cap coins can 2X and dump back in under 15 minutes.
 *  The full v2monitor (every 30 mins) would miss this entirely.
 *  This endpoint fires the critical alerts (TARGET HIT, STOP LOSS)
 *  as fast as possible — within 10 minutes of the event.
 *
 *  v2monitor still runs every 30 mins for HOLD/TP1/TP2/TP3 alerts.
 *  This only handles the time-critical ones.
 */

const axios  = require('axios');
const { getAllUsersPositions, updatePosition } = require('../src/services/positionStore');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const KUCOIN_BASE = 'https://api.kucoin.com/api/v1';
const BINANCE_BASE = 'https://api.binance.com/api/v3';

// ─── Fetch current price only (no candles) ────────────────────────────────────
async function getCurrentPrice(symbol) {
  // Try Binance first
  try {
    const r = await axios.get(`${BINANCE_BASE}/ticker/price`, {
      params: { symbol },
      timeout: 5000,
    });
    return parseFloat(r.data.price);
  } catch {}

  // Fallback to KuCoin
  try {
    const kuSymbol = symbol.replace('USDT', '-USDT');
    const r = await axios.get(`${KUCOIN_BASE}/market/orderbook/level1`, {
      params: { symbol: kuSymbol },
      timeout: 5000,
    });
    return parseFloat(r.data.data?.price || 0);
  } catch {}

  return null;
}

// ─── Send Telegram alert ──────────────────────────────────────────────────────
async function sendAlert(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[QuickCheck] Alert failed:', e.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const positions = await getAllUsersPositions();

    // Only check positions that have a target or need stop loss monitoring
    const active = positions.filter(p =>
      !p.targetHit &&
      !p.stopLossHit &&
      (p.targetPrice || p.stopLossPrice)
    );

    if (active.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No active targets to check',
        checkedAt: new Date().toISOString(),
      });
    }

    // Group by symbol to avoid duplicate price fetches
    const symbolMap = {};
    for (const pos of active) {
      if (!symbolMap[pos.symbol]) symbolMap[pos.symbol] = [];
      symbolMap[pos.symbol].push(pos);
    }

    const results = [];

    for (const [symbol, symbolPositions] of Object.entries(symbolMap)) {
      const currentPrice = await getCurrentPrice(symbol);
      if (!currentPrice) {
        results.push({ symbol, error: 'Could not fetch price' });
        continue;
      }

      for (const pos of symbolPositions) {
        const pnlPct      = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
        const multiple    = currentPrice / pos.buyPrice;
        const priceStr    = currentPrice < 0.01
          ? currentPrice.toFixed(8)
          : currentPrice.toFixed(4);

        // ── TARGET HIT ────────────────────────────────────────────────────
        if (pos.targetPrice && currentPrice >= pos.targetPrice && !pos.targetHit) {
          await sendAlert(pos.chatId, [
            ``,
            `🚨🎯🚨 *${pos.targetMultiple}X TARGET HIT — ${symbol}* 🚨🎯🚨`,
            ``,
            `🌕 *SELL NOW — YOUR TARGET HAS BEEN REACHED*`,
            ``,
            `💰 *Bought at:*   \`$${pos.buyPrice}\``,
            `📊 *Now:*         \`$${priceStr}\``,
            `📈 *Your gain:*   +${pnlPct.toFixed(2)}% (${multiple.toFixed(2)}X)`,
            pos.quantity ? `💵 *Est. profit:* $${((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2)}` : '',
            ``,
            `⚡ *This alert fired within 10 minutes of the target being hit*`,
            ``,
            `🔴 *DO THIS RIGHT NOW:*`,
            `  1. Open your exchange immediately`,
            `  2. Sell 60% of your position at market price`,
            `  3. Set stop on remaining 40% at your entry ($${pos.buyPrice})`,
            `  4. If price keeps rising → let it run 🚀`,
            `  5. If price drops back → sell the rest`,
            ``,
            `📝 Record your sale: \`sold ${symbol.replace('USDT','')} ${pos.buyPrice} ${priceStr}\``,
            `⏰ ${new Date().toUTCString()}`,
          ].filter(Boolean).join('\n'));

          await updatePosition(pos.chatId, pos.positionId, { targetHit: true });
          results.push({ symbol, positionId: pos.positionId, event: 'TARGET_HIT', price: currentPrice });
        }

        // ── STOP LOSS HIT ─────────────────────────────────────────────────
        else if (pos.stopLossPrice && currentPrice <= pos.stopLossPrice && !pos.stopLossHit) {
          await sendAlert(pos.chatId, [
            `🔴 *STOP LOSS HIT — EXIT NOW — ${symbol}*`,
            ``,
            `⚡ *This alert fired within 10 minutes of the stop being hit*`,
            ``,
            `💰 *Bought at:* \`$${pos.buyPrice}\``,
            `📊 *Now:*       \`$${priceStr}\``,
            `📉 *Loss:*      ${pnlPct.toFixed(2)}%`,
            ``,
            `🔴 *Sell 100% immediately. No hesitation.*`,
            `_A small controlled loss now prevents a catastrophic loss later._`,
            ``,
            `📝 Record your exit: \`sold ${symbol.replace('USDT','')} ${pos.buyPrice} ${priceStr}\``,
            `⏰ ${new Date().toUTCString()}`,
          ].join('\n'));

          await updatePosition(pos.chatId, pos.positionId, { stopLossHit: true });
          results.push({ symbol, positionId: pos.positionId, event: 'STOP_LOSS', price: currentPrice });
        }

        // ── APPROACHING TARGET (within 5%) — early warning ────────────────
        else if (pos.targetPrice && !pos.targetHit) {
          const distPct = ((pos.targetPrice - currentPrice) / currentPrice) * 100;
          if (distPct > 0 && distPct <= 5) {
            await sendAlert(pos.chatId, [
              `⚡ *APPROACHING TARGET — ${symbol}*`,
              ``,
              `💰 Bought at: \`$${pos.buyPrice}\``,
              `📊 Now:       \`$${priceStr}\``,
              `🎯 Target:    \`$${pos.targetPrice}\` (${pos.targetMultiple}X)`,
              `📏 Distance:  ${distPct.toFixed(1)}% away`,
              ``,
              `Get ready to sell when target hits.`,
              `Open your exchange now so you are ready.`,
            ].join('\n'));
            results.push({ symbol, positionId: pos.positionId, event: 'APPROACHING_TARGET', price: currentPrice });
          }
        }
      }
    }

    return res.status(200).json({
      success:    true,
      checked:    active.length,
      symbols:    Object.keys(symbolMap).length,
      alerts:     results.filter(r => r.event),
      checkedAt:  new Date().toISOString(),
    });

  } catch (err) {
    console.error('[QuickCheck]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};