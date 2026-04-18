const { Schema, model } = require("mongoose");

const BookingAgreementSchema = new Schema(
  {
    booking: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    service: {
      type: Schema.Types.ObjectId,
      ref: "ServiceListing",
      required: true,
    },
    vendor: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    // Signature data (base64 images from canvas)
    signatureImage: {
      type: String,
      required: true,
    },
    initialsImage: {
      type: String,
      required: true,
    },

    // Government-issued ID images (base64)
    idFrontImage: {
      type: String,
    },
    idBackImage: {
      type: String,
    },

    // Agreement snapshot — what the customer agreed to at the time of booking
    agreementSnapshot: {
      serviceName: String,
      vendorName: String,
      checkIn: String,
      checkOut: String,
      guests: Number,
      totalPrice: Number,
      addOnServices: [
        {
          name: String,
          price: Number,
          selectedQuantity: Number,
        },
      ],
      discountValue: Number,
      cancellationPolicy: String,
      vendorRules: String,
      paymentMethod: {
        type: String,
        enum: ["card", "wallet"],
      },
    },

    // Terms version for audit trail
    termsVersion: {
      type: String,
      default: "1.0",
    },

    // IP and device info for legal validity
    ipAddress: String,
    userAgent: String,

    // Timestamp of when customer signed
    signedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for quick lookups
BookingAgreementSchema.index({ booking: 1, user: 1 });
BookingAgreementSchema.index({ signedAt: -1 });

module.exports = model("BookingAgreement", BookingAgreementSchema);
