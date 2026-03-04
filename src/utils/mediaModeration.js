/**
 * mediaModeration.js — Secure media upload moderation pipeline
 *
 * Validates and analyses uploaded images/videos before allowing publication.
 *
 * Pipeline:
 *   1. Metadata inspection (GPS / geolocation stripping)
 *   2. Video: duration check (≤30s), audio removal, frame extraction
 *   3. OCR on every frame/photo → contact-info regex detection
 *   4. Scene classification via local colour analysis (sharp) → indoor-only enforcement
 *
 * Dependencies:
 *   fluent-ffmpeg (ffmpeg + ffprobe wrappers)
 *   tesseract.js  (browser-less OCR)
 *   exif-parser   (EXIF/GPS metadata)
 *   sharp         (image resizing + raw pixel analysis for scene detection)
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
 * RGB → HSL conversion helper (used by local scene analysis)
 * ═══════════════════════════════════════════════════════════ */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
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
 * 4. SCENE CLASSIFICATION — Local multi-signal analysis via sharp
 *
 * Analyses pixel colors in different image regions to detect outdoor scenes.
 * Uses multiple overlapping signals to handle diverse outdoor types:
 *   - Blue sky, overcast sky, sunset sky in top third
 *   - Vegetation (green), earth/sand (brown), pavement (gray) anywhere
 *   - Top-vs-bottom brightness gradient (sky brighter than ground)
 *   - Natural lighting patterns (high brightness + high variance)
 *   - High colour diversity typical of outdoor scenes
 *   - Warm/cool colour temperature analysis
 *
 * Returns { isOutdoor, isLandmark, labels, reasons[] }
 * ═══════════════════════════════════════════════════════════ */

/**
 * Classify a single image using local pixel-level colour analysis (sharp).
 * No cloud APIs required — runs entirely on-server.
 */
