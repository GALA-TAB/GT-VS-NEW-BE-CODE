const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const ServiceListing = require('../models/ServiceListing');
const mongoose = require('mongoose');

// Tier definitions — score controls sort order on the landing page
const TIER_CONFIG = {
  featured: { score: 1000, label: 'Featured',       defaultFee: 20 },
  top10:    { score: 100,  label: 'Top 10',          defaultFee: 15 },
  top50:    { score: 50,   label: 'Top 50',          defaultFee: 10 },
  standard: { score: 10,  label: 'Standard Boost',   defaultFee: 5 },
};

// ─── GET /api/boost/listings ──────────────────────────────────────────────────
// Returns all active+verified listings with their current boost status.
// Query params: serviceType (typevalue), status ('boosted'|'unboosted'|'all'),
//               search, page, limit
const getBoostableListings = catchAsync(async (req, res) => {
  const {
    serviceType,
    status = 'all',
    search = '',
    page = 1,
    limit = 20,
  } = req.query;

  const now = new Date();
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const matchStage = {
    VerificationStatus: 'verified',
    completed: true,
    isDeleted: { $ne: true },
  };

  if (search) {
    matchStage.$or = [
      { title: { $regex: search, $options: 'i' } },
      { generatedTitle: { $regex: search, $options: 'i' } },
    ];
  }

  if (status === 'boosted') {
    matchStage.$and = [
      { 'boost.isActive': true },
      { $or: [{ 'boost.expiresAt': null }, { 'boost.expiresAt': { $gt: now } }] },
    ];
  } else if (status === 'unboosted') {
    matchStage.$or = [
      { 'boost.isActive': { $ne: true } },
      { 'boost.expiresAt': { $lte: now } },
    ];
  }

  const pipeline = [
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData',
      },
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendorData',
      },
    },
    { $unwind: { path: '$vendorData', preserveNullAndEmptyArrays: true } },
    { $match: matchStage },
  ];

  if (serviceType) {
    pipeline.push({ $match: { 'serviceTypeData.typevalue': serviceType } });
  }

  pipeline.push(
    {
      $addFields: {
        isBoostActive: {
          $and: [
            { $eq: ['$boost.isActive', true] },
            {
              $or: [
                { $eq: ['$boost.expiresAt', null] },
                { $gt: ['$boost.expiresAt', now] },
              ],
            },
          ],
        },
      },
    },
    { $sort: { isBoostActive: -1, 'boost.score': -1, createdAt: -1 } },
  );

  const countPipeline = [...pipeline, { $count: 'total' }];
  const dataPipeline = [
    ...pipeline,
    { $skip: skip },
    { $limit: parseInt(limit, 10) },
    {
      $project: {
        _id: 1,
        title: 1,
        generatedTitle: 1,
        media: { $slice: ['$media', 1] },
        boost: 1,
        boostRequest: 1,
        isBoostActive: 1,
        'location.city': 1,
        'location.state': 1,
        'serviceTypeData._id': 1,
        'serviceTypeData.name': 1,
        'serviceTypeData.typevalue': 1,
        'vendorData._id': 1,
        'vendorData.firstName': 1,
        'vendorData.lastName': 1,
        'vendorData.email': 1,
        'vendorData.profilePicture': 1,
        createdAt: 1,
        status: 1,
      },
    },
  ];

  const [countResult, listings] = await Promise.all([
    ServiceListing.aggregate(countPipeline),
    ServiceListing.aggregate(dataPipeline),
  ]);

  const total = countResult[0]?.total || 0;

  return res.status(200).json({
    status: 'success',
    total,
    totalPages: Math.ceil(total / parseInt(limit, 10)),
    currentPage: parseInt(page, 10),
    tierConfig: TIER_CONFIG,
    data: listings,
  });
});

