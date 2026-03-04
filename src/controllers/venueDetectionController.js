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
 * Body: { serviceListingId }
 * Generates titles from listing title + description + template
 * WITHOUT exposing address or original service title.
 * ─────────────────────────────────────────────────────── */

/**
 * Extract key features / descriptive words from a text string.
 * Filters out common stop-words, addresses, and short tokens.
 */
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','shall',
  'should','may','might','must','can','could','this','that','these',
  'those','i','me','my','we','our','you','your','he','she','it','they',
  'them','his','her','its','our','their','what','which','who','whom',
  'where','when','how','not','no','nor','so','if','then','than','too',
  'very','just','about','above','after','before','between','into','through',
  'during','for','with','at','by','from','up','down','in','out','on','off',
  'over','under','of','to','as','also','each','every','all','both','few',
  'more','most','other','some','such','only','own','same','here','there',
]);

function extractKeyFeatures(text, maxFeatures = 5) {
  if (!text) return [];
  // Remove punctuation, split into words, filter
  const words = text
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  // Frequency count — pick most common descriptive words
  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFeatures)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
}

/**
 * Build a title from the template format by substituting variables.
 * Template example: "[Adjective] + [Listing Type] + in/near + [Neighborhood] + [Key Feature]"
 */
function buildFromTemplate(templateStr, vars) {
  let title = templateStr;
  // Replace each [Variable] token
  title = title.replace(/\[Adjective\]/gi, vars.adjective || '');
  title = title.replace(/\[Listing Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Venue Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Neighborhood\]/gi, vars.neighborhood || '');
  title = title.replace(/\[City\]/gi, vars.city || '');
  title = title.replace(/\[Key Feature\]/gi, vars.keyFeature || '');

  // Handle "in/near" — use "in" when we have city, "near" for neighborhood-only
  if (vars.neighborhood && vars.city) {
    title = title.replace(/in\/near/gi, 'in');
  } else if (vars.neighborhood) {
    title = title.replace(/in\/near/gi, 'near');
  } else if (vars.city) {
    title = title.replace(/in\/near/gi, 'in');
  } else {
    title = title.replace(/in\/near\s*/gi, '');
  }

  // Clean up "+" separators and extra whitespace
  title = title.replace(/\s*\+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Remove trailing prepositions left by missing variables
  title = title.replace(/\s+(in|near|with)\s*$/i, '').trim();

  return title;
}

exports.generateTitle = catchAsync(async (req, res, next) => {
  const settings = await getOrCreateSettings();

  if (!settings.titleGeneration.enabled) {
    return next(new AppError('Title generation is currently disabled', 400));
  }

  if (!req.body.serviceListingId) {
    return next(new AppError('Please provide a serviceListingId', 400));
  }

  const listing = await ServiceListing.findById(req.body.serviceListingId)
    .populate('serviceTypeId', 'name')
    .populate('venuesAmenities', 'name');

  if (!listing) return next(new AppError('Listing not found', 404));

  const styleDescriptors = settings.titleGeneration.styleDescriptors || [];
  const templateFormat = settings.titleGeneration.titleFormat
    || '[Adjective] + [Listing Type] + in/near + [Neighborhood] + [Key Feature]';

  // ── Extract info from listing (NOT the address or original title) ──
  const listingType = listing.serviceTypeId?.name || 'Space';
  const city         = listing.location?.city || '';
  const neighborhood = listing.location?.state || '';
  const amenityNames = (listing.venuesAmenities || []).map((a) => a.name);

  // Extract key features from the listing description
  const descriptionFeatures = extractKeyFeatures(listing.description || '');

  // Merge amenities + description features for key feature pool
  const featurePool = [
    ...amenityNames,
    ...descriptionFeatures,
  ].filter(Boolean);

  // ── Generate multiple title suggestions ──
  const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
  const shuffledDescriptors = shuffle(styleDescriptors);
  const shuffledFeatures = shuffle(featurePool);

  const titles = [];
  const usedSet = new Set();

  // Generate titles using template, different descriptor + feature combos
  for (let i = 0; i < Math.min(4, Math.max(1, shuffledDescriptors.length)); i++) {
    const adjective = shuffledDescriptors[i] || shuffledDescriptors[0] || '';
    const keyFeature = shuffledFeatures[i] || shuffledFeatures[0] || '';

    const title = buildFromTemplate(templateFormat, {
      adjective,
      listingType,
      neighborhood,
      city,
      keyFeature,
    });

    if (title && !usedSet.has(title)) {
      usedSet.add(title);
      titles.push(title);
    }
  }

  // Add one variation without a key feature
  if (shuffledDescriptors.length > 0) {
    const basic = buildFromTemplate(templateFormat, {
      adjective: shuffledDescriptors[0],
      listingType,
      neighborhood,
      city,
      keyFeature: '',
    });
    if (basic && !usedSet.has(basic)) {
      usedSet.add(basic);
      titles.push(basic);
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      suggestions: titles,
      selectedTitle: titles[0] || '',
      metadata: {
        listingType,
        neighborhood,
        city,
        featuresExtracted: featurePool.slice(0, 8),
        templateUsed: templateFormat,
        descriptorCount: styleDescriptors.length,
      },
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
