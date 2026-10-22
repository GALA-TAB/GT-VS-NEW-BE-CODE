const { Schema, model } = require('mongoose');

const referralAttributionSchema = new Schema(
  {
    referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    invitation: { type: Schema.Types.ObjectId, ref: 'ReferralInvitation', default: null, index: true },
    code: { type: String, required: true, uppercase: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    visitorHash: { type: String, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    rules: {
      version: { type: Number, required: true },
      termsVersion: { type: String, required: true },
      rewardPercent: { type: Number, default: null },
      rewardCap: { type: Number, default: null },
      rewardAmount: { type: Number, default: null },
      minimumPlatformFee: { type: Number, default: null },
      attributionWindowDays: { type: Number, required: true },
      completionDelayHours: { type: Number, required: true }
    },
    status: { type: String, enum: ['active', 'expired', 'invalid'], default: 'active' }
  },
  { timestamps: true }
);

referralAttributionSchema.index({ referrer: 1, createdAt: -1 });
referralAttributionSchema.index(
  { visitorHash: 1 },
  { unique: true, partialFilterExpression: { status: 'active', visitorHash: { $type: 'string' } } }
);

module.exports = model('ReferralAttribution', referralAttributionSchema);
