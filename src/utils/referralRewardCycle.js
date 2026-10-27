const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const Payments = require('../models/Payment');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralCommission = require('../models/ReferralCommission');
const stripeClient = require('../config/stripe');
const { evaluateReferralPayoutEligibility, toCents, REFERRAL_RULES_MODEL, V3_RULES_MODEL, FLAT_RULES_MODEL } = require('./referral-program');
const { getCurrentSettings } = require('./referralSettings');
const { cancelReward, claimRewardForBooking } = require('./referralRewards');

const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REPAIR_MIN_AGE_MS = 5 * 60 * 1000;
const ESCROW_SETTLED = ['released', 'completed'];

const CANCELING_REASONS = new Set(['booking_canceled', 'no_qualifying_booking_fee']);

const createBalanceReader = (stripe) => {
  let remaining = null;
  return {
    // Rewards are paid from Gala Tab's own Stripe balance; each reward verified in a
    // cycle reserves its amount so a single balance is never counted twice.
    async reserve(amount) {
      if (!stripe) return false;
      if (remaining === null) {
        try {
          const balance = await stripe.balance.retrieve();
          remaining = (balance.available || []).filter((entry) => entry.currency === 'usd')
            .reduce((sum, entry) => sum + entry.amount, 0);
        } catch (error) {
          console.error('[referralRewards] Could not read the Stripe balance:', error.message);
          return false;
        }
      }
      const cents = toCents(amount);
      if (remaining < cents) return false;
      remaining -= cents;
      return true;
    },
    release(amount) {
      if (remaining !== null) remaining += toCents(amount);
    }
  };
};

// Re-create reward records for qualifying bookings whose ledger write was interrupted.
const repairMissingLedgerEntries = async ({ now }) => {
  const bookings = await Booking.find({
    'referral.eligibility': 'eligible',
    'referral.rewardAmount': { $gt: 0 },
    createdAt: { $gte: new Date(now.getTime() - REPAIR_WINDOW_MS), $lte: new Date(now.getTime() - REPAIR_MIN_AGE_MS) }
  }).select('service referral user totalPrice paymentIntentId');
  if (!bookings.length) return;
  const existing = new Set(
    (await ReferralCommission.find({ booking: { $in: bookings.map((booking) => booking._id) } }).select('booking'))
      .map((commission) => String(commission.booking))
  );
  for (const booking of bookings) {
    if (existing.has(String(booking._id))) continue;
    const listing = await Listing.findById(booking.service).select('vendorId');
    if (!listing) continue;
    await claimRewardForBooking({
      booking,
      vendorId: listing.vendorId,
      paymentIntentIds: booking.paymentIntentId ? [booking.paymentIntentId] : []
    });
  }
};

const markEligibleRewards = async ({ now, settings, balance }) => {
  // Rewards recorded under the earlier percentage program keep their amount; they only continue
  // here once service completion was already confirmed (the migration script closes the rest).
  const candidates = await ReferralCommission.find({
    $and: [
      { $or: [{ rulesModel: { $in: [REFERRAL_RULES_MODEL, V3_RULES_MODEL, FLAT_RULES_MODEL] } }, { rulesModel: null, completionConfirmedAt: { $ne: null } }] },
      {
        $or: [
          { status: 'pending' },
          { status: 'failed', updatedAt: { $lte: new Date(now.getTime() - RETRY_AFTER_FAILURE_MS) } }
        ]
      }
    ]
  }).limit(100);

  for (const commission of candidates) {
    try {
      const booking = await Booking.findById(commission.booking);
      if (!booking) continue;
      const payoutAccount = await ReferralAccount.findOne({ user: commission.referrer });
      const payment = await Payments.findOne({ booking: booking._id });
      // The reward comes out of the booking fee, which is only Gala Tab's to spend once the
      // vendor's escrow window has settled and the Stripe balance can cover it.
      let fundsAvailable = Boolean(payment && ESCROW_SETTLED.includes(payment.escrowStatus));
      if (fundsAvailable && (await balance.reserve(commission.amount))) balance.release(commission.amount);
      else fundsAvailable = false;
      commission.availableFundsVerified = fundsAvailable;
      const eligibility = evaluateReferralPayoutEligibility({ booking, commission, settings, payoutAccount, now });

      if (!eligibility.eligible) {
        if (CANCELING_REASONS.has(eligibility.reason)) {
          await cancelReward(commission, { reason: eligibility.reason });
        } else {
          await commission.save();
        }
        continue;
      }
      if (eligibility.rewardAmount !== commission.amount) commission.amount = eligibility.rewardAmount;
      commission.status = 'eligible';
      commission.eligibleAt = eligibility.eligibleAt;
      commission.payoutOnboardingRequired = false;
      commission.auditTrail.push({ action: 'release_conditions_met', metadata: { eligibleAt: eligibility.eligibleAt } });
      await commission.save();
    } catch (error) {
      console.error('[referralRewards] Eligibility check failed:', commission._id, error.message);
    }
  }
};

