 const express = require('express');
const {
    getAllServiceListings,
    createServiceListing,
    deleteServiceListing,
    updateServiceListing,
    deleteServicemedia,
    updateServiceDetail,
    getServiceListing,
    getServiceListingsforLandingPage,
    getServiceListingLanding,
    likeServiceListing,
    getAllLikedListings,
    getServiceListingTitle,
    getoverallServiceListings,
    getAllService,
    VerifyServiceListing,
} = require('../controllers/servicelistingController');
const requireAuth = require('../middlewares/requireAuth');
const optionalAuth = require('../middlewares/optionalAuth');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

const router = express.Router();

router.route('/').post(requireAuth, restrictTo(["vendor", "admin"],{
    admin:"serviceManagement",
    vendor:"listings",
    
}), logActionMiddleware('Create Service', 'ServiceListing'), createServiceListing).get(requireAuth, restrictTo(["vendor", "admin"]),  getAllServiceListings);
router.route("/map").get(getoverallServiceListings);
router.route("/all").get(requireAuth, restrictTo(["admin"]),getAllService);
router.route("/verify/:id").post(requireAuth, restrictTo(["admin"]),logActionMiddleware('Verify service', 'ServiceListing'), VerifyServiceListing);
router.route("/serviceTitle").get(requireAuth, restrictTo(["vendor", "admin"]),  getServiceListingTitle);
router.route('/like').post(requireAuth, logActionMiddleware('Like service', 'ServiceListing'), likeServiceListing).get(requireAuth, getAllLikedListings);
router.route('/:id').delete(requireAuth, restrictTo(["vendor", "admin"]), logActionMiddleware('Delete service', 'ServiceListing'), deleteServiceListing).patch(requireAuth, restrictTo(["vendor", "admin"]),  logActionMiddleware('Update service', 'ServiceListing'), updateServiceListing).get(optionalAuth, getServiceListing);
router.route('/updatedetail/:id').patch(requireAuth, restrictTo(["vendor", "admin"]),  logActionMiddleware('Update detail', 'ServiceListing'), updateServiceDetail);
router.route('/media/:mediaId').delete(requireAuth, restrictTo(["vendor", "admin"]),  logActionMiddleware('Delete media', 'ServiceListing'), deleteServicemedia);
router.route('/landingpage/services').get(getServiceListingsforLandingPage)
router.route('/landingpage/:id').get(getServiceListingLanding)

module.exports = router;
