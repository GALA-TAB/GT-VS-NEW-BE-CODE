// models/Log.js
const mongoose = require('mongoose');

const logSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'actorModel'
    },
    actorModel: {
      type: String,
      required: true,
      // 'admin' covers both admin & subAdmin — role is visible via populate
      enum: ['customer', 'vendor', 'admin']
    },
    action: {
      type: String,
      required: true // e.g. 'LOGIN', 'CREATE_BOOKING', 'DELETE_SERVICE', etc.
    },
    target: {
      type: String,
      default: null // e.g. 'Service', 'Booking', 'UserProfile', etc.
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    description: {
      type: String,
      default: null // Human-readable sentence: 'Logged in successfully'
    },
    ipAddress: {
      type: String,
      default: null
    }
  },
  { timestamps: true } // adds createdAt & updatedAt automatically
);

// Index for fast per-user queries and time-range queries
logSchema.index({ actorId: 1, createdAt: -1 });
logSchema.index({ createdAt: -1 });
logSchema.index({ action: 1 });

module.exports = mongoose.model('Log', logSchema);

