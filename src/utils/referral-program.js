// Referral program: the referrer earns REFERRAL_REWARD_PERCENT of the booking fee Gala Tab
// RETAINS from a referred customer's first qualifying booking, capped at REFERRAL_REWARD_CAP
// per referred customer. There is no minimum fee: any booking with a booking fee above zero
// qualifies, and a 0% fee booking does not. The percentage applies to Gala Tab's booking fee
// (taxes excluded), never to the booking total or the vendor's payout.
const REFERRAL_REWARD_PERCENT = 10;
const REFERRAL_REWARD_CAP = 250;
const REFERRAL_RULES_MODEL = 'fee_percent_v4';
// Rewards created under earlier terms keep the rules they were created with:
//   fee_percent_v3 : 10% of the retained fee, $250 cap, $500 minimum fee
//   flat_fee_v2    : fixed $50, $500 minimum fee
const V3_RULES_MODEL = 'fee_percent_v3';
const FLAT_RULES_MODEL = 'flat_fee_v2';
const LEGACY_MINIMUM_PLATFORM_FEE = 500;

const isFeeBasedModel = (model) => [REFERRAL_RULES_MODEL, V3_RULES_MODEL, FLAT_RULES_MODEL].includes(model);

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

// Same refund logic as above, but on the pre-tax booking amount: taxes are never part of
// Gala Tab's booking fee, so a refund is spread across the pre-tax and tax portions in
// proportion to the amounts the customer paid. With no tax recorded it is identical to
// calculateRetainedPlatformFee.
const calculateRetainedFeeExcludingTax = ({ totalPrice, taxAmount = 0, platformFee, refundedAmount = 0 }) => {
  const totalCents = toCents(totalPrice || 0);
  const preTaxCents = Math.min(Math.max(totalCents - toCents(taxAmount || 0), 0), Math.max(totalCents, 0));
  const refundCents = Math.min(Math.max(toCents(refundedAmount || 0), 0), Math.max(totalCents, 0));
  const preTaxRefundCents = totalCents > 0 ? Math.round((refundCents * preTaxCents) / totalCents) : 0;
  return calculateRetainedPlatformFee({
    totalPrice: fromCents(preTaxCents),
    platformFee,
    refundedAmount: fromCents(preTaxRefundCents)
  });
};

// 10% of the retained booking fee, rounded to the nearest cent and capped. A booking with
// no retained fee (a 0% fee booking, or one fully refunded) earns nothing. `minimumPlatformFee`
// only exists for rewards created under the earlier terms.
const calculateReferralReward = (
  retainedPlatformFee,
  {
    rewardPercent = REFERRAL_REWARD_PERCENT,
    rewardCap = REFERRAL_REWARD_CAP,
    minimumPlatformFee = 0
  } = {}
) => {
  const retainedCents = toCents(retainedPlatformFee || 0);
  if (!Number.isFinite(retainedCents) || retainedCents <= 0 || retainedCents < toCents(minimumPlatformFee)) return 0;
  const percentCents = Math.round((retainedCents * Number(rewardPercent)) / 100);
  return fromCents(Math.min(percentCents, toCents(rewardCap)));
};

// A reward is recalculated from the retained fee using the rules it was created with.
// Current-terms rewards never have a minimum; earlier rewards keep theirs, and rewards
// recorded as a fixed amount keep that amount while the fee stays eligible.
const calculateRewardForCommission = (commission, retainedPlatformFee) => {
  if (commission.rulesModel === REFERRAL_RULES_MODEL) {
    return calculateReferralReward(retainedPlatformFee, {
      rewardPercent: REFERRAL_REWARD_PERCENT,
      rewardCap: REFERRAL_REWARD_CAP
    });
  }
  const minimumPlatformFee = commission.minimumPlatformFee ?? LEGACY_MINIMUM_PLATFORM_FEE;
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
    if (rewardAmount <= 0) return { eligible: false, reason: 'no_qualifying_booking_fee' };
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
  LEGACY_MINIMUM_PLATFORM_FEE,
  REFERRAL_RULES_MODEL,
  V3_RULES_MODEL,
  FLAT_RULES_MODEL,
  isFeeBasedModel,
  toCents,
  fromCents,
  calculatePlatformFee,
  calculateRetainedPlatformFee,
  calculateRetainedFeeExcludingTax,
  calculateReferralReward,
  calculateRewardForCommission,
  evaluateReferralPayoutEligibility
};
