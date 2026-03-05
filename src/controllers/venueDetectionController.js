const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/appError');
const VenueDetection = require('../models/VenueDetection');
const ServiceListing = require('../models/ServiceListing');
const User = require('../models/users/User');
const { generateTitleForListing, generateTitleSuggestions } = require('../utils/generateListingTitle');
const { scanContent } = require('../utils/contentFilter');
const { detectCompanyName } = require('../utils/mediaModeration');

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
  let { texts, serviceListingId } = req.body;
  if (!texts) return next(new AppError('Please provide texts to check', 400));

  // Normalise to array
  if (typeof texts === 'string') texts = [texts];
  if (!Array.isArray(texts)) return next(new AppError('texts must be a string or array of strings', 400));

  const settings = await getOrCreateSettings();
  const cf = settings.contentFiltering || {};
  const filterEnabled = cf.enabled !== false;

  // ── Look up vendor names from BOTH the requesting user AND the listing's vendor ──
  // When an admin creates/edits a listing on behalf of a vendor, req.user is the
  // admin (who has no companyName). We also look up the listing's actual vendorId
  // so the company-name check always runs against the correct vendor.
  const vendorNamesToBlock = [];
  const seenUserIds = new Set();

  // 1. Check the listing's actual vendorId (most reliable for moderation)
  if (serviceListingId) {
    try {
      const listing = await ServiceListing.findById(serviceListingId).select('vendorId').lean();
      if (listing?.vendorId) {
        const listingVendor = await User.findById(listing.vendorId)
          .select('companyName firstName lastName email').lean();
        console.log('[checkContent] listing vendor lookup', listing.vendorId,
          '=> companyName:', JSON.stringify(listingVendor?.companyName),
          'firstName:', JSON.stringify(listingVendor?.firstName),
          'lastName:', JSON.stringify(listingVendor?.lastName));
        if (listingVendor?.companyName) vendorNamesToBlock.push(listingVendor.companyName);
        const fullName = [listingVendor?.firstName, listingVendor?.lastName].filter(Boolean).join(' ');
        if (fullName.trim()) vendorNamesToBlock.push(fullName);
        seenUserIds.add(String(listing.vendorId));
      }
    } catch (e) {
      console.log('[checkContent] listing lookup failed:', e.message);
    }
  }

  // 2. Also check the requesting user (fallback / additional names)
  if (req.user && req.user._id && !seenUserIds.has(String(req.user._id))) {
    const vendor = await User.findById(req.user._id)
      .select('companyName firstName lastName email').lean();
    console.log('[checkContent] req.user lookup', req.user._id,
      '=> companyName:', JSON.stringify(vendor?.companyName),
      'firstName:', JSON.stringify(vendor?.firstName),
      'lastName:', JSON.stringify(vendor?.lastName),
      'email:', JSON.stringify(vendor?.email));
    if (vendor?.companyName) vendorNamesToBlock.push(vendor.companyName);
    const fullName = [vendor?.firstName, vendor?.lastName].filter(Boolean).join(' ');
    if (fullName.trim()) vendorNamesToBlock.push(fullName);
  } else if (!req.user || !req.user._id) {
    console.log('[checkContent] WARNING: no req.user or req.user._id — cannot look up vendor names');
  }

  // Deduplicate names
  const uniqueNames = [...new Set(vendorNamesToBlock)];
  console.log('[checkContent] namesToBlock =', JSON.stringify(uniqueNames));

  // When content filtering is enabled, ALL detection categories run.
  // Individual toggles are no longer used — the master toggle controls everything.
  const scanOptions = {
    checkPhoneNumbers:     true,
    checkEmails:           true,
    checkSocialHandles:    true,
    checkLinks:            true,
    checkIntentPhrases:    true,
    checkPaymentInfo:      true,
    checkLocationIdentity: true,
    checkProfanity:        true,
    checkBannedWords:      true,
    bannedWords:           cf.bannedWords || [],
  };

  const results = texts.map((t) => {
    // Run the general content scan only when the master toggle is on
    const scanResult = filterEnabled
      ? scanContent(String(t), scanOptions)
      : { clean: true, violations: [], allMatches: [], summary: '' };

    // Always check for vendor company name / full name (independent of master toggle)
    for (const vName of uniqueNames) {
      const cnReasons = detectCompanyName(String(t), vName);
      if (cnReasons.length > 0) {
        console.log('[checkContent] DETECTED vendor name in text:',
          JSON.stringify(String(t).substring(0, 80)), 'matched:', JSON.stringify(vName));
        scanResult.clean = false;
        scanResult.violations = scanResult.violations || [];
        scanResult.violations.push({ category: 'companyName', message: cnReasons[0] });
        scanResult.allMatches = scanResult.allMatches || [];
        scanResult.allMatches.push(...cnReasons);
        scanResult.summary = scanResult.summary
          ? scanResult.summary + '; ' + cnReasons[0]
          : cnReasons[0];
        break; // one match is enough
      }
    }
    return scanResult;
  });
  const allClean = results.every((r) => r.clean);

  res.status(200).json({
    status: 'success',
    data: {
      clean: allClean,
      results,
    },
  });
});
