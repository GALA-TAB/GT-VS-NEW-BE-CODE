/**
 * mediaModeration.js — Secure media upload moderation pipeline
 *
 * Validates and analyses uploaded images/videos before allowing publication.
 *
 * Pipeline:
 *   1. Metadata inspection (GPS / geolocation stripping)
 *   2. Video: duration check (≤30s), audio removal, frame extraction
 *   3. OCR on every frame/photo → contact-info + sign detection
 *      (Single fast variant with 8s timeout to avoid slow uploads)
 *
 * Dependencies:
 *   fluent-ffmpeg (ffmpeg + ffprobe wrappers)
 *   tesseract.js  (browser-less OCR)
 *   exif-parser   (EXIF/GPS metadata)
 *   sharp         (image preprocessing for OCR)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── ALL heavy deps are lazy-loaded to avoid crashing the server on startup ──
// tesseract.js, exif-parser, sharp, fluent-ffmpeg, ffmpeg-static, ffprobe-static
// are required ONLY when actually called.

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
  // First, handle "eight hundred" → "800", "one hundred" → "100" etc.
  let result = text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b/gi,
    (_, digit) => String(WORD_TO_DIGIT[digit.toLowerCase()] * 100)
  );
  // Then replace remaining single digit words
  const words = Object.keys(WORD_TO_DIGIT).join('|');
  const re = new RegExp(`\\b(${words})\\b`, 'gi');
  return result.replace(re, (m) => WORD_TO_DIGIT[m.toLowerCase()] || m);
}

/**
 * Run OCR on an image buffer with preprocessing for better accuracy.
 *
 * Three preprocessing variants for maximum text extraction:
 *   1. Standard grayscale → threshold (dark text on light backgrounds)
 *   2. Red channel extraction → threshold (white/yellow text on GREEN/BLUE signs)
 *   3. Inverted grayscale → threshold (general light-on-dark text)
 *
 * The red channel variant is the key addition for colored signs:
 *   - Green signs (#006B3F): red=0 → background is black; white text red=255 → text is white
 *   - Blue signs (#003DA5): red=0 → background is black; white text red=255 → text is white
 *   - Yellow text (#FFCC00): red=255 → text stays bright even on green background
 *
 * Uses a total time budget (not per-variant) so slow Render cold starts
 * don't waste the entire timeout on one variant.
 */
let ocrWorker = null;
let ocrWorkerInitializing = false;

