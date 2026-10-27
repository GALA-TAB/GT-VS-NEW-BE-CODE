const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REFERRAL_REWARD_PERCENT,
  REFERRAL_REWARD_CAP,
  calculatePlatformFee,
  calculateRetainedPlatformFee,
  calculateRetainedFeeExcludingTax,
  calculateReferralReward,
  calculateRewardForCommission,
  evaluateReferralPayoutEligibility
} = require('./referral-program');

test('program constants: 10% of the retained booking fee, capped at $250', () => {
  assert.equal(REFERRAL_REWARD_PERCENT, 10);
  assert.equal(REFERRAL_REWARD_CAP, 250);
});

test('there is no minimum booking fee: any fee above zero earns 10%', () => {
  assert.equal(calculateReferralReward(0.01), 0);
  assert.equal(calculateReferralReward(0.05), 0.01);
  assert.equal(calculateReferralReward(10), 1);
  assert.equal(calculateReferralReward(49.99), 5);
  assert.equal(calculateReferralReward(499), 49.9);
  assert.equal(calculateReferralReward(500), 50);
});

test('a booking with no booking fee earns nothing', () => {
  assert.equal(calculateReferralReward(0), 0);
  assert.equal(calculateReferralReward(null), 0);
  assert.equal(calculateReferralReward(-5), 0);
  assert.equal(calculateReferralReward(calculatePlatformFee(20000, 0)), 0);
});

test('the reward is 10% of the retained fee, rounded to the nearest cent', () => {
  assert.equal(calculateReferralReward(800), 80);
  assert.equal(calculateReferralReward(1234.56), 123.46);
  assert.equal(calculateReferralReward(123.45), 12.35); // 12.345 rounds up
  assert.equal(calculateReferralReward(123.44), 12.34); // 12.344 rounds down
  assert.equal(calculateReferralReward(2000), 200);
});

test('the reward is capped at $250 per referred customer', () => {
  assert.equal(calculateReferralReward(2499.99), 250);
  assert.equal(calculateReferralReward(2500), 250);
  assert.equal(calculateReferralReward(2500.01), 250);
  assert.equal(calculateReferralReward(100000), 250);
});

test('the reward comes from the booking fee, not the booking total', () => {
  const fee = calculatePlatformFee(20000, 2); // $20,000 booking, $400 fee
  assert.equal(fee, 400);
  assert.equal(calculateReferralReward(fee), 40);
  assert.equal(calculateReferralReward(calculatePlatformFee(5000, 10)), 50);
  assert.equal(calculateReferralReward(calculatePlatformFee(100, 10)), 1);
});

test('current-terms rewards ignore any stored minimum and use the fixed rate and cap', () => {
  const reward = { rulesModel: 'fee_percent_v4', amount: 1, rewardPercent: 50, rewardCap: 5, minimumPlatformFee: 500 };
  assert.equal(calculateRewardForCommission(reward, 10), 1);
  assert.equal(calculateRewardForCommission(reward, 650), 65);
  assert.equal(calculateRewardForCommission(reward, 5000), 250);
  assert.equal(calculateRewardForCommission(reward, 0), 0);
});

test('rewards created under the $500-minimum terms keep their own rules', () => {
  const reward = { rulesModel: 'fee_percent_v3', amount: 80, rewardPercent: 10, rewardCap: 250, minimumPlatformFee: 500 };
  assert.equal(calculateRewardForCommission(reward, 800), 80);
  assert.equal(calculateRewardForCommission(reward, 650), 65);
  assert.equal(calculateRewardForCommission(reward, 499.99), 0);
  assert.equal(calculateRewardForCommission({ ...reward, rewardPercent: 5, rewardCap: 20 }, 2000), 20);
  assert.equal(calculateRewardForCommission({ ...reward, minimumPlatformFee: undefined }, 499), 0);
});

