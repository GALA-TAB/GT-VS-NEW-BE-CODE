  const express = require('express');
const {
  initiateKyc,
  uploadKyc,
  getallPendingKYC,
  approveRejectDocs,
  getallvendor,
  updateKycStatus,
  directUploadKyc,
  getVendorVerificationStatus,
  getVendorAllDocuments
} = require('../controllers/KYCController');
const requireAuth = require('../middlewares/requireAuth');
const { VerficationComplete } = require('../utils/veriff');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

const router = express.Router();

// =================KYC FLOW================
// KYC SESSION schema, KYC DOCUMENT schema

// 1. user clicks on next button, initiate-kyc API hits. backend creates the KYC session document in DB
// 2. also backend creates and sends the qrcode to frontend. user scans the qrcode from mobile.
// 3. then frontend uploads the documents(driving license, passport, gov ID) + Selfie
// 4. frontend sends the image urls with sessionToken to the upload-kyc API to create the KYCDocument Doc in the DB.
// 5. also backend makes the session completed

// initiate the KYC session by storeing the session in DB
router.get('/initiate-kyc', requireAuth, initiateKyc);
router.patch('/update-kyc-status/:documentId', requireAuth, restrictTo(["admin"]), logActionMiddleware('Update kyc status', 'KYCDocument'), updateKycStatus);

// uploads the docs+selfie urls to DB
router.post('/upload-kyc', requireAuth, logActionMiddleware('Upload kyc', 'KYCDocument'), uploadKyc);

// direct upload front/back photos without QR session
router.post('/direct-upload', requireAuth, logActionMiddleware('Direct upload kyc', 'KYCDocument'), directUploadKyc);

router.post('/verfication', VerficationComplete);

// for admin, get all pending KYC docs
router.get('/kyc/pending', requireAuth, restrictTo(["admin"]), getallPendingKYC);

// route to approve or reject KYC DOCs
router.post('/kyc/review', requireAuth, restrictTo(["admin"]), approveRejectDocs);
router.get('/verification-status', requireAuth, restrictTo(["vendor"]), getVendorVerificationStatus);
router.get('/vendor-documents/:vendorId', requireAuth, restrictTo(["admin"]), getVendorAllDocuments);
router.get('/',  getallvendor);

module.exports = router;
