const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const Customer = require('../models/users/Customer');
const User = require('../models/users/User');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const stripe = require('../config/stripe');
const { requestSchema } = require('../utils/joi/requestValidation');
const { createPaymentIntents } = require('../utils/stripe-utils/connect-accounts.util');
const {
  createCustomer,
  attachPaymentMethod,
  updateCustomer,
  retrievePaymentMethod,
  capturePaymentIntent,
  verifyCoupon,
  cancelPaymentIntent,
  refundPaymentIntent
} = require('../utils/stripe-utils/customers.utils');
const joiError = require('../utils/joiError');
const PayHistory = require('../models/CustomerPayHistory');
const {
  getServiceBookingPrice,
  checkBookingDatesForExtension,
  checkBufferTimeAvailability
} = require('../utils/calculateServicePrice');
const Calendar = require('../models/Calendar');
const sendNotification = require('../utils/storeNotification');
const { bookingformat } = require('../utils/dataformat');
const mongoose = require('mongoose');
const Pricing = require('../models/Pricing');
const { maintoConnect } = require('../utils/stripe-utils/stripe-transfer.util');
const Payment = require('../models/Payment');
const Extensionbooking = require('../models/Extensionbooking');
const Discount = require('../models/PromoDiscountCode');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const { moderateText } = require('../utils/mediaModeration');

const filter = (param) => {
  const { status, startDate, endDate, cancelRequest } = param;
  const query = [];

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    query.push({
      $match: {
        $and: [{ checkIn: { $gte: start } }, { checkOut: { $lte: end } }]
      }
    });
  } else {
    if (startDate) {
      const start = new Date(startDate);
      query.push({
        $match: {
          checkIn: { $gte: start }
        }
      });
    }
    if (endDate) {
      const end = new Date(endDate);
      query.push({
        $match: {
          checkOut: { $lte: end }
        }
      });
    }
  }

  if (status) {
    query.push({ $match: { status } });
  }
  if (cancelRequest === 'true' || cancelRequest === true) {
    query.push({ $match: { cancelRequest: true } });
  }

  // Add filter for serviceTypeId
  console.log('Filter query:', query);

  return query;
};

const createBooking = catchAsync(async (req, res, next) => {
  const {
    service,
    checkIn,
    checkOut,
    guests,
    paymentMethodid,
    message,
    couponCode,
    addOnServices,
    timezone
  } = req.body;

  // ── Text content moderation on booking message ──
  if (message) {
    const { approved, reasons } = moderateText(message);
    if (!approved) {
      return next(new AppError(
        `Your message contains prohibited content: ${reasons[0]}`,
        400,
        { field: 'message', reasons }
      ));
    }
  }

  console.log('Request body:', req.body);
  const { error } = requestSchema.validate(req.body, {
    allowUnknown: true,
    abortEarly: false,
    convert: true
  });

  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Invalid request', 400, { errorFields }));
  }

  const listingExists = await Listing.findById(service).populate('vendorId', 'SleepMode _id');
  if (!listingExists) {
    return next(new AppError('Listing Not Found', 404));
  }
  const existingBooking = await Booking.findOne({
    service,
    status: { $in: ['pending', 'booked'] },
    $or: [
      {
        checkIn: { $lt: new Date(checkOut) },
        checkOut: { $gt: new Date(checkIn) }
      }
    ]
  });
  const checkCalendar = await Calendar.findOne({
    $or: [
      {
        serviceId: service,
        start: { $lt: new Date(checkOut) },
        end: { $gt: new Date(checkIn) }
      },
      {
        userId: listingExists?.vendorId?._id.toString(),
        start: { $lt: new Date(checkOut) },
        end: { $gt: new Date(checkIn) }
      }
    ]
  });

  console.log(listingExists, 'check calendar', checkCalendar);

  if (existingBooking) {
    return next(new AppError('This service is already booked for the selected dates.', 400));
  }
  if (checkCalendar) {
    return next(
      new AppError('This service is already booked or reserved for the selected dates.', 400)
    );
  }

  // Check buffer time availability (vendor-side check - doesn't affect pricing)
  const bufferCheck = await checkBufferTimeAvailability(
    new Date(checkIn),
    new Date(checkOut),
    service,
    listingExists.bufferTime || 0,
    listingExists.bufferTimeUnit || 'minutes',
    listingExists.durationUnit || 'hours',
    listingExists.minimumDuration || 0,
    timezone
  );

  if (!bufferCheck.available) {
    return next(new AppError(bufferCheck.reason, 400));
  }

  if (listingExists?.vendorId?.SleepMode === true) {
    return next(
      new AppError('This listing is currently unavailable because it is in sleep mode', 400)
    );
  }

  if (guests > listingExists?.maxGuests) {
    return next(
      new AppError(`Invalid request`, 400, {
        guests: `Max Guests for this service is ${listingExists?.maxGuests}`
      })
    );
  }

  const userId = req.user._id;
  const user = await Customer.findById(userId);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Get or create a Stripe customer
  let { stripeCustomerId } = user;
  if (!stripeCustomerId) {
    const customer = await createCustomer({
      email: user.email,
      name: user.name
    });

    stripeCustomerId = customer.id;

    // Save stripeCustomerId to the database
    await Customer.findByIdAndUpdate(userId, {
      $set: {
        stripeCustomerId,
        paymentMethodid
      }
    });
  }
  const { pricingModel, serviceDays, instantBookingCheck } = listingExists;
  let totalPriceforConfirm = getServiceBookingPrice(
    pricingModel,
    checkIn,
    checkOut,
    serviceDays,
    addOnServices,
    (serviceInfo = {
      timezone
    })
  );

  console.log('totalPriceforConfirm', totalPriceforConfirm);
  await attachPaymentMethod({
    paymentMethodId: paymentMethodid,
    customerId: stripeCustomerId
  });
  // Attach payment method to the customer
  await updateCustomer({
    stripeCustomerId,
    paymentMethodid
  });

  if (couponCode) {
    const discount = await Discount.findOne({
      discountCode: couponCode,
      status: 'Active',
      isDeleted: false,
      vendorId: listingExists?.vendorId?._id
    });

    if (!discount) {
      return next(new AppError('Invalid  discount code', 404));
    }
    let discountValue = 0;

    if (discount.discountType === 'Percentage' && totalPriceforConfirm) {
      discountValue = (totalPriceforConfirm * discount.percentage) / 100;
    } else if (discount.discountType === 'Fixed') {
      discountValue = discount.maxDiscount;
    }

    const coupon = await verifyCoupon({ couponCode });
    console.log(coupon, 'coupon verified in stripe');
    totalPriceforConfirm -= discountValue;
  }

  const paymentAmount = Math.round(totalPriceforConfirm * 100);
  const currency = 'usd';
  const paymentMethodId = paymentMethodid;
  const customerId = stripeCustomerId;
  const paymentIntent = await createPaymentIntents({
    amount: paymentAmount,
    currency,
    paymentMethodId,
    customerId,
    instantBookingCheck
  });

  const booking = await Booking.create({
    user: userId,
    service,
    checkIn,
    checkOut,
    guests,
    totalPrice: paymentIntent.amount / 100,
    message,
    paymentIntentId: paymentIntent?.id,
    servicePrice: addOnServices
  });
  res.locals.dataId = booking._id; // Store the ID of the created booking in res.locals

  console.log(paymentIntent, 'paymentIntent created successfully');
  if (instantBookingCheck === true && paymentIntent.status === 'succeeded') {
    await PayHistory.create({
      payoutId: paymentIntent?.id,
      customerId: booking?.user,
      bookingId: booking._id,
      bank: paymentIntent?.cardDetails?.brand || 'N/A',
      totalAmount: Math.round(paymentIntent?.amount / 100),

      status: 'Paid'
    });
    booking.status = 'booked';
    // booking.paymentStatus = true;
    await booking.save();
    sendNotification({
      userId: listingExists?.vendorId?._id,
      title: instantBookingCheck ? 'Booking Confirmed' : 'New Booking Request',
      message: instantBookingCheck
        ? `A booking from ${user?.firstName} ${user?.lastName} has been confirmed.`
        : `You have a new booking request from ${user?.firstName} ${user?.lastName}`,
      type: 'booking',
      fortype: 'new_venue',
      permission: 'bookings',
      linkUrl: `/vendor-dashboard/comfirm-Bookings`
    });
  } else {
    sendNotification({
      userId: listingExists?.vendorId?._id,
      title: 'New Booking Request',
      message: `You have a new booking request from ${user?.firstName} ${user?.lastName}`,
      type: 'booking',
      fortype: 'new_venue',
      permission: 'bookings',
      linkUrl: `/vendor-dashboard/booking-requests`
    });
  }
  user.paymentMethodid = paymentMethodid;
  await user.save();
  return res.status(200).json({
    status: 'success',
    message: 'Booking created successfully',
    booking
  });
});

