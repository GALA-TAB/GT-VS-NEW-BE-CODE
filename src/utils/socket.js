const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { ObjectId } = require('mongoose').Types;

const moment = require('moment');
const UsersModel = require('../models/users/User');
const MessagesModel = require('../models/chat/Message');
const ChatsModel = require('../models/chat/Chat');
const ReactionsModel = require('../models/chat/Reaction');

const Messages = require('../models/chat/Message');
const {
  authMiddleWareSocket,
  updateDeliveredAt,
  fetchUnseenChats,
  fetchUserChats,
  msgDeliveryStatus,
  updateReadAt,
  deleteUserChat,
  addReaction,
  fetchChatMessages,
  fetchChatBookings,
  removeReaction,
  editMessage,
  markMessageAsRead,
  getUserNotifications,
  getUserUnreadNotifications,
  readUserNotifications,
  chatProfileForUser,
  chatNameForUser,
  createGroupChat,
  addMemberinGroup,
  removeMembersFromGroup,
  searchChatsByMessageContent
} = require('./socket-utils');
const Bookings = require('../models/Bookings');
const User = require('../models/users/User');
const NotificationPermission = require('../models/NotificationPermission');
const { sendTwilioSms } = require('./sendTwilioSms');
const Notification = require('../models/Notification');
const Email = require('./email');
const Chat = require('../models/chat/Chat');
const {
  DataContextImpl
} = require('twilio/lib/rest/api/v2010/account/recording/addOnResult/payload/data');

let io;

const defaultImage =
  'https://images.icon-icons.com/1993/PNG/512/account_avatar_face_man_people_profile_user_icon_123197.png';

