const { runLiveCheck } = require('../src/services/liveService');

module.exports = async (req, res) => {
  try {
    const results = await runLiveCheck();
    res.status(200).json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
