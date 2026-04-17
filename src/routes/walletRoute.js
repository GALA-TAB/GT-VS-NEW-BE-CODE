const express = require('express');
const {
  getWallet,
  addFunds,
  payFromWallet,
  createFundMeLink,
  getFundMeLink,
  contributeFundMe,
  deactivateFundMeLink,
  getAllWallets,
  getWalletByUserId,
  adminAdjustWallet,
} = require('../controllers/walletController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const router = express.Router();

// Admin — wallet management
router.get('/admin/all', requireAuth, restrictTo(['admin']), getAllWallets);
router.get('/admin/:userId', requireAuth, restrictTo(['admin']), getWalletByUserId);
router.post('/admin/:userId/adjust', requireAuth, restrictTo(['admin']), adminAdjustWallet);

// Authenticated — wallet owner
router.get('/', requireAuth, getWallet);
router.post('/add-funds', requireAuth, addFunds);
router.post('/pay-from-wallet', requireAuth, payFromWallet);
router.post('/create-fundme', requireAuth, createFundMeLink);
router.patch('/fundme/:token/deactivate', requireAuth, deactivateFundMeLink);

// Public — view & contribute to FundMe
router.get('/fundme/:token', getFundMeLink);
router.post('/fundme/:token/contribute', contributeFundMe);

module.exports = router;
