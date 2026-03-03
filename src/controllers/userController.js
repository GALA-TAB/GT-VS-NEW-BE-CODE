const mongoose = require('mongoose');
const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber');
const User = require('../models/users/User');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { validateUserProfile } = require('../utils/joi/userValidation');
const { validateAndFormatPhoneNumber } = require('../utils/helperFunctions');
const Email = require('../utils/email');
const createLog = require('../utils/createLog');

const phoneUtil = PhoneNumberUtil.getInstance();
const { roles } = require('../utils/types');
const Vendor = require('../models/users/Vendor');
const joiError = require('../utils/joiError');
const ServiceListing = require('../models/ServiceListing');
const { vendorResponseTimeQuery } = require('../utils/dataformat');

const sendEmail = async (subject, email, text, data) => {
  await new Email(email, subject).sendTextEmail(subject, text, data);
};
const sendEmailforVendor = async (template, subject, email, data) => {
  const response = await new Email(email, subject).send(template, subject, data);
  return response;
};

const updateMe = catchAsync(async (req, res, next) => {
  const {
    contact,
    countryCode,
    officeContact,
    officeCountryCode,
    emergencyContact,
    emergencyCountryCode,
    ...updateData
  } = req.body;

  // Find user
  const userFound = await User.findById(req.user._id).populate('templateId');
  if (!userFound) {
    return next(new AppError('User not found', 404));
  }

  // Validate only the fields that are present in the request body
  const { error } = validateUserProfile(req.body, { partial: true });
  if (error) {
    const formattedErrors = {};
    error.details.forEach((err) => {
      const key = err.path.join('.'); // e.g., "address.mailingZip"

      if (key.startsWith('address.')) {
        const field = key.split('.')[1]; // e.g., "mailingZip"
        if (!formattedErrors.address) formattedErrors.address = {};
        formattedErrors.address[field] = err.message;
      } else {
        formattedErrors[key] = err.message;
      }
    });
    return next(new AppError('Validation failed', 400, formattedErrors));
  }

  // Validate and normalize phone numbers if provided
  try {
    if (contact !== undefined) {
      updateData.contact = contact
        ? validateAndFormatPhoneNumber(
            contact,
            countryCode || userFound.countryCode || userFound.countryCode
          )
        : '';
      if (countryCode !== undefined) {
        updateData.countryCode = countryCode;
      }
    }

    if (officeContact !== undefined) {
      updateData.officeContact = officeContact
        ? validateAndFormatPhoneNumber(
            officeContact,
            officeCountryCode || userFound?.officeCountryCode
          )
        : '';
      if (officeCountryCode !== undefined) {
        updateData.officeCountryCode = officeCountryCode;
      }
    }

    if (emergencyContact !== undefined) {
      updateData.emergencyContact = emergencyContact
        ? validateAndFormatPhoneNumber(
            emergencyContact,
            emergencyCountryCode || userFound.emergencyCountryCode
          )
        : '';
      if (emergencyCountryCode !== undefined) {
        updateData.emergencyCountryCode = emergencyCountryCode;
      }
    }
  } catch (err) {
    console.log(err);
    return next(new AppError(err.message, 400));
  }

  // Update user with only provided information
  Object.keys(updateData).forEach((key) => {
    if (updateData[key] !== undefined) {
      userFound[key] = updateData[key];
    }
  });

  // Handle address updates separately if provided
  if (updateData.address) {
    userFound.address = userFound.address || {};
    Object.keys(updateData.address).forEach((key) => {
      if (updateData.address[key] !== undefined) {
        userFound.address[key] = updateData.address[key];
      }
    });
  }

  await userFound.save();
  res.locals.dataId = userFound._id;

  return res.status(200).json({
    status: 'success',
    message: 'Profile updated successfully',
    data: userFound
  });
});

