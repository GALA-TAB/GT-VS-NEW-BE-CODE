const mongoose = require('mongoose');

/**
 * ListingDetection — singleton settings document
 * Controls AI-driven listing protection, location masking,
 * title generation, and message filtering across ALL service listings.
 */
const venueDetectionSchema = new mongoose.Schema(
  {
    /* ── Location Masking ───────────────────────────────────────── */
    locationMasking: {
      enabled:                { type: Boolean, default: true },
      showCityNeighborhood:   { type: Boolean, default: true },
      showApproximateMap:     { type: Boolean, default: true },
      mapCircleRadiusKm:     { type: Number,  default: 1, min: 0.1, max: 50 },
      showNearbyLandmarks:   { type: Boolean, default: true },
      revealAddressAfterBooking: { type: Boolean, default: true },
      hideStreetAddress:     { type: Boolean, default: true },
      hideBuildingName:      { type: Boolean, default: true },
      hideUnitNumber:        { type: Boolean, default: true },
      hidePostalCode:        { type: Boolean, default: false },
    },

    /* ── AI / Template Title Generation ─────────────────────────── */
    titleGeneration: {
      enabled:                   { type: Boolean, default: true },
      autoGenerateIfEmpty:       { type: Boolean, default: true },
      suggestToVenueOwners:      { type: Boolean, default: true },
      allowVenueOwnerCustomTitle:{ type: Boolean, default: true },
      removeAddressFromTitles:   { type: Boolean, default: true },
      titleFormat: {
        type: String,
        default: '[Adjective] + [Venue Type] + in/near + [Neighborhood] + [Key Feature]',
      },
      styleDescriptors: {
        type: [String],
        default: ['Modern', 'Cozy', 'Luxury', 'Elegant', 'Charming', 'Spacious', 'Intimate', 'Grand'],
      },
    },

    /* ── Venue Owner Titles vs System Titles ─────────────────────── */
    titleControl: {
      systemCanOverride:       { type: Boolean, default: false },
      systemCanReorder:        { type: Boolean, default: true },
      removeLocationSpecifics: { type: Boolean, default: true },
      appendNeighborhood:      { type: Boolean, default: true },
    },

    /* ── Message / Chat Filtering ──────────────────────────────── */
    messageFiltering: {
      enabled:                  { type: Boolean, default: true },
      blockPhoneNumbers:        { type: Boolean, default: true },
      blockEmails:              { type: Boolean, default: true },
      blockExactAddresses:      { type: Boolean, default: true },
      blockExternalLinks:       { type: Boolean, default: true },
      blockSocialMediaHandles:  { type: Boolean, default: true },
      autoWarnOnViolation:      { type: Boolean, default: true },
      maxViolationsBeforeRestriction: { type: Number, default: 3, min: 1, max: 50 },
    },

    /* ── Pre-Booking Visibility (what clients see BEFORE booking) ─ */
    preBookingVisibility: {
      showListingTitle:         { type: Boolean, default: true },
      showNeighborhoodCity:     { type: Boolean, default: true },
      showApproximateMap:       { type: Boolean, default: true },
      showDistanceToLandmarks:  { type: Boolean, default: true },
      showPhotos:               { type: Boolean, default: true },
      showVenueAmenities:       { type: Boolean, default: true },
      showMaxCapacity:          { type: Boolean, default: true },
      showEventCalendar:        { type: Boolean, default: true },
      showVenueOwnerName:       { type: Boolean, default: false },
      showExactAddress:         { type: Boolean, default: false },
      showBuildingName:         { type: Boolean, default: false },
      showUnitNumber:           { type: Boolean, default: false },
    },

    /* ── Post-Booking Reveal (what clients see AFTER booking) ──── */
    postBookingReveal: {
      revealExactAddress:       { type: Boolean, default: true },
      revealBuildingName:       { type: Boolean, default: true },
      revealUnitNumber:         { type: Boolean, default: true },
      revealVenueOwnerPhone:    { type: Boolean, default: true },
      revealVenueOwnerEmail:    { type: Boolean, default: false },
      revealPostalCode:         { type: Boolean, default: true },
    },

    /* ── Updated-by tracking ──────────────────────────────────── */
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ListingDetection', venueDetectionSchema);
