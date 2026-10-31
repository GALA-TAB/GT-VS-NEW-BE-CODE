const { Schema, model } = require('mongoose');

// One shareable referral link + matching backup code. It refers customers to Gala Tab as a
// platform and can attribute any number of new customers; each referred customer can earn
// the referrer one reward (tracked on ReferralCommission.customerClaim).
// active   : can be used
// revoked  : retired by the referrer or an administrator
// claimed / rewarded : only set by earlier terms (single-use invitations); treated as active.
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
