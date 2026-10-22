const { Schema, model } = require('mongoose');

const auditEntrySchema = new Schema(
  {
    action: { type: String, required: true },
    reason: { type: String, default: '' },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

// The reward ledger: one record per rewarded booking. `amount` is the reward payable.
// Records created under the earlier percentage program have no `rulesModel`; their
// amounts are kept untouched.
const referralCommissionSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true, index: true },
    attribution: { type: Schema.Types.ObjectId, ref: 'ReferralAttribution', required: true, index: true },
    // Cleared when an unpaid reward is canceled so the invitation can be used again.
    invitation: { type: Schema.Types.ObjectId, ref: 'ReferralInvitation', default: null },
    canceledInvitation: { type: Schema.Types.ObjectId, ref: 'ReferralInvitation', default: null },
    referredUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    rulesModel: { type: String, default: null },
    paymentTransactions: [{ type: Schema.Types.ObjectId, ref: 'Payments' }],
    paymentHistoryTransactions: [{ type: Schema.Types.ObjectId, ref: 'Payout' }],
    paymentIntentIds: [{ type: String, trim: true }],
    // Booking-fee revenue for this one booking (never combined with other bookings).
    bookingTotal: { type: Number, default: 0, min: 0 },
    platformFeeAmount: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },
    retainedPlatformFee: { type: Number, default: 0, min: 0 },
    minimumPlatformFee: { type: Number, default: null },
    rewardPercent: { type: Number, default: null },
    rewardCap: { type: Number, default: null },
    // Legacy percentage-program fields, kept for already-recorded rewards.
    serviceSubtotal: { type: Number, default: 0, min: 0 },
    remainingServiceSubtotal: { type: Number, default: 0, min: 0 },
    refundedServiceSubtotal: { type: Number, default: 0, min: 0 },
    ratePercent: { type: Number, default: null },
    minimumServiceSubtotal: { type: Number, default: null },
    completionDelayHours: { type: Number, default: 48, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    allocatedAmount: { type: Number, default: 0, min: 0 },
    availableFundsVerified: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'eligible', 'processing', 'paid', 'canceled', 'failed', 'paused', 'review'],
      default: 'pending',
      index: true
    },
    payoutOnboardingRequired: { type: Boolean, default: true },
    completionConfirmedAt: { type: Date, default: null },
    eligibleAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    providerTransferId: { type: String, default: null },
    providerPayoutId: { type: String, default: null },
    recoverableAmount: { type: Number, default: 0 },
    auditTrail: { type: [auditEntrySchema], default: [] }
  },
  { timestamps: true }
);

// An invitation (link + code) can hold at most one live reward.
referralCommissionSchema.index(
  { invitation: 1 },
  { unique: true, partialFilterExpression: { invitation: { $type: 'objectId' } } }
);

module.exports = model('ReferralCommission', referralCommissionSchema);
