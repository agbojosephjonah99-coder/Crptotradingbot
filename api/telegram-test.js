/**
 * GET /api/telegram-test?key=CRON_SECRET
 * Checks the bot token and sends a test message to TELEGRAM_CHAT_ID.
 *
 * SECURITY FIX: the old version was public and, on a wrong chat id, returned
 * a getUpdates URL containing the FULL bot token. It now requires CRON_SECRET
 * and never echoes the token or chat id.
 */

const tg = require('../src/lib/telegram');
const { requireAdminKey } = require('../src/lib/auth');

module.exports = async (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  const diagnosis = {
    env: {
      TELEGRAM_BOT_TOKEN:       botToken ? 'SET' : 'MISSING ❌',
      TELEGRAM_CHAT_ID:         chatId   ? 'SET' : 'MISSING ❌',
      TELEGRAM_INFO_CHANNEL_ID: process.env.TELEGRAM_INFO_CHANNEL_ID ? 'SET' : 'not set (info alerts go to main chat)',
      TELEGRAM_WEBHOOK_SECRET:  process.env.TELEGRAM_WEBHOOK_SECRET ? 'SET' : 'MISSING ❌ (webhook can be forged)',
      UPSTASH:                  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? 'SET' : 'MISSING ❌ (data is not persisted)',
    },
    botInfo: null,
    webhook: null,
    sendResult: null,
    error: null,
  };

  if (!botToken || !chatId) {
    return res.status(200).json({ success: false, diagnosis, fix: 'Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your environment variables.' });
  }

  try {
    const me = await tg.call('getMe', {}, 8000);
    diagnosis.botInfo = { valid: true, username: me.username };
  } catch (err) {
    diagnosis.botInfo = { valid: false };
    diagnosis.error = 'Bot token is invalid or Telegram is unreachable.';
    return res.status(200).json({ success: false, diagnosis });
  }

  try {
    const info = await tg.call('getWebhookInfo', {}, 8000);
    diagnosis.webhook = {
      url: info.url || '(none)',
      pendingUpdates: info.pending_update_count,
      lastError: info.last_error_message || null,
    };
  } catch { /* optional */ }

  try {
    await tg.send(chatId, '✅ Test message from your Crypto Trading Bot! Notifications are working.', { plain: true, throwOnError: true });
    diagnosis.sendResult = { ok: true };
    return res.status(200).json({ success: true, diagnosis });
  } catch (err) {
    const msg = err.message || '';
    diagnosis.sendResult = { ok: false };
    if (/chat not found/i.test(msg)) {
      diagnosis.error = 'TELEGRAM_CHAT_ID is wrong, or you have never sent the bot a message. Open the bot in Telegram, send /start, then check the chat id.';
    } else if (/blocked|Forbidden/i.test(msg)) {
      diagnosis.error = 'The bot is blocked by this chat. Unblock it in Telegram and send /start.';
    } else if (/Unauthorized/i.test(msg)) {
      diagnosis.error = 'Bot token is invalid. Double-check TELEGRAM_BOT_TOKEN.';
    } else {
      diagnosis.error = msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');
    }
    return res.status(200).json({ success: false, diagnosis });
  }
};