// ─── POST /api/boost/listings/:id ────────────────────────────────────────────
// Set or update the boost tier on a listing.
// Body: { tier, feePercent, durationDays, notes }
const setListingBoost = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { tier, feePercent, durationDays, notes } = req.body;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('Invalid listing ID', 400));
  }
  if (!tier || !TIER_CONFIG[tier]) {
    return next(
      new AppError(`Invalid tier. Must be one of: ${Object.keys(TIER_CONFIG).join(', ')}`, 400),
    );
  }

  const config = TIER_CONFIG[tier];
  const feeToUse =
    feePercent !== undefined && feePercent !== null
      ? Number(feePercent)
      : config.defaultFee;

  if (isNaN(feeToUse) || feeToUse < 0 || feeToUse > 100) {
    return next(new AppError('feePercent must be between 0 and 100', 400));
  }

  const startedAt = new Date();
  const expiresAt = durationDays
    ? new Date(startedAt.getTime() + Number(durationDays) * 24 * 60 * 60 * 1000)
    : null;

  const listing = await ServiceListing.findByIdAndUpdate(
    id,
    {
      $set: {
        boost: {
          isActive: true,
          tier,
          feePercent: feeToUse,
          score: config.score,
          startedAt,
          expiresAt,
          boostedBy: req.user._id,
          notes: notes || '',
        },
      },
    },
    { new: true, runValidators: false },
  );

  if (!listing) {
    return next(new AppError('Listing not found', 404));
  }

  return res.status(200).json({
    status: 'success',
    message: `Listing boosted to "${config.label}" tier`,
    data: { boost: listing.boost },
  });
});

// ─── DELETE /api/boost/listings/:id ──────────────────────────────────────────
// Remove boost from a listing
const removeListingBoost = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('Invalid listing ID', 400));
  }

  const listing = await ServiceListing.findByIdAndUpdate(
    id,
    {
      $set: {
        'boost.isActive': false,
        'boost.tier': null,
        'boost.score': 0,
        'boost.feePercent': 0,
        'boost.expiresAt': null,
      },
    },
    { new: true, runValidators: false },
  );

  if (!listing) {
    return next(new AppError('Listing not found', 404));
  }

  return res.status(200).json({
    status: 'success',
    message: 'Boost removed from listing',
  });
});

// ─── GET /api/boost/tiers ────────────────────────────────────────────────────
// Returns the available boost tiers and their config
const getBoostTiers = catchAsync(async (req, res) => {
  return res.status(200).json({
    status: 'success',
    data: TIER_CONFIG,
  });
});

// ─── GET /api/boost/stats ────────────────────────────────────────────────────
// Summary: count of boosted listings by tier
const getBoostStats = catchAsync(async (req, res) => {
  const now = new Date();

  const stats = await ServiceListing.aggregate([
    {
      $match: {
        'boost.isActive': true,
        $or: [{ 'boost.expiresAt': null }, { 'boost.expiresAt': { $gt: now } }],
        VerificationStatus: 'verified',
        completed: true,
        isDeleted: { $ne: true },
      },
    },
    {
      $group: {
        _id: '$boost.tier',
        count: { $sum: 1 },
        avgFeePercent: { $avg: '$boost.feePercent' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return res.status(200).json({
    status: 'success',
    data: stats,
  });
});

// ─── POST /api/boost/listings/:id/request ────────────────────────────────────
// Vendor submits a boost request for their own listing
const requestListingBoost = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { tier } = req.body;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('Invalid listing ID', 400));
  }
  if (!tier || !TIER_CONFIG[tier]) {
    return next(
      new AppError(`Invalid tier. Must be one of: ${Object.keys(TIER_CONFIG).join(', ')}`, 400),
    );
  }

  // Verify vendor owns this listing
  const listing = await ServiceListing.findOne({
    _id: id,
    vendorId: req.user._id,
    isDeleted: { $ne: true },
  });

  if (!listing) {
    return next(new AppError('Listing not found or not owned by you', 404));
  }

  if (listing.boostRequest?.status === 'pending') {
    return next(new AppError('A boost request is already pending for this listing', 400));
  }

  if (listing.boost?.isActive) {
    return next(
      new AppError('This listing already has an active boost. Contact admin to change it.', 400),
    );
  }

  await ServiceListing.findByIdAndUpdate(id, {
    $set: {
      boostRequest: {
        status: 'pending',
        requestedTier: tier,
        requestedAt: new Date(),
        rejectedReason: '',
      },
    },
  });

  return res.status(200).json({
    status: 'success',
    message: 'Boost request submitted. Admin will review and activate it shortly.',
  });
});

// ─── GET /api/boost/requests ──────────────────────────────────────────────────
// Admin: get all pending boost requests
const getPendingBoostRequests = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const pipeline = [
    { $match: { 'boostRequest.status': 'pending', isDeleted: { $ne: true } } },
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendorData',
      },
    },
    { $unwind: { path: '$vendorData', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData',
      },
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $sort: { 'boostRequest.requestedAt': 1 } },
  ];

  const [countResult, requests] = await Promise.all([
    ServiceListing.aggregate([...pipeline, { $count: 'total' }]),
    ServiceListing.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
      {
        $project: {
          _id: 1,
          title: 1,
          generatedTitle: 1,
          media: { $slice: ['$media', 1] },
          boostRequest: 1,
          boost: 1,
          'location.city': 1,
          'location.state': 1,
          'serviceTypeData.name': 1,
          'serviceTypeData.typevalue': 1,
          'vendorData._id': 1,
          'vendorData.firstName': 1,
          'vendorData.lastName': 1,
          'vendorData.email': 1,
          'vendorData.profilePicture': 1,
          createdAt: 1,
        },
      },
    ]),
  ]);

  return res.status(200).json({
    status: 'success',
    total: countResult[0]?.total || 0,
    totalPages: Math.ceil((countResult[0]?.total || 0) / parseInt(limit, 10)),
    currentPage: parseInt(page, 10),
    tierConfig: TIER_CONFIG,
    data: requests,
  });
});

