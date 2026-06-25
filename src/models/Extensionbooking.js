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
      enum: ['accept', 'reject', 'pending', 'cancelled'],
      default: 'pending'
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

module.exports = model('ExtensionBooking', ExtensionBookingSchema);
