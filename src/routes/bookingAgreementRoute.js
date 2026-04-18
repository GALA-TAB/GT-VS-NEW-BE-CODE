const express = require('express');
const {
  getAllAgreements,
  getAgreementById,
  getAgreementByBooking,
} = require('../controllers/bookingAgreementController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Admin only — list all agreements (paginated, filterable)
router.get('/', restrictTo(['admin']), getAllAgreements);

// Admin or the booking owner — view single agreement by ID
router.get('/:id', restrictTo(['admin']), getAgreementById);

// Get agreement by booking ID — admin, vendor, or customer who owns it
router.get('/booking/:bookingId', restrictTo(['admin', 'vendor', 'customer']), getAgreementByBooking);

module.exports = router;