const UpdateUserByAdmin = catchAsync(async (req, res, next) => {
  const {
    contact,
    countryCode,
    officeContact,
    officeCountryCode,
    emergencyContact,
    emergencyCountryCode,
    ...updateData
  } = req.body;
  const { id } = req.params;

  // Find user
  const userFound = await User.findById(id);
  if (!userFound) {
    return next(new AppError('User not found', 404));
  }

  // Validate only the fields that are present in the request body
  const { error } = validateUserProfile(req.body, { partial: true });
  if (error) {
    const formattedErrors = {};
    error.details.forEach((err) => {
      const key = err.path.join('.'); // e.g., "address.mailingZip"

      if (key.startsWith('address.')) {
        const field = key.split('.')[1]; // e.g., "mailingZip"
        if (!formattedErrors.address) formattedErrors.address = {};
        formattedErrors.address[field] = err.message;
      } else {
        formattedErrors[key] = err.message;
      }
    });
    return next(new AppError('Validation failed', 400, formattedErrors));
  }

  // Validate and normalize phone numbers if provided
  try {
    if (contact !== undefined) {
      updateData.contact = contact
        ? validateAndFormatPhoneNumber(
            contact,
            countryCode || userFound.countryCode || userFound.countryCode
          )
        : '';
      if (countryCode !== undefined) {
        updateData.countryCode = countryCode;
      }
    }

    if (officeContact !== undefined) {
      updateData.officeContact = officeContact
        ? validateAndFormatPhoneNumber(
            officeContact,
            officeCountryCode || userFound?.officeCountryCode
          )
        : '';
      if (officeCountryCode !== undefined) {
        updateData.officeCountryCode = officeCountryCode;
      }
    }

    if (emergencyContact !== undefined) {
      updateData.emergencyContact = emergencyContact
        ? validateAndFormatPhoneNumber(
            emergencyContact,
            emergencyCountryCode || userFound.emergencyCountryCode
          )
        : '';
      if (emergencyCountryCode !== undefined) {
        updateData.emergencyCountryCode = emergencyCountryCode;
      }
    }
  } catch (err) {
    console.log(err);
    return next(new AppError(err.message, 400));
  }

  // Update user with only provided information
  Object.keys(updateData).forEach((key) => {
    if (updateData[key] !== undefined) {
      userFound[key] = updateData[key];
    }
  });

  // Handle address updates separately if provided
  if (updateData.address) {
    userFound.address = userFound.address || {};
    Object.keys(updateData.address).forEach((key) => {
      if (updateData.address[key] !== undefined) {
        userFound.address[key] = updateData.address[key];
      }
    });
  }

  await userFound.save();
  res.locals.dataId = userFound._id;

  // Log admin edit
  createLog({
    actorId: req.user._id,
    actorModel: 'admin',
    action: 'UPDATE_USER',
    description: `Admin updated profile for user: ${userFound.email}`,
    target: 'User',
    targetId: userFound._id,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  return res.status(200).json({
    status: 'success',
    message: 'User updated successfully',
    data: userFound
  });
});

const CreateVendorByAdmin = catchAsync(async (req, res, next) => {
  const {
    officeContact,
    officeCountryCode,
    emergencyContact,
    emergencyCountryCode,
    ...updateData
  } = req.body;

  // Validate only the fields that are present in the request body
  const { error } = validateUserProfile(req.body);
  if (error) {
    const formattedErrors = joiError(error);

    return next(new AppError('Validation failed', 400, formattedErrors));
  }

  const { email, contact, countryCode } = req.body;

  let normalizedContact;
  let regionCode;

  try {
    const countryDialCode = parseInt(countryCode.replace('+', ''), 10);
    regionCode = phoneUtil.getRegionCodeForCountryCode(countryDialCode);
    if (!regionCode) throw new Error('Invalid country code.');

    const number = phoneUtil.parseAndKeepRawInput(contact, regionCode);
    if (!phoneUtil.isValidNumber(number) || !phoneUtil.isValidNumberForRegion(number, regionCode)) {
      throw new Error('Invalid phone number for the specified country.');
    }
    normalizedContact = phoneUtil.format(number, PhoneNumberFormat.E164);
  } catch (err) {
    return next(new AppError('Validation failed', 400, { contact: err.message }));
  }

  // Check if email or contact already exists
  const existingUsers = await User.findOne({
    $or: [{ email }, { contact: normalizedContact }]
  });
  if (existingUsers) {
    if (existingUsers.email === email) {
      return next(new AppError('Email already exists!', 400, { email: 'Email already exists!' }));
    }
    if (existingUsers.contact === normalizedContact) {
      return next(
        new AppError('Contact already exists!', 400, { contact: 'Contact already exists!' })
      );
    }
  }

  // Prepare user data
  const UserData = {
    ...updateData,
    email,
    contact: normalizedContact,
    countryCode,
    role: roles.VENDOR
    // status: 'Pending',
  };

  const user = await Vendor.create(UserData);
  const resetToken = user.createPasswordResetToken();
  const origin = req.get('origin') || process.env.FRONTEND_URL;
  const resetURL = `${origin}/auth/reset-password?token=${resetToken}`;
  try {
    const response = await sendEmailforVendor('forgotEmail', 'Reset Your Password', email, {
      firstName: user.firstName,
      resetURL
    });
    res.locals.dataId = user._id;
    user.save({ validateBeforeSave: false });

    // Log vendor creation by admin
    createLog({
      actorId: req.user._id,
      actorModel: 'admin',
      action: 'CREATE_VENDOR',
      description: `Admin created vendor account: ${user.email}`,
      target: 'User',
      targetId: user._id,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
    });

    return res.status(200).json({
      status: 'success',
      message: 'Vendor created successfully',
      data: user
    });
  } catch (err) {
    console.log(err);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(new AppError('There was an error sending the email. Try again later!'), 500);
  }
});

const getMe = catchAsync(async (req, res, next) => {
  const user = await User.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(req.user._id)
      }
    },
    // Customer bookings
    {
      $lookup: {
        from: 'bookings',
        pipeline: [
          {
            $match: {
              user: new mongoose.Types.ObjectId(req.user._id),
              status: {
                $in: ['completed', 'booked']
              }
            }
          }
        ],
        as: 'customerBookings'
      }
    },
    // Vendor bookings + response time
    {
      $lookup: {
        from: 'bookings',
        let: { vendorId: '$_id' },
        pipeline: [
          {
            $match: {
              status: {
                $in: ['completed', 'booked']
              }
            }
          },
          {
            $lookup: {
              from: 'servicelistings',
              let: { vendorId: '$$vendorId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [{ $eq: ['$vendorId', '$$vendorId'] }]
                    }
                  }
                }
              ],
              as: 'matchedService'
            }
          },
          { $unwind: { path: '$matchedService', preserveNullAndEmptyArrays: false } },
          {
            $match: {
              $expr: { $eq: ['$service', '$matchedService._id'] }
            }
          },
          {
            $addFields: {
              responseTimeMinutes: {
                $divide: [{ $subtract: ['$bookingResponseTime', '$createdAt'] }, 1000 * 60]
              }
            }
          }
        ],
        as: 'vendorBookings'
      }
    },
    // Add counts + average response time
    {
      $addFields: {
        totalCustomerBookings: {
          $cond: [{ $isArray: '$customerBookings' }, { $size: '$customerBookings' }, 0]
        },
        totalVendorBookings: {
          $cond: [{ $isArray: '$vendorBookings' }, { $size: '$vendorBookings' }, 0]
        }
      }
    },

    {
      $lookup: {
        from: 'bookings',
        let: { vendorId: '$_id' },
        pipeline: [
          {
            $lookup: {
              from: 'servicelistings',
              localField: 'service',
              foreignField: '_id',
              as: 'serviceInfo'
            }
          },
          { $unwind: { path: '$serviceInfo', preserveNullAndEmptyArrays: true } },
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$serviceInfo.vendorId', '$$vendorId'] },
                  { $ne: ['$bookingResponseTime', null] },
                  { $ne: ['$status', 'pending'] }
                ]
              }
            }
          },
          {
            $addFields: {
              responseTimeMinutes: {
                $divide: [{ $subtract: ['$bookingResponseTime', '$createdAt'] }, 1000 * 60]
              }
            }
          }
        ],
        as: 'vendorAllBookings'
      }
    },

    // 📌 Chat response time
    {
      $lookup: {
        from: 'chats',
        let: { vendorId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$$vendorId', '$participants'] }
            }
          },
          {
            $lookup: {
              from: 'messages',
              localField: '_id',
              foreignField: 'chat',
              as: 'messages'
            }
          },
          { $unwind: '$messages' },
          { $sort: { 'messages.createdAt': 1 } },
          {
            $group: {
              _id: '$_id',
              messages: { $push: '$messages' }
            }
          },
          {
            $addFields: {
              chatResponseTimes: {
                $reduce: {
                  input: { $range: [1, { $size: '$messages' }] },
                  initialValue: [],
                  in: {
                    $let: {
                      vars: {
                        currentMsg: { $arrayElemAt: ['$messages', '$$this'] },
                        prevMsg: { $arrayElemAt: ['$messages', { $subtract: ['$$this', 1] }] }
                      },
                      in: {
                        $cond: [
                          {
                            $and: [
                              { $eq: ['$$currentMsg.sender', '$$vendorId'] },
                              { $ne: ['$$prevMsg.sender', '$$vendorId'] }
                            ]
                          },
                          {
                            $concatArrays: [
                              '$$value',
                              [
                                {
                                  responseTimeMinutes: {
                                    $divide: [
                                      {
                                        $subtract: ['$$currentMsg.createdAt', '$$prevMsg.createdAt']
                                      },
                                      1000 * 60
                                    ]
                                  }
                                }
                              ]
                            ]
                          },
                          '$$value'
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        ],
        as: 'vendorChats'
      }
    },

    // 📌 Final averages
    {
      $addFields: {
        avgResponseTimeMinutes: {
          $cond: [
            { $gt: [{ $size: '$vendorAllBookings' }, 0] },
            { $avg: '$vendorAllBookings.responseTimeMinutes' },
            null
          ]
        },
        avgChatResponseTimeMinutes: {
          $let: {
            vars: {
              allChatResponseTimes: {
                $reduce: {
                  input: '$vendorChats',
                  initialValue: [],
                  in: { $concatArrays: ['$$value', '$$this.chatResponseTimes'] }
                }
              }
            },
            in: {
              $cond: [
                { $gt: [{ $size: '$$allChatResponseTimes' }, 0] },
                {
                  $avg: {
                    $map: {
                      input: '$$allChatResponseTimes',
                      as: 'response',
                      in: '$$response.responseTimeMinutes'
                    }
                  }
                },
                null
              ]
            }
          }
        }
      }
    },
    // Permissions lookup
    {
      $lookup: {
        from: 'permissions',
        localField: 'templateId',
        foreignField: '_id',
        as: 'templateId'
      }
    },
    { $unwind: { path: '$templateId', preserveNullAndEmptyArrays: true } },
    // Tax forum lookup
    {
      $lookup: {
        from: 'taxforums',
        localField: '_id',
        foreignField: 'vendorId',
        as: 'taxforums'
      }
    },
    { $unwind: { path: '$taxforums', preserveNullAndEmptyArrays: true } },
    // KYC lookup
    {
      $lookup: {
        from: 'kycdocuments',
        localField: '_id',
        foreignField: 'userId',
        as: 'kyc'
      }
    },
    { $unwind: { path: '$kyc', preserveNullAndEmptyArrays: true } },
    // Country lookup
    {
      $lookup: {
        from: 'countries',
        localField: 'country',
        foreignField: '_id',
        as: 'country'
      }
    },
    { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } },
    // Final projection
    {
      $project: {
        password: 0,
        __v: 0,
        vendorBookings: 0,
        customerBookings: 0,
        vendorAllBookings: 0,
        vendorChats: 0
      }
    }
  ]);

  if (!user || user.length === 0) {
    return next(new AppError('User not found', 404, { user: 'user not found' }));
  }

  return res.status(200).json({
    status: 'success',
    data: user[0]
  });
});
const getVendorforService = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const user = await User.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(userId)
      }
    },
    {
      $lookup: {
        from: 'bookings',
        localField: '_id',
        foreignField: 'user',
        as: 'booking'
      }
    },
    {
      $lookup: {
        from: 'reviews',
        let: {
          bookingIds: {
            $map: {
              input: '$booking',
              as: 'b',
              in: '$$b._id'
            }
          },
          vendorId: '$_id'
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $in: ['$reviewOn', '$$bookingIds'] },
                  { $ne: ['$reviewer', '$$vendorId'] },
                  { $eq: ['$isDeleted', false] }
                ]
              }
            }
          },
          // Lookup booking for each review
          {
            $lookup: {
              from: 'bookings',
              localField: 'reviewOn',
              foreignField: '_id',
              as: 'booking'
            }
          },
          { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'users',
              localField: 'reviewer',
              foreignField: '_id',
              as: 'reviewerInfo'
            }
          },
          {
            $unwind: {
              path: '$reviewerInfo',
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $project: {
              _id: 1,
              comment: 1,
              reviewType: 1,
              rating: 1,
              reviewer: {
                firstName: '$reviewerInfo.firstName',
                lastName: '$reviewerInfo.lastName',
                profilePicture: '$reviewerInfo.profilePicture'
              },
              createdAt: 1,
              updatedAt: 1,
              bookingDate: '$booking.checkIn'
            }
          }
        ],
        as: 'reviews'
      }
    },
    {
      $addFields: {
        totalReviews: { $size: '$reviews' },
        averageRating: {
          $cond: [
            { $gt: [{ $size: '$reviews' }, 0] },
            {
              $avg: '$reviews.rating'
            },
            0
          ]
        }
      }
    },
    {
      $project: {
        password: 0,
        __v: 0,
        booking: 0
      }
    }
  ]);

  if (!user || user.length === 0) {
    return next(new AppError('User not found', 404, { user: 'user not found' }));
  }

  return res.status(200).json({
    status: 'success',
    data: user[0]
  });
});
const getUser = catchAsync(async (req, res, next) => {
  const userId = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return next(new AppError('Invalid ID format', 400, { user: 'Invalid ID format' }));
  }

  const user = await User.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(userId)
      }
    },
    {
      $lookup: {
        from: 'countries',
        localField: 'country',
        foreignField: '_id',
        as: 'country'
      }
    },
    { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'permissions',
        localField: 'templateId',
        foreignField: '_id',
        as: 'templateId'
      }
    },
    { $unwind: { path: '$templateId', preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: 'bookings',
        let: { vendorId: '$_id' },
        pipeline: [
          {
            $lookup: {
              from: 'servicelistings',
              localField: 'service',
              foreignField: '_id',
              as: 'serviceInfo'
            }
          },
          { $unwind: { path: '$serviceInfo', preserveNullAndEmptyArrays: true } },
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$serviceInfo.vendorId', '$$vendorId'] },
                  { $ne: ['$bookingResponseTime', null] },
                  { $ne: ['$status', 'pending'] }
                ]
              }
            }
          },
          {
            $addFields: {
              responseTimeMinutes: {
                $divide: [{ $subtract: ['$bookingResponseTime', '$createdAt'] }, 1000 * 60]
              }
            }
          }
        ],
        as: 'vendorAllBookings'
      }
    },

    // 📌 Chat response time
    {
      $lookup: {
        from: 'chats',
        let: { vendorId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$$vendorId', '$participants'] }
            }
          },
          {
            $lookup: {
              from: 'messages',
              localField: '_id',
              foreignField: 'chat',
              as: 'messages'
            }
          },
          { $unwind: '$messages' },
          { $sort: { 'messages.createdAt': 1 } },
          {
            $group: {
              _id: '$_id',
              messages: { $push: '$messages' }
            }
          },
          {
            $addFields: {
              chatResponseTimes: {
                $reduce: {
                  input: { $range: [1, { $size: '$messages' }] },
                  initialValue: [],
                  in: {
                    $let: {
                      vars: {
                        currentMsg: { $arrayElemAt: ['$messages', '$$this'] },
                        prevMsg: { $arrayElemAt: ['$messages', { $subtract: ['$$this', 1] }] }
                      },
                      in: {
                        $cond: [
                          {
                            $and: [
                              { $eq: ['$$currentMsg.sender', '$$vendorId'] },
                              { $ne: ['$$prevMsg.sender', '$$vendorId'] }
                            ]
                          },
                          {
                            $concatArrays: [
                              '$$value',
                              [
                                {
                                  responseTimeMinutes: {
                                    $divide: [
                                      {
                                        $subtract: ['$$currentMsg.createdAt', '$$prevMsg.createdAt']
                                      },
                                      1000 * 60
                                    ]
                                  }
                                }
                              ]
                            ]
                          },
                          '$$value'
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        ],
        as: 'vendorChats'
      }
    },

    // 📌 Final averages
    {
      $addFields: {
        avgResponseTimeMinutes: {
          $cond: [
            { $gt: [{ $size: '$vendorAllBookings' }, 0] },
            { $avg: '$vendorAllBookings.responseTimeMinutes' },
            null
          ]
        },
        avgChatResponseTimeMinutes: {
          $let: {
            vars: {
              allChatResponseTimes: {
                $reduce: {
                  input: '$vendorChats',
                  initialValue: [],
                  in: { $concatArrays: ['$$value', '$$this.chatResponseTimes'] }
                }
              }
            },
            in: {
              $cond: [
                { $gt: [{ $size: '$$allChatResponseTimes' }, 0] },
                {
                  $avg: {
                    $map: {
                      input: '$$allChatResponseTimes',
                      as: 'response',
                      in: '$$response.responseTimeMinutes'
                    }
                  }
                },
                null
              ]
            }
          }
        }
      }
    },
    {
      $project: {
        vendorAllBookings: 0,
        vendorChats: 0,
        password: 0,
        __v: 0
      }
    }
  ]);
  const userResult = user[0];
  if (!userResult) {
    return next(new AppError('User not found', 404, { user: 'user not found' }));
  }

  return res.status(200).json({
    status: 'success',
    data: userResult
  });
});

const getAllUsers = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

  console.log('get all users route. sortBy', sortBy, 'sortOrder1', sortOrder);

  const skip = (page - 1) * limit;

  const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  console.log('get all users route. sort options', sortOptions);

  const users = await User.aggregate([
    { $sort: sortOptions },
    { $skip: skip },
    { $limit: parseInt(limit, 10) },
    {
      $project: {
        password: 0,
        __v: 0
      }
    }
  ]);

  const totalUsers = await User.countDocuments();

  return res.status(200).json({
    status: 'success',
    results: users.length,
    totalUsers,
    data: users
  });
});
const getAllUsersforAdmin = catchAsync(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sortBy = 'createdAt', // allowed: createdAt, email, fullName, status, role, etc.
    sortOrder = 'desc',
    role = 'customer',
    search = '',
    status
  } = req.query;

  // ensure numbers
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);
  const skip = (pageNum - 1) * limitNum;
  const sortDir = sortOrder === 'asc' ? 1 : -1;

  // whitelist sort fields to avoid accidental/no-op sorts
  const allowedSortFields = new Set([
    'createdAt',
    'email',
    'fullName',
    'status',
    'role',
    'companyName',
    'contact',
    'countryCode'
  ]);
  const sortField = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';

  // build sort options (if sorting by name, use a lowercased helper field for case-insensitive sort)
  const sortOptions = {};
  if (sortField === 'fullName') {
    sortOptions['fullNameLower'] = sortDir;
  } else {
    sortOptions[sortField] = sortDir;
  }

  // base query
  const query = { adminRole: { $ne: 'admin' } ,
          vendorRole: { $ne: 'staff' },
          customerRole: { $ne: 'staff' }
};
  if (role) query.role = role;
  if (status) query.status = status;

  // build search ORs
  const searchQuery = [];
  const trimmedSearch = (search || '').trim();
  if (trimmedSearch) {
    searchQuery.push(
      { fullName: { $regex: trimmedSearch, $options: 'i' } },
      { email: { $regex: trimmedSearch, $options: 'i' } },
      { companyName: { $regex: trimmedSearch, $options: 'i' } },
      { contact: { $regex: trimmedSearch, $options: 'i' } },
      { countryCode: { $regex: trimmedSearch, $options: 'i' } },
      { status: { $regex: trimmedSearch, $options: 'i' } }
    );
  }

  // build a base pipeline (no pagination)
  const basePipeline = [
    { $match: query },

    // lookup (keep as array)
    {
      $lookup: {
        from: 'permissions',
        localField: 'templateId',
        foreignField: '_id',
        as: 'templateId'
      }
    },

    // avoid $unwind duplicates by taking the first matching permission (if you need all, change logic)
    {
      $addFields: {
        templateId: { $arrayElemAt: ['$templateId', 0] }
      }
    },

    // create fullName and a lowercase helper field for sorting
    {
      $addFields: {
        fullName: {
          $trim: {
            input: {
              $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }]
            }
          }
        }
      }
    },
    {
      $addFields: {
        fullNameLower: { $toLower: { $ifNull: ['$fullName', ''] } }
      }
    },

    // apply search if provided
    ...(searchQuery.length > 0 ? [{ $match: { $or: searchQuery } }] : [])
  ];

  // full pipeline with sort and pagination (sort before skip/limit)
  const aggregationPipeline = [
    ...basePipeline,
    { $sort: sortOptions },
    { $skip: skip },
    { $limit: limitNum },

    // project out sensitive/internal fields at the very end
    {
      $project: {
        password: 0,
        __v: 0
      }
    }
  ];

  // pipeline to count total matches (no skip/limit)
  const totalUsersPipeline = [...basePipeline, { $count: 'totalUsers' }];

  const [users, totalCountResult] = await Promise.all([
    User.aggregate(aggregationPipeline),
    User.aggregate(totalUsersPipeline)
  ]);

  const totalUsers = totalCountResult[0]?.totalUsers || 0;

  return res.status(200).json({
    status: 'success',
    results: users.length,
    totalUsers,
    data: users
  });
});