async function getOcrWorker() {
  if (!ocrWorker && !ocrWorkerInitializing) {
    ocrWorkerInitializing = true;
    try {
      const { createWorker } = require('tesseract.js');
      ocrWorker = await createWorker('eng');
      console.log('[mediaModeration] Tesseract OCR worker ready');
    } catch (err) {
      console.error('[mediaModeration] OCR worker init failed:', err.message);
      ocrWorkerInitializing = false;
      throw err;
    }
  }
  // If another call is already initializing, wait for it
  if (!ocrWorker) {
    const start = Date.now();
    while (!ocrWorker && Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return ocrWorker;
}

// Pre-initialize OCR worker in background so first upload doesn't bear the full cost
setTimeout(() => {
  getOcrWorker().catch(err =>
    console.error('[mediaModeration] Background OCR init failed:', err.message)
  );
}, 2000); // 2s after server start

const OCR_TOTAL_TIMEOUT_MS = 15000; // 15 seconds total budget for all variants

async function ocrImage(bufferOrPath) {
  const sharp = require('sharp');
  const worker = await getOcrWorker();

  let imgBuffer;
  if (Buffer.isBuffer(bufferOrPath)) {
    imgBuffer = bufferOrPath;
  } else {
    imgBuffer = fs.readFileSync(bufferOrPath);
  }

  // Get image metadata to decide upscaling
  const metadata = await sharp(imgBuffer).metadata();
  const minDim = Math.min(metadata.width || 0, metadata.height || 0);

  // Aim for 800px on shortest side — fast + sufficient for real text
  const scale = minDim > 0 && minDim < 800 ? Math.ceil(800 / minDim) : 1;
  const targetW = Math.min((metadata.width || 800) * scale, 2000);
  const targetH = Math.min((metadata.height || 800) * scale, 2000);

  // Variant 1: Standard grayscale → threshold (dark text on light bg)
  const normal = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .threshold(128)
    .png()
    .toBuffer();

  // Variant 2: Red channel extraction — best for GREEN/BLUE sign detection
  // White text (R=255) vs green bg (R≈0) → maximum contrast in red channel
  // Yellow text (#FFCC00, R=255) on green → also perfect contrast in red channel
  // Lower threshold (60) preserves JPEG-compressed text edges
  let redChannel = null;
  try {
    redChannel = await sharp(imgBuffer)
      .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
      .removeAlpha()
      .extractChannel('red')
      .normalize()
      .sharpen({ sigma: 1.5 })
      .threshold(60)
      .png()
      .toBuffer();
  } catch (err) {
    console.log(`[mediaModeration] Red channel variant failed: ${err.message}`);
  }

  // Variant 3: Grayscale WITHOUT threshold — preserves anti-aliased text edges
  // Tesseract handles grayscale images well; binary thresholding can destroy
  // fine text details especially on colored backgrounds with JPEG compression
  const softGray = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 2 })
    .png()
    .toBuffer();

  // Build variant list — 3 variants optimized for different sign types
  const variants = [
    { name: 'normal', buf: normal },
  ];
  if (redChannel) variants.push({ name: 'red-channel', buf: redChannel });
  variants.push({ name: 'soft-gray', buf: softGray });

  const allText = new Set();
  const startTime = Date.now();

  for (const { name, buf } of variants) {
    // Check total time budget
    const elapsed = Date.now() - startTime;
    const remaining = OCR_TOTAL_TIMEOUT_MS - elapsed;
    if (remaining <= 1000) {
      console.log(`[mediaModeration] OCR time budget exhausted after ${elapsed}ms, skipping remaining variants`);
      break;
    }

    try {
      const ocrPromise = worker.recognize(buf);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`OCR timeout (${name})`)), remaining)
      );
      const { data: { text } } = await Promise.race([ocrPromise, timeoutPromise]);
      if (text && text.trim().length > 0) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length >= 2) allText.add(trimmed);
        }
      }
    } catch (err) {
      console.log(`[mediaModeration] OCR variant '${name}' skipped: ${err.message}`);
    }
  }

  const merged = [...allText].join('\n');

  if (merged.length > 0) {
    console.log(`[mediaModeration] OCR extracted ${merged.split('\n').length} text lines (${merged.length} chars) in ${Date.now() - startTime}ms`);
    console.log(`[mediaModeration] OCR text preview: "${merged.slice(0, 200)}${merged.length > 200 ? '…' : ''}"`);
  }
  return merged;
}

/* ── CATEGORY CONSTANTS (used in reasons so the frontend can distinguish) ─── */
const CAT = {
  PHONE:    'Phone number',
  EMAIL:    'Email address',
  SOCIAL:   'Social media handle / username',
  LINK:     'Direct link / off-platform URL',
  INVITE:   'Invite code / messaging link',
  INTENT:   'Contact-intent phrase',
  PAYMENT:  'Payment / money-transfer info',
  CRYPTO:   'Cryptocurrency address / reference',
  BANK:     'Bank / financial account info',
  GIFT:     'Gift-card reference',
  QR:       'QR code reference',
  ADDRESS:  'Physical address',
};

/**
 * Comprehensive regex patterns for detecting contact / off-platform info.
 *
 * Each entry: { category, pattern, onCollapsed? }
 *   - category  → one of CAT.* (used in the rejection reason)
 *   - pattern   → RegExp (should use `g` and `i` where appropriate)
 *   - onCollapsed → if true, also test against the spacing-collapsed variant
 *
 * ⚠️  ORDER MATTERS — more-specific patterns MUST come before general ones
 *     so that "discord.gg/xxx" is flagged as INVITE, not SOCIAL;
 *     "account number: 12345678901" is flagged as BANK, not PHONE; etc.
 */
