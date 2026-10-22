const test = require('node:test');
const assert = require('node:assert/strict');
const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const Payments = require('../models/Payment');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralInvitation = require('../models/ReferralInvitation');
const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const { runReferralRewardCycle } = require('./referralRewardCycle');

const NOW = new Date('2026-03-10T12:00:00Z');
const restores = [];
const patch = (target, name, implementation) => {
  const original = target[name];
  target[name] = implementation;
  restores.push(() => { target[name] = original; });
};
test.afterEach(() => {
  restores.splice(0).reverse().forEach((restore) => restore());
});

const applyUpdate = (doc, update) => {
  Object.assign(doc, update.$set || {});
  (update.$push ? Object.entries(update.$push) : []).forEach(([key, value]) => doc[key].push(value));
};

// Sets up one rewarded booking and the surrounding collections. Returns handles to inspect.
const arrange = ({
  payoutsEnabled = true,
  escrowStatus = 'released',
  balanceCents = 100000,
  booking: bookingPatch = {},
  account = { stripeAccountId: 'acct_referrer', payoutOnboardingStatus: 'verified' },
  commission: commissionPatch = {},
  existingTransfers = [],
  transferError = null
} = {}) => {
  const booking = {
    _id: 'bookingA',
    status: 'completed',
    paymentStatus: true,
    inDispute: false,
    cancelRequest: false,
    totalPrice: 5000,
    checkOut: new Date('2026-03-01T00:00:00Z'),
    ...bookingPatch
  };
  const commission = {
    _id: 'commission1',
    booking: 'bookingA',
    referrer: 'referrer1',
    invitation: 'inv1',
    rulesModel: 'flat_fee_v2',
    status: 'pending',
    amount: 50,
    platformFeeAmount: 500,
    retainedPlatformFee: 500,
    minimumPlatformFee: 500,
    completionDelayHours: 48,
    completionConfirmedAt: new Date('2026-03-02T00:00:00Z'),
    availableFundsVerified: false,
    auditTrail: [],
    save: async () => commission,
    ...commissionPatch
  };
  const invitation = { _id: 'inv1', status: 'claimed', claimedBooking: 'bookingA' };
  const transfers = [...existingTransfers];
  const stripe = {
    balance: { retrieve: async () => ({ available: [{ currency: 'usd', amount: balanceCents }] }) },
    transfers: {
      list: async () => ({ data: transfers }),
      create: async (params, options) => {
        if (transferError) throw transferError;
        const transfer = { id: `tr_${transfers.length + 1}`, ...params, options };
        transfers.push(transfer);
        return transfer;
      }
    }
  };

  patch(ReferralProgramSettings, 'findOne', () => ({
    sort: () => ({ lean: async () => ({ version: 2, rulesModel: 'flat_fee_v2', termsVersion: 't', enabled: true, rewardAmount: 50, minimumPlatformFee: 500, attributionWindowDays: 30, completionDelayHours: 48, payoutsEnabled }) })
  }));
  patch(Booking, 'find', () => ({ select: async () => [] }));
  patch(Booking, 'findById', async () => booking);
  patch(Listing, 'findById', () => ({ select: async () => ({ vendorId: 'vendor1' }) }));
  patch(Payments, 'findOne', async () => ({ escrowStatus }));
  patch(ReferralAccount, 'findOne', async () => account);
  patch(ReferralCommission, 'find', (filter) => ({
    limit: async () => {
      if (filter.$and) return commission.status === 'pending' ? [commission] : [];
      if (filter.status === 'eligible') return commission.status === 'eligible' ? [commission] : [];
      return [];
    },
    select: async () => []
  }));
  patch(ReferralCommission, 'updateMany', async () => ({}));
  patch(ReferralCommission, 'updateOne', async (filter, update) => {
    if (filter.status && commission.status !== filter.status) return { modifiedCount: 0 };
    applyUpdate(commission, update);
    return { modifiedCount: 1 };
  });
  patch(ReferralCommission, 'findOneAndUpdate', async (filter, update) => {
    if (filter.status && commission.status !== filter.status) return null;
    applyUpdate(commission, update);
    return commission;
  });
  patch(ReferralInvitation, 'findOneAndUpdate', async (filter, update) => {
    if (filter.status && invitation.status !== filter.status) return null;
    applyUpdate(invitation, update);
    return invitation;
  });
  return { commission, invitation, transfers, stripe };
};

const cycle = (stripe) => runReferralRewardCycle({ now: NOW, stripe });