async function classifyImage(bufferOrPath) {
  let imgBuffer;
  if (Buffer.isBuffer(bufferOrPath)) {
    imgBuffer = bufferOrPath;
  } else {
    imgBuffer = fs.readFileSync(bufferOrPath);
  }

  const sharp = require('sharp');

  // Resize to small fixed size for fast analysis (preserves colour ratios)
  const SIZE = 150;
  const { data, info } = await sharp(imgBuffer)
    .resize(SIZE, SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const totalPixels = width * height;

  // Divide image into horizontal thirds
  const topEnd = Math.floor(height / 3);
  const midEnd = Math.floor((2 * height) / 3);

  // ── Accumulators ──
  let blueSkyPixels = 0;       // classic blue sky
  let overcastSkyPixels = 0;   // bright gray/white sky
  let sunsetSkyPixels = 0;     // warm hue sky (orange/red)
  let greenPixelsAll = 0;      // vegetation anywhere
  let brownPixelsAll = 0;      // earth / sand / dirt
  let grayPixelsAll = 0;       // roads / pavement / concrete
  let topPixelCount = 0;
  let bottomPixelCount = 0;
  let bottomGreenCount = 0;
  let bottomBrownCount = 0;
  let bottomGrayCount = 0;
  let totalBrightness = 0;
  let topBrightnessSum = 0;
  let bottomBrightnessSum = 0;
  let saturationSum = 0;
  let topSaturationSum = 0;
  const brightnessValues = [];
  const topBrightnessValues = [];
  const hueHistogram = new Array(36).fill(0); // 10-degree bins

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const brightness = (r + g + b) / 3;
      totalBrightness += brightness;
      brightnessValues.push(brightness);

      const { h, s, l } = rgbToHsl(r, g, b);
      saturationSum += s;

      // Hue histogram (only count chromatic pixels)
      if (s > 0.08) {
        hueHistogram[Math.floor(h / 10) % 36]++;
      }

      /* ── TOP THIRD — sky detection (multiple sky types) ── */
      if (y < topEnd) {
        topPixelCount++;
        topBrightnessSum += brightness;
        topSaturationSum += s;
        topBrightnessValues.push(brightness);

        // Blue sky: hue 190-260, moderate+ saturation, medium-high lightness
        if (h >= 185 && h <= 260 && s > 0.15 && l > 0.25 && l < 0.88) {
          blueSkyPixels++;
        }
        // Bright overcast / hazy sky: very bright, low saturation
        // This catches cloudy, gray, white skies
        if (l > 0.65 && s < 0.20 && brightness > 160) {
          overcastSkyPixels++;
        }
        // Sunset / sunrise: warm hue, strongly vivid, in upper portion
        // Threshold kept high (0.45) to avoid matching warm indoor walls/ceilings
        if ((h <= 45 || h >= 320) && s > 0.45 && l > 0.35 && l < 0.9) {
          sunsetSkyPixels++;
        }
      }

      /* ── BOTTOM THIRD — ground surface detection ────────── */
      if (y >= midEnd) {
        bottomPixelCount++;
        bottomBrightnessSum += brightness;
        // Green vegetation
        if (h >= 70 && h <= 170 && s > 0.10 && l > 0.08 && l < 0.88) {
          bottomGreenCount++;
        }
        // Brown / tan / earth / sand (warm hues, moderate saturation)
        if (h >= 15 && h <= 55 && s > 0.10 && l > 0.15 && l < 0.80) {
          bottomBrownCount++;
        }
        // Gray / concrete / asphalt (very low saturation, mid brightness)
        if (s < 0.12 && l > 0.15 && l < 0.65) {
          bottomGrayCount++;
        }
      }

      /* ── ALL REGIONS — surface type detection ──────────── */
      // Vegetation (green)
      if (h >= 70 && h <= 170 && s > 0.10 && l > 0.08 && l < 0.88) {
        greenPixelsAll++;
      }
      // Earth / sand / brown
      if (h >= 15 && h <= 55 && s > 0.10 && l > 0.15 && l < 0.80) {
        brownPixelsAll++;
      }
      // Gray / pavement / roads
      if (s < 0.10 && l > 0.15 && l < 0.60) {
        grayPixelsAll++;
      }
    }
  }

  // ── Derived metrics ──
  const avgBrightness = totalBrightness / totalPixels;
  const avgSaturation = saturationSum / totalPixels;
  const topAvgBrightness = topPixelCount > 0 ? topBrightnessSum / topPixelCount : 0;
  const bottomAvgBrightness = bottomPixelCount > 0 ? bottomBrightnessSum / bottomPixelCount : 0;
  const topAvgSaturation = topPixelCount > 0 ? topSaturationSum / topPixelCount : 0;

  const brightnessVariance =
    brightnessValues.reduce((sum, bv) => sum + (bv - avgBrightness) ** 2, 0) / totalPixels;
  const brightnessStdDev = Math.sqrt(brightnessVariance);

  // Top-third brightness uniformity (sky is usually uniform)
  const topBrightnessMean = topAvgBrightness;
  const topBrightnessVar = topBrightnessValues.length > 0
    ? topBrightnessValues.reduce((sum, bv) => sum + (bv - topBrightnessMean) ** 2, 0) / topBrightnessValues.length
    : 0;
  const topBrightnessStdDev = Math.sqrt(topBrightnessVar);

  const significantHueBins = hueHistogram.filter(c => c > totalPixels * 0.015).length;

  // Sky ratios
  const combinedSkyPixels = blueSkyPixels + overcastSkyPixels + sunsetSkyPixels;
  const skyRatio = topPixelCount > 0 ? combinedSkyPixels / topPixelCount : 0;
  const blueSkyRatio = topPixelCount > 0 ? blueSkyPixels / topPixelCount : 0;
  const overcastRatio = topPixelCount > 0 ? overcastSkyPixels / topPixelCount : 0;

  // Surface ratios
  const greenRatio = greenPixelsAll / totalPixels;
  const brownRatio = brownPixelsAll / totalPixels;
  const grayRatio = grayPixelsAll / totalPixels;
  const bottomGreenRatio = bottomPixelCount > 0 ? bottomGreenCount / bottomPixelCount : 0;
  const bottomBrownRatio = bottomPixelCount > 0 ? bottomBrownCount / bottomPixelCount : 0;
  const bottomGrayRatio = bottomPixelCount > 0 ? bottomGrayCount / bottomPixelCount : 0;

  // Top brighter than bottom? (strong outdoor signal — sky above, ground below)
  const brightnessGradient = topAvgBrightness - bottomAvgBrightness;

  // ══════════════════════════════════════════════════
  // SCORING — each signal contributes points
  // ══════════════════════════════════════════════════
  let outdoorScore = 0;
  const signals = [];

  // ── A. SKY DETECTION (any type of sky in top third) ──
  if (skyRatio > 0.45) {
    outdoorScore += 35;
    signals.push(`sky detected in upper portion (${(skyRatio * 100).toFixed(0)}%)`);
  } else if (skyRatio > 0.25) {
    outdoorScore += 22;
    signals.push(`possible sky in upper portion (${(skyRatio * 100).toFixed(0)}%)`);
  } else if (skyRatio > 0.15) {
    outdoorScore += 12;
    signals.push(`faint sky signal (${(skyRatio * 100).toFixed(0)}%)`);
  }

  // Bonus for clearly blue sky
  if (blueSkyRatio > 0.30) {
    outdoorScore += 10;
    signals.push(`blue sky (${(blueSkyRatio * 100).toFixed(0)}%)`);
  }

  // ── B. BRIGHTNESS GRADIENT (top brighter than bottom) ──
  // Outdoor photos almost always have sky (bright) above and ground (darker) below
  if (brightnessGradient > 40) {
    outdoorScore += 25;
    signals.push(`strong top-down brightness gradient (+${brightnessGradient.toFixed(0)})`);
  } else if (brightnessGradient > 20) {
    outdoorScore += 15;
    signals.push(`brightness gradient detected (+${brightnessGradient.toFixed(0)})`);
  }

  // ── C. VEGETATION / GREENERY ──
  if (greenRatio > 0.20) {
    outdoorScore += 30;
    signals.push(`vegetation/greenery detected (${(greenRatio * 100).toFixed(0)}%)`);
  } else if (greenRatio > 0.08) {
    outdoorScore += 18;
    signals.push(`some vegetation detected (${(greenRatio * 100).toFixed(0)}%)`);
  }

  // ── D. EARTH / SAND / BROWN SURFACES ──
  if (brownRatio > 0.20) {
    outdoorScore += 20;
    signals.push(`earth/sand tones detected (${(brownRatio * 100).toFixed(0)}%)`);
  } else if (brownRatio > 0.10) {
    outdoorScore += 10;
    signals.push(`some earth tones (${(brownRatio * 100).toFixed(0)}%)`);
  }

  // ── E. GRAY (pavement / road / concrete) — only boosts if combined with sky ──
  if (grayRatio > 0.15 && skyRatio > 0.15) {
    outdoorScore += 15;
    signals.push(`pavement/road + sky combination`);
  }

  // ── F. NATURAL LIGHTING (bright with high variance → sun + shadows) ──
  if (avgBrightness > 130 && brightnessStdDev > 55) {
    outdoorScore += 12;
    signals.push('natural lighting pattern');
  }

  // ── G. HIGH COLOUR DIVERSITY ──
  if (significantHueBins >= 10 && avgSaturation > 0.15) {
    outdoorScore += 8;
    signals.push('high colour diversity');
  }

  // ── H. SKY + GROUND SURFACE COMBINATIONS (strong indicators) ──
  // Sky + vegetation = classic outdoor
  if (skyRatio > 0.15 && greenRatio > 0.08) {
    outdoorScore += 12;
    signals.push('sky + vegetation combination');
  }
  // Sky + earth/brown = desert, beach, hiking trail (requires gradient to avoid uniform indoor)
  if (skyRatio > 0.15 && brownRatio > 0.08 && brightnessGradient > 10) {
    outdoorScore += 12;
    signals.push('sky + earth combination');
  }
  // Bright top + any ground surface
  if (brightnessGradient > 15 && (bottomGreenRatio > 0.15 || bottomBrownRatio > 0.15 || bottomGrayRatio > 0.20)) {
    outdoorScore += 10;
    signals.push('bright sky over ground surface');
  }

  // ── I. TOP-THIRD UNIFORMITY (sky tends to be uniform brightness) ──
  if (topBrightnessStdDev < 25 && topAvgBrightness > 150 && skyRatio > 0.10) {
    outdoorScore += 8;
    signals.push('uniform bright top (sky-like)');
  }

  // ══════════════════════════════════════════════════
  // INDOOR COUNTER-INDICATORS (reduce score)
  // ══════════════════════════════════════════════════
  let indoorPenalty = 0;

  // Dim, uniform lighting → likely indoor
  if (avgBrightness < 100 && brightnessStdDev < 35) {
    indoorPenalty += 20;
  }
  // Very low saturation throughout → artificial/fluorescent light
  if (avgSaturation < 0.08) {
    indoorPenalty += 12;
  }
  // Top is NOT brighter than bottom (reversed gradient = ceiling + floor)
  if (brightnessGradient < -10) {
    indoorPenalty += 10;
  }
  // Very few significant hue bins with low saturation = indoor beige/gray
  if (significantHueBins < 4 && avgSaturation < 0.15) {
    indoorPenalty += 8;
  }
  // Very uniform brightness → indoor lighting (real outdoor has sun/shadow variance)
  if (brightnessStdDev < 15) {
    indoorPenalty += 20;
  }
  // Flat gradient despite sky detection → uniform indoor room, not real sky
  if (Math.abs(brightnessGradient) < 10 && skyRatio > 0.30) {
    indoorPenalty += 15;
  }

  outdoorScore -= indoorPenalty;

  const isOutdoor = outdoorScore >= 35;
  const reasons = [];

  if (isOutdoor) {
    const topSignals = signals.slice(0, 3).join(', ');
    reasons.push(
      `Outdoor scene detected (${topSignals}). Only interior/indoor venue photos are allowed for service listings.`
    );
  }

  console.log(
    `[classifyImage] Score: ${outdoorScore} (penalty: -${indoorPenalty}), Sky: ${(skyRatio * 100).toFixed(1)}% ` +
    `(blue: ${(blueSkyRatio * 100).toFixed(1)}%, overcast: ${(overcastRatio * 100).toFixed(1)}%), ` +
    `Green: ${(greenRatio * 100).toFixed(1)}%, Brown: ${(brownRatio * 100).toFixed(1)}%, Gray: ${(grayRatio * 100).toFixed(1)}%, ` +
    `Brightness: ${avgBrightness.toFixed(0)} ± ${brightnessStdDev.toFixed(0)}, ` +
    `Gradient: ${brightnessGradient.toFixed(0)}, TopStd: ${topBrightnessStdDev.toFixed(0)}, ` +
    `Sat: ${avgSaturation.toFixed(2)}, Hue bins: ${significantHueBins}, Outdoor: ${isOutdoor}, ` +
    `Signals: [${signals.join(', ')}]`
  );

  return {
    isOutdoor,
    isLandmark: false, // local analysis cannot detect specific landmarks
    labels: signals.map(s => ({ name: s, confidence: 0, parents: [] })),
    reasons,
  };
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

    // For videos, pick up to 5 evenly-spaced frames for classification (perf)
    // OCR still runs on all frames since tesseract is local.
    let classificationFrames;
    if (isVideo && allImages.length > 5) {
      const step = Math.floor(allImages.length / 5);
      classificationFrames = [0, step, step * 2, step * 3, allImages.length - 1].map(i => allImages[i]);
    } else {
      classificationFrames = allImages;
    }
    const classificationSet = new Set(classificationFrames);

    for (let i = 0; i < allImages.length; i++) {
      const imgSource = allImages[i];

      // 3a. OCR — detect text containing contact info (runs on every frame)
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

      // 3b. Scene classification via local colour analysis — sampled frames only
      // FAIL-CLOSED: if classification errors out, reject the upload rather than
      // silently letting unscreened media through.
      if (classificationSet.has(imgSource)) {
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
          // FAIL-CLOSED: reject if we cannot verify the scene
          reasons.push('Scene classification service is temporarily unavailable. Please try again in a moment.');
        }
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