const CONTACT_PATTERNS = [

  /* ═══ A. MOST-SPECIFIC (URLs / codes / addresses) ═══════════════════════ */

  /* ────────── 1. INVITE / MESSAGING LINKS  (before social & links) ──────── */
  // Discord invite
  { category: CAT.INVITE, pattern: /discord(?:\.gg|\.com\/invite|app\.com\/invite)\s*[/:]?\s*[\w\-]+/gi },
  // Telegram link
  { category: CAT.INVITE, pattern: /t\.me\/[\w\-]+/gi },
  { category: CAT.INVITE, pattern: /telegram\.me\/[\w\-]+/gi },
  // WhatsApp link
  { category: CAT.INVITE, pattern: /wa\.me\/[\d+]+/gi },
  { category: CAT.INVITE, pattern: /chat\.whatsapp\.com\/[\w]+/gi },
  // Linktree
  { category: CAT.INVITE, pattern: /linktr\.ee\/[\w.\-]+/gi },
  // Signal group / number links
  { category: CAT.INVITE, pattern: /signal\.(?:me|group)\/[\w#\-]+/gi },

  /* ────────── 2. BANK / FINANCIAL DETAILS  (before phone — IBANs look like phone #s) */
  // IBAN (keyword-gated to avoid OCR noise matching random uppercase+digits)
  { category: CAT.BANK, pattern: /\biban\s*:?\s*[A-Z]{2}\d{2}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}(?:\s?[\dA-Z]{1,4}){0,5}\b/gi },
  // SWIFT / BIC
  { category: CAT.BANK, pattern: /\b(?:swift|bic)\s*(?:code)?\s*:?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi },
  // Routing + account number patterns (keyword-gated → won't false-positive on random digits)
  { category: CAT.BANK, pattern: /\b(?:routing|aba|transit)\s*(?:#|number|no\.?)?\s*:?\s*\d{9}\b/gi },
  { category: CAT.BANK, pattern: /\b(?:account|acct)\s*(?:#|number|no\.?)?\s*:?\s*\d{8,17}\b/gi },
  // Generic bank phrases
  { category: CAT.BANK, pattern: /\b(?:bank\s+(?:details|info|account|transfer)|wire\s+(?:transfer|me)|direct\s+deposit|routing\s+number|account\s+number)\b/gi },

  /* ────────── 3. CRYPTOCURRENCY  (before phone — long hex strings) ──────── */
  // Bitcoin addresses (1…, 3…, bc1…)
  { category: CAT.CRYPTO, pattern: /\b(?:1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,90})\b/g },
  // Ethereum addresses (0x…)
  { category: CAT.CRYPTO, pattern: /\b0x[a-fA-F0-9]{40}\b/g },
  // Crypto keywords + nearby wallet/address-like text
  { category: CAT.CRYPTO, pattern: /\b(?:btc|bitcoin|eth|ethereum|usdt|tether|usdc|crypto|wallet|blockchain|litecoin|ltc|doge|dogecoin|solana|sol|bnb|xrp|ada|cardano)\s*(?:address|wallet|:)?\s*[:=]?\s*[\w]{10,}/gi },
  // "send crypto / send BTC / my wallet"
  { category: CAT.CRYPTO, pattern: /\b(?:send|my|to)\s+(?:btc|bitcoin|eth|ethereum|crypto|usdt|usdc)\b/gi },
  { category: CAT.CRYPTO, pattern: /\bmy\s+(?:crypto\s+)?wallet\b/gi },

  /* ────────── 4. PAYMENT / MONEY TRANSFER  (before social — "Venmo @user") ─ */
  // App names (CashApp, Venmo, Zelle, PayPal, Apple Pay, Google Pay, Samsung Pay)
  { category: CAT.PAYMENT, pattern: /\b(?:cash\s*app|venmo|zelle|pay\s*pal|apple\s*pay|google\s*pay|samsung\s*pay|gpay)\b\s*[-:@$]?\s*[@$]?[\w@$.]{0,30}/gi },
  // Venmo / PayPal "send to @…"
  { category: CAT.PAYMENT, pattern: /(?:send|pay|transfer|wire)\s+(?:(?:money|payment)\s+)?(?:to|via|through|on)\s+(?:cash\s*app|venmo|zelle|pay\s*pal|apple\s*pay|google\s*pay)\b/gi },
  // "pay me" / "send deposit"
  { category: CAT.PAYMENT, pattern: /\b(?:pay\s+me|send\s+(?:me\s+)?(?:a\s+)?(?:deposit|payment|money))\b/gi },
  // CashApp $tag (including spaced: "$ n a m e")
  { category: CAT.PAYMENT, pattern: /\$\s*[a-zA-Z][a-zA-Z0-9_\s]{1,25}[a-zA-Z0-9]/gi },

  /* ────────── 5. GIFT CARDS ────────── */
  { category: CAT.GIFT, pattern: /\b(?:gift\s*card|e-?gift|prepaid\s*card)\b/gi },
  { category: CAT.GIFT, pattern: /\b(?:amazon|itunes|apple|google\s*play|steam|visa|mastercard|amex|american\s*express|target|walmart|nike|sephora|nordstrom|best\s*buy|ebay|starbucks)\s+(?:gift\s*)?card\b/gi },
  { category: CAT.GIFT, pattern: /\b(?:buy|send|get)\s+(?:me\s+)?(?:a\s+)?gift\s*card\b/gi },
  // Redemption code pattern
  { category: CAT.GIFT, pattern: /\b(?:redeem|redemption|promo|coupon)\s*(?:code)?\s*:?\s*[A-Z0-9\-]{8,25}\b/gi },

  /* ═══ B. GENERAL CONTACT INFO ═══════════════════════════════════════════ */

  /* ────────── 6. EMAIL ADDRESSES ────────── */
  // Standard
  { category: CAT.EMAIL, pattern: /[a-zA-Z0-9._%+\-]{2,}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  // Obfuscated: "name at domain dot com"
  { category: CAT.EMAIL, pattern: /[a-zA-Z0-9._%+\-]{2,}\s*(?:\bat\b|@)\s*[a-zA-Z0-9.\-]+\s*(?:\bdot\b|\.)\s*[a-zA-Z]{2,}/gi },
  // Extra-obfuscated: "(at)" / "[at]" / "{at}"
  { category: CAT.EMAIL, pattern: /[a-zA-Z0-9._%+\-]{2,}\s*[\[({]\s*at\s*[\])}]\s*[a-zA-Z0-9.\-]+\s*[\[({]\s*dot\s*[\])}]\s*[a-zA-Z]{2,}/gi },

  /* ────────── 7. SOCIAL MEDIA HANDLES / USERNAMES ────────── */
  // Platform name followed by a handle: "ig: @user", "snapchat user123", "tiktok - @user"
  // Only unambiguous platform names (removed: line, signal, fb, tele, threads, kik, viber, wechat)
  { category: CAT.SOCIAL, pattern: /\b(?:instagram|insta|ig|snapchat|tik\s*tok|telegram|whats?\s*app|discord|twitter|x\.com|facebook)\s*[-:@=|/\\]?\s*@?[\w.][\w.]{1,30}/gi },
  // "my IG is @…" / "add me on snapchat …"
  { category: CAT.SOCIAL, pattern: /(?:my|add\s+me\s+on|follow\s+(?:me\s+)?on|find\s+me\s+on|hit\s+me\s+(?:up\s+)?on|hmu\s+on)\s+\b(?:instagram|insta|ig|snapchat|tik\s*tok|telegram|whats?\s*app|discord|twitter|facebook)\s*[-:@=]?\s*@?[\w.]{1,30}/gi },
  // "@ insta is …" / "@ig …" (inverted handle pattern)
  { category: CAT.SOCIAL, pattern: /@\s*(?:instagram|insta|ig|snapchat|tik\s*tok|telegram|whats?\s*app|discord|twitter|facebook)\s+(?:is\s+)?@?[\w.]{1,30}/gi },

  /* ────────── 8. PHONE NUMBERS  (last among contact — most general) ──────── */
  // US: (123) 456-7890 / 123-456-7890 / 123.456.7890 / +1 …
  // Also runs on collapsed text to catch word-disguised numbers: "five five five..."
  { category: CAT.PHONE, pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, onCollapsed: true },
  // International: +44 20 7946 0958, +91-98765-43210, etc.
  { category: CAT.PHONE, pattern: /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g },
  // Common text-evasion: "call / text / reach (me at) 555…"
  { category: CAT.PHONE, pattern: /(?:call|text|reach|dial|ring|phone|cell|mobile|whatsapp|viber)\s*(?:me\s*)?(?:at|on|@|:)?\s*\+?\(?\d[\d\s()\-.]{6,}\d/gi },

  /* ════ C. CONTEXT / INTENT SIGNALS ═════════════════════════════════════ */

  /* ────────── 9. LINKS / URLs  (after social — bare domains are lower priority) */
  // Standard URLs
  { category: CAT.LINK, pattern: /https?:\/\/[^\s<>"']+/gi },
  { category: CAT.LINK, pattern: /www\.[^\s<>"']+/gi },
  // URL shorteners
  { category: CAT.LINK, pattern: /(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rb\.gy|cutt\.ly|shorturl\.at|tiny\.cc|surl\.li|s\.id)\b[^\s]*/gi },

  /* ────────── 10. "TEXT ME / CALL ME / DM ME" INTENT ────────── */
  // Requires "me"/"us" after verb — bare "text"/"call"/"message" alone is too common
  { category: CAT.INTENT, pattern: /\b(?:(?:text|call|ring|dial|dm|direct\s*message|inbox|pm|private\s*message|message|msg)\s+(?:me|us)|hit\s+(?:me\s+)?up|hmu|reach\s+(?:out\s+)?to\s+(?:me|us)|contact\s+(?:me|us)|get\s+(?:in\s+)?touch\s+with\s+(?:me|us)|slide\s+in(?:to)?\s+(?:my|the)\s+(?:dms?|inbox))\b/gi },
  // "for bookings text …" / "for inquiries call …"
  { category: CAT.INTENT, pattern: /\b(?:for\s+(?:bookings?|inquir(?:ies|y)|reservations?|appointments?|info|details?))\s+(?:text|call|dm|message|email|reach|contact)\b/gi },

  /* ────────── 11. QR CODE REFERENCES ────────── */
  { category: CAT.QR, pattern: /\bqr\s*code\b/gi },
  { category: CAT.QR, pattern: /\bscan\s+(?:this|the|my)\s+(?:code|qr)\b/gi },

  /* ────────── 12. PHYSICAL ADDRESSES ────────── */
  { category: CAT.ADDRESS, pattern: /\b\d{1,5}\s+[A-Za-z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|way|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|terr(?:ace)?|hwy|highway)\b/gi },
  // Apartment / unit / suite
  { category: CAT.ADDRESS, pattern: /\b(?:apt|apartment|unit|suite|ste|#)\s*\.?\s*\d{1,5}[a-zA-Z]?\b/gi },
  // Zip codes (5-digit or ZIP+4, keyword-gated to reduce false positives)
  { category: CAT.ADDRESS, pattern: /\b(?:zip|postal|zip\s*code)\s*:?\s*\d{5}(?:-\d{4})?\b/gi },
  // "send me your address" / "meet me at…" / "come to…"
  { category: CAT.ADDRESS, pattern: /\b(?:send\s+(?:me\s+)?(?:your|the)\s+address|meet\s+me\s+at|come\s+to\s+(?:my|the|our))\b/gi },

  /* ────────── 13. PERSONAL IDENTITY (DOB / SSN) ────────── */
  { category: 'Personal identity info', pattern: /\b(?:social\s+security|ssn|ss#)\s*:?\s*\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/gi },
  { category: 'Personal identity info', pattern: /\b(?:date\s+of\s+birth|dob|d\.o\.b)\s*:?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi },
  { category: 'Personal identity info', pattern: /\bssn\s*:?\s*\d{3}/gi },
];

/**
 * Check if OCR text looks like actual printed/written text vs noise/artifacts.
 * Regular photos produce garbage characters from textures, patterns, decorations,
 * and edges. This filters those out before running detection patterns.
 */
function isLikelyRealText(text) {
  if (!text || text.trim().length < 10) return false;

  // Count words that resemble real English (3+ consecutive letters)
  const realWords = text.match(/[a-zA-Z]{3,}/g) || [];

  // Need at least 3 real words to consider it genuine text
  // (patterns, textures, and edges often produce 1-2 spurious "words")
  if (realWords.length >= 3) return true;

  // Allow through if text has clearly structured contact data
  // (someone may photograph just a phone number or email)
  if (/\d{3}[-.\s)]+\d{3}[-.\s]+\d{4}/.test(text)) return true;
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return true;
  if (/https?:\/\/|www\./i.test(text)) return true;

  return false;
}

/**
 * Lighter quality gate for sign detection.
 * Street signs often have very short text ("Main St", "5th Ave", "One Way")
 * so we only need 1 real word of 3+ letters.
 */
function isLikelySignText(text) {
  if (!text || text.trim().length < 3) return false;
  const realWords = text.match(/[a-zA-Z]{3,}/g) || [];
  return realWords.length >= 1;
}

/**
 * Detect contact / off-platform information in OCR text.
 * Returns an array of user-facing reason strings, each prefixed with the
 * detected category so the frontend can show exactly what was found.
 */
function detectContactInfo(text) {
  if (!text || text.trim().length < 3) return [];

  const reasons = [];
  const seenCategories = new Set(); // at most one reason per category

  const normalized = normalizeNumberWords(text);

  // Collapse deliberate spacing: "5 5 5  1 2 3 4" → "5551234"
  const collapsed = normalized.replace(/(\d)\s+(?=\d)/g, '$1');

  // Also strip common OCR noise / separators people exploit
  const stripped = normalized
    .replace(/[|\\/_\-–—•·⋅⏐│┃▏▎▍▌▋▊▉█]+/g, ' ')
    .replace(/\s{2,}/g, ' ');

  for (const { category, pattern, onCollapsed } of CONTACT_PATTERNS) {
    if (seenCategories.has(category)) continue; // already flagged this category

    // Build ordered list of text variants to test
    const variants = [text, normalized, stripped];
    if (onCollapsed) variants.push(collapsed);

    for (const src of variants) {
      // Fresh regex each time (avoids lastIndex issues with /g)
      const re = new RegExp(pattern.source, pattern.flags);
      const match = src.match(re);
      if (match && match.length > 0) {
        const snippet = match[0].length > 40 ? match[0].slice(0, 37) + '…' : match[0];
        reasons.push(`${category} detected: "${snippet}". This type of content is not allowed in listing photos.`);
        seenCategories.add(category);
        break; // move to next pattern
      }
    }
  }

  return reasons;
}

/* ═══════════════════════════════════════════════════════════
 * 3b. SIGN / STOREFRONT / LOCATION TEXT DETECTION (OCR-based)
 *
 * Detects text that indicates the photo was taken of a storefront,
 * street sign, or other location-identifying signage.  This catches:
 *   - Business name patterns ("XYZ Catering", "ABC Events LLC")
 *   - Street / road signs ("Main St", "5th Avenue")
 *   - "OPEN" / hours-of-operation signs
 *   - Directional / wayfinding signs
 *   - Visible complete addresses on buildings
 *   - Landmark / monument plaques
 *
 * These are separate from contactInfo patterns (which catch phone #s,
 * emails, social handles, payment info, etc.).
 * ═══════════════════════════════════════════════════════════ */

const SIGN_PATTERNS = [
  // "OPEN" signs — must include context (bare "open" is too common at events)
  {
    category: 'Storefront sign',
    pattern: /\b(?:now\s+open|open\s+(?:24\s*(?:hrs?|hours?)|daily|7\s*days))\b/gi,
  },
  // Hours of operation (very specific — low false-positive rate)
  {
    category: 'Hours-of-operation sign',
    pattern: /\b(?:hours|open)\s*:\s*(?:mon|tue|wed|thu|fri|sat|sun|m|t|w|th|f|sa|su)[\s\S]{3,40}(?:am|pm|noon|midnight)\b/gi,
  },
  {
    category: 'Hours-of-operation sign',
    pattern: /\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\s*[-–—to]+\s*\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b/gi,
  },
  // Street signs / road name patterns
  // Named roads: "Main St", "Oak Avenue", "Sunset Blvd", etc.
  // \w{0,2} after suffix allows 1-2 trailing OCR garbage chars (e.g. "Avenuer")
  {
    category: 'Street sign',
    pattern: /\b[A-Z][a-zA-Z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|terr(?:ace)?|pike|trail|crossing|loop)\w{0,2}\b/gi,
  },
  // Numbered streets: "5th Ave", "42nd Street", "1st St", "3rd Rd"
  {
    category: 'Street sign',
    pattern: /\b\d{1,5}(?:st|nd|rd|th)\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|terr(?:ace)?|pike|trail|crossing|loop)\w{0,2}\b/gi,
  },
  // Directional prefix streets: "North Main St", "E 42nd St", "SW 8th Street"
  {
    category: 'Street sign',
    pattern: /\b(?:n(?:orth)?|s(?:outh)?|e(?:ast)?|w(?:est)?|ne|nw|se|sw)\.?\s+(?:\d{1,5}(?:st|nd|rd|th)?\s+)?[A-Za-z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|way|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|hwy|highway|terr(?:ace)?|pike|trail|crossing|loop)\w{0,2}\b/gi,
  },
  // "One Way", "Do Not Enter", "Stop", "Yield", "No Parking", "Speed Limit"
  {
    category: 'Street sign',
    pattern: /\b(?:one\s+way|do\s+not\s+enter|no\s+(?:parking|entry|trespassing|standing|u-?turn)|speed\s+limit\s+\d{1,3}|yield|dead\s+end|road\s+closed|detour|wrong\s+way|keep\s+(?:right|left)|merge|thru\s+traffic|no\s+outlet)\b/gi,
  },
  // Highway signs (very specific)
  {
    category: 'Highway / road sign',
    pattern: /\b(?:interstate|i-\d{1,3}|us-\d{1,4}|route\s+\d{1,4}|exit\s+\d{1,4}[a-zA-Z]?)\b/gi,
  },
];

/**
 * Clean OCR text for better sign/contact detection.
 * Removes common OCR noise characters while preserving meaningful text.
 */
function cleanOcrText(text) {
  return text
    .replace(/[|\\{}[\]<>~`^]+/g, ' ')   // Remove OCR pipe/bracket noise
    .replace(/[^\w\s@#$%.,:;!?'"-]/g, '') // Keep only common text chars
    .replace(/\s{2,}/g, ' ')              // Collapse multiple spaces
    .trim();
}

/**
 * Detect storefront signs, street signs, and location-identifying text.
 * Returns an array of reason strings (empty = no sign detected).
 */
function detectSignsAndStorefronts(text) {
  if (!text || text.trim().length < 3) return [];

  const reasons = [];
  const seenCategories = new Set();

  // Test against both raw and cleaned OCR text for better matching
  const cleaned = cleanOcrText(text);
  const textVariants = [text, cleaned];

  for (const { category, pattern } of SIGN_PATTERNS) {
    if (seenCategories.has(category)) continue;
    for (const src of textVariants) {
      const re = new RegExp(pattern.source, pattern.flags);
      const match = src.match(re);
      if (match && match.length > 0) {
        const snippet = match[0].length > 45 ? match[0].slice(0, 42) + '…' : match[0];
        reasons.push(
          `${category} detected: "${snippet}". Photos of storefronts, street signs, and location-identifying signage are not allowed.`
        );
        seenCategories.add(category);
        break; // next pattern
      }
    }
  }

  return reasons;
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

    /* ── 3. OCR analysis (photos + video frames) ───────────── */
    const allImages = isVideo ? framePaths : [buffer];

    for (let i = 0; i < allImages.length; i++) {
      try {
        const ocrText = await ocrImage(allImages[i]);
        if (ocrText.trim().length > 0) {
          // Sign detection uses a lighter quality gate (1+ real words)
          // because street signs have short text like "Main St"
          if (isLikelySignText(ocrText)) {
            const signReasons = detectSignsAndStorefronts(ocrText);
            if (signReasons.length > 0) {
              console.log(`[mediaModeration] Sign text in ${isVideo ? `frame ${i + 1}` : 'image'}:`, signReasons);
              reasons.push(...signReasons);
            }
          }

          // Contact detection uses the stricter quality gate (3+ real words)
          // to avoid false positives from OCR noise
          if (isLikelyRealText(ocrText)) {
            const contactReasons = detectContactInfo(ocrText);
            if (contactReasons.length > 0) {
              console.log(`[mediaModeration] Contact info in ${isVideo ? `frame ${i + 1}` : 'image'}:`, contactReasons);
              reasons.push(...contactReasons);
            }
          }
        }
      } catch (err) {
        console.error(`[mediaModeration] OCR error on ${isVideo ? `frame ${i + 1}` : 'image'}:`, err.message);
      }
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
 * TEXT FIELD MODERATION
 *
 * Runs the same contact/payment/identity detection patterns on raw text
 * fields (listing title, description, booking messages, reviews, etc.)
 * No OCR needed — just regex against the user-typed text.
 *
 * @param  {string}  text — the text to moderate
 * @returns {{ approved: boolean, reasons: string[] }}
 * ═══════════════════════════════════════════════════════════ */
function moderateText(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return { approved: true, reasons: [] };
  }

  // For direct text moderation (not OCR), skip the quality gate —
  // this IS real user-typed text, not noisy OCR output.
  const contactReasons = detectContactInfo(text);
  const signReasons = detectSignsAndStorefronts(text);
  const allReasons = [...contactReasons, ...signReasons];
  const uniqueReasons = [...new Set(allReasons)];

  return {
    approved: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

/* ═══════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════ */
module.exports = {
  moderateMedia,
  moderateText,
  inspectMetadata,
  getVideoDuration,
  muteVideo,
  extractFrames,
  ocrImage,
  detectContactInfo,
  detectSignsAndStorefronts,
};
