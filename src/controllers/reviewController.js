const { name } = require('ejs');
const mongoose = require('mongoose');
const Bookings = require('../models/Bookings');
const Review = require('../models/Review');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { ReviewValidation } = require('../utils/joi/reviewValidation');
const joiError = require('../utils/joiError');
const sendNotification = require('../utils/storeNotification');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const { moderateText } = require('../utils/mediaModeration');
const User = require('../models/users/User');

const AddReview = catchAsync(async (req, res, next) => {
  const { rating, comment, reviewOn } = req.body;
  const schema = ReviewValidation.fork(['reviewOn', 'rating', 'comment', 'reviewType'], (field) =>
    field.required()
  );

  // Validate the review data
  const { error } = schema.validate(req.body, {
    abortEarly: false
  });

  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  const findBooking = await Bookings.findOne({ _id: reviewOn }).populate({
    path: 'service',
    select: 'vendorId _id'
  });
  if (!findBooking) {
    return next(new AppError('No booking found for this review', 404));
  }
  console.log(findBooking, 'findBooking');

  if (findBooking.status !== 'completed') {
    return next(new AppError('You can only review completed bookings', 400));
  }
  // Check if the user has already reviewed this booking
  const existingReview = await Review.findOne({
    reviewOn,
    reviewer: req.user._id,
    isDeleted: false
  });
  if (existingReview) {
    return next(new AppError('You have already reviewed this booking', 400));
  }

  // ── Text content moderation (same detection as service description) ──
  if (comment) {
    // Get the vendor's company name + full name from the booking's service
    const reviewVendor = findBooking?.service?.vendorId
      ? await User.findById(findBooking.service.vendorId).select('companyName firstName lastName').lean()
      : null;
    const rvFullName = [reviewVendor?.firstName, reviewVendor?.lastName].filter(Boolean).join(' ');
    const { approved, reasons } = moderateText(comment, {
      companyName: reviewVendor?.companyName || '',
      vendorNames: rvFullName ? [rvFullName] : [],
    });
    if (!approved) {
      return next(new AppError(
        `Review contains prohibited content: ${reasons[0]}`,
        400,
        { field: 'comment', reasons }
      ));
    }
  }

  const review = await Review.create({
    rating,
    comment,
    reviewOn,
    reviewer: req.user._id,
    reviewType: req.body.reviewType
  });
  console.log(
    review,
    req.user.role === 'customer'
      ? `/vendor-dashboard/booking-details/${findBooking?._id}`
      : `/user-dashboard/user-rating?tab=1`
  );
  sendNotification({
    userId: req.user.role === 'customer' ? findBooking.service.vendorId : findBooking.user,
    title: 'New Review',
    message: `${req.user.firstName} ${req.user.lastName} has reviewed your service`,
    type: 'review',
    fortype: 'venue_feedback',
    permission: 'review',
    linkUrl:
      req.user.role === 'customer'
        ? `/vendor-dashboard/booking-details/${findBooking?._id}`
        : `/user-dashboard/user-rating?tab=1`
  });

  res.locals.dataId = review._id; // Store the ID of the created review in res.locals

  res.status(201).json({
    status: 'success',
    data: {
      review
    }
  });
});

