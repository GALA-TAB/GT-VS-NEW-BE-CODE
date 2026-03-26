const catchAsync = require('../utils/catchAsync');
const BusinessCertificate = require('../models/BusinessCertificate');
const AppError = require('../utils/appError');
const Vendor = require('../models/users/Vendor');
const User = require('../models/users/User');
const sendNotification = require('../utils/storeNotification');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const { checkAndAutoVerifyVendor } = require('./KYCController');

const createBusinessCertificate = catchAsync(async (req, res, next) => {
  const { documentUrl, businessName } = req.body;
  const vendor = req.user;

  if (!documentUrl) {
    return next(new AppError('Document URL is required', 400, { documentUrl: 'Document is required' }));
  }

  // Check if vendor already has a business certificate - archive old one
  const existing = await BusinessCertificate.findOne({ vendorId: vendor._id });

  if (existing) {
    // Archive the old document
    existing.archivedDocuments.push({
      documentUrl: existing.documentUrl,
      status: existing.status,
      archivedAt: new Date()
    });
    existing.documentUrl = documentUrl;
    existing.businessName = businessName || existing.businessName;
    existing.status = 'pending';
    await existing.save();

    // Notify admin about resubmitted business certificate
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
      await sendNotification({
        userId: admin._id,
        title: 'Business Certificate Resubmitted',
        message: `${vendor.firstName} ${vendor.lastName} has resubmitted their business certificate for review.`,
        type: 'alert',
        fortype: 'new_venue',
        permission: 'vendorManagement',
        linkUrl: `/admin-dashboard/Verified-Documents-Details?vendorId=${vendor._id}`
      });
    }

    res.locals.dataId = existing._id;
    return res.status(200).json({
      status: 'success',
      data: existing,
      message: 'Business Certificate resubmitted successfully. Previous document has been archived.'
    });
  }

  const businessCertificate = await BusinessCertificate.create({
    vendorId: vendor._id,
    documentUrl,
    businessName,
    status: 'pending'
  });

  // Notify admin about new business certificate submission
  const admin = await User.findOne({ role: 'admin' });
  if (admin) {
    await sendNotification({
      userId: admin._id,
      title: 'New Business Certificate Submitted',
      message: `${vendor.firstName} ${vendor.lastName} has submitted a business certificate for review.`,
      type: 'alert',
      fortype: 'new_venue',
      permission: 'vendorManagement',
      linkUrl: `/admin-dashboard/Verified-Documents-Details?vendorId=${vendor._id}`
    });
  }

  res.locals.dataId = businessCertificate._id;
  res.status(200).json({
    status: 'success',
    data: businessCertificate,
    message: 'Business Certificate submitted successfully'
  });
});

const getBusinessCertificate = catchAsync(async (req, res, next) => {
  const businessCertificate = await BusinessCertificate.findById(req.params.id).populate('vendorId');
  if (!businessCertificate) {
    return next(new AppError('No business certificate found with that ID', 404));
  }
  res.status(200).json({
    status: 'success',
    data: businessCertificate
  });
});

const getAllBusinessCertificates = catchAsync(async (req, res, next) => {
  const page = req.query.page * 1 || 1;
  const limit = req.query.limit * 1 || 10;
  const skip = (page - 1) * limit;
  const { search } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);

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
      { 'vendorId.email': { $regex: search, $options: 'i' } },
      {
        $expr: {
          $regexMatch: {
            input: { $concat: ['$vendorId.firstName', ' ', '$vendorId.lastName'] },
            regex: search,
            options: 'i'
          }
        }
      }
    ];
  }

  matchStage = withSoftDeleteFilter(matchStage, isDeleted);

  const result = await BusinessCertificate.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendorId'
      }
    },
    { $unwind: { path: '$vendorId', preserveNullAndEmptyArrays: true } },
    { $match: matchStage },
    {
      $facet: {
        data: [
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit }
        ],
        totalCount: [{ $count: 'count' }]
      }
    }
  ]);

  const businessCertificates = result[0].data;
  const totalBusinessCertificates = result[0].totalCount[0]?.count || 0;
  const totalPages = Math.ceil(totalBusinessCertificates / limit);

  res.status(200).json({
    status: 'success',
    data: businessCertificates,
    totalBusinessCertificates,
    totalPages,
    currentPage: page
  });
});

const updateBusinessCertificate = catchAsync(async (req, res, next) => {
  const businessCertificate = await BusinessCertificate.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });
  if (!businessCertificate) {
    return next(new AppError('No business certificate found with that ID', 404));
  }
  res.locals.dataId = businessCertificate._id;
  res.status(200).json({
    status: 'success',
    data: businessCertificate
  });
});

const verifyBusinessCertificate = catchAsync(async (req, res, next) => {
  const { status, rejectionNote } = req.body;
  if (!status) {
    return next(new AppError('Status is required', 400, { status: 'status is required' }));
  }

  const updateData = { status };
  if (status === 'rejected' && rejectionNote) {
    updateData.rejectionNote = rejectionNote;
  }
  if (status === 'approved') {
    updateData.approvedBy = req.user._id;
    updateData.approvedAt = new Date();
  }

  const businessCertificate = await BusinessCertificate.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true, runValidators: true }
  );

  if (!businessCertificate) {
    return next(new AppError('No business certificate found with that ID', 404));
  }

  // Update vendor's businessCertificateStatus
  const vendorId = businessCertificate.vendorId?._id || businessCertificate.vendorId;
  await Vendor.findByIdAndUpdate(
    vendorId,
    { businessCertificateStatus: status },
    { new: true }
  );

  res.locals.dataId = businessCertificate._id;

  // Auto-verify vendor if all docs approved
  await checkAndAutoVerifyVendor(vendorId);

  // Send notification + email to vendor
  const notifTitle = status === 'approved' ? 'Business Certificate Approved' : 'Business Certificate Rejected';
  const notifMessage = status === 'approved'
    ? 'Your Business Certificate has been approved by Gala Tab.'
    : `Your Business Certificate has been rejected by Gala Tab. Reason: ${businessCertificate.rejectionNote || 'No reason provided'}`;
  await sendNotification({
    userId: vendorId,
    title: notifTitle,
    message: notifMessage,
    type: 'alert',
  });

  res.status(200).json({
    status: 'success',
    data: businessCertificate,
    message: `Business certificate ${status} successfully`
  });
});

const deleteBusinessCertificate = catchAsync(async (req, res, next) => {
  const businessCertificate = await BusinessCertificate.findByIdAndUpdate(
    req.params.id,
    { isDeleted: true },
    { new: true }
  );
  if (!businessCertificate) {
    return next(new AppError('No business certificate found with that ID', 404));
  }
  res.locals.dataId = businessCertificate._id;
  res.status(200).json({
    status: 'success',
    message: 'Business certificate deleted successfully'
  });
});

module.exports = {
  createBusinessCertificate,
  getBusinessCertificate,
  getAllBusinessCertificates,
  updateBusinessCertificate,
  verifyBusinessCertificate,
  deleteBusinessCertificate
};
