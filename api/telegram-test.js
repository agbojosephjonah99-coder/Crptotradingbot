const { sendTestMessage } = require('../src/services/telegramService');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await sendTestMessage();
    res.status(200).json({ success: true, message: 'Test message sent to Telegram successfully!' });
  } catch (error) {
    console.error('Telegram test error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};
