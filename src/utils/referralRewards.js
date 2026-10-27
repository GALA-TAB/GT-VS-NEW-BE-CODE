const ReferralAccount = require('../models/ReferralAccount');
const ReferralCommission = require('../models/ReferralCommission');
const User = require('../models/users/User');
const {
  REFERRAL_RULES_MODEL,
  V3_RULES_MODEL,
  isFeeBasedModel,
  calculatePlatformFee,
  calculateRetainedFeeExcludingTax,
  calculateReferralReward,
  calculateRewardForCommission,
  fromCents,
  toCents
} = require('./referral-program');
const { rewardOptionsFrom } = require('./referralSettings');
const { findInvitationByCode, isNewCustomer } = require('./referralInvitations');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isSelfReferral = ({ referrer, user, vendorId }) =>
  String(referrer?._id) === String(user?._id) ||
  String(referrer?._id) === String(vendorId) ||
  String(referrer?.staffOf || '') === String(vendorId) ||
  (Boolean(normalizeEmail(referrer?.email)) && normalizeEmail(referrer?.email) === normalizeEmail(user?.email));

// A referred customer can earn the referrer one reward. Any reward that has not been canceled
// (pending, ready, processing, paid, on hold, or under review) uses it up.
const hasLiveRewardForCustomer = async ({ userId, excludeBookingId = null, CommissionModel = ReferralCommission }) => {
  const filter = { referredUser: userId, status: { $ne: 'canceled' } };
  if (excludeBookingId) filter.booking = { $ne: excludeBookingId };
  return Boolean(await CommissionModel.exists(filter));
};

// Decides, at booking time, whether this booking may hold the referred customer's reward.
// Only an eligible booking is recorded against the customer: a booking that does not qualify
// (0% booking fee, self-referral, ...) leaves them able to earn on a later booking. Nothing
// is paid here: the fee must still be retained, the event completed, and every release
// condition met later. The fee excludes taxes.
const buildReferralSnapshot = async ({
  attribution,
  user,
  vendorId,
  finalTotalPrice,
  taxAmount = 0,
  platformFeePercent,
  settings,
  deps = {}
}) => {
  const {
    UserModel = User,
    AccountModel = ReferralAccount,
    findInvitation = findInvitationByCode,
    newCustomerCheck = isNewCustomer,
    rewardedCheck = hasLiveRewardForCustomer
  } = deps;
  const rewardRules = rewardOptionsFrom();
  const preTaxTotal = fromCents(Math.max(toCents(finalTotalPrice || 0) - toCents(taxAmount || 0), 0));
  const platformFeeAmount = calculatePlatformFee(preTaxTotal, platformFeePercent);
  const expectedReward = calculateReferralReward(platformFeeAmount, rewardRules);
  const invitation = attribution.invitation
    ? { _id: attribution.invitation }
    : await findInvitation(attribution.code);
  const referrer = await UserModel.findById(attribution.referrer).select('email staffOf');
  const referrerAccount = await AccountModel.findOne({ user: attribution.referrer }).select('referrerConsent');

  let eligibility = 'eligible';
  if (!invitation) eligibility = 'invitation_unavailable';
  else if (isSelfReferral({ referrer: referrer || { _id: attribution.referrer }, user, vendorId })) eligibility = 'self_referral';
  else if (expectedReward <= 0) eligibility = 'zero_fee';
  else if (referrerAccount?.referrerConsent?.termsVersion !== settings?.termsVersion) eligibility = 'terms_not_accepted';
  else if (await rewardedCheck({ userId: user._id })) eligibility = 'already_rewarded';
  else if (!(await newCustomerCheck({ userId: user._id, attributedAt: attribution.createdAt }))) eligibility = 'not_new_customer';

  return {
    attribution: attribution._id,
    invitation: invitation?._id || null,
    referrer: attribution.referrer,
    code: attribution.code,
    eligibility,
    rulesModel: REFERRAL_RULES_MODEL,
    rewardAmount: eligibility === 'eligible' ? expectedReward : 0,
    rewardPercent: rewardRules.rewardPercent,
    rewardCap: rewardRules.rewardCap,
    minimumPlatformFee: 0,
    completionDelayHours: attribution.rules?.completionDelayHours || settings?.completionDelayHours || 48,
    platformFeePercent: Number(platformFeePercent || 0),
    platformFeeAmount,
    retainedPlatformFee: platformFeeAmount,
    taxAmount: Number(taxAmount || 0),
    attributionRulesVersion: attribution.rules?.version ?? null,
    committedAt: new Date(),
    auditTrail: [{
      action: eligibility === 'eligible' ? 'reward_candidate' : `booking_${eligibility}`,
      metadata: { rulesVersion: attribution.rules?.version ?? null, termsVersion: settings?.termsVersion ?? null, platformFeeAmount }
    }]
  };
};

