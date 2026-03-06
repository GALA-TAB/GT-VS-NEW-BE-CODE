const express = require('express');
const {
    createBooking,
    updateBookingRequestStatus,
    getAllBookings,
    deleteBooking,
    updateBooking,
    getBookingById,
    getAllBookingsForVendorService,
    getAllBookingsForCustomer,
    cancelBooking,
    getRefundDataOfBooking,
    refundAmount,
    extendBooking,
    acceptorRejectExtension,
    extensionsRequestForVendor,
    getBookingExtensionHistory,
    extensionsRequestForCustomer,
    getBookingsWithMessagesByUser,
    checkServiceAvailability,
    getBookingServiceAddress
} = require('../controllers/requestController');

const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');
const subAuth = require('../middlewares/subAuth');

const router = express.Router();


//  More specific static routes first
router.route('/availability/:serviceId')
    .post(checkServiceAvailability);

router.route('/vendor')
    .get(requireAuth, restrictTo(["vendor","admin"],),subAuth,getAllBookingsForVendorService);
router.route('/vendor/extensionrequest')
    .get(requireAuth, restrictTo(["vendor","admin"]),subAuth,extensionsRequestForVendor);
router.get(
  '/customer/extensionrequest',
  requireAuth,
  restrictTo('customer'),
  extensionsRequestForCustomer
);

router.route('/customer/messages/:userId')
    .get(requireAuth, restrictTo(["admin"]), getBookingsWithMessagesByUser);

router.route('/customer')
    .get(requireAuth, restrictTo(["customer"]), getAllBookingsForCustomer);


router.route('/customer/:id')
    .patch(requireAuth, restrictTo(["customer","admin","vendor"]), logActionMiddleware("Cancel Booking","Booking"),cancelBooking);

//  Then general routes
router.route('/')
    .post(requireAuth, restrictTo(["customer"]),logActionMiddleware("Create Booking","Booking"), createBooking)
    .get(requireAuth, restrictTo(["admin"]),subAuth,getAllBookings);

router.route('/:bookingId/updateStatus')
    .patch(requireAuth, restrictTo(["vendor","admin"]), logActionMiddleware("Accept Booking","Booking"), subAuth,updateBookingRequestStatus);
router.route('/:id')
    .patch(requireAuth, restrictTo(["customer"]), logActionMiddleware("Update Booking","Booking"), updateBooking)
    .get(requireAuth, getBookingById)
    .delete(requireAuth, deleteBooking);

router.route('/:id/refunddata').get(requireAuth, restrictTo(["admin","vendor"]),subAuth, getRefundDataOfBooking).post(requireAuth, restrictTo(["admin","vendor"]),subAuth, refundAmount);
router.route('/:bookingId/extend').post(requireAuth, restrictTo(["customer","admin","vendor"]), logActionMiddleware("Extend Booking","Booking"), extendBooking).get(requireAuth, restrictTo(["customer","admin","vendor"]), subAuth,getBookingExtensionHistory);
router.route('/:extensionId/acceptorrejectextension').post(requireAuth, restrictTo(["vendor","admin","customer"]), logActionMiddleware("Accept or Reject Extension","Booking"), subAuth,acceptorRejectExtension);

// Service address reveal — only confirmed booking customer can access
router.route('/:bookingId/service-address')
    .get(requireAuth, restrictTo(["customer","admin"]), getBookingServiceAddress);

module.exports = router;
