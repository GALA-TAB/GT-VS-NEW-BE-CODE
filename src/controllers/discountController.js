const catchAsync = require('../utils/catchAsync');
const Discount = require('../models/PromoDiscountCode');
const AppError = require('../utils/appError');
const { discountValidation } = require('../utils/joi/discountValidation');
const joiError = require('../utils/joiError');
const { STRIPE_SECRET_ACCESS_KEY } = process.env;
const moment = require('moment');
const {
  createCoupon,
  verifyCoupon,
  updateCoupon,
  deleteCoupon
} = require('../utils/stripe-utils/customers.utils');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
// Create Discount
const createDiscount = catchAsync(async (req, res, next) => {
  const {
    discountName,
    discountType,
    startDate,
    endDate,
    percentage,
    maxDiscount,
    minAmountInCart,
    maxTotalUsage,
    discountCode,
    serviceListingId,
    status
  } = req.body;

  const partialSchema = discountValidation.fork(
    ['discountName', 'discountType', 'startDate', 'endDate', 'discountCode'],
    (schema) => schema.required()
  );

  const { error } = partialSchema.validate(req.body, {
    abortEarly: false,
    allowUnknown: true
  });

  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  const discountData = {
    discountName,
    discountType,
    startDate,
    endDate,
    percentage,
    maxDiscount,
    minAmountInCart,
    maxTotalUsage,
    discountCode,
    serviceListingId: serviceListingId || null,
    status: status || 'Active',
    vendorId: req.user._id // Assuming req.user contains the authenticated user's information
  };

  const coupon = await createCoupon({ discountData });

  console.log(coupon, 'coupon created in stripe');

  const discount = await Discount.create(discountData);
  res.locals.dataId = discount._id;
  res.status(201).json({
    status: 'success',
    data: discount,
    message: 'Discount created successfully'
  });
});

// Get Single Discount
const getDiscount = catchAsync(async (req, res, next) => {
  const discount = await Discount.findById(req.params.id);

  if (!discount) {
    return next(new AppError('No discount found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: discount
  });
});

// Get All Discounts
const getAllDiscounts = catchAsync(async (req, res, next) => {
  const page = req.query.page * 1 || 1;
  const limit = req.query.limit * 1 || 10;
  const skip = (page - 1) * limit;

  const { status } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const queryObj = {};

  if (status) {
    queryObj.status = status;
  }

  const filterQuery = withSoftDeleteFilter(queryObj, isDeleted);

  const discounts = await Discount.find(filterQuery).skip(skip).limit(limit);

  const totalDiscounts = await Discount.countDocuments(filterQuery);
  const totalPages = Math.ceil(totalDiscounts / limit);

  res.status(200).json({
    status: 'success',
    data: discounts,
    totalDiscounts,
    totalPages,
    currentPage: page
  });
});

// Update Discount
const updateDiscount = catchAsync(async (req, res, next) => {
  const { error } = discountValidation.validate(req.body, {
    abortEarly: false,
    allowUnknown: true
  });

  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  // Get the existing discount to retrieve the old coupon code
  const existingDiscount = await Discount.findOne({ _id: req.params.id, vendorId: req.user._id });

  if (!existingDiscount) {
    return next(new AppError('No discount found with that ID', 404));
  }

  // Check if critical fields that affect Stripe coupon have changed
  const needsStripeUpdate =
    req.body.endDate ||
    req.body.maxTotalUsage ||
    req.body.discountCode ||
    req.body.discountType ||
    req.body.percentage ||
    req.body.maxDiscount;

  if (needsStripeUpdate) {
    // Prepare discount data for Stripe update
    const discountData = {
      discountCode: req.body.discountCode || existingDiscount.discountCode,
      discountType: req.body.discountType || existingDiscount.discountType,
      endDate: req.body.endDate || existingDiscount.endDate,
      maxTotalUsage: req.body.maxTotalUsage || existingDiscount.maxTotalUsage,
      percentage: req.body.percentage || existingDiscount.percentage,
      maxDiscount: req.body.maxDiscount || existingDiscount.maxDiscount
    };

    // Update coupon in Stripe
    await updateCoupon({
      oldCouponCode: existingDiscount.discountCode,
      discountData
    });

    console.log('Coupon updated in Stripe');
  }

  // Update the discount in the database
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.id, vendorId: req.user._id },
    req.body,
    {
      new: true,
      runValidators: true
    }
  );

  res.locals.dataId = discount._id;
  res.status(200).json({
    status: 'success',
    data: discount
  });
});

