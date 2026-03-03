const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const { createNote, getNotes } = require('../controllers/adminNoteController');

const router = express.Router();

// All admin-note routes require a logged-in admin
router.use(requireAuth);
router.use(restrictTo(['admin']));

router.post('/', createNote);
router.get('/', getNotes);

module.exports = router;
