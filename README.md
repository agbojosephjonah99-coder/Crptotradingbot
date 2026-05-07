# ─── V2 Configuration ────────────────────────────────────────────────────────

# Coins to scan (comma-separated Binance pairs)
# Add as many as you want — scanner handles all of them
BINANCE_SYMBOLS=SOLUSDT,BTCUSDT,ETHUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,INJUSDT

# Telegram notifications (optional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# ─── V2 Endpoints (once deployed on Vercel) ───────────────────────────────────
# GET  /api/v2scan      — Multi-timeframe scanner for BINANCE_SYMBOLS
# GET  /api/v2listings  — New listing pump scanner (all Binance USDT pairs)
# GET  /api/v2advice?symbol=SOLUSDT&buyPrice=150&tp=8&sl=5  — Position exit advice
# POST /api/v2advice    — Same but as JSON body { symbol, buyPrice, tp, sl }
# 
# Dashboard: /dashboard
