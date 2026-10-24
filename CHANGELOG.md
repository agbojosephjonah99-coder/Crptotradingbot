# Changelog

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
