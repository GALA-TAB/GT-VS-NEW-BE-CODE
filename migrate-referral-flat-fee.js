/**
 * One-time migration for the flat-fee Refer & Earn program.
 *
 * Rewards recorded under the earlier percentage program are handled like this:
 *   - paid / processing / eligible rewards, and any reward whose service completion was
 *     already confirmed, are LEFT UNTOUCHED (already earned; their amounts are preserved).
 *   - every other open reward (booking not yet completed) is closed as superseded, because
 *     the percentage and booking-total rules no longer exist. Nothing is deleted; each closed
 *     record keeps its audit trail.
 *
 * Dry run by default.   node migrate-referral-flat-fee.js
 * Apply the changes:    node migrate-referral-flat-fee.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const apply = process.argv.includes('--apply');

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  const commissions = mongoose.connection.collection('referralcommissions');

  const filter = {
    rulesModel: null,
    status: { $in: ['pending', 'failed', 'paused', 'review'] },
    completionConfirmedAt: null
  };
  const open = await commissions.countDocuments(filter);
  const preserved = await commissions.countDocuments({
    rulesModel: null,
    $or: [{ status: { $in: ['eligible', 'processing', 'paid'] } }, { completionConfirmedAt: { $ne: null } }]
  });
  console.log(`Earned percentage-program rewards preserved: ${preserved}`);
  console.log(`Open, unconfirmed percentage-program rewards to close: ${open}`);

  if (apply && open) {
    const result = await commissions.updateMany(filter, {
      $set: { status: 'canceled', updatedAt: new Date() },
      $push: {
        auditTrail: {
          action: 'superseded_by_flat_fee_program',
          reason: 'Percentage-based rewards were replaced by the flat platform-fee reward.',
          at: new Date(),
          metadata: {}
        }
      }
    });
    console.log(`Closed ${result.modifiedCount} reward(s).`);
  } else if (!apply) {
    console.log('Dry run only. Re-run with --apply to make these changes.');
  }
  await mongoose.disconnect();
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
