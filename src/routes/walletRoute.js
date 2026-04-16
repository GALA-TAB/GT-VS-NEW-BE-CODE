const express = require('express');
const {
  getWallet,
  addFunds,
  payFromWallet,
  createFundMeLink,
  getFundMeLink,
  contributeFundMe,
  deactivateFundMeLink,
} = require('../controllers/walletController');
const requireAuth = require('../middlewares/requireAuth');
const router = express.Router();

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
