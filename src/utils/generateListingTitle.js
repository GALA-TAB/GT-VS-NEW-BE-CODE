const VenueDetection = require('../models/VenueDetection');

/* ─────────────────────────────────────────────────────────
 * Stop-words to exclude from description feature extraction
 * ───────────────────────────────────────────────────────── */
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

/**
 * Extract key descriptive words from a text string.
 */
function extractKeyFeatures(text, maxFeatures = 5) {
  if (!text) return [];
  const words = text
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFeatures)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
}

/**
 * Build a title from the template format by substituting variables.
 * Template: "[Adjective] + [Listing Type] + in/near + [Neighborhood] + [Key Feature]"
 */
function buildFromTemplate(templateStr, vars) {
  let title = templateStr;

  title = title.replace(/\[Adjective\]/gi, vars.adjective || '');
  title = title.replace(/\[Listing Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Venue Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Neighborhood\]/gi, vars.neighborhood || '');
  title = title.replace(/\[City\]/gi, vars.city || '');
  title = title.replace(/\[Key Feature\]/gi, vars.keyFeature || '');

  // Handle "in/near"
  if (vars.neighborhood && vars.city) {
    title = title.replace(/in\/near/gi, 'in');
  } else if (vars.neighborhood) {
    title = title.replace(/in\/near/gi, 'near');
  } else if (vars.city) {
    title = title.replace(/in\/near/gi, 'in');
  } else {
    title = title.replace(/in\/near\s*/gi, '');
  }

  // Clean up separators and whitespace
  title = title.replace(/\s*\+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  title = title.replace(/\s+(in|near|with)\s*$/i, '').trim();

  return title;
}

/**
 * Generate a title for a service listing using Listing Detection settings.
 *
 * @param {Object} listing — A populated ServiceListing document
 *   Expects: listing.serviceTypeId?.name, listing.location, listing.description,
 *            listing.venuesAmenities[].name
 * @param {Object} [detectionSettings] — Optional pre-fetched VenueDetection doc
 * @returns {Promise<string|null>} The generated title, or null if disabled
 */
async function generateTitleForListing(listing, detectionSettings) {
  const settings = detectionSettings || await VenueDetection.findOne();
  if (!settings || !settings.titleGeneration?.enabled) return null;

  const styleDescriptors = settings.titleGeneration.styleDescriptors || [];
  if (styleDescriptors.length === 0) return null;

  const templateFormat = settings.titleGeneration.titleFormat
    || '[Adjective] + [Listing Type] + in/near + [Neighborhood] + [Key Feature]';

  // Extract listing info (NOT the address or original title)
  const listingType = listing.serviceTypeId?.name || 'Space';
  const city         = listing.location?.city || '';
  const neighborhood = listing.location?.state || '';
  const amenityNames = (listing.venuesAmenities || []).map((a) =>
    typeof a === 'object' && a.name ? a.name : ''
  ).filter(Boolean);

  const descriptionFeatures = extractKeyFeatures(listing.description || '');
  const featurePool = [...amenityNames, ...descriptionFeatures].filter(Boolean);

  // Pick a random descriptor and feature
  const adjective = styleDescriptors[Math.floor(Math.random() * styleDescriptors.length)];
  const keyFeature = featurePool.length > 0
    ? featurePool[Math.floor(Math.random() * featurePool.length)]
    : '';

  const title = buildFromTemplate(templateFormat, {
    adjective,
    listingType,
    neighborhood,
    city,
    keyFeature,
  });

  return title || null;
}

/**
 * Generate multiple title suggestions (for the admin preview endpoint).
 */
async function generateTitleSuggestions(listing, detectionSettings) {
  const settings = detectionSettings || await VenueDetection.findOne();
  if (!settings || !settings.titleGeneration?.enabled) return [];

  const styleDescriptors = settings.titleGeneration.styleDescriptors || [];
  if (styleDescriptors.length === 0) return [];

  const templateFormat = settings.titleGeneration.titleFormat
    || '[Adjective] + [Listing Type] + in/near + [Neighborhood] + [Key Feature]';

  const listingType = listing.serviceTypeId?.name || 'Space';
  const city         = listing.location?.city || '';
  const neighborhood = listing.location?.state || '';
  const amenityNames = (listing.venuesAmenities || []).map((a) =>
    typeof a === 'object' && a.name ? a.name : ''
  ).filter(Boolean);

  const descriptionFeatures = extractKeyFeatures(listing.description || '');
  const featurePool = [...amenityNames, ...descriptionFeatures].filter(Boolean);

  const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
  const shuffledDescriptors = shuffle(styleDescriptors);
  const shuffledFeatures = shuffle(featurePool);

  const titles = [];
  const usedSet = new Set();

  for (let i = 0; i < Math.min(4, Math.max(1, shuffledDescriptors.length)); i++) {
    const adjective = shuffledDescriptors[i] || shuffledDescriptors[0] || '';
    const keyFeature = shuffledFeatures[i] || shuffledFeatures[0] || '';

    const title = buildFromTemplate(templateFormat, {
      adjective, listingType, neighborhood, city, keyFeature,
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
      listingType, neighborhood, city, keyFeature: '',
    });
    if (basic && !usedSet.has(basic)) {
      usedSet.add(basic);
      titles.push(basic);
    }
  }

  return {
    suggestions: titles,
    metadata: {
      listingType, neighborhood, city,
      featuresExtracted: featurePool.slice(0, 8),
      templateUsed: templateFormat,
      descriptorCount: styleDescriptors.length,
    },
  };
}

module.exports = {
  generateTitleForListing,
  generateTitleSuggestions,
  extractKeyFeatures,
  buildFromTemplate,
};