// ─── POST /api/boost/requests/:id/approve ────────────────────────────────────
// Admin approves a vendor boost request (can override tier and set fee/duration)
const approveBoostRequest = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { tier, feePercent, durationDays, notes } = req.body;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('Invalid listing ID', 400));
  }

  const listing = await ServiceListing.findById(id);
  if (!listing) return next(new AppError('Listing not found', 404));
  if (listing.boostRequest?.status !== 'pending') {
    return next(new AppError('No pending boost request found for this listing', 400));
  }

  const approvedTier = tier || listing.boostRequest.requestedTier;
  if (!TIER_CONFIG[approvedTier]) {
    return next(new AppError('Invalid tier', 400));
  }

  const config = TIER_CONFIG[approvedTier];
  const feeToUse =
    feePercent !== undefined && feePercent !== null ? Number(feePercent) : config.defaultFee;

  const startedAt = new Date();
  const expiresAt = durationDays
    ? new Date(startedAt.getTime() + Number(durationDays) * 24 * 60 * 60 * 1000)
    : null;

  await ServiceListing.findByIdAndUpdate(id, {
    $set: {
      boost: {
        isActive: true,
        tier: approvedTier,
        feePercent: feeToUse,
        score: config.score,
        startedAt,
        expiresAt,
        boostedBy: req.user._id,
        notes: notes || '',
      },
      'boostRequest.status': 'approved',
    },
  });

  return res.status(200).json({
    status: 'success',
    message: `Boost request approved. Listing moved to "${config.label}" tier.`,
  });
});

// ─── POST /api/boost/requests/:id/reject ─────────────────────────────────────
// Admin rejects a vendor boost request
const rejectBoostRequest = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('Invalid listing ID', 400));
  }

  const listing = await ServiceListing.findById(id);
  if (!listing) return next(new AppError('Listing not found', 404));
  if (listing.boostRequest?.status !== 'pending') {
    return next(new AppError('No pending boost request found', 400));
  }

  await ServiceListing.findByIdAndUpdate(id, {
    $set: {
      'boostRequest.status': 'rejected',
      'boostRequest.rejectedReason': reason || '',
    },
  });

  return res.status(200).json({
    status: 'success',
    message: 'Boost request rejected.',
  });
});

module.exports = {
  getBoostableListings,
  setListingBoost,
  removeListingBoost,
  getBoostTiers,
  getBoostStats,
  requestListingBoost,
  getPendingBoostRequests,
  approveBoostRequest,
  rejectBoostRequest,
};
