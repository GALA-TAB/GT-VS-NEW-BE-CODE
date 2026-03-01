const User = require('../models/users/User');
const Pricing = require('../models/Pricing');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { validateVendorProfile } = require('../utils/joi/userValidation');

const { validateAndFormatPhoneNumber } = require('../utils/helperFunctions');
const {
  createStripeExpressAccount,
  createStripeOnBoardingLink
} = require('../utils/stripe-utils/connect-accounts.util');
const Vendor = require('../models/users/Vendor');
const ServiceListing = require('../models/ServiceListing');
const moment = require('moment');
const { default: mongoose } = require('mongoose');
const APIFeatures = require('../utils/apiFeatures');
const sendNotification = require('../utils/storeNotification');
const updateVendorProfile = catchAsync(async (req, res, next) => {
  const { countryCode, contact, officeContact, emergencyContact, ...updateData } = req.body;

  // Find Vendor user
  const findUser = await User.findById(req.user._id);
  if (!findUser) {
    return next(new AppError('Vendor user not found', 404, { user: 'user not found' }));
  }

  // Validate only the fields that are present in the request body
  const { error } = validateVendorProfile(req.body, { partial: true });
  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});
    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  // Validate and normalize phone numbers if provided
  try {
    if (contact !== undefined) {
      updateData.contact = contact
        ? validateAndFormatPhoneNumber(contact, countryCode)
        : '';
      if (countryCode !== undefined) updateData.countryCode = countryCode;
    }
    if (officeContact !== undefined) {
      updateData.officeContact = officeContact
        ? validateAndFormatPhoneNumber(officeContact, countryCode)
        : '';
    }
    if (emergencyContact !== undefined) {
      updateData.emergencyContact = emergencyContact
        ? validateAndFormatPhoneNumber(emergencyContact, countryCode)
        : '';
    }
  } catch (err) {
    return next(new AppError('Validation failed', 400, { contact: err.message }));
  }
  // Update vendor user with only provided information
  Object.assign(findUser, updateData);

  await findUser.save();
  res.locals.dataId = findUser._id;

  return res.status(200).json({
    status: 'success',
    message: 'Profile updated successfully',
    data: findUser
  });
});

const stripeConnect = catchAsync(async (req, res, next) => {
  try {
    let accountId;
    if (req.user.stripeAccountId) {
      accountId = req.user.stripeAccountId;
    } else {
      accountId = await createStripeExpressAccount({
        email: req.user.email,
        country: req.user?.countryName,
        userId: req.user._id
      });
    }
    const onboardingLink = await createStripeOnBoardingLink({
      accountId
    });

    const user = await Vendor.findByIdAndUpdate(
      req.user._id,
      { stripeAccountId: accountId },
      { new: true }
    );
    console.log(user, 'User after stripe account creation');
    res.locals.dataId = user._id;

    res.json({ url: onboardingLink });
  } catch (error) {
    next(new AppError('Stripe account creation failed', 500, { error: error.message }));
  }
});

const createDefaultPricing = catchAsync(async (req, res, next) => {
  const { pricingPercentage } = req.body; // Assuming pricingData is an array of pricing objects
  if (!pricingPercentage) {
    return next(
      new AppError('Pricing percentage is required', 400, {
        pricingPercentage: 'Pricing percentage is required'
      })
    );
  }
  // Check if default pricing already exists
  const existingPricing = await Pricing.findOne({});
  if (existingPricing) {
    return next(new AppError('Default pricing already exists', 400));
  }

  // Create new default pricing
  const newPricing = await Pricing.create({ pricingPercentage });
  res.locals.dataId = newPricing._id;

  return res.status(201).json({
    status: 'success',
    data: newPricing
  });
});

/// ////////////////////// update default pricing /////////////////////////
const updateDefaultPricing = catchAsync(async (req, res, next) => {
  const { pricingPercentage } = req.body; // Assuming pricingData is an array of pricing objects

  // Check if default pricing already exists
  let existingPricing = await Pricing.findOne({});
  if (!existingPricing) {
    existingPricing = new Pricing({ pricingPercentage });
  } else {
    // Update default pricing
    existingPricing.pricingPercentage = pricingPercentage;
  }
  await existingPricing.save();
  res.locals.dataId = existingPricing._id;
  return res.status(200).json({
    status: 'success',
    data: existingPricing
  });
});

const defaultPricing = catchAsync(async (req, res, next) => {
  const pricing = await Pricing.findOne({});
  if (!pricing) {
    return next(new AppError('Default pricing not found', 404));
  }
  return res.status(200).json({
    status: 'success',
    data: pricing
  });
});

