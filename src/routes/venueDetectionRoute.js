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
  checkContent,
} = require('../controllers/venueDetectionController');

const router = express.Router();

router.use(requireAuth);

// Any authenticated user
router.get('/masked-location/:listingId', getMaskedLocation);
router.post('/check-content', checkContent);

// Admin only
router.get('/stats',  restrictTo(['admin']), getStats);
router.get('/',       restrictTo(['admin']), getSettings);
router.patch('/',     restrictTo(['admin']), updateSettings);
router.post('/generate-title', restrictTo(['admin']), generateTitle);
router.post('/generate-all-titles', restrictTo(['admin']), generateAllTitles);

module.exports = router;
