const express = require('express');
const {
    getAllpaymentsforVendor,
    getAllPayments,
    vendorPayout,
    getsinglecompletedbooking,
    getEscrowStatus,
    fileDispute,
    resolveDispute,
    adminReleaseEscrow
} = require('../controllers/paymentController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const router = express.Router();

// ── Existing routes ──────────────────────────────────────────────────────────
router.route('/').get(requireAuth, restrictTo(['admin']), getAllPayments);
router.route('/vendor').get(requireAuth, restrictTo(['admin', 'vendor']), getAllpaymentsforVendor).post(requireAuth, restrictTo(['admin']), vendorPayout);
router.route('/:bookingId').get(requireAuth, restrictTo(['admin', 'vendor']), getsinglecompletedbooking);

// ── Escrow & Dispute routes ──────────────────────────────────────────────────
// GET  /api/payment/escrow/:bookingId           → check escrow status
router.get('/escrow/:bookingId', requireAuth, getEscrowStatus);

// POST /api/payment/dispute/:bookingId          → customer files dispute (within 72h)
router.post('/dispute/:bookingId', requireAuth, restrictTo(['user']), fileDispute);

// POST /api/payment/dispute/:bookingId/resolve  → admin resolves dispute
router.post('/dispute/:bookingId/resolve', requireAuth, restrictTo(['admin']), resolveDispute);

// POST /api/payment/escrow/:bookingId/release   → admin manually releases escrow
router.post('/escrow/:bookingId/release', requireAuth, restrictTo(['admin']), adminReleaseEscrow);

module.exports = router;