test('a completed, paid, undisputed referral is paid exactly $50 once, from Gala Tab funds', async () => {
  const { commission, invitation, transfers, stripe } = arrange();
  await cycle(stripe);
  assert.equal(commission.status, 'paid');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amount, 5000);
  assert.equal(transfers[0].destination, 'acct_referrer');
  assert.equal(transfers[0].options.idempotencyKey, 'referral-reward-commission1');
  assert.equal(commission.providerTransferId, 'tr_1');
  assert.equal(invitation.status, 'rewarded');

  await cycle(stripe);
  await cycle(stripe);
  assert.equal(transfers.length, 1, 'repeated cycles must not pay again');
});

test('rewards stay pending, and nothing is paid, while administrators keep payouts disabled', async () => {
  const { commission, transfers, stripe } = arrange({ payoutsEnabled: false });
  await cycle(stripe);
  assert.equal(commission.status, 'pending');
  assert.equal(transfers.length, 0);
});

test('nothing is released before the vendor escrow window settles', async () => {
  const { commission, transfers, stripe } = arrange({ escrowStatus: 'held' });
  await cycle(stripe);
  assert.equal(commission.status, 'pending');
  assert.equal(commission.availableFundsVerified, false);
  assert.equal(transfers.length, 0);
});

test('nothing is released when the Stripe balance cannot cover the reward', async () => {
  const { commission, transfers, stripe } = arrange({ balanceCents: 4999 });
  await cycle(stripe);
  assert.equal(commission.status, 'pending');
  assert.equal(transfers.length, 0);
});

test('a Stripe balance of exactly $50 is enough to pay the reward', async () => {
  const { commission, stripe } = arrange({ balanceCents: 5000 });
  await cycle(stripe);
  assert.equal(commission.status, 'paid');
});

test('an unresolved dispute or refund request blocks release', async () => {
  for (const patchBooking of [{ inDispute: true }, { cancelRequest: true }]) {
    const { commission, transfers, stripe } = arrange({ booking: patchBooking });
    await cycle(stripe);
    assert.equal(commission.status, 'pending');
    assert.equal(transfers.length, 0);
    restores.splice(0).reverse().forEach((restore) => restore());
  }
});

test('missing payout verification blocks release', async () => {
  const { commission, transfers, stripe } = arrange({ account: { stripeAccountId: 'acct_referrer', payoutOnboardingStatus: 'pending' } });
  await cycle(stripe);
  assert.equal(commission.status, 'pending');
  assert.equal(transfers.length, 0);
});

test('unconfirmed completion and the 48 hour delay both block release', async () => {
  const unconfirmed = arrange({ commission: { completionConfirmedAt: null } });
  await cycle(unconfirmed.stripe);
  assert.equal(unconfirmed.commission.status, 'pending');
  restores.splice(0).reverse().forEach((restore) => restore());

  const tooSoon = arrange({ commission: { completionConfirmedAt: new Date('2026-03-09T12:00:01Z') } });
  await cycle(tooSoon.stripe);
  assert.equal(tooSoon.commission.status, 'pending');
  assert.equal(tooSoon.transfers.length, 0);
});

test('an unpaid booking blocks release', async () => {
  const { commission, transfers, stripe } = arrange({ booking: { paymentStatus: false } });
  await cycle(stripe);
  assert.equal(commission.status, 'pending');
  assert.equal(transfers.length, 0);
});

test('a retained fee under $500 cancels the reward at release time', async () => {
  const { commission, invitation, transfers, stripe } = arrange({ commission: { retainedPlatformFee: 499.99 } });
  await cycle(stripe);
  assert.equal(commission.status, 'canceled');
  assert.equal(invitation.status, 'active');
  assert.equal(transfers.length, 0);
});

test('a transfer that already exists at Stripe is adopted instead of paying twice', async () => {
  const { commission, transfers, stripe } = arrange({ existingTransfers: [{ id: 'tr_existing', metadata: { commissionId: 'commission1' } }] });
  await cycle(stripe);
  assert.equal(commission.status, 'paid');
  assert.equal(commission.providerTransferId, 'tr_existing');
  assert.equal(transfers.length, 1);
});

test('a failed transfer is recorded for retry, not marked paid', async () => {
  const { commission, invitation, stripe } = arrange({ transferError: new Error('insufficient funds') });
  await cycle(stripe);
  assert.equal(commission.status, 'failed');
  assert.equal(invitation.status, 'claimed');
});

test('rewards earned under the earlier percentage program are still paid at their recorded amount', async () => {
  const { commission, transfers, stripe } = arrange({
    commission: { rulesModel: null, status: 'eligible', amount: 100, retainedPlatformFee: undefined, platformFeeAmount: undefined }
  });
  await cycle(stripe);
  assert.equal(commission.status, 'paid');
  assert.equal(transfers[0].amount, 10000);
});
