const { Schema, model } = require('mongoose');

const referralProgramSettingsSchema = new Schema(
  {
    version: { type: Number, required: true, unique: true },
    termsVersion: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    commissionRatePercent: { type: Number, required: true, min: 0, max: 100 },
    minimumServiceSubtotal: { type: Number, required: true, min: 0 },
    attributionWindowDays: { type: Number, required: true, min: 1, max: 90 },
    completionDelayHours: { type: Number, required: true, min: 0, max: 720 },
    payoutsEnabled: { type: Boolean, default: false },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    changeReason: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = model('ReferralProgramSettings', referralProgramSettingsSchema);