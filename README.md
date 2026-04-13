# SOL/USDT Crypto Signal Bot

A lightweight Node.js signal bot for SOL/USDT using Binance data, a multi-timeframe EMA + RSI strategy, backtesting, and Telegram alerts.

## Features

- Multi-Timeframe Confirmation (15m / 1h / 4h)
- Real-time BUY / SELL / WAIT signal generation
- Backtesting engine with profit factor and drawdown
- Telegram alerts for strong MTF signals only
- Clean, modular source structure

## Project Structure

- `index.js` — live signal runner (calls multi-timeframe live service)
- `backtest.js` — backtest runner using 4h / 1h / 15m data
- `src/services/binanceService.js` — Binance data fetcher with paging support
- `src/services/indicatorService.js` — EMA and RSI calculation
- `src/services/signalService.js` — multi-timeframe signal decision logic
- `src/services/backtestService.js` — multi-timeframe backtest engine
- `src/services/telegramService.js` — Telegram notifications for strong signals
- `src/services/liveService.js` — live MTF evaluation service
- `src/utils/helpers.js` — shared utility functions

## Setup

1. Install dependencies

```bash
npm install
```

2. Create a `.env` file in the project root:

```env
BINANCE_SYMBOLS=SOLUSDT
BINANCE_INTERVAL=1h
CRON_SCHEDULE=0 * * * *
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

3. Run a live signal check:

```bash
node index.js
```

4. Run the hourly scheduler:

```bash
npm run scheduler
```

5. Run backtesting:

```bash
npm run backtest
```

## Vercel Deployment

1. Install the Vercel CLI globally:

```bash
npm install -g vercel
```

2. Run locally with Vercel:

```bash
npm run dev
```

3. Deploy to production:

```bash
npm run deploy
```

4. Use API endpoints after deployment:

- `/api/signal` — live signal check
- `/api/backtest` — multi-timeframe backtest

5. Add your environment variables in the Vercel dashboard:

- `BINANCE_SYMBOLS`
- `BINANCE_INTERVAL`
- `CRON_SCHEDULE`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

**Note:** This deploys only the API endpoints as serverless functions. The main bot (`index.js`) is designed to run locally or on a VPS, not on Vercel.


## Multiple Symbols

You can monitor multiple pairs by setting `BINANCE_SYMBOLS` with comma-separated symbols, for example:

```env
BINANCE_SYMBOLS=SOLUSDT,ETHUSDT,BTCUSDT
```

## Signal Storage

The live runner saves the latest signal outputs to `signals.json`.

## Backtest Output

The multi-timeframe backtest writes a full results file to `backtest-results.json` and includes win rate, profit factor, net profit, and drawdown.

## Telegram Alerts

Alerts are sent only when the signal is `BUY` or `SELL` and score is 6 or higher.

Message format:

```
🚨 MTF CONFIRMED SIGNAL
Pair: SOL/USDT
Signal: BUY
Price: 145.23
Trend: UP
Confirmation: bullish
Time: 2026-04-12 14:00
```

## Notes

- The strategy uses 4h trend, 1h setup, and 15m entry confirmation.
- Only signals with a score of 6 or higher return `BUY` or `SELL`.
- Backtesting uses 1% risk per trade and a 1:2 reward:risk ratio.
- Detailed backtest results are saved to `backtest-results.json`.
