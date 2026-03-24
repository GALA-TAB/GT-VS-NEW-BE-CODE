const { Schema, model } = require('mongoose');

const KYCDocumentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sessionToken: { type: String },
  documentType: {
    type: String,
    enum: ['national_id', 'passport', 'driver_license'],
    required: true
  },
  frontImageUrl: { type: String, required: true },
  backImageUrl: { type: String, required: true },
  selfieImageUrl: { type: String },
  status: {
    type: String,
    enum: ['pending', "inprogress", 'abandoned', 'expired', "resubmission_requested", "approved"],
    default: 'inprogress'
  },
  rejectionReason: { type: String },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  country: {
    type: String,
    trim: true
  },
  archivedDocuments: [
    {
      frontImageUrl: { type: String },
      backImageUrl: { type: String },
      selfieImageUrl: { type: String },
      documentType: { type: String },
      status: { type: String },
      archivedAt: { type: Date, default: Date.now }
    }
  ],
  uploadedAt: { type: Date, default: Date.now }
});

module.exports = model('KYCDocument', KYCDocumentSchema);
