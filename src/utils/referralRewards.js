const ReferralAccount = require('../models/ReferralAccount');
const ReferralCommission = require('../models/ReferralCommission');
const User = require('../models/users/User');
const {
  MINIMUM_PLATFORM_FEE,
  REFERRAL_RULES_MODEL,
  calculatePlatformFee,
  calculateRetainedPlatformFee,
  calculateReferralReward
} = require('./referral-program');
const { rewardOptionsFrom } = require('./referralSettings');
const {
  findInvitationByCode,
  claimInvitation,
  releaseInvitation,
  isNewCustomer
} = require('./referralInvitations');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isSelfReferral = ({ referrer, user, vendorId }) =>
  String(referrer?._id) === String(user?._id) ||
  String(referrer?._id) === String(vendorId) ||
  String(referrer?.staffOf || '') === String(vendorId) ||
  (Boolean(normalizeEmail(referrer?.email)) && normalizeEmail(referrer?.email) === normalizeEmail(user?.email));

// Decides, at booking time, whether this booking may hold the invitation's reward.
// Nothing is paid here: the fee must still be retained, the event completed, and
// every release condition met later.
const buildReferralSnapshot = async ({
  attribution,
  user,
  vendorId,
  finalTotalPrice,
  platformFeePercent,
  settings,
  deps = {}
}) => {
  const { UserModel = User, findInvitation = findInvitationByCode, newCustomerCheck = isNewCustomer } = deps;
  const rewardRules = rewardOptionsFrom(attribution.rules?.rewardAmount != null ? attribution.rules : settings);
  const platformFeeAmount = calculatePlatformFee(finalTotalPrice, platformFeePercent);
  const invitation = attribution.invitation
    ? { _id: attribution.invitation }
    : await findInvitation(attribution.code);
  const referrer = await UserModel.findById(attribution.referrer).select('email staffOf');

  let eligibility = 'eligible';
  if (!invitation) eligibility = 'invitation_unavailable';
  else if (isSelfReferral({ referrer: referrer || { _id: attribution.referrer }, user, vendorId })) eligibility = 'self_referral';
  else if (calculateReferralReward(platformFeeAmount, rewardRules) <= 0) eligibility = 'below_threshold';
  else if (!(await newCustomerCheck({ userId: user._id, attributedAt: attribution.createdAt }))) eligibility = 'not_new_customer';

  return {
    attribution: attribution._id,
    invitation: invitation?._id || null,
    referrer: attribution.referrer,
    code: attribution.code,
    eligibility,
    rewardAmount: eligibility === 'eligible' ? rewardRules.rewardAmount : 0,
    minimumPlatformFee: rewardRules.minimumPlatformFee,
    completionDelayHours: attribution.rules?.completionDelayHours || settings?.completionDelayHours || 48,
    platformFeePercent: Number(platformFeePercent || 0),
    platformFeeAmount,
    retainedPlatformFee: platformFeeAmount,
    attributionRulesVersion: attribution.rules?.version ?? null,
    committedAt: new Date(),
    auditTrail: [{
      action: eligibility === 'eligible' ? 'reward_candidate' : `booking_${eligibility}`,
      metadata: { rulesVersion: attribution.rules?.version ?? null, platformFeeAmount }
    }]
  };
};

const markBookingNotRewarded = async (booking, eligibility, action) => {
  booking.referral.eligibility = eligibility;
  booking.referral.rewardAmount = 0;
  booking.referral.auditTrail.push({ action, metadata: {} });
  await booking.save();
};

