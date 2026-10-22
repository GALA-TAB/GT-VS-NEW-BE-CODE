// Referral program: the referrer earns REFERRAL_REWARD_PERCENT of the booking fee Gala Tab
// RETAINS from ONE referred booking (capped at REFERRAL_REWARD_CAP), and only when that
// retained fee is at least MINIMUM_PLATFORM_FEE. The percentage and the minimum apply to
// Gala Tab's booking-fee revenue, never to the booking total or the vendor's payout, and
// fees from different bookings are never combined.
const REFERRAL_REWARD_PERCENT = 10;
const REFERRAL_REWARD_CAP = 250;
const MINIMUM_PLATFORM_FEE = 500;
const REFERRAL_RULES_MODEL = 'fee_percent_v3';
// Rewards recorded earlier as a fixed $50 keep their amount.
const FLAT_RULES_MODEL = 'flat_fee_v2';

const isFeeBasedModel = (model) => model === REFERRAL_RULES_MODEL || model === FLAT_RULES_MODEL;

const toCents = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100);
const fromCents = (cents) => Number((cents / 100).toFixed(2));

const calculatePlatformFee = (totalPrice, feePercent) => {
  const totalCents = toCents(totalPrice || 0);
  const percent = Number(feePercent || 0);
  if (!Number.isFinite(totalCents) || !Number.isFinite(percent) || totalCents <= 0 || percent <= 0) return 0;
  return fromCents(Math.round((totalCents * percent) / 100));
};

// Refunds are absorbed by the vendor's share of the booking first (the customer
// only gets Gala Tab's fee back once the refund exceeds what the vendor would
// receive), so the fee Gala Tab retains is what is left of the fee after that.
const calculateRetainedPlatformFee = ({ totalPrice, platformFee, refundedAmount = 0 }) => {
  const totalCents = toCents(totalPrice || 0);
  const feeCents = Math.min(Math.max(toCents(platformFee || 0), 0), Math.max(totalCents, 0));
  const refundCents = Math.min(Math.max(toCents(refundedAmount || 0), 0), Math.max(totalCents, 0));
  if (![totalCents, feeCents, refundCents].every(Number.isFinite)) return 0;
  const vendorShareCents = totalCents - feeCents;
  const feeRefundedCents = Math.min(feeCents, Math.max(0, refundCents - vendorShareCents));
  return fromCents(feeCents - feeRefundedCents);
};

const calculateReferralReward = (
  retainedPlatformFee,
  {
    rewardPercent = REFERRAL_REWARD_PERCENT,
    rewardCap = REFERRAL_REWARD_CAP,
    minimumPlatformFee = MINIMUM_PLATFORM_FEE
  } = {}
) => {
  const retainedCents = toCents(retainedPlatformFee || 0);
  if (!Number.isFinite(retainedCents) || retainedCents < toCents(minimumPlatformFee)) return 0;
  const percentCents = Math.round((retainedCents * Number(rewardPercent)) / 100);
  return fromCents(Math.min(percentCents, toCents(rewardCap)));
};

// A reward is recalculated from the retained fee using the rate and cap it was created
// with. Rewards recorded as a fixed amount keep that amount while the fee stays eligible.
const calculateRewardForCommission = (commission, retainedPlatformFee) => {
  const minimumPlatformFee = commission.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE;
  if (commission.rewardPercent != null) {
    return calculateReferralReward(retainedPlatformFee, {
      rewardPercent: commission.rewardPercent,
      rewardCap: commission.rewardCap ?? REFERRAL_REWARD_CAP,
      minimumPlatformFee
    });
  }
  return toCents(retainedPlatformFee || 0) >= toCents(minimumPlatformFee) ? Number(commission.amount || 0) : 0;
};

const evaluateReferralPayoutEligibility = ({
  booking,
  commission,
  settings,
  payoutAccount,
  now = new Date()
}) => {
  if (!booking || !commission) return { eligible: false, reason: 'missing_booking_or_commission' };
  if (['canceled', 'rejected'].includes(booking.status)) return { eligible: false, reason: 'booking_canceled' };
  if (booking.inDispute) return { eligible: false, reason: 'dispute_unresolved' };
  if (booking.cancelRequest) return { eligible: false, reason: 'refund_unresolved' };
  let rewardAmount = commission.amount;
  if (isFeeBasedModel(commission.rulesModel)) {
    const retained = Number(commission.retainedPlatformFee ?? commission.platformFeeAmount ?? 0);
    rewardAmount = calculateRewardForCommission(commission, retained);
    if (rewardAmount <= 0) return { eligible: false, reason: 'platform_fee_below_threshold' };
  }
  if (!commission.completionConfirmedAt || new Date(booking.checkOut) > now) {
    return { eligible: false, reason: 'completion_not_confirmed' };
  }
  if (booking.paymentStatus !== true) {
    return { eligible: false, reason: 'booking_not_fully_paid' };
  }
  const eligibleAt =
    new Date(commission.completionConfirmedAt).getTime() +
    Number(commission.completionDelayHours ?? settings?.completionDelayHours ?? 48) * 60 * 60 * 1000;
  if (eligibleAt > now.getTime()) {
    return { eligible: false, reason: 'completion_delay_active', eligibleAt: new Date(eligibleAt) };
  }
  if (!settings?.payoutsEnabled) return { eligible: false, reason: 'payouts_disabled', eligibleAt: new Date(eligibleAt) };
  if (payoutAccount?.payoutOnboardingStatus !== 'verified' || !payoutAccount?.stripeAccountId) {
    return { eligible: false, reason: 'payout_onboarding_incomplete', eligibleAt: new Date(eligibleAt) };
  }
  if (!commission.availableFundsVerified) {
    return { eligible: false, reason: 'funds_unavailable', eligibleAt: new Date(eligibleAt) };
  }
  return { eligible: true, reason: null, eligibleAt: new Date(eligibleAt), rewardAmount };
};

module.exports = {
  REFERRAL_REWARD_PERCENT,
  REFERRAL_REWARD_CAP,
  MINIMUM_PLATFORM_FEE,
  REFERRAL_RULES_MODEL,
  FLAT_RULES_MODEL,
  isFeeBasedModel,
  toCents,
  fromCents,
  calculatePlatformFee,
  calculateRetainedPlatformFee,
  calculateReferralReward,
  calculateRewardForCommission,
  evaluateReferralPayoutEligibility
};
