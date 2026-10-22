const test = require('node:test');
const assert = require('node:assert/strict');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralInvitation = require('../models/ReferralInvitation');
const ReferralAccount = require('../models/ReferralAccount');
const {
  buildReferralSnapshot,
  claimRewardForBooking,
  applyRefundToReferralReward,
  syncRewardWithFinalFee
} = require('./referralRewards');
const { markInvitationRewarded } = require('./referralInvitations');

// ── In-memory stand-ins for the Mongo collections ─────────────────────────────
// They evaluate the same conditional filters the code sends, one JS turn at a time,
// so each conditional update behaves atomically like Mongo's single-document update.
const same = (a, b) => String(a ?? null) === String(b ?? null);
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, value]) =>
    (key === '$or' ? value.some((alternative) => matches(doc, alternative)) : same(doc[key], value)));

const createStore = ({ invitations = [] } = {}) => {
  const store = { invitations, commissions: [], restore: [] };
  const patch = (target, name, implementation) => {
    const original = target[name];
    target[name] = implementation;
    store.restore.push(() => { target[name] = original; });
  };
  patch(ReferralInvitation, 'findOneAndUpdate', async (filter, update) => {
    const doc = store.invitations.find((candidate) => matches(candidate, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return { ...doc };
  });
  patch(ReferralAccount, 'findOne', async () => ({ payoutOnboardingStatus: 'verified' }));
  patch(ReferralCommission, 'create', async (data) => {
    const duplicate = store.commissions.some((existing) =>
      same(existing.booking, data.booking) || (data.invitation && same(existing.invitation, data.invitation)));
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
    rewardAmount: 50,
    minimumPlatformFee: 500,
    platformFeeAmount: 500,
    retainedPlatformFee: 500,
    completionDelayHours: 48,
    attributionRulesVersion: 2,
    auditTrail: []
  },
  save: async () => {},
  ...overrides
});

const newInvitation = (overrides = {}) => ({
  _id: 'inv1',
  referrer: 'referrer1',
  status: 'active',
  referredUser: null,
  claimedBooking: null,
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
  rules: { version: 2, rewardAmount: 50, minimumPlatformFee: 500 }
};
const customer = { _id: 'customer1', email: 'guest@example.com' };
const settings = { rewardAmount: 50, minimumPlatformFee: 500, completionDelayHours: 48 };
const referrerLookup = (referrer) => ({ findById: () => ({ select: async () => referrer }) });
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
      newCustomerCheck: async () => true,
      ...deps
    },
    ...overrides
  });

test('a booking whose platform fee is exactly $500 is a reward candidate', async () => {
  const snapshot = await snapshotFor();
  assert.equal(snapshot.eligibility, 'eligible');
  assert.equal(snapshot.rewardAmount, 50);
  assert.equal(snapshot.platformFeeAmount, 500);
});

test('a $499.99 platform fee earns nothing, even on a large booking', async () => {
  const justUnder = await snapshotFor({ finalTotalPrice: 4999.9 });
  assert.equal(justUnder.eligibility, 'below_threshold');
  assert.equal(justUnder.rewardAmount, 0);
  const bigButLowFee = await snapshotFor({ finalTotalPrice: 50000, platformFeePercent: 0.9 });
  assert.equal(bigButLowFee.eligibility, 'below_threshold');
});