const getAllCustomerandVendor = catchAsync(async (req, res) => {
  let users;
  const userId = new mongoose.Types.ObjectId(req.user._id);
  if (req.user.role === 'vendor') {
    users = await User.aggregate([
      {
        $match: {
          _id: { $ne: userId },
          adminRole: { $ne: 'subAdmin' }
        }
      },
      {
        $lookup: {
          from: 'bookings',
          localField: '_id',
          foreignField: 'user',
          as: 'bookings',
          pipeline: [
            {
              $lookup: {
                from: 'servicelistings',
                localField: 'service',
                foreignField: '_id',
                as: 'serviceDetails'
              }
            },
            { $unwind: { path: '$serviceDetails', preserveNullAndEmptyArrays: true } },
            {
              $match: { 'serviceDetails.vendorId': userId } // assuming vendorId is in serviceDetails
            }
          ]
        }
      },
      {
        $match: {
          $expr: {
            $or: [
              { $gt: [{ $size: '$bookings' }, 0] }, // condition 1
              { $eq: ['$role', 'admin'] } // condition 2
            ]
          }
        }
      },

      {
        $project: {
          fullName: { $concat: ['$firstName', ' ', '$lastName'] },
          firstName: 1,
          lastName: 1,
          role: 1,
          profilePicture: 1
        }
      }
    ]);
  } else if (req.user.role === 'customer') {
    users = await User.aggregate([
      {
        $match: {
          _id: { $ne: userId },
          adminRole: { $ne: 'subAdmin' }
        }
      },
      {
        $lookup: {
          from: 'bookings',
          let: { vendorId: userId, user: '$_id' }, // pass current user’s _id to inner pipeline
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$user', '$$vendorId'] } // match bookings.user == user._id
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
            { $unwind: { path: '$serviceDetails', preserveNullAndEmptyArrays: true } },
            {
              $match: {
                $expr: { $eq: ['$serviceDetails.vendorId', '$$user'] }
              }
            }
          ],
          as: 'bookings'
        }
      },
      {
        $match: {
          $expr: {
            $or: [
              { $gt: [{ $size: '$bookings' }, 0] }, // condition 1
              { $eq: ['$role', 'admin'] } // condition 2
            ]
          }
        }
      },
      {
        $project: {
          fullName: { $concat: ['$firstName', ' ', '$lastName'] },
          firstName: 1,
          lastName: 1,
          role: 1,
          profilePicture: 1
        }
      }
    ]);
  } else {
    users = await User.find({
      _id: { $ne: req.user._id },
      adminRole: { $ne: 'subAdmin' },
      vendorRole: { $ne: 'staff' },
      customerRole: { $ne: 'staff' }
    }).select('fullName firstName lastName role profilePicture');
  }

  console.log('usersall', users);

  return res.status(200).json({
    status: 'success',
    data: users
  });
});

