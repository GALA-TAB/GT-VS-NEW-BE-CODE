const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const {
  REFERRAL_REWARD_PERCENT,
  REFERRAL_REWARD_CAP,
  REFERRAL_RULES_MODEL
} = require('./referral-program');

const TERMS_VERSION = 'gala-tab-referral-2026-10-v4';

const DEFAULT_SETTINGS = {
  version: 1,
  termsVersion: TERMS_VERSION,
  enabled: true,
  rulesModel: REFERRAL_RULES_MODEL,
  rewardPercent: REFERRAL_REWARD_PERCENT,
  rewardCap: REFERRAL_REWARD_CAP,
  attributionWindowDays: 30,
  completionDelayHours: 48,
  payoutsEnabled: false
};

// Settings saved under an earlier rule set (service-subtotal percentage, fixed $50, or the
// $500-minimum fee percentage) are replaced by a new version of the current rules the first
// time they are read. Their window, delay, enabled, and payout values carry over. Rewards
// already created keep the rules recorded on them; only new bookings follow these settings.
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
      attributionWindowDays: latest.attributionWindowDays || DEFAULT_SETTINGS.attributionWindowDays,
    completionDelayHours: latest.completionDelayHours ?? DEFAULT_SETTINGS.completionDelayHours,
    payoutsEnabled: Boolean(latest.payoutsEnabled),
    changeReason: 'Updated program: 10% of the retained booking fee up to $250 per referred customer, no minimum fee, 0% fee bookings excluded.'
  };
  try {
    return (await ReferralProgramSettings.create(migrated)).toObject();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return ReferralProgramSettings.findOne().sort({ version: -1 }).lean();
  }
};

// The reward percentage and cap are fixed program terms, not tunable settings.
const rewardOptionsFrom = () => ({
  rewardPercent: REFERRAL_REWARD_PERCENT,
  rewardCap: REFERRAL_REWARD_CAP
});

module.exports = { TERMS_VERSION, DEFAULT_SETTINGS, getCurrentSettings, rewardOptionsFrom };
