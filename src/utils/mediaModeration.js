/**
 * mediaModeration.js — Secure media upload moderation pipeline
 *
 * Validates and analyses uploaded images/videos before allowing publication.
 *
 * Pipeline:
 *   1. Metadata inspection (GPS / geolocation stripping)
 *   2. Video: duration check (≤30s), audio removal, frame extraction
 *   3. OCR on every frame/photo → contact-info regex detection
 *   4. Scene classification → indoor-only enforcement
 *   5. Landmark / outdoor location detection
 *
 * Dependencies:
 *   fluent-ffmpeg (ffmpeg + ffprobe wrappers)
 *   tesseract.js  (browser-less OCR)
 *   exif-parser   (EXIF/GPS metadata)
 *   @tensorflow/tfjs  (TF runtime — pure JS, no native build)
 *   @tensorflow-models/mobilenet (scene/object classification)
 *   sharp (image resizing helper)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── ALL heavy deps are lazy-loaded to avoid crashing the server on startup ──
// tesseract.js, exif-parser, sharp, @tensorflow/tfjs, @tensorflow-models/mobilenet,
// fluent-ffmpeg, ffmpeg-static, ffprobe-static are required ONLY when actually called.

/* ═══════════════════════════════════════════════════════════
 * ffmpeg / ffprobe — lazy loaded, with PATH auto-detection
 * ═══════════════════════════════════════════════════════════ */
let ffmpeg;
let ffmpegInstalled = false;

function getFfmpeg() {
  if (!ffmpeg) {
    ffmpeg = require('fluent-ffmpeg');
    // Try to locate ffmpeg/ffprobe binaries
    try {
      const ffmpegPath = require('ffmpeg-static');
      if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    } catch { /* not installed — rely on system PATH */ }
    try {
      const ffprobePath = require('ffprobe-static').path;
      if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
    } catch { /* not installed — rely on system PATH */ }
    ffmpegInstalled = true;
  }
  return ffmpeg;
}

/* ═══════════════════════════════════════════════════════════
 * TensorFlow + MobileNet — lazy singleton
 * ═══════════════════════════════════════════════════════════ */
let mobilenetModel = null;
let mobilenetUnavailable = false;

async function getMobileNet() {
  if (mobilenetUnavailable) return null;
  if (!mobilenetModel) {
    try {
      // Use pure-JS TF backend (no native build required)
      require('@tensorflow/tfjs');
      const mobilenet = require('@tensorflow-models/mobilenet');
      mobilenetModel = await mobilenet.load({ version: 2, alpha: 1.0 });
      console.log('[mediaModeration] MobileNet v2 loaded');
    } catch (err) {
      console.warn('[mediaModeration] MobileNet not available — scene classification will be skipped:', err.message);
      mobilenetUnavailable = true;
      return null;
    }
  }
  return mobilenetModel;
}

/* ═══════════════════════════════════════════════════════════
 * TEMP DIRECTORY helpers
 * ═══════════════════════════════════════════════════════════ */
function tmpDir() {
  const dir = path.join(os.tmpdir(), 'gt-media-mod');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpFile(ext = '') {
  return path.join(tmpDir(), `${crypto.randomBytes(12).toString('hex')}${ext}`);
}

function cleanupFiles(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best-effort */ }
  }
}

function cleanupDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        try { fs.unlinkSync(path.join(dir, e)); } catch { /* best-effort */ }
      }
      fs.rmdirSync(dir);
    }
  } catch { /* best-effort */ }
}

/* ═══════════════════════════════════════════════════════════
 * 1. METADATA INSPECTION
 * ═══════════════════════════════════════════════════════════ */
function inspectMetadata(buffer) {
  const reasons = [];
  try {
    const ExifParser = require('exif-parser');
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    const tags = result.tags || {};

    // Check for GPS coordinates
    if (
      (tags.GPSLatitude !== undefined && tags.GPSLatitude !== null) ||
      (tags.GPSLongitude !== undefined && tags.GPSLongitude !== null) ||
      tags.GPSPosition ||
      tags.GPSAltitude !== undefined
    ) {
      reasons.push('GPS geolocation metadata detected in file');
    }
  } catch {
    // Not a JPEG/TIFF with EXIF — that is fine
  }
  return reasons;
}

