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

const referralCommissionSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true, index: true },
    attribution: { type: Schema.Types.ObjectId, ref: 'ReferralAttribution', required: true, index: true },
    referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    paymentTransactions: [{ type: Schema.Types.ObjectId, ref: 'Payments' }],
    paymentHistoryTransactions: [{ type: Schema.Types.ObjectId, ref: 'Payout' }],
    paymentIntentIds: [{ type: String, trim: true }],
    serviceSubtotal: { type: Number, required: true, min: 0 },
    remainingServiceSubtotal: { type: Number, default: 0, min: 0 },
    refundedServiceSubtotal: { type: Number, default: 0, min: 0 },
    ratePercent: { type: Number, required: true },
    minimumServiceSubtotal: { type: Number, required: true },
    completionDelayHours: { type: Number, default: 48, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    allocatedAmount: { type: Number, default: 0, min: 0 },
    availableProviderFundsVerified: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'eligible', 'processing', 'paid', 'canceled', 'failed', 'paused', 'review'],
      default: 'pending',
      index: true
    },
    payoutOnboardingRequired: { type: Boolean, default: true },
    completionConfirmedAt: { type: Date, default: null },
    eligibleAt: { type: Date, default: null },
    providerTransferId: { type: String, default: null },
    providerPayoutId: { type: String, default: null },
    recoverableAmount: { type: Number, default: 0 },
    auditTrail: { type: [auditEntrySchema], default: [] }
  },
  { timestamps: true }
);

module.exports = model('ReferralCommission', referralCommissionSchema);