const updateBookingRequestStatus = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;
  const { status = 'booked' } = req.body;
  // Check if booking exists
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }
  const listing = await Listing.findById(booking.service);
  if (
    (!listing || listing?.vendorId.toString() !== req.user._id.toString()) &&
    req.user.role !== 'admin'
  ) {
    return next(new AppError('Unauthorized to update this booking', 403));
  }
  const findcustomer = await Customer.findById(booking?.user);
  if (!findcustomer) {
    return next(new AppError('Cutomer of this booking request  not found', 404));
  }

  if (status === 'booked') {
    const paymentIntent = await retrievePaymentMethod({
      paymentMethodId: booking?.paymentIntentId
    });
    if (paymentIntent.status === 'requires_capture') {
      const capturedPayment = await capturePaymentIntent({
        paymentIntentId: booking?.paymentIntentId
      });
      console.log('capturedPayment', capturedPayment);
      if (capturedPayment.status !== 'succeeded') {
        return next(new AppError('Payment capture failed', 400));
      }
      await PayHistory.create({
        payoutId: capturedPayment?.id,
        customerId: booking?.user,
        bookingId: booking._id,
        bank: capturedPayment?.payment_method?.card?.brand,
        totalAmount: Math.round(capturedPayment?.amount / 100),
        status: 'Paid'
      });
    }

    // Construct Google Maps link for service location
    let locationLink = '';
    if (listing?.location) {
      if (listing.location.latitude && listing.location.longitude) {
        // Use coordinates for precise location
        locationLink = `https://www.google.com/maps?q=${listing.location.latitude},${listing.location.longitude}`;
      } else if (listing.location.address) {
        // Fallback to address if coordinates not available
        const addressParts = [
          listing.location.address,
          listing.location.city,
          listing.location.state,
          listing.location.country,
          listing.location.postalCode
        ]
          .filter(Boolean)
          .join(', ');
        locationLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressParts)}`;
      }
    }

    sendNotification({
      userId: booking?.user,
      title: 'Booking Confirmed',
      message: `You have confirmed the booking request from ${req.user?.firstName} ${req.user?.lastName}${locationLink ? `\n\nLocation: ${locationLink}` : ''}`,
      type: 'booking',
      fortype: 'booking',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-booking?tab=0`
    });

    booking.status = 'booked';
  } else if (status === 'rejected') {
    const cancelPaymentIntentd = await cancelPaymentIntent({
      paymentIntentId: booking?.paymentIntentId
    });
    console.log('cancelPaymentIntent', cancelPaymentIntentd);
    await PayHistory.create({
      payoutId: cancelPaymentIntentd?.id,
      customerId: booking?.user,
      bookingId: booking._id,
      bank: cancelPaymentIntentd?.cardDetails?.brand || 'N/A',
      totalAmount: Math.round(cancelPaymentIntentd?.amount / 100),
      status: 'Refunded',
      refundType: 'Full'
    });
    booking.status = 'rejected';
    sendNotification({
      userId: booking?.user,
      title: 'Booking Rejected',
      message: `Your booking request has been rejected by ${req.user?.firstName} ${req.user?.lastName}`,
      type: 'booking',
      fortype: 'booking',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-booking?tab=3`
    });
  } else {
    return next(new AppError(`Invalid status ${status}`, 400));
  }

  if (!booking.bookingResponseTime) {
    booking.bookingResponseTime = Date.now();
  }
  await booking.save();
  res.locals.dataId = booking._id; // Store the ID of the updated booking in res.locals
  return res.status(200).json({
    status: 'success',
    message: `Booking request ${status} successfully`,
    booking
  });
});

const cancelBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const booking = await Booking.findOne({ _id: id }).populate('service');

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  if (
    (req.user.role === 'customer' && booking.user.toString() !== req.user._id.toString()) ||
    (req.user.role === 'vendor' && booking.service.vendorId.toString() !== req.user._id.toString())
  ) {
    return next(new AppError('Unauthorized to cancel this booking', 403));
  }

  if (['canceled', 'rejected', 'completed'].includes(booking.status)) {
    return next(
      new AppError('Invalid request', 400, { status: `Booking already ${booking.status}` })
    );
  }
  // Compare checkIn date in UTC with current UTC date
  if (booking.status === 'booked') {
    booking.cancelRequest = true;
    await booking.save();
    return res.status(200).json({
      status: 'success',
      message: 'Booking cancellation request submitted successfully'
    });
  }

  if (booking.status === 'pending') {
    const paymentIntent = await cancelPaymentIntent({
      paymentIntentId: booking.paymentIntentId
    });
    console.log('cancelPaymentIntent', paymentIntent);
    await PayHistory.create({
      payoutId: paymentIntent?.id,
      customerId: booking?.user,
      bookingId: booking._id,
      bank: paymentIntent?.cardDetails?.brand || 'N/A',
      totalAmount: Math.round(paymentIntent?.amount / 100),
      status: 'Refunded',
      refundType: 'Full'
    });
  } else if (booking.status === 'booked') {
    // Check if the paymentIntent exists and is not already canceled
    const refundedPayment = await refundPaymentIntent({
      paymentIntentId: booking.paymentIntentId,
      amount: booking.amount
    });
    await PayHistory.findOneAndUpdate(
      { bookingId: booking._id },
      {
        status: 'Refunded',
        refundType: 'Full',
        totalAmount: Math.round(refundedPayment?.amount / 100)
      },
      { new: true, upsert: true }
    );
    if (!refundedPayment || refundedPayment.status !== 'succeeded') {
      return next(
        new AppError('Invalid request', 400, {
          status: 'Refund failed or payment intent not found'
        })
      );
    }
  }

  const data = await Booking.findOneAndUpdate(
    { _id: id },
    { status: 'canceled', cancelReason: req.body.cancelReason }
  ).populate('service');
  sendNotification({
    userId: booking?.service?.vendorId,
    title: 'Booking Canceled',
    message: `Booking has been canceled by the ${req.user.firstName} ${req.user.lastName}`,
    type: 'booking',
    fortype: 'venue_cancellation',
    permission: 'bookings',
    linkUrl: `/vendor-dashboard/cancelled-booking-details/${data._id}`
  });

  sendNotification({
    userId: booking?.user,
    title: 'Booking Canceled',
    message: `Your booking has been canceled successfully by ${req.user.firstName} ${req.user.lastName}. `,
    type: 'booking',
    fortype: 'venue_cancellation',
    permission: 'bookings',
    linkUrl: `/user-dashboard/user-booking?tab=4`
  });

  res.locals.dataId = id; // Store the ID of the canceled booking in res.locals
  return res.status(200).json({
    status: 'success',
    message: 'Booking canceled and deleted successfully'
  });
});
// Get all bookings (admin or dashboard)
const getAllBookings = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const filerQuery = filter(req.query);
  const searchQuery = req.query.search
    ? {
        $or: [
          { 'service.title': { $regex: req.query.search, $options: 'i' } },
          { 'user.fullName': { $regex: req.query.search, $options: 'i' } }
        ]
      }
    : {};

  const query = [
    ...filerQuery,
    ...bookingformat,
    {
      $match: {
        ...searchQuery
      }
    }
  ];
  if (req.query.serviceTypeId) {
    query.push({
      $match: {
        'service.serviceTypeId': new mongoose.Types.ObjectId(req.query.serviceTypeId)
      }
    });
  }

  const [total, bookings] = await Promise.all([
    Booking.aggregate([...query, { $count: 'total' }]),
    Booking.aggregate([
      ...query,
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $sort: { createdAt: -1 } }
    ])
  ]);

  return res.status(200).json({
    status: 'success',
    message: 'Bookings fetched successfully',
    total: total[0]?.total || 0,
    page,
    totalPages: Math.ceil(total[0]?.total / limit),
    bookings
  });
});

// Get all bookings for vendor listing services
const getAllBookingsForVendorService = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  console.log(req.query, 'this is query for get the request of cancel');
  const filerQuery = filter(req.query);
  const searchQuery = req.query.search
    ? {
        $or: [
          { 'service.title': { $regex: req.query.search, $options: 'i' } },
          { 'user.fullName': { $regex: req.query.search, $options: 'i' } }
        ]
      }
    : {};

  const query = [
    ...filerQuery,
    ...bookingformat,
    {
      $match: {
        'service.vendorId': new mongoose.Types.ObjectId(req.user?._id),
        ...searchQuery
      }
    }
  ];
  if (req.query.serviceTypeId) {
    query.push({
      $match: {
        'service.serviceTypeId': new mongoose.Types.ObjectId(req.query.serviceTypeId)
      }
    });
  }

  const [total, bookings] = await Promise.all([
    Booking.aggregate([...query, { $count: 'total' }]),
    Booking.aggregate([
      ...query,
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $sort: { createdAt: -1 } }
    ])
  ]);

  console.log(total, 'total booking');

  return res.status(200).json({
    status: 'success',
    message: 'Bookings fetched successfully',
    total: total[0]?.total || 0,
    page,
    totalPages: Math.ceil(total[0]?.total / limit),
    bookings
  });
});

const getAllBookingsForCustomer = catchAsync(async (req, res, next) => {
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const filerQuery = filter(req.query);
  const searchQuery = req.query.search
    ? {
        $or: [
          { 'service.title': { $regex: req.query.search, $options: 'i' } },
          { 'service.description': { $regex: req.query.search, $options: 'i' } },
          { 'vendor.fullName': { $regex: req.query.search, $options: 'i' } }
        ]
      }
    : {};
  const query = [
    { $match: withSoftDeleteFilter({ user: req.user?._id }, isDeleted) },
    ...filerQuery,
    ...bookingformat,
    {
      $match: {
        ...searchQuery
      }
    }
  ];
  if (req.query.serviceTypeId) {
    query.push({
      $match: {
        'service.serviceTypeId': new mongoose.Types.ObjectId(req.query.serviceTypeId)
      }
    });
  }

  // Get total count for pagination
  const total = await Booking.aggregate([...query, { $count: 'total' }]);

  // Fetch bookings with pagination and population
  const bookings = await Booking.aggregate([
    ...query,
    { $skip: (page - 1) * limit },
    { $limit: limit },
    { $sort: { createdAt: -1 } }
  ]);

  return res.status(200).json({
    total: total[0]?.total || 0,
    page,
    totalPages: Math.ceil(total[0]?.total / limit),
    bookings
  });
});

// Get booking by ID
const getBookingById = catchAsync(async (req, res, next) => {
  const booking = await Booking.findOne({ _id: req.params.id, isDeleted: false })
    .populate('user')
    .populate({
      path: 'service',
      populate: [
        { path: 'serviceTypeId' },
        { path: 'filters.filterId' },
        { path: 'vendorId', select: 'profilePicture email lastName firstName' },
        { path: 'faqs' },
        { path: 'eventTypes' }
      ]
    });
  // .populate('payment');

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  return res.status(200).json({
    status: 'success',
    data: booking
  });
});

// Get bookings that have messages for a given user (vendor or customer)
const getBookingsWithMessagesByUser = catchAsync(async (req, res, next) => {
  const targetUserId = req.params.userId || req.user._id;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search ? String(req.query.search).trim() : null;

  // Authorization: if requesting another user's data, only admin can do that
  if (
    req.params.userId &&
    req.user.role !== 'admin' &&
    req.params.userId !== req.user._id.toString()
  ) {
    return next(new AppError('Unauthorized to fetch other user data', 403));
  }

  // Ensure target user exists and determine their role
  const targetUser = await User.findById(targetUserId).select('role firstName lastName');
  if (!targetUser) return next(new AppError('Target user not found', 404));

  const isVendor = targetUser.role === 'vendor';

  // Build base aggregation on bookings
  const basePipeline = [];

  // Lookup service to get vendor and service title
  basePipeline.push(
    {
      $lookup: {
        from: 'servicelistings',
        localField: 'service',
        foreignField: '_id',
        as: 'service'
      }
    },
    { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } }
  );

  // Role based matching: vendor -> service.vendorId, customer -> booking.user
  if (isVendor) {
    basePipeline.push({
      $match: { 'service.vendorId': new mongoose.Types.ObjectId(targetUserId) }
    });
  } else {
    basePipeline.push({ $match: { user: new mongoose.Types.ObjectId(targetUserId) } });
  }

  // Lookup last message (with sender info) and message count
  basePipeline.push(
    {
      $lookup: {
        from: 'messages',
        let: { bookingId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$bookingId', '$$bookingId'] } } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'senderInfo'
            }
          },
          { $unwind: { path: '$senderInfo', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              content: 1,
              createdAt: 1,
              sender: {
                _id: '$senderInfo._id',
                firstName: '$senderInfo.firstName',
                lastName: '$senderInfo.lastName',
                profilePicture: '$senderInfo.profilePicture',
                role: '$senderInfo.role'
              }
            }
          }
        ],
        as: 'lastMessage'
      }
    },
    {
      $lookup: {
        from: 'messages',
        let: { bookingId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$bookingId', '$$bookingId'] } } },
          { $count: 'count' }
        ],
        as: 'messageCount'
      }
    },
    {
      $addFields: {
        messageCount: { $ifNull: [{ $arrayElemAt: ['$messageCount.count', 0] }, 0] },
        lastMessage: { $arrayElemAt: ['$lastMessage', 0] }
      }
    },
    { $match: { messageCount: { $gt: 0 } } }
  );

  // Lookup client and vendor user info (for search/display)
  basePipeline.push(
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'client'
      }
    },
    { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'service.vendorId',
        foreignField: '_id',
        as: 'vendor'
      }
    },
    { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } }
  );

  // Apply search (if provided) against service title, client and vendor names
  if (search) {
    const regex = new RegExp(search, 'i');
    basePipeline.push({
      $match: {
        $or: [
          { 'service.title': { $regex: regex } },
          { 'client.firstName': { $regex: regex } },
          { 'client.lastName': { $regex: regex } },
          { 'vendor.firstName': { $regex: regex } },
          { 'vendor.lastName': { $regex: regex } }
        ]
      }
    });
  }

  // Final projection
  const projectStage = {
    $project: {
      _id: 1,
      status: 1,
      checkIn: 1,
      checkOut: 1,
      createdAt: 1,
      totalPrice: 1,
      service: { _id: '$service._id', title: '$service.title' },
      client: {
        _id: '$client._id',
        firstName: '$client.firstName',
        lastName: '$client.lastName',
        profilePicture: '$client.profilePicture'
      },
      vendor: {
        _id: '$vendor._id',
        firstName: '$vendor.firstName',
        lastName: '$vendor.lastName',
        profilePicture: '$vendor.profilePicture'
      },
      messageCount: 1,
      lastMessage: 1
    }
  };

  const countPipeline = [...basePipeline, { $count: 'total' }];
  const resultsPipeline = [
    ...basePipeline,
    projectStage,
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit }
  ];

  const [countRes, results] = await Promise.all([
    Booking.aggregate(countPipeline),
    Booking.aggregate(resultsPipeline)
  ]);

  const total = countRes[0]?.total || 0;

  return res.status(200).json({
    status: 'success',
    total,
    page,
    totalPages: Math.ceil(total / limit) || 0,
    results: results.length,
    data: results
  });
});

// Update booking (only certain fields should be editable)
const updateBooking = catchAsync(async (req, res) => {
  const allowedUpdates = ['checkIn', 'checkOut', 'guests', 'status'];
  const updates = {};

  for (const key of allowedUpdates) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  const booking = await Booking.findOneAndUpdate(
    { _id: req.params.id, isDeleted: false },
    updates,
    { new: true, runValidators: true }
  );

  if (!booking) {
    return next(new AppError('Booking Not Found', 404));
  }
  res.locals.dataId = booking._id; // Store the ID of the updated booking in res.locals

  return res.status(200).json({ message: 'Booking updated', booking });
});

// Soft delete booking
const deleteBooking = catchAsync(async (req, res) => {
  const booking = await Booking.findOneAndUpdate(
    { _id: req.params.id },
    { isDeleted: true },
    { new: true }
  );

  if (!booking) {
    return next(new AppError('Booking Not Found', 404));
  }

  return res.status(200).json({ message: 'Booking deleted (soft)', booking });
});

const paymentByadmintoVendor = catchAsync(async (req, res) => {
  const { amount } = req.body;
  if (!amount) {
    return next(new AppError('Invalid request', 400, { amount: 'Amount is required' }));
  }

  const booking = await Booking.findOne({ _id: req.params.id, status: 'completed' }).populate(
    'service',
    'vendorId'
  );

  if (!booking) {
    return next(new AppError('Booking Not Found', 404));
  }

  if (booking?.paymentStatus === true) {
    return next(new AppError('Payment already done', 400));
  }

  /// //////find vendor stripe id and transfer amount to vendor account
  const user = await User.findById(booking?.service?.vendorId).select(
    'stripeAccountId',
    'accountStatus'
  );
  if (!user) {
    return next(new AppError('Vendor not found', 404));
  }
  const stripeAccountId = user?.stripeAccountId;
  if (!stripeAccountId) {
    return next(new AppError('Stripe account ID not found for vendor', 404));
  }

  if (user?.accountStatus === 'pending') {
    return next(new AppError('Vendor Stripe account is not complete', 400));
  }
  if (user?.accountStatus === 'inactive') {
    return next(new AppError('Vendor Stripe account is inactive', 400));
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    payment_method_types: ['card'],
    transfer_data: {
      destination: stripeAccountId
    }
  });
  const capturePayment = await stripe.paymentIntents.capture(paymentIntent.id, {
    amount: booking?.amount * 100
  });

  booking.paymentStatus = true;
  await booking.save();

  return res.status(200).json({ message: 'Payment processed successfully', booking });
});

const getRefundDataOfBooking = catchAsync(async (req, res, next) => {
  const bookingId = req.params.id;
  const findbooking = await Booking.findOne({ _id: bookingId, status: 'booked' })
    .populate('service', 'vendorId')
    .populate({
      path: 'service',
      populate: {
        path: 'vendorId'
      }
    });
  if (!findbooking) {
    return next(new AppError('Booking not found', 404));
  }
  let amountafterfee = findbooking.totalPrice;

  if (findbooking.service.vendorId.customPricingPercentage) {
    const fee =
      (findbooking.totalPrice * findbooking.service.vendorId.customPricingPercentage) / 100;
    amountafterfee = findbooking.totalPrice - fee;
  } else {
    const pricing = await Pricing.findOne({});
    if (pricing) {
      const fee = (findbooking.totalPrice * pricing.pricingPercentage) / 100;
      amountafterfee = findbooking.totalPrice - fee;
    } else {
      console.log('No pricing found, using total price as amount after fee');
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      amountafterfee,
      totalBookingAmount: findbooking.totalPrice
    }
  });
});

const refundAmount = catchAsync(async (req, res, next) => {
  const bookingId = req.params.id;
  const { amount, refundType = 'Full' } = req.body;
  console.log(amount, refundType, 'this is amount and refund type');

  const findbooking = await Booking.findOne({ _id: bookingId, status: 'booked' })
    .populate('service', 'vendorId')
    .populate({
      path: 'service',
      populate: {
        path: 'vendorId'
      }
    });
  if (!findbooking) {
    return next(new AppError('Booking not found', 404));
  }
  let amountafterfee = findbooking.totalPrice;

  if (findbooking.service.vendorId.customPricingPercentage) {
    const fee =
      (findbooking.totalPrice * findbooking.service.vendorId.customPricingPercentage) / 100;
    amountafterfee = findbooking.totalPrice - fee;
  } else {
    const pricing = await Pricing.findOne({});
    if (pricing) {
      const fee = (findbooking.totalPrice * pricing.pricingPercentage) / 100;
      amountafterfee = findbooking.totalPrice - fee;
    } else {
      console.log('No pricing found, using total price as amount after fee');
    }
  }
  let refunds = [];
  const paymentHistory = await PayHistory.find({ bookingId: findbooking._id, status: 'Paid' });
  if (!paymentHistory || paymentHistory.length === 0) {
    return next(new AppError('Payment history not found for this booking', 404));
  }

  if (refundType === 'Full') {
    let remaining = Math.round(amountafterfee * 100);
    for (let payment of paymentHistory) {
      if (remaining <= 0) break;
      console.log('payment....1', payment.totalAmount * 100);
      const refundable = Math.min(remaining, Math.round(payment.totalAmount * 100));
      console.log('refundable....1', refundable);
      const refunded = await refundPaymentIntent({
        paymentIntentId: payment.payoutId,
        amount: refundable
      });
      if (refunded?.status === 'succeeded') {
        refunds.push(refunded);
        remaining -= refundable;
      }
    }
    await PayHistory.create({
      payoutId: refunds.map((r) => r.id).join(', '),
      customerId: findbooking?.user,
      bookingId: findbooking._id,
      bank: refunds[0]?.cardDetails?.brand || 'N/A',
      totalAmount: amountafterfee,
      status: 'Refunded',
      refundType: 'Full'
    });
    findbooking.cancelReason = req.body.cancelReason;
    findbooking.status = 'canceled';
    await findbooking.save();

    // Notify customer about full refund
    const cancelReason = req.body.cancelReason || 'No reason provided';
    sendNotification({
      userId: findbooking?.user,
      title: 'Booking Refund Processed',
      message: `A full refund of $${Number(amountafterfee).toFixed(2)} has been processed for your booking. Reason: ${cancelReason}`,
      type: 'booking',
      fortype: 'booking_refund',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-finance?tab=1`
    });
  } else if (refundType === 'Partial') {
    if (!amount || amount <= 0) {
      return next(
        new AppError('Invalid request', 400, { amount: 'Amount must be greater than 0' })
      );
    }
    if (amount > amountafterfee) {
      return next(
        new AppError('Invalid request', 400, { amount: 'Amount exceeds refundable amount' })
      );
    }
    let remaining = Math.round(amount * 100);
    for (let payment of paymentHistory) {
      if (remaining <= 0) break;
      const refundable = Math.min(remaining, Math.round(payment.totalAmount * 100));
      const refunded = await refundPaymentIntent({
        paymentIntentId: payment.payoutId,
        amount: refundable
      });
      if (refunded?.status === 'succeeded') {
        refunds.push(refunded);
        remaining -= refundable;
      }
    }

    await PayHistory.create({
      payoutId: refunds.map((r) => r.id).join(', '),
      customerId: findbooking?.user,
      bookingId: findbooking._id,
      bank: refunds[0]?.cardDetails?.brand || 'N/A',
      totalAmount: amount,
      status: 'Refunded',
      refundType: 'Partial'
    });
    const vendorAmount = amountafterfee - amount;
    const transfer = await maintoConnect({
      vendor: findbooking.service.vendorId,
      amountInCents: Math.round(vendorAmount * 100)
    });
    if (transfer) {
      await Payment.create({
        booking: findbooking._id.toString(),
        vendorId: findbooking.service.vendorId._id.toString(),
        amount: vendorAmount,
        status: 'completed'
      });
    } else {
      await Payment.create({
        booking: findbooking._id.toString(),
        vendorId: findbooking.service.vendorId._id.toString(),
        amount: vendorAmount,
        status: 'pending'
      });
    }
    findbooking.status = 'canceled';
    findbooking.cancelReason = req.body.cancelReason;
    await findbooking.save();

    // Notify customer about partial refund
    const cancelReason = req.body.cancelReason || 'No reason provided';
    sendNotification({
      userId: findbooking?.user,
      title: 'Partial Refund Processed',
      message: `A partial refund of $${Number(amount).toFixed(2)} has been processed for your booking. Reason: ${cancelReason}`,
      type: 'booking',
      fortype: 'venue_cancellation',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-finances?tab=1`
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      refund: refunds
    }
  });
});

const extendBooking = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;
  const { endDate, startDate, addOnServices = [], timezone } = req.body;

  console.log(req.body, 'this is body of extend booking');
  const findbooking = await Booking.findOne({ _id: bookingId, status: 'booked' })
    .populate('service')
    .populate('user')
    .populate({
      path: 'service',
      populate: {
        path: 'vendorId'
      }
    });
  if (!findbooking) {
    return next(new AppError('Booking not found', 404));
  }

  if (req.user.role === 'customer' && findbooking.user._id.toString() !== req.user._id.toString()) {
    return next(new AppError('You are not authorized to extend this booking', 403));
  }
  console.log(findbooking?.service?.vendorId, req.user._id.toString(), 'this is vendor id');
  if (
    req.user.role === 'vendor' &&
    findbooking?.service?.vendorId?._id.toString() !== req.user._id.toString()
  ) {
    return next(new AppError('You are not authorized to extend this booking', 403));
  }

  const existingBooking = await Booking.findOne({
    service: findbooking.service._id,
    status: { $in: ['pending', 'booked'] },
    _id: { $ne: findbooking._id },
    $or: [
      {
        checkIn: { $lt: new Date(startDate) },
        checkOut: { $gt: new Date(endDate) }
      }
    ]
  });
  const checkCalendar = await Calendar.findOne({
    $or: [
      {
        serviceId: findbooking.service._id,
        start: { $lt: new Date(startDate) },
        end: { $gt: new Date(endDate) }
      },
      {
        userId: findbooking?.service?.vendorId?._id.toString(),
        start: { $lt: new Date(startDate) },
        end: { $gt: new Date(endDate) }
      }
    ]
  });

  if (existingBooking) {
    return next(new AppError('This service is already booked for the selected dates.', 400));
  }
  if (checkCalendar) {
    return next(
      new AppError('This service is already booked or reserved for the selected dates.', 400)
    );
  }

  // Check buffer time availability for extension (vendor-side check)
  const bufferCheck = await checkBufferTimeAvailability(
    new Date(startDate),
    new Date(endDate),
    findbooking.service._id,
    findbooking.service.bufferTime || 0,
    findbooking.service.bufferTimeUnit || 'minutes',
    findbooking.service.durationUnit || 'hours',
    findbooking.service.minimumDuration || 0,
    timezone,
    findbooking._id
  );

  if (!bufferCheck.available) {
    return next(new AppError(bufferCheck.reason, 400));
  }

  const today = new Date();
  if (new Date(startDate) <= today) {
    return next(new AppError('Extension start date must be after today', 400));
  }
  if (new Date(startDate) >= new Date(endDate)) {
    return next(new AppError('Extension end date must be after start date', 400));
  }

  const alreadybookingduration = checkBookingDatesForExtension(
    findbooking.checkIn,
    findbooking.checkOut,
    findbooking.service.pricingModel,
    findbooking.service.serviceDays
  );

  const newbookingduration = checkBookingDatesForExtension(
    startDate,
    endDate,
    findbooking.service.pricingModel,
    findbooking.service.serviceDays
  );

  if (newbookingduration < alreadybookingduration) {
    return next(
      new AppError('Extension duration must be greater or equal to current booking duration', 400)
    );
  }

  const previousPrice = getServiceBookingPrice(
    findbooking.service.pricingModel,
    new Date(findbooking.checkIn),
    new Date(findbooking.checkOut),
    findbooking.service.serviceDays,
    findbooking.addOnServices || [],
    (serviceInfo = {
      timezone
    })
  );
  console.log('this is findbooking', findbooking);
  const currentPrice = getServiceBookingPrice(
    findbooking.service.pricingModel,
    new Date(startDate),
    new Date(endDate),
    findbooking.service.serviceDays,
    addOnServices,
    (serviceInfo = {
      timezone
    })
  );

  let totalPriceforConfirm = 0;
  let paymentIntent = null;
  console.log('this is previous price', previousPrice, 'this is current price', currentPrice);
  if (currentPrice > previousPrice) {
    totalPriceforConfirm = currentPrice - previousPrice;
    paymentIntent = await createPaymentIntents({
      amount: Math.round(totalPriceforConfirm * 100),
      currency: 'usd',
      paymentMethodId: findbooking?.user?.paymentMethodid,
      customerId: findbooking?.user?.stripeCustomerId,
      instantBookingCheck: req.user.role === 'customer' || req.user.role === 'vendor' ? false : true
    });
  }
  console.log('this is payment intent for extension', paymentIntent);

  let extensionBooking;
  if (req.user.role === 'customer') {
    extensionBooking = await Extensionbooking.create({
      bookingId: findbooking._id,
      endDate,
      startDate,
      request: 'pending',
      newChargeAmount: totalPriceforConfirm,
      totalAmount: currentPrice,
      paymentIntentId: paymentIntent?.id,
      amount: currentPrice,
      vendorId: findbooking?.service?.vendorId?._id,
      customerId: findbooking?.user?._id,
      servicePrice: addOnServices,
      requestBy: req.user._id
    });
    console.log('this is extension booking', findbooking?.service?.vendorId?._id);
    sendNotification({
      userId: findbooking?.service?.vendorId?._id,
      title: 'Booking Extension Request',
      message: `${findbooking?.user?.firstName} ${findbooking?.user?.lastName} has requested to extend their booking until ${new Date(endDate).toLocaleDateString()}`,
      type: 'booking',
      fortype: 'booking_extension',
      permission: 'bookings',
      linkUrl: `/vendor-dashboard/extend-requests`
    });
  } else if (req.user.role === 'vendor') {
    // Vendor creates extension request - needs customer approval
    extensionBooking = await Extensionbooking.create({
      bookingId: findbooking._id,
      endDate,
      startDate,
      request: 'pending',
      newChargeAmount: totalPriceforConfirm,
      totalAmount: currentPrice,
      paymentIntentId: paymentIntent?.id,
      amount: currentPrice,
      vendorId: findbooking?.service?.vendorId?._id,
      customerId: findbooking?.user?._id,
      requestBy: req.user._id,
      servicePrice: addOnServices
    });
    sendNotification({
      userId: findbooking?.user?._id,
      title: 'Booking Extension Request from Vendor',
      message: `${req.user?.firstName} ${req.user?.lastName} has requested to extend your booking until ${new Date(endDate).toLocaleDateString()}`,
      type: 'booking',
      fortype: 'booking_extension',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-booking?tab=5`
    });
  } else if (req.user.role === 'admin') {
    // Admin directly approves extension
    extensionBooking = await Extensionbooking.create({
      bookingId: findbooking._id,
      endDate,
      startDate,
      request: 'accept',
      newChargeAmount: totalPriceforConfirm,
      totalAmount: currentPrice,
      paymentIntentId: paymentIntent?.id,
      amount: currentPrice,
      vendorId: findbooking?.service?.vendorId?._id,
      customerId: findbooking?.user?._id,
      servicePrice: addOnServices,
      requestBy: req.user._id
    });
    if (paymentIntent && paymentIntent.status === 'succeeded') {
      await PayHistory.create({
        payoutId: paymentIntent?.id,
        customerId: findbooking?.user?._id,
        bookingId: findbooking._id,
        bank: paymentIntent?.cardDetails?.brand || 'N/A',
        totalAmount: Math.round(paymentIntent?.amount / 100),
        status: 'Paid',
        extensionRequestId: extensionBooking._id
      });

      findbooking.checkOut = endDate;
      findbooking.checkIn = startDate;
      findbooking.totalPrice = currentPrice;

      findbooking.servicePrice = addOnServices;
      console.log('this is findbooking before save', findbooking);
      await findbooking.save();
    }
    // Notify customer
    sendNotification({
      userId: findbooking?.user?._id,
      title: 'Booking Extension Confirmed by Admin',
      message: `Your booking extension has been confirmed by admin until ${new Date(endDate).toLocaleDateString()}`,
      type: 'booking',
      fortype: 'booking_extension_accepted',
      permission: 'bookings',
      linkUrl: `/user-dashboard/user-booking`
    });
    // Notify vendor
    sendNotification({
      userId: findbooking?.service?.vendorId?._id,
      title: 'Booking Extension Confirmed by Admin',
      message: `Booking extension for ${findbooking?.user?.firstName} ${findbooking?.user?.lastName} has been confirmed by admin until ${new Date(endDate).toLocaleDateString()}`,
      type: 'booking',
      fortype: 'booking_extension_accepted',
      permission: 'bookings',
      linkUrl: `/vendor-dashboard/confirm-booking-details/${findbooking._id}`
    });
  }

  res.status(201).json({
    status: 'success',
    message: 'Booking extended successfully',
    data: {
      extensionBooking
    }
  });
});