// Verify Discount Code and Calculate Discount Value
const verifyDiscount = catchAsync(async (req, res, next) => {
  const { discountCode, bookingTotal, vendorId } = req.body;

  if (!discountCode) {
    return next(
      new AppError('Discount code is required', 400, { discountCode: 'discount code is required' })
    );
  }

  if (!bookingTotal) {
    return next(
      new AppError('Booking total is required', 400, { bookingTotal: 'booking total is required' })
    );
  }
  const discount = await Discount.findOne({
    discountCode,
    status: 'Active',
    isDeleted: false,
    vendorId: vendorId
  });

  if (!discount) {
    return next(new AppError('Invalid  discount code', 404));
  }

  let discountValue = 0;

  if (discount.discountType === 'Percentage' && bookingTotal) {
    discountValue = (bookingTotal * discount.percentage) / 100;
  } else if (discount.discountType === 'Fixed') {
    discountValue = discount.maxDiscount;
  }

  if (bookingTotal && discount.minAmountInCart && bookingTotal < discount.minAmountInCart) {
    return next(
      new AppError('Booking total does not meet the minimum amount required for this discount', 400)
    );
  }

  const coupon = await verifyCoupon({ couponCode: discountCode });
  console.log(coupon, 'coupon verified in stripe');
  res.locals.dataId = discount._id;

  res.status(200).json({
    status: 'success',
    discountValue,
    discount
  });
});

// Soft Delete Discount
const deleteDiscount = catchAsync(async (req, res, next) => {
  const discount = await Discount.findOne({ _id: req.params.id });

  if (!discount) {
    return next(new AppError('No discount found with that ID', 404));
  }

  // Delete the coupon from Stripe
  try {
    await deleteCoupon({ couponCode: discount.discountCode });
    console.log('Coupon deleted from Stripe');
  } catch (error) {
    console.error('Error deleting coupon from Stripe:', error);
    // Continue with database deletion even if Stripe deletion fails
  }

  // Soft delete in database
  const deletedDiscount = await Discount.findOneAndUpdate(
    { _id: req.params.id },
    { isDeleted: true },
    { new: true }
  );

  res.locals.dataId = deletedDiscount._id;
  res.status(204).json({
    status: 'success',
    data: null
  });
});
const getdiscountForVendor = catchAsync(async (req, res, next) => {
  const vendorId = req.user._id;
  const { status, endDate, startDate, page = 1, limit = 10, search } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const skip = (page - 1) * limit;
  const queryObj = { vendorId: vendorId };

  if (status) {
    queryObj.status = status;
  }
  if (search) {
    queryObj.$or = [
      { discountCode: { $regex: search, $options: 'i' } },
      { discountName: { $regex: search, $options: 'i' } }
    ];
  }

  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    queryObj.startDate = { $gte: start.toDate() };
    queryObj.endDate = { $lte: end.toDate() };
  } else if (startDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(startDate).endOf('day');
    queryObj.startDate = { $gte: start.toDate(), $lte: end.toDate() };
  } else if (endDate) {
    const start = moment.utc(endDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    queryObj.endDate = { $gte: start.toDate(), $lte: end.toDate() };
  }

  console.log(queryObj, 'queryObj');
  const filterQuery = withSoftDeleteFilter(queryObj, isDeleted);
  const discounts = await Discount.find(filterQuery).skip(skip).limit(limit);

  const totalDiscounts = await Discount.countDocuments(filterQuery);
  const totalPages = Math.ceil(totalDiscounts / limit);

  res.status(200).json({
    status: 'success',
    data: discounts,
    totalDiscounts,
    totalPages,
    currentPage: page
  });
});

module.exports = {
  createDiscount,
  getDiscount,
  getAllDiscounts,
  updateDiscount,
  verifyDiscount,
  deleteDiscount,
  getdiscountForVendor
};
