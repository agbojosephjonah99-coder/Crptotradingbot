const axios = require('axios');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function sendSignalAlert(signalData) {
  if (!botToken || !chatId) {
    console.warn('Telegram credentials missing (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set); skipping alert');
    return;
  }

  if (signalData.score < 6 || (signalData.signal !== 'BUY' && signalData.signal !== 'SELL')) {
    return;
  }

  const emoji = signalData.signal === 'BUY' ? '🟢' : '🔴';
  const message = [
    `🚨 *MTF CONFIRMED SIGNAL*`,
    ``,
    `${emoji} *${signalData.signal}* — ${signalData.symbol || 'SOL/USDT'}`,
    `💰 Price: \`${Number(signalData.price).toFixed(4)}\``,
    `📈 Trend: ${signalData.trend}`,
    `📊 Score: ${signalData.score}/9`,
    `🔍 RSI: ${Number(signalData.rsi).toFixed(1)}`,
    `✅ Confirmation: ${signalData.confirmationType || 'none'}`,
    `🕐 Time: ${signalData.time}`
  ].join('\n');

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await axios.post(url, {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'
  }, {
    timeout: 8000
  });

  if (!response.data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(response.data)}`);
  }

  console.log(`Telegram alert sent for ${signalData.symbol} ${signalData.signal}`);
  return response.data;
}

async function sendTestMessage() {
  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variable is missing');
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await axios.post(url, {
    chat_id: chatId,
    text: '✅ Crypto Trading Bot connected successfully! You will receive signal alerts here.',
    parse_mode: 'Markdown'
  }, {
    timeout: 8000
  });

  if (!response.data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(response.data)}`);
  }

  return response.data;
}

module.exports = {
  sendSignalAlert,
  sendTestMessage
};
