const crypto = require('node:crypto');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralAttribution = require('../models/ReferralAttribution');
const ReferralProgramSettings = require('../models/ReferralProgramSettings');

const TERMS_VERSION = 'gala-tab-referral-2026-10-v1';
const DEFAULT_SETTINGS = {
  version: 1,
  termsVersion: TERMS_VERSION,
  enabled: true,
  commissionRatePercent: 5,
  minimumServiceSubtotal: 500,
  attributionWindowDays: 30,
  completionDelayHours: 48
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const createAttributionForCode = async (code, userId, visitorId) => {
  const visitorHash = visitorId ? hashToken(String(visitorId)) : null;
  if (visitorHash) {
    await ReferralAttribution.updateMany(
      { visitorHash, status: 'active', expiresAt: { $lte: new Date() } },
      { $set: { status: 'expired' } }
    );
  }
  if (visitorHash) {
    const existing = await ReferralAttribution.findOne({
      visitorHash,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });
    if (existing) return { attribution: existing, token: null, preserved: true };
  }
  const settings = (await ReferralProgramSettings.findOne().sort({ version: -1 })) || DEFAULT_SETTINGS;
  if (!settings.enabled || !code) return null;
  const account = await ReferralAccount.findOne({ code: String(code).trim().toUpperCase(), referrerEnabled: true });
  if (
    !account ||
    String(account.user) === String(userId || '') ||
    account.referrerConsent?.termsVersion !== settings.termsVersion ||
    account.referrerConsent?.ratePercent !== settings.commissionRatePercent ||
    account.referrerConsent?.minimumServiceSubtotal !== settings.minimumServiceSubtotal
  ) return null;
  const participants = await ReferralAccount.find({ vendorFundingEnabled: true }).select('user vendorConsent');
  const vendorCommitments = participants
    .filter((participant) =>
      participant.vendorConsent?.acceptedAt &&
      participant.vendorConsent?.termsVersion === settings.termsVersion &&
      participant.vendorConsent?.ratePercent === settings.commissionRatePercent &&
      participant.vendorConsent?.minimumServiceSubtotal === settings.minimumServiceSubtotal
    )
    .map((participant) => ({
      vendor: participant.user,
      ratePercent: participant.vendorConsent.ratePercent,
      minimumServiceSubtotal: participant.vendorConsent.minimumServiceSubtotal,
      termsVersion: participant.vendorConsent.termsVersion,
      consentedAt: participant.vendorConsent.acceptedAt
    }));
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + settings.attributionWindowDays * 24 * 60 * 60 * 1000);
  let attribution;
  try {
    attribution = await ReferralAttribution.create({
      referrer: account.user,
      code: account.code,
      tokenHash: hashToken(token),
      visitorHash,
      createdAt,
      expiresAt,
      rules: {
        version: settings.version,
        termsVersion: settings.termsVersion,
        commissionRatePercent: settings.commissionRatePercent,
        minimumServiceSubtotal: settings.minimumServiceSubtotal,
        attributionWindowDays: settings.attributionWindowDays,
        completionDelayHours: settings.completionDelayHours
      },
      vendorCommitments
    });
  } catch (error) {
    if (error.code !== 11000 || !visitorHash) throw error;
    attribution = await ReferralAttribution.findOne({ visitorHash, status: 'active', expiresAt: { $gt: new Date() } });
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
    if (attribution) return { attribution, token };
  }
  if (visitorId) {
    const existing = await ReferralAttribution.findOne({
      visitorHash: hashToken(String(visitorId)),
      status: 'active',
      expiresAt: { $gt: new Date() }
    });
    if (existing) return { attribution: existing, token: null, preserved: true };
  }
  if (!code) return null;
  return createAttributionForCode(code, userId, visitorId);
};

module.exports = { hashToken, createAttributionForCode, resolveReferralAttribution };