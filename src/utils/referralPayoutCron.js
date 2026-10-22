const cron = require('node-cron');
const { runReferralRewardCycle } = require('./referralRewardCycle');

let running = false;

// Checks reward release conditions and, only when administrators have enabled
// reward payouts, pays rewards that satisfy every one of them.
const referralPayoutCron = cron.schedule('* * * * *', async () => {
  if (running) return;
  running = true;
  try {
    await runReferralRewardCycle();
  } catch (error) {
    console.error('[referralPayoutCron] Reward cycle failed:', error.message);
  } finally {
    running = false;
  }
});

module.exports = referralPayoutCron;