const getAllReviews = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 10,
    serviceCategories,
    reviewType,
    owners,
    ratings,
    search,
    reviewerRole
  } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const skip = (page - 1) * limit;

  const matchStage = {};

  if (reviewType) {
    matchStage.reviewType = reviewType;
  }

  if (ratings) {
    const ratingValues = Array.isArray(ratings) ? ratings : [ratings];
    matchStage.rating = { $in: ratingValues.map((r) => Number(r)) };
  }

  if (serviceCategories) {
    const categoryValues = Array.isArray(serviceCategories)
      ? serviceCategories
      : [serviceCategories];
    matchStage['service.ServiceCategory'] = {
      $in: categoryValues.map((c) => new mongoose.Types.ObjectId(c))
    };
  }

  if (owners) {
    const ownerIds = Array.isArray(owners)
      ? owners.map((id) => new mongoose.Types.ObjectId(id))
      : [new mongoose.Types.ObjectId(owners)];
    matchStage['serviceOwner._id'] = { $in: ownerIds };
  }

  if (reviewerRole) {
    matchStage['reviewer.role'] = reviewerRole;
  }

  if (search) {
    matchStage.$or = [
      { 'serviceOwner.fullName': { $regex: search, $options: 'i' } },
      { 'reviewer.email': { $regex: search, $options: 'i' } },
      { 'service.title': { $regex: search, $options: 'i' } },
      { 'service.description': { $regex: search, $options: 'i' } },

      { comment: { $regex: search, $options: 'i' } }
    ];
  }

  const finalMatchStage = withSoftDeleteFilter(matchStage, isDeleted);

  const queryPipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'reviewer',
        foreignField: '_id',
        as: 'reviewer'
      }
    },
    { $unwind: { path: '$reviewer', preserveNullAndEmptyArrays: true } },
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
        from: 'servicelistings',
        localField: 'booking.service',
        foreignField: '_id',
        as: 'service'
      }
    },
    { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'service.vendorId',
        foreignField: '_id',
        as: 'serviceOwner'
      }
    },
    { $unwind: { path: '$serviceOwner', preserveNullAndEmptyArrays: true } },

    {
      $addFields: {
        'serviceOwner.fullName': {
          $concat: [
            { $ifNull: ['$serviceOwner.firstName', ''] },
            ' ',
            { $ifNull: ['$serviceOwner.lastName', ''] }
          ]
        }
      }
    },
    { $match: finalMatchStage }
  ];

  const result = await Review.aggregate([
    {
      $facet: {
        stats: [
          ...queryPipeline,
          {
            $group: {
              _id: null,
              totalReviews: { $sum: 1 }
            }
          }
        ],
        reviews: [
          ...queryPipeline,
          { $sort: { createdAt: -1 } },
          { $skip: Number(skip) },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 1,
              rating: 1,
              comment: 1,
              reviewOn: 1,
              createdAt: 1,
              updatedAt: 1,
              reviewType: 1,
              reviewer: 1,
              booking: 1,
              service: 1,
              hide: 1,
              serviceOwner: {
                _id: 1,
                profilePicture: 1,
                firstName: 1,
                lastName: 1,
                email: 1
              }
            }
          }
        ]
      }
    },
    {
      $project: {
        stats: { $arrayElemAt: ['$stats', 0] },
        reviews: 1
      }
    }
  ]);

  const { stats, reviews } = result[0];

  res.status(200).json({
    status: 'success',
    results: reviews.length,
    page: Number(page),
    limit: Number(limit),
    reviews,
    totalReviews: stats?.totalReviews || 0
  });
});

const getReviewsforService = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const skip = (page - 1) * limit;

  const query = [
    {
      $lookup: {
        from: 'users',
        localField: 'reviewer',
        foreignField: '_id',
        as: 'reviewer',
        pipeline: [
          {
            $match: { role: 'customer' }
          }
        ]
      }
    },
    { $unwind: '$reviewer' },
    {
      $lookup: {
        from: 'bookings',
        localField: 'reviewOn',
        foreignField: '_id',
        as: 'booking'
      }
    },
    { $unwind: '$booking' },
    {
      $match: withSoftDeleteFilter({
        reviewType: req.query.reviewType || { $exists: true },
        'booking.service': new mongoose.Types.ObjectId(req.params.id),
        hide: false
      }, isDeleted)
    }
  ];

  const result = await Review.aggregate([
    {
      $facet: {
        stats: [
          ...query,
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              totalReviews: { $sum: 1 }
            }
          }
        ],
        reviews: [
          ...query,
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 1,
              rating: 1,
              comment: 1,
              reviewOn: 1,
              createdAt: 1,
              updatedAt: 1,
              hide: 1,
              reviewer: { firstName: 1, lastName: 1, profilePicture: 1, location: 1 },
              serviceId: '$booking.service',
              bookingDate:'$booking.checkIn'
            }
          }
        ]
      }
    },
    {
      $project: {
        stats: { $arrayElemAt: ['$stats', 0] },
        reviews: 1
      }
    }
  ]);

  const { stats, reviews } = result[0];

  res.status(200).json({
    status: 'success',
    results: reviews.length,
    page: Number(page),
    limit: Number(limit),
    reviews,
    totalReviews: stats?.totalReviews || 0,
    averageRating: stats?.averageRating || 0
  });
});

