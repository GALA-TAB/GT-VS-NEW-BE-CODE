const test = require('node:test');
const assert = require('node:assert/strict');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralAccount = require('../models/ReferralAccount');
const {
  buildReferralSnapshot,
  claimRewardForBooking,
  applyRefundToReferralReward,
  syncRewardWithFinalFee
} = require('./referralRewards');

// ── In-memory stand-in for the commission ledger ──────────────────────────────
// It enforces the same unique indexes the model declares (booking, invitation, customerClaim)
// and evaluates the filters the code sends, so duplicate prevention is exercised for real.
const same = (a, b) => String(a ?? null) === String(b ?? null);
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$ne' in value) return !same(doc[key], value.$ne);
    return same(doc[key], value);
  });

const createStore = ({ commissions = [], skipPrecheck = false } = {}) => {
  const store = { commissions, restore: [] };
  const patch = (target, name, implementation) => {
    const original = target[name];
    target[name] = implementation;
    store.restore.push(() => { target[name] = original; });
  };
  patch(ReferralAccount, 'findOne', async () => ({ payoutOnboardingStatus: 'verified' }));
  patch(ReferralCommission, 'create', async (data) => {
    const duplicate = store.commissions.some((existing) =>
      same(existing.booking, data.booking) ||
      (data.invitation && same(existing.invitation, data.invitation)) ||
      (data.customerClaim && same(existing.customerClaim, data.customerClaim)));
    if (duplicate) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const commission = {
      paymentTransactions: [],
      auditTrail: [],
      refundedAmount: 0,
      ...data,
      save: async () => commission
    };
    store.commissions.push(commission);
    return commission;
  });
  patch(ReferralCommission, 'findOne', async (filter) => store.commissions.find((c) => matches(c, filter)) || null);
  patch(ReferralCommission, 'exists', async (filter) =>
    (skipPrecheck ? null : store.commissions.find((c) => matches(c, filter)) || null));
  return store;
};

const makeBooking = (id, user, overrides = {}) => ({
  _id: id,
  user,
  totalPrice: 5000,
  status: 'booked',
  referral: {
    eligibility: 'eligible',
    invitation: 'inv1',
    attribution: 'attr1',
    referrer: 'referrer1',
    rulesModel: 'fee_percent_v4',
    rewardAmount: 50,
    rewardPercent: 10,
    rewardCap: 250,
    minimumPlatformFee: 0,
    platformFeePercent: 10,
    platformFeeAmount: 500,
    retainedPlatformFee: 500,
    completionDelayHours: 48,
    attributionRulesVersion: 2,
    auditTrail: []
  },
  save: async () => {},
  ...overrides
});

let store;
test.afterEach(() => {
  store?.restore.reverse().forEach((restore) => restore());
  store = null;
});

// ── Booking evaluation ────────────────────────────────────────────────────────
const attribution = {
  _id: 'attr1',
  invitation: 'inv1',
  referrer: 'referrer1',
  code: 'GTAAAAAAAAAA',
  createdAt: new Date('2026-01-01'),
  rules: { version: 3, rewardPercent: 10, rewardCap: 250, minimumPlatformFee: 500 }
};
const customer = { _id: 'customer1', email: 'guest@example.com' };
const settings = { termsVersion: 'terms-v4', completionDelayHours: 48 };
const referrerLookup = (referrer) => ({ findById: () => ({ select: async () => referrer }) });
const accountLookup = (termsVersion = 'terms-v4') => ({
  findOne: () => ({ select: async () => ({ referrerConsent: { termsVersion } }) })
});
const snapshotFor = (overrides = {}, deps = {}) =>
  buildReferralSnapshot({
    attribution,
    user: customer,
    vendorId: 'vendor1',
    finalTotalPrice: 5000,
    platformFeePercent: 10,
    settings,
    deps: {
      UserModel: referrerLookup({ _id: 'referrer1', email: 'referrer@example.com' }),
      AccountModel: accountLookup(),
      newCustomerCheck: async () => true,
      rewardedCheck: async () => false,
      ...deps
    },
    ...overrides
  });

test('the reward is 10% of the booking fee, with no minimum fee', async () => {
  const small = await snapshotFor({ finalTotalPrice: 100 }); // $10 fee
  assert.equal(small.eligibility, 'eligible');
  assert.equal(small.platformFeeAmount, 10);
  assert.equal(small.rewardAmount, 1);
  assert.equal((await snapshotFor()).rewardAmount, 50);
  assert.equal((await snapshotFor({ finalTotalPrice: 8000 })).rewardAmount, 80);
  assert.equal((await snapshotFor({ finalTotalPrice: 4999.9 })).rewardAmount, 50);
});

