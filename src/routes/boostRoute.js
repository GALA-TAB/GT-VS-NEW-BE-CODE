const express = require('express');
const {
  getBoostableListings,
  setListingBoost,
  removeListingBoost,
  getBoostTiers,
  getBoostStats,
} = require('../controllers/boostController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');

const router = express.Router();

// All boost routes require admin authentication
router.use(requireAuth, restrictTo(['admin']));

router.get('/tiers', getBoostTiers);
router.get('/stats', getBoostStats);
router.get('/listings', getBoostableListings);
router.post('/listings/:id', setListingBoost);
router.delete('/listings/:id', removeListingBoost);

module.exports = router;
