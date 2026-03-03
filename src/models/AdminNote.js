const { Schema, model } = require('mongoose');

/**
 * AdminNote — permanent admin notes attached to a user/vendor.
 * Notes are NEVER deleted; they form a full audit trail visible
 * to any admin at any time.
 */
const adminNoteSchema = new Schema(
  {
    // The user this note is about (stored as String to support
    // both real ObjectIds and legacy mock IDs)
    targetUserId: {
      type: String,
      required: true,
      index: true,
    },
    targetName: {
      type: String,
      required: true,
    },
    targetRole: {
      type: String,
      enum: ['vendor', 'customer'],
      default: 'vendor',
    },

    // Note category
    type: {
      type: String,
      enum: ['protection', 'financial', 'general'],
      default: 'protection',
    },

    // The note text
    note: {
      type: String,
      required: true,
      maxlength: 2000,
    },

    // Which admin wrote this note
    addedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Denormalized name so it stays correct even if the admin is deleted
    addedByAdminName: {
      type: String,
      required: true,
    },
  },
  { timestamps: true } // createdAt = when the note was saved
);

// Fast look-up by user + newest first
adminNoteSchema.index({ targetUserId: 1, createdAt: -1 });
// Full-text search across name and note body
adminNoteSchema.index({ targetName: 'text', note: 'text' });

module.exports = model('AdminNote', adminNoteSchema);
