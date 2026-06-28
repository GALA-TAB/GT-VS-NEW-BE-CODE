const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const ServiceListing = require('../models/ServiceListing');
const mongoose = require('mongoose');

// Tier definitions — score controls sort order on the landing page
const TIER_CONFIG = {
  featured: { score: 1000, label: 'Featured',   defaultFee: 20 },
  top10:    { score: 100,  label: 'Top 10',      defaultFee: 15 },
  top50:    { score: 50,   label: 'Top 50',       defaultFee: 10 },
  standard: { score: 10,  label: 'Standard Boost', defaultFee: 5 },
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
    matchStage['boost.isActive'] = true;
    matchStage.$or = matchStage.$or
      ? matchStage.$or
      : undefined;
    // Active boost: isActive=true AND (no expiry OR expiry in future)
    matchStage.$and = [
      { 'boost.isActive': true },
      { $or: [{ 'boost.expiresAt': null }, { 'boost.expiresAt': { $gt: now } }] },
    ];
    delete matchStage['boost.isActive'];
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
        'media': { $slice: ['$media', 1] },
        boost: 1,
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

// ─── GET /api/boost/tiers ─────────────────────────────────────────────────────
// Returns the available boost tiers and their config
const getBoostTiers = catchAsync(async (req, res) => {
  return res.status(200).json({
    status: 'success',
    data: TIER_CONFIG,
  });
});

// ─── GET /api/boost/stats ─────────────────────────────────────────────────────
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

module.exports = {
  getBoostableListings,
  setListingBoost,
  removeListingBoost,
  getBoostTiers,
  getBoostStats,
};
