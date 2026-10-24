# Changelog

## 2.5.0 — Reliability

### Do this after deploying
- **Nothing is required.** Existing users, positions and trades move to the new storage format automatically, the first time each is read. The old values are kept as `…-legacy-backup` keys in Upstash.
- Optional: open `/api/set-commands?key=…` once to add `/setstop` to the bot's menu, and `/api/health?key=…` to check every data source from Vercel.

### Saved data can no longer be overwritten
- **Positions:** one Redis hash per position, plus an index per user. Each update writes only the fields it changes. Before, every change rewrote a single JSON value holding all of a user's positions, so a buy made while the monitor was running, or a "stop hit" flag set by quickcheck at the same moment as the monitor, could silently disappear.
- **Trades:** an append-only list, so simultaneous `sold` records are all kept.
- **Users:** one hash field per user, so an approval and a new `/start` at the same moment both survive.
- **Duplicate-alert protection:** atomic claims (SET NX with expiry). Two scans running at once can't both send the same BUY alert, and a failed send releases the claim so the next run retries.
- **An update can't resurrect a position the user just removed.**

### Stops follow the plan
- After TP1, the saved stop moves to breakeven; after TP2, to TP1. The alerts already told users to do this, but the bot kept watching the original stop, so a return to entry after TP1 produced no alert. Now you get "🟡 BREAKEVEN STOP" or "🟢 PROFIT STOP".
- Stops only ever move up.
- **Your own stop:** `buy SOL 92.5 2x sl 88`; targets are then built from your stop.
- **Change it later:** `setstop SOL 90`, or `setstopid <entry id> 90` when you have several entries. A stop above the current price is refused.

### No more timeouts or duplicate replies
- **Telegram webhook** replies instantly and finishes slow commands (scan, newlistings, split) in the background, using `waitUntil` from `@vercel/functions`. Repeated deliveries of the same update are ignored.
- **Monitor** fetches market data once per coin instead of once per position, 4 coins in parallel. Quickcheck fetches prices 6 at a time. Overlapping runs of either are skipped.
- **Moonshot / listings scans:** one batch CoinGecko call replaces ~60 single calls. Contract addresses are fetched only for the coins shown, KuCoin calls run 5 at a time, and CoinGecko/KuCoin calls retry on rate limits (429) and server errors.
- `/api/v2listings` names all candidates in one call and fetches contract details only for BUYs.
- All functions may run up to 60 seconds (`vercel.json` → `maxDuration`).

### Data sources that work from Vercel
- Functions now run in **Frankfurt (`fra1`)**: closer to Nigeria, and api.binance.com doesn't block it (it blocks Vercel's default US region).
- `/api/v2listings` also falls back to the Binance public mirror.
- **New `/api/health?key=…`** checks Binance, the Binance mirror, Kraken, KuCoin, CoinGecko, Upstash and Telegram from the function's region, and returns 503 if something critical is down.

### Also included (from 2.4.0)
- `npm run research` and `src/config/strategy.js` (see `STRATEGY.md`).

