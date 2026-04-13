const { Telegraf } = require('telegraf');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = botToken ? new Telegraf(botToken) : null;

async function sendSignalAlert(signalData) {
  if (!bot || !chatId) {
    console.warn('Telegram credentials missing; skipping alert');
    return;
  }

  if (signalData.score < 6 || (signalData.signal !== 'BUY' && signalData.signal !== 'SELL')) {
    return;
  }

  const message = `🚨 MTF CONFIRMED SIGNAL\nPair: ${signalData.symbol || 'SOL/USDT'}\nSignal: ${signalData.signal}\nPrice: ${signalData.price.toFixed(2)}\nTrend: ${signalData.trend}\nConfirmation: ${signalData.confirmationType || 'none'}\nTime: ${signalData.time}`;
  await bot.telegram.sendMessage(chatId, message);
}

module.exports = {
  sendSignalAlert
};
