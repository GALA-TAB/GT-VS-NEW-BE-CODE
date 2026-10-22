const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const { REFERRAL_REWARD_AMOUNT, MINIMUM_PLATFORM_FEE, REFERRAL_RULES_MODEL } = require('./referral-program');

const TERMS_VERSION = 'gala-tab-referral-2026-10-v2';

const DEFAULT_SETTINGS = {
  version: 1,
  termsVersion: TERMS_VERSION,
  enabled: true,
  rulesModel: REFERRAL_RULES_MODEL,
  rewardAmount: REFERRAL_REWARD_AMOUNT,
  minimumPlatformFee: MINIMUM_PLATFORM_FEE,
  attributionWindowDays: 30,
  completionDelayHours: 48,
  payoutsEnabled: false
};

// Settings saved under the earlier percentage-based rules are replaced by a new
// flat-fee version. Their window/delay/enabled/payout values carry over; the
// percentage and booking-total threshold do not.
const getCurrentSettings = async () => {
  const latest = await ReferralProgramSettings.findOne().sort({ version: -1 }).lean();
  if (!latest) return { ...DEFAULT_SETTINGS };
  if (latest.rulesModel === REFERRAL_RULES_MODEL) return latest;
  const migrated = {
    version: Number(latest.version || 0) + 1,
    termsVersion: TERMS_VERSION,
    enabled: latest.enabled !== false,
    rulesModel: REFERRAL_RULES_MODEL,
    rewardAmount: REFERRAL_REWARD_AMOUNT,
    minimumPlatformFee: MINIMUM_PLATFORM_FEE,
    attributionWindowDays: latest.attributionWindowDays || DEFAULT_SETTINGS.attributionWindowDays,
    completionDelayHours: latest.completionDelayHours ?? DEFAULT_SETTINGS.completionDelayHours,
    payoutsEnabled: Boolean(latest.payoutsEnabled),
    changeReason: 'Replaced percentage-based rewards with the flat platform-fee reward.'
  };
  try {
    return (await ReferralProgramSettings.create(migrated)).toObject();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return ReferralProgramSettings.findOne().sort({ version: -1 }).lean();
  }
};

const rewardOptionsFrom = (settings) => ({
  rewardAmount: settings?.rewardAmount ?? REFERRAL_REWARD_AMOUNT,
  minimumPlatformFee: settings?.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE
});

module.exports = { TERMS_VERSION, DEFAULT_SETTINGS, getCurrentSettings, rewardOptionsFrom };
