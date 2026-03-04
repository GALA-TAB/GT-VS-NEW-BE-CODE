const multer = require('multer');
const {
  initiateMultipartUpload,
  createPresignedUrl,
  uploadPart,
  completeMultipartUpload,
  generateDownloadUrl,
  hasAwsCredentials,
  getPresignedPutUrl,
  uploadFileToS3,
  deleteMedia
} = require('../middlewares/aws-v3');
const ServiceListing = require('../models/ServiceListing');
const { moderateMedia } = require('../utils/mediaModeration');

// Multer config for profile/generic image uploads (max 10MB, images only)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/jpg', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG and WebP images are allowed'));
    }
  }
});
const uploadMiddleware = upload.single('image');

// Multer config for SERVICE MEDIA uploads (photos + videos up to 100MB)
const serviceMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB for videos
  fileFilter: (req, file, cb) => {
    const allowedImages = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'];
    const allowedVideos = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
    if ([...allowedImages, ...allowedVideos].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, HEIC images and MP4, MOV, AVI, WebM, MKV videos are allowed'));
    }
  }
});
const serviceMediaMiddleware = serviceMediaUpload.single('media');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const {
  initiateUploadSchema,
  generatePresignedUrlSchema,
  completeUploadSchema
} = require('../utils/joi/fileUploadValidations');

// Determine if we should use AWS or local upload
const useAwsUpload = hasAwsCredentials();

// Don't load local file upload at all - it causes issues in serverless
// Lazy load local file upload only if AWS is not available
const getLocalFileUpload = () => {
  if (!useAwsUpload) {
    throw new AppError('File uploads require AWS S3 configuration in serverless environment', 500);
  }
  return null;
};

const initiateUpload = catchAsync(async (req, res, next) => {
  const { error } = initiateUploadSchema.validate(req.body, {
    abortEarly: false
  });

  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});

    return next(new AppError('Validation failed', 400, { errorFields }));
  }
  const { fileName, filetype } = req.body;
  console.log('files coming', req.body);

  let response;
  if (useAwsUpload) {
    response = await initiateMultipartUpload(fileName, filetype);
  } else {
    return next(new AppError('File uploads require AWS S3 configuration', 500));
  }
  
  return res.status(200).json({ success: true, response, uploadMode: useAwsUpload ? 'aws' : 'local' });
});

const generatePresignedUrl = catchAsync(async (req, res, next) => {
  const { error } = generatePresignedUrlSchema.validate(req.body, {
    abortEarly: false
  });

  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});

    return next(new AppError('Validation failed', 400, { errorFields }));
  }
  const { fileName, uploadId, filetype, numChunks } = req.body;

  console.log('pre signed body', req.body);

  let urls;
  if (useAwsUpload) {
    urls = await Promise.all(
      Array.from({ length: numChunks }, (_, i) =>
        createPresignedUrl(fileName, uploadId, i + 1, filetype)
      )
    );
  } else {
    // For local uploads, return local upload endpoints
    urls = Array.from({ length: numChunks }, (_, i) => 
      `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/upload/chunk/${uploadId}/${i + 1}`
    );
  }

  return res.status(200).json({ success: true, urls });
});

const completeUpload = catchAsync(async (req, res, next) => {
  const { error } = completeUploadSchema.validate(req.body, {
    abortEarly: false
  });

  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});

    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  const { fileName, uploadId } = req.body;

  let response;
  if (useAwsUpload) {
    response = await completeMultipartUpload(fileName, uploadId);
  } else {
    return next(new AppError('File uploads require AWS S3 configuration', 500));
  }

  return res.status(200).json({
    success: true,
    message: 'Upload completed successfully',
    data: response,
    uploadMode: useAwsUpload ? 'aws' : 'local'
  });
});
const uploadChunk = catchAsync(async (req, res, next) => {
  const { index, fileName, filetype } = req.body;
  const { uploadId } = req.query;
  const { file } = req;
  if (!index || !fileName || !uploadId || !file) {
    return next(new AppError('Missing required parameters.', 400));
  }

  if (useAwsUpload) {
    const response = await uploadPart(index, fileName, file.buffer, uploadId, filetype);
    return res.status(200).json({
      success: true,
      message: 'Chunk uploaded successfully',
      data: response
    });
  } else {
    return res.status(200).json({
      success: true,
      message: 'Chunk received successfully',
      data: { uploadId, partNumber: index }
    });
  }
});

