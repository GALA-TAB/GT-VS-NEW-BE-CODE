const { Schema, model } = require('mongoose');

const paymentSchema = new Schema(
  {
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    booking: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    systemFee: {
      type: Number,
      min: [0, 'System Fee must be positive'],
      default: 0
    },
    // ── Escrow Fields ──────────────────────────────────────────────
    // held      : funds captured, sitting on platform, dispute window open
    // released  : 72h passed, no dispute → transferred to vendor
    // disputed  : user filed a dispute within 72h → funds frozen
    // refunded  : full refund issued to customer (dispute resolved for customer / cancellation)
    // partial_refund: partial refund to customer, remainder transferred to vendor
    // completed : legacy status kept for backwards compat
    escrowStatus: {
      type: String,
      enum: ['held', 'released', 'disputed', 'refunded', 'partial_refund', 'pending', 'completed'],
      default: 'held'
    },
    // When the 72-hour dispute window closes and funds auto-release to vendor
    escrowReleaseAt: {
      type: Date,
      default: null
    },
    // Stripe transfer ID once funds are released to vendor
    stripeTransferId: {
      type: String,
      trim: true,
      default: null
    },
    // Stripe charge ID (from payment intent)
    stripeChargeId: {
      type: String,
      trim: true,
      default: null
    },
    // Stripe refund ID(s) — comma-separated if multiple
    stripeRefundId: {
      type: String,
      trim: true,
      default: null
    },
    // Legacy field – kept for backwards compatibility
    status: {
      type: String,
      enum: ['pending', 'completed'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

// Index for efficient escrow release queries
paymentSchema.index({ escrowStatus: 1, escrowReleaseAt: 1 });

module.exports = model('Payments', paymentSchema);