const getReviewById = catchAsync(async (req, res, next) => {
  const review = await Review.findById(req.params.id)
    .populate('reviewer', 'name email profilePicture')
    .populate('reviewOn');
  if (!review) {
    return next(new AppError('No review found with that ID', 404));
  }
  res.status(200).json({
    status: 'success',
    data: {
      review
    }
  });
});

const EditReview = catchAsync(async (req, res, next) => {
  const { error } = ReviewValidation.validate(req.body, {
    abortEarly: false,
    allowUnknown: true
  });
  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Validation failed', 400, { errorFields }));
  }
  // Find the review by ID
  const review = await Review.findById(req.params.id);
  if (!review) {
    return next(new AppError('No review found with that ID', 404));
  }
  // Check if the user is the reviewer
  if (review.reviewer.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
    return next(new AppError('Unauthorized to update this review', 403));
  }

  // ── Text content moderation (same detection as service description) ──
  if (req.body.comment) {
    // Get the vendor's company name + full name via the review's booking → service → vendorId
    let editVendorCompanyName = '';
    let editVendorFullName = '';
    if (review.reviewOn) {
      const reviewBooking = await Bookings.findById(review.reviewOn).populate({ path: 'service', select: 'vendorId' }).lean();
      if (reviewBooking?.service?.vendorId) {
        const editVendor = await User.findById(reviewBooking.service.vendorId).select('companyName firstName lastName').lean();
        editVendorCompanyName = editVendor?.companyName || '';
        editVendorFullName = [editVendor?.firstName, editVendor?.lastName].filter(Boolean).join(' ');
      }
    }
    const { approved, reasons } = moderateText(req.body.comment, {
      companyName: editVendorCompanyName,
      vendorNames: editVendorFullName ? [editVendorFullName] : [],
    });
    if (!approved) {
      return next(new AppError(
        `Review contains prohibited content: ${reasons[0]}`,
        400,
        { field: 'comment', reasons }
      ));
    }
  }

  const updatedReview = await Review.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });
  res.locals.dataId = updatedReview._id; // Store the ID of the created review in res.locals
  res.status(200).json({
    status: 'success',
    data: {
      review: updatedReview
    }
  });
});

/// //////////////////// DELETE REVIEW /////////////////////////
const DeleteReview = catchAsync(async (req, res, next) => {
  const review = await Review.findById(req.params.id);
  if (!review) {
    return next(new AppError('No review found with that ID', 404));
  }
  // Check if the user is the reviewer
  // if (review.reviewer.toString() !== req.user._id.toString()) {
  //     return next(new AppError('Unauthorized to delete this review', 403));
  // }
  const deletedReview = await Review.findByIdAndUpdate(
    req.params.id,
    {
      isDeleted: true
    },
    { new: true }
  );

  res.locals.dataId = deletedReview._id; // Store the ID of the deleted review in res.locals
  res.status(200).json({
    status: 'success',
    data: {
      review: deletedReview
    }
  });
});

const hideReview = catchAsync(async (req, res, next) => {
  const { hide = false } = req.body;
  const review = await Review.findById(req.params.id);
  if (!review) {
    return next(new AppError('No review found with that ID', 404));
  }
  // Check if the user is the reviewer
  if (review.reviewer.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
    return next(new AppError('Unauthorized to hide this review', 403));
  }

  review.hide = hide;
  await review.save();

  res.status(200).json({
    status: 'success',
    data: {
      review
    }
  });
});