function initializeSocket(server) {
  if (!io) {
    console.log('Socket.io is not initialized.');
    io = new Server(server, { cors: { origin: '*' } });
  }
  io.use(authMiddleWareSocket);

  // io.adapter(redisAdapter({ host: REDIS_HOST, port: REDIS_PORT }));

  io.on('connection', async (socket) => {
    const socketId = socket.id;
    const userId = socket?.user?._id.toString();
    const username = socket?.user?.fullName ?? socket?.user?.firstName;
    const user = socket?.user;
    const staff = socket?.staff;
    const subAdmin = socket?.subAdmin?.toObject();

    if (userId) {
      socket.join(userId.toString());
      console.log(`User ${userId}  ${username} connected and joined room `);
    }

    if (subAdmin?.adminRole === 'subAdmin') {
      socket.join(`notification_subAdmin_${subAdmin?._id}`);
    } else if (subAdmin?.adminRole === 'admin') {
      socket.join(`notification_admin`);
    }
    try {
      const userChatIds = await ChatsModel.find({
        participants: new ObjectId(userId),
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
      const undeliveredMessagesQuery = {
        chat: { $in: userChatIds },
        alert_result: { $ne: { isAllowed: 'False' } },
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
                $or: [{ deliveredAt: { $exists: false } }, { deliveredAt: null }]
              }
            }
          }
        ]
      };
      const undeliveredChatIds =
        await MessagesModel.find(undeliveredMessagesQuery).distinct('chat');

      if (undeliveredChatIds?.length) {
        const undeliverdChats = await ChatsModel.find({ _id: { $in: undeliveredChatIds } });
        undeliverdChats?.map(async (chat) => {
          const otherUserIds = chat?.participants?.filter(
            (participant) => participant.toString() !== userId.toString()
          );
          otherUserIds.forEach((otherUserId) => {
            const otherUserSocketId = io.sockets.adapter.rooms.get(otherUserId?.toString?.());
            if (otherUserSocketId) {
              io.to(otherUserId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId: chat?._id,
                allMsgsDelivered: true
              });
            }
          });
        });
        undeliverdChats?.map(async (chat) => {
          await updateDeliveredAt({
            userId,
            chatIds: [chat?._id]
          });
        });
      }
    } catch (error) {
      console.log('socket connection error');
      socket.emit('socket-error', { message: 'Error in updating chats.' });
      console.log('error', error);
    }
    socket.on('disconnect', async () => {
      await UsersModel.updateOne({ _id: userId }, { activeChat: null });
      console.log(`User ${userId} disconnected.`);
    });

    socket.on('get-user-active-status', async (data) => {
      try {
        const { userToCheckId } = data;
        const isUserOnline = io.sockets.adapter.rooms.get(userToCheckData?.toString?.())
          ? true
          : false;
        if (isUserOnline) {
          socket.emit('user-active-status', { isUserOnline: true });
          return;
        }
        const userToCheckData = await UsersModel.findById(userToCheckId);
        const lastSeen = userToCheckData?.lastSeen;
        socket.emit('user-active-status', { isUserOnline: false, lastSeen });
        return;
      } catch (error) {
        console.log(`Got error in get-user-active-status: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in getting user active status.' });
      }
    });

    socket.on('fetch-unseen-chats', async (data) => {
      try {
        const unseenChats = await fetchUnseenChats({ ...data, userId });
        socket.emit('unseen-chats', unseenChats);
      } catch (error) {
        console.log(`Got error in fetch-unseen-chats: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching unseen chats.' });
      }
    });

    /////////////////////// fetch-user-chats done /////////////////////////
    socket.on('fetch-user-chats', async (data) => {
      try {
        const chats = await fetchUserChats({ ...data, userId });
        socket.emit('user-chats', chats);
      } catch (error) {
        console.log(`Got error in fetch-user-chats: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching unseen chats.' });
      }
    });

    socket.on('fetch-chat-booking', async (data) => {
      try {
        let receiverId = data?.receiverId;
        if (receiverId && typeof receiverId === 'object' && receiverId._id) {
          receiverId = receiverId._id.toString();
        }
        if (!receiverId && !data?.chatId) {
          socket.emit('socket-error', { message: 'Receiver id or chat id is required.' });
          return;
        }
        if (data?.chatId) {
          const validateUserChat = await ChatsModel.findOne({
            _id: data?.chatId,
            participants: new ObjectId(userId)
          });
          if (!validateUserChat) {
            // console.log(`No chat found against chat id ${data?.chatId} and user ${userId} in send-message`);
            socket.emit('socket-error', { message: 'No chat found against chat id and user.' });
            return;
          }
          if (receiverId && !validateUserChat?.participants?.includes(receiverId)) {
            // console.log(`Receiver is not a part of chat ${data?.chatId} in send-message`);
            socket.emit('socket-error', {
              message: `You can't send message to user who is not part of chat.`
            });
            return;
          } else {
            receiverId = validateUserChat?.participants?.find(
              (participant) => participant.toString?.() !== userId?.toString()
            );
          }
        }
        const bookings = await fetchChatBookings({ ...data, receiverId, user: socket?.user });
        socket.emit('user-booking', bookings);
      } catch (error) {
        console.log(`Got error in fetch-chat-bookings: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching chat booking' });
      }
    });

    socket.on('fetch-user-chat-messages', async (data) => {
      try {
        // console.log(`fetch-user-chat-messages event received for socket ${socketId} and user ${userId} with data: ${JSON.stringify(data)}`);
        const { chatId } = data;
        if (!chatId) {
          socket.emit('socket-error', { message: 'Chat id is required.' });
          return;
        }
        const response = await fetchChatMessages({ ...data, userId });
        socket.emit('user-chat-messages', response);
        const chatDetails = await ChatsModel.findById(chatId);
        if (chatDetails) {
          const otherParticipant = chatDetails?.participants?.find(
            (participant) => participant.toString() !== userId.toString()
          );
          const otherParticipantId = otherParticipant?._id?.toString?.();
          const otherParticipantSocketId = io.sockets.adapter.rooms.get(otherParticipantId);
          if (otherParticipantSocketId) {
            io.to(otherParticipantId).emit('mark-message-read-response', {
              success: true,
              chatId,
              userId,
              allMsgsRead: true,
              bookingId: data?.bookingId,
              unreadCount: response?.unreadCount
            });
          }
          await UsersModel.updateOne({ _id: userId }, { activeChat: chatId });
        }
      } catch (error) {
        console.log(`Got error in fetch-user-chat-messages: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching unseen chats.' });
      }
    });

    socket.on('check-user-existingchat', async (data) => {
      try {
        let receiverId = data?.receiverId;

        if (receiverId && typeof receiverId === 'object' && receiverId._id) {
          receiverId = receiverId._id.toString();
        }

        // if ( userId.toString() === receiverId.toString() ){
        //     socket.emit('socket-error', { message: 'Receiver id is current UserId!' });
        //     return;
        // }

        let chatId = null;
        const checkExistingChat = await ChatsModel.findOne({ participants: [userId, receiverId] });
        if (checkExistingChat) {
          chatId = checkExistingChat?._id.toString();
        }
        socket.emit('user-existingChatId', { chatId });
      } catch (error) {
        console.log(`Got error in check-user-existingchat: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching unseen chats.' });
      }
    });

    //////////////////////////////////// send-message done /////////////////////////
    socket.on('send-message', async (data) => {
      try {
        let receiverId = data?.receiverId;
        const senderData = user; ////////////////////// this is required for process /////////////////////////
        if (!data?.chatType) {
          socket.emit('socket-error', { message: 'chatType is required.' });
          return;
        }
        let bookingId = data?.bookingId;
        let findBooking = null;
        if (bookingId) {
          findBooking = await Bookings.findById(bookingId).populate('service');
          if (!findBooking) {
            socket.emit('socket-error', { message: `Booking not found with id ${bookingId._id}` });
            return;
          }
          if (
            !['completed', 'booked'].includes(findBooking.status) &&
            data?.contentType !== 'text'
          ) {
            socket.emit('socket-error', {
              message: 'Booking is not completed yet . Media is not allowed'
            });
            return;
          }
          bookingId = findBooking._id.toString();
        }

        if (!receiverId && !data?.chatId && data?.chatType !== 'contact') {
          socket.emit('socket-error', { message: 'Receiver id or chat id is required.' });
          return;
        }

        let allParticipants = [];

        if (data?.chatId) {
          const validateUserChat = await ChatsModel.findOne({
            _id: data?.chatId,
            participants: { $in: [userId] }
          });
          if (!validateUserChat) {
            socket.emit('socket-error', { message: 'No chat found against chat id and user.' });
            return;
          }
          if (receiverId && !validateUserChat?.participants?.includes(receiverId)) {
            socket.emit('socket-error', {
              message: `You can't send message to user who is not part of chat.`
            });
            return;
          } else {
            allParticipants = validateUserChat?.participants?.filter(
              (participant) => participant.toString?.() !== userId?.toString()
            );
          }
        }
        let receiversData;

        if (data?.chatType === 'contact' && allParticipants.length === 0) {
          receiversData = await UsersModel.find({ adminRole: 'admin' });
          receiverId = receiversData[0]?._id;

          allParticipants.push(receiverId);
        } else {
          receiversData = await UsersModel.find({ _id: { $in: allParticipants } });
        }

        if (receiversData?.length === 0) {
          socket.emit('socket-error', { message: `Invalid receiver data.` });
          return;
        }

        let chatId = data?.chatId;

        if (!chatId) {
          let chat;

          chat = await ChatsModel.findOne({
            chatType: data?.chatType,
            isGroup: false,
            participants: { $all: [userId, receiverId], $size: 2 }
          });

          if (!chat) {
            chat = await ChatsModel.create({
              participants: [userId, receiverId],
              chatType: data?.chatType,
              isGroup: false
            });
            sendNotification({
              userId: receiverId,
              title: 'New Message',
              message: `${senderData?.fullName} has sent you a message.`,
              type: 'message',
              fortype: 'customer_support',
              permission: 'help',
              linkUrl:
                receiversData?.role === 'vendor'
                  ? `/vendor-dashboard/vendor-inbox?chatId=${chat._id}`
                  : receiversData?.role === 'admin'
                    ? `/admin-dashboard/admin-inbox?chatId=${chat._id}`
                    : `/user-dashboard/user-inbox?chatId=${chat._id}`
            });
          }

          chatId = chat._id;
        }

        const chatDetailsQuery = {
          ...(chatId ? { _id: chatId } : { participants: { $all: [userId, receiverId] } })
        };
        const chatDetails = await ChatsModel.findOne(chatDetailsQuery).populate('participants');
        if (!chatDetails) {
          socket.emit('socket-error', {
            message: 'No chat found against chat id and participants.'
          });
          return;
        }

        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];

        const messageBody = {
          chat: chatId,
          sender: userId,
          contentTitle: data?.contentTitle,
          fileSize: data?.fileSize,
          content: data?.content,
          contentDescription: data?.contentDescription,
          contentType: data?.contentType,
          contentDescriptionType: data?.contentDescriptionType,
          userSettings: userSettingsBody,
          bookingId: bookingId,
          alert_result: data?.alert_result,
          staff: staff?._id
        };
        const addMessage = await MessagesModel.create(messageBody);

        // Update chat with lastMessage and lastMessageSentAt so inbox sort is always correct
        await ChatsModel.findByIdAndUpdate(chatId, {
          lastMessage: addMessage._id,
          lastMessageSentAt: addMessage.createdAt
        });

        const latestMessageData = addMessage;

        const messageEmitBody = {
          chatScreenBody: {
            chatId,
            isGroup: chatDetails?.isGroup ?? false,
            GroupcreatedBy: chatDetails?.GroupcreatedBy,
            chatType: chatDetails?.chatType,
            latestMessage: addMessage?.content ?? '',
            latestMessageId: addMessage?._id,
            latestMessageType: addMessage?.contentType ?? 'text',
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            latestMessageSentAt: addMessage?.createdAt,
            latestMessageTitle: addMessage?.contentTitle ?? '',
            fileSize: addMessage?.fileSize ?? '',
            latestMessageDescription: addMessage?.contentDescription ?? '',
            participants:
              chatDetails?.participants.map((participant) => ({
                userId: participant?._id,
                fullName: participant?.fullName,
                profilePicture: participant?.profilePicture ?? defaultImage
              })) ?? []
          },
          messageScreenBody: {
            chatId,
            messageId: addMessage?._id,
            bookingId,
            sender: {
              _id: userId,
              name: senderData?.fullName,
              profilePicture: senderData?.profilePicture ?? defaultImage
            },
            content: addMessage?.content,
            latestMessageSentAt: addMessage?.createdAt,
            contentTitle: addMessage?.contentTitle,
            fileSize: addMessage?.fileSize ?? '',
            contentDescription: addMessage?.contentDescription,
            contentType: addMessage?.contentType,
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            alert_result: addMessage?.alert_result,
            staff: staff
              ? {
                  _id: staff?._id,
                  name: staff?.fullName,
                  staffRole: staff?.staffRole,
                  profilePicture: staff?.profilePicture ?? defaultImage
                }
              : undefined
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};
        for (const receiver of receiversData) {
          const receiverID = receiver?._id; // Ensure you have the ID from receiver object
          const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());
          console.log('data..................data...........', data);

          if (receiverSocketId) {
            if (
              data?.alert_result?.alert === 'True' &&
              data?.alert_result?.isAllowed === 'True' &&
              ['completed', 'booked'].includes(findBooking?.status)
            ) {
              userSettingsBody.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            } else if (
              data?.alert_result?.alert === 'False' &&
              data?.alert_result?.isAllowed === 'True'
            ) {
              userSettingsBody.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            } else if (
              !bookingId &&
              data?.alert_result?.alert === 'True' &&
              data?.alert_result?.isAllowed === 'True'
            ) {
              userSettingsBody.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            } else if (data?.contentType !== 'text') {
              userSettingsBody.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            }
          }

          const unreadCount = await Messages.countDocuments({
            chat: { $in: chatId },
            'alert_result.isAllowed': { $ne: 'False' },
            $or: [
              { userSettings: { $size: 0 } },
              { 'userSettings.userId': { $ne: receiverID } },
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

          if (receiverID.toString() !== userId.toString()) {
            if (
              (
                data?.alert_result?.alert === 'True' &&
                data?.alert_result?.isAllowed === 'True' &&
                ['completed', 'booked'].includes(findBooking?.status)) ||
              (
                data?.alert_result?.alert === 'False' &&
                data?.alert_result?.isAllowed === 'True') ||
              (
                !bookingId &&
                data?.alert_result?.alert === 'True' &&
                data?.alert_result?.isAllowed === 'True') || data?.contentType !== 'text'
            ) {
              io.to(receiverID.toString()).emit('receive-message', {
                ...messageEmitBody,
                unreadCounts: unreadCount,
                chatScreenBody: {
                  ...messageEmitBody.chatScreenBody,
                  chatName: chatNameForUser(chatDetails, receiverID),
                  displayPicture: chatProfileForUser(chatDetails, receiverID)
                }
              });
              io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId,
                allMsgsDelivered: true
              });

              // if (!receiver?.activeChat || receiver?.activeChat.toString() !== chatId.toString()) {
                sendNotification({
                  userId: receiverID,
                  title: 'New Message',
                  message: `You have a new message from ${senderData?.fullName}`,
                  type: 'message',
                  fortype: 'customer_support',
                  permission: 'help',
                  linkUrl:
                    receiver?.role === 'vendor'
                      ? `/vendor-dashboard/vendor-inbox?chatId=${chatDetails._id}`
                      : receiver?.role === 'admin'
                        ? `/admin-dashboard/admin-inbox?chatId=${chatDetails._id}`
                        : `/user-dashboard/user-inbox?chatId=${chatDetails._id}`
                });
              // }
            }
          }
        }
        ///////////////////////////////////////////////////////////

        if (data?.alert_result?.alert === 'True') {
          const findAdmin = await UsersModel.findOne({ role: 'admin' });
          sendNotification({
            userId: findAdmin._id,
            title: 'Alert',
            message: bookingId
              ? `${senderData?.fullName} may be attempting to chat in an unauthorized way  in booking of service '${findBooking?.service?.title}': message: ${data?.content} : Allowed: ${data?.alert_result?.isAllowed}`
              : `${senderData?.fullName} may be attempting to chat in an unauthorized way message: ${data?.content} : Allowed: ${data?.alert_result?.isAllowed}`,
            type: 'alert',
            fortype: 'customer_support',
            permission: 'help',
            linkUrl: bookingId
              ? `/admin-dashboard/chat-details/${bookingId}`
              : `/admin-dashboard/chat-messages/${chatId}`
          });
        }

        console.log('userSettingsBody', userSettingsBody, addMessage._id);
        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        await MessagesModel.updateOne(
          { _id: addMessage._id },
          { userSettings: userSettingsBody },
          {
            multi: true
          }
        );

        io.to(userId.toString()).emit('receive-message', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chatDetails, userId), // Set chatName for the sender
            displayPicture: chatProfileForUser(chatDetails, userId), // Set displayPicture for the sender,
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });

        // Define these before the auto-reply block so they can be reused
        const objectChatId = new mongoose.Types.ObjectId(chatId);
        const objectUserId = new mongoose.Types.ObjectId(userId);

        if (data?.reply_result?.sender && data?.reply_result?.answer) {
          const userSettingsBody1 = [
            {
              userId: data?.reply_result?.sender,
              deliveredAt: new Date(),
              readAt: new Date()
            }
          ];
          const findSaveSender = await UsersModel.findById(data?.reply_result?.sender);

          const messageBody1 = {
            chat: chatId,
            sender: data?.reply_result?.sender,
            content: data?.reply_result?.answer,
            contentType: data?.contentType,
            contentDescriptionType: data?.contentDescriptionType,
            userSettings: userSettingsBody1,
            bookingId: bookingId
          };
          const addMessage1 = await MessagesModel.create(messageBody1);

          const latestMessageData1 = addMessage1;

          const messageEmitBody1 = {
            chatScreenBody: {
              chatId,
              isGroup: chatDetails?.isGroup ?? false,
              GroupcreatedBy: chatDetails?.GroupcreatedBy,
              chatType: chatDetails?.chatType,
              latestMessage: addMessage1?.content ?? '',
              latestMessageId: addMessage1?._id,
              latestMessageType: addMessage1?.contentType ?? 'text',
              contentDescriptionType: addMessage1?.contentDescriptionType ?? 'text',
              latestMessageSentAt: addMessage1?.createdAt,
              latestMessageTitle: addMessage1?.contentTitle ?? '',
              fileSize: addMessage1?.fileSize ?? '',
              latestMessageDescription: addMessage1?.contentDescription ?? '',
              participants:
                chatDetails?.participants.map((participant) => ({
                  userId: participant?._id,
                  fullName: participant?.fullName,
                  profilePicture: participant?.profilePicture ?? defaultImage
                })) ?? []
            },
            messageScreenBody: {
              chatId,
              messageId: addMessage1?._id,
              bookingId,
              sender: {
                _id: findSaveSender?._id,
                name: findSaveSender?.fullName,
                profilePicture: findSaveSender?.profilePicture ?? defaultImage
              },
              content: addMessage1?.content,
              latestMessageSentAt: addMessage1?.createdAt,
              contentTitle: addMessage1?.contentTitle,
              fileSize: addMessage1?.fileSize ?? '',
              contentDescription: addMessage1?.contentDescription,
              contentType: addMessage1?.contentType,
              contentDescriptionType: addMessage1?.contentDescriptionType ?? 'text',
              alert_result: addMessage1?.alert_result
            }
          };

          const messageDeliveryStatus =
            msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData1 } }) || {};
          for (const receiver of receiversData) {
            const receiverID = receiver?._id; // Ensure you have the ID from receiver object
            const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());
            console.log(
              'alert_result',
              data?.alert_result?.alert,
              data?.alert_result?.isAllowed,
              ['completed', 'booked'].includes(findBooking.status)
            );

            if (
              data?.alert_result?.alert === 'True' &&
              data?.alert_result?.isAllowed === 'True' &&
              ['completed', 'booked'].includes(findBooking.status)
            ) {
              userSettingsBody1.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            } else if (
              data?.alert_result?.alert === 'False' &&
              data?.alert_result?.isAllowed === 'True'
            ) {
              userSettingsBody1.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            } else if (
              !bookingId &&
              data?.alert_result?.alert === 'True' &&
              data?.alert_result?.isAllowed === 'True'
            ) {
              userSettingsBody1.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            }else if (data?.contentType !== 'text') {
              userSettingsBody1.push({
                userId: receiverID,
                deliveredAt: new Date()
              });
            }

            const unreadCount = await Messages.countDocuments({
              chat: { $in: chatId },
              'alert_result.isAllowed': { $ne: 'False' },
              $or: [
                { userSettings: { $size: 0 } },
                { 'userSettings.userId': { $ne: receiverID } },
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

            if (receiverID.toString() !== userId.toString()) {
              if (
                (receiverSocketId &&
                  data?.alert_result?.alert === 'True' &&
                  data?.alert_result?.isAllowed === 'True' &&
                  ['completed', 'booked'].includes(findBooking.status)) ||
                (receiverSocketId &&
                  data?.alert_result?.alert === 'False' &&
                  data?.alert_result?.isAllowed === 'True') || data?.contentType !== 'text'
              ) {
                io.to(receiverID.toString()).emit('receive-message', {
                  ...messageEmitBody1,
                  unreadCounts: unreadCount,
                  chatScreenBody: {
                    ...messageEmitBody1.chatScreenBody,
                    chatName: chatNameForUser(chatDetails, receiverID),
                    displayPicture: chatProfileForUser(chatDetails, receiverID)
                  }
                });
                io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                  success: true,
                  chatId,
                  allMsgsDelivered: true
                });
              }
            }
          }

          io.to(userId.toString()).emit('receive-message', {
            ...messageEmitBody1,
            chatScreenBody: {
              ...messageEmitBody1.chatScreenBody,
              unreadCount: 0,
              chatName: chatNameForUser(chatDetails, userId), // Set chatName for the sender
              displayPicture: chatProfileForUser(chatDetails, userId), // Set displayPicture for the sender,
              ...(Object.keys(messageDeliveryStatus || {})?.length && {
                ...messageDeliveryStatus
              })
            }
          });
          await MessagesModel.updateOne(
            { _id: addMessage1._id },
            { userSettings: userSettingsBody1 },
            {
              multi: true
            }
          );

          // Update chat with the auto-reply as the latest message

          const updateChatBodyForReply = {
            lastMessage: addMessage1?._id,
            lastMessageSentAt: new Date(),
            'userSettings.$[elem].hasUserDeletedChat': false
          };

          await ChatsModel.updateOne(
            { _id: objectChatId },
            { $set: updateChatBodyForReply },
            {
              arrayFilters: [{ 'elem.userId': objectUserId }]
            }
          );
        }

        if (
          (data?.alert_result?.alert === 'True' &&
            data?.alert_result?.isAllowed === 'True' &&
            ['completed', 'booked'].includes(findBooking.status)) ||
          (data?.alert_result?.alert === 'False' && data?.alert_result?.isAllowed === 'True') ||
          (!bookingId &&
            data?.alert_result?.alert === 'True' &&
            data?.alert_result?.isAllowed === 'True')
        ) {
          const updateChatBody = {
            lastMessage: addMessage?._id,
            lastMessageSentAt: new Date(),
            'userSettings.$[elem].hasUserDeletedChat': false
          };

          await ChatsModel.updateOne(
            { _id: objectChatId },
            { $set: updateChatBody },
            {
              arrayFilters: [{ 'elem.userId': objectUserId }]
            }
          );
        }
        const allChatMessages = await MessagesModel.find({
          chat: chatId,
          alert_result: { $ne: { isAllowed: 'False' } }
        }).distinct('_id');
        await updateReadAt({
          userId,
          chatId,
          messageIds: allChatMessages
        });

        chatDetails.markModified('userSettings');
      } catch (error) {
        console.log(error);

        socket.emit('socket-error', { message: 'Failed to send message' });
        return;
      }
    });

    ////////////////////////////////get single chat for user /////////////////////////
    socket.on('get-user-single-chat', async (data) => {
      try {
        let receiverId = data?.receiverId;

        if (!data?.chatType) {
          socket.emit('socket-error', { message: 'chatType is required.' });
          return;
        }

        if (receiverId && typeof receiverId === 'object' && receiverId._id) {
          receiverId = receiverId._id.toString();
        }
        if (!receiverId && data?.chatType !== 'contact') {
          socket.emit('socket-error', { message: 'Receiver id or chat id is required.' });
          return;
        }

        let receiverData;
        if (!receiverId && data?.chatType !== 'contact') {
          socket.emit('socket-error', { message: `Failed to retreive receiver data.` });
          return;
        }

        if (data?.chatType === 'contact' && !receiverId) {
          receiverData = await UsersModel.findOne({ adminRole: 'admin' });
          receiverId = receiverData?._id.toString();
        } else {
          receiverData = await UsersModel.findById(receiverId.toString());
        }

        if (!receiverData) {
          socket.emit('socket-error', { message: `Invalid receiver data.` });
          return;
        }

        let chatId = data?.chatId;

        if (!chatId) {
          let chat;

          // Case when chatting with oneself
          if (userId.toString?.() === receiverId.toString?.()) {
            socket.emit('with-me', { message: 'chat with me' });

            return;
          } else {
            chat = await ChatsModel.findOne({
              chatType: data?.chatType,
              participants: { $all: [userId, receiverId], $size: 2 }
            });
          }

          if (!chat) {
            chat = await ChatsModel.create({
              participants: [userId, receiverId],
              chatType: data?.chatType
            });
          }

          chatId = chat._id;
        }

        const chatDetailsQuery = {
          ...(chatId ? { _id: chatId } : { participants: { $all: [userId, receiverId] } })
        };
        const chatDetails = await ChatsModel.findOne(chatDetailsQuery).populate('participants');
        if (!chatDetails) {
          socket.emit('socket-error', {
            message: 'No chat found against chat id and participants.'
          });
          return;
        }

        chatDetails.markModified('userSettings');
        await chatDetails.save();
        const chatName =
          userId.toString() === receiverId.toString()
            ? `${chatDetails?.participants?.find((participant) => participant?._id?.toString() === userId.toString())?.fullName} (You)`
            : chatDetails?.participants?.find(
                (participant) => participant?._id?.toString() !== userId.toString()
              )?.fullName;

        const receiverSocketId = io.sockets.adapter.rooms.get(receiverId?.toString?.());
        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];
        if (receiverSocketId) {
          userSettingsBody.push({
            userId: receiverId,
            deliveredAt: new Date()
          });
        }

        const latestMessageData = await Messages.findOne({ chat: chatId });

        const unreadCount = await Messages.countDocuments({
          chat: { $in: chatId },
          'alert_result.isAllowed': { $ne: 'False' },
          $or: [
            { userSettings: { $size: 0 } },
            { 'userSettings.userId': { $ne: receiverId } },
            {
              userSettings: {
                $elemMatch: {
                  userId: receiverId,
                  $or: [{ readAt: null }, { readAt: { $exists: false } }]
                }
              }
            }
          ]
        });

        const messageEmitBody = {
          chatScreenBody: {
            chatId,
            chatName,
            chatType: chatDetails?.chatType,
            isGroup: chatDetails?.isGroup ?? false,
            GroupcreatedBy: chatDetails?.GroupcreatedBy,
            receiverId,
            latestMessage: latestMessageData?.content ?? '',
            latestMessageId: latestMessageData?._id,
            latestMessageType: latestMessageData?.contentType ?? 'text',
            contentDescriptionType: latestMessageData?.contentDescriptionType ?? 'text',
            latestMessageSentAt: latestMessageData?.createdAt,
            latestMessageTitle: latestMessageData?.contentTitle ?? '',
            fileSize: latestMessageData?.fileSize ?? '',
            latestMessageDescription: latestMessageData?.contentDescription ?? '',
            unreadCount: unreadCount,
            participants:
              chatDetails?.participants.map((participant) => ({
                userId: participant?._id,
                fullName: participant?.fullName,
                profilePicture: participant?.profilePicture ?? defaultImage
              })) ?? []
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};
        io.to(userId.toString()).emit('get-single-chat', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chatDetails, userId), // Set chatName for the sender
            displayPicture: chatProfileForUser(chatDetails, userId), // Set displayPicture for the sender,
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });
      } catch (error) {
        console.log(error);

        socket.emit('socket-error', { message: 'Failed to send message' });
        return;
      }
    });

    /////////////////////////////////create  group //////////////////////////////////////
    socket.on('create-group', async (data) => {
      try {
        const { participants, chatPicture, chatName, chatType = 'contact' } = data;
        if (!chatName || !participants || participants.length < 1 || !chatPicture) {
          socket.emit('socket-error', {
            message: 'Group name, participants and chat picture are required.'
          });
          return;
        }
        if (user.role === 'customer') {
          const findBookings = await Bookings.find({
            user: userId,
            status: { $in: ['completed', 'booked'] }
          });
          if (!findBookings || findBookings.length === 0) {
            socket.emit('socket-error', {
              message: 'Customer must have at least one booking to create a group chat.'
            });
            return;
          }
        }

        if (user.role === 'vendor') {
          const findBookings = await Bookings.aggregate([
            {
              $match: {
                status: { $in: ['completed', 'booked'] }
              }
            },
            {
              $lookup: {
                from: 'servicelistings',
                localField: 'service',
                foreignField: '_id',
                as: 'serviceDetails'
              }
            },
            { $unwind: '$serviceDetails' },
            {
              $match: { 'serviceDetails.vendorId': new mongoose.Types.ObjectId(userId) }
            }
          ]);
          if (!findBookings || findBookings.length === 0) {
            socket.emit('socket-error', {
              message: 'Vendor must have at least one booking to create a group chat.'
            });
            return;
          }
        }
        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];

        const chat = await createGroupChat({ ...data, userId, chatType });
        const findchat = await Chat.findById(chat?._id).populate('participants');
        const messageBody = {
          chat: chat._id,
          sender: userId,
          contentTitle: 'Group Created',
          content: `Group created by ${user?.fullName}`,
          userSettings: userSettingsBody
        };
        const addMessage = await MessagesModel.create(messageBody);

        const latestMessageData = addMessage;

        const messageEmitBody = {
          chatScreenBody: {
            chatId: chat._id,
            chatType: chat?.chatType,
            latestMessage: addMessage?.content ?? '',
            latestMessageId: addMessage?._id,
            latestMessageType: addMessage?.contentType ?? 'text',
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            latestMessageSentAt: addMessage?.createdAt,
            latestMessageTitle: addMessage?.contentTitle ?? '',
            fileSize: addMessage?.fileSize ?? '',
            latestMessageDescription: addMessage?.contentDescription ?? '',
            participants:
              findchat?.participants.map((participant) => ({
                userId: participant?._id,
                fullName: participant?.fullName,
                profilePicture: participant?.profilePicture ?? defaultImage
              })) ?? [],
            isGroup: true,
            GroupcreatedBy: chat?.GroupcreatedBy
          },
          messageScreenBody: {
            chatId: chat._id,
            messageId: addMessage?._id,
            sender: {
              _id: userId,
              name: user?.fullName,
              profilePicture: user?.profilePicture ?? defaultImage
            },
            content: addMessage?.content,
            latestMessageSentAt: addMessage?.createdAt,
            contentTitle: addMessage?.contentTitle,
            fileSize: addMessage?.fileSize ?? '',
            contentDescription: addMessage?.contentDescription,
            contentType: addMessage?.contentType,
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text'
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};

        const receiversData = await UsersModel.find({ _id: { $in: participants } });

        for (const receiver of receiversData) {
          const receiverID = receiver?._id; // Ensure you have the ID from receiver object
          const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());

          if (receiverSocketId) {
            userSettingsBody.push({
              userId: receiverID,
              deliveredAt: new Date()
            });
          }
          const unreadCount = await Messages.countDocuments({
            chat: { $in: chat._id },
            'alert_result.isAllowed': { $ne: 'False' },
            $or: [
              { userSettings: { $size: 0 } },
              { 'userSettings.userId': { $ne: receiverID } },
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

          if (receiverID.toString() !== userId.toString()) {
            if (receiverSocketId) {
              io.to(receiverID.toString()).emit('receive-message', {
                ...messageEmitBody,
                unreadCounts: unreadCount,
                chatScreenBody: {
                  ...messageEmitBody.chatScreenBody,
                  chatName: chatNameForUser(chat, receiverID),
                  displayPicture: chatProfileForUser(chat, receiverID)
                }
              });
              io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId: chat?._id,
                allMsgsDelivered: true
              });
            }
          }
          console.log('sending notification to ', receiver?.role?.toString());
          sendNotification({
            userId: receiverID,
            title: 'New Group Chat Member',
            message: `${user?.fullName} added you to the group chat "${chatName}"`,
            type: 'message',
            fortype: 'customer_support',
            permission: 'help',
            linkUrl:
              receiver?.role === 'vendor'
                ? `/vendor-dashboard/vendor-inbox?chatId=${chat._id}`
                : receiver?.role === 'admin'
                  ? `/admin-dashboard/admin-inbox?chatId=${chat._id}`
                  : `/user-dashboard/user-inbox?chatId=${chat._id}`
          });
        }

        await MessagesModel.updateOne(
          { _id: addMessage._id },
          { userSettings: userSettingsBody },
          {
            multi: true
          }
        );

        // Update chat with lastMessage and lastMessageSentAt
        await ChatsModel.findByIdAndUpdate(chat._id, {
          lastMessage: addMessage._id,
          lastMessageSentAt: addMessage.createdAt
        });

        io.to(userId.toString()).emit('receive-message', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chat, userId), // Set chatName for the sender
            displayPicture: chatProfileForUser(chat, userId), // Set displayPicture for the sender,
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });
      } catch (error) {
        console.log(`Got error in create-group: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in creating group.' });
      }
    });

    socket.on('add-members-Ingroup', async (data1) => {
      try {
        const { participants, chatId } = data1;
        if (!chatId || !participants || participants.length < 1) {
          socket.emit('socket-error', { message: 'Chat ID and participants are required.' });
          return;
        }

        const findchat = await ChatsModel.findById(chatId).populate('participants');
        if (
          !findchat?.GroupcreatedBy ||
          (findchat?.GroupcreatedBy.toString() !== userId.toString() && user.role !== 'admin')
        ) {
          socket.emit('socket-error', { message: 'Chat not found.' });
          return;
        }

        const data = await addMemberinGroup({ ...data1, userId });

        if (data?.success === false) {
          socket.emit('socket-error', {
            message: data?.message ?? 'Failed to add members to group'
          });
          return;
        }

        const chat = data?.chat;
        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];
        const filteredParticipants = chat.participants.filter(
          (participant) => participant.toString() !== userId.toString()
        );
        const receiversData = await UsersModel.find({ _id: { $in: filteredParticipants } });
        const filteredNewMembers = receiversData.filter((receiver) =>
          data?.newParticipants?.includes(receiver?._id.toString())
        );

        const allParticipants = [
          {
            userId: userId,
            fullName: user?.fullName,
            profilePicture: user?.profilePicture ?? defaultImage
          },
          ...receiversData.map((member) => ({
            userId: member._id,
            fullName: member.fullName,
            profilePicture: member.profilePicture ?? defaultImage
          }))
        ];

        const messageBody = {
          chat: chat._id,
          sender: userId,
          contentTitle: 'Add members in group',
          content: `${filteredNewMembers.map((member) => member.firstName).join(', ')} added to the group.`,
          userSettings: userSettingsBody
        };
        const addMessage = await MessagesModel.create(messageBody);
        const latestMessageData = addMessage;

        const messageEmitBody = {
          chatScreenBody: {
            chatId: chat._id,
            chatType: chat?.chatType,
            latestMessage: addMessage?.content ?? '',
            latestMessageId: addMessage?._id,
            latestMessageType: addMessage?.contentType ?? 'text',
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            latestMessageSentAt: addMessage?.createdAt,
            latestMessageTitle: addMessage?.contentTitle ?? '',
            fileSize: addMessage?.fileSize ?? '',
            latestMessageDescription: addMessage?.contentDescription ?? '',
            participants: allParticipants,
            isGroup: chat?.isGroup ?? false,
            GroupcreatedBy: chat?.GroupcreatedBy
          },
          messageScreenBody: {
            chatId: chat._id,
            messageId: addMessage?._id,
            sender: {
              _id: userId,
              name: user?.fullName,
              profilePicture: user?.profilePicture ?? defaultImage
            },
            content: addMessage?.content,
            latestMessageSentAt: addMessage?.createdAt,
            contentTitle: addMessage?.contentTitle,
            fileSize: addMessage?.fileSize ?? '',
            contentDescription: addMessage?.contentDescription,
            contentType: addMessage?.contentType,
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text'
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};

        for (const receiver of receiversData) {
          const receiverID = receiver?._id; // Ensure you have the ID from receiver object
          const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());

          if (receiverSocketId) {
            userSettingsBody.push({
              userId: receiverID,
              deliveredAt: new Date()
            });
          }
          const unreadCount = await Messages.countDocuments({
            chat: { $in: chat._id },
            $or: [
              { userSettings: { $size: 0 } },
              { 'userSettings.userId': { $ne: receiverID } },
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

          if (receiverID.toString() !== userId.toString()) {
            if (receiverSocketId) {
              io.to(receiverID.toString()).emit('receive-message', {
                ...messageEmitBody,
                unreadCounts: unreadCount,
                chatScreenBody: {
                  ...messageEmitBody.chatScreenBody,
                  chatName: chatNameForUser(chat, receiverID),
                  displayPicture: chatProfileForUser(chat, receiverID)
                }
              });
              io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId,
                allMsgsDelivered: true
              });
            }
          }

          sendNotification({
            userId: receiverID,
            title: 'New Group Chat Member',
            message: `${user?.fullName} added you to the group chat "${chatNameForUser(chat, receiverID)}"`,
            type: 'message',
            fortype: 'customer_support',
            permission: 'help',
            linkUrl:
              receiver?.role === 'vendor'
                ? `/vendor-dashboard/vendor-inbox?chatId=${chat._id}`
                : receiver?.role === 'admin'
                  ? `/admin-dashboard/admin-inbox?chatId=${chat._id}`
                  : `/user-dashboard/user-inbox?chatId=${chat._id}`
          });
        }

        await MessagesModel.updateOne(
          { _id: addMessage._id },
          { userSettings: userSettingsBody },
          {
            multi: true
          }
        );

        // Update chat with lastMessage and lastMessageSentAt
        await ChatsModel.findByIdAndUpdate(chat._id, {
          lastMessage: addMessage._id,
          lastMessageSentAt: addMessage.createdAt
        });

        io.to(userId.toString()).emit('receive-message', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chat, userId), // Set chatName for the sender
            displayPicture: chatProfileForUser(chat, userId), // Set displayPicture for the sender,
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });
      } catch (error) {
        socket.emit('socket-error', { message: 'Error in creating group.' });
      }
    });
    socket.on('remove-members-Ingroup', async (data1) => {
      try {
        const { participants, chatId } = data1;
        if (!chatId || !participants || participants.length < 1) {
          socket.emit('socket-error', { message: 'Chat ID and participants are required.' });
          return;
        }
        const findchat = await ChatsModel.findById(chatId).populate('participants');
        if (
          !findchat?.GroupcreatedBy ||
          (findchat?.GroupcreatedBy.toString() !== userId.toString() && user.role !== 'admin')
        ) {
          socket.emit('socket-error', { message: 'Chat not found.' });
          return;
        }
        const data = await removeMembersFromGroup({ ...data1, userId });

        if (data?.success === false) {
          socket.emit('socket-error', {
            message: data?.message ?? 'Failed to remove members from group'
          });
          return;
        }

        const chat = data?.chat;
        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];
        const filteredParticipants = chat.participants.filter(
          (participant) => participant.toString() !== userId.toString()
        );

        const receiversData = await UsersModel.find({ _id: { $in: filteredParticipants } });

        const filteredRemoveMembers = await UsersModel.find({ _id: { $in: data?.removedMembers } });

        const allParticipants = [
          !data1?.participants.includes(userId.toString()) && {
            userId: userId,
            fullName: user?.fullName,
            profilePicture: user?.profilePicture ?? defaultImage
          },
          ...receiversData.map((member) => ({
            userId: member._id,
            fullName: member.fullName,
            profilePicture: member.profilePicture ?? defaultImage
          }))
        ];

        const messageBody = {
          chat: chat._id,
          sender: userId,
          contentTitle: 'Remove members from group',
          content: `${filteredRemoveMembers.map((member) => member.firstName).join(', ')} removed from the group.`,
          userSettings: userSettingsBody
        };
        const addMessage = await MessagesModel.create(messageBody);
        const latestMessageData = addMessage;

        const messageEmitBody = {
          chatScreenBody: {
            chatId: chat._id,
            chatType: chat?.chatType,
            latestMessage: addMessage?.content ?? '',
            latestMessageId: addMessage?._id,
            latestMessageType: addMessage?.contentType ?? 'text',
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            latestMessageSentAt: addMessage?.createdAt,
            latestMessageTitle: addMessage?.contentTitle ?? '',
            fileSize: addMessage?.fileSize ?? '',
            latestMessageDescription: addMessage?.contentDescription ?? '',
            participants: allParticipants,
            isGroup: chat?.isGroup ?? false,
            GroupcreatedBy: chat?.GroupcreatedBy
          },
          messageScreenBody: {
            chatId: chat._id,
            messageId: addMessage?._id,
            sender: {
              _id: userId,
              name: user?.fullName,
              profilePicture: user?.profilePicture ?? defaultImage
            },
            content: addMessage?.content,
            latestMessageSentAt: addMessage?.createdAt,
            contentTitle: addMessage?.contentTitle,
            fileSize: addMessage?.fileSize ?? '',
            contentDescription: addMessage?.contentDescription,
            contentType: addMessage?.contentType,
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text'
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};

        for (const receiver of receiversData) {
          const receiverID = receiver?._id; // Ensure you have the ID from receiver object
          const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());

          if (receiverSocketId) {
            userSettingsBody.push({
              userId: receiverID,
              deliveredAt: new Date()
            });
          }
          const unreadCount = await Messages.countDocuments({
            chat: { $in: chat._id },
            $or: [
              { userSettings: { $size: 0 } },
              { 'userSettings.userId': { $ne: receiverID } },
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

          if (receiverID.toString() !== userId.toString()) {
            if (receiverSocketId) {
              io.to(receiverID.toString()).emit('receive-message', {
                ...messageEmitBody,
                unreadCounts: unreadCount,
                chatScreenBody: {
                  ...messageEmitBody.chatScreenBody,
                  chatName: chatNameForUser(chat, receiverID),
                  displayPicture: chatProfileForUser(chat, receiverID)
                }
              });
              io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId,
                allMsgsDelivered: true
              });
            }
          }
          sendNotification({
            userId: receiverID,
            title: 'Member Removed from Group Chat',
            message: `${user?.fullName} has removed ${filteredRemoveMembers.map((member) => member.firstName).join(', ')} from the group chat "${chatNameForUser(chat, receiverID)}"`,
            type: 'message',
            fortype: 'customer_support',
            permission: 'help',
            linkUrl:
              receiver?.role === 'vendor'
                ? `/vendor-dashboard/vendor-inbox?chatId=${chat._id}`
                : receiver?.role === 'admin'
                  ? `/admin-dashboard/admin-inbox?chatId=${chat._id}`
                  : `/user-dashboard/user-inbox?chatId=${chat._id}`
          });
        }

        await MessagesModel.updateOne(
          { _id: addMessage._id },
          { userSettings: userSettingsBody },
          {
            multi: true
          }
        );

        // Update chat with lastMessage and lastMessageSentAt
        await ChatsModel.findByIdAndUpdate(chat._id, {
          lastMessage: addMessage._id,
          lastMessageSentAt: addMessage.createdAt
        });

        io.to(userId.toString()).emit('receive-message', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chat, userId), // Set chatName for the sender
            displayPicture: chatProfileForUser(chat, userId), // Set displayPicture for the sender,
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });
      } catch (error) {
        console.log(`Got error in create-group: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in creating group.' });
      }
    });

    socket.on('change-onetoone-InGroup', async (data) => {
      const { chatId, chatName, chatPicture } = data;

      if (!chatId || !chatName || !chatPicture) {
        socket.emit('socket-error', { message: 'Chat ID, Name and Picture are required.' });
        return;
      }

      const findchat = await ChatsModel.findById(chatId).populate('participants');
      if (!findchat || findchat.isGroup) {
        socket.emit('socket-error', { message: 'Chat not found or is already a group chat.' });
        return;
      }
      const receiversData = findchat.participants.filter(
        (participant) => participant._id.toString() !== userId.toString()
      );

      const chat = await ChatsModel.findByIdAndUpdate(
        chatId,
        {
          isGroup: true,
          chatName,
          GroupcreatedBy: userId,
          chatPicture
        },
        { new: true }
      );
      const userSettingsBody = [
        {
          userId,
          deliveredAt: new Date(),
          readAt: new Date()
        }
      ];
      const messageBody = {
        chat: chat._id,
        sender: userId,
        contentTitle: 'Chat change into group',
        content: `Chat changed to group`,
        userSettings: userSettingsBody
      };
      const addMessage = await MessagesModel.create(messageBody);
      const latestMessageData = addMessage;

      const messageEmitBody = {
        chatScreenBody: {
          chatId: chat._id,
          chatType: chat?.chatType,
          latestMessage: addMessage?.content ?? '',
          latestMessageId: addMessage?._id,
          latestMessageType: addMessage?.contentType ?? 'text',
          contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
          latestMessageSentAt: addMessage?.createdAt,
          latestMessageTitle: addMessage?.contentTitle ?? '',
          fileSize: addMessage?.fileSize ?? '',
          latestMessageDescription: addMessage?.contentDescription ?? '',
          isGroup: chat?.isGroup ?? false,
          GroupcreatedBy: chat?.GroupcreatedBy,
          participants:
            findchat?.participants.map((participant) => ({
              userId: participant._id,
              fullName: participant.fullName,
              profilePicture: participant.profilePicture ?? defaultImage
            })) ?? []
        },
        messageScreenBody: {
          chatId: chat._id,
          messageId: addMessage?._id,
          sender: {
            _id: userId,
            name: user?.fullName,
            profilePicture: user?.profilePicture ?? defaultImage
          },
          content: addMessage?.content,
          latestMessageSentAt: addMessage?.createdAt,
          contentTitle: addMessage?.contentTitle,
          fileSize: addMessage?.fileSize ?? '',
          contentDescription: addMessage?.contentDescription,
          contentType: addMessage?.contentType,
          contentDescriptionType: addMessage?.contentDescriptionType ?? 'text'
        }
      };

      const messageDeliveryStatus =
        msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};

      for (const receiver of receiversData) {
        const receiverID = receiver?._id; // Ensure you have the ID from receiver object
        const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());

        if (receiverSocketId) {
          userSettingsBody.push({
            userId: receiverID,
            deliveredAt: new Date()
          });
        }
        const unreadCount = await Messages.countDocuments({
          chat: { $in: chat._id },
          $or: [
            { userSettings: { $size: 0 } },
            { 'userSettings.userId': { $ne: receiverID } },
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

        if (receiverID.toString() !== userId.toString()) {
          if (receiverSocketId) {
            io.to(receiverID.toString()).emit('receive-message', {
              ...messageEmitBody,
              unreadCounts: unreadCount,
              chatScreenBody: {
                ...messageEmitBody.chatScreenBody,
                chatName: chatNameForUser(chat, receiverID),
                displayPicture: chatProfileForUser(chat, receiverID)
              }
            });
            io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
              success: true,
              chatId,
              allMsgsDelivered: true
            });
          }
        }
      }

      await MessagesModel.updateOne(
        { _id: addMessage._id },
        { userSettings: userSettingsBody },
        {
          multi: true
        }
      );

      // Update chat with lastMessage and lastMessageSentAt
      await ChatsModel.findByIdAndUpdate(chat._id, {
        lastMessage: addMessage._id,
        lastMessageSentAt: addMessage.createdAt
      });

      io.to(userId.toString()).emit('receive-message', {
        ...messageEmitBody,
        chatScreenBody: {
          ...messageEmitBody.chatScreenBody,
          unreadCount: 0,
          chatName: chatNameForUser(chat, userId), // Set chatName for the sender
          displayPicture: chatProfileForUser(chat, userId), // Set displayPicture for the sender,
          ...(Object.keys(messageDeliveryStatus || {})?.length && {
            ...messageDeliveryStatus
          })
        }
      });
    });

    socket.on('update-chat', async (data) => {
      try {
        const { chatId, chatName, chatPicture } = data;
        if (!chatId) {
          console.log(`Chat ID is required in update-chat`);
          socket.emit('socket-error', { message: 'Chat ID is required.' });
          return;
        }
        if (!chatName && !chatPicture) {
          console.log(`One of Name and Picture are required in update-chat`);
          socket.emit('socket-error', { message: 'One of Name and Picture are required.' });
          return;
        }
        const findchat = await ChatsModel.findById(chatId).populate('participants');
        if (
          !findchat?.GroupcreatedBy ||
          (findchat?.GroupcreatedBy.toString() !== userId.toString() && user.role !== 'admin')
        ) {
          socket.emit('socket-error', { message: 'Chat not found.' });
          return;
        }
        const chat = await ChatsModel.findByIdAndUpdate(
          chatId,
          { chatName, chatPicture },
          { new: true }
        ).populate('participants');
        const receiversData = chat.participants.filter(
          (participant) => participant._id.toString() !== userId.toString()
        );

        const userSettingsBody = [
          {
            userId,
            deliveredAt: new Date(),
            readAt: new Date()
          }
        ];

        // Create a more descriptive message based on what was updated
        const updateMessage =
          chatName && chatPicture
            ? `Chat name and picture updated by ${user?.fullName}`
            : chatName
              ? `Chat name updated to "${chatName}" by ${user?.fullName}`
              : `Chat picture updated by ${user?.fullName}`;

        const messageBody = {
          chat: chat._id,
          sender: userId,
          contentTitle: 'Chat Updated',
          content: updateMessage,
          userSettings: userSettingsBody
        };
        const addMessage = await MessagesModel.create(messageBody);
        const latestMessageData = addMessage;

        const messageEmitBody = {
          chatScreenBody: {
            chatId: chat._id,
            chatType: chat?.chatType,
            latestMessage: addMessage?.content ?? '',
            latestMessageId: addMessage?._id,
            latestMessageType: addMessage?.contentType ?? 'text',
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text',
            latestMessageSentAt: addMessage?.createdAt,
            latestMessageTitle: addMessage?.contentTitle ?? '',
            fileSize: addMessage?.fileSize ?? '',
            latestMessageDescription: addMessage?.contentDescription ?? '',
            participants:
              chat?.participants.map((participant) => ({
                userId: participant?._id,
                fullName: participant?.fullName,
                profilePicture: participant?.profilePicture ?? defaultImage
              })) ?? [],
            isGroup: chat?.isGroup ?? false,
            GroupcreatedBy: chat?.GroupcreatedBy
          },
          messageScreenBody: {
            chatId: chat._id,
            messageId: addMessage?._id,
            sender: {
              _id: userId,
              name: user?.fullName,
              profilePicture: user?.profilePicture ?? defaultImage
            },
            content: addMessage?.content,
            latestMessageSentAt: addMessage?.createdAt,
            contentTitle: addMessage?.contentTitle,
            fileSize: addMessage?.fileSize ?? '',
            contentDescription: addMessage?.contentDescription,
            contentType: addMessage?.contentType,
            contentDescriptionType: addMessage?.contentDescriptionType ?? 'text'
          }
        };

        const messageDeliveryStatus =
          msgDeliveryStatus({ userId, chat: { lastMessage: latestMessageData } }) || {};

        for (const receiver of receiversData) {
          const receiverID = receiver?._id;
          const receiverSocketId = io.sockets.adapter.rooms.get(receiverID?.toString?.());

          if (receiverSocketId) {
            userSettingsBody.push({
              userId: receiverID,
              deliveredAt: new Date()
            });
          }
          const unreadCount = await Messages.countDocuments({
            chat: { $in: chat._id },
            $or: [
              { userSettings: { $size: 0 } },
              { 'userSettings.userId': { $ne: receiverID } },
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

          if (receiverID.toString() !== userId.toString()) {
            if (receiverSocketId) {
              io.to(receiverID.toString()).emit('receive-message', {
                ...messageEmitBody,
                unreadCounts: unreadCount,
                chatScreenBody: {
                  ...messageEmitBody.chatScreenBody,
                  chatName: chatNameForUser(chat, receiverID),
                  displayPicture: chatProfileForUser(chat, receiverID)
                }
              });
              io.to(userId?.toString?.()).emit('mark-message-deliver-response', {
                success: true,
                chatId,
                allMsgsDelivered: true
              });
            }
          }
        }

        await MessagesModel.updateOne(
          { _id: addMessage._id },
          { userSettings: userSettingsBody },
          {
            multi: true
          }
        );

        // Update chat with lastMessage and lastMessageSentAt
        await ChatsModel.findByIdAndUpdate(chat._id, {
          lastMessage: addMessage._id,
          lastMessageSentAt: addMessage.createdAt
        });

        io.to(userId.toString()).emit('receive-message', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody.chatScreenBody,
            unreadCount: 0,
            chatName: chatNameForUser(chat, userId),
            displayPicture: chatProfileForUser(chat, userId),
            ...(Object.keys(messageDeliveryStatus || {})?.length && {
              ...messageDeliveryStatus
            })
          }
        });
      } catch (error) {
        console.log(`Got error in update-chat: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in updating chat.' });
      }
    });

    socket.on('delete-chat', async (data) => {
      try {
        const chatDeleted = await deleteUserChat({ ...data, userId });
        if (!chatDeleted?.success) {
          socket.emit('socket-error', { message: chatDeleted?.message ?? 'Failed to delete chat' });
          return;
        }
        socket.emit('chat-deleted', {
          ...chatDeleted
        });
      } catch (error) {
        console.log(`Got error in delete-chat: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in deleting chat.' });
      }
    });

    socket.on('add-reaction', async (data) => {
      try {
        const { emoji, messageId } = data;
        if (!emoji || !messageId) {
          socket.emit('socket-error', { message: 'Emoji and message id are required.' });
          return;
        }

        const message = await MessagesModel.findById(messageId).populate({
          path: 'chat',
          populate: { path: 'participants' }
        });

        if (
          !message?.chat?.participants?.some(
            (participant) => participant?._id?.toString() === userId?.toString()
          )
        ) {
          socket.emit('socket-error', { message: 'User is not a part of chat.' });
          return;
        }

        const userExistingReaction = await ReactionsModel.findOne({
          objectId: messageId,
          user: userId
        });
        if (userExistingReaction) {
          const existingEmoji = userExistingReaction.emoji;

          if (existingEmoji && message?.reactionsCount?.get?.(existingEmoji) > 0) {
            const newCount = message.reactionsCount.get(existingEmoji) - 1;
            if (newCount > 0) {
              message.reactionsCount.set(existingEmoji, newCount);
            } else {
              message.reactionsCount.delete(existingEmoji);
            }
          }

          userExistingReaction.emoji = emoji;
          await userExistingReaction.save();
        } else {
          const reactionBody = {
            objectId: messageId,
            objectOnModel: 'messages',
            user: userId,
            emoji
          };
          await ReactionsModel.create(reactionBody);
        }

        message.reactionsCount.set(emoji, (message.reactionsCount.get(emoji) || 0) + 1);
        const receiverId = message?.chat?.participants
          ?.find((participant) => participant?._id?.toString?.() !== userId?.toString?.())
          ?._id.toString();
        message.markModified('reactionsCount');
        await message.save();

        const reactionsList = await ReactionsModel.find({ objectId: messageId }).populate(
          'user',
          '_id name Username dp'
        );

        const detailedReactions = reactionsList.map((reaction) => ({
          userId: reaction.user._id,
          userName: reaction.user.name,
          profilePicture: reaction.user.profilePicture,
          emoji: reaction.emoji
        }));

        const payload = {
          chatId: message?.chat?._id,
          messageId,
          emoji,
          reactionsCount: message?.reactionsCount,
          sId: message?.sId ?? '',
          userId,
          reactions: detailedReactions
        };

        io.to(userId.toString()).emit('reaction', payload);
        io.to(receiverId).emit('reaction', payload);

        await addReaction({ ...data, userId });
      } catch (error) {
        console.log(`Got error in add-reaction: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in forwarding message.' });
      }
    });

    socket.on('remove-reaction', async (data) => {
      try {
        const { emoji, messageId } = data;

        const message = await MessagesModel.findById(messageId).populate({
          path: 'chat',
          populate: { path: 'participants' }
        });
        if (!message) {
          socket.emit('socket-error', { message: 'Message not found.' });
          return;
        }

        const userReaction = await ReactionsModel.findOne({
          objectId: messageId,
          user: userId,
          emoji
        });
        if (!userReaction) {
          socket.emit('socket-error', {
            message: 'No reaction from the user found for the message or emoji.'
          });
          return;
        }

        if (message?.reactionsCount?.has?.(emoji)) {
          const newCount = message?.reactionsCount?.get?.(emoji) - 1;
          if (newCount > 0) {
            message.reactionsCount.set(emoji, newCount);
          } else {
            message.reactionsCount.delete(emoji);
          }
        }
        const receiverId = message?.chat?.participants
          ?.find((participant) => participant?._id?.toString?.() !== userId?.toString?.())
          ?._id.toString();

        message.markModified('reactionsCount');
        await message.save();

        io.to(userId.toString()).emit('remove-reaction-response', {
          chatId: message?.chat?._id,
          messageId,
          emoji,
          reactionsCount: message.reactionsCount.get(emoji) || {},
          sId: message?.sId ?? ''
        });
        io.to(receiverId).emit('remove-reaction-response', {
          chatId: message?.chat?._id,
          messageId,
          emoji,
          reactionsCount: message.reactionsCount.get(emoji) || {},
          sId: message?.sId ?? ''
        });
        await removeReaction({ ...data, userId });
      } catch (error) {
        console.log(`Got error in remove-reaction: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in removing reaction.' });
      }
    });

    socket.on('edit-message', async (data) => {
      try {
        const response = await editMessage({ ...data, userId });
        if (!response?.success) {
          socket.emit('socket-error', { message: response?.message });
          return;
        }
        const message = response?.data ?? {};
        const { chat = {} } = message;
        const unreadCount = await MessagesModel.countDocuments({
          chat: { $in: chat?._id },
          $or: [
            { [`userSettings.${userId}`]: { $exists: false } },
            { [`userSettings.${userId}.readAt`]: { $exists: false } },
            { [`userSettings.${userId}.readAt`]: null }
          ]
        });
        const chatNameForUser = (chatDetails, userId) => {
          return (
            chatDetails?.groupName ||
            chatDetails?.participants?.find(
              (participant) => participant?._id?.toString?.() !== userId?.toString?.()
            )?.fullName
          );
        };
        const chatProfileForUser = (chatDetails, userId) => {
          return (
            chatDetails?.participants?.find(
              (participant) => participant?._id?.toString?.() != userId?.toString?.()
            )?.profilePicture ??
            chatDetails?.participants?.find(
              (participant) => participant?._id?.toString?.() != userId?.toString?.()
            )?.profilePicture ??
            defaultImage
          );
        };
        const otherUser = chat?.participants?.find(
          (participant) => participant._id.toString() !== userId.toString()
        );
        const senderData = await UsersModel.findById(userId);

        const displayPicture =
          chat?.participants?.find(
            (participant) => participant?._id?.toString?.() != userId?.toString?.()
          )?.profilePicture ??
          chat?.participants?.find(
            (participant) => participant?._id?.toString?.() != userId?.toString?.()
          )?.profilePicture ??
          defaultImage;
        const messageEmitBody = {
          chatScreenBody: {
            receiverId: otherUser?._id.toString(),
            chatId: chat?._id,
            chatName: chat?.participants?.find(
              (participant) => participant?._id?.toString?.() !== userId?.toString?.()
            )?.profilePicture,
            displayPicture,
            latestMessage: message?.content ?? '',
            latestMessageId: message?._id,
            latestMessageType: message?.contentType ?? 'text',
            contentDescriptionType: message?.contentDescriptionType ?? 'text',
            latestMessageSentAt: message?.createdAt,
            latestMessageTitle: message?.contentTitle ?? '',
            fileSize: message?.fileSize ?? '',
            latestMessageDescription: message?.contentDescription ?? '',
            unreadCount: unreadCount ?? 0
          },
          messageScreenBody: {
            chatId: chat?._id,
            messageId: message?._id,
            sender: {
              _id: userId,
              name: senderData?.name ?? null,
              profilePicture: senderData?.profilePicture ?? defaultImage
            },
            content: message?.content ?? null,
            contentTitle: message?.contentTitle ?? null,
            fileSize: message?.fileSize ?? '',
            contentDescription: message?.contentDescription ?? null,
            contentType: message?.contentType ?? null,
            contentDescriptionType: message?.contentDescriptionType ?? 'text',

            editedAt: message?.editedAt ?? null
          }
        };
        socket.emit('edit-message-response', {
          ...messageEmitBody,
          chatScreenBody: {
            ...messageEmitBody?.chatScreenBody,
            chatName: chatNameForUser(chat, userId),
            displayPicture: chatProfileForUser(chat, userId)
          }
        });

        const receiverId = chat?.participants?.find(
          (participant) => participant?._id?.toString?.() !== userId?.toString?.()
        )?._id;
        if (receiverId) {
          // const receiverUserData = await UsersModel.findById(receiverId);
          // const receiverSocketId = receiverUserData?.active_socket;
          io.to(receiverId.toString()).emit('edit-message-response', {
            ...messageEmitBody,
            chatScreenBody: {
              ...messageEmitBody?.chatScreenBody,
              chatName: chatNameForUser(chat, receiverId),
              displayPicture: chatProfileForUser(chat, receiverId)
            }
          });
        }
      } catch (error) {
        console.log(`Got error in edit-message: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in editing message.' });
      }
    });

    socket.on('mark-message-as-read', async (data) => {
      try {
        const markAsReadResponse = await markMessageAsRead({ ...data, userId });
        const unreadCount = await MessagesModel.countDocuments({
          chat: { $in: data?.chatId },
          bookingId: {
            $ne: data?.bookingId
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
        if (!markAsReadResponse?.success) {
          socket.emit('socket-error', { message: markAsReadResponse?.message });
          return;
        }
        socket.emit('mark-message-read-response', {
          success: true,
          unreadCount: unreadCount || 0,
          bookingId: data?.bookingId
        });
        const { chatId } = markAsReadResponse;
        const chat = await ChatsModel.findById(chatId);
        const otherParticipants = chat?.participants?.filter(
          (participant) => participant.toString() !== userId.toString()
        );
        otherParticipants.forEach((otherParticipant) => {
          const isUserOnline = io.sockets.adapter.rooms.get(otherParticipant?.toString?.())
            ? true
            : false;
          if (isUserOnline) {
            io.to(otherParticipant?.toString?.()).emit('mark-message-read-response', {
              success: true,
              chatId,
              userId,
              allMsgsRead: true,
              unreadCount: unreadCount || 0,
              bookingId: data?.bookingId
            });
          }
        });
      } catch (error) {
        console.log(`Got error in mark-message-as-read: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in marking message as read.' });
      }
    });

    socket.on('get-user-notifications', async (data) => {
      try {
        const notifications = await getUserNotifications({
          ...data,
          userId: subAdmin ? subAdmin._id : userId
        });
        socket.emit('user-notifications', notifications);
      } catch (error) {
        console.log(`Got error in get-user-notifications: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching notifications.' });
      }
    });

    //////////////////////get user unread notifications /////////////////////////
    socket.on('get-user-unread-notifications', async (data) => {
      try {
        const notifications = await getUserUnreadNotifications({
          ...data,
          userId: subAdmin ? subAdmin._id : userId
        });
        socket.emit('user-unread-notifications', notifications);
      } catch (error) {
        console.log(`Got error in get-user-unread-notifications: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in fetching unread notifications.' });
      }
    });

    ////////////////////////// read user notifications ////////////////////////////

    socket.on('read-user-notifications', async (data) => {
      try {
        const notifications = await readUserNotifications({ ...data, userId });
        socket.emit('read-notifications', {
          success: notifications,
          message: 'Notifications marked as read successfully.'
        });
      } catch (error) {
        console.log(`Got error in read-user-notifications: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in reading notifications.' });
      }
    });

    ////////////////////////// search chats by message content ////////////////////////////
    socket.on('search-chat-messages', async (data) => {
      try {
        const chats = await searchChatsByMessageContent({ ...data, userId });
        socket.emit('search-messages-results', chats);
      } catch (error) {
        console.log(`Got error in search-chat-messages: ${JSON.stringify(error?.stack)}`);
        socket.emit('socket-error', { message: 'Error in searching messages.' });
      }
    });
  });
}

function getIO() {
  return io;
}
const sendEmail = async (user, title, message) => {
  const emailInstance = new Email(user.email, user.firstName);
  await emailInstance.sendTextEmail(title, message, { attachment: null });
};

const sendNotification = async ({
  userId,
  title,
  message,
  type,
  fortype,
  permission: tab,
  linkUrl
}) => {
  try {
    const io = getIO();
    const user = await User.findById(userId);
    if (!user) {
      return;
    }

    // Admin Notification Handling
    if (user.role === 'admin' && fortype) {
      const permissions = await NotificationPermission.findOne({ type: fortype });

      if (!permissions) {
        return;
      }

      // Email
      if (permissions.email === true) {
        if (permissions.admin) {
          await sendEmail(user, title, message);
        }
        if (permissions.subadmin) {
          const subAdmins = await User.find({ adminRole: 'subAdmin' }).populate('templateId');
          for (const subAdmin of subAdmins) {
            if (subAdmin.email && subAdmin?.templateId?.tabPermissions?.includes(tab)) {
              await sendEmail(subAdmin, title, message);
            }
          }
        }
      }

      // SMS
      if (permissions.sms === true) {
        if (permissions.subadmin === true) {
          const subAdmins = await User.find({ adminRole: 'subAdmin' }).populate('templateId');
          for (const subAdmin of subAdmins) {
            if (subAdmin.contact && subAdmin?.templateId?.tabPermissions?.includes(tab)) {
              const smsResponse = await sendTwilioSms(subAdmin.contact, message);
            }
          }
          if (permissions.admin === true) {
            const smsResponse = await sendTwilioSms(user.contact, message);
          }
        }
      }

      // Mobile Notification
      if (permissions.mobile === true) {
        if (permissions.admin === true) {
          const notification = new Notification({
            userId: user._id,
            title,
            message,
            type,
            linkUrl
          });
          await notification.save();
          io.to('notification_admin').emit('notification', notification);
        }

        if (permissions.subadmin === true) {
          const subAdmins = await User.find({ adminRole: 'subAdmin' });
          for (const subAdmin of subAdmins) {
            if (subAdmin?.templateId?.tabPermissions?.includes(tab)) {
              const subNotification = new Notification({
                userId: subAdmin._id,
                title,
                message,
                type,
                linkUrl
              });
              await subNotification.save();
              io.to(`notification_subAdmin_${subAdmin?._id}`).emit('notification', subNotification);
            }
          }
        }
      }

      return 0;
    }

    await sendEmail(user, title, message);

    if (user.contact) {
      const smsResponse = await sendTwilioSms(user.contact, message);
      console.log('SMS sent:', smsResponse);
    }

    const newNotification = new Notification({
      userId: user._id,
      title,
      message,
      type,
      linkUrl
    });

    await newNotification.save();

    const room = io.sockets.adapter.rooms.get(user._id.toString());
    if (room) {
      newNotification.isDelivered = true;
      await newNotification.save();
      io.to(user._id.toString()).emit('notification', newNotification);
    }
  } catch (error) {
    console.error('Notification middleware error:', error);
    throw error;
  }
};

module.exports = {
  initializeSocket,
  getIO
};
