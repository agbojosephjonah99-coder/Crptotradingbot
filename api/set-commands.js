/**
 * ─── Set Telegram Bot Commands (Menu) ────────────────────────────────────────
 * GET /api/set-commands
 *
 * Visit this URL once in your browser after deploying:
 * https://crptotradingbot.vercel.app/api/set-commands
 *
 * This registers all commands with Telegram so they appear
 * as a menu when users tap the "/" button in the chat.
 */

const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async (req, res) => {
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  const commands = [
    {
      command: 'scan',
      description: '🔍 Scan market for high-probability pump coins now',
    },
    {
      command: 'moonshots',
      description: '🌕 Find coins likely to 2X-5X within 3 days',
    },
    {
      command: 'newlistings',
      description: '🚀 Hot newly listed coins with contract addresses',
    },
    {
      command: 'buy',
      description: '💰 Register a buy — e.g. /buy SOL 92.50 or /buy SOL 92.50 2x',
    },
    {
      command: 'sell',
      description: '💸 Remove a position after you exit — e.g. /sell SOL',
    },
    {
      command: 'positions',
      description: '📊 View all your open positions and their status',
    },
    {
      command: 'check',
      description: '🔎 Get instant advice on a position — e.g. /check SOL',
    },
    {
      command: 'help',
      description: '📖 Show all commands and how to use them',
    },
  ];

  try {
    const resp = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`,
      { commands },
      { timeout: 10000 }
    );

    if (resp.data.ok) {
      return res.status(200).json({
        success: true,
        message: '✅ Bot menu commands registered successfully',
        commands: commands.map(c => `/${c.command} — ${c.description}`),
      });
    } else {
      return res.status(500).json({ success: false, error: resp.data });
    }

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};