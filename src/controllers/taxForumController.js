const catchAsync = require('../utils/catchAsync');
const TaxForum = require('../models/TaxForum');
const AppError = require('../utils/appError');
const { taxForumValidation } = require('../utils/joi/taxforumValidation');
const joiError = require('../utils/joiError');
const User = require('../models/users/User');
const sendNotification = require('../utils/storeNotification');
const Vendor = require('../models/users/Vendor');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const { checkAndAutoVerifyVendor } = require('./KYCController');

const createTaxForum = catchAsync(async (req, res, next) => {
  const { businessName, taxClassification, taxId, deliveryForm, taxDocument } = req.body;
  const partialSchema = taxForumValidation.fork(
    ['businessName', 'taxClassification', 'taxId', 'deliveryForm'],
    (schema) => schema.required()
  );
  const vendor = req.user; // Assuming you have the user ID from the request object
  const { error } = partialSchema.validate(req.body, {
    abortEarly: false,
    allowUnknown: true
  });

  if (error) {
    const errorFields = joiError(error);

    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  const taxForumData = {
    vendorId: vendor._id,
    businessName,
    taxClassification,
    taxId,
    deliveryForm,
    taxDocument,
    status: 'pending'
  };

  const taxForum = await TaxForum.findOneAndUpdate({ vendorId: vendor._id }, taxForumData, {
    new: true,
    upsert: true,
    runValidators: true
  });
  res.locals.dataId = taxForum._id; // Store the ID of the created FAQ in res.locals
  res.status(200).json({
    status: 'success',
    data: taxForum,
    message: 'Tax Forum processed successfully'
  });
});

const getTaxForum = catchAsync(async (req, res, next) => {
  const taxForum = await TaxForum.findById(req.params.id).populate('vendorId');
  if (!taxForum) {
    return next(new AppError('No tax forum found with that ID', 404));
  }
  res.status(200).json({
    status: 'success',
    data: taxForum
  });
});

const getAllTaxForum = catchAsync(async (req, res, next) => {
  const page = req.query.page * 1 || 1;
  const limit = req.query.limit * 1 || 10;
  const skip = (page - 1) * limit;
  const { search } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);

  // Build $match for search
  let matchStage = {};

  // Date range filter
  const { startDate, endDate } = req.query;
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt.$lte = end;
    }
  }

  if (search) {
    matchStage.$or = [
      { businessName: { $regex: search, $options: 'i' } },
      { taxClassification: { $regex: search, $options: 'i' } },
      { taxId: { $regex: search, $options: 'i' } },
      { deliveryForm: { $regex: search, $options: 'i' } },
      { 
        $expr: {
          $regexMatch: {
            input: { $concat: ['$vendorId.firstName', ' ', '$vendorId.lastName'] },
            regex: search,
            options: 'i'
          }
        }
      },
      { 'vendorId.email': { $regex: search, $options: 'i' } }
    ];
  }
  matchStage = withSoftDeleteFilter(matchStage, isDeleted);

  const result = await TaxForum.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendorId'
      }
    },
    { $unwind: { path: '$vendorId', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'countries',
        localField: 'vendorId.country',
        foreignField: '_id',
        as: 'vendorId.country'
      }
    },
    {
      $lookup: {
        from: 'cities',
        localField: 'vendorId.city',
        foreignField: '_id',
        as: 'vendorId.city'
      }
    },
    { $match: matchStage },
    {
      $facet: {
        data: [
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ],
        totalCount: [{ $count: 'count' }]
      }
    }
  ]);

  const taxForums = result[0].data;
  const totalTaxForums = result[0].totalCount[0]?.count || 0;
  const totalPages = Math.ceil(totalTaxForums / limit);

  res.status(200).json({
    status: 'success',
    data: taxForums,
    totalTaxForums,
    totalPages,
    currentPage: page
  });
});

const updateTaxForum = catchAsync(async (req, res, next) => {
  const { error } = taxForumValidation.validate(req.body, {
    abortEarly: false,
    allowUnknown: true
  });

  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});

    return next(new AppError('Validation failed', 400, { errorFields }));
  }
  const taxForum = await TaxForum.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });
  if (!taxForum) {
    return next(new AppError('No tax forum found with that ID', 404));
  }
  res.locals.dataId = taxForum._id; // Store the ID of the created FAQ in res.locals
  res.status(200).json({
    status: 'success',
    data: taxForum
  });
});

const VerifyTaxForum = catchAsync(async (req, res, next) => {
  const { status, rejectionNote } = req.body;
  console.log('Requested Status:', status);
  if (!status) {
    return next(new AppError('Status is required', 400, { status: 'status is required' }));
  }
  let taxForum;
  if (status === false) {
    taxForum = await TaxForum.findByIdAndDelete(req.params.id);
  } else {
    const updateData = { status };
    if (status === 'rejected' && rejectionNote) {
      updateData.rejectionNote = rejectionNote;
    }
    if (status === 'approved') {
      updateData.approvedBy = req.user._id;
      updateData.approvedAt = new Date();
    }
    taxForum = await TaxForum.findByIdAndUpdate(
      req.params.id,
      updateData,
      {
        new: true,
        runValidators: true
      }
    );
  }
  if (!taxForum) {
    return next(new AppError('No tax forum found with that ID', 404));
  }

  res.locals.dataId = taxForum?._id;
  console.log('Tax Forum ID:', taxForum?._id, status, taxForum?.vendorId);
  const vendorId = taxForum?.vendorId?._id || taxForum?.vendorId;
  const vendor = await Vendor.findByIdAndUpdate(
    vendorId,
    { textForumStatus: status },
    { new: true }
  );

  // Auto-verify vendor if all docs approved
  if (status === 'approved') {
    await checkAndAutoVerifyVendor(vendorId);
  }

  console.log('Tax Forum Verification Status:', vendor?.textForumStatus);

  // Send notification + email to vendor
  const notifTitle = status === 'approved' ? 'EIN Confirmation Letter Approved' : 'EIN Confirmation Letter Rejected';
  const notifMessage = status === 'approved'
    ? 'Your EIN Confirmation Letter has been approved by Gala Tab.'
    : `Your EIN Confirmation Letter has been rejected by Gala Tab. Reason: ${taxForum.rejectionNote || 'No reason provided'}`;
  await sendNotification({
    userId: vendorId,
    title: notifTitle,
    message: notifMessage,
    type: 'alert',
  });

  res.status(200).json({
    status: 'success',
    data: taxForum
  });
});

const deleteTaxForum = catchAsync(async (req, res, next) => {
  const taxForum = await TaxForum.findByIdAndUpdate(
    req.params.id,
    { isDeleted: true },
    { new: true }
  );
  if (!taxForum) {
    return next(new AppError('No tax forum found with that ID', 404));
  }
  res.locals.dataId = taxForum._id; // Store the ID of the created FAQ in res.locals
  res.status(204).json({
    status: 'success',
    data: null
  });
});

module.exports = {
  createTaxForum,
  getTaxForum,
  getAllTaxForum,
  updateTaxForum,
  deleteTaxForum,
  VerifyTaxForum
};
