const { Schema, model } = require('mongoose');

/**
 * Holds signup form data for an account that has NOT yet verified its email
 * or phone number. No record is created in the real Users collection until
 * OTP verification succeeds (see verifySignupEmailOtp / verifySignupPhoneOtp
 * in authController.js) — this is what keeps unverified signups from
 * occupying a real account slot / blocking the email or contact number from
 * being reused.
 *
 * `password` is stored already bcrypt-hashed (never plain text), and is
 * carried over as-is when the real account is created.
 *
 * The `createdAt` TTL index automatically removes abandoned signups after
 * one hour so stale pending records don't accumulate.
 */
const pendingRegistrationSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  contact: { type: String, required: true, trim: true },
  countryCode: { type: String, trim: true },
  countryName: { type: String, trim: true },
  password: { type: String, required: true },
  role: { type: String, required: true },
  providers: { type: [String], default: ['local'] },
  OTP: { type: String },
  otpExpiration: { type: Number },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 // auto-delete after 1 hour if never verified
  }
});

module.exports = model('PendingRegistration', pendingRegistrationSchema);