const getUserReviewsByVendor = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, reviewType } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const user = req.user._id;
  const skip = (page - 1) * limit;

  const query = [
    {
      $lookup: {
        from: 'users',
        localField: 'reviewer',
        foreignField: '_id',
        as: 'reviewer',
        pipeline: [
          {
            $match: { role: 'vendor' }
          }
        ]
      }
    },
    { $unwind: { path: '$reviewer' } },
    {
      $lookup: {
        from: 'bookings',
        localField: 'reviewOn',
        foreignField: '_id',
        as: 'booking',
        pipeline: [{ $match: { user: new mongoose.Types.ObjectId(user) } }]
      }
    },
    { $unwind: { path: '$booking' } },
    {
      $lookup: {
        from: 'servicelistings',
        localField: 'booking.service',
        foreignField: '_id',
        as: 'service'
      }
    },
    { $unwind: { path: '$service' } },
    {
      $match: withSoftDeleteFilter({
        ...(reviewType && { reviewType: reviewType })
      }, isDeleted)
    }
  ];

  const result = await Review.aggregate([
    {
      $facet: {
        stats: [
          ...query,
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              totalReviews: { $sum: 1 }
            }
          }
        ],
        reviews: [
          ...query,
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 1,
              rating: 1,
              comment: 1,
              reviewOn: 1,
              reviewType: 1,
              createdAt: 1,
              updatedAt: 1,
              bookingDate:'$booking.checkIn',
              hide: 1,
              reviewer: {
                _id: 1,
                firstName: 1,
                lastName: 1,
                profilePicture: 1,
                location: 1
              },
              service: {
                _id: 1,
                title: 1,
                vendorId: 1,
                media: 1
              }
            }
          }
        ]
      }
    },
    {
      $project: {
        stats: { $arrayElemAt: ['$stats', 0] },
        reviews: 1
      }
    }
  ]);

  const { stats, reviews } = result[0];

  res.status(200).json({
    status: 'success',
    results: reviews.length,
    page: Number(page),
    limit: Number(limit),
    reviews,
    totalReviews: stats?.totalReviews || 0,
    averageRating: stats?.averageRating || 0
  });
});
const getUserReviewsById = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, reviewType } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const user = req.params.id;
  const skip = (page - 1) * limit;

  const query = [
    {
      $lookup: {
        from: 'users',
        localField: 'reviewer',
        foreignField: '_id',
        as: 'reviewer',
        pipeline: [
          {
            $match: { role: 'vendor' }
          }
        ]
      }
    },
    { $unwind: { path: '$reviewer' } },
    {
      $lookup: {
        from: 'bookings',
        localField: 'reviewOn',
        foreignField: '_id',
        as: 'booking',
        pipeline: [{ $match: { user: new mongoose.Types.ObjectId(user) } }]
      }
    },
    { $unwind: { path: '$booking' } },
    {
      $lookup: {
        from: 'servicelistings',
        localField: 'booking.service',
        foreignField: '_id',
        as: 'service'
      }
    },
    { $unwind: { path: '$service' } },
    {
      $match: withSoftDeleteFilter({
        ...(reviewType && { reviewType: reviewType })
      }, isDeleted)
    }
  ];

  const result = await Review.aggregate([
    {
      $facet: {
        stats: [
          ...query,
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              totalReviews: { $sum: 1 }
            }
          }
        ],
        reviews: [
          ...query,
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 1,
              rating: 1,
              comment: 1,
              reviewOn: 1,
              reviewType: 1,
              createdAt: 1,
              updatedAt: 1,
              bookingDate:'$booking.checkIn',
              hide: 1,
              reviewer: {
                _id: 1,
                firstName: 1,
                lastName: 1,
                profilePicture: 1,
                location: 1
              },
              service: {
                _id: 1,
                title: 1,
                vendorId: 1,
                media: 1
              }
            }
          }
        ]
      }
    },
    {
      $project: {
        stats: { $arrayElemAt: ['$stats', 0] },
        reviews: 1
      }
    }
  ]);

  const { stats, reviews } = result[0];

  res.status(200).json({
    status: 'success',
    results: reviews.length,
    page: Number(page),
    limit: Number(limit),
    reviews,
    totalReviews: stats?.totalReviews || 0,
    averageRating: stats?.averageRating || 0
  });
});
module.exports = {
  AddReview,
  getAllReviews,
  getReviewById,
  EditReview,
  DeleteReview,
  getReviewsforService,
  hideReview,
  getUserReviewsByVendor,
  getUserReviewsById
};