const acceptorRejectExtension = catchAsync(async (req, res, next) => {
  const { extensionId } = req.params;
  const { action } = req.body; // 'accept' or 'reject'

  const extensionRequest = await Extensionbooking.findById(extensionId)
    .populate('bookingId')
    .populate('customerId')
    .populate('vendorId');

  if (!extensionRequest) {
    return next(new AppError('Extension request not found', 404));
  }

  // Check authorization
  if (
    req.user.role === 'vendor' &&
    extensionRequest.vendorId._id.toString() !== req.user._id.toString()
  ) {
    return next(new AppError('You are not authorized to manage this extension request', 403));
  }
  if (
    req.user.role === 'customer' &&
    extensionRequest.customerId._id.toString() !== req.user._id.toString()
  ) {
    return next(new AppError('You are not authorized to manage this extension request', 403));
  }

  if (action === 'accept') {
    if (extensionRequest?.paymentIntentId) {
      const capturedPayment = await capturePaymentIntent({
        paymentIntentId: extensionRequest?.paymentIntentId
      });
      console.log('capturedPayment amount', capturedPayment);
      await PayHistory.create({
        payoutId: capturedPayment?.id,
        customerId: extensionRequest?.customerId,
        bookingId: extensionRequest?.bookingId,
        bank: capturedPayment?.payment_method?.card?.brand,
        totalAmount: Math.round(capturedPayment?.amount / 100),
        status: 'Paid',
        extensionRequestId: extensionRequest._id
      });
    }
    extensionRequest.request = 'accept';
    const booking = await Booking.findById(extensionRequest.bookingId);
    booking.checkIn = extensionRequest.startDate;
    booking.checkOut = extensionRequest.endDate;
    booking.totalPrice = extensionRequest.totalAmount;
    booking.servicePrice = extensionRequest.servicePrice;
    await booking.save();

    // Send notifications based on who approved
    if (req.user.role === 'vendor') {
      // Vendor approved customer's extension request
      sendNotification({
        userId: extensionRequest?.customerId?._id,
        title: 'Booking Extension Accepted',
        message: `Your booking extension request has been accepted by ${req.user?.firstName} ${req.user?.lastName} until ${new Date(extensionRequest.endDate).toLocaleDateString()}`,
        type: 'booking',
        fortype: 'booking_extension_accepted',
        permission: 'bookings',
        linkUrl: `/user-dashboard/user-booking?tab=0`
      });
    } else if (req.user.role === 'customer') {
      // Customer approved vendor's extension request
      sendNotification({
        userId: extensionRequest?.vendorId?._id,
        title: 'Booking Extension Accepted',
        message: `${req.user?.firstName} ${req.user?.lastName} has accepted your booking extension request until ${new Date(extensionRequest.endDate).toLocaleDateString()}`,
        type: 'booking',
        fortype: 'booking_extension_accepted',
        permission: 'bookings',
        linkUrl: `/vendor-dashboard/booking-extend/details/${extensionRequest.bookingId}`
      });
    }
  } else if (action === 'reject') {
    // Handle rejection logic
    extensionRequest.request = 'reject';
    if (extensionRequest?.paymentIntentId) {
      const cancelPaymentIntentd = await cancelPaymentIntent({
        paymentIntentId: extensionRequest?.paymentIntentId
      });
      console.log('cancelPaymentIntent', cancelPaymentIntentd);
    }

    // Send notifications based on who rejected
    if (req.user.role === 'vendor') {
      // Vendor rejected customer's extension request
      sendNotification({
        userId: extensionRequest?.customerId?._id,
        title: 'Booking Extension Rejected',
        message: `Your booking extension request has been rejected by ${req.user?.firstName} ${req.user?.lastName}`,
        type: 'booking',
        fortype: 'booking_extension_rejected',
        permission: 'bookings',
        linkUrl: `/user-dashboard/user-booking?tab=5`
      });
    } else if (req.user.role === 'customer') {
      // Customer rejected vendor's extension request
      sendNotification({
        userId: extensionRequest?.vendorId?._id,
        title: 'Booking Extension Rejected',
        message: `${req.user?.firstName} ${req.user?.lastName} has rejected your booking extension request`,
        type: 'booking',
        fortype: 'booking_extension_rejected',
        permission: 'bookings',
        linkUrl: `/vendor-dashboard/booking-extend/details/${extensionRequest.bookingId}`
      });
    }
  } else {
    return next(new AppError('Invalid action', 400));
  }
  await extensionRequest.save();

  res.status(200).json({
    status: 'success',
    message: `Extension request ${action}ed successfully`,
    data: {
      extensionRequest
    }
  });
});