test('rewards recorded as a fixed $50 keep that amount while the fee stays eligible', () => {
  const fixed = { rulesModel: 'flat_fee_v2', amount: 50, rewardPercent: null, minimumPlatformFee: 500 };
  assert.equal(calculateRewardForCommission(fixed, 2000), 50);
  assert.equal(calculateRewardForCommission(fixed, 499), 0);
});

test('platform fee is rounded to cents without floating point drift', () => {
  assert.equal(calculatePlatformFee(1999.99, 10), 200);
  assert.equal(calculatePlatformFee(0, 10), 0);
  assert.equal(calculatePlatformFee(1000, 0), 0);
  assert.equal(calculatePlatformFee(5000.05, 10), 500.01);
});

test('fees from different bookings are never combined', () => {
  const fees = [300, 300];
  assert.deepEqual(fees.map((fee) => calculateReferralReward(fee)), [30, 30]);
});

test('refunds absorbed by the vendor share leave the retained fee untouched', () => {
  // $5,000 booking, $500 fee, vendor share $4,500
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 0 }), 500);
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 4500 }), 500);
});

test('refunds beyond the vendor share reduce the fee Gala Tab retains', () => {
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 4500.01 }), 499.99);
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 4750 }), 250);
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 5000 }), 0);
  assert.equal(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 9999 }), 0);
});

test('a partial refund into the fee lowers the reward with it, and a full refund removes it', () => {
  const retained = calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 4750 });
  assert.equal(retained, 250);
  assert.equal(calculateReferralReward(retained), 25);
  assert.equal(calculateReferralReward(calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 5000 })), 0);
});

test('taxes are excluded from the fee and from refunds measured against it', () => {
  // $1,000 service + $88.75 tax = $1,088.75 paid; 10% fee on the $1,000 service = $100
  assert.equal(calculateRetainedFeeExcludingTax({ totalPrice: 1088.75, taxAmount: 88.75, platformFee: 100, refundedAmount: 0 }), 100);
  // a refund is spread across the pre-tax and tax portions; this one stays within the vendor's share
  assert.equal(calculateRetainedFeeExcludingTax({ totalPrice: 1088.75, taxAmount: 88.75, platformFee: 100, refundedAmount: 970 }), 100);
  // $1,000 refunded = $918.48 of the pre-tax amount, $18.48 beyond the vendor's $900 share
  assert.equal(calculateRetainedFeeExcludingTax({ totalPrice: 1088.75, taxAmount: 88.75, platformFee: 100, refundedAmount: 1000 }), 81.52);
  // a full refund returns everything
  assert.equal(calculateRetainedFeeExcludingTax({ totalPrice: 1088.75, taxAmount: 88.75, platformFee: 100, refundedAmount: 1088.75 }), 0);
  // without recorded tax it matches the original calculation
  assert.equal(
    calculateRetainedFeeExcludingTax({ totalPrice: 5000, platformFee: 500, refundedAmount: 4750 }),
    calculateRetainedPlatformFee({ totalPrice: 5000, platformFee: 500, refundedAmount: 4750 })
  );
});

const eligibleCase = (overrides = {}) => ({
  booking: { status: 'completed', checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-02'), totalPrice: 5000, paymentStatus: true, inDispute: false, cancelRequest: false },
  commission: {
    rulesModel: 'fee_percent_v4',
    rewardPercent: 10,
    rewardCap: 250,
    completionConfirmedAt: new Date('2026-01-03T00:00:00Z'),
    amount: 50,
    platformFeeAmount: 500,
    retainedPlatformFee: 500,
    minimumPlatformFee: 0,
    availableFundsVerified: true
  },
  settings: { completionDelayHours: 48, payoutsEnabled: true },
  payoutAccount: { stripeAccountId: 'acct_test', payoutOnboardingStatus: 'verified' },
  now: new Date('2026-01-05T00:00:00Z'),
  ...overrides
});
const withBooking = (patch) => eligibleCase({ booking: { ...eligibleCase().booking, ...patch } });
const withCommission = (patch) => eligibleCase({ commission: { ...eligibleCase().commission, ...patch } });

test('a reward is released only when every condition is met', () => {
  const result = evaluateReferralPayoutEligibility(eligibleCase());
  assert.equal(result.eligible, true);
  assert.equal(result.rewardAmount, 50);
});

test('the amount released follows the retained fee', () => {
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ retainedPlatformFee: 800, amount: 80 })).rewardAmount, 80);
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ retainedPlatformFee: 3000, amount: 250 })).rewardAmount, 250);
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ retainedPlatformFee: 600, amount: 80 })).rewardAmount, 60);
});

