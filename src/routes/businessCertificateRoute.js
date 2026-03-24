const express = require('express');
const {
  createBusinessCertificate,
  getBusinessCertificate,
  getAllBusinessCertificates,
  updateBusinessCertificate,
  verifyBusinessCertificate,
  deleteBusinessCertificate
} = require('../controllers/businessCertificateController');
const requireAuth = require('../middlewares/requireAuth');
const restrictTo = require('../middlewares/restrictTo');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

const router = express.Router();

router
  .route('/')
  .post(requireAuth, restrictTo(['vendor']), logActionMiddleware('Submit Business Certificate', 'BusinessCertificate'), createBusinessCertificate)
  .get(requireAuth, restrictTo(['admin']), getAllBusinessCertificates);

router
  .route('/:id')
  .get(getBusinessCertificate)
  .patch(requireAuth, restrictTo(['vendor', 'admin']), logActionMiddleware('Update Business Certificate', 'BusinessCertificate'), updateBusinessCertificate)
  .delete(requireAuth, restrictTo(['vendor', 'admin']), logActionMiddleware('Delete Business Certificate', 'BusinessCertificate'), deleteBusinessCertificate);

router
  .route('/verify/:id')
  .patch(requireAuth, restrictTo(['admin']), logActionMiddleware('Verify Business Certificate', 'BusinessCertificate'), verifyBusinessCertificate);

module.exports = router;
