# Setup for crptotradingbot.vercel.app (@JijazyBot)

Your real secret values are in **PRIVATE-vercel-secrets.txt**. That file is kept on your device and never uploaded to GitHub.
Wherever this guide says `YOUR_CRON_SECRET`, use the `CRON_SECRET` value from that file.

## 1. Vercel → crptotradingbot → Settings → Environment Variables

Add:
- `CRON_SECRET`: from the private file
- `TELEGRAM_WEBHOOK_SECRET`: from the private file
- `BOT_USERNAME` = `JijazyBot`
- `PUBLIC_BASE_URL` = `https://crptotradingbot.vercel.app`

Optional — automated exits (2.8.0):
- `TRADING_ENCRYPTION_KEY`: 64 hex characters that encrypt users' Binance keys. Make one with `openssl rand -hex 32` (or see the private file). Without it, automated exits are simply unavailable. **Never change it later** — saved keys could no longer be read, and users would have to connect again.
- `AUTOTRADE_DRY_RUN` = `true` to try it without placing any orders (remove it to go live).

Check these already exist (they were never in the code):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and optionally `TELEGRAM_INFO_CHANNEL_ID`.

Then go to **Deployments → latest → ⋯ → Redeploy**.

## 2. Register the webhook (once)

https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET  → expect `"secretTokenRegistered": true`
https://crptotradingbot.vercel.app/api/health?key=YOUR_CRON_SECRET → health check

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

## 6. Automated exits (optional)

1. Add `TRADING_ENCRYPTION_KEY` (above) and redeploy. `/api/health` should show `"autoExits": {"available": true}`.
2. Go to https://testnet.binance.vision, log in with GitHub, and click **Generate HMAC_SHA256 Key**. Testnet accounts come with fake balances.
3. In Telegram: `autotrade connect API_KEY API_SECRET`, then `autotrade on`.
4. Add a position with a quantity, for a coin you hold on the testnet: `buy BTC 65000 0.01`. The bot replies "Stop placed on Binance (testnet)".
5. Real money, only when you're happy: create a binance.com API key with **Enable Spot & Margin Trading** ON and **withdrawals OFF**. Vercel's IP addresses change, so the key can't be limited to one IP; Binance may put extra limits on unrestricted keys, so check its API Management page. Then `autotrade connect live KEY SECRET` and `autotrade on I UNDERSTAND REAL MONEY`.

## 7. Paid access (optional)

1. Paystack → Settings → API Keys & Webhooks:
   - copy the **Secret key** (start with `sk_test_…` to try it with test cards);
   - set **Webhook URL** to `https://crptotradingbot.vercel.app/paystack-webhook`.
2. Vercel → Environment Variables:
   - `PAYSTACK_SECRET_KEY` = your secret key
   - `SUBSCRIPTION_PRICE` = e.g. `5000` · `SUBSCRIPTION_CURRENCY` = `NGN` · `SUBSCRIPTION_DAYS` = `30`
   - `PAID_ACCESS_ENABLED` = `true` (only when you're ready, because unpaid users lose access straight away; give existing users time first with `grant ID 30`)
3. Redeploy, open `/api/set-commands?key=…` once (adds `/account` and `/subscribe` to the menu), and send `subs` to see everyone's status.
4. Test: from a non-admin account, `subscribe you@example.com` → pay with a Paystack test card → you're sent back to Telegram with "Payment received". Then swap to your `sk_live_…` key.