const updateVendorPricing = catchAsync(async (req, res, next) => {
  const { customPricingPercentage } = req.body;
  const { id } = req.params;
  if (!customPricingPercentage) {
    return next(
      new AppError('Custom pricing percentage is required', 400, {
        customPricingPercentage: 'Custom pricing percentage is required'
      })
    );
  }

  const existingVendor = await Vendor.findByIdAndUpdate(
    id,
    { customPricingPercentage },
    { new: true, runValidators: true }
  );
  if (!existingVendor) {
    return next(new AppError('Vendor not found', 404));
  }
  res.locals.dataId = existingVendor._id;
  sendNotification({
    userId: existingVendor._id,
    title: 'Custom Pricing Updated',
    message: `Your custom pricing has been updated to ${customPricingPercentage}%`,
    type: 'user',
    dataId: existingVendor._id,
    fortype: 'vendor',
    permission: 'pricing',
    // linkUrl: `/vendor-dashboard/pricing`
  });

  return res.status(200).json({
    status: 'success',
    data: existingVendor
  });
});
const getVendorsPricing = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search = '' } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const basePipeline = [
    {
      $match: {
        role: 'vendor'
      }
    },
    {
      $addFields: {
        fullName: {
          $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }]
        }
      }
    }
  ];

  if (search.trim()) {
    basePipeline.push({
      $match: {
        $or: [
          { fullName: { $regex: search.trim(), $options: 'i' } },
          { email: { $regex: search.trim(), $options: 'i' } }
        ]
      }
    });
  }

  const paginationPipeline = [
    ...basePipeline,
    {
      $project: {
        _id: 1,
        fullName: 1,
        firstName: 1,
        lastName: 1,
        email: 1,
        customPricingPercentage: 1
      }
    },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parseInt(limit, 10) }
  ];

  const [vendorsPricing, totalResult] = await Promise.all([
    User.aggregate(paginationPipeline),
    User.aggregate([...basePipeline, { $count: 'total' }])
  ]);

  const totalCount = totalResult[0]?.total || 0;

  return res.status(200).json({
    status: 'success',
    results: vendorsPricing.length,
    totalVendors: totalCount,
    data: vendorsPricing
  });
});

const getVendorServices = catchAsync(async (req, res, next) => {
  const vendorId = req.params.id;

  const {
    keyword,
    page = 1,
    limit = 10,
    startDate,
    endDate,
    serviceTypeId,
    status,
    dateFilter,
    favorite
  } = req.query;

  const parsedLimit = parseInt(limit, 10) || 10;
  const parsedPage = parseInt(page, 10) || 1;
  const skip = (parsedPage - 1) * parsedLimit;

  const matchStage = { vendorId: new mongoose.Types.ObjectId(vendorId), isDeleted: false };
  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day').toDate();
    const end = moment.utc(endDate).endOf('day').toDate();
    matchStage.createdAt = { $gte: start, $lte: end };
  } else if (startDate) {
    const start = moment.utc(startDate).startOf('day').toDate();
    const end = moment.utc(startDate).endOf('day').toDate();
    matchStage.createdAt = { $gte: start, $lte: end };
  } else if (endDate) {
    const start = moment.utc(endDate).startOf('day').toDate();
    const end = moment.utc(endDate).endOf('day').toDate();
    matchStage.createdAt = { $gte: start, $lte: end };
  }

  if (favorite) {
    matchStage.likedBy = { $in: [new mongoose.Types.ObjectId(vendorId)] };
  }

  if (keyword) {
    matchStage.keyword = { $regex: keyword, $options: 'i' }; // case-insensitive search
  }

  if (serviceTypeId) {
    matchStage.serviceTypeId = new mongoose.Types.ObjectId(serviceTypeId);
  }

  if (dateFilter) {
    const range = getDateRange(dateFilter);
    if (range) {
      matchStage.createdAt = { $gte: range.start, $lte: range.end };
    }
  }

  if (status?.length) {
    matchStage.status = { $in: status };
  }

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: 'servicecategories', // collection name (check your db name for serviceTypeId!)
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeId'
      }
    },
    { $unwind: { path: '$serviceTypeId', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'bookings',
        let: { serviceId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$service', '$$serviceId'] } } },
          { $count: 'totalBookings' }
        ],
        as: 'bookingDetails'
      }
    },
    {
      $addFields: {
        totalBookings: {
          $ifNull: [{ $arrayElemAt: ['$bookingDetails.totalBookings', 0] }, 0]
        }
      }
    },
    {
      $addFields: {
        totalPrice: {
          $sum: {
            $map: {
              input: '$servicePrice',
              as: 'sp',
              in: '$$sp.price'
            }
          }
        }
      }
    },
    {
      $project: {
        bookingDetails: 0 // Remove the bookingDetails array, we don't need it now
      }
    },

    { $sort: { createdAt: -1 } },
    {
      $facet: {
        paginatedResults: [{ $skip: skip }, { $limit: parsedLimit }],
        totalCount: [{ $count: 'count' }]
      }
    }
  ];

  const result = await ServiceListing.aggregate(aggregatePipeline);

  const serviceListings = result[0]?.paginatedResults || [];
  const totalCount = result[0]?.totalCount[0]?.count || 0;
  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json({
    status: 'success',
    results: serviceListings.length,
    totalCount,
    totalPages: isFinite(totalPages) ? totalPages : 0,
    currentPage: parsedPage,
    data: serviceListings
  });
});
const updateVendorMode = catchAsync(async (req, res, next) => {
  const vendor = await User.findOneAndUpdate(
    { _id: req.user._id },
    { SleepMode: req.body.SleepMode },
    { new: true, runValidators: true }
  );
  if (!vendor) {
    return next(new AppError('Vendor not found', 404));
  }
  res.locals.dataId = vendor._id;
  return res.status(200).json({
    status: 'success',
    message: 'Vendor mode updated successfully'
  });
});

module.exports = {
  updateVendorProfile,
  stripeConnect,
  defaultPricing,
  createDefaultPricing,
  updateDefaultPricing,
  updateVendorPricing,
  getVendorsPricing,
  getVendorServices,
  updateVendorMode
};
