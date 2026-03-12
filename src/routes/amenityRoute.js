const express = require('express');
const { getAllAmenities, createAmenity,addCategoryToAmenity,deleteAmenityCategory } = require('../controllers/amenitiesController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');
const populateAmenities = require('../utils/populateAmenities');

const router = express.Router();

router.route('/').post(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("create amenity","Amenities"),createAmenity).get(getAllAmenities);
router.route('/:id').delete(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("Delete amenity category","Amenities"),deleteAmenityCategory);
router.route('/addcategory/:id').patch(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("Add category in Amenity","Amenities"),addCategoryToAmenity);

// Temporary seed endpoint — remove after use
router.get('/seed', async (req, res) => {
  try {
    await populateAmenities();
    res.json({ success: true, message: 'Amenities seeded successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