const markBookingNotRewarded = async (booking, eligibility, action) => {
  booking.referral.eligibility = eligibility;
  booking.referral.rewardAmount = 0;
  booking.referral.auditTrail.push({ action, metadata: {} });
  await booking.save();
};

// Records the booking's single reward in the ledger. The ledger enforces one reward per
// booking and one live reward per referred customer, so concurrent or repeated attempts
// (a retry, a second booking, a link and a code together) can never produce a second one.
const claimRewardForBooking = async ({ booking, vendorId, paymentIntentIds = [], CommissionModel = ReferralCommission }) => {
  const snapshot = booking.referral;
  if (snapshot?.eligibility !== 'eligible' || !snapshot.referrer) return null;
  const existing = await CommissionModel.findOne({ booking: booking._id });
  if (existing) return existing;
  if (await hasLiveRewardForCustomer({ userId: booking.user, excludeBookingId: booking._id, CommissionModel })) {
    await markBookingNotRewarded(booking, 'already_rewarded', 'customer_already_rewarded');
    return null;
  }
  try {
    const referrerAccount = await ReferralAccount.findOne({ user: snapshot.referrer });
    return await CommissionModel.create({
      booking: booking._id,
      attribution: snapshot.attribution,
      sourceInvitation: snapshot.invitation,
      customerClaim: booking.user,
      referredUser: booking.user,
      referrer: snapshot.referrer,
      vendor: vendorId,
      // Bookings evaluated before the updated terms have no rules model and keep the earlier rules.
      rulesModel: snapshot.rulesModel || V3_RULES_MODEL,
      paymentIntentIds,
      bookingTotal: booking.totalPrice,
      taxAmount: snapshot.taxAmount || 0,
      platformFeeAmount: snapshot.platformFeeAmount,
      retainedPlatformFee: snapshot.platformFeeAmount,
      minimumPlatformFee: snapshot.minimumPlatformFee,
      rewardPercent: snapshot.rewardPercent,
      rewardCap: snapshot.rewardCap,
      completionDelayHours: snapshot.completionDelayHours,
      amount: snapshot.rewardAmount,
      status: 'pending',
      payoutOnboardingRequired: referrerAccount?.payoutOnboardingStatus !== 'verified',
      auditTrail: [{ action: 'reward_recorded', actor: booking.user, metadata: { rulesVersion: snapshot.attributionRulesVersion } }]
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await CommissionModel.findOne({ booking: booking._id });
      if (duplicate) return duplicate;
      await markBookingNotRewarded(booking, 'already_rewarded', 'customer_already_rewarded');
      return null;
    }
    // The booking stays a reward candidate; the reward cycle retries interrupted ledger writes.
    console.error('[referral] Failed to record booking reward:', error.message);
    return null;
  }
};

// Cancels an unpaid reward and frees the referred customer to earn on their next qualifying
// booking. Paid rewards are never cancelled here.
const cancelReward = async (commission, { reason, actor = null, metadata = {} }) => {
  commission.status = 'canceled';
  commission.canceledInvitation = commission.invitation || commission.canceledInvitation || null;
  commission.invitation = null;
  commission.customerClaim = null;
  commission.allocatedAmount = 0;
  commission.availableFundsVerified = false;
  commission.auditTrail.push({ action: 'reward_canceled', reason, actor, metadata });
  await commission.save();
};

const isPaidOrInFlight = (commission) => ['paid', 'processing'].includes(commission.status);

// Brings the reward in line with the fee Gala Tab now retains. An unpaid reward is
// recalculated (or canceled when the fee no longer qualifies or the booking is canceled).
// A reward already paid is never rewritten: any excess is flagged for recovery review.
const settleRewardAfterFeeChange = async (commission, booking, { retained, bookingCanceled = false, reason, actor = null, metadata = {} }) => {
  const newAmount = bookingCanceled ? 0 : calculateRewardForCommission(commission, retained);
  const previousAmount = commission.amount;
  const audit = { ...metadata, retained, previousAmount, newAmount };

  if (newAmount <= 0) {
    if (isPaidOrInFlight(commission)) {
      commission.recoverableAmount = previousAmount;
      commission.status = 'review';
      commission.auditTrail.push({ action: 'paid_reward_needs_recovery_review', reason, actor, metadata: audit });
      await commission.save();
    } else if (commission.status !== 'canceled') {
      await cancelReward(commission, { reason, actor, metadata: audit });
    }
    return;
  }
  if (newAmount !== previousAmount) {
    if (isPaidOrInFlight(commission)) {
      if (newAmount < previousAmount) {
        commission.recoverableAmount = previousAmount - newAmount;
        commission.status = 'review';
        commission.auditTrail.push({ action: 'paid_reward_needs_recovery_review', reason: 'retained_platform_fee_reduced', actor, metadata: audit });
      }
    } else {
      commission.amount = newAmount;
      commission.auditTrail.push({ action: 'reward_recalculated', reason, actor, metadata: audit });
      if (booking.referral) booking.referral.rewardAmount = newAmount;
    }
  }
  if (!isPaidOrInFlight(commission)) commission.allocatedAmount = commission.amount;
  await commission.save();
};

// Recomputes the booking fee Gala Tab actually retains after a refund, then settles the
// reward against it.
const applyRefundToReferralReward = async ({
  booking,
  refundAmount = 0,
  refundedTotal = null,
  fullRefund = false,
  bookingCanceled = false,
  actorId = null,
  source = 'refund',
  metadata = {}
}) => {
  const commission = await ReferralCommission.findOne({ booking: booking._id });
  if (!commission) return null;
  const audit = { source, refundAmount, fullRefund, ...metadata };

  if (!isFeeBasedModel(commission.rulesModel)) {
    commission.auditTrail.push({ action: 'refund_recorded_on_earlier_reward', actor: actorId, metadata: audit });
    await commission.save();
    return commission;
  }

  const total = Number(booking.totalPrice || commission.bookingTotal || 0);
  // `refundedTotal` is an absolute figure from Stripe, so replayed webhooks cannot double count.
  const refundedAmount = fullRefund
    ? total
    : Math.min(
      total,
      refundedTotal != null
        ? Math.max(Number(commission.refundedAmount || 0), Number(refundedTotal))
        : Number(commission.refundedAmount || 0) + Number(refundAmount || 0)
    );
  const retained = calculateRetainedFeeExcludingTax({
    totalPrice: total,
    taxAmount: commission.taxAmount,
    platformFee: commission.platformFeeAmount,
    refundedAmount
  });
  commission.refundedAmount = refundedAmount;
  commission.retainedPlatformFee = retained;
  if (booking.referral) {
    booking.referral.retainedPlatformFee = retained;
    booking.referral.auditTrail.push({ action: `${source}_reconciled`, metadata: { ...audit, retained } });
  }
  await settleRewardAfterFeeChange(commission, booking, {
    retained,
    bookingCanceled,
    reason: bookingCanceled ? 'booking_canceled' : 'retained_platform_fee_changed',
    actor: actorId,
    metadata: audit
  });
  await booking.save();
  return commission;
};

// Called when the completion job fixes the booking's final platform fee.
const syncRewardWithFinalFee = async ({ booking, platformFee, payment }) => {
  const commission = await ReferralCommission.findOne({ booking: booking._id });
  if (!commission || !isFeeBasedModel(commission.rulesModel)) return null;
  // Current terms measure the fee on the pre-tax amount; earlier rewards keep the fee
  // the completion job calculated.
  const feePercent = Number(booking.referral?.platformFeePercent);
  const finalFee = commission.rulesModel === REFERRAL_RULES_MODEL && Number.isFinite(feePercent)
    ? calculatePlatformFee(fromCents(Math.max(toCents(booking.totalPrice) - toCents(commission.taxAmount || 0), 0)), feePercent)
    : platformFee;
  const retained = calculateRetainedFeeExcludingTax({
    totalPrice: booking.totalPrice,
    taxAmount: commission.taxAmount,
    platformFee: finalFee,
    refundedAmount: commission.refundedAmount
  });
  commission.platformFeeAmount = finalFee;
  commission.retainedPlatformFee = retained;
  if (payment?._id && !commission.paymentTransactions.some((id) => String(id) === String(payment._id))) {
    commission.paymentTransactions.push(payment._id);
  }
  // The reward is set aside from the booking fee Gala Tab keeps, not from the vendor's payout.
  await settleRewardAfterFeeChange(commission, booking, {
    retained,
    reason: 'final_platform_fee',
    metadata: { source: 'completion', platformFee: finalFee }
  });
  if (booking.referral) {
    booking.referral.platformFeeAmount = finalFee;
    booking.referral.retainedPlatformFee = retained;
    await booking.save();
  }
  return commission;
};

module.exports = {
  buildReferralSnapshot,
  hasLiveRewardForCustomer,
  claimRewardForBooking,
  cancelReward,
  applyRefundToReferralReward,
  syncRewardWithFinalFee,
  isSelfReferral
};
