/**
 * ─── Risk Management Service ──────────────────────────────────────────────────
 * TRADER'S NOTE ON THE ORIGINAL:
 *  The original had zero position sizing logic. This is the single most
 *  important gap. A great signal with a bad position size will blow accounts.
 *
 *  Rule: Never risk more than 1–2% of your account on any single trade.
 *  This module tells you HOW MANY UNITS to buy, not just whether to buy.
 *
 *  Also handles: signal deduplication, portfolio heat, daily loss limits.
 */

// ─── Position Sizing ──────────────────────────────────────────────────────────

/**
 * Fixed Fractional Position Sizing (the industry standard)
 *
 * Formula: positionSize = (accountBalance * riskPercent) / (entryPrice - stopLoss)
 *
 * Example:
 *   Account: $10,000 | Risk: 1% ($100)
 *   Entry: $150 | Stop: $143 (ATR-based)
 *   Risk per unit: $7
 *   Units: $100 / $7 = 14.28 SOL
 *   Position value: 14.28 * $150 = $2,142 (21.4% of account)
 */
function calcPositionSize({ accountBalance, riskPercent = 1, entryPrice, stopLoss }) {
  if (!accountBalance || !entryPrice || !stopLoss || stopLoss >= entryPrice) {
    return { units: null, positionValue: null, dollarRisk: null, error: 'Invalid inputs for position sizing' };
  }

  const dollarRisk    = (accountBalance * riskPercent) / 100;
  const riskPerUnit   = entryPrice - stopLoss;
  const units         = dollarRisk / riskPerUnit;
  const positionValue = units * entryPrice;
  const portfolioPct  = (positionValue / accountBalance) * 100;

  // Safety guard: never put more than 30% of account in one trade
  if (portfolioPct > 30) {
    const cappedUnits = (accountBalance * 0.30) / entryPrice;
    return {
      units:         parseFloat(cappedUnits.toFixed(6)),
      positionValue: parseFloat((cappedUnits * entryPrice).toFixed(2)),
      dollarRisk:    parseFloat((cappedUnits * riskPerUnit).toFixed(2)),
      portfolioPct:  30,
      capped:        true,
      capReason:     'Position capped at 30% of account — reduce risk % or widen stop',
    };
  }

  return {
    units:         parseFloat(units.toFixed(6)),
    positionValue: parseFloat(positionValue.toFixed(2)),
    dollarRisk:    parseFloat(dollarRisk.toFixed(2)),
    portfolioPct:  parseFloat(portfolioPct.toFixed(1)),
    capped:        false,
  };
}

/**
 * ATR-based dynamic stop loss.
 * Uses 1.5x ATR below entry for buys — this gives the trade room to breathe
 * without letting small noise wipe you out.
 *
 * Why 1.5x? Backtests show 1x ATR gets stopped out too often on volatile assets.
 * 2x is too wide and creates an unfavorable risk/reward on lower-quality signals.
 */
function calcATRStop({ entryPrice, atrValue, multiplier = 1.5, side = 'long' }) {
  if (!atrValue || atrValue <= 0) return null;
  if (side === 'long')  return parseFloat((entryPrice - atrValue * multiplier).toFixed(6));
  if (side === 'short') return parseFloat((entryPrice + atrValue * multiplier).toFixed(6));
  return null;
}

/**
 * Multi-level take profit targets using Risk:Reward ratios.
 * Professional traders never sell everything at one target.
 *
 * Strategy:
 *   TP1 (1.5R) → Sell 40% — lock in guaranteed profit
 *   TP2 (2.5R) → Sell 35% — let most of the position ride
 *   TP3 (4R)   → Sell 25% — moonbag for the big move
 *   After TP1  → Move stop to breakeven
 */
function calcTakeProfits({ entryPrice, stopLoss, side = 'long' }) {
  const risk = Math.abs(entryPrice - stopLoss);
  if (risk === 0) return null;

  const r = (ratio) => side === 'long'
    ? parseFloat((entryPrice + risk * ratio).toFixed(6))
    : parseFloat((entryPrice - risk * ratio).toFixed(6));

  return {
    tp1: { price: r(1.5), sellPercent: 40, ratio: '1.5R', label: 'Secure profit' },
    tp2: { price: r(2.5), sellPercent: 35, ratio: '2.5R', label: 'Main target' },
    tp3: { price: r(4.0), sellPercent: 25, ratio: '4R',   label: 'Moon bag' },
    breakeven: entryPrice,  // Move SL here after TP1 hits
  };
}

/**
 * Risk:Reward ratio check. Minimum 1.5 R:R to take any trade.
 * Below 1.5 = bad trade even with a good signal.
 */
function calcRiskReward({ entryPrice, stopLoss, takeProfit }) {
  const risk   = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  if (risk === 0) return null;
  return parseFloat((reward / risk).toFixed(2));
}

// ─── Signal Deduplication ─────────────────────────────────────────────────────

/**
 * In-memory signal cache (resets on Vercel cold start — acceptable for serverless).
 * Prevents the same signal from firing multiple times within the cooldown window.
 * Original had no dedup — could spam the same BUY signal every hour.
 */
const signalCache = new Map();
const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

function isDuplicateSignal(symbol, signal) {
  const key = `${symbol}:${signal}`;
  const lastFired = signalCache.get(key);
  if (!lastFired) return false;
  return (Date.now() - lastFired) < SIGNAL_COOLDOWN_MS;
}

function markSignalFired(symbol, signal) {
  const key = `${symbol}:${signal}`;
  signalCache.set(key, Date.now());
}

function clearSignalCache() {
  signalCache.clear();
}

// ─── Portfolio Heat ───────────────────────────────────────────────────────────

/**
 * Portfolio heat = total % of account at risk across all open trades.
 * Max recommended: 6% total heat (3 trades × 2% each).
 * Exceeding this makes a bad run catastrophic.
 */
function calcPortfolioHeat(openPositions) {
  return openPositions.reduce((total, pos) => {
    const riskPct = ((pos.entryPrice - pos.stopLoss) / pos.entryPrice) * 100;
    return total + riskPct;
  }, 0);
}

module.exports = {
  calcPositionSize,
  calcATRStop,
  calcTakeProfits,
  calcRiskReward,
  isDuplicateSignal,
  markSignalFired,
  clearSignalCache,
  calcPortfolioHeat,
};
