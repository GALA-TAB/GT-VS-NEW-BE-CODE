const mongoose = require('mongoose');

const { Schema } = mongoose;

const userSettingsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hasUserDeletedChat: { type: Boolean, default: false },
  lastChatDeletedAt: { type: Date, default: new Date(0) },
  isDeletedFrom2Reply: { type: Boolean, default: false },
});

const chatSchema = new Schema(
  {
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
      } 
    ],
    chatType: {
      type: String,
      enum: ['contact', 'service'],
    },
    chatName: {
      type: String,
    },
    chatPicture: {
      type: String,
    
    },
    isGroup: {
      type: Boolean,
      default: false
    },
    GroupcreatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: 'Message'
    },
    lastMessageSentAt: {
      type: Date
    },
    userSettings: [userSettingsSchema]
  },
  { timestamps: true, versionKey: false }
);

chatSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

chatSchema.index({ participants: 1 });
chatSchema.index({ lastMessageSentAt: 1 });

const Chat = mongoose.model('chats', chatSchema);

module.exports = Chat;