const handleLocalChunkUpload = catchAsync(async (req, res, next) => {
  const { uploadId, partNumber } = req.params;

  if (!uploadId || !partNumber) {
    return next(new AppError('Missing uploadId or partNumber.', 400));
  }

  // The chunk data comes as raw binary in the request body
  const chunkBuffer = req.body;

  if (!chunkBuffer || chunkBuffer.length === 0) {
    return next(new AppError('No chunk data received.', 400));
  }

  // Local uploads not supported in serverless
  return next(new AppError('File uploads require AWS S3 configuration', 500));
  
  return res.status(200).json({
    success: true,
    message: 'Chunk uploaded successfully',
    data: response
  });
});

const downloadAwsObject = catchAsync(async (req, res, next) => {
  const { key } = req.body;

  if (!key) {
    return next(new AppError('File key is required.', 400));
  }

  const url = await generateDownloadUrl(key);
  return res.status(200).json({ success: true, url });
});

const getPresignedPut = catchAsync(async (req, res, next) => {
  const { fileName, filetype } = req.body;
  if (!fileName || !filetype) {
    return next(new AppError('fileName and filetype are required', 400));
  }
  if (!useAwsUpload) {
    return next(new AppError('File uploads require AWS S3 configuration', 500));
  }
  const uniqueName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { uploadUrl, fileUrl } = await getPresignedPutUrl(uniqueName, filetype);
  return res.status(200).json({ success: true, uploadUrl, fileUrl });
});

// AWS config status check (no secrets exposed)
const awsStatus = (req, res) => {
  const accessKey = process.env.AWS_ACCESS_KEY_ID || '';
  const bucket = process.env.AWS_STORAGE_BUCKET_NAME || '';
  const region = process.env.REGION || process.env.AWS_REGION || '';
  return res.status(200).json({
    success: true,
    aws: {
      configured: useAwsUpload,
      accessKeyPresent: !!accessKey,
      accessKeyPrefix: accessKey ? accessKey.substring(0, 8) : 'NOT SET',
      bucket: bucket || 'NOT SET',
      region: region || 'NOT SET',
    }
  });
};

