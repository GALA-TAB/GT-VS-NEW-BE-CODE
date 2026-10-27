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

// A referral link/code refers customers to Gala Tab as a platform and can be used by any
// number of new customers; it only stops working once it is revoked. (Earlier terms made an
// invitation single-use, so legacy claimed/rewarded invitations are usable again.)
const isInvitationUsable = (invitation) => Boolean(invitation) && invitation.status !== 'revoked';

// "New customer": no live booking existed before the referral was first attributed. A
// booking that was itself nonqualifying (0% booking fee) never counts against the customer,
// so it does not use up their eligibility if they are attributed again later.
const isNewCustomer = async ({ userId, attributedAt, excludeBookingId, BookingModel = Booking }) => {
  const filter = {
    user: userId,
    isDeleted: { $ne: true },
    status: { $in: ['pending', 'booked', 'completed'] },
    createdAt: { $lt: attributedAt },
    'referral.eligibility': { $ne: 'zero_fee' }
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
  isNewCustomer
};