// Claims the invitation for a candidate booking and records its single reward.
const claimRewardForBooking = async ({ booking, vendorId, paymentIntentIds = [] }) => {
  const snapshot = booking.referral;
  if (snapshot?.eligibility !== 'eligible' || !snapshot.invitation) return null;
  const invitation = await claimInvitation({
    invitationId: snapshot.invitation,
    userId: booking.user,
    bookingId: booking._id
  });
  if (!invitation) {
    await markBookingNotRewarded(booking, 'invitation_unavailable', 'invitation_already_redeemed');
    return null;
  }
  try {
    const referrerAccount = await ReferralAccount.findOne({ user: snapshot.referrer });
    return await ReferralCommission.create({
      booking: booking._id,
      attribution: snapshot.attribution,
      invitation: invitation._id,
      referredUser: booking.user,
      referrer: snapshot.referrer,
      vendor: vendorId,
      rulesModel: REFERRAL_RULES_MODEL,
      paymentIntentIds,
      bookingTotal: booking.totalPrice,
      platformFeeAmount: snapshot.platformFeeAmount,
      retainedPlatformFee: snapshot.platformFeeAmount,
      minimumPlatformFee: snapshot.minimumPlatformFee,
      completionDelayHours: snapshot.completionDelayHours,
      amount: snapshot.rewardAmount,
      status: 'pending',
      payoutOnboardingRequired: referrerAccount?.payoutOnboardingStatus !== 'verified',
      auditTrail: [{ action: 'reward_recorded', actor: booking.user, metadata: { rulesVersion: snapshot.attributionRulesVersion } }]
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await ReferralCommission.findOne({ booking: booking._id });
      if (existing) return existing;
    }
    await releaseInvitation({ invitationId: invitation._id, bookingId: booking._id });
    await markBookingNotRewarded(booking, 'invitation_unavailable', 'reward_record_failed');
    console.error('[referral] Failed to record booking reward:', error.message);
    return null;
  }
};

// Cancels an unpaid reward and frees its invitation for the same customer's next
// qualifying booking. Paid rewards are never cancelled here.
const cancelReward = async (commission, { reason, actor = null, metadata = {} }) => {
  const invitationId = commission.invitation;
  commission.status = 'canceled';
  commission.invitation = null;
  commission.canceledInvitation = invitationId;
  commission.allocatedAmount = 0;
  commission.availableFundsVerified = false;
  commission.auditTrail.push({ action: 'reward_canceled', reason, actor, metadata });
  await commission.save();
  if (invitationId) await releaseInvitation({ invitationId, bookingId: commission.booking });
};

const flagPaidRewardForReview = (commission, { reason, actor, metadata }) => {
  commission.recoverableAmount = commission.amount;
  commission.status = 'review';
  commission.auditTrail.push({ action: 'paid_reward_needs_recovery_review', reason, actor, metadata });
};

// Recomputes the booking fee Gala Tab actually retains after a refund and cancels
// the reward if it falls under the minimum or the booking itself is canceled.
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

  if (commission.rulesModel !== REFERRAL_RULES_MODEL) {
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
  const retained = calculateRetainedPlatformFee({
    totalPrice: total,
    platformFee: commission.platformFeeAmount,
    refundedAmount
  });
  commission.refundedAmount = refundedAmount;
  commission.retainedPlatformFee = retained;
  if (booking.referral) {
    booking.referral.retainedPlatformFee = retained;
    booking.referral.auditTrail.push({ action: `${source}_reconciled`, metadata: { ...audit, retained } });
  }
  const stillQualifies =
    !bookingCanceled &&
    calculateReferralReward(retained, {
      rewardAmount: commission.amount,
      minimumPlatformFee: commission.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE
    }) > 0;
  const reason = bookingCanceled ? 'booking_canceled' : 'retained_platform_fee_below_minimum';

  if (stillQualifies) {
    commission.auditTrail.push({ action: `${source}_reconciled`, actor: actorId, metadata: { ...audit, retained } });
    await commission.save();
  } else if (['paid', 'processing'].includes(commission.status)) {
    flagPaidRewardForReview(commission, { reason, actor: actorId, metadata: { ...audit, retained } });
    await commission.save();
  } else if (commission.status !== 'canceled') {
    await cancelReward(commission, { reason, actor: actorId, metadata: { ...audit, retained } });
  }
  await booking.save();
  return commission;
};

// Called when the completion job fixes the booking's final platform fee.
const syncRewardWithFinalFee = async ({ booking, platformFee, payment }) => {
  const commission = await ReferralCommission.findOne({ booking: booking._id });
  if (!commission || commission.rulesModel !== REFERRAL_RULES_MODEL) return null;
  const retained = calculateRetainedPlatformFee({
    totalPrice: booking.totalPrice,
    platformFee,
    refundedAmount: commission.refundedAmount
  });
  commission.platformFeeAmount = platformFee;
  commission.retainedPlatformFee = retained;
  if (payment?._id && !commission.paymentTransactions.some((id) => String(id) === String(payment._id))) {
    commission.paymentTransactions.push(payment._id);
  }
  const qualifies =
    calculateReferralReward(retained, {
      rewardAmount: commission.amount,
      minimumPlatformFee: commission.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE
    }) > 0;
  if (!qualifies) {
    if (['paid', 'processing'].includes(commission.status)) {
      flagPaidRewardForReview(commission, { reason: 'final_platform_fee_below_minimum', actor: null, metadata: { retained } });
      await commission.save();
    } else if (commission.status !== 'canceled') {
      await cancelReward(commission, { reason: 'final_platform_fee_below_minimum', metadata: { retained } });
    }
  } else {
    // The reward is set aside from the booking fee Gala Tab keeps, not from the vendor's payout.
    commission.allocatedAmount = commission.amount;
    commission.auditTrail.push({ action: 'reward_set_aside_from_platform_fee', metadata: { platformFee, retained } });
    await commission.save();
  }
  if (booking.referral) {
    booking.referral.platformFeeAmount = platformFee;
    booking.referral.retainedPlatformFee = retained;
    await booking.save();
  }
  return commission;
};

module.exports = {
  buildReferralSnapshot,
  claimRewardForBooking,
  cancelReward,
  applyRefundToReferralReward,
  syncRewardWithFinalFee,
  isSelfReferral
};
