const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/appError');
const VenueDetection = require('../models/VenueDetection');
const ServiceListing = require('../models/ServiceListing');
const { generateTitleForListing, generateTitleSuggestions } = require('../utils/generateListingTitle');
const { scanContent } = require('../utils/contentFilter');

/* ───────────────────────────────────────────────────────
 * Helper — ensure exactly one settings doc exists
 * ─────────────────────────────────────────────────────── */
const getOrCreateSettings = async () => {
  let settings = await VenueDetection.findOne();
  if (!settings) {
    settings = await VenueDetection.create({});
  }
  return settings;
};

/* ───────────────────────────────────────────────────────
 * GET  /api/listing-detection
 * Return current detection settings (admin only)
 * ─────────────────────────────────────────────────────── */
exports.getSettings = catchAsync(async (req, res) => {
  const settings = await getOrCreateSettings();
  res.status(200).json({ status: 'success', data: settings });
});

/* ───────────────────────────────────────────────────────
 * PATCH  /api/listing-detection
 * Update detection settings (admin only)
 * Accepts partial or full nested objects
 * ─────────────────────────────────────────────────────── */
exports.updateSettings = catchAsync(async (req, res) => {
  const allowed = [
    'locationMasking',
    'titleGeneration',
    'messageFiltering',
    'contentFiltering',
    'preBookingVisibility',
    'postBookingReveal',
  ];

  const update = {};
  for (const section of allowed) {
    if (req.body[section] && typeof req.body[section] === 'object') {
      // Flatten nested keys so Mongo merges instead of replaces
      for (const [key, value] of Object.entries(req.body[section])) {
        update[`${section}.${key}`] = value;
      }
    }
  }

  update.updatedBy = req.user._id;

  const settings = await VenueDetection.findOneAndUpdate(
    {},
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );

  res.status(200).json({ status: 'success', data: settings });
});

/* ───────────────────────────────────────────────────────
 * POST  /api/listing-detection/generate-title
 * AI / Template title generator for a listing
 * Body: { serviceListingId }
 * Also saves the first suggestion as generatedTitle on the listing.
 * ─────────────────────────────────────────────────────── */
exports.generateTitle = catchAsync(async (req, res, next) => {
  const settings = await getOrCreateSettings();

  if (!settings.titleGeneration.enabled) {
    return next(new AppError('Title generation is currently disabled', 400));
  }

  if (!req.body.serviceListingId) {
    return next(new AppError('Please provide a serviceListingId', 400));
  }

  const listing = await ServiceListing.findById(req.body.serviceListingId)
    .populate('serviceTypeId', 'name');

  if (!listing) return next(new AppError('Listing not found', 404));

  const result = await generateTitleSuggestions(listing, settings);

  // Save the first suggestion as the generatedTitle on the listing
  if (result.suggestions && result.suggestions.length > 0) {
    await ServiceListing.findByIdAndUpdate(listing._id, {
      generatedTitle: result.suggestions[0],
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      suggestions: result.suggestions || [],
      selectedTitle: result.suggestions?.[0] || '',
      metadata: result.metadata || {},
      sourceInfo: {
        originalTitle: listing.title || '',
        hasDescription: !!(listing.description),
      },
    },
  });
});

/* ───────────────────────────────────────────────────────
 * GET  /api/listing-detection/masked-location/:listingId
 * Return masked location data for pre-booking display
 * (Any authenticated user can request this)
 * ─────────────────────────────────────────────────────── */
exports.getMaskedLocation = catchAsync(async (req, res, next) => {
  const listing = await ServiceListing.findById(req.params.listingId);
  if (!listing) return next(new AppError('Listing not found', 404));

  const settings = await getOrCreateSettings();
  const mask = settings.locationMasking;
  const vis  = settings.preBookingVisibility;

  const masked = {};

  // Always show city/neighborhood if enabled
  if (mask.enabled && mask.showCityNeighborhood) {
    if (listing.location?.city)  masked.city  = listing.location.city;
    if (listing.location?.state) masked.neighborhood = listing.location.state;
  }

  // Approximate map center (offset coordinates slightly for privacy)
  if (mask.enabled && mask.showApproximateMap && listing.location?.coordinates) {
    const [lng, lat] = listing.location.coordinates;
    // Add small random offset (within the configured radius)
    const radiusMiles = mask.mapCircleRadiusMiles || 1;
    // Enforce minimum 0.5 mile offset so circle never centres on actual address
    const minOffsetMiles = 0.5;
    // Random offset distance between minOffsetMiles and radiusMiles
    const offsetDist = minOffsetMiles + Math.random() * (Math.max(radiusMiles, minOffsetMiles) - minOffsetMiles);
    // Random angle 0-2π
    const angle = Math.random() * 2 * Math.PI;
    // 1 degree latitude ≈ 69 miles, 1 degree longitude ≈ 53 miles (mid-latitudes)
    const latOffset = (offsetDist * Math.sin(angle)) / 69;
    const lngOffset = (offsetDist * Math.cos(angle)) / 53;
    masked.approximateCoordinates = [
      parseFloat((lng + lngOffset).toFixed(4)),
      parseFloat((lat + latOffset).toFixed(4)),
    ];
    masked.mapCircleRadiusMiles = radiusMiles;
  }

  // Visibility controls
  masked.showPhotos             = vis.showPhotos;
  masked.showVenueAmenities     = vis.showVenueAmenities;
  masked.showMaxCapacity        = vis.showMaxCapacity;
  masked.showEventCalendar      = vis.showEventCalendar;
  masked.showDistanceToLandmarks= vis.showDistanceToLandmarks;

  // Explicitly HIDE sensitive fields when masking is on
  if (mask.enabled) {
    masked.exactAddressHidden  = mask.hideStreetAddress;
    masked.buildingNameHidden  = mask.hideBuildingName;
    masked.unitNumberHidden    = mask.hideUnitNumber;
    masked.postalCodeHidden    = mask.hidePostalCode;
  }

  res.status(200).json({ status: 'success', data: masked });
});

