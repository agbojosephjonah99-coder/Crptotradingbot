# Setup for crptotradingbot.vercel.app (@JijazyBot)

Your real secret values are in **PRIVATE-vercel-secrets.txt**. That file is kept on your device and never uploaded to GitHub.
Wherever this guide says `YOUR_CRON_SECRET`, use the `CRON_SECRET` value from that file.

## 1. Vercel → crptotradingbot → Settings → Environment Variables

Add:
- `CRON_SECRET`: from the private file
- `TELEGRAM_WEBHOOK_SECRET`: from the private file
- `BOT_USERNAME` = `JijazyBot`
- `PUBLIC_BASE_URL` = `https://crptotradingbot.vercel.app`

Check these already exist (they were never in the code):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and optionally `TELEGRAM_INFO_CHANNEL_ID`.

Then go to **Deployments → latest → ⋯ → Redeploy**.

## 2. Register the webhook (once)

https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET  → expect `"secretTokenRegistered": true`
https://crptotradingbot.vercel.app/api/telegram-test?key=YOUR_CRON_SECRET → health check

## 3. cron-job.org

| Job | Every | URL |
|---|---|---|
| Quick check | 10 min | `https://crptotradingbot.vercel.app/api/v2quickcheck?key=YOUR_CRON_SECRET` |
| Monitor | 30 min | `https://crptotradingbot.vercel.app/api/v2monitor?key=YOUR_CRON_SECRET` |
| Scanner | 30–60 min | `https://crptotradingbot.vercel.app/api/v2scan?key=YOUR_CRON_SECRET` |
| Listings alert | 30 min | `https://crptotradingbot.vercel.app/api/v2listings-alert?key=YOUR_CRON_SECRET` |
| Moonshots | 30 min | `https://crptotradingbot.vercel.app/api/v2moonshot?key=YOUR_CRON_SECRET` |

The dashboard stays public at https://crptotradingbot.vercel.app/dashboard

## 4. Backtest the strategy (once, then monthly)

On your computer, inside the project folder:
```bash
npm install
npm run backtest
git add data/strategy-stats.json
git commit -m "Backtest results"
git push
```
BUY alerts and the dashboard's Track Record tab will then show the measured results. See `STRATEGY.md`.

## 5. Test

Send `/start` to @JijazyBot. Then try `buy SOL 150 2x` → `positions` → `sold SOL 150 160` → `profit`.
