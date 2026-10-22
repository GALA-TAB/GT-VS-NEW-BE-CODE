const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const {
  REFERRAL_REWARD_PERCENT,
  REFERRAL_REWARD_CAP,
  MINIMUM_PLATFORM_FEE,
  REFERRAL_RULES_MODEL
} = require('./referral-program');

const TERMS_VERSION = 'gala-tab-referral-2026-10-v3';

const DEFAULT_SETTINGS = {
  version: 1,
  termsVersion: TERMS_VERSION,
  enabled: true,
  rulesModel: REFERRAL_RULES_MODEL,
  rewardPercent: REFERRAL_REWARD_PERCENT,
  rewardCap: REFERRAL_REWARD_CAP,
  minimumPlatformFee: MINIMUM_PLATFORM_FEE,
  attributionWindowDays: 30,
  completionDelayHours: 48,
  payoutsEnabled: false
};

// Settings saved under an earlier rule set (percentage of the service subtotal, or the
// fixed $50 reward) are replaced by a new version of the current rules. Their window,
// delay, enabled, and payout values carry over; the old reward rules do not.
const getCurrentSettings = async () => {
  const latest = await ReferralProgramSettings.findOne().sort({ version: -1 }).lean();
  if (!latest) return { ...DEFAULT_SETTINGS };
  if (latest.rulesModel === REFERRAL_RULES_MODEL) return latest;
  const migrated = {
    version: Number(latest.version || 0) + 1,
    termsVersion: TERMS_VERSION,
    enabled: latest.enabled !== false,
    rulesModel: REFERRAL_RULES_MODEL,
    rewardPercent: REFERRAL_REWARD_PERCENT,
    rewardCap: REFERRAL_REWARD_CAP,
    minimumPlatformFee: MINIMUM_PLATFORM_FEE,
    attributionWindowDays: latest.attributionWindowDays || DEFAULT_SETTINGS.attributionWindowDays,
    completionDelayHours: latest.completionDelayHours ?? DEFAULT_SETTINGS.completionDelayHours,
    payoutsEnabled: Boolean(latest.payoutsEnabled),
    changeReason: 'Replaced earlier reward rules with a percentage of the retained booking fee.'
  };
  try {
    return (await ReferralProgramSettings.create(migrated)).toObject();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return ReferralProgramSettings.findOne().sort({ version: -1 }).lean();
  }
};

const rewardOptionsFrom = (settings) => ({
  rewardPercent: settings?.rewardPercent ?? REFERRAL_REWARD_PERCENT,
  rewardCap: settings?.rewardCap ?? REFERRAL_REWARD_CAP,
  minimumPlatformFee: settings?.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE
});

module.exports = { TERMS_VERSION, DEFAULT_SETTINGS, getCurrentSettings, rewardOptionsFrom };