/* ───────────────────────────────────────────────────────
 * GET  /api/listing-detection/stats
 * Quick overview: counts of listings, masked vs revealed
 * ─────────────────────────────────────────────────────── */
exports.getStats = catchAsync(async (req, res) => {
  const settings = await getOrCreateSettings();

  const totalListings = await ServiceListing.countDocuments({ isDeleted: false });
  const completedListings = await ServiceListing.countDocuments({ isDeleted: false, completed: true });
  const listingsWithLocation = await ServiceListing.countDocuments({
    isDeleted: false,
    'location.address': { $exists: true, $ne: '' },
  });
  const listingsWithGeneratedTitle = await ServiceListing.countDocuments({
    isDeleted: false,
    generatedTitle: { $exists: true, $ne: '' },
  });

  res.status(200).json({
    status: 'success',
    data: {
      totalListings,
      completedListings,
      listingsWithLocation,
      listingsWithGeneratedTitle,
      locationMaskingEnabled: settings.locationMasking.enabled,
      titleGenerationEnabled: settings.titleGeneration.enabled,
      messageFilteringEnabled: settings.messageFiltering.enabled,
    },
  });
});

/* ───────────────────────────────────────────────────────
 * POST  /api/listing-detection/generate-all-titles
 * Bulk-generate titles for all completed listings that
 * have a city/location. Updates generatedTitle on each.
 * Admin only.
 * ─────────────────────────────────────────────────────── */
exports.generateAllTitles = catchAsync(async (req, res, next) => {
  const settings = await getOrCreateSettings();

  if (!settings.titleGeneration.enabled) {
    return next(new AppError('Title generation is currently disabled', 400));
  }

  const listings = await ServiceListing.find({
    isDeleted: false,
    completed: true,
    $or: [
      { 'location.neighborhood': { $exists: true, $ne: '' } },
      { 'location.city': { $exists: true, $ne: '' } },
    ],
  })
    .populate('serviceTypeId', 'name');

  let updated = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      const title = await generateTitleForListing(listing, settings);
      if (title) {
        await ServiceListing.findByIdAndUpdate(listing._id, { generatedTitle: title });
        updated++;
      }
    } catch (e) {
      failed++;
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      totalProcessed: listings.length,
      updated,
      failed,
    },
  });
});

/* ───────────────────────────────────────────────────────
 * POST  /api/listing-detection/check-content
 * Scan user-submitted text against all detection rules.
 *
 * Body: { texts: string | string[] }
 *   — single string or array of strings to check
 *
 * Returns per-text violation results.
 * Any authenticated user can call this (frontend calls it
 * before allowing "Next" / "Save").
 * ─────────────────────────────────────────────────────── */
exports.checkContent = catchAsync(async (req, res, next) => {
  let { texts } = req.body;
  if (!texts) return next(new AppError('Please provide texts to check', 400));

  // Normalise to array
  if (typeof texts === 'string') texts = [texts];
  if (!Array.isArray(texts)) return next(new AppError('texts must be a string or array of strings', 400));

  const settings = await getOrCreateSettings();
  const cf = settings.contentFiltering || {};

  // If content filtering is globally disabled, everything passes
  if (cf.enabled === false) {
    return res.status(200).json({
      status: 'success',
      data: {
        clean: true,
        results: texts.map(() => ({ clean: true, violations: [], allMatches: [], summary: '' })),
      },
    });
  }

  const scanOptions = {
    checkPhoneNumbers:    cf.blockPhoneNumbers !== false,
    checkEmails:          cf.blockEmails !== false,
    checkSocialHandles:   cf.blockSocialHandles !== false,
    checkLinks:           cf.blockLinks !== false,
    checkIntentPhrases:   cf.blockIntentPhrases !== false,
    checkPaymentInfo:     cf.blockPaymentInfo !== false,
    checkLocationIdentity: cf.blockLocationIdentity !== false,    checkProfanity:        cf.blockProfanity !== false,    checkBannedWords:     cf.blockBannedWords !== false,
    bannedWords:          cf.bannedWords || [],
  };

  const results = texts.map((t) => scanContent(String(t), scanOptions));
  const allClean = results.every((r) => r.clean);

  res.status(200).json({
    status: 'success',
    data: {
      clean: allClean,
      results,
    },
  });
});
