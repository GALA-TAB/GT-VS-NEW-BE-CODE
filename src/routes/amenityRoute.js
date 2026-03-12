const express = require('express');
const { getAllAmenities, createAmenity,addCategoryToAmenity,deleteAmenityCategory } = require('../controllers/amenitiesController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

const router = express.Router();

router.route('/').post(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("create amenity","Amenities"),createAmenity).get(getAllAmenities);
router.route('/:id').delete(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("Delete amenity category","Amenities"),deleteAmenityCategory);
router.route('/addcategory/:id').patch(requireAuth,restrictTo(["vendor",'admin']),logActionMiddleware("Add category in Amenity","Amenities"),addCategoryToAmenity);

module.exports = router;
