const mongoose = require('mongoose');

const verificationLogSchema = new mongoose.Schema(
  {
    serviceListingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceListing',
      required: true
    },
    serviceTitle: {
      type: String,
      default: null
    },
    previousStatus: {
      type: String,
      enum: ['verified', 'notVerified', 'pending', null],
      default: null
    },
    newStatus: {
      type: String,
      enum: ['verified', 'notVerified', 'pending'],
      required: true
    },
    changedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    changedByAdminName: {
      type: String,
      required: true
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    }
  },
  { timestamps: true }
);

verificationLogSchema.index({ serviceListingId: 1, createdAt: -1 });
verificationLogSchema.index({ changedByAdminId: 1, createdAt: -1 });
verificationLogSchema.index({ newStatus: 1, createdAt: -1 });

module.exports = mongoose.model('VerificationLog', verificationLogSchema);
