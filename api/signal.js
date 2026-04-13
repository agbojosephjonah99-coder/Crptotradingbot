const path = require('path');
const { runLiveCheck } = require(path.join(process.cwd(), 'src/services/liveService'));

module.exports = async (req, res) => {
  try {
    const results = await runLiveCheck();
    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
