const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const moment = require('moment');
const { promisify } = require('util');
const { connectDB } = require('../config/connectDb');
const Messages = require('../models/chat/Message');
const Chats = require('../models/chat/Chat');
const Users = require('../models/users/User');
const Reactions = require('../models/chat/Reaction');
// const SpamUsers = require('../models/spamUsers');

const defaultImage =
  'https://images.icon-icons.com/1993/PNG/512/account_avatar_face_man_people_profile_user_icon_123197.png';
const { ObjectId } = require('mongoose').Types;
// const { getMessaging } = require("firebase-admin/messaging");
const User = require('../models/users/User');
const Bookings = require('../models/Bookings');
const Notification = require('../models/Notification');


module.exports = {
  authMiddleWareSocket: async (socket, next) => {
    try {
      // Wait for MongoDB to be ready (handles Render cold-start delays)
      // Poll up to 10 times × 2s = 20s before giving up
      if (mongoose.connection.readyState !== 1) {
        const MAX_ATTEMPTS = 10;
        const RETRY_DELAY_MS = 2000;
        let connected = false;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          try {
            await connectDB();
            if (mongoose.connection.readyState === 1) {
              connected = true;
              break;
            }
          } catch (_) { /* will retry */ }
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        if (!connected) {
          console.error('Socket auth: DB not ready after retries');
          return next(new Error('Server is starting up. Please try again in a moment.'));
        }
      }

      const authorization = socket.handshake.auth.token;
      if (!authorization) {
        return next(new Error('You must be logged in'));
      }
      const decoded = await promisify(jwt.verify)(authorization, process.env.JWT_SECRET);
      const currentUser = decoded?.user;
      if (!currentUser) {
        return next(new Error('Invalid token.'));
      }
      const user = await User.findById(currentUser._id);
      if (!user) {
        return next(new Error('User not found.'));
      }
      console.log(user.fullName);
      if (user?.role === 'admin') {
        const adminUser = await User.findOne({ adminRole: 'admin' });
        socket.user = adminUser;
        socket.staff = user?.adminRole === 'subAdmin' ? user : undefined;
        socket.subAdmin = user;
      } else if (user.vendorRole === 'staff' || user.customerRole === 'staff') {
        const findVendor = await User.findById(user.staffOf);
        if (findVendor && findVendor?.status === 'Delete') {
          return next(
            new AppError('This account deleted by Admin. Please contact with Admin', 404)
          );
        }
        socket.staff = user;
        socket.user = findVendor;
      } else {
        socket.user = user;
      }

      next();
    } catch (error) {
      console.error('JWT decoding error:', error.message);
      return next(new Error(error.message || 'Authentication error'));
    }
  },
  getUserNotifications: async (params) => {
    try {
      const { userId, pageNo = 1, recordsPerPage = 10 } = params;
      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const notifications = await Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skipDocuments)
        .limit(recordsPerPage);

      if (!notifications) {
        throw new Error('User not found.');
      }

      return notifications;
    } catch (error) {
      console.error('JWT decoding error:', error.message);
      throw new Error(error.message || 'Authentication error');
    }
  },
  getUserUnreadNotifications: async (params) => {
    try {
      const { userId, search } = params;
      const match = { userId: new mongoose.Types.ObjectId(userId) };
      const pipeline = [
        { $match: match },
        // only unread notifications if your schema has `isRead` or `readAt`
        {
          $match: {
            $or: [{ isRead: false }, { isRead: { $exists: false } }]
          }
        }
      ];

      // optional text search across common fields
      if (search) {
        const regex = new RegExp(search, 'i');
        pipeline.push({
          $match: {
            $or: [{ title: regex }, { body: regex }, { message: regex }, { type: regex }]
          }
        });
      }

      // sort / project as required
      pipeline.push({ $sort: { createdAt: -1 } });

      const notifications = await Notification.aggregate(pipeline);
      if (notifications.length === 0) {
        throw new Error('No unread notifications found.');
      }
      return notifications;
    } catch (error) {
      console.error('JWT decoding error:', error.message);
      throw new Error(error.message || 'Authentication error');
    }
  },

  readUserNotifications: async (params) => {
    try {
      const { userId } = params;

      await Notification.deleteMany({ userId: userId });
      return true;
    } catch (error) {
      console.error('JWT decoding error:', error.message);

      return false;
    }
  },
  fetchUnseenChats: async (params) => {
    try {
      const { userId, pageNo = 1, recordsPerPage = 10 } = params;
      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const documentsLimit = recordsPerPage;
      const userChatIds = await Chats.find({
        participants: new ObjectId(userId),
        notStarted: false,
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $and: [
                  {
                    $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
                  }
                ]
              }
            }
          }
        ]
      }).distinct('_id');

      const unseenChats = await Messages.find({
        chat: { $in: userChatIds },
        $or: [
          { userSettings: { $exists: false } },
          { userSettings: { $size: 0 } },
          {
            userSettings: {
              $not: {
                $elemMatch: {
                  userId: userId
                }
              }
            }
          },
          {
            userSettings: {
              $elemMatch: {
                userId: { $eq: userId },
                $or: [{ readAt: { $exists: false } }, { readAt: null }]
              }
            }
          }
        ]
      }).distinct('chat');
      const allUnseenChats = await Chats.find({ _id: { $in: unseenChats } });

      let chats = await Chats.aggregate([
        { $match: { _id: { $in: unseenChats.map((id) => new ObjectId(id)) } } },
        {
          $addFields: {
            matchingPinnedAt: {
              $let: {
                vars: {
                  matchingUserSetting: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: '$userSettings',
                          as: 'setting',
                          cond: { $eq: ['$$setting.userId', new ObjectId(userId)] }
                        }
                      },
                      0
                    ]
                  }
                }
              }
            }
          }
        },
        {
          $addFields: {
            sortPriority: {
              $ifNull: ['$lastMessageSentAt', new Date(0)]
            }
          }
        },
        { $sort: { sortPriority: -1 } },
        { $skip: skipDocuments },
        { $limit: documentsLimit },
        {
          $lookup: {
            from: 'users',
            localField: 'participants',
            foreignField: '_id',
            as: 'participants'
          }
        },
        {
          $lookup: {
            from: 'messages',
            localField: 'lastMessage',
            foreignField: '_id',
            as: 'lastMessage'
          }
        },
        {
          $unwind: {
            path: '$lastMessage',
            preserveNullAndEmptyArrays: true
          }
        }
      ]);

      if (chats?.length) {
        chats = await Promise.all(
          chats?.map(async (chat) => {
            const unreadCount = await Messages.countDocuments({
              chat: { $in: chat?._id },
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: userId } },
                {
                  userSettings: {
                    $elemMatch: {
                      userId: userId,
                      $or: [{ readAt: null }, { readAt: { $exists: false } }]
                    }
                  }
                }
              ]
            });
            console.log(
              'chat?.participants?.find(participant => participant._id !== userId)[0]?.Username',
              chat?.participants?.find(
                (participant) => participant._id?.toString() !== userId?.toString()
              )?.Username
            );
            const userSettings = chat?.userSettings?.find(
              (setting) => setting?.userId?.toString?.() === userId?.toString?.()
            );
            const displayPicture =
              chat?.participants?.find(
                (participant) => participant?._id?.toString?.() !== userId?.toString?.()
              )?.profilePicture ?? defaultImage;
            const receiverId = chat?.participants
              ?.find((participant) => participant?._id.toString() !== userId)
              ?._id.toString();
            const messageDeliveryStatus = module.exports.msgDeliveryStatus({ userId, chat }) || {};
            const chatDisplayInfo = {
              chatId: chat?._id,
              chatName:
                chat?.groupName ||
                chat?.participants?.find(
                  (participant) => participant?._id?.toString?.() !== userId?.toString?.()
                )?.fullName,
              displayPicture,
              latestMessage: chat?.lastMessage?.content,
              latestMessageId: chat?.lastMessage?._id,
              latestMessageType: chat?.lastMessage?.contentType,
              contentDescriptionType: chat?.lastMessage?.contentDescriptionType ?? 'text',
              fileSize: chat?.lastMessage?.fileSize ?? '',
              latestMessageSentAt: chat?.lastMessageSentAt ?? chat?.lastMessage?.createdAt,
              latestMessageTitle: chat?.lastMessage?.title ?? '',
              latestMessageDescription: chat?.lastMessage?.description ?? '',

              unreadCount: unreadCount || 0,
              receiverId,
              ...(Object.keys(messageDeliveryStatus || {})?.length && { ...messageDeliveryStatus })
            };
            return chatDisplayInfo;
          })
        );

        chats = chats?.sort((a, b) => b?.pinnedAt - a?.pinnedAt);
      }
      const allUnseenChatIds = allUnseenChats?.map((chat) => chat?._id);
      module.exports.updateDeliveredAt({ chatIds: allUnseenChatIds, userId });
      const response = {
        pageNo,
        recordsPerPage,
        totalRecords: unseenChats?.length,
        chats
      };
      return response;
    } catch (error) {
      console.error('Error fetching unseen chats:'.red.bold, error?.stack);
      return [];
    }
  },
  updateDeliveredAt: async (params) => {
    try {
      const { chatIds, userId } = params;

      // Update existing entries
      await Messages.updateMany(
        {
          chat: { $in: chatIds },
          sender: { $ne: userId },
          'alert_result.isAllowed': { $ne: 'False' }, // FIXED
          userSettings: {
            $elemMatch: {
              userId: userId,
              $or: [{ deliveredAt: { $exists: false } }, { deliveredAt: null }]
            }
          }
        },
        {
          $set: { 'userSettings.$.deliveredAt': new Date() }
        }
      );

      // Add new userSettings entry if none exist
      await Messages.updateMany(
        {
          chat: { $in: chatIds },
          sender: { $ne: userId },
          'alert_result.isAllowed': { $ne: 'False' }, // FIXED
          'userSettings.userId': { $ne: userId } // FIXED condition
        },
        {
          $push: {
            userSettings: {
              userId: userId,
              deliveredAt: new Date()
            }
          }
        }
      );
    } catch (error) {
      console.log(`Got error in [updateDeliveredAt] for userId ${params?.userId}: ${error?.stack}`);
    }
  },
  updateReadAt: async (params) => {
    try {
      const { chatId, userId, messageIds } = params;
      console.log(`updateReadAt called with params ${JSON.stringify(params)}`);

      // Update existing entries
      const updatedMessagesResponse = await Messages.updateMany(
        {
          _id: { $in: messageIds },
          chat: chatId,
          'alert_result.isAllowed': { $ne: 'False' }, // FIXED
          userSettings: {
            $elemMatch: {
              userId: userId,
              $or: [{ readAt: { $exists: false } }, { readAt: null }]
            }
          }
        },
        {
          $set: { 'userSettings.$.readAt': new Date() }
        }
      );

      console.log(`Got updatedMessagesResponse: ${JSON.stringify(updatedMessagesResponse)}`);

      // Add new userSetting entry if user does not exist in array
      const newEntryResponse = await Messages.updateMany(
        {
          _id: { $in: messageIds },
          chat: chatId,
          'alert_result.isAllowed': { $ne: 'False' }, // FIXED
          'userSettings.userId': { $ne: userId } // FIXED (correct check)
        },
        {
          $push: {
            userSettings: {
              userId: userId,
              readAt: new Date(),
              deliveredAt: new Date()
            }
          }
        }
      );

      console.log(`Got newEntryResponse: ${JSON.stringify(newEntryResponse)}`);

      return { success: true };
    } catch (error) {
      console.log(`Got error in [updateReadAt] for userId ${params?.userId}: ${error?.stack}`);
      return { success: false };
    }
  },

  fetchUserChats: async (params) => {
    try {
      console.log(`fetchUserChats util called with params ${JSON.stringify(params)}`);
      const { userId, pageNo = 1, recordsPerPage = 10, others = false, chatType, search } = params;
      console.log('others', others);
      console.log('userId', userId);
      let a = JSON.parse(others || false) ? false : true;
      console.log('a', a);
      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const documentsLimit = recordsPerPage;
      const userChatIds = await Chats.find({
        // ...(chatType ? { chatType } : {}),
        participants: new ObjectId(userId),
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                // isChatWithContact: true,
                // movedToOthers: { $ne: true },
                $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
              }
            }
          }
        ]
      }).distinct('_id');

      console.log('userChatIds', userChatIds);
      let chats = await Chats.find({ _id: { $in: userChatIds } })
        .populate('participants')
        .populate({ path: 'lastMessage', model: Messages })
        .sort({ lastMessageSentAt: -1 });

      console.log('these are chats for users', chats);

      // Apply search filter if searchQuery is provided
      if (search && search.trim() !== '') {
        const searchRegex = new RegExp(search, 'i');
        chats = chats.filter((chat) => {
          // Search in chat name
          const chatName =
            chat?.chatName ||
            chat?.participants?.find(
              (participant) => participant?._id?.toString?.() !== userId?.toString?.()
            )?.fullName;
          const chatNameMatch = chatName && searchRegex.test(chatName);

          // Search in participant names
          const participantMatch = chat?.participants?.some((participant) => {
            const fullName = participant?.fullName || '';
            const firstName = participant?.firstName || '';
            const lastName = participant?.lastName || '';
            return (
              searchRegex.test(fullName) ||
              searchRegex.test(firstName) ||
              searchRegex.test(lastName)
            );
          });

          return chatNameMatch || participantMatch;
        });

        // Re-sort after filtering to maintain lastMessageSentAt order
        chats.sort((a, b) => {
          const dateA = a.lastMessageSentAt ? new Date(a.lastMessageSentAt) : new Date(0);
          const dateB = b.lastMessageSentAt ? new Date(b.lastMessageSentAt) : new Date(0);
          return dateB - dateA; // Descending order (newest first)
        });
      }

      // Get total after search filter
      const totalRecords = chats.length;

      // Apply pagination after search
      chats = chats.slice(skipDocuments, skipDocuments + documentsLimit);

      if (chats?.length) {
        chats = await Promise.all(
          chats?.map(async (chat) => {
            const unreadCount = await Messages.countDocuments({
              chat: { $in: chat?._id },
              'alert_result.isAllowed': { $ne: 'False' }, // FIXED
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: userId } },
                {
                  userSettings: {
                    $elemMatch: {
                      userId: userId,
                      $or: [{ readAt: null }, { readAt: { $exists: false } }]
                    }
                  }
                }
              ]
            });
            const displayPicture = chat?.chatPicture
              ? chat?.chatPicture
              : (chat?.participants?.find(
                  (participant) => participant?._id?.toString?.() != userId?.toString?.()
                )?.profilePicture || defaultImage);
            const messageDeliveryStatus = module.exports.msgDeliveryStatus({ userId, chat }) || {};
            const chatDisplayInfo = {
              chatId: chat?._id,
              chatType: chat?.chatType,
              isGroup: chat?.isGroup ?? false,
              GroupcreatedBy: chat?.GroupcreatedBy,
              participants:
                chat?.participants.map((participant) => ({
                  userId: participant?._id,
                  fullName: participant?.fullName,
                  profilePicture: participant?.profilePicture || defaultImage
                })) ?? [],
              chatName:
                chat?.chatName ||
                chat?.participants?.find(
                  (participant) => participant?._id?.toString?.() !== userId?.toString?.()
                )?.fullName,
              displayPicture,
              latestMessage: chat?.lastMessage?.content,
              latestMessageId: chat?.lastMessage?._id,
              latestMessageType: chat?.lastMessage?.contentType,
              contentDescriptionType: chat?.lastMessage?.contentDescriptionType ?? 'text',
              fileSize: chat?.lastMessage?.fileSize ?? '',
              latestMessageSentAt: chat?.lastMessageSentAt ?? chat?.lastMessage?.createdAt,
              latestMessageTitle: chat?.lastMessage?.title ?? '',
              latestMessageDescription: chat?.lastMessage?.description ?? '',
              unreadCount: unreadCount || 0,
              ...(Object.keys(messageDeliveryStatus || {})?.length && { ...messageDeliveryStatus })
            };
            return chatDisplayInfo;
          })
        );
      }
      const response = {
        pageNo,
        recordsPerPage,
        totalRecords,
        chats
      };
      return response;
    } catch (error) {
      console.log('error', error);
      console.log(`Got error in fetchUserChats for user ${params?.userId}: ${error.message}`);
      return [];
    }
  },

  fetchChatMessages: async (params) => {
    try {
      const { chatId, userId, bookingId, pageNo = 1, recordsPerPage = 20 } = params;
      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const documentsLimit = recordsPerPage;
      const messagesQuery = {
        chat: chatId,
        $or: [
          {
            userSettings: {
              $not: {
                $elemMatch: {
                  userId: userId,
                  deletedAt: { $exists: true }
                }
              }
            },
            'alert_result.isAllowed': { $ne: 'False' } // FIXED
          },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                deletedAt: null
              }
            }
          }
        ]
      };

      if (bookingId) {
        messagesQuery.bookingId = bookingId;
      }
      console.log('messagesQuery', messagesQuery);

      const totalRecords = await Messages.countDocuments(messagesQuery);
      let messages = await Messages.find(messagesQuery)
        .populate('sender', '_id lastName firstName fullName profilePicture')
        .populate('staff', '_id lastName firstName fullName profilePicture staffRole')
        .sort({ createdAt: -1 })
        .skip(skipDocuments)
        .limit(documentsLimit);

      const chatData = await Chats.findById(chatId);
      messages = messages?.map((message) => {
        const otherUserSettings = message?.userSettings?.find(
          (setting) => setting?.userId?.toString?.() !== userId?.toString?.()
        );
        return {
          bookingId: message?.bookingId,
          chatId: message?.chat,
          messageId: message?._id,
          sender: message?.sender,
          content: message?.content,
          contentType: message?.contentType,
          contentTitle: message?.contentTitle,
          fileSize: message?.fileSize ?? '',
          contentDescription: message?.contentDescription ?? '',
          contentDescriptionType: message?.contentDescriptionType ?? 'text',
          editedAt: message?.editedAt ?? null,
          reactionCounts: message?.reactionsCount,
          latestMessageSentAt: message?.createdAt,
          isRead: otherUserSettings?.readAt ? true : false,
          isDelivered: otherUserSettings?.deliveredAt ? true : false,
          alert_result: message?.alert_result,
          receiverId: chatData?.participants?.find(
            (participant) => participant?.toString?.() !== message?.sender?._id?.toString?.()
          ),
          userSettings: message?.userSettings,
          staff: message?.staff
            ? {
                _id: message?.staff?._id,
                name: message?.staff?.fullName,
                profilePicture: message?.staff?.profilePicture ?? defaultImage,
                staffRole: message?.staff?.staffRole
              }
            : undefined
        };
      });

      const unreadCount = await Messages.countDocuments({
        chat: { $in: chatId },
        bookingId: {
          $ne: bookingId
        },

        'alert_result.isAllowed': { $ne: 'False' }, // FIXED
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $or: [{ readAt: null }, { readAt: { $exists: false } }]
              }
            }
          }
        ]
      });
      const messageIds = messages?.map((message) => message?.messageId);
      module.exports.updateReadAt({ chatId, userId, messageIds });
      return {
        pageNo: 1,
        recordsPerPage: 20,
        totalRecords,
        messages,
        unreadCount: unreadCount || 0
      };
    } catch (error) {
      console.error('Error fetching chat messages:', error.message);
      return {
        messages: [],
        pageNo: 1,
        recordsPerPage: 20
      };
    }
  },
  fetchChatBookings: async (params) => {
    try {
      const { user, receiverId } = params;

      let customerId;
      let vendorId;
      if (user.role === 'customer') {
        customerId = user?._id;
        vendorId = receiverId;
      } else {
        vendorId = user?._id;
        customerId = receiverId;
      }

      const query = [
        {
          $match: {
            user: new mongoose.Types.ObjectId(customerId)
          }
        },
        {
          $lookup: {
            from: 'servicelistings',
            localField: 'service',
            foreignField: '_id',
            as: 'servicedetail'
          }
        },
        {
          $unwind: { path: '$servicedetail', preserveNullAndEmptyArrays: true }
        },
        {
          $match: {
            'servicedetail.vendorId': new mongoose.Types.ObjectId(vendorId)
          }
        }
      ];

      console.log('query', query);

      const result = await Bookings.aggregate(query);
      
      // Find the chat between customer and vendor
      const chat = await Chats.findOne({
        participants: { $all: [new mongoose.Types.ObjectId(customerId), new mongoose.Types.ObjectId(vendorId)], $size: 2 },
        isGroup: false
      });

      // If chat exists, calculate unreadCount for each booking
      if (chat && result?.length) {
        const userId = new mongoose.Types.ObjectId(user._id);
        const bookingsWithUnreadCount = await Promise.all(
          result.map(async (booking) => {
            const unreadCount = await Messages.countDocuments({
              chat: chat._id,
              bookingId: booking._id,
              sender: { $ne: userId },
              'alert_result.isAllowed': { $ne: 'False' },
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: userId } },
                {
                  userSettings: {
                    $elemMatch: {
                      userId: userId,
                      $or: [{ readAt: null }, { readAt: { $exists: false } }]
                    }
                  }
                }
              ]
            });
            return {
              ...booking,
              unreadCount: unreadCount || 0
            };
          })
        );
        return {
          bookings: bookingsWithUnreadCount
        };
      }

      // If no chat exists, return bookings with unreadCount 0
      const bookingsWithUnreadCount = result.map((booking) => ({
        ...booking,
        unreadCount: 0
      }));

      return {
        bookings: bookingsWithUnreadCount
      };
    } catch (error) {
      console.error('Error fetching chat bookings:', error.message);
      return {
        // pageNo,
        // recordsPerPage,
        totalRecords: 0,
        totalPages: 0,
        bookings: []
      };
    }
  },

  sendMessage: async (params) => {
    try {
      const { chatId, senderId, content, contentType } = params;
      const messageBody = {
        chat: chatId,
        sender: senderId,
        content,
        contentType
      };
      console.log('Creating message with body:', messageBody);
      const newMessage = await Messages.create(messageBody);
      console.log('Got response of send message in [sendMessage', newMessage);
      if (newMessage) {
        console.log(
          `Going to update last message in chat ${chatId} with messageId ${newMessage._id}`
        );
        const chatUpdated = await Chats.findByIdAndUpdate(
          chatId,
          { lastMessage: newMessage._id },
          { new: true }
        );
        console.log(
          `Updated chat ${chatId} with last message and response is ${JSON.stringify(chatUpdated)}`
        );
      }
    } catch (error) {
      console.log('Error sending message:', error.message);
      return null;
    }
  },

  deleteUserChat: async (params) => {
    try {
      console.log(`deleteUserChat util called with params ${JSON.stringify(params)}`);
      const { userId, chatId } = params;
      const validateUserChat = await Chats.findOne({
        _id: chatId,
        participants: new ObjectId(userId)
      });
      if (!validateUserChat) {
        console.log(`User ${userId} is not a participant of chat ${chatId}`);
        return {
          success: false,
          message: `User ${userId} is not a participant of chat ${chatId}`
        };
      }

      const chatUserSetting = validateUserChat?.userSettings || [];
      if (!chatUserSetting?.length) {
        chatUserSetting.push({
          userId,
          lastChatDeletedAt: new Date(),
          hasUserDeletedChat: true
        });
      } else {
        const userSpecificSettings = chatUserSetting.find(
          (setting) => setting.userId.toString() === userId.toString()
        );
        if (userSpecificSettings) {
          userSpecificSettings.hasUserDeletedChat = true;
          userSpecificSettings.lastChatDeletedAt = new Date();
        } else {
          chatUserSetting.push({
            userId,
            lastChatDeletedAt: new Date(),
            hasUserDeletedChat: true
          });
        }
      }
      validateUserChat.markModified('userSettings');
      await validateUserChat.save();

      await Messages.updateMany(
        {
          chat: chatId,
          userSettings: {
            $elemMatch: {
              userId: userId,
              $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
            }
          }
        },
        {
          $set: { 'userSettings.$.deletedAt': new Date() }
        }
      );

      await Messages.updateMany(
        {
          chat: { $in: chatId },
          'userSettings.userId': { $ne: userId }
        },
        {
          $push: {
            userSettings: {
              userId: userId,
              deletedAt: new Date()
            }
          }
        }
      );

      console.log(`Messages updated for user ${userId} in chat ${chatId}}`);

      return {
        success: true,
        userId,
        chatId,
        message: `Chat and messages deleted for user ${userId}`
      };
    } catch (error) {
      console.log(`Got error in deleteUserChat for user ${params?.userId}: ${error?.stack}`);
      return {
        success: false,
        message: `Internal server error. Please try again.`,
        error: error.message
      };
    }
  },

  addReaction: async (params) => {
    try {
      console.log(`addReaction util called with params ${JSON.stringify(params)}`);
      const { messageId, userId, emoji } = params;
      const userExistingReaction = await Reactions.findOne({ objectId: messageId, user: userId });
      if (userExistingReaction) {
        userExistingReaction.emoji = emoji;
        return userExistingReaction.save();
      }
      const reactionBody = {
        objectId: messageId,
        objectOnModel: 'messages',
        user: userId,
        emoji
      };
      const reaction = await Reactions.create(reactionBody);
      console.log(`Got reaction create response in DB [add-reaction]: ${JSON.stringify(reaction)}`);
      return true;
    } catch (error) {
      console.log(`Got error in addReaction for user ${params?.userId}: ${error.message}`);
      return false;
    }
  },

  removeReaction: async (params) => {
    try {
      console.log(`removeReaction util called with params ${JSON.stringify(params)}`);
      const { messageId, userId, emoji } = params;
      return Reactions.findOneAndDelete({ objectId: messageId, user: userId, emoji });
    } catch (error) {
      console.log(`Got error in removeReaction for user ${params?.userId}: ${error.message}`);
      return false;
    }
  },

  editMessage: async (params) => {
    try {
      console.log(`editMessage util called with params ${JSON.stringify(params)}`);
      const { messageId, userId, content } = params;
      const message = await Messages.findById(messageId)
        .populate({ path: 'chat', populate: { path: 'participants' } })
        .populate('sender');
      if (!message) {
        console.log(`Message with ID ${messageId} not found`);
        return {
          success: false,
          message: `Message with ID ${messageId} not found`
        };
      }
      if (message?.sender?._id?.toString?.() !== userId?.toString?.()) {
        console.log(`User ${userId} is not the sender of message ${messageId}`);
        return {
          success: false,
          message: `User ${userId} is not the sender of message ${messageId}`
        };
      }
      message.content = content;
      message.editedAt = new Date();
      await message.save();
      console.log(
        `Message ${messageId} edited successfully and new data is ${JSON.stringify(message)}`
      );
      return {
        success: true,
        data: message
      };
    } catch (error) {
      console.error(`Got error in editMessage for user ${params?.userId}: ${error.message}`);
      return {
        success: false
      };
    }
  },

  getChatGallery: async (params) => {
    try {
      console.log(`getChatGallery util called with params ${JSON.stringify(params)}`);
      const { chatId, userId, pageNo = 1, recordsPerPage = 20, contentType } = params;

      const validateUserChat = await Chats.findOne({
        _id: chatId,
        participants: new ObjectId(userId),
        $or: [
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
              }
            }
          }
        ]
      });
      if (!validateUserChat) {
        console.log(`User ${userId} is not part of chat ${chatId}`);
        return {
          success: false,
          message: `Chat not found for user ${userId}`
        };
      }

      const skip = (pageNo - 1) * recordsPerPage;

      let contentTypeCondition = {};

      if (contentType === 'media') {
        contentTypeCondition = { contentType: { $in: ['image', 'video'] } };
      } else if (contentType && contentType !== 'link') {
        contentTypeCondition = { contentType };
      }

      const contentTypeOrDescriptionCondition = {
        $or: [{ contentType: 'link' }, { contentDescriptionType: 'link' }]
      };

      const query = {
        chat: chatId,
        ...(contentType === 'link' ? contentTypeOrDescriptionCondition : contentTypeCondition)
      };

      // Fetch the messages
      const messages = await Messages.find(query)
        .populate('sender')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(recordsPerPage);

      // Get the total records for pagination
      const totalRecords = await Messages.countDocuments(query);

      // Format the response
      const formattedResponse = messages?.map((message) => ({
        chatId: message?.chat,
        messageId: message?._id,
        sender: {
          _id: message?.sender?._id,
          name: message?.sender?.name ?? 'Unknown'
        },
        content: message?.content,
        contentTitle: message?.contentTitle,
        fileSize: message?.fileSize ?? '',
        contentDescription: message?.contentDescription ?? '',
        contentType: message?.contentType,
        contentDescriptionType: message?.contentDescriptionType ?? 'text',
        isContentPaid: message?.isContentPaid,
        contentPrice: message?.contentPrice,
        contentPaymentCurrency: message?.contentPaymentCurrency,
        usersPaidForContent: [],
        isReplyIncentivized: message?.isReplyIncentivized,
        replyIncentiveAmount: message?.replyIncentiveAmount,
        replyIncentiveCurrency: message?.replyIncentiveCurrency,
        usersIncentivizedForReplying: [],
        forwardedFrom: message?.forwardedFrom,
        forwaredFromType: message?.forwaredFromType,
        replyTo: message?.replyTo,
        replyToType: message?.replyToType,
        groupMediaIdentfier: message?.groupMediaIdentfier,
        editedAt: message?.editedAt
      }));

      console.log(
        `Got chat gallery in DB [get-chat-gallery] for ${userId} and page no ${pageNo} with length: ${formattedResponse?.length}`
      );

      return {
        success: true,
        pageNo,
        recordsPerPage,
        totalRecords,
        data: formattedResponse
      };
    } catch (error) {
      console.log(`Got error in getChatGallery for user ${params?.userId}: ${error.message}`);
      return {
        success: false,
        message: `Internal server error. Please try again.`
      };
    }
  },

  markMessageAsRead: async (params) => {
    try {
      console.log(`markMessageAsRead util called with params ${JSON.stringify(params)}`);
      let { chatId, userId, bookingId } = params;
      const chat = await Chats.findOne({ _id: chatId, participants: new ObjectId(userId) });
      if (!chat) {
        console.log(`Chat with ID ${chatId} for user ${userId} not found.`);
        return {
          success: false,
          message: `Chat with ID ${chatId} for user ${userId} not found.`
        };
      }
      chatId = chat?._id;
      const query = {};
      if (bookingId) {
        query.bookingId = bookingId;
      }
      const allChatMessages = await Messages.find({
        chat: chatId,
        alert_result: { $ne: { isAllowed: 'False' } }
      }).distinct('_id');
      const response = await module.exports.updateReadAt({
        chatId,
        userId,
        ...query,
        messageIds: allChatMessages
      });
      if (!response) {
        console.log(`Failed to mark messages as read for chat ${chatId} and user ${userId}`);
        return {
          success: false,
          message: `Failed to mark messages as read for chat ${chatId} and user ${userId}`
        };
      }
      return {
        success: true,
        chatId
      };
    } catch (error) {
      console.error(`Got error in markMessageAsRead for user ${params?.userId}: ${error.message}`);
      return {
        success: false,
        message: `Internal server error. Please try again.`
      };
    }
  },

  convertMinutes: (minutes) => {
    try {
      const weeks = Math.floor(minutes / 10080); // 10080 minutes in a week
      const remainingMinutesAfterWeeks = minutes % 10080;
      const days = Math.floor(remainingMinutesAfterWeeks / 1440); // 1440 minutes in a day
      const remainingMinutesAfterDays = remainingMinutesAfterWeeks % 1440;
      const hours = Math.floor(remainingMinutesAfterDays / 60);
      const remainingMinutes = remainingMinutesAfterDays % 60;

      let result = '';
      if (weeks > 0) {
        result += `${weeks} week${weeks > 1 ? 's' : ''}`;
      }
      if (days > 0) {
        result += `${result ? ' ' : ''}${days} day${days > 1 ? 's' : ''}`;
      }
      if (hours > 0) {
        result += `${result ? ' ' : ''}${hours} hour${hours > 1 ? 's' : ''}`;
      }
      if (remainingMinutes > 0) {
        result += `${result ? ' ' : ''}${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
      }

      return result || '0 minutes';
    } catch (error) {
      console.log(`Got error in convertMinutes: ${JSON.stringify(error?.stack)}`);
      return '0 minutes';
    }
  },

  msgDeliveryStatus: (params) => {
    try {
      const { userId, chat } = params;
      console.log(`msgDeliveryStatus util called for userId and chat: ${userId} and ${chat?._id}`);
      const senderId = chat?.lastMessage?.sender?._id
        ? chat?.lastMessage?.sender?._id?.toString?.()
        : chat?.lastMessage?.sender?.toString?.();
      const showLastMsgDeliveryStatus = senderId === userId?.toString?.() ? true : false;
      const deliveryStatus = {};
      if (JSON.parse(showLastMsgDeliveryStatus || false)) {
        const isRead = chat?.lastMessage?.userSettings?.find(
          (setting) => setting?.userId?.toString?.() !== userId?.toString()
        )?.readAt
          ? true
          : false;
        const isDelivered = isRead
          ? true
          : chat?.lastMessage?.userSettings?.find(
                (setting) => setting?.userId?.toString?.() !== userId?.toString()
              )?.deliveredAt
            ? true
            : false;
        deliveryStatus.isRead = isRead;
        deliveryStatus.isDelivered = isDelivered;
      }
      return deliveryStatus;
    } catch (error) {
      console.log(`Got error in msgDeliveryStatus: ${JSON.stringify(error?.stack)}`);
      return {};
    }
  },

  fetchOtherChats: async (params) => {
    try {
      console.log(`fetchOtherChats util called with params ${JSON.stringify(params)}`);
      const { userId, pageNo = 1, recordsPerPage = 10 } = params;
      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const documentsLimit = recordsPerPage;
      const userChatIds = await Chats.find({
        participants: new ObjectId(userId),
        notStarted: false,
        userSettings: {
          $elemMatch: {
            userId: userId,
            $and: [
              {
                $or: [
                  { isChatWithContact: false }
                  // { movedToOthers: true }
                ]
              },
              {
                $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
              }
            ]
          }
        }
      }).distinct('_id');
      console.log('user other chats ids', userChatIds);
      let chats = await Chats.find({ _id: { $in: userChatIds } })
        .sort({ lastMessageSentAt: -1 })
        .populate('participants')
        .populate({ path: 'lastMessage', model: Messages })
        .skip(skipDocuments)
        .limit(documentsLimit);
      if (chats?.length) {
        chats = await Promise.all(
          chats?.map(async (chat) => {
            const unreadCount = await Messages.countDocuments({
              chat: { $in: chat?._id },
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: userId } },
                {
                  userSettings: {
                    $elemMatch: {
                      userId: userId,
                      $or: [{ readAt: null }, { readAt: { $exists: false } }]
                    }
                  }
                }
              ]
            });
            const userSettings = chat?.userSettings?.find(
              (setting) => setting?.userId?.toString?.() == userId?.toString?.()
            );
            const displayPicture =
              chat?.participants?.find(
                (participant) => participant?._id?.toString?.() != userId?.toString?.()
              )?.dp ?? defaultImage;
            const chatName =
              chat?.groupName ||
              chat?.participants?.find(
                (participant) => participant?._id?.toString?.() !== userId?.toString?.()
              )?.name;
            const receiverId = chat?.participants
              ?.find((participant) => participant?._id.toString() != userId)
              ?._id.toString();
            // const isBlocked = await SpamUsers.findOne({ userId, actBy: receiverId, type: 'block' }) ? true : false;
            // const blockedByMe = await SpamUsers.findOne({ userId: receiverId, actBy: userId, type: 'block' }) ? true : false;
            const messageDeliveryStatus = module.exports.msgDeliveryStatus({ userId, chat }) || {};
            const chatDisplayInfo = {
              chatId: chat?._id,
              chatName,
              displayPicture,
              latestMessage: chat?.lastMessage?.content,
              latestMessageId: chat?.lastMessage?._id,
              latestMessageType: chat?.lastMessage?.contentType,
              latestMessageSentAt: chat?.lastMessageSentAt ?? chat?.lastMessage?.createdAt,
              latestMessageTitle: chat?.lastMessage?.title ?? '',
              latestMessageDescription: chat?.lastMessage?.description ?? '',
              isReplyIncentivized: chat?.lastMessage?.isReplyIncentivized,
              replyIncentiveAmount: chat?.lastMessage?.replyIncentiveAmount,
              replyIncentiveCurrency: chat?.lastMessage?.replyIncentiveCurrency,
              hasUserIncentivizedForReplying: false,
              isContentPaid: chat?.lastMessage?.isContentPaid,
              contentPrice: chat?.lastMessage?.contentPrice,
              contentPaymentCurrency: chat?.lastMessage?.contentPaymentCurrency,
              hasUserPaidForContent: false,
              pinnedAt: userSettings?.pinnedAt ?? null,
              isMuted: userSettings?.hasUserMutedChat ?? false,
              unreadCount: unreadCount || 0,
              receiverId,
              isBlocked,
              blockedByMe,
              ...(Object.keys(messageDeliveryStatus || {})?.length && { ...messageDeliveryStatus }),
              isOthersRequestPending: JSON.parse(userSettings?.isOthersRequestPending || false)
                ? true
                : false
            };
            return chatDisplayInfo;
          })
        );
      }
      const response = {
        pageNo,
        recordsPerPage,
        totalRecords: userChatIds?.length,
        chats
      };
      return response;
    } catch (error) {
      console.log(`Got error in fetchUserChats for user ${params?.userId}: ${error?.stack}`);
      return [];
    }
  },

  acceptOtherRequest: async (params) => {
    try {
      console.log(`acceptOtherRequest util called with params ${JSON.stringify(params)}`);
      const { userId, chatId } = params;
      if (!chatId) {
        console.log(`ChatId is required to accept other request.`);
        return {
          success: false,
          message: `ChatId is required to accept other request.`
        };
      }
      const validateChat = await Chats.findOne({ _id: chatId, participants: userId });
      if (!validateChat) {
        console.log(`User ${userId} is not part of chat ${chatId}`);
        return {
          success: false,
          message: `User ${userId} is not part of chat ${chatId}`
        };
      }
      if (!validateChat?.userSettings?.length) {
        const userSpecificSettings = [
          {
            userId,
            isChatWithContact: true
          }
        ];
        validateChat.userSettings = userSpecificSettings;
      } else {
        const userSettings = validateChat?.userSettings?.find(
          (setting) => setting?.userId?.toString?.() === userId?.toString?.()
        );
        if (!userSettings) {
          console.log(`User settings not found for user ${userId} in chat ${chatId}`);
          validateChat.userSettings.push({
            userId,
            isChatWithContact: true,
            isRequestAccepted: true
          });
        } else {
          userSettings.isChatWithContact = true;
          userSettings.isOthersRequestPending = false;
          userSettings.isRequestAccepted = true;
        }
      }
      validateChat.markModified('userSettings');
      await validateChat.save();
      const contactId = validateChat?.participants?.find?.(
        (participant) => participant?.toString?.() !== userId?.toString?.()
      );
      const contactResponse = await module.exports.addSenderToContact({ userId, contactId });
      if (!contactResponse?.success) {
        console.log(`Failed to add sender to contact for user ${userId} and contact ${contactId}`);
        return {
          success: false,
          message: `Failed to add sender to contact for user ${userId} and contact ${contactId}`
        };
      }
      return {
        success: true,
        data: contactResponse?.data
      };
    } catch (error) {
      console.log(`Got error in acceptOtherRequest for user ${params?.userId}: ${error?.stack}`);
      return {
        success: false
      };
    }
  },

  sendPushNotification: async (params) => {
    try {
      const {
        sender = null,
        receiver = null,
        latestMessageData,
        chatId,
        notificationBody,
        deviceId
      } = params;
      console.log(`sendPushNotification util called with params ${JSON.stringify(params)}`);
      // Helper function to validate FCM token (basic check)
      if (!latestMessageData || !sender || !receiver || !chatId) {
        console.log('invalid message data');
        return;
      }
      const validateFcmToken = (token) => {
        return typeof token === 'string' && token.trim() !== '';
      };

      if (!validateFcmToken(receiver?.fcmToken)) {
        console.error('Invalid or empty FCM token for receiver. No notification will be sent.');
      } else {
        const notificationForReceiver = {
          notification: {
            title: sender.name,
            body: notificationBody || latestMessageData?.content
          },
          data: {
            userId: sender._id?.toString(),
            chatId: chatId?.toString()
          },
          tokens: [receiver?.fcmToken]
        };

        console.log('Notification for Receiver:', notificationForReceiver);
      }

      console.log('Notifications sent successfully if tokens were valid.');
    } catch (error) {
      console.error('Error sending notification:', error);
      // Optionally, handle more specific FCM errors (e.g., invalid token errors)
      if (error.message.includes('invalid')) {
        console.error('FCM token error:', error.message);
      }
    }
  },

  calculateUnreadCounts: async (userId) => {
    try {
      // Fetch unread chats
      const userChatIds = await Chats.find({
        participants: new ObjectId(userId),
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $or: [{ readAt: null }, { readAt: { $exists: false } }]
              }
            }
          }
        ]
      }).distinct('_id');

      // Count unread messages in these chats
      const unreadMessages = await Messages.countDocuments({
        chat: { $in: userChatIds },
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $or: [{ readAt: null }, { readAt: { $exists: false } }]
              }
            }
          }
        ]
      });

      return {
        unreadChats: userChatIds.length,
        unreadMessages
      };
    } catch (error) {
      console.error('Error calculating unread counts:', error);
      return { unreadChats: 0, unreadMessages: 0 };
    }
  },

  getNotificationBody: (message) => {
    const contentType = message?.contentType;
    switch (contentType) {
      case 'image':
        return 'Image shared';
      case 'video':
        return 'Video shared';
      case 'audio':
        return 'Audio shared';
      case 'file':
        return 'File shared';
      case 'contact':
        return `Contact shared: ${message?.sharedContact?.name || 'Unknown'}`;
      case 'current_location':
        return 'Location shared';
      case 'live_location':
        return 'Live location shared';
      case 'link':
        return `Link shared`;
      // return `Link shared: ${message?.contentTitle || "No Title"}`;
      case 'text':
      default:
        return message?.content || 'New message';
    }
  },

  fetchUnseenChatCounts: async (userId) => {
    try {
      const userChatIds = await Chats.find({
        participants: new ObjectId(userId),
        notStarted: false,
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $and: [
                  {
                    $or: [
                      { isDeletedFrom2Reply: false },
                      { isDeletedFrom2Reply: { $exists: false } }
                    ]
                  },
                  {
                    $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
                  }
                ]
              }
            }
          }
        ]
      }).distinct('_id');
      const unseenChats = await Messages.find({
        chat: { $in: userChatIds },
        $or: [
          { userSettings: { $exists: false } },
          { userSettings: { $size: 0 } },
          {
            userSettings: {
              $not: {
                $elemMatch: {
                  userId: userId
                }
              }
            }
          },
          {
            userSettings: {
              $elemMatch: {
                userId: { $eq: userId },
                $or: [{ readAt: { $exists: false } }, { readAt: null }]
              }
            }
          }
        ]
      }).distinct('chat');
      console.log('unseen chat ids'.green.bold, unseenChats);
      const allUnseenChats = await Chats.countDocuments({ _id: { $in: unseenChats } });

      return {
        unseenChatsCount: allUnseenChats
      };
    } catch (error) {
      console.error('Error fetching unseen chat counts:', error.message);
      return {
        unseenChatsCount1: 0,
        message: 'No unseen chats'
      };
    }
  },
  createGroupChat: async ({ chatName, participants, userId, chatType = '', chatPicture }) => {
    try {
      const chat = await Chats.create({
        chatName: chatName,
        participants: [...participants, userId],
        chatType: chatType,
        chatPicture: chatPicture,
        GroupcreatedBy: userId,
        isGroup: true
      });
      return chat;
    } catch (error) {
      console.error('Error creating group chat:', error.message);
      return { success: false, message: 'Failed to create group chat.' };
    }
  },
  addMemberinGroup: async ({ chatId, participants }) => {
    try {
      const chat = await Chats.findById(chatId);
      if (!chat) {
        console.error(`Chat with ID ${chatId} not found.`);
        return { success: false, message: 'Chat not found.' };
      }
      const existingParticipants = chat.participants.map((participant) => participant.toString());
      const newParticipants = participants.filter(
        (participant) => !existingParticipants.includes(participant.toString())
      );
      if (newParticipants.length === 0) {
        console.log('No new participants to add.');
        return { success: true, message: 'No new participants to add.' };
      }
      chat.participants.push(...newParticipants);
      await chat.save();
      return { success: true, chat, newParticipants };
    } catch (error) {
      console.error('Error adding members to group:', error.message);
      return { success: false, message: 'Failed to add members to group.' };
    }
  },
  removeMembersFromGroup: async ({ chatId, participants, userId }) => {
    try {
      const chat = await Chats.findById(chatId);
      if (!chat) {
        console.error(`Chat with ID ${chatId} not found.`);
        return { success: false, message: 'Chat not found.' };
      }
      chat.participants = chat.participants.filter(
        (participant) => !participants.includes(participant.toString())
      );
      await chat.save();
      return { success: true, chat, removedMembers: participants };
    } catch (error) {
      console.error('Error removing members from group:', error.message);
      return { success: false, message: 'Failed to remove members from group.' };
    }
  },
  chatNameForUser: (chatDetails, userId) => {
    return (
      chatDetails?.chatName ||
      chatDetails?.participants?.find(
        (participant) => participant?._id?.toString?.() !== userId?.toString?.()
      )?.fullName
    );
  },
  chatProfileForUser: (chatDetails, userId) => {
    return chatDetails?.chatPicture
      ? chatDetails?.chatPicture
      : (chatDetails?.participants?.find(
          (participant) => participant?._id?.toString?.() != userId.toString?.()
        )?.profilePicture ??
          chatDetails?.participants?.find(
            (participant) => participant?._id?.toString?.() != userId?.toString?.()
          )?.profilePicture ??
          defaultImage);
  },

  searchChatsByMessageContent: async (params) => {
    try {
      console.log(`searchChatsByMessageContent util called with params ${JSON.stringify(params)}`);
      const { userId, search, pageNo = 1, recordsPerPage = 20 } = params;

      if (!search || search.trim() === '') {
        console.log('Search query is required');
        return {
          pageNo,
          recordsPerPage,
          totalRecords: 0,
          chats: []
        };
      }

      const skipDocuments = (pageNo - 1) * recordsPerPage;
      const documentsLimit = recordsPerPage;

      // Get all chats where user is a participant
      const userChatIds = await Chats.find({
        participants: new ObjectId(userId),
        $or: [
          { userSettings: { $size: 0 } },
          { 'userSettings.userId': { $ne: userId } },
          {
            userSettings: {
              $elemMatch: {
                userId: userId,
                $or: [{ hasUserDeletedChat: false }, { hasUserDeletedChat: { $exists: false } }]
              }
            }
          }
        ]
      }).distinct('_id');

      // Search for messages containing the search query
      const searchRegex = new RegExp(search, 'i');

      // Find all matching messages (not distinct by chat)
      const matchingMessages = await Messages.find({
        chat: { $in: userChatIds },
        content: { $regex: searchRegex },
        contentType: 'text'
      })
        .populate('sender', '_id firstName lastName fullName profilePicture')
        .populate('chat')
        .sort({ createdAt: -1 });

      console.log(`Found ${matchingMessages.length} matching messages`);

      // Get total count for pagination
      const totalRecords = matchingMessages.length;

      // Apply pagination to messages
      const paginatedMessages = matchingMessages.slice(
        skipDocuments,
        skipDocuments + documentsLimit
      );

      // Map each message to a chat result
      let chats = [];
      if (paginatedMessages?.length) {
        chats = await Promise.all(
          paginatedMessages.map(async (message) => {
            const chat = await Chats.findById(message.chat).populate('participants');

            if (!chat) {
              return null;
            }

            const unreadCount = await Messages.countDocuments({
              chat: { $in: chat?._id },
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: userId } },
                {
                  userSettings: {
                    $elemMatch: {
                      userId: userId,
                      $or: [{ readAt: null }, { readAt: { $exists: false } }]
                    }
                  }
                }
              ]
            });

            const displayPicture = chat?.chatPicture
              ? chat?.chatPicture
              : (chat?.participants?.find(
                  (participant) => participant?._id?.toString?.() != userId?.toString?.()
                )?.profilePicture ?? defaultImage);

            // Create a temporary chat object with the matched message as lastMessage
            const chatWithMatchedMessage = {
              ...chat.toObject(),
              lastMessage: message
            };

            const messageDeliveryStatus =
              module.exports.msgDeliveryStatus({ userId, chat: chatWithMatchedMessage }) || {};

            const chatDisplayInfo = {
              chatId: chat?._id,
              chatType: chat?.chatType,
              isGroup: chat?.isGroup ?? false,
              GroupcreatedBy: chat?.GroupcreatedBy,
              participants:
                chat?.participants.map((participant) => ({
                  userId: participant?._id,
                  fullName: participant?.fullName,
                  profilePicture: participant?.profilePicture ?? defaultImage
                })) ?? [],
              chatName:
                chat?.chatName ||
                chat?.participants?.find(
                  (participant) => participant?._id?.toString?.() !== userId?.toString?.()
                )?.fullName,
              displayPicture,
              latestMessage: message?.content,
              latestMessageId: message?._id,
              latestMessageType: message?.contentType,
              contentDescriptionType: message?.contentDescriptionType ?? 'text',
              fileSize: message?.fileSize ?? '',
              latestMessageSentAt: message?.createdAt,
              latestMessageTitle: message?.contentTitle ?? '',
              latestMessageDescription: message?.contentDescription ?? '',
              unreadCount: unreadCount || 0,
              matchedMessage: {
                messageId: message._id,
                content: message.content,
                sender: {
                  _id: message.sender?._id,
                  fullName: message.sender?.fullName,
                  profilePicture: message.sender?.profilePicture ?? defaultImage
                },
                sentAt: message.createdAt,
                contentType: message.contentType,
                bookingId: message.bookingId || null
              },
              ...(Object.keys(messageDeliveryStatus || {})?.length && { ...messageDeliveryStatus })
            };
            return chatDisplayInfo;
          })
        );

        // Filter out any null values
        chats = chats.filter((chat) => chat !== null);
      }

      const response = {
        pageNo,
        recordsPerPage,
        totalRecords,
        chats
      };
      return response;
    } catch (error) {
      console.log('error', error);
      console.log(
        `Got error in searchChatsByMessageContent for user ${params?.userId}: ${error.message}`
      );
      return {
        pageNo: params?.pageNo || 1,
        recordsPerPage: params?.recordsPerPage || 20,
        totalRecords: 0,
        chats: []
      };
    }
  }
};