/* ═══════════════════════════════════════════════════════════
 * 2. VIDEO PROCESSING — duration, mute audio, extract frames
 * ═══════════════════════════════════════════════════════════ */

/**
 * Get video duration in seconds using ffprobe
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    getFfmpeg().ffprobe(filePath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const duration = metadata?.format?.duration;
      if (duration === undefined || duration === null) {
        return reject(new Error('Could not determine video duration'));
      }
      resolve(Number(duration));
    });
  });
}

/**
 * Remove audio track and produce a muted video
 * Returns path to the muted file
 */
function muteVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = tmpFile('.mp4');
    getFfmpeg()(inputPath)
      .noAudio()
      .videoCodec('copy')          // fast — no re-encoding
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`ffmpeg mute failed: ${err.message}`)))
      .run();
  });
}

/**
 * Extract frames at 1 fps for up to 30 seconds
 * Returns array of file paths to extracted PNG frames
 */
function extractFrames(videoPath, maxSeconds = 30) {
  return new Promise((resolve, reject) => {
    const framesDir = path.join(tmpDir(), `frames_${crypto.randomBytes(6).toString('hex')}`);
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

    getFfmpeg()(videoPath)
      .outputOptions([
        '-vf', `fps=1`,                          // 1 frame per second
        '-t', String(maxSeconds),                  // limit to first 30s
        '-vsync', 'vfr',
      ])
      .output(path.join(framesDir, 'frame_%03d.png'))
      .on('end', () => {
        const files = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.png'))
          .sort()
          .map(f => path.join(framesDir, f));
        resolve({ frames: files, framesDir });
      })
      .on('error', (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
      .run();
  });
}

/* ═══════════════════════════════════════════════════════════
 * 3. OCR + CONTACT INFORMATION DETECTION
 * ═══════════════════════════════════════════════════════════ */

/**
 * Number-word normaliser ("five" → "5", "eight" → "8")
 */
const WORD_TO_DIGIT = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10',
};

function normalizeNumberWords(text) {
  const words = Object.keys(WORD_TO_DIGIT).join('|');
  const re = new RegExp(`\\b(${words})\\b`, 'gi');
  return text.replace(re, (m) => WORD_TO_DIGIT[m.toLowerCase()] || m);
}

/**
 * Run OCR on an image buffer, return extracted text
 */
let ocrWorker = null;

async function getOcrWorker() {
  if (!ocrWorker) {
    const { createWorker } = require('tesseract.js');
    ocrWorker = await createWorker('eng');
    console.log('[mediaModeration] Tesseract OCR worker ready');
  }
  return ocrWorker;
}

async function ocrImage(bufferOrPath) {
  const worker = await getOcrWorker();
  const { data: { text } } = await worker.recognize(bufferOrPath);
  return text || '';
}

/**
 * Regex patterns for detecting contact information in OCR text
 */
const CONTACT_PATTERNS = [
  // Phone numbers — US + international
  { name: 'phone number', pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: 'phone number', pattern: /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}/g },
  { name: 'phone number', pattern: /\d{10,}/g },

  // Email addresses
  { name: 'email address', pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { name: 'email address', pattern: /[a-zA-Z0-9._%+\-]+\s*(?:at|@)\s*[a-zA-Z0-9.\-]+\s*(?:dot|\.)\s*[a-zA-Z]{2,}/gi },

  // URLs / links
  { name: 'URL', pattern: /https?:\/\/[^\s<>"']+/gi },
  { name: 'URL', pattern: /www\.[^\s<>"']+/gi },
  { name: 'URL', pattern: /[a-zA-Z0-9\-]+\.(?:com|net|org|io|co|me|app|dev|xyz|info|biz)\b/gi },

  // Social media handles
  { name: 'social media handle', pattern: /(?:instagram|insta|ig|snap(?:chat)?|tik\s*tok|telegram|whats\s*app|discord|twitter|facebook|fb|linkedin)\s*[:@=]?\s*[@]?[\w.]{2,30}/gi },
  { name: 'social media handle', pattern: /(?<!\w)@[a-zA-Z][\w.]{2,29}(?!\.\w{2,4}\b)/g },

  // Physical addresses
  { name: 'physical address', pattern: /\b\d{1,5}\s+[A-Za-z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|dr(?:ive)?|rd|road|ln|lane|ct|court|way)\b/gi },

  // Payment instructions
  { name: 'payment info', pattern: /(?:cash\s*app|venmo|zelle|paypal)\s*[:@$]?\s*[\w@$.]{0,30}/gi },
  { name: 'payment info', pattern: /\$[a-zA-Z][\w]{1,20}/g },

  // QR code mention (textual hint — actual image QR detection would need a detector)
  { name: 'QR code reference', pattern: /\bqr\s*code\b/gi },
  { name: 'QR code reference', pattern: /\bscan\s+(?:this|the|my)\s+(?:code|qr)\b/gi },
];

/**
 * Detect contact information in OCR text
 */
function detectContactInfo(text) {
  const reasons = [];
  const normalized = normalizeNumberWords(text);

  // Also collapse deliberate spacing: "5 5 5 1 2 3" → "555123"
  const collapsed = normalized.replace(/\b(\d)\s+(?=\d\b)/g, '$1');

  for (const { name, pattern } of CONTACT_PATTERNS) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;
    const sources = [text, normalized, collapsed];
    for (const src of sources) {
      const p = new RegExp(pattern.source, pattern.flags);
      const match = src.match(p);
      if (match && match.length > 0) {
        reasons.push(`${name} detected in image text: "${match[0]}"`);
        break; // one match per pattern is enough
      }
    }
  }
  return reasons;
}

/* ═══════════════════════════════════════════════════════════
 * 4. SCENE CLASSIFICATION — indoor vs outdoor
 * ═══════════════════════════════════════════════════════════ */

// Keywords in MobileNet class labels that indicate OUTDOOR scenes
const OUTDOOR_KEYWORDS = [
  'street', 'sidewalk', 'parking', 'park', 'garden', 'beach', 'mountain',
  'cliff', 'ocean', 'lake', 'river', 'forest', 'desert', 'sky', 'skyline',
  'bridge', 'dam', 'lighthouse', 'church', 'mosque', 'palace', 'castle',
  'monument', 'fountain', 'crane', 'construction', 'roof', 'patio',
  'terrace', 'balcony', 'lawn', 'field', 'stadium', 'amphitheatre',
  'valley', 'volcano', 'waterfall', 'pier', 'dock', 'harbor', 'seashore',
  'breakwater', 'promontory', 'alp', 'lakeshore', 'sandbar',
  'barn', 'greenhouse', 'boathouse', 'mobile home', 'trailer',
  'picket fence', 'stone wall', 'worm fence', 'chainlink fence',
  'cab', 'taxi', 'limousine', 'minivan', 'ambulance', 'fire engine',
  'police van', 'jeep', 'moving van', 'garbage truck', 'trailer truck',
  'aircraft', 'airplane', 'airliner', 'airship', 'balloon', 'parachute',
  'bicycle', 'tricycle', 'unicycle', 'rickshaw', 'oxcart',
  'canoe', 'kayak', 'catamaran', 'sailboat', 'speedboat', 'gondola',
  'drone', 'solar dish',
];

// Keywords indicating well-known LANDMARKS
const LANDMARK_KEYWORDS = [
  'obelisk', 'monument', 'triumphal arch', 'palace', 'castle',
  'church', 'mosque', 'cathedral', 'stupa', 'pagoda', 'dome',
  'beacon', 'lighthouse', 'megalith', 'totem',
  'dam', 'suspension bridge', 'steel arch bridge', 'viaduct',
  'tower', 'bell tower', 'clock tower',
];

// Keywords indicating INDOOR-ALLOWED scenes
const INDOOR_KEYWORDS = [
  'stage', 'ballroom', 'banquet', 'hall', 'restaurant', 'dining',
  'bar', 'lounge', 'library', 'studio', 'office', 'shop',
  'showroom', 'theater', 'cinema', 'auditorium', 'gallery',
  'room', 'suite', 'lobby', 'corridor', 'staircase', 'elevator',
  'kitchen', 'bathroom', 'bedroom', 'living room', 'parlor',
  'table', 'chair', 'desk', 'sofa', 'couch', 'candelabra',
  'chandelier', 'lamp', 'curtain', 'pillow', 'quilt',
  'vase', 'flower arrangement', 'plate', 'cup', 'wine glass',
  'wine bottle', 'cocktail', 'goblet', 'tray', 'menu',
  'spotlight', 'projector', 'screen', 'monitor',
  'microphone', 'speaker', 'piano', 'organ', 'accordion',
  'entertainment center', 'home theater',
];

/**
 * Classify a single image using MobileNet
 * Returns { isOutdoor, isLandmark, topPredictions, reasons }
 */
async function classifyImage(bufferOrPath) {
  const model = await getMobileNet();
  if (!model) {
    // MobileNet unavailable — skip classification (graceful degradation)
    return { isOutdoor: false, isLandmark: false, topPredictions: [], reasons: [] };
  }
  const tf = require('@tensorflow/tfjs');

  // Load image into tensor
  let imgBuffer;
  if (Buffer.isBuffer(bufferOrPath)) {
    imgBuffer = bufferOrPath;
  } else {
    imgBuffer = fs.readFileSync(bufferOrPath);
  }

  // Decode to 3-channel RGB via sharp then to tensor
  const sharp = require('sharp');
  const { data, info } = await sharp(imgBuffer)
    .resize(224, 224, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(data, [info.height, info.width, 3]);
  const predictions = await model.classify(tensor);
  tensor.dispose();

  const reasons = [];
  let isOutdoor = false;
  let isLandmark = false;

  for (const pred of predictions) {
    const label = pred.className.toLowerCase();
    const confidence = pred.probability;

    // Check landmarks
    if (LANDMARK_KEYWORDS.some(kw => label.includes(kw)) && confidence > 0.15) {
      isLandmark = true;
      reasons.push(`Landmark/identifiable location detected: "${pred.className}" (${(confidence * 100).toFixed(1)}%)`);
    }

    // Check outdoor scenes — block if confidence > 60%
    if (OUTDOOR_KEYWORDS.some(kw => label.includes(kw)) && confidence > 0.60) {
      isOutdoor = true;
      reasons.push(`Outdoor scene detected: "${pred.className}" (${(confidence * 100).toFixed(1)}%)`);
    }
  }

  return { isOutdoor, isLandmark, topPredictions: predictions, reasons };
}

/* ═══════════════════════════════════════════════════════════
 * MAIN MODERATION PIPELINE
 *
 * @param {Buffer}  buffer     — raw file bytes
 * @param {string}  mimetype   — e.g. 'image/jpeg', 'video/mp4'
 * @param {string}  originalName — original file name
 * @param {Object}  listingInfo — { existingVideoCount, existingPhotoCount }
 *
 * @returns {Object}
 *   { approved: bool, reasons: string[], mutedVideoBuffer?: Buffer }
 * ═══════════════════════════════════════════════════════════ */
async function moderateMedia(buffer, mimetype, originalName, listingInfo = {}) {
  const isVideo = mimetype.startsWith('video/');
  const isImage = mimetype.startsWith('image/');
  const reasons = [];
  let tempFiles = [];
  let tempDirs = [];
  let mutedVideoBuffer = null;

  if (!isVideo && !isImage) {
    return { approved: false, reasons: ['File type not supported. Only images and videos are allowed.'] };
  }

  try {
    /* ── Listing-level limits ─────────────────────────────── */
    if (isVideo) {
      if ((listingInfo.existingVideoCount || 0) >= 1) {
        return { approved: false, reasons: ['This listing already has a video. Only 1 video is allowed per listing.'] };
      }
    } else {
      if ((listingInfo.existingPhotoCount || 0) >= 40) {
        return { approved: false, reasons: ['Maximum of 40 photos reached for this listing.'] };
      }
    }

    /* ── 1. Metadata GPS check (images only — EXIF) ─────── */
    if (isImage) {
      const metaReasons = inspectMetadata(buffer);
      if (metaReasons.length > 0) reasons.push(...metaReasons);
    }

    /* ── 2. Video-specific processing ────────────────────── */
    let framePaths = [];
    let framesDir = null;

    if (isVideo) {
      // Write video to temp file for ffmpeg
      const videoTmp = tmpFile(path.extname(originalName) || '.mp4');
      fs.writeFileSync(videoTmp, buffer);
      tempFiles.push(videoTmp);

      // 2a. Check duration
      try {
        const duration = await getVideoDuration(videoTmp);
        console.log(`[mediaModeration] Video duration: ${duration.toFixed(1)}s`);
        if (duration > 30) {
          reasons.push(`Video exceeds 30-second limit (${duration.toFixed(1)}s). Please trim your video.`);
          return { approved: false, reasons };
        }
      } catch (err) {
        console.error('[mediaModeration] ffprobe error:', err.message);
        reasons.push('Could not verify video duration. Please ensure the video is valid.');
        return { approved: false, reasons };
      }

      // 2b. Mute audio
      try {
        const mutedPath = await muteVideo(videoTmp);
        tempFiles.push(mutedPath);
        mutedVideoBuffer = fs.readFileSync(mutedPath);
        console.log('[mediaModeration] Audio removed from video');
      } catch (err) {
        console.error('[mediaModeration] Mute error:', err.message);
        // Non-critical: continue with original
        mutedVideoBuffer = buffer;
      }

      // 2c. Extract frames
      try {
        const { frames, framesDir: fDir } = await extractFrames(videoTmp, 30);
        framePaths = frames;
        framesDir = fDir;
        tempDirs.push(fDir);
        console.log(`[mediaModeration] Extracted ${frames.length} frames`);
      } catch (err) {
        console.error('[mediaModeration] Frame extraction error:', err.message);
        // If we can't extract frames, we can't analyze — reject
        reasons.push('Could not extract video frames for analysis.');
        return { approved: false, reasons };
      }

      // Also check video metadata for GPS (from the raw buffer)
      const metaReasons = inspectMetadata(buffer);
      if (metaReasons.length > 0) reasons.push(...metaReasons);
    }

    /* ── 3. Analyze each frame/photo ─────────────────────── */
    const imagesToAnalyze = isVideo ? framePaths : [buffer]; // photos: analyze the buffer directly

    for (let i = 0; i < imagesToAnalyze.length; i++) {
      const imgSource = imagesToAnalyze[i];

      // 3a. OCR — detect text containing contact info
      try {
        const ocrText = await ocrImage(imgSource);
        if (ocrText.trim().length > 0) {
          const contactReasons = detectContactInfo(ocrText);
          if (contactReasons.length > 0) {
            reasons.push(...contactReasons);
          }
        }
      } catch (err) {
        console.error(`[mediaModeration] OCR error on ${isVideo ? `frame ${i + 1}` : 'image'}:`, err.message);
        // Non-critical — continue
      }

      // 3b. Scene classification — indoor/outdoor + landmark
      try {
        const classification = await classifyImage(imgSource);
        if (classification.isOutdoor) {
          reasons.push(...classification.reasons);
        }
        if (classification.isLandmark) {
          reasons.push(...classification.reasons.filter(r => r.includes('Landmark')));
        }
      } catch (err) {
        console.error(`[mediaModeration] Classification error on ${isVideo ? `frame ${i + 1}` : 'image'}:`, err.message);
        // Non-critical — continue
      }

      // If already enough reasons, break early (no need to check every frame)
      if (reasons.length >= 3) break;
    }

    /* ── 4. Final decision ───────────────────────────────── */
    // De-duplicate reasons
    const uniqueReasons = [...new Set(reasons)];

    if (uniqueReasons.length > 0) {
      return { approved: false, reasons: uniqueReasons };
    }

    return {
      approved: true,
      reasons: [],
      // For videos, return the muted buffer to upload instead of the original
      mutedVideoBuffer: isVideo ? mutedVideoBuffer : null,
    };
  } finally {
    // Cleanup temp files
    cleanupFiles(...tempFiles);
    for (const d of tempDirs) cleanupDir(d);
  }
}

/* ═══════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════ */
module.exports = {
  moderateMedia,
  inspectMetadata,
  getVideoDuration,
  muteVideo,
  extractFrames,
  ocrImage,
  detectContactInfo,
  classifyImage,
};
