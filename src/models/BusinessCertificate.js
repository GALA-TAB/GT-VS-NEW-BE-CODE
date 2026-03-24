const { Schema, model } = require('mongoose');

const BusinessCertificateSchema = new Schema(
  {
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    businessName: {
      type: String,
      trim: true
    },
    documentUrl: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'inprogress'],
      default: 'pending'
    },
    rejectionNote: {
      type: String,
      trim: true
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    archivedDocuments: [
      {
        documentUrl: { type: String },
        status: { type: String },
        archivedAt: { type: Date, default: Date.now }
      }
    ],
    isDeleted: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

module.exports = model('BusinessCertificate', BusinessCertificateSchema);
