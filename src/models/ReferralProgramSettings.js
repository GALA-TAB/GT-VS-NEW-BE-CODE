const { Schema, model } = require('mongoose');

const referralProgramSettingsSchema = new Schema(
  {
    version: { type: Number, required: true, unique: true },
    termsVersion: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    rulesModel: { type: String, default: 'fee_percent_v4' },
    rewardPercent: { type: Number, required: true, min: 0, max: 100 },
    rewardCap: { type: Number, required: true, min: 0 },
    rewardAmount: { type: Number, default: null }, // fixed amount from the earlier flat-fee version
    minimumPlatformFee: { type: Number, default: 0, min: 0 }, // earlier versions only
    attributionWindowDays: { type: Number, required: true, min: 1, max: 90 },
    completionDelayHours: { type: Number, required: true, min: 0, max: 720 },
    payoutsEnabled: { type: Boolean, default: false },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    changeReason: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = model('ReferralProgramSettings', referralProgramSettingsSchema);