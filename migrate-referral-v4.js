/**
 * Transition to the updated Refer & Earn terms (gala-tab-referral-2026-10-v4):
 * 10% of the retained booking fee, up to $250 per referred customer, no minimum fee,
 * 0% fee bookings excluded.
 *
 * Rewards already earned or recorded are NEVER recalculated, cancelled, or paid again by this
 * script. Each keeps the rules model and amounts recorded on it (fixed $50, or 10% with the
 * $500 minimum fee); only bookings made after the new settings version takes effect follow
 * the new terms.
 *
 * The one thing it does is register each live earlier reward against its referred customer, so
 * the one-live-reward-per-customer rule also covers customers who were rewarded before the
 * update. Without this, an earlier reward would not stop a second one for the same customer.
 *
 * Dry run by default.   node migrate-referral-v4.js
 * Apply the changes:    node migrate-referral-v4.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const apply = process.argv.includes('--apply');

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  const commissions = mongoose.connection.collection('referralcommissions');

  const live = await commissions
    .find({
      referredUser: { $type: 'objectId' },
      customerClaim: null,
      status: { $ne: 'canceled' }
    })
    .sort({ createdAt: 1 })
    .toArray();

  const seen = new Set(
    (await commissions.find({ customerClaim: { $type: 'objectId' } }, { projection: { customerClaim: 1 } }).toArray())
      .map((doc) => String(doc.customerClaim))
  );

  let registered = 0;
  const duplicates = [];
  for (const doc of live) {
    const customer = String(doc.referredUser);
    if (seen.has(customer)) {
      duplicates.push({ commission: String(doc._id), customer });
      continue;
    }
    seen.add(customer);
    registered += 1;
    if (apply) {
      await commissions.updateOne(
        { _id: doc._id },
        { $set: { customerClaim: doc.referredUser } }
      );
    }
  }

  console.log(`Earlier rewards registered against their referred customer: ${registered}`);
  console.log(`Additional live rewards for an already-registered customer (left untouched, review manually): ${duplicates.length}`);
  duplicates.forEach((item) => console.log(`  commission ${item.commission} · customer ${item.customer}`));
  if (!apply) console.log('Dry run only. Re-run with --apply to make these changes.');

  if (apply) {
    await commissions.createIndex(
      { customerClaim: 1 },
      { unique: true, partialFilterExpression: { customerClaim: { $type: 'objectId' } } }
    );
    console.log('Ensured the unique customerClaim index.');
  }
  await mongoose.disconnect();
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
