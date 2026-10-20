const { Schema, model } = require('mongoose');

const stripeWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    status: { type: String, enum: ['processing', 'processed', 'failed'], default: 'processing', index: true },
    processingStartedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = model('StripeWebhookEvent', stripeWebhookEventSchema);