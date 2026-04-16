const { Schema, model } = require('mongoose');
const crypto = require('crypto');

const transactionSchema = new Schema({
  type: {
    type: String,
    enum: ['deposit', 'fundme_contribution', 'payment', 'refund'],
    required: true,
  },
  amount: { type: Number, required: true },
  description: { type: String, default: '' },
  stripePaymentIntentId: { type: String, default: null },
  // For fundme contributions
  contributorName: { type: String, default: null },
  contributorEmail: { type: String, default: null },
  // For payments (spending wallet on bookings)
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
  createdAt: { type: Date, default: Date.now },
});

const fundMeLinkSchema = new Schema({
  token: {
    type: String,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(24).toString('hex'),
  },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  targetAmount: { type: Number, required: true },
  amountRaised: { type: Number, default: 0 },
  // Link to cart items for the event
  cartItems: [{
    serviceId: { type: String },
    title: { type: String },
    checkIn: { type: Date },
    checkOut: { type: Date },
    guests: { type: Number, default: 1 },
    totalPrice: { type: Number },
  }],
  contributions: [{
    name: { type: String, required: true },
    email: { type: String, default: null },
    amount: { type: Number, required: true },
    message: { type: String, default: '' },
    stripePaymentIntentId: { type: String },
    paidAt: { type: Date, default: Date.now },
  }],
  isActive: { type: Boolean, default: true },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  },
  createdAt: { type: Date, default: Date.now },
});

const walletSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
    },
    transactions: [transactionSchema],
    fundMeLinks: [fundMeLinkSchema],
  },
  { timestamps: true }
);

module.exports = model('Wallet', walletSchema);
