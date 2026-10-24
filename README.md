# CryptoBot V2

A Telegram crypto signal and position-tracking bot that runs on Vercel serverless functions.
It **only gives advice and never places trades**.

- **Scanner:** checks your coin list on 4H, 1H and 15M candles (ADX, RSI, StochRSI, MACD, Bollinger Bands, VWAP, OBV, candle patterns), using closed candles only. A strong setup becomes a BUY with an ATR stop and three take-profits.
- **Honest track record:** the live strategy is backtested with fees and slippage. Every BUY alert shows how that kind of signal actually performed (see `STRATEGY.md`).
- **Moonshots / listings:** small-cap gainers from KuCoin and Binance, with CoinGecko data and a 7-factor heuristic score.
- **Telegram bot:** new users wait for admin approval. Users log trades (`buy SOL 92.5 2x`) and the bot monitors them.
- **Monitors:** stop-loss, take-profit, target and milestone alerts, sent to each user's own chat.
- **Dashboard:** `/dashboard`.

## Setup

1. Deploy to Vercel. Add the variables from `.env.example`, at least `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` and the two `UPSTASH_*` values.
2. Open `https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once. This registers the command menu **and** the webhook with its secret token.
3. Optionally, open `/api/telegram-test?key=YOUR_CRON_SECRET` to check the setup.
4. Point your cron jobs (for example cron-job.org) at the endpoints below and **add `?key=YOUR_CRON_SECRET`** to each URL.

## Endpoints

| Endpoint | Schedule | Key needed | What it does |
|---|---|---|---|
| `/api/v2quickcheck` | every 10 min | yes | Price-only check of targets and stops |
| `/api/v2monitor` | every 30 min | yes | Full position check: TPs, milestones, 4h HOLD |
| `/api/v2scan` | every 30–60 min | for alerts | Scanner. Without the key it returns data only |
| `/api/v2listings` | optional | for alerts | Listing scanner. Without the key it returns data only |
| `/api/v2listings-alert` | every 30 min | yes | Broadcasts moonshots, listings and trending coins |
| `/api/v2moonshot` | every 30 min | yes | Sends high-score moonshots to the admin |
| `/api/v2advice?symbol=SOLUSDT&buyPrice=150&account=1000&risk=1` | – | no | Exit advice for one position (read-only) |
| `/api/backtest` | – | no | Saved backtest results of the live strategy (`data/strategy-stats.json`) |
| `/api/signal` | – | for alerts | Legacy endpoint (same output as v2scan) |
| `/api/set-commands`, `/api/telegram-test` | once | always | Admin setup and diagnostics |
| `/api/telegram-webhook` | – | Telegram secret header | Bot updates |

"Key" means `?key=CRON_SECRET` or the header `Authorization: Bearer CRON_SECRET`.
If `CRON_SECRET` is not set, endpoints stay open (with a warning in the logs) so an existing deployment keeps working. **Set it.**

## Telegram commands

`buy SOL 92.50 [qty] [2x|10%]` · `sell SOL` · `sold SOL 92.50 110 [qty]` (records the trade for `profit`) · `positions` · `check SOL` · `profit` · `split 50` · `scan` · `newlistings` · `menu` · `help`

Admin: `pending` · `users` · `approve ID` · `block ID` · `remove ID` · `invite`

## Local use

```bash
npm install
cp .env.example .env    # fill in
npm start               # one scan of BINANCE_SYMBOLS (same engine as /api/v2scan)
npm run scheduler       # repeat on CRON_SCHEDULE
npm run backtest        # backtests the LIVE strategy (needs Binance access) → commit data/strategy-stats.json
npm test                # offline unit tests
```

## Code layout

```
api/                  Vercel functions (one per endpoint)
src/lib/              Shared building blocks: telegram, redis, market data, auth
src/services/         scanEngine (live strategy), strategyBacktest + strategyStats,
                      adviceService, positionStore, userService, profitTracker,
                      listings/probability, risk
data/                 strategy-stats.json (saved backtest summary, shown in alerts)
public/               Landing page + dashboard
test/                 node:test suite (no network)
```

## Known limitations (not changed in this upgrade)

- The moonshot / listings score (0–92) can't be backtested (no free history for its inputs). It is labelled as a heuristic everywhere.
- Backtest results depend on the period tested; re-run `npm run backtest` regularly.
- Binance blocks some server regions (including Vercel's default US region). Candles and prices fall back to Kraken/KuCoin, but `/api/v2listings` is Binance-only.
- Moonshot scans make many CoinGecko calls, and the free tier may rate-limit them.
- Each user's positions are stored as one Redis value. Two writes at the same moment (for example a `buy` while the monitor runs) can still overwrite each other.
- Long scans run inside the request, so very long coin lists may hit serverless time limits.

See `CHANGELOG.md` for what changed, and `STRATEGY.md` for how the strategy is tested.
