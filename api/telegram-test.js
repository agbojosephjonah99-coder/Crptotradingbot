const axios = require('axios');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  // Step 1: Check env vars are present
  const diagnosis = {
    env: {
      TELEGRAM_BOT_TOKEN: botToken ? `SET (ends in ...${botToken.slice(-6)})` : 'MISSING ❌',
      TELEGRAM_CHAT_ID:   chatId   ? `SET (value: ${chatId})` : 'MISSING ❌',
    },
    botInfo:     null,
    sendResult:  null,
    error:       null
  };

  if (!botToken || !chatId) {
    return res.status(200).json({
      success: false,
      diagnosis,
      fix: 'Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your Vercel environment variables.'
    });
  }

  // Step 2: Verify the bot token is valid via getMe
  try {
    const getMeRes = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 8000 });
    diagnosis.botInfo = getMeRes.data.ok
      ? { valid: true, username: getMeRes.data.result.username, id: getMeRes.data.result.id }
      : { valid: false, raw: getMeRes.data };
  } catch (err) {
    diagnosis.botInfo = { valid: false, error: err.response?.data || err.message };
    diagnosis.error = 'Bot token is invalid or Telegram API is unreachable.';
    return res.status(200).json({ success: false, diagnosis });
  }

  // Step 3: Try sending a test message and capture the full Telegram response
  try {
    const sendRes = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text: '✅ Test message from your Crypto Trading Bot! Notifications are working.' },
      { timeout: 8000 }
    );
    diagnosis.sendResult = { ok: true, message_id: sendRes.data.result?.message_id };
    return res.status(200).json({ success: true, diagnosis });
  } catch (err) {
    const telegramError = err.response?.data;
    diagnosis.sendResult = { ok: false, raw: telegramError };

    // Diagnose the specific error
    if (telegramError?.error_code === 400 && telegramError?.description?.includes('chat not found')) {
      diagnosis.error = 'CHAT_ID is wrong or the bot has never been messaged. Fix: open your bot in Telegram and send it /start, then get your chat ID from https://api.telegram.org/bot' + botToken + '/getUpdates';
    } else if (telegramError?.error_code === 403) {
      diagnosis.error = 'Bot is blocked or chat_id is for a user who blocked the bot. Fix: unblock the bot in Telegram or re-send /start to it.';
    } else if (telegramError?.error_code === 401) {
      diagnosis.error = 'Bot token is invalid. Double-check TELEGRAM_BOT_TOKEN in Vercel env vars.';
    } else {
      diagnosis.error = telegramError?.description || err.message;
    }

    return res.status(200).json({ success: false, diagnosis });
  }
};