// Direct server-side upload: receives file via multipart/form-data, uploads to S3, returns URL
const uploadImage = async (req, res, next) => {
  try {
    console.log('[uploadImage] called, file:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'MISSING');
    console.log('[uploadImage] useAwsUpload:', useAwsUpload);
    if (!req.file) {
      return next(new AppError('No image file provided. Make sure field name is "image"', 400));
    }
    if (!useAwsUpload) {
      return next(new AppError('AWS S3 is not configured on this server. Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_STORAGE_BUCKET_NAME env vars on Render.', 500));
    }
    const ext = req.file.originalname.split('.').pop();
    const uniqueName = `profiles/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    console.log('[uploadImage] uploading to S3 key:', uniqueName);
    const fileUrl = await uploadFileToS3(req.file.buffer, uniqueName, req.file.mimetype);
    console.log('[uploadImage] success, url:', fileUrl);
    return res.status(200).json({ success: true, url: fileUrl });
  } catch (err) {
    console.error('[uploadImage] error:', err.name, err.message);
    return next(new AppError(`Upload failed: ${err.message}`, 500));
  }
};

/* ═══════════════════════════════════════════════════════════════════════
 * uploadServiceMedia — Secure, moderated upload for service listing media
 *
 * POST /api/upload/service-media
 * Body: multipart/form-data  field="media" (single file)
 * Query/Body: serviceId (required)
 *
 * Steps:
 *   1. Look up the listing to count existing photos/videos
 *   2. Run the full moderation pipeline (metadata, OCR, scene classification)
 *   3. If approved → upload to S3, return { url, type, key }
 *   4. If rejected → return 400 with reasons
 * ═══════════════════════════════════════════════════════════════════════ */
const REJECTION_MSG =
  'Upload rejected. Media must only show interior venue spaces without contact information. Listings allow one 30-second video and up to 40 photos.';

const uploadServiceMedia = async (req, res, next) => {
  try {
    // ── 1. Validate inputs ──────────────────────────────────
    const serviceId = req.body.serviceId || req.query.serviceId;
    if (!serviceId) {
      return next(new AppError('serviceId is required', 400));
    }
    if (!req.file) {
      return next(new AppError('No media file provided. Use field name "media".', 400));
    }
    if (!useAwsUpload) {
      return next(new AppError('AWS S3 is not configured on this server.', 500));
    }

    const file = req.file;
    const isVideo = file.mimetype.startsWith('video/');
    const isImage = file.mimetype.startsWith('image/');

    console.log(`[uploadServiceMedia] serviceId=${serviceId}, file=${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB), type=${file.mimetype}`);

    // ── 2. Fetch listing to check existing media counts ─────
    const listing = await ServiceListing.findById(serviceId).select('media');
    if (!listing) {
      return next(new AppError('Service listing not found', 404));
    }

    const existingMedia = listing.media || [];
    const existingVideoCount = existingMedia.filter(m => m.type === 'video').length;
    const existingPhotoCount = existingMedia.filter(m => m.type === 'image').length;

    // ── Quick server-side limit check before expensive moderation ──
    if (isVideo && existingVideoCount >= 1) {
      return res.status(400).json({
        success: false,
        message: 'This listing already has a video. Only 1 video is allowed per listing.',
      });
    }
    if (isImage && existingPhotoCount >= 40) {
      return res.status(400).json({
        success: false,
        message: 'Maximum of 40 photos reached for this listing.',
      });
    }

    // ── 3. Run moderation pipeline ──────────────────────────
    console.log('[uploadServiceMedia] Starting moderation pipeline...');
    const moderationResult = await moderateMedia(
      file.buffer,
      file.mimetype,
      file.originalname,
      { existingVideoCount, existingPhotoCount }
    );

    if (!moderationResult.approved) {
      console.log('[uploadServiceMedia] REJECTED:', moderationResult.reasons);
      return res.status(400).json({
        success: false,
        message: REJECTION_MSG,
        reasons: moderationResult.reasons,
      });
    }

    // ── 4. Upload approved media to S3 ──────────────────────
    const ext = file.originalname.split('.').pop() || (isVideo ? 'mp4' : 'jpg');
    const s3Key = `listings/${serviceId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    // For videos, upload the muted version; for images, upload original
    const bufferToUpload = isVideo && moderationResult.mutedVideoBuffer
      ? moderationResult.mutedVideoBuffer
      : file.buffer;

    const contentType = isVideo ? 'video/mp4' : file.mimetype;
    const fileUrl = await uploadFileToS3(bufferToUpload, s3Key, contentType);

    console.log(`[uploadServiceMedia] Uploaded to S3: ${fileUrl}`);

    // ── 5. Return the approved media info ─────────────────
    return res.status(200).json({
      success: true,
      message: 'Media uploaded and approved',
      data: {
        url: fileUrl,
        type: isVideo ? 'video' : 'image',
        key: s3Key,
      },
    });
  } catch (err) {
    console.error('[uploadServiceMedia] error:', err.name, err.message);
    return next(new AppError(`Upload failed: ${err.message}`, 500));
  }
};

module.exports = {
  generatePresignedUrl,
  initiateUpload,
  completeUpload,
  uploadChunk,
  handleLocalChunkUpload,
  downloadAwsObject,
  getPresignedPut,
  uploadImage,
  uploadMiddleware,
  serviceMediaMiddleware,
  uploadServiceMedia,
  awsStatus
};
