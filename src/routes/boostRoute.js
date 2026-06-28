const express = require('express');
const {
  getBoostableListings,
  setListingBoost,
  removeListingBoost,
  getBoostTiers,
  getBoostStats,
  requestListingBoost,
  getPendingBoostRequests,
  approveBoostRequest,
  rejectBoostRequest,
} = require('../controllers/boostController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');

const router = express.Router();

// Public: tier config (used by vendor boost modal to show fees)
router.get('/tiers', getBoostTiers);

// Vendor: request a boost for their own listing
router.post('/listings/:id/request', requireAuth, restrictTo(['vendor']), requestListingBoost);

// Admin-only routes
router.use(requireAuth, restrictTo(['admin']));
router.get('/stats', getBoostStats);
router.get('/listings', getBoostableListings);
router.post('/listings/:id', setListingBoost);
router.delete('/listings/:id', removeListingBoost);
router.get('/requests', getPendingBoostRequests);
router.post('/requests/:id/approve', approveBoostRequest);
router.post('/requests/:id/reject', rejectBoostRequest);

module.exports = router;
