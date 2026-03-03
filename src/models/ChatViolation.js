const { Schema, model } = require('mongoose');

const chatViolationSchema = new Schema(
  {
    // Who sent the blocked message
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    senderName: { type: String, default: '' },
    senderEmail: { type: String, default: '' },
    senderRole: {
      type: String,
      enum: ['customer', 'vendor', 'admin', 'staff'],
      default: 'customer',
    },

    // Who the message was addressed to
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    recipientName: { type: String, default: '' },
    recipientRole: {
      type: String,
      enum: ['customer', 'vendor', 'admin', 'staff', ''],
      default: '',
    },

    // Chat context
    chatId: { type: String, default: '' },

    // The flagged message (truncated at 300 chars)
    messageExcerpt: {
      type: String,
      maxlength: 300,
      required: true,
    },

    // Detection info
    detectionType: {
      type: String,
      enum: ['phone', 'email', 'address', 'social', 'off_platform', 'profanity', 'external_contact', 'other'],
      required: true,
    },
    detectionLabel: { type: String, required: true }, // Human-readable, e.g. "Phone Number"

    // Admin review
    status: {
      type: String,
      enum: ['blocked', 'warned', 'restricted', 'cooldown', 'reviewed', 'dismissed'],
      default: 'blocked',
    },
    actionTaken: { type: String, default: 'Message blocked' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    adminNote: { type: String, default: '' },
  },
  { timestamps: true }
);

// Index for quick admin queries
chatViolationSchema.index({ senderId: 1, createdAt: -1 });
chatViolationSchema.index({ detectionType: 1 });
chatViolationSchema.index({ status: 1 });

module.exports = model('ChatViolation', chatViolationSchema);