const updatestaus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return next(new AppError('Invalid data', 404, { status: 'status is required' }));
  }
  if (!id) {
    return next(new AppError('Invalid User ID', 404));
  }

  const user = await User.findByIdAndUpdate(id, { status }, { new: true, runValidators: true });
  if (status === 'active') {
    sendEmail(
      'Account Activated',
      user.email,
      'Your account has been activated successfully. Please login to your account.',
      {}
    );
  }

  if (!user) {
    return next(new AppError('User not found', 404, { user: 'user not found' }));
  }
  res.locals.dataId = user._id;

  // Log status change
  createLog({
    actorId: req.user._id,
    actorModel: 'admin',
    action: 'UPDATE_USER_STATUS',
    description: `Admin changed status of ${user.email} to "${status}"`,
    target: 'User',
    targetId: user._id,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  return res.status(202).json({
    status: 'success',
    user,
    message: 'Status updated successfully'
  });
});
const deleteMe = catchAsync(async (req, res, next) => {
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { status: 'Delete' },
    { new: true, runValidators: true }
  );

  if (!user) {
    return next(new AppError('User not found', 404, { user: 'user not found' }));
  }
  res.locals.dataId = user._id;

  // Log account deletion
  createLog({
    actorId: req.user._id,
    actorModel: req.user.role === 'vendor' ? 'vendor' : req.user.role === 'admin' ? 'admin' : 'customer',
    action: 'DELETE_ACCOUNT',
    description: `Account deleted (self): ${user.email}`,
    target: 'User',
    targetId: user._id,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  return res.status(204).json({
    status: 'success',
    message: 'Account deleted successfully'
  });
});

const sendMailToUsers = catchAsync(async (req, res, next) => {
  const { selectedIds, message } = req.body;

  if (!message) {
    return next(new AppError('Invalid data', 400, { message: 'Message is required' }));
  }

  if (selectedIds && Array.isArray(selectedIds) && selectedIds.length > 0) {
    const users = await User.find({ _id: { $in: selectedIds } }, { email: 1 });

    // Assuming you have a function to send emails
    await Promise.all(users.map((user) => sendEmail('Inform', user.email, message)));
    // res.locals.dataId = user._id;

    return res.status(200).json({
      status: 'success',
      message: 'Emails sent successfully'
    });
  }
  return next(
    new AppError('Invalid or empty selectedIds', 400, {
      selectedIds: 'Invalid or empty selectedIds'
    })
  );
});

const addLastViewedService = catchAsync(async (req, res, next) => {
  const user = req.user; // or wherever you're getting the user from
  const { serviceId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(serviceId)) {
    return next(new AppError('Invalid service ID.', 400));
  }

  // Remove if it already exists to re-add at top
  user.lastViewedServices = user.lastViewedServices.filter((id) => id.toString() !== serviceId);

  // Add new at the beginning
  user.lastViewedServices.unshift(serviceId);

  // Keep only the last 4
  if (user.lastViewedServices.length > 4) {
    user.lastViewedServices = user.lastViewedServices.slice(0, 4);
  }

  await user.save();
  res.locals.dataId = user._id; // Store the ID of the updated user in res.locals
  res.status(200).json({
    status: 'success',
    data: user.lastViewedServices
  });
});

const is2FAEnabled = catchAsync(async (req, res, next) => {
  const user = req.user; // or wherever you're getting the user from
  const { is2FAEnabled } = req.body;

  if (is2FAEnabled !== undefined) {
    user.is2FAEnabled = is2FAEnabled;
    await user.save();
  }

  res.locals.dataId = user._id; // Store the ID of the updated user in res.locals
  res.status(200).json({
    status: 'success',
    data: {
      is2FAEnabled: user.is2FAEnabled
    }
  });
});

module.exports = {
  getAllCustomerandVendor,
  updateMe,
  getMe,
  getUser,
  getAllUsers,
  deleteMe,
  getAllUsersforAdmin,
  updatestaus,
  sendMailToUsers,
  getVendorforService,
  CreateVendorByAdmin,
  addLastViewedService,
  UpdateUserByAdmin,
  is2FAEnabled
};