test('an $800 platform fee earns the same flat $50', async () => {
  const snapshot = await snapshotFor({ finalTotalPrice: 8000 });
  assert.equal(snapshot.eligibility, 'eligible');
  assert.equal(snapshot.rewardAmount, 50);
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

test('an unknown invitation is not rewarded', async () => {
  const snapshot = await snapshotFor({ attribution: { ...attribution, invitation: null } }, { findInvitation: async () => null });
  assert.equal(snapshot.eligibility, 'invitation_unavailable');
});

// ── Duplicate redemption ──────────────────────────────────────────────────────
test('two bookings racing for one invitation produce exactly one reward', async () => {
  store = createStore({ invitations: [newInvitation()] });
  const first = makeBooking('bookingA', 'customer1');
  const second = makeBooking('bookingB', 'customer2');
  const results = await Promise.all([
    claimRewardForBooking({ booking: first, vendorId: 'vendor1' }),
    claimRewardForBooking({ booking: second, vendorId: 'vendor1' })
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(store.commissions.length, 1);
  const loser = results[0] ? second : first;
  assert.equal(loser.referral.eligibility, 'invitation_unavailable');
  assert.equal(loser.referral.rewardAmount, 0);
});

test('retrying the same booking does not create a second reward', async () => {
  store = createStore({ invitations: [newInvitation()] });
  const booking = makeBooking('bookingA', 'customer1');
  await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  const retry = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  assert.equal(store.commissions.length, 1);
  assert.equal(retry.booking, 'bookingA');
});

test('a second booking by the same customer cannot reuse an invitation that holds a reward', async () => {
  store = createStore({ invitations: [newInvitation()] });
  await claimRewardForBooking({ booking: makeBooking('bookingA', 'customer1'), vendorId: 'vendor1' });
  const later = makeBooking('bookingB', 'customer1');
  assert.equal(await claimRewardForBooking({ booking: later, vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 1);
});

test('a paid invitation can never produce another reward', async () => {
  store = createStore({ invitations: [newInvitation()] });
  await claimRewardForBooking({ booking: makeBooking('bookingA', 'customer1'), vendorId: 'vendor1' });
  await markInvitationRewarded({ invitationId: 'inv1', bookingId: 'bookingA' });
  assert.equal(store.invitations[0].status, 'rewarded');
  assert.equal(await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer1'), vendorId: 'vendor1' }), null);
  assert.equal(await claimRewardForBooking({ booking: makeBooking('bookingC', 'customer2'), vendorId: 'vendor1' }), null);
  assert.equal(store.commissions.length, 1);
});

test('a failed ledger write frees the invitation again', async () => {
  store = createStore({ invitations: [newInvitation()] });
  ReferralCommission.create = async () => { throw new Error('database unavailable'); };
  const booking = makeBooking('bookingA', 'customer1');
  assert.equal(await claimRewardForBooking({ booking, vendorId: 'vendor1' }), null);
  assert.equal(store.invitations[0].status, 'active');
  assert.equal(booking.referral.eligibility, 'invitation_unavailable');
});

// ── Refunds ───────────────────────────────────────────────────────────────────
const withReward = async (bookingOverrides = {}) => {
  store = createStore({ invitations: [newInvitation()] });
  const booking = makeBooking('bookingA', 'customer1', bookingOverrides);
  const commission = await claimRewardForBooking({ booking, vendorId: 'vendor1' });
  return { booking, commission };
};

test('a refund taken from the vendor share keeps the $50 reward', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, refundAmount: 4500, source: 'vendor_partial_refund' });
  assert.equal(commission.status, 'pending');
  assert.equal(commission.retainedPlatformFee, 500);
  assert.equal(commission.amount, 50);
});

test('a refund that cuts the retained fee below $500 cancels the reward and frees the invitation', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, refundAmount: 4500.01, source: 'partial_refund' });
  assert.equal(commission.status, 'canceled');
  assert.equal(commission.retainedPlatformFee, 499.99);
  assert.equal(commission.invitation, null);
  assert.equal(store.invitations[0].status, 'active');
  assert.equal(store.invitations[0].claimedBooking, null);
});

test('after a canceled reward only the same referred customer can earn the invitation', async () => {
  const { booking } = await withReward();
  await applyRefundToReferralReward({ booking, fullRefund: true, bookingCanceled: true, source: 'full_refund' });
  assert.equal(store.commissions[0].status, 'canceled');
  assert.equal(await claimRewardForBooking({ booking: makeBooking('bookingB', 'customer2'), vendorId: 'vendor1' }), null);
  const retry = await claimRewardForBooking({ booking: makeBooking('bookingC', 'customer1'), vendorId: 'vendor1' });
  assert.equal(retry.booking, 'bookingC');
  assert.equal(store.commissions.filter((commission) => commission.status !== 'canceled').length, 1);
});

test('a full refund cancels the reward', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, fullRefund: true, source: 'dispute_refund' });
  assert.equal(commission.status, 'canceled');
  assert.equal(commission.refundedAmount, 5000);
  assert.equal(booking.referral.retainedPlatformFee, 0);
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
});

test('replayed Stripe refund events do not double count', async () => {
  const { booking, commission } = await withReward();
  await applyRefundToReferralReward({ booking, refundedTotal: 2000, source: 'stripe_refund' });
  await applyRefundToReferralReward({ booking, refundedTotal: 2000, source: 'stripe_refund' });
  assert.equal(commission.refundedAmount, 2000);
  assert.equal(commission.status, 'pending');
  await applyRefundToReferralReward({ booking, refundedTotal: 4600, source: 'stripe_refund' });
  assert.equal(commission.status, 'canceled');
});

test('rewards created under the earlier percentage program are left as they were', async () => {
  const { booking, commission } = await withReward();
  commission.rulesModel = null;
  commission.status = 'eligible';
  await applyRefundToReferralReward({ booking, fullRefund: true, source: 'full_refund' });
  assert.equal(commission.status, 'eligible');
  assert.equal(commission.amount, 50);
});

test('the final platform fee is checked again when the booking completes', async () => {
  const { booking, commission } = await withReward();
  await syncRewardWithFinalFee({ booking, platformFee: 499.99, payment: { _id: 'pay1' } });
  assert.equal(commission.status, 'canceled');
});

test('the reward is set aside from the platform fee, not the vendor payout', async () => {
  const { booking, commission } = await withReward();
  await syncRewardWithFinalFee({ booking, platformFee: 500, payment: { _id: 'pay1' } });
  assert.equal(commission.status, 'pending');
  assert.equal(commission.allocatedAmount, 50);
  assert.deepEqual(commission.paymentTransactions, ['pay1']);
});
