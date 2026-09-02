const express = require('express');
const {
  createSharedCartPayment,
  updateSharedCartPayment,
  getSharedCartByToken,
  processSharedCartPayment,
  getMySharedCartLinks,
  deactivateSharedCartLink,
} = require('../controllers/sharedCartPaymentController');
const requireAuth = require('../middlewares/requireAuth');
const router = express.Router();

// Authenticated — create link & manage own links
router.post('/', requireAuth, createSharedCartPayment);
router.get('/my-links', requireAuth, getMySharedCartLinks);
router.patch('/:token/deactivate', requireAuth, deactivateSharedCartLink);
router.patch('/:token', requireAuth, updateSharedCartPayment);

// Public — view & pay (no auth required)
router.get('/:token', getSharedCartByToken);
router.post('/:token/pay', processSharedCartPayment);

module.exports = router;
