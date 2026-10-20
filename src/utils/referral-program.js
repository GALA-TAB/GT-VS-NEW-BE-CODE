const DEFAULT_REFERRAL_RATE_PERCENT = 5;
const DEFAULT_MINIMUM_SERVICE_SUBTOTAL = 500;

const toCents = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100);
const fromCents = (amount) => Number((amount / 100).toFixed(2));

const calculateReferralCommission = (
  serviceSubtotal,
  ratePercent = DEFAULT_REFERRAL_RATE_PERCENT,
  minimumSubtotal = DEFAULT_MINIMUM_SERVICE_SUBTOTAL
) => {
  const subtotalCents = toCents(serviceSubtotal);
  if (!Number.isFinite(subtotalCents) || subtotalCents < toCents(minimumSubtotal)) return 0;
  return fromCents(Math.round((subtotalCents * Number(ratePercent)) / 100));
};

const calculateVendorNet = (serviceSubtotal, platformFeePercent, commission) => {
  const subtotalCents = toCents(serviceSubtotal);
  const platformFeeCents = Math.round((subtotalCents * Number(platformFeePercent || 0)) / 100);
  return fromCents(Math.max(0, subtotalCents - platformFeeCents - toCents(commission || 0)));
};

const calculateRemainingCommission = ({
  remainingServiceSubtotal,
  ratePercent = DEFAULT_REFERRAL_RATE_PERCENT,
  minimumSubtotal = DEFAULT_MINIMUM_SERVICE_SUBTOTAL,
  alreadyPaid = 0
}) => {
  const recalculated = calculateReferralCommission(
    remainingServiceSubtotal,
    ratePercent,
    minimumSubtotal
  );
  return fromCents(Math.max(0, toCents(recalculated) - toCents(alreadyPaid)));
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
  if (!commission.completionConfirmedAt || new Date(booking.checkOut) > now) {
    return { eligible: false, reason: 'completion_not_confirmed' };
  }
  if (booking.paymentStatus !== true) {
    return { eligible: false, reason: 'booking_not_fully_paid' };
  }
  const eligibleAt = new Date(commission.completionConfirmedAt).getTime() + Number(commission.completionDelayHours ?? settings?.completionDelayHours ?? 48) * 60 * 60 * 1000;
  if (eligibleAt > now.getTime()) return { eligible: false, reason: 'completion_delay_active', eligibleAt: new Date(eligibleAt) };
  if (!settings?.payoutsEnabled) return { eligible: false, reason: 'payouts_disabled', eligibleAt: new Date(eligibleAt) };
  if (payoutAccount?.payoutOnboardingStatus !== 'verified' || !payoutAccount?.stripeAccountId) {
    return { eligible: false, reason: 'payout_onboarding_incomplete', eligibleAt: new Date(eligibleAt) };
  }
  if (!commission.availableProviderFundsVerified || Number(commission.allocatedAmount || 0) + 0.01 < Number(commission.amount || 0)) {
    return { eligible: false, reason: 'vendor_funds_unverified_or_insufficient', eligibleAt: new Date(eligibleAt) };
  }
  return { eligible: true, reason: null, eligibleAt: new Date(eligibleAt) };
};

module.exports = {
  DEFAULT_REFERRAL_RATE_PERCENT,
  DEFAULT_MINIMUM_SERVICE_SUBTOTAL,
  calculateReferralCommission,
  calculateVendorNet,
  calculateRemainingCommission,
  evaluateReferralPayoutEligibility
};