test('release is blocked until the service completion is confirmed', () => {
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ completionConfirmedAt: null })).reason, 'completion_not_confirmed');
  assert.equal(evaluateReferralPayoutEligibility(withBooking({ checkOut: new Date('2026-02-01') })).reason, 'completion_not_confirmed');
});

test('release is blocked until the booking is fully paid', () => {
  assert.equal(evaluateReferralPayoutEligibility(withBooking({ paymentStatus: false })).reason, 'booking_not_fully_paid');
});

test('release is blocked by unresolved disputes and refund requests', () => {
  assert.equal(evaluateReferralPayoutEligibility(withBooking({ inDispute: true })).reason, 'dispute_unresolved');
  assert.equal(evaluateReferralPayoutEligibility(withBooking({ cancelRequest: true })).reason, 'refund_unresolved');
});

test('release is blocked for canceled bookings', () => {
  assert.equal(evaluateReferralPayoutEligibility(withBooking({ status: 'canceled' })).reason, 'booking_canceled');
});

test('release is blocked when no booking fee is retained, with no minimum otherwise', () => {
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ retainedPlatformFee: 0 })).reason, 'no_qualifying_booking_fee');
  const small = evaluateReferralPayoutEligibility(withCommission({ retainedPlatformFee: 20, amount: 2 }));
  assert.equal(small.eligible, true);
  assert.equal(small.rewardAmount, 2);
});

test('a reward from the earlier $500-minimum terms is still held to that minimum', () => {
  const earlier = { rulesModel: 'fee_percent_v3', minimumPlatformFee: 500 };
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ ...earlier, retainedPlatformFee: 499.99 })).reason, 'no_qualifying_booking_fee');
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ ...earlier, retainedPlatformFee: 500 })).eligible, true);
});

test('release is blocked without required payout verification or available funds', () => {
  assert.equal(
    evaluateReferralPayoutEligibility(eligibleCase({ payoutAccount: { stripeAccountId: 'acct_test', payoutOnboardingStatus: 'pending' } })).reason,
    'payout_onboarding_incomplete'
  );
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ payoutAccount: null })).reason, 'payout_onboarding_incomplete');
  assert.equal(evaluateReferralPayoutEligibility(withCommission({ availableFundsVerified: false })).reason, 'funds_unavailable');
  assert.equal(evaluateReferralPayoutEligibility(eligibleCase({ settings: { completionDelayHours: 48, payoutsEnabled: false } })).reason, 'payouts_disabled');
});

test('the completion delay is snapshotted per reward', () => {
  const scenario = withCommission({ completionDelayHours: 72 });
  scenario.settings = { completionDelayHours: 0, payoutsEnabled: true };
  scenario.now = new Date('2026-01-05T12:00:00Z');
  assert.equal(evaluateReferralPayoutEligibility(scenario).reason, 'completion_delay_active');
  scenario.now = new Date('2026-01-06T00:00:00Z');
  assert.equal(evaluateReferralPayoutEligibility(scenario).eligible, true);
});

test('rewards recorded under the earlier percentage program keep their amount and skip the fee check', () => {
  const legacy = withCommission({ rulesModel: null, amount: 100, retainedPlatformFee: undefined, platformFeeAmount: undefined });
  assert.equal(evaluateReferralPayoutEligibility(legacy).eligible, true);
});
