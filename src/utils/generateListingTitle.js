const VenueDetection = require('../models/VenueDetection');

/**
 * Build a title from the template format by substituting variables.
 * Default template: "[Adjective] + [Venue Type] + in/near + [Neighborhood]"
 *
 * Supported placeholders:
 *   [Adjective]     — randomly picked from admin-configured styleDescriptors
 *   [Listing Type] / [Venue Type] — the service category name
 *   [Neighborhood]  — extracted from Google Maps address components (0.5 mi radius)
 *   [City]          — listing city
 */
function buildFromTemplate(templateStr, vars) {
  let title = templateStr;

  title = title.replace(/\[Adjective\]/gi, vars.adjective || '');
  title = title.replace(/\[Listing Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Venue Type\]/gi, vars.listingType || '');
  title = title.replace(/\[Neighborhood\]/gi, vars.neighborhood || '');
  title = title.replace(/\[City\]/gi, vars.city || '');

  // Handle "in/near" — prefer neighborhood, fall back to city
  if (vars.neighborhood) {
    title = title.replace(/in\/near/gi, 'in');
  } else if (vars.city) {
    // No neighborhood available — swap placeholder to city context
    title = title.replace(/in\/near/gi, 'in');
  } else {
    title = title.replace(/in\/near\s*/gi, '');
  }

  // Clean up separators and whitespace
  title = title.replace(/\s*\+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  title = title.replace(/\s+(in|near)\s*$/i, '').trim();

  return title;
}

/**
 * Generate a title for a service listing using Listing Detection settings.
 *
 * The title is built from the admin-configured template using:
 *   - A random style descriptor as [Adjective]
 *   - The service type name as [Venue Type]
 *   - The Google-Maps-derived neighborhood (0.5 mi radius) as [Neighborhood]
 *
 * @param {Object} listing — A populated ServiceListing document
 *   Expects: listing.serviceTypeId?.name, listing.location (with neighborhood, city)
 * @param {Object} [detectionSettings] — Optional pre-fetched VenueDetection doc
 * @returns {Promise<string|null>} The generated title, or null if disabled
 */
async function generateTitleForListing(listing, detectionSettings) {
  const settings = detectionSettings || await VenueDetection.findOne();
  if (!settings || !settings.titleGeneration?.enabled) return null;

  const styleDescriptors = settings.titleGeneration.styleDescriptors || [];
  if (styleDescriptors.length === 0) return null;

  const templateFormat = settings.titleGeneration.titleFormat
    || '[Adjective] + [Venue Type] + in/near + [Neighborhood]';

  const listingType  = listing.serviceTypeId?.name || 'Space';
  const city         = listing.location?.city || '';
  // Use the neighborhood field (extracted from Google Maps address components).
  // Falls back to city if neighborhood is not available.
  const neighborhood = listing.location?.neighborhood || city || '';

  // Pick a random descriptor
  const adjective = styleDescriptors[Math.floor(Math.random() * styleDescriptors.length)];

  const title = buildFromTemplate(templateFormat, {
    adjective,
    listingType,
    neighborhood,
    city,
  });

  return title || null;
}

/**
 * Generate multiple title suggestions (for the admin preview endpoint).
 * Each suggestion uses a different style descriptor to show variety.
 */
async function generateTitleSuggestions(listing, detectionSettings) {
  const settings = detectionSettings || await VenueDetection.findOne();
  if (!settings || !settings.titleGeneration?.enabled) return [];

  const styleDescriptors = settings.titleGeneration.styleDescriptors || [];
  if (styleDescriptors.length === 0) return [];

  const templateFormat = settings.titleGeneration.titleFormat
    || '[Adjective] + [Venue Type] + in/near + [Neighborhood]';

  const listingType  = listing.serviceTypeId?.name || 'Space';
  const city         = listing.location?.city || '';
  const neighborhood = listing.location?.neighborhood || city || '';

  const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
  const shuffledDescriptors = shuffle(styleDescriptors);

  const titles = [];
  const usedSet = new Set();

  // Generate up to 5 unique title variations using different style descriptors
  for (let i = 0; i < Math.min(5, shuffledDescriptors.length); i++) {
    const adjective = shuffledDescriptors[i];

    const title = buildFromTemplate(templateFormat, {
      adjective, listingType, neighborhood, city,
    });

    if (title && !usedSet.has(title)) {
      usedSet.add(title);
      titles.push(title);
    }
  }

  return {
    suggestions: titles,
    metadata: {
      listingType, neighborhood, city,
      templateUsed: templateFormat,
      descriptorCount: styleDescriptors.length,
    },
  };
}

module.exports = {
  generateTitleForListing,
  generateTitleSuggestions,
  buildFromTemplate,
};
