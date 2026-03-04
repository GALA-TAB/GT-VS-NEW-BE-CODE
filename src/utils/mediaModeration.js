/**
 * mediaModeration.js — Secure media upload moderation pipeline
 *
 * Validates and analyses uploaded images/videos before allowing publication.
 *
 * Pipeline:
 *   1. Metadata inspection (GPS / geolocation stripping)
 *   2. Video: duration check (≤30s), audio removal, frame extraction
 *   3. OCR on every frame/photo → contact-info + sign/storefront detection
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
  const words = Object.keys(WORD_TO_DIGIT).join('|');
  const re = new RegExp(`\\b(${words})\\b`, 'gi');
  return text.replace(re, (m) => WORD_TO_DIGIT[m.toLowerCase()] || m);
}

/**
 * Run OCR on an image buffer with preprocessing for better accuracy.
 *
 * Tesseract performs poorly on raw photographs. We preprocess with sharp:
 *   1. Upscale small images (Tesseract needs ~300 DPI equivalent)
 *   2. Grayscale conversion (removes colour noise)
 *   3. Normalize contrast (stretch histogram to full 0-255)
 *   4. Sharpen (helps with phone-camera blur)
 *   5. Threshold to high-contrast black/white (isolates text from backgrounds)
 *
 * We run OCR on MULTIPLE preprocessed variants because different thresholds /
 * inversions pick up text on different background colours (white text on dark
 * vs dark text on light). Results are merged.
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

  // Upscale factor — aim for at least 1500px on shortest side (Tesseract sweet spot)
  const scale = minDim > 0 && minDim < 1500 ? Math.ceil(1500 / minDim) : 1;
  const targetW = Math.min((metadata.width || 1500) * scale, 4000);
  const targetH = Math.min((metadata.height || 1500) * scale, 4000);

  // ── Variant A: standard (dark text on light background) ──
  const variantA = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()            // stretch contrast to full 0-255
    .sharpen({ sigma: 1.5 })
    .threshold(140)         // binarize: dark text → black, light bg → white
    .png()
    .toBuffer();

  // ── Variant B: inverted (light text on dark background) ──
  const variantB = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .negate()               // invert before threshold → catches white/bright text on dark bg
    .threshold(140)
    .png()
    .toBuffer();

  // ── Variant C: softer threshold (catches medium-contrast text) ──
  const variantC = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 2.0 })
    .threshold(100)         // lower threshold → more permissive
    .png()
    .toBuffer();

  // Run OCR on all variants and merge unique text
  const allText = new Set();
  for (const variant of [variantA, variantB, variantC]) {
    try {
      const { data: { text } } = await worker.recognize(variant);
      if (text && text.trim().length > 0) {
        // Split into lines, trim each, keep non-empty
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length >= 2) allText.add(trimmed);
        }
      }
    } catch (err) {
      console.error('[mediaModeration] OCR variant error:', err.message);
    }
  }

  const merged = [...allText].join('\n');
  if (merged.length > 0) {
    console.log(`[mediaModeration] OCR extracted ${allText.size} text lines (${merged.length} chars)`);
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
  // IBAN (2-letter country + 2 check digits + up to 30 alphanumeric)
  { category: CAT.BANK, pattern: /\b[A-Z]{2}\d{2}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}(?:\s?[\dA-Z]{1,4}){0,5}\b/g },
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
  // CashApp $cashtag
  { category: CAT.PAYMENT, pattern: /\$[a-zA-Z][\w]{1,20}\b/g },
  // Venmo / PayPal "send to @…"
  { category: CAT.PAYMENT, pattern: /(?:send|pay|transfer|wire)\s+(?:(?:money|payment)\s+)?(?:to|via|through|on)\s+(?:cash\s*app|venmo|zelle|pay\s*pal|apple\s*pay|google\s*pay)\b/gi },
  // "pay me" / "send deposit"
  { category: CAT.PAYMENT, pattern: /\b(?:pay\s+me|send\s+(?:me\s+)?(?:a\s+)?(?:deposit|payment|money))\b/gi },

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
  // Platform name followed by a handle: "ig: @user", "snap user123", "tiktok - @user"
  { category: CAT.SOCIAL, pattern: /(?:instagram|insta|ig|snap(?:chat)?|tik\s*tok|telegram|tele|whats?\s*app|discord|twitter|x\.com|facebook|fb|linked\s*in|threads|signal|wechat|line|kik|viber)\s*[-:@=|/\\]?\s*@?[\w.][\w.]{1,30}/gi },
  // "my IG is @…" / "add me on snap …"
  { category: CAT.SOCIAL, pattern: /(?:my|add\s+me\s+on|follow\s+(?:me\s+)?on|find\s+me\s+on|hit\s+me\s+(?:up\s+)?on|hmu\s+on)\s+(?:instagram|insta|ig|snap(?:chat)?|tik\s*tok|telegram|whats?\s*app|discord|twitter|x|facebook|fb|threads|signal|kik)\s*[-:@=]?\s*@?[\w.]{1,30}/gi },
  // Bare @handle (3+ chars, not an email)
  { category: CAT.SOCIAL, pattern: /(?<![a-zA-Z0-9._%+\-])@[a-zA-Z][\w.]{2,29}(?!@|\.[a-zA-Z]{2,4}\b)/g },

  /* ────────── 8. PHONE NUMBERS  (last among contact — most general) ──────── */
  // US: (123) 456-7890 / 123-456-7890 / 123.456.7890 / +1 …
  { category: CAT.PHONE, pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // International: +44 20 7946 0958, +91-98765-43210, etc.
  { category: CAT.PHONE, pattern: /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g },
  // 10+ consecutive digits (catches spaced / dashed numbers after collapsing)
  { category: CAT.PHONE, pattern: /\d{10,}/g, onCollapsed: true },
  // Common text-evasion: "call / text / reach (me at) 555…"
  { category: CAT.PHONE, pattern: /(?:call|text|reach|dial|ring|phone|cell|mobile|whatsapp|viber)\s*(?:me\s*)?(?:at|on|@|:)?\s*\+?\(?\d[\d\s()\-.]{6,}\d/gi },

  /* ════ C. CONTEXT / INTENT SIGNALS ═════════════════════════════════════ */

  /* ────────── 9. LINKS / URLs  (after social — bare domains are lower priority) */
  // Standard URLs
  { category: CAT.LINK, pattern: /https?:\/\/[^\s<>"']+/gi },
  { category: CAT.LINK, pattern: /www\.[^\s<>"']+/gi },
  // Bare domain with common TLDs
  { category: CAT.LINK, pattern: /[a-zA-Z0-9][\w\-]*\.(?:com|net|org|io|co|me|app|dev|xyz|info|biz|us|uk|ca|au|de|fr|es|it|nl|ru|in|site|online|store|shop|link|page|bio|club|vip|pro|gg|tv|ly|gl|be)\b(?:\/[^\s<>"']*)?/gi },
  // URL shorteners
  { category: CAT.LINK, pattern: /(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rb\.gy|cutt\.ly|shorturl\.at|tiny\.cc|surl\.li|s\.id)\b[^\s]*/gi },

  /* ────────── 10. "TEXT ME / CALL ME / DM ME" INTENT ────────── */
  { category: CAT.INTENT, pattern: /\b(?:text|call|ring|dial|dms?|direct\s*message|inbox|pm|private\s*message|message|msg|hit\s*(?:me\s*)?up|hmu|reach\s*(?:out)?|contact|get\s*(?:in\s*)?touch|slide\s*(?:in(?:to)?)?(?:\s*(?:my|the))?\s*(?:dms?|inbox))\s*(?:me|us)?\b/gi },
  // "for bookings text …" / "for inquiries call …"
  { category: CAT.INTENT, pattern: /\b(?:for\s+(?:bookings?|inquir(?:ies|y)|reservations?|appointments?|info|details?))\s+(?:text|call|dm|message|email|reach|contact)\b/gi },

  /* ────────── 11. QR CODE REFERENCES ────────── */
  { category: CAT.QR, pattern: /\bqr\s*code\b/gi },
  { category: CAT.QR, pattern: /\bscan\s+(?:this|the|my)\s+(?:code|qr)\b/gi },

  /* ────────── 12. PHYSICAL ADDRESSES ────────── */
  { category: CAT.ADDRESS, pattern: /\b\d{1,5}\s+[A-Za-z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|way|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|terr(?:ace)?|hwy|highway)\b/gi },
];

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
  // Business type suffixes on signs: "XYZ Restaurant", "ABC Lounge LLC"
  {
    category: 'Storefront / business sign',
    pattern: /\b[\w\s&']{2,30}\s+(?:restaurant|café|cafe|bar|lounge|grill|bistro|diner|bakery|pizzeria|deli|pub|tavern|brewery|salon|spa|barbershop|laundry|cleaners|pharmacy|clinic|dental|hospital|hotel|motel|inn|suites|resort|bank|credit\s*union|realty|insurance|law\s*(?:firm|office)|attorney|accountant|tax|auto\s*(?:body|repair|shop|parts)|garage|tire|gas\s*station|hardware|lumber|florist|jewel(?:ry|ers?)|pawn|thrift|liquor|smoke\s*shop|vape|tattoo|nail|beauty\s*supply)\b/gi,
  },
  {
    category: 'Storefront / business sign',
    pattern: /\b[\w\s&']{2,30}\s+(?:LLC|Inc\.?|Corp\.?|Ltd\.?|Co\.?|Company|Enterprises?|Group|Associates?|Partners?|Services?|Solutions?|Studio|Boutique|Emporium|Depot|Outlet|Market|Plaza|Center|Centre)\b/gi,
  },
  // "OPEN" signs (large text on storefronts)
  {
    category: 'Storefront sign',
    pattern: /\b(?:now\s+)?open(?:\s+(?:24\s*(?:hrs?|hours?)|daily|7\s*days|mon|tue|wed|thu|fri|sat|sun))?\b/gi,
  },
  // Hours of operation
  {
    category: 'Hours-of-operation sign',
    pattern: /\b(?:hours|open)\s*:\s*(?:mon|tue|wed|thu|fri|sat|sun|m|t|w|th|f|sa|su)[\s\S]{3,40}(?:am|pm|noon|midnight)\b/gi,
  },
  {
    category: 'Hours-of-operation sign',
    pattern: /\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\s*[-–—to]+\s*\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b/gi,
  },
  // Street signs / road name patterns
  {
    category: 'Street sign',
    pattern: /\b(?:north|south|east|west|n\.?|s\.?|e\.?|w\.?)\s+\d{0,5}(?:st|nd|rd|th)?\s*(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|way|pl(?:ace)?|cir(?:cle)?|pkwy|parkway|hwy|highway|terr(?:ace)?|pike|trail|crossing|loop)\b/gi,
  },
  // "Exit" / highway signs
  {
    category: 'Highway / road sign',
    pattern: /\b(?:exit|interstate|i-|us-|route|sr-|hwy)\s*\d{1,4}\b/gi,
  },
  // Directional / wayfinding signs
  {
    category: 'Directional sign',
    pattern: /\b(?:entrance|exit|parking|restroom|elevator|stairs|lobby|←|→|↑|↓)\b/gi,
  },
  // Landmark / monument plaques
  {
    category: 'Landmark plaque / monument',
    pattern: /\b(?:national\s+(?:monument|park|historic)|historic\s+(?:site|landmark|district)|est(?:ablished)?\.?\s*\d{4}|founded\s+(?:in\s+)?\d{4}|registered\s+landmark|heritage\s+site|memorial)\b/gi,
  },
];

/**
 * Detect storefront signs, street signs, and location-identifying text.
 * Returns an array of reason strings (empty = no sign detected).
 */
function detectSignsAndStorefronts(text) {
  if (!text || text.trim().length < 3) return [];

  const reasons = [];
  const seenCategories = new Set();

  for (const { category, pattern } of SIGN_PATTERNS) {
    if (seenCategories.has(category)) continue;
    const re = new RegExp(pattern.source, pattern.flags);
    const match = text.match(re);
    if (match && match.length > 0) {
      const snippet = match[0].length > 45 ? match[0].slice(0, 42) + '…' : match[0];
      reasons.push(
        `${category} detected: "${snippet}". Photos of storefronts, street signs, and location-identifying signage are not allowed.`
      );
      seenCategories.add(category);
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

    /* ── 3. Analyze each frame/photo ─────────────────────── */
    const allImages = isVideo ? framePaths : [buffer];

    for (let i = 0; i < allImages.length; i++) {
      const imgSource = allImages[i];

      // 3. OCR — detect contact info + storefront/sign text (runs on every frame)
      try {
        const ocrText = await ocrImage(imgSource);
        if (ocrText.trim().length > 0) {
          // Check for contact / off-platform info
          const contactReasons = detectContactInfo(ocrText);
          if (contactReasons.length > 0) {
            console.log(`[mediaModeration] Contact info detected in ${isVideo ? `frame ${i + 1}` : 'image'}:`, contactReasons);
            reasons.push(...contactReasons);
          }

          // Check for storefront signs, street signs, location text
          const signReasons = detectSignsAndStorefronts(ocrText);
          if (signReasons.length > 0) {
            console.log(`[mediaModeration] Sign/storefront text detected in ${isVideo ? `frame ${i + 1}` : 'image'}:`, signReasons);
            reasons.push(...signReasons);
          }

          if (contactReasons.length === 0 && signReasons.length === 0) {
            console.log(`[mediaModeration] OCR found text but no violations in ${isVideo ? `frame ${i + 1}` : 'image'}`);
          }
        } else {
          console.log(`[mediaModeration] No text detected via OCR in ${isVideo ? `frame ${i + 1}` : 'image'}`);
        }
      } catch (err) {
        console.error(`[mediaModeration] OCR error on ${isVideo ? `frame ${i + 1}` : 'image'}:`, err.message);
        // Non-critical — continue (OCR failure shouldn't block uploads entirely)
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
  detectSignsAndStorefronts,
};
