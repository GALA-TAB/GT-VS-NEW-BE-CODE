const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateReferralCommission,
  calculateVendorNet,
  calculateRemainingCommission,
  evaluateReferralPayoutEligibility
} = require('./referral-program');

test('launch commission is 5 percent of qualifying service subtotal', () => {
  assert.equal(calculateReferralCommission(2000), 100);
  assert.equal(calculateReferralCommission(500), 25);
  assert.equal(calculateReferralCommission(499.99), 0);
});

test('vendor net deducts platform fee and referral commission separately', () => {
  assert.equal(calculateVendorNet(2000, 10, 100), 1700);
});

test('partial refunds recalculate only the remaining eligible service amount', () => {
  assert.equal(calculateRemainingCommission({ remainingServiceSubtotal: 1800 }), 90);
  assert.equal(calculateRemainingCommission({ remainingServiceSubtotal: 499 }), 0);
});

const eligibleCase = (overrides = {}) => ({
  booking: { status: 'completed', checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-02'), totalPrice: 2000, paymentStatus: true, inDispute: false },
  commission: { completionConfirmedAt: new Date('2026-01-03T00:00:00Z'), amount: 100, allocatedAmount: 100, availableProviderFundsVerified: true },
  settings: { completionDelayHours: 48, payoutsEnabled: true },
  payoutAccount: { stripeAccountId: 'acct_test', payoutOnboardingStatus: 'verified' },
  now: new Date('2026-01-05T00:00:00Z'),
  ...overrides
});

test('payout eligibility requires all completion, payment, dispute, delay, onboarding, and funds gates', () => {
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase()).eligible, true);
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ commission: { ...eligibleCase().commission, completionConfirmedAt: null } })).reason, 'completion_not_confirmed');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ now: new Date('2026-01-04T23:59:59Z') })).reason, 'completion_delay_active');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ booking: { ...eligibleCase().booking, inDispute: true } })).reason, 'dispute_unresolved');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ booking: { ...eligibleCase().booking, status: 'canceled' } })).reason, 'booking_canceled');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ booking: { ...eligibleCase().booking, paymentStatus: false } })).reason, 'booking_not_fully_paid');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ settings: { completionDelayHours: 48, payoutsEnabled: false } })).reason, 'payouts_disabled');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ payoutAccount: { stripeAccountId: 'acct_test', payoutOnboardingStatus: 'pending' } })).reason, 'payout_onboarding_incomplete');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ commission: { ...eligibleCase().commission, availableProviderFundsVerified: false } })).reason, 'vendor_funds_unverified_or_insufficient');
});

test('existing commissions keep their snapshotted completion delay after admin changes', () => {
  const scenario = eligibleCase({
    commission: { ...eligibleCase().commission, completionDelayHours: 72 },
    settings: { completionDelayHours: 0, payoutsEnabled: true },
    now: new Date('2026-01-05T12:00:00Z')
  });
  assert.equal(evaluateReferralPayoutEligibility(scenario).reason, 'completion_delay_active');
  scenario.now = new Date('2026-01-06T00:00:00Z');
  assert.equal(evaluateReferralPayoutEligibility(scenario).eligible, true);
});