const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const {
  reportViolation,
  getViolations,
  updateViolation,
  deleteViolation,
  getViolationStats,
  setChatRestriction,
  getMyChatStatus,
} = require('../controllers/chatViolationController');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Any authenticated user
router.post('/', reportViolation);
router.get('/my-status', getMyChatStatus);

// Admin-only routes
router.get('/stats', restrictTo(['admin']), getViolationStats);
router.get('/', restrictTo(['admin']), getViolations);
router.patch('/restrict/:userId', restrictTo(['admin']), setChatRestriction);
router.patch('/:id', restrictTo(['admin']), updateViolation);
router.delete('/:id', restrictTo(['admin']), deleteViolation);

module.exports = router;