- Tests: 70. Requires Node 20+ (Vercel's default).


## 2.3.0 — Honest strategy

### Do this after deploying
1. On your computer: `npm install`, then `npm run backtest`. This needs internet access to Binance and takes a few minutes. Add `-- --days 365` for more trades.
2. Commit and push the new `data/strategy-stats.json`. BUY alerts and the dashboard's Track Record tab then show the measured results.

### What changed
- **The backtest now tests the strategy the bot actually trades.** New `src/services/strategyBacktest.js` replays history through the live scanner's own `evaluateSignal()`, with the same candle windows. It trades the plan the BUY alert gives (TP1 40% → breakeven, TP2 35% → stop to TP1, TP3 25%), entering at the next candle's open.
- **Costs included:** 0.1% fee per fill, 0.05% slippage on market fills, the stop counted first when a candle touches both stop and target, and gaps filling at the open. All adjustable with `--fee`, `--slippage`, `--risk` and `--max-hold-hours`.
- **Honest statistics** (`src/services/strategyStats.js`): average profit per trade in R, win rate with a 95% range, profit factor, max drawdown, buy-and-hold comparison, results by setup score, warnings below 30 trades, and a plain-English verdict that says so when the strategy lost money.
- **No more made-up confidence:**
  - BUY alerts replace "Confidence 73% |███████░░░|" (which was just score ÷ 15) with the measured backtest line.
  - The dashboard shows "Setup score x/15" plus the track record.
  - Moonshot / scan / listings scores are labelled "heuristic, not backtested" everywhere, and the manual no longer promises "high-probability" or "2X–5X in 3 days".
- **Live signals no longer repaint.** The scanner ignores the still-forming candle, so a BUY can't appear and vanish within the same 15 minutes, and live signals match what was backtested.
- **Binance mirror fallback:** candles and prices also try `data-api.binance.vision` before Kraken. This helps Vercel's US servers, which `api.binance.com` blocks.
- **ADX** is now the standard Wilder calculation: it matches charting platforms and is about 30× faster. Live ADX values shift slightly as a result.
- **Dashboard:** new **Track Record** tab.
- `/api/backtest` serves the saved results (a real backtest is too heavy for a serverless request).
- **Removed** the old strategy (`signalService.js`), the old backtester (`backtestService.js`, `utils/helpers.js`) and the stale `backtest-results.json`, which tested a different strategy with look-ahead.
- New `STRATEGY.md` explains the method and how to read the numbers.
- Tests: 39 (11 new for the backtester: trade-plan maths, exact fees, stop-first, gaps, next-open entry, no look-ahead).


## 2.2.0 — Fix & secure

### ⚠️ Do this after deploying
1. Add two new environment variables in Vercel, each a long random string:
   - `CRON_SECRET`
   - `TELEGRAM_WEBHOOK_SECRET` (letters, numbers, `_` and `-` only)
2. Open `https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once. This re-registers the webhook with the secret.
3. Add `?key=YOUR_CRON_SECRET` to every cron-job.org URL (`v2quickcheck`, `v2monitor`, `v2scan`, `v2listings-alert`, `v2moonshot`).

Until steps 1–2 are done, everything keeps working as before, but the security holes stay open (the logs warn about this).

### Security
- **Webhook verification:** Telegram updates must carry `TELEGRAM_WEBHOOK_SECRET`. Before, anyone could POST a fake update "from" the admin chat ID and get admin powers.
- **Cron key:** endpoints that send messages or change data now require `CRON_SECRET`. `v2scan`, `v2listings` and `signal` still return data publicly (the dashboard uses them), but only keyed calls send alerts.
- **No token leak:** `/api/telegram-test` used to return a URL containing the full bot token. It now requires the key and never echoes the token or chat ID.
- **`/api/set-commands`** requires the key, and now also registers the webhook with its secret.
- **Privacy:** milestone and HOLD alerts for each user's positions used to go to the shared info channel, where every member could see them. They now go only to the owner's chat, delivered silently. The info channel carries market-wide alerts only.
- **Dashboard:** API text is HTML-escaped before display.

### Bugs fixed
- `node index.js`, `node scheduler.js` and `node backtest.js` crashed (`calculateEMA is not a function`).
- `sold SOL 92.5 185` only deleted the position and never recorded the trade, so `profit` stats stayed empty. It now records the trade (using the position's quantity if you don't give one) and removes the matching entry. Plain `sold SOL` still works as `sell`.
- Position advice fetched 50 four-hour candles but EMA200 needs 200+, so the 4H trend was always "UNKNOWN". It now fetches 250.
- `v2moonshot` never alerted: it read `score` and `reasons`, which don't exist. It now uses `probability` and `greenSignals`, with a threshold set by `MOONSHOT_MIN_SCORE` (default 70).
- The 4-hourly HOLD update never fired, because `lastChecked` was reset every 30 minutes. It now has its own timer.
- **Stops and take-profits are locked per position.** They used to be recalculated from the live ATR every check, so they drifted and the two monitors disagreed. They're now saved when you `buy` (or on the first check for older positions).
- "Approaching target" fired every 10 minutes while the price was within 5% of the target. It now fires once.
- Jumping past several 10% milestones used to send them one by one on later runs. Now one alert is sent and all of them are marked.
- Jumping straight to TP2 or TP3 used to leave the lower TPs unmarked, so they alerted later. They're now marked too.
- "Buy #N" numbering was off by one.
- Admin `remove SOL` deleted a *user* lookup instead of the position. Now `remove <numeric id>` removes a user and `remove SOL` removes the position.
- `/command@BotName` didn't work in group chats.
- Messages containing coin names or usernames with `_`, `*` and similar characters were rejected by Telegram and lost silently. They're now re-sent as plain text.
- Duplicate-alert protection was held in memory and reset on every Vercel cold start. It's now stored in Redis.
- Alerts started with `setImmediate` could be frozen after the response on serverless. They're now awaited.
- **The backtest could see the future:** it used the still-forming 1H/4H candle. It now only uses fully closed candles, and a stop that the price gaps through fills at the open. Older `backtest-results.json` files were produced with the leak and look better than reality.
- Profit tracker: "last month" was wrong on the 29th–31st, and a $0 P&L showed as blank.
- Dashboard: listings were always empty, BUY levels and advice levels showed "—", and the TP%/SL% fields were ignored by the API. They're replaced with account size and risk %, which the API does use.
- Scheduler: a failed run no longer kills the process.

### Cleanup
- New shared modules in `src/lib/`: `telegram.js`, `redis.js`, `market.js`, `auth.js`. These replace 5–7 copies each of Telegram sending, Upstash access, Kraken mapping and candle fetching.
- The live strategy was moved from `api/v2scan.js` to `src/services/scanEngine.js`. The scanner, the local runner and `/api/signal` now share it (`/api/signal` used to run an older copy).
- Position advice was moved to `src/services/adviceService.js`.
- `/api/backtest` uses the shared backtester instead of its own copy.
- The unused `telegraf` dependency was removed.
- `vercel.json` now has `cleanUrls`, so `/dashboard` works.
- `.env.example` lists every variable. The README was rewritten.
- Added `npm test`: 28 offline tests (`test/`).

Existing Redis data (users, positions, trades) uses the same keys and format and loads unchanged.