test('the reward is calculated from the booking fee, not the booking total', async () => {
  const snapshot = await snapshotFor({ finalTotalPrice: 50000, platformFeePercent: 0.9 }); // $450 fee
  assert.equal(snapshot.platformFeeAmount, 450);
  assert.equal(snapshot.rewardAmount, 45);
});

test('the reward is rounded to the nearest cent', async () => {
  assert.equal((await snapshotFor({ finalTotalPrice: 123.45 })).rewardAmount, 1.24); // fee 12.35 -> 1.235 rounds half up
  assert.equal((await snapshotFor({ finalTotalPrice: 1234.56 })).rewardAmount, 12.35); // fee 123.46 -> 12.346
});

test('the reward never exceeds $250', async () => {
  assert.equal((await snapshotFor({ finalTotalPrice: 25000 })).rewardAmount, 250);
  assert.equal((await snapshotFor({ finalTotalPrice: 500000 })).rewardAmount, 250);
});

test('a booking with a 0% booking fee does not qualify', async () => {
  const snapshot = await snapshotFor({ platformFeePercent: 0 });
  assert.equal(snapshot.eligibility, 'zero_fee');
  assert.equal(snapshot.rewardAmount, 0);
  assert.equal((await snapshotFor({ platformFeePercent: undefined })).eligibility, 'zero_fee');
});

test('taxes are excluded from the booking fee', async () => {
  const snapshot = await snapshotFor({ finalTotalPrice: 1088.75, taxAmount: 88.75 });
  assert.equal(snapshot.platformFeeAmount, 100);
  assert.equal(snapshot.rewardAmount, 10);
  assert.equal(snapshot.taxAmount, 88.75);
});

test('an attribution made under earlier terms follows the current rules', async () => {
  const legacy = { ...attribution, rules: { version: 2, rewardAmount: 50, minimumPlatformFee: 500 } };
  const snapshot = await snapshotFor({ attribution: legacy, finalTotalPrice: 100 });
  assert.equal(snapshot.eligibility, 'eligible');
  assert.equal(snapshot.rewardAmount, 1);
  assert.equal(snapshot.rulesModel, 'fee_percent_v4');
});

test('self-referrals are rejected by account, vendor, staff, and matching email', async () => {
  const byUser = await snapshotFor({}, { UserModel: referrerLookup({ _id: 'customer1', email: 'x@example.com' }) });
  assert.equal(byUser.eligibility, 'self_referral');
  const byVendor = await snapshotFor({ vendorId: 'referrer1' });
  assert.equal(byVendor.eligibility, 'self_referral');
  const byStaff = await snapshotFor({}, { UserModel: referrerLookup({ _id: 'referrer1', staffOf: 'vendor1' }) });
  assert.equal(byStaff.eligibility, 'self_referral');
  const byEmail = await snapshotFor({}, { UserModel: referrerLookup({ _id: 'referrer1', email: ' Guest@Example.com ' }) });
  assert.equal(byEmail.eligibility, 'self_referral');
});

test('only a new customer qualifies', async () => {
  const snapshot = await snapshotFor({}, { newCustomerCheck: async () => false });
  assert.equal(snapshot.eligibility, 'not_new_customer');
  assert.equal(snapshot.rewardAmount, 0);
});

test('a customer who already produced a reward does not qualify again', async () => {
  const snapshot = await snapshotFor({}, { rewardedCheck: async () => true });
  assert.equal(snapshot.eligibility, 'already_rewarded');
  assert.equal(snapshot.rewardAmount, 0);
});

test('the referrer must have accepted the current program terms', async () => {
  const snapshot = await snapshotFor({}, { AccountModel: accountLookup('terms-v3') });
  assert.equal(snapshot.eligibility, 'terms_not_accepted');
  assert.equal(snapshot.rewardAmount, 0);
});

test('an unknown invitation is not rewarded', async () => {
  const snapshot = await snapshotFor({ attribution: { ...attribution, invitation: null } }, { findInvitation: async () => null });
  assert.equal(snapshot.eligibility, 'invitation_unavailable');
});

