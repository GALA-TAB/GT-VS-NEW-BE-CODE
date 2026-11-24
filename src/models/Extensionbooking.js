const { Schema, model } = require('mongoose');

const ExtensionBookingSchema = new Schema(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking'
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    requestBy: {
     type: Schema.Types.ObjectId,
      ref: 'User'
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    endDate: {
      type: Date,
      required: true,
      trim: true
    },
    startDate: {
      type: Date,
      required: true,
      trim: true
    },
    newChargeAmount: {
      type: Number,
      required: true,
      trim: true
    },
    totalAmount: {
      type: Number,
      required: true,
      trim: true
    },
    paymentIntentId: {
      type: String,
      trim: true
    },
    request: {
      type: String,
      // processing is a short internal lock held while the payment for an accepted request is handled
      enum: ['accept', 'reject', 'pending', 'cancelled', 'expired', 'processing'],
      default: 'pending'
    },
    // Pending requests auto-expire (and any card hold is released) after this time
    expiresAt: {
      type: Date,
      default: null
    },
    // none: no money moves | authorized: card hold placed | captured: charged
    // released: hold released | refunded: price decrease refunded | failed: charge/refund failed
    paymentStatus: {
      type: String,
      enum: ['none', 'authorized', 'captured', 'released', 'refunded', 'failed'],
      default: 'none'
    },
    // Amount returned to the customer when the change lowers the booking total
    refundAmount: {
      type: Number,
      default: 0
    },
    rejectReason: {
      type: String,
      trim: true,
      default: ''
    },
    // The booking as it was when this request was priced; used to refuse a stale accept
    baseline: {
      checkIn: { type: Date },
      checkOut: { type: Date },
      totalPrice: { type: Number }
    },
    // What the requester agreed to when submitting the change
    consent: {
      amount: { type: Number },
      termsVersion: { type: String, trim: true },
      acceptedAt: { type: Date }
    },
    servicePrice: [
      {
        name: {
          type: String
        },
        price: {
          type: Number,
          required: true
        },
        description: {
          type: String,
          trim: true
        },
        pricingType: {
          type: String,
          enum: ['flat', 'quantity'],
          default: 'flat'
        },
        selectedQuantity: {
          type: Number,
          default: 1
        }
      }
    ]
  },
  { timestamps: true }
);

module.exports = model('ExtensionBooking', ExtensionBookingSchema);