const getExtensionBooking = catchAsync(async (req, res, next) => {
  const { extensionId } = req.params;

  const extensionBooking = await Extensionbooking.findById(extensionId);
  if (!extensionBooking) {
    return next(new AppError('Extension booking not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      extensionBooking
    }
  });
});

const extensionsRequestForVendor = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const extensionRequests = await Extensionbooking.find({
    request: 'pending',
    vendorId: req.user._id
  })
    .populate('bookingId')
    .populate('customerId')
    .populate({
      path: 'bookingId',
      populate: {
        path: 'service'
      }
    })
    .skip((page - 1) * limit)
    .limit(limit)
    .sort({ createdAt: -1 });
  const totalRequests = await Extensionbooking.countDocuments({
    request: 'pending',
    vendorId: req.user._id
  });

  res.status(200).json({
    status: 'success',
    data: {
      extensionRequests,
      total: totalRequests,
      page,
      totalPages: Math.ceil(totalRequests / limit)
    }
  });
});

const extensionsRequestForCustomer = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const extensionRequests = await Extensionbooking.find({
    request: 'pending',
    customerId: req.user._id
  })
    .populate('bookingId')
    .populate('vendorId')
    .populate({
      path: 'bookingId',
      populate: {
        path: 'service'
      }
    })
    .skip((page - 1) * limit)
    .limit(limit)
    .sort({ createdAt: -1 });
  const totalRequests = await Extensionbooking.countDocuments({
    request: 'pending',
    customerId: req.user._id
  });

  res.status(200).json({
    status: 'success',
    data: {
      extensionRequests,
      total: totalRequests,
      page,
      totalPages: Math.ceil(totalRequests / limit)
    }
  });
});

