const mongoose = require('mongoose');

const discountSchema = new mongoose.Schema({
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceListingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceListing',
    default: null
  },
  discountName: {
    type: String,
    required: true
  },
  discountType: {
    type: String,
    enum: ['Percentage', 'Fixed'], // Allow only these two types
    required: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  percentage: {
    type: Number,
    required() {
      return this.discountType === 'Percentage';
    }
  },
  maxDiscount: {
    type: Number,
    required: false
  },
  minAmountInCart: {
    type: Number,
    required: false
  },
  maxTotalUsage: {
    type: Number,
    required: false
  },
  discountCode: {     
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt fields
});

module.exports = mongoose.model('Discount', discountSchema);
