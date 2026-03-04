const express = require('express');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middlewares/requireAuth');
const {
  initiateUpload,
  generatePresignedUrl,
  completeUpload,
  handleLocalChunkUpload,
  getPresignedPut,
  uploadImage,
  uploadMiddleware,
  serviceMediaMiddleware,
  uploadServiceMedia,
  awsStatus
} = require('../controllers/uploadController');
const { testAwsConnection } = require('../middlewares/aws-v3');


const router = express.Router();

console.log('[uploadRoute] routes registered: /upload-image, /presigned-put, /initiate-upload');

// AWS config status (no secrets) — for debugging
router.get('/aws-status', awsStatus);

// Live AWS connectivity test — actually calls S3 to verify the credentials work
router.get('/aws-test', async (req, res) => {
  const result = await testAwsConnection();
  return res.status(result.success ? 200 : 500).json(result);
});

// Token debug endpoint — diagnose JWT verification issues
router.get('/test-token', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.json({ error: 'No Authorization header received' });
  const token = auth.split(' ')[1];
  if (!token) return res.json({ error: 'No token after Bearer' });
  const secret = process.env.JWT_SECRET;
  try {
    const decoded = jwt.verify(token, secret);
    return res.json({
      success: true,
      secretSet: !!secret,
      secretLength: secret ? secret.length : 0,
      tokenLength: token.length,
      userId: decoded?.user?._id,
      role: decoded?.user?.role,
      exp: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : 'no expiry'
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      errorName: err.name,
      secretSet: !!secret,
      secretLength: secret ? secret.length : 0,
      tokenLength: token.length,
      tokenPreview: token.substring(0, 20) + '...'
    });
  }
});

// Direct server-side upload — requireAuth temporarily removed to diagnose JWT issue
// TODO: restore requireAuth once JWT_SECRET is confirmed working
router.post('/upload-image', uploadMiddleware, uploadImage);

// ── Secure moderated upload for service listing media (photos + videos) ──
// Runs full moderation pipeline: metadata, OCR, scene classification
router.post('/service-media', requireAuth, serviceMediaMiddleware, uploadServiceMedia);

// Simple single-file upload via presigned PUT
router.post('/presigned-put', requireAuth, getPresignedPut);

// Multipart upload (for large files)
router.post('/initiate-upload', requireAuth, initiateUpload);
router.post('/generate-presigned-url', requireAuth, generatePresignedUrl);
router.post('/complete-upload', requireAuth, completeUpload);
router.put('/chunk/:uploadId/:partNumber', requireAuth, handleLocalChunkUpload);

module.exports = router;