// ── One reward per referred customer ──────────────────────────────────────────
test('one referral link can reward the referrer for several different new customers', async () => {
  store = createStore();
  const first = await claimRewardForBooking({ booking: makeBooking('bookingA', 'customer1'), vendorId: 'vendor1' });
  const second = await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer2'), vendorId: 'vendor1' });
  assert.ok(first && second);
  assert.equal(store.commissions.length, 2);
  assert.equal(store.commissions[0].sourceInvitation, 'inv1');
  assert.equal(store.commissions[1].sourceInvitation, 'inv1');
});

test('the reward is recorded against the referred customer with the current rules', async () => {
  store = createStore();
  const commission = await claimRewardForBooking({ booking: makeBooking('bookingA', 'customer1'), vendorId: 'vendor1' });
  assert.equal(commission.customerClaim, 'customer1');
  assert.equal(commission.referredUser, 'customer1');
  assert.equal(commission.rulesModel, 'fee_percent_v4');
  assert.equal(commission.minimumPlatformFee, 0);
  assert.equal(commission.status, 'pending');
  assert.equal(commission.amount, 50);
});

test('two bookings by the same customer racing for a reward produce exactly one', async () => {
  store = createStore();
  const first = makeBooking('bookingA', 'customer1');
  const second = makeBooking('bookingB', 'customer1');
  const results = await Promise.all([
    claimRewardForBooking({ booking: first, vendorId: 'vendor1' }),
    claimRewardForBooking({ booking: second, vendorId: 'vendor1' })
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(store.commissions.length, 1);
  const loser = results[0] ? second : first;
  assert.equal(loser.referral.eligibility, 'already_rewarded');
  assert.equal(loser.referral.rewardAmount, 0);
});

test('the database index alone stops a second reward when the pre-check is raced past', async () => {
  store = createStore({ skipPrecheck: true });
  const first = makeBooking('bookingA', 'customer1');
  const second = makeBooking('bookingB', 'customer1');
  assert.ok(await claimRewardForBooking({ booking: first, vendorId: 'vendor1' }));
  assert.equal(await claimRewardForBooking({ booking: second, vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 1);
  assert.equal(second.referral.eligibility, 'already_rewarded');
});

test('using both a link and a code for one customer still produces one reward', async () => {
  store = createStore();
  const viaLink = makeBooking('bookingA', 'customer1');
  const viaCode = makeBooking('bookingB', 'customer1');
  viaCode.referral.invitation = 'inv2';
  await claimRewardForBooking({ booking: viaLink, vendorId: 'vendor1' });
  assert.equal(await claimRewardForBooking({ booking: viaCode, vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 1);
});

test('retrying the same booking does not create a second reward', async () => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1');
  await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  const retry = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  assert.equal(store.commissions.length, 1);
  assert.equal(retry.booking, 'bookingA');
});

test('a later booking cannot earn again once the first reward is paid', async () => {
  store = createStore();
  const first = await claimRewardForBooking({ booking: makeBooking('bookingA', 'customer1'), vendorId: 'vendor1' });
  first.status = 'paid';
  assert.equal(await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer1'), vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 1);
});

test('a reward from the earlier terms also uses up the customer', async () => {
  store = createStore({
    commissions: [{ booking: 'old1', referredUser: 'customer1', invitation: 'inv9', status: 'paid', rulesModel: 'fee_percent_v3', amount: 80 }]
  });
  const booking = makeBooking('bookingB', 'customer1');
  assert.equal(await claimRewardForBooking({ booking, vendorId: 'vendor1' }), null);
  assert.equal(booking.referral.eligibility, 'already_rewarded');
  assert.equal(store.commissions.length, 1);
});

test('a nonqualifying booking does not use up the customer: no ledger entry is made', async () => {
  store = createStore();
  const zeroFee = makeBooking('bookingA', 'customer1');
  Object.assign(zeroFee.referral, { eligibility: 'zero_fee', rewardAmount: 0, platformFeeAmount: 0 });
  assert.equal(await claimRewardForBooking({ booking: zeroFee, vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 0);
  const qualifying = await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer1'), vendorId: 'vendor1' });
  assert.equal(qualifying.booking, 'bookingB');
  assert.equal(qualifying.amount, 50);
});

test('a nonqualifying booking is evaluated without consulting or consuming any reward', async () => {
  store = createStore();
  const nonQualifying = await snapshotFor({ platformFeePercent: 0 }, { rewardedCheck: async () => { throw new Error('must not be reached'); } });
  assert.equal(nonQualifying.eligibility, 'zero_fee');
  const next = await snapshotFor();
  assert.equal(next.eligibility, 'eligible');
});

test('a failed ledger write leaves the booking a candidate for the repair job', async () => {
  store = createStore();
  ReferralCommission.create = async () => { throw new Error('database unavailable'); };
  const booking = makeBooking('bookingA', 'customer1');
  assert.equal(await claimRewardForBooking({ booking, vendorId: 'vendor1' }), null);
  assert.equal(booking.referral.eligibility, 'eligible');
  assert.equal(store.commissions.length, 0);
});

test('a booking evaluated before the updated terms keeps the earlier rules when its reward is recorded', async () => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1');
  delete booking.referral.rulesModel;
  booking.referral.minimumPlatformFee = 500;
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  assert.equal(commission.rulesModel, 'fee_percent_v3');
  assert.equal(commission.minimumPlatformFee, 500);
});

// ── Refunds ───────────────────────────────────────────────────────────────────
const withReward = async (bookingOverrides = {}) => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1', bookingOverrides);
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  return { booking, commission };
};

const withLargeReward = async () => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1', { totalPrice: 8000 });
  Object.assign(booking.referral, { platformFeeAmount: 800, retainedPlatformFee: 800, rewardAmount: 80 });
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  return { booking, commission };
};

test('a partial refund that lowers the retained fee lowers the unpaid reward with it', async () => {
  const { booking, commission } = await withLargeReward();
  assert.equal(commission.amount, 80);
  await applyRefundToReferralReward({ booking, refundAmount: 7300, source: 'partial_refund' }); // vendor share is $7,200
  assert.equal(commission.retainedPlatformFee, 700);
  assert.equal(commission.amount, 70);
  assert.equal(commission.status, 'pending');
  assert.equal(booking.referral.rewardAmount, 70);
});

test('a small retained fee still earns a proportionally small reward after a refund', async () => {
  const { booking, commission } = await withLargeReward();
  await applyRefundToReferralReward({ booking, refundAmount: 7999, source: 'partial_refund' }); // $1 of fee left
  assert.equal(commission.retainedPlatformFee, 1);
  assert.equal(commission.amount, 0.1);
  assert.equal(commission.status, 'pending');
});

test('a refund taken from the vendor share leaves the reward unchanged', async () => {
  const { booking, commission } = await withLargeReward();
  await applyRefundToReferralReward({ booking, refundAmount: 7200, source: 'vendor_partial_refund' });
  assert.equal(commission.amount, 80);
});

test('refunds are measured without taxes', async () => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1', { totalPrice: 1088.75 });
  Object.assign(booking.referral, { taxAmount: 88.75, platformFeeAmount: 100, retainedPlatformFee: 100, rewardAmount: 10 });
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  assert.equal(commission.taxAmount, 88.75);
  await applyRefundToReferralReward({ booking, refundAmount: 1000, source: 'partial_refund' });
  assert.equal(commission.retainedPlatformFee, 81.52);
  assert.equal(commission.amount, 8.15);
});

test('a refund after a paid reward flags only the excess for recovery review', async () => {
  const { booking, commission } = await withLargeReward();
  commission.status = 'paid';
  await applyRefundToReferralReward({ booking, refundAmount: 7300, source: 'chargeback_partial' });
  assert.equal(commission.status, 'review');
  assert.equal(commission.amount, 80);
  assert.equal(commission.recoverableAmount, 10);
});

test('a refund that keeps a paid reward unchanged does not flag it', async () => {
  const { booking, commission } = await withLargeReward();
  commission.status = 'paid';
  await applyRefundToReferralReward({ booking, refundAmount: 100, source: 'partial_refund' });
  assert.equal(commission.status, 'paid');
  assert.equal(commission.recoverableAmount ?? 0, 0);
});

test('a full refund cancels the reward and frees the customer for a later qualifying booking', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, fullRefund: true, source: 'dispute_refund' });
  assert.equal(commission.status, 'canceled');
  assert.equal(commission.refundedAmount, 5000);
  assert.equal(commission.customerClaim, null);
  assert.equal(booking.referral.retainedPlatformFee, 0);
  const later = await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer1'), vendorId: 'vendor1' });
  assert.equal(later.booking, 'bookingB');
  assert.equal(store.commissions.filter((c) => c.status !== 'canceled').length, 1);
});

test('a canceled booking cancels the reward even when its fee is retained', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, refundAmount: 4500, bookingCanceled: true, source: 'partial_refund' });
  assert.equal(commission.status, 'canceled');
});

