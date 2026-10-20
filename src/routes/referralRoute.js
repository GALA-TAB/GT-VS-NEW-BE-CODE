const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const {
  getReferralOverview,
  updateParticipation,
  createAttribution,
  confirmServiceCompletion,
  startPayoutOnboarding,
  getPayoutOnboardingStatus,
  getAdminOverview,
  updateAdminSettings,
  reviewCommission,
  exportAdminRecords
} = require('../controllers/referralController');

const router = express.Router();

router.post('/attribution', rateLimit({ windowMs: 60 * 60 * 1000, max: 30 }), createAttribution);
router.get('/me', requireAuth, restrictTo(['customer', 'vendor']), getReferralOverview);
router.patch('/participation', requireAuth, restrictTo(['customer', 'vendor']), updateParticipation);
router.post('/payout-onboarding', requireAuth, restrictTo(['customer', 'vendor']), startPayoutOnboarding);
router.get('/payout-onboarding/status', requireAuth, restrictTo(['customer', 'vendor']), getPayoutOnboardingStatus);
router.post('/bookings/:bookingId/complete', requireAuth, restrictTo(['vendor', 'admin']), confirmServiceCompletion);
router.get('/admin', requireAuth, restrictTo(['admin']), getAdminOverview);
router.get('/admin/export', requireAuth, restrictTo(['admin']), exportAdminRecords);
router.patch('/admin/settings', requireAuth, restrictTo(['admin']), updateAdminSettings);
router.patch('/admin/commissions/:commissionId', requireAuth, restrictTo(['admin']), reviewCommission);

module.exports = router;