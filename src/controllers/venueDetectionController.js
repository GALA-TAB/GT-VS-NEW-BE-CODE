const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/appError');
const VenueDetection = require('../models/VenueDetection');
const ServiceListing = require('../models/ServiceListing');

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
    'titleControl',
    'messageFiltering',
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
 * Body: { serviceListingId } or { listingType, neighborhood, city, amenities[] }
 * ─────────────────────────────────────────────────────── */
exports.generateTitle = catchAsync(async (req, res, next) => {
  const settings = await getOrCreateSettings();

  if (!settings.titleGeneration.enabled) {
    return next(new AppError('Title generation is currently disabled', 400));
  }

  let venueType, neighborhood, city, amenities, styleDescriptors;
  styleDescriptors = settings.titleGeneration.styleDescriptors;

  if (req.body.serviceListingId) {
    const listing = await ServiceListing.findById(req.body.serviceListingId)
      .populate('serviceTypeId', 'name')
      .populate('venuesAmenities', 'name');

    if (!listing) return next(new AppError('Listing not found', 404));

    venueType    = listing.serviceTypeId?.name || 'Listing';
    city         = listing.location?.city || '';
    neighborhood = listing.location?.state || '';
    amenities    = (listing.venuesAmenities || []).map((a) => a.name);
  } else {
    venueType    = req.body.venueType || 'Listing';
    city         = req.body.city || '';
    neighborhood = req.body.neighborhood || '';
    amenities    = req.body.amenities || [];
  }

  // Pick a random style descriptor
  const adjective =
    styleDescriptors[Math.floor(Math.random() * styleDescriptors.length)];

  // Pick a key feature from amenities if available
  const keyFeature =
    amenities.length > 0
      ? amenities[Math.floor(Math.random() * amenities.length)]
      : '';

  // Build title options
  const locationPart = neighborhood && city
    ? `in ${neighborhood}, ${city}`
    : city
    ? `in ${city}`
    : neighborhood
    ? `near ${neighborhood}`
    : '';

  const titles = [
    `${adjective} ${venueType} ${locationPart}`.trim(),
    keyFeature
      ? `${adjective} ${venueType} with ${keyFeature} ${locationPart}`.trim()
      : null,
    keyFeature
      ? `${venueType} ${locationPart} — ${keyFeature}`.trim()
      : null,
    `${venueType} ${locationPart}`.trim(),
  ].filter(Boolean);

  res.status(200).json({
    status: 'success',
    data: {
      suggestions: titles,
      selectedTitle: titles[0],
      metadata: { adjective, venueType, locationPart, keyFeature },
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

  res.status(200).json({
    status: 'success',
    data: {
      totalListings,
      completedListings,
      listingsWithLocation,
      locationMaskingEnabled: settings.locationMasking.enabled,
      titleGenerationEnabled: settings.titleGeneration.enabled,
      messageFilteringEnabled: settings.messageFiltering.enabled,
    },
  });
});