test('a refund after the reward was paid flags it for recovery review instead of rewriting it', async () => {
  const { booking, commission } = await withReward();
  commission.status = 'paid';
  await applyRefundToReferralReward({ booking, fullRefund: true, source: 'chargeback_lost' });
  assert.equal(commission.status, 'review');
  assert.equal(commission.recoverableAmount, 50);
  assert.equal(commission.amount, 50);
  assert.equal(commission.customerClaim, 'customer1');
});

test('replayed Stripe refund events do not double count', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, refundedTotal: 2000, source: 'stripe_refund' });
  await applyRefundToReferralReward({ booking, refundedTotal: 2000, source: 'stripe_refund' });
  assert.equal(commission.refundedAmount, 2000);
  assert.equal(commission.status, 'pending');
  await applyRefundToReferralReward({ booking, refundedTotal: 5000, source: 'stripe_refund' });
  assert.equal(commission.status, 'canceled');
});

// ── Rewards created under earlier terms are never silently recalculated ───────
const earlierReward = (overrides = {}) => ({
  booking: 'old1', referredUser: 'customerOld', customerClaim: null, invitation: 'inv9', status: 'pending',
  rulesModel: 'fee_percent_v3', rewardPercent: 10, rewardCap: 250, minimumPlatformFee: 500,
  bookingTotal: 5000, platformFeeAmount: 500, retainedPlatformFee: 500, refundedAmount: 0, amount: 50,
  paymentTransactions: [], auditTrail: [], save: async () => {},
  ...overrides
});

