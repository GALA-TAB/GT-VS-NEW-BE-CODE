const express = require('express');
const {
  getAllAgreements,
  getAgreementById,
  getAgreementByBooking,
  getAgreementSummary,
} = require('../controllers/bookingAgreementController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Admin only — list all agreements (paginated, filterable)
router.get('/', restrictTo(['admin']), getAllAgreements);

// Admin only — per-booking agreement status for list screens. Must stay above
// '/:id' or 'summary' would be treated as an id.
router.get('/summary', restrictTo(['admin']), getAgreementSummary);

// Admin or the booking owner — view single agreement by ID
router.get('/:id', restrictTo(['admin']), getAgreementById);

// Get agreement by booking ID — admin, vendor, or customer who owns it
router.get('/booking/:bookingId', restrictTo(['admin', 'vendor', 'customer']), getAgreementByBooking);

module.exports = router;