const getBookingExtensionHistory = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  const extensionHistory = await Extensionbooking.find({
    bookingId: bookingId
  })
    .populate('customerId')
    .populate('vendorId')
    .skip((page - 1) * limit)
    .limit(limit);

  const totalHistory = await Extensionbooking.countDocuments({
    bookingId: bookingId
  });

  res.status(200).json({
    status: 'success',
    data: {
      extensionHistory,
      total: totalHistory,
      page,
      totalPages: Math.ceil(totalHistory / limit)
    }
  });
});

const checkServiceAvailability = catchAsync(async (req, res, next) => {
  const { serviceId } = req.params;
  const { checkIn, checkOut } = req.body;

  if (!checkIn || !checkOut) {
    return next(new AppError('Check-in and check-out dates are required', 400));
  }

  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);

  if (checkInDate >= checkOutDate) {
    return next(new AppError('Check-out date must be after check-in date', 400));
  }

  // Check if listing exists
  const listingExists = await Listing.findById(serviceId).populate('vendorId', 'SleepMode _id');
  if (!listingExists) {
    return next(new AppError('Listing not found', 404));
  }

  // Check if vendor is in sleep mode
  if (listingExists?.vendorId?.SleepMode === true) {
    return res.status(200).json({
      status: 'success',
      available: false,
      reason: 'This listing is currently unavailable because it is in sleep mode'
    });
  }

  // Check for existing bookings
  const existingBooking = await Booking.findOne({
    service: serviceId,
    status: { $in: ['pending', 'booked'] },
    $or: [
      {
        checkIn: { $lt: checkOutDate },
        checkOut: { $gt: checkInDate }
      }
    ]
  });

  if (existingBooking) {
    return res.status(200).json({
      status: 'success',
      available: false,
      reason: 'This service is already booked for the selected dates',
      conflictingBooking: {
        checkIn: existingBooking.checkIn,
        checkOut: existingBooking.checkOut
      }
    });
  }

  // Check calendar for blocked dates
  const checkCalendar = await Calendar.findOne({
    $or: [
      {
        serviceId: serviceId,
        start: { $lt: checkOutDate },
        end: { $gt: checkInDate }
      },
      {
        userId: listingExists?.vendorId?._id.toString(),
        start: { $lt: checkOutDate },
        end: { $gt: checkInDate }
      }
    ]
  });

  if (checkCalendar) {
    return res.status(200).json({
      status: 'success',
      available: false,
      reason: 'This service is already booked or reserved for the selected dates',
      conflictingCalendar: {
        start: checkCalendar.start,
        end: checkCalendar.end,
        title: checkCalendar.title || 'Reserved'
      }
    });
  }

  // Check buffer time availability (vendor-side availability check)
  const bufferCheck = await checkBufferTimeAvailability(
    checkInDate,
    checkOutDate,
    serviceId,
    listingExists.bufferTime || 0,
    listingExists.bufferTimeUnit || 'minutes',
    listingExists.durationUnit || 'hours',
    listingExists.minimumDuration || 0,
    req.body.timezone
  );

  if (!bufferCheck.available) {
    return res.status(200).json({
      status: 'success',
      available: false,
      reason: bufferCheck.reason,
      conflictingBooking: bufferCheck.conflictingBooking
    });
  }

  // Service is available
  return res.status(200).json({
    status: 'success',
    available: true,
    message: 'Service is available for the selected dates',
    service: {
      _id: listingExists._id,
      title: listingExists.title,
      maxGuests: listingExists.maxGuests,
      pricingModel: listingExists.pricingModel,
      bufferTime: listingExists.bufferTime,
      bufferTimeUnit: listingExists.bufferTimeUnit,
      minimumDuration: listingExists.minimumDuration,
      durationUnit: listingExists.durationUnit
    }
  });
});

module.exports = {
  createBooking,
  updateBookingRequestStatus,
  getAllBookings,
  getExtensionBooking,
  deleteBooking,
  updateBooking,
  getBookingById,
  getBookingsWithMessagesByUser,
  getAllBookingsForVendorService,
  getAllBookingsForCustomer,
  cancelBooking,
  paymentByadmintoVendor,
  getRefundDataOfBooking,
  refundAmount,
  extendBooking,
  acceptorRejectExtension,
  extensionsRequestForVendor,
  extensionsRequestForCustomer,
  getBookingExtensionHistory,
  checkServiceAvailability
};
