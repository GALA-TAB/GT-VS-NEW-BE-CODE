const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { updateMe, getMe, deleteMe, getAllUsers,getAllUsersforAdmin ,updatestaus,sendMailToUsers,getVendorforService,CreateVendorByAdmin,CreateCustomerByAdmin,getUser,addLastViewedService,UpdateUserByAdmin,is2FAEnabled, getAllCustomerandVendor} = require('../controllers/userController');

const restrictTo = require('../middlewares/restrictTo');
const { roles } = require('../utils/types');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

const router = express.Router();

router.use(requireAuth);

// User profile  restrictTo(roles.VENDOR, roles.CUSTOMER),
router.route('/Me').get(getMe).patch(logActionMiddleware('Update Profile', 'User'),updateMe).delete(logActionMiddleware('Delete Profile', 'User'),deleteMe);
router.route('/is2FAEnabled').post(logActionMiddleware('Update 2FA Status', 'User'),is2FAEnabled);
router.route('/addLastViewedService').patch(logActionMiddleware('Add Last Viewed Service', 'User'),addLastViewedService);
// Admin-only routes
router.route('/service/:userId').get(restrictTo([roles.ADMIN,roles.VENDOR,roles.CUSTOMER]),getVendorforService);
router.route('/customerandvendors').get(restrictTo([roles.ADMIN,roles.VENDOR,roles.CUSTOMER]),getAllCustomerandVendor);
router.use(restrictTo([roles.ADMIN]));
router.route('/').get(getAllUsers)
router.route("/updatestatus/:id").patch(logActionMiddleware('Update Status', 'User'),updatestaus);
router.route('/CreateVendor').post(logActionMiddleware('Create vendor', 'User'),CreateVendorByAdmin);
router.route('/CreateCustomer').post(logActionMiddleware('Create customer', 'User'),CreateCustomerByAdmin);
router.route("/sendmessage").post(sendMailToUsers)
router.route('/AccountUsers').get(restrictTo([roles.ADMIN]),getAllUsersforAdmin);
router.get('/getUser/:id', restrictTo([roles.ADMIN]),getUser);
router.route('/:id').patch(restrictTo([roles.ADMIN]),logActionMiddleware('Update User Detail by Admin', 'User'),UpdateUserByAdmin)
module.exports = router;
