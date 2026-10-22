const { Schema, model } = require('mongoose');

// One shareable invitation = one link + one matching backup code = at most one reward.
// active   : can be redeemed
// claimed  : a qualifying booking holds it; its reward is pending or being paid
// rewarded : the reward was paid; the invitation can never produce another one
// revoked  : retired by the referrer or an administrator
const referralInvitationSchema = new Schema(
  {
    referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    code: { type: String, required: true, unique: true, uppercase: true, index: true },
    label: { type: String, trim: true, maxlength: 60, default: '' },
    status: { type: String, enum: ['active', 'claimed', 'rewarded', 'revoked'], default: 'active', index: true },
    // The referred customer is fixed by the first booking that claims the invitation.
    referredUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    claimedBooking: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    claimedAt: { type: Date, default: null },
    rewardedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = model('ReferralInvitation', referralInvitationSchema);
