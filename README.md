# CryptoBot V2

A Telegram crypto signal and position-tracking bot that runs on Vercel serverless functions.
It **only gives advice and never places trades**.

- **Scanner:** checks your coin list on 4H, 1H and 15M candles (ADX, RSI, StochRSI, MACD, Bollinger Bands, VWAP, OBV, candle patterns), using closed candles only. A strong setup becomes a BUY with an ATR stop and three take-profits.
- **Honest track record:** the live strategy is backtested with fees and slippage. Every BUY alert shows how that kind of signal actually performed (see `STRATEGY.md`).
- **Moonshots / listings:** small-cap gainers from KuCoin and Binance, with CoinGecko data and a 7-factor heuristic score.
- **Telegram bot:** new users wait for admin approval. Users log trades (`buy SOL 92.5 2x`) and the bot monitors them.
- **Monitors:** stop-loss, take-profit, target and milestone alerts, sent to each user's own chat.
- **Dashboard:** `/dashboard`. Send `/dashboard` to the bot for a private login link; you'll see your real positions with live P&L, and can add, update or close them.

## Setup

1. Deploy to Vercel. Add the variables from `.env.example`, at least `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` and the two `UPSTASH_*` values.
2. Open `https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once. This registers the command menu **and** the webhook with its secret token.
3. Optionally, open `/api/health?key=YOUR_CRON_SECRET` to check the setup.
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
| `/api/health` | optional (uptime monitor) | yes | Checks every data source, Upstash and Telegram from Vercel |
| `/api/set-commands` | once | always | Registers the bot menu and webhook |
| `/api/telegram-webhook` | – | Telegram secret header | Bot updates |

"Key" means `?key=CRON_SECRET` or the header `Authorization: Bearer CRON_SECRET`.
If `CRON_SECRET` is not set, endpoints stay open (with a warning in the logs) so an existing deployment keeps working. **Set it.**

## Telegram commands

`buy SOL 92.50 [qty] [2x|10%] [sl 88] [ex mexc]` · `setstop SOL 90` · `sell SOL` · `sold SOL 92.50 110 [qty]` (records the trade for `profit`) · `positions` · `check SOL` · `profit` · `split 50` · `scan` · `newlistings` · `menu` · `help`

Practice (play money, real prices): `practice` · `practice buy SOL 100 [2x] [sl 140]` · `practice sell SOL` · `practice reset`

Go live (guided Binance set-up): `golive`

Automated exits (optional, Binance): `autotrade` · `autotrade connect KEY SECRET` · `autotrade on` · `autotrade off` · `autotrade disconnect` · `autotrade resume SOL`

Paid access (when PAID_ACCESS_ENABLED=true): `account` · `subscribe you@example.com` · `subscribe check`

Admin: `pending` · `users` · `approve ID` · `block ID` · `remove ID` · `invite` · `subs` · `grant ID DAYS` · `revoke ID`

## Local use

```bash
npm install
cp .env.example .env    # fill in
npm start               # one scan of BINANCE_SYMBOLS (same engine as /api/v2scan)
npm run scheduler       # repeat on CRON_SCHEDULE
npm run backtest        # backtests the LIVE strategy (needs Binance access) → commit data/strategy-stats.json
npm run research        # tests 48 strategy variants, chooses on 8 months, judges on 4 unseen months
npm test                # offline unit tests
```

## Code layout

```
api/                  Vercel functions (one per endpoint)
src/lib/              Shared building blocks: telegram, redis, market data, auth
src/services/         scanEngine (live strategy), strategyBacktest + strategyStats,
                      adviceService, positionStore, userService, profitTracker,
                      listings/probability, risk, portfolioService (dashboard),
                      tradingAccounts + autoTrader (automated exits),
                      subscriptionService (paid access, Paystack),
                      practiceService (play-money practice mode)
data/                 strategy-stats.json (saved backtest summary, shown in alerts)
public/               Landing page + dashboard
test/                 node:test suite (no network)
```

## Vercel Hobby limit

The free Hobby plan allows **12 functions** per deployment, and each file in `api/` counts as one. There are 12 now (the maximum); new features are added as actions in `api/app.js`. Before adding a new endpoint, merge or remove one, or the deployment will fail.

## Known limitations (not changed in this upgrade)

- The moonshot / listings score (0–92) can't be backtested (no free history for its inputs). It is labelled as a heuristic everywhere.
- Backtest results depend on the period tested; re-run `npm run backtest` regularly.
- Binance blocks some server regions (including Vercel's default US region). Candles and prices fall back to Kraken/KuCoin, but `/api/v2listings` is Binance-only.
- Moonshot scans make many CoinGecko calls, and the free tier may rate-limit them.
- Functions are limited to 60 seconds; very long coin lists in `BINANCE_SYMBOLS` may need splitting.
- The live strategy was tested and shown to have no edge after fees (see `STRATEGY.md`).

See `CHANGELOG.md` for what changed, and `STRATEGY.md` for how the strategy is tested.
