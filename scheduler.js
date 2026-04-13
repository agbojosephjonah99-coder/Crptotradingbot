require('dotenv').config();
const cron = require('node-cron');
const { runLiveCheck } = require('./src/services/liveService');

const schedule = process.env.CRON_SCHEDULE || '0 * * * *';

async function startScheduler() {
  console.log(`Starting live signal scheduler: ${schedule}`);
  await runLiveCheck();

  cron.schedule(schedule, async () => {
    console.log('Running scheduled live signal check...');
    await runLiveCheck();
  });
}

startScheduler().catch(error => {
  console.error('Scheduler failed:', error.message || error);
  process.exit(1);
});
