const { Schema, model } = require('mongoose');

const BookingSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true // Index for faster lookup
    },
    service: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceListing',
      required: true,
      index: true
    },
    checkIn: {
      type: Date,
      required: true
    },
    checkOut: {
      type: Date,
      required: true
    },
    guests: {
      type: Number,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: [0, 'Total price must be positive']
    },
    paymentStatus: {
      type: Boolean,
      default: false
    },
    paymentIntentId: {
      type: String,
      trim: true,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'booked', 'canceled', 'completed', 'rejected'],
      default: 'pending'
    },
    isDeleted: {
      type: Boolean,
      default: false
    },
    bookingResponseTime: {
      type: Date,
      default: null
    },
    cancelRequest: {
      type: Boolean,
      default: false
    },
    cancelReason: {
      type: String,
      trim: true
    },
    // ── Escrow / Dispute Fields ────────────────────────────────────
    // Timestamp when the 72-hour dispute window closes (set when booking completes)
    escrowReleaseAt: {
      type: Date,
      default: null
    },
    // Whether an active dispute has been filed by the customer
    inDispute: {
      type: Boolean,
      default: false
    },
    disputeReason: {
      type: String,
      trim: true,
      default: null
    },
    disputeFiledAt: {
      type: Date,
      default: null
    },
    disputeResolvedAt: {
      type: Date,
      default: null
    },
    // 'refunded' | 'partial_refund' | 'released' – set when admin resolves
    disputeResolution: {
      type: String,
      enum: ['refunded', 'partial_refund', 'released', null],
      default: null
    },
    servicePrice: [
      {
        name: {
          type: String
        },
        price: {
          type: Number,
          required: true
        }
      }
    ]
  },
  { timestamps: true }
);

// Index for sorting and filtering bookings efficiently
BookingSchema.index({
  user: 1,
  service: 1,
  status: 1,
  guests: 1,
  checkIn: 1,
  checkOut: 1,
  totalPrice: 1
});
BookingSchema.index({ createdAt: -1 }); // Index for sorting by creation date

module.exports = model('Booking', BookingSchema);
