const { Schema, model } = require('mongoose');

const consentSchema = new Schema(
  {
    acceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null }
  },
  { _id: false }
);

const referralAccountSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    // The first invitation code. Additional invitations live in ReferralInvitation.
    code: { type: String, required: true, unique: true, uppercase: true, index: true },
    referrerEnabled: { type: Boolean, default: false, index: true },
    referrerConsent: { type: consentSchema, default: () => ({}) },
    consentHistory: [{
      // 'vendor' entries only exist from the earlier vendor-funded program.
      participantType: { type: String, enum: ['referrer', 'vendor'], required: true },
      enabled: { type: Boolean, required: true },
      acceptedAt: { type: Date, default: Date.now },
      termsVersion: { type: String, default: null }
    }],
    stripeAccountId: { type: String, trim: true, default: null },
    payoutOnboardingStatus: {
      type: String,
      enum: ['not_started', 'pending', 'verified', 'restricted'],
      default: 'not_started'
    }
  },
  { timestamps: true }
);

module.exports = model('ReferralAccount', referralAccountSchema);
