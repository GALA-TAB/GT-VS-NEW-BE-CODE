const crypto = require('node:crypto');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralInvitation = require('../models/ReferralInvitation');
const Booking = require('../models/Bookings');

const MAX_UNUSED_INVITATIONS = 25;
const CODE_PATTERN = /^GT[A-F0-9]{10}$/;

const generateInvitationCode = () => `GT${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const normalizeCode = (code) => String(code || '').trim().toUpperCase();

// The code created with a participant's account is their first invitation. Existing
// accounts get theirs lazily, so no data migration is required.
const ensurePrimaryInvitation = async (account) => {
  try {
    return await ReferralInvitation.findOneAndUpdate(
      { code: account.code },
      { $setOnInsert: { referrer: account.user, code: account.code, status: 'active' } },
      { upsert: true, new: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    return ReferralInvitation.findOne({ code: account.code });
  }
};

const findInvitationByCode = async (rawCode) => {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) return null;
  const invitation = await ReferralInvitation.findOne({ code });
  if (invitation) return invitation;
  const account = await ReferralAccount.findOne({ code });
  return account ? ensurePrimaryInvitation(account) : null;
};

const createInvitation = async ({ account, label = '' }) => {
  await ensurePrimaryInvitation(account);
  const unused = await ReferralInvitation.countDocuments({ referrer: account.user, status: 'active' });
  if (unused >= MAX_UNUSED_INVITATIONS) {
    const error = new Error(`You can have up to ${MAX_UNUSED_INVITATIONS} unused invitations. Revoke one before creating another.`);
    error.statusCode = 400;
    throw error;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInvitationCode();
    if (await ReferralAccount.exists({ code })) continue;
    try {
      return await ReferralInvitation.create({
        referrer: account.user,
        code,
        label: String(label || '').trim().slice(0, 60)
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  throw new Error('Could not generate a unique invitation code.');
};

// An invitation can be redeemed while unused, or again by the same referred customer
// after an earlier unpaid reward was canceled. Anyone else is rejected.
const isInvitationUsable = (invitation, userId) =>
  Boolean(invitation) &&
  invitation.status === 'active' &&
  (!invitation.referredUser || !userId || String(invitation.referredUser) === String(userId));

// The conditional update is atomic: only one booking can win an invitation, however many
// are submitted at once. A booking that already holds it (e.g. a retry after a crash)
// may continue; no other booking can take it.
const claimInvitation = ({ invitationId, userId, bookingId, Invitation = ReferralInvitation }) =>
  Invitation.findOneAndUpdate(
    {
      _id: invitationId,
      $or: [
        { status: 'active', $or: [{ referredUser: null }, { referredUser: userId }] },
        { status: 'claimed', claimedBooking: bookingId }
      ]
    },
    { $set: { status: 'claimed', referredUser: userId, claimedBooking: bookingId, claimedAt: new Date() } },
    { new: true }
  );

const releaseInvitation = ({ invitationId, bookingId, Invitation = ReferralInvitation }) =>
  Invitation.findOneAndUpdate(
    { _id: invitationId, status: 'claimed', claimedBooking: bookingId },
    { $set: { status: 'active', claimedBooking: null, claimedAt: null } },
    { new: true }
  );

const markInvitationRewarded = ({ invitationId, bookingId, Invitation = ReferralInvitation }) =>
  Invitation.findOneAndUpdate(
    { _id: invitationId, status: 'claimed', claimedBooking: bookingId },
    { $set: { status: 'rewarded', rewardedAt: new Date() } },
    { new: true }
  );

// "New customer": no live booking existed before the referral was first attributed.
const isNewCustomer = async ({ userId, attributedAt, excludeBookingId, BookingModel = Booking }) => {
  const filter = {
    user: userId,
    isDeleted: { $ne: true },
    status: { $in: ['pending', 'booked', 'completed'] },
    createdAt: { $lt: attributedAt }
  };
  if (excludeBookingId) filter._id = { $ne: excludeBookingId };
  return !(await BookingModel.exists(filter));
};

module.exports = {
  MAX_UNUSED_INVITATIONS,
  CODE_PATTERN,
  generateInvitationCode,
  normalizeCode,
  ensurePrimaryInvitation,
  findInvitationByCode,
  createInvitation,
  isInvitationUsable,
  claimInvitation,
  releaseInvitation,
  markInvitationRewarded,
  isNewCustomer
};
