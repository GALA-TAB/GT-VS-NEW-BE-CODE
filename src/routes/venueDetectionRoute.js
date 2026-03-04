const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const {
  getSettings,
  updateSettings,
  generateTitle,
  generateAllTitles,
  getMaskedLocation,
  getStats,
} = require('../controllers/venueDetectionController');

const router = express.Router();

router.use(requireAuth);

// Public (any authenticated user) — masked location for pre-booking
router.get('/masked-location/:listingId', getMaskedLocation);

// Admin only
router.get('/stats',  restrictTo(['admin']), getStats);
router.get('/',       restrictTo(['admin']), getSettings);
router.patch('/',     restrictTo(['admin']), updateSettings);
router.post('/generate-title', restrictTo(['admin']), generateTitle);
router.post('/generate-all-titles', restrictTo(['admin']), generateAllTitles);

module.exports = router;
