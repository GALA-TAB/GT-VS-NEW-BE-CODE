const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const {
  reportViolation,
  getViolations,
  updateViolation,
  deleteViolation,
  getViolationStats,
} = require('../controllers/chatViolationController');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Any authenticated user can report a violation (the blocked sender)
router.post('/', reportViolation);

// Admin-only routes
router.get('/stats', restrictTo(['admin']), getViolationStats);
router.get('/', restrictTo(['admin']), getViolations);
router.patch('/:id', restrictTo(['admin']), updateViolation);
router.delete('/:id', restrictTo(['admin']), deleteViolation);

module.exports = router;
