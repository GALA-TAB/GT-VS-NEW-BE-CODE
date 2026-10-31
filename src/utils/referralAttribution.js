const crypto = require('node:crypto');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralAttribution = require('../models/ReferralAttribution');
const { getCurrentSettings, rewardOptionsFrom } = require('./referralSettings');
const { findInvitationByCode, isInvitationUsable } = require('./referralInvitations');
const ReferralInvitation = require('../models/ReferralInvitation');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const findActiveVisitorAttribution = (visitorHash) =>
  ReferralAttribution.findOne({ visitorHash, status: 'active', expiresAt: { $gt: new Date() } });

// A visitor keeps their first valid attribution. It stops being valid once its
// invitation is revoked, which frees them to use another code. Using both a link and a
// code never creates a second attribution, and never a second reward (see the ledger's
// one-live-reward-per-customer rule).
const preservedAttributionFor = async (visitorHash, userId) => {
  const existing = await findActiveVisitorAttribution(visitorHash);
  if (!existing) return null;
  const invitation = existing.invitation ? await ReferralInvitation.findById(existing.invitation) : null;
  if (!invitation || isInvitationUsable(invitation)) return existing;
  existing.status = 'invalid';
  await existing.save();
  return null;
};

const createAttributionForCode = async (code, userId, visitorId) => {
  const visitorHash = visitorId ? hashToken(String(visitorId)) : null;
  if (visitorHash) {
    await ReferralAttribution.updateMany(
      { visitorHash, status: 'active', expiresAt: { $lte: new Date() } },
      { $set: { status: 'expired' } }
    );
    const existing = await preservedAttributionFor(visitorHash, userId);
    if (existing) return { attribution: existing, token: null, preserved: true };
  }
  const settings = await getCurrentSettings();
  if (!settings.enabled || !code) return null;
  const invitation = await findInvitationByCode(code);
  if (!invitation || !isInvitationUsable(invitation)) return null;
  const account = await ReferralAccount.findOne({ user: invitation.referrer, referrerEnabled: true });
  if (
    !account ||
    String(account.user) === String(userId || '') ||
    account.referrerConsent?.termsVersion !== settings.termsVersion
  ) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + settings.attributionWindowDays * 24 * 60 * 60 * 1000);
  let attribution;
  try {
    attribution = await ReferralAttribution.create({
      referrer: account.user,
      invitation: invitation._id,
      code: invitation.code,
      tokenHash: hashToken(token),
      visitorHash,
      createdAt,
      expiresAt,
      rules: {
        version: settings.version,
        termsVersion: settings.termsVersion,
        ...rewardOptionsFrom(settings),
        attributionWindowDays: settings.attributionWindowDays,
        completionDelayHours: settings.completionDelayHours
      }
    });
  } catch (error) {
    if (error.code !== 11000 || !visitorHash) throw error;
    attribution = await findActiveVisitorAttribution(visitorHash);
    if (!attribution) throw error;
    return { attribution, token: null, preserved: true };
  }
  return { attribution, token };
};

const resolveReferralAttribution = async ({ token, code, userId, visitorId }) => {
  if (token) {
    const attribution = await ReferralAttribution.findOne({
      tokenHash: hashToken(token),
      status: 'active',
      expiresAt: { $gt: new Date() }
    });
    if (attribution) {
      const invitation = attribution.invitation ? await ReferralInvitation.findById(attribution.invitation) : null;
      if (!invitation || isInvitationUsable(invitation)) return { attribution, token };
    }
  }
  if (visitorId) {
    const existing = await preservedAttributionFor(hashToken(String(visitorId)), userId);
    if (existing) return { attribution: existing, token: null, preserved: true };
  }
  if (!code) return null;
  return createAttributionForCode(code, userId, visitorId);
};

module.exports = { hashToken, createAttributionForCode, resolveReferralAttribution };