const findExistingTransfer = async (stripe, commission) => {
  const transfers = await stripe.transfers.list({ transfer_group: `referral_${commission.booking}`, limit: 10 });
  return (transfers.data || []).find((transfer) => transfer.metadata?.commissionId === String(commission._id)) || null;
};

const payEligibleRewards = async ({ now, settings, stripe, balance }) => {
  if (!settings.payoutsEnabled || !stripe) return;

  await ReferralCommission.updateMany(
    { status: 'processing', processingStartedAt: { $lte: new Date(now.getTime() - STALE_PROCESSING_MS) } },
    { $set: { status: 'eligible' }, $push: { auditTrail: { action: 'processing_timed_out_will_retry' } } }
  );

  const rewards = await ReferralCommission.find({ status: 'eligible' }).limit(50);
  for (const reward of rewards) {
    try {
      const booking = await Booking.findById(reward.booking);
      const payoutAccount = await ReferralAccount.findOne({ user: reward.referrer });
      const blocked =
        !booking ||
        ['canceled', 'rejected'].includes(booking.status) ||
        booking.inDispute ||
        booking.cancelRequest ||
        payoutAccount?.payoutOnboardingStatus !== 'verified' ||
        !payoutAccount?.stripeAccountId;
      if (blocked) {
        await ReferralCommission.updateOne(
          { _id: reward._id, status: 'eligible' },
          { $set: { status: 'pending' }, $push: { auditTrail: { action: 'release_conditions_no_longer_met' } } }
        );
        continue;
      }
      const claimed = await ReferralCommission.findOneAndUpdate(
        { _id: reward._id, status: 'eligible' },
        { $set: { status: 'processing', processingStartedAt: now } },
        { new: true }
      );
      if (!claimed) continue;

      let transfer = await findExistingTransfer(stripe, claimed);
      if (!transfer) {
        if (!(await balance.reserve(claimed.amount))) {
          await ReferralCommission.updateOne(
            { _id: claimed._id, status: 'processing' },
            { $set: { status: 'eligible' } }
          );
          continue;
        }
        transfer = await stripe.transfers.create(
          {
            amount: toCents(claimed.amount),
            currency: 'usd',
            destination: payoutAccount.stripeAccountId,
            transfer_group: `referral_${claimed.booking}`,
            description: 'Gala Tab referral reward',
            metadata: { commissionId: String(claimed._id), bookingId: String(claimed.booking), purpose: 'referral_reward' }
          },
          { idempotencyKey: `referral-reward-${claimed._id}` }
        );
      }
      await ReferralCommission.updateOne({ _id: claimed._id }, { $set: { providerTransferId: transfer.id } });
      await ReferralCommission.findOneAndUpdate(
        { _id: claimed._id, status: 'processing' },
        { $set: { status: 'paid' }, $push: { auditTrail: { action: 'reward_paid', metadata: { transferId: transfer.id } } } },
        { new: true }
      );
    } catch (error) {
      console.error('[referralRewards] Reward payout failed:', reward._id, error.message);
      await ReferralCommission.updateOne(
        { _id: reward._id, status: 'processing' },
        { $set: { status: 'failed' }, $push: { auditTrail: { action: 'payout_failed', reason: String(error.message).slice(0, 300) } } }
      );
    }
  }
};

const runReferralRewardCycle = async ({ now = new Date(), stripe = stripeClient } = {}) => {
  const settings = await getCurrentSettings();
  const balance = createBalanceReader(stripe);
  await repairMissingLedgerEntries({ now });
  await markEligibleRewards({ now, settings, balance });
  await payEligibleRewards({ now, settings, stripe, balance });
};

module.exports = { runReferralRewardCycle, createBalanceReader };
