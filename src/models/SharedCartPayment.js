const { Schema, model } = require('mongoose');
const crypto = require('crypto');

const sharedCartItemSchema = new Schema({
  serviceId: { type: String, required: true },
  title: { type: String, required: true },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  guests: { type: Number, default: 1 },
  totalPrice: { type: Number, required: true },
  servicePrice: [{ name: String, price: Number }],
  addOnServices: [{ name: String, price: Number }],
  couponCode: { type: String, default: null },
}, { _id: false });

const sharedCartPaymentSchema = new Schema(
  {
    token: {
      type: String,
      unique: true,
      index: true,
      default: () => crypto.randomBytes(24).toString('hex'),
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    cartItems: {
      type: [sharedCartItemSchema],
      required: true,
      validate: {
        validator: (v) => v.length > 0,
        message: 'At least one cart item is required',
      },
    },
    itemDiscounts: {
      type: Schema.Types.Mixed,
      default: {},
    },
    currency: {
      type: String,
      default: 'USD',
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    // Payment options
    allowPartialPayment: {
      type: Boolean,
      default: true,
    },
    minimumPartialPercent: {
      type: Number,
      default: 25,
      min: 1,
      max: 100,
    },
    // Payment tracking
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'partial', 'paid'],
      default: 'unpaid',
    },
    amountPaid: {
      type: Number,
      default: 0,
    },
    payments: [
      {
        paymentIntentId: String,
        amount: Number,
        paidAt: { type: Date, default: Date.now },
        payerEmail: String,
      },
    ],
    // Link settings
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    accessCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

sharedCartPaymentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('SharedCartPayment', sharedCartPaymentSchema);