test('a $500-minimum reward is still cancelled when a refund takes its fee under $500', async () => {
  store = createStore({ commissions: [earlierReward()] });
  const booking = makeBooking('old1', 'customerOld');
  await applyRefundToReferralReward({ booking, refundAmount: 4500.01, source: 'partial_refund' });
  assert.equal(store.commissions[0].status, 'canceled');
  assert.equal(store.commissions[0].retainedPlatformFee, 499.99);
});

test('a fixed-$50 reward keeps its amount through a refund that leaves the fee eligible', async () => {
  store = createStore({ commissions: [earlierReward({ rulesModel: 'flat_fee_v2', rewardPercent: null })] });
  await applyRefundToReferralReward({ booking: makeBooking('old1', 'customerOld'), refundAmount: 4500, source: 'partial_refund' });
  assert.equal(store.commissions[0].amount, 50);
  assert.equal(store.commissions[0].status, 'pending');
});

test('a paid earlier reward is not rewritten by the updated terms', async () => {
  store = createStore({ commissions: [earlierReward({ status: 'paid', amount: 50 })] });
  await applyRefundToReferralReward({ booking: makeBooking('old1', 'customerOld'), refundAmount: 100, source: 'partial_refund' });
  assert.equal(store.commissions[0].status, 'paid');
  assert.equal(store.commissions[0].amount, 50);
});

test('rewards created under the earliest percentage program are left as they were', async () => {
  const { booking, commission } = await withReward();
  commission.rulesModel = null;
  commission.status = 'eligible';
  await applyRefundToReferralReward({ booking, fullRefund: true, source: 'full_refund' });
  assert.equal(commission.status, 'eligible');
  assert.equal(commission.amount, 50);
});

// ── Completion ────────────────────────────────────────────────────────────────
test('the final fee is measured on the pre-tax amount at completion', async () => {
  store = createStore();
  const booking = makeBooking('bookingA', 'customer1', { totalPrice: 1088.75 });
  Object.assign(booking.referral, { taxAmount: 88.75, platformFeePercent: 10, platformFeeAmount: 100, retainedPlatformFee: 100, rewardAmount: 10 });
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  // The completion job's fee (10% of the taxed total) is not what the reward uses.
  await syncRewardWithFinalFee({ booking, platformFee: 108.88, payment: { _id: 'pay1' } });
  assert.equal(commission.platformFeeAmount, 100);
  assert.equal(commission.amount, 10);
});

test('the reward is set aside from the platform fee, not the vendor payout', async () => {
  const { booking, commission } = await withReward();
  await syncRewardWithFinalFee({ booking, platformFee: 500, payment: { _id: 'pay1' } });
  assert.equal(commission.status, 'pending');
  assert.equal(commission.allocatedAmount, 50);
  assert.deepEqual(commission.paymentTransactions, ['pay1']);
});

test('an earlier reward keeps the fee the completion job calculated', async () => {
  store = createStore({ commissions: [earlierReward()] });
  const booking = makeBooking('old1', 'customerOld');
  await syncRewardWithFinalFee({ booking, platformFee: 800, payment: { _id: 'pay1' } });
  assert.equal(store.commissions[0].amount, 80);
});
