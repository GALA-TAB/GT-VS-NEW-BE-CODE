/**
 * mediaModeration.js — Secure media upload moderation pipeline
 *
 * Validates and analyses uploaded images/videos before allowing publication.
 *
 * Pipeline:
 *   1. Video: duration check (≤30s), audio removal, frame extraction
 *   2. OCR on every frame/photo → contact-info + street sign detection
 *      (Single fast variant with 15s timeout)
 *
 * Detects ONLY:
 *   - Phone numbers, emails, social handles, links/invite codes
 *   - Usernames, intent phrases (call me, text me, etc.)
 *   - Payment/money info, crypto, bank details, gift cards
 *   - Physical addresses, personal identity (DOB/SSN)
 *   - Obfuscation patterns (spaced-out digits, etc.)
 *   - Street name signs (St, Ave, Rd, Blvd, Dr, Ln, Ct, Pl, Way, Ter)
 *
 * Does NOT reject for: GPS metadata, sign colors, storefronts,
 * traffic signs, highway signs, STOP signs, or warning signs.
 *
 * Dependencies:
 *   fluent-ffmpeg (ffmpeg + ffprobe wrappers)
 *   tesseract.js  (browser-less OCR)
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
 * 1. METADATA INSPECTION (kept for export compat — no longer rejects)
 * ═══════════════════════════════════════════════════════════ */
function inspectMetadata(/* buffer */) {
  // GPS metadata is no longer a rejection reason.
  // Photos/videos with location data are allowed.
  return [];
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

async function ocrImage(bufferOrPath, { allVariants = false } = {}) {
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
  // This is the ONLY variant used for photos to avoid false positives.
  const normal = await sharp(imgBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .threshold(128)
    .png()
    .toBuffer();

  // Build variant list — for photos we only use the standard variant
  // Extra variants produce too much OCR noise on regular photos
  const variants = [
    { name: 'normal', buf: normal },
  ];

  // Additional variants ONLY for video frames (allVariants=true)
  // Video frames are pre-selected and have less noise than random photos
  if (allVariants) {
    // Red channel — best for GREEN/BLUE sign text
    try {
      const redChannel = await sharp(imgBuffer)
        .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
        .removeAlpha()
        .extractChannel('red')
        .normalize()
        .sharpen({ sigma: 1.5 })
        .threshold(60)
        .png()
        .toBuffer();
      variants.push({ name: 'red-channel', buf: redChannel });
    } catch (err) {
      console.log(`[mediaModeration] Red channel variant failed: ${err.message}`);
    }

    // Soft grayscale — preserves anti-aliased text edges
    const softGray = await sharp(imgBuffer)
      .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 2 })
      .png()
      .toBuffer();
    variants.push({ name: 'soft-gray', buf: softGray });
  }

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
  // CashApp $tag — requires 3+ alphanumeric chars after $, no spaces (avoids OCR noise like "$NA")
  { category: CAT.PAYMENT, pattern: /\$[a-zA-Z][a-zA-Z0-9_]{2,24}\b/g },

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
 * Quality gate for sign detection.
 * Requires at least 2 real words (3+ letters) to avoid OCR noise
 * triggering on random characters that happen to match "St" or "Rd".
 */
function isLikelySignText(text) {
  if (!text || text.trim().length < 3) return false;
  const realWords = text.match(/[a-zA-Z]{3,}/g) || [];
  if (realWords.length >= 2) return true;
  if (realWords.length >= 1 && /\d/.test(text)) return true;
  if (realWords.length >= 1 && realWords.some(w => w.length >= 5)) return true;
  return false;
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
 * 3b. STREET SIGN TEXT DETECTION (OCR-based)
 *
 * Detects street name signs only.  Catches:
 *   - Named roads: "Main Street", "Oak Avenue", "Sunset Blvd"
 *   - Abbreviated: "Main St", "Brown Rd", "Cedar Ln"
 *   - Numbered: "5th Ave", "42nd Street"
 *   - Directional: "North Main St", "E 42nd St"
 *
 * Only triggers for suffixes: St, Ave, Rd, Blvd, Dr, Ln, Ct, Pl, Way, Ter
 * (and their full-word equivalents).
 *
 * Does NOT detect: storefronts, traffic signs, highway signs,
 * STOP signs, warning signs, or hours-of-operation signs.
 * ═══════════════════════════════════════════════════════════ */

const SIGN_PATTERNS = [
  // ── Street name signs ONLY ──
  // Detect road name suffixes: St, Ave, Rd, Blvd, Dr, Ln, Ct, Pl, Way, Ter
  // Full-word suffixes (street, avenue, road, etc.) — road name 3+ chars
  {
    category: 'Street sign',
    pattern: /\b[A-Z][a-zA-Z]{2,}\s+(?:street|avenue|boulevard|drive|road|lane|court|place|way|terrace)\b/gi,
  },
  // Short abbreviated suffixes require 4+ char road name to avoid OCR noise
  {
    category: 'Street sign',
    pattern: /\b[A-Z][a-zA-Z]{3,}\s+(?:st|ave|blvd|dr|rd|ln|ct|pl|way|ter)\b/gi,
  },
  // Numbered streets: "5th Ave", "42nd Street", "1st St", "3rd Rd"
  {
    category: 'Street sign',
    pattern: /\b\d{1,5}(?:st|nd|rd|th)\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|pl(?:ace)?|way|ter(?:race)?)\b/gi,
  },
  // Directional prefix streets: "North Main St", "E 42nd St", "SW 8th Street"
  {
    category: 'Street sign',
    pattern: /\b(?:n(?:orth)?|s(?:outh)?|e(?:ast)?|w(?:est)?|ne|nw|se|sw)\.?\s+(?:\d{1,5}(?:st|nd|rd|th)?\s+)?[A-Za-z]{3,}\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|pl(?:ace)?|way|ter(?:race)?)\b/gi,
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
          `${category} detected: "${snippet}". Photos containing street name signs are not allowed in listings.`
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

    /* ── 1. Video-specific processing (optional — requires ffmpeg) ── */
    let framePaths = [];
    let framesDir = null;

    if (isVideo) {
      // Ensure mutedVideoBuffer is always set so S3 upload works
      // even if ffmpeg muting fails or is unavailable
      mutedVideoBuffer = buffer;

      // Write video to temp file for ffmpeg
      const videoTmp = tmpFile(path.extname(originalName) || '.mp4');
      fs.writeFileSync(videoTmp, buffer);
      tempFiles.push(videoTmp);

      // 2a. Check duration (graceful — skip if ffprobe unavailable)
      try {
        const duration = await getVideoDuration(videoTmp);
        console.log(`[mediaModeration] Video duration: ${duration.toFixed(1)}s`);
        if (duration > 30) {
          reasons.push(`Video exceeds 30-second limit (${duration.toFixed(1)}s). Please trim your video.`);
          return { approved: false, reasons };
        }
      } catch (err) {
        console.warn('[mediaModeration] ffprobe unavailable, skipping duration check:', err.message);
      }

      // 2b. Mute audio (graceful — use original if ffmpeg unavailable)
      try {
        const mutedPath = await muteVideo(videoTmp);
        tempFiles.push(mutedPath);
        mutedVideoBuffer = fs.readFileSync(mutedPath);
        console.log('[mediaModeration] Audio removed from video');
      } catch (err) {
        console.warn('[mediaModeration] ffmpeg mute unavailable, keeping original audio:', err.message);
        mutedVideoBuffer = buffer;
      }

      // 2c. Extract frames for OCR (graceful — skip if ffmpeg unavailable)
      try {
        const { frames, framesDir: fDir } = await extractFrames(videoTmp, 30);
        framePaths = frames;
        framesDir = fDir;
        tempDirs.push(fDir);
        console.log(`[mediaModeration] Extracted ${frames.length} frames`);
      } catch (err) {
        console.warn('[mediaModeration] Frame extraction unavailable, skipping video OCR:', err.message);
      }
    }

    /* ── 2. OCR analysis (photos + video frames) ───────────── */
    const allImages = isVideo ? framePaths : [buffer];

    if (isVideo && allImages.length === 0) {
      console.log('[mediaModeration] No video frames extracted — skipping OCR, approving video');
    }

    for (let i = 0; i < allImages.length; i++) {
      try {
        // Single fast OCR variant only — no enhanced variants
        const ocrText = await ocrImage(allImages[i], { allVariants: false });
        if (ocrText.trim().length > 0) {
          // Street sign text detection (requires 2+ real words to avoid noise)
          if (isLikelySignText(ocrText)) {
            const signReasons = detectSignsAndStorefronts(ocrText);
            if (signReasons.length > 0) {
              console.log(`[mediaModeration] Sign text in ${isVideo ? `frame ${i + 1}` : 'image'}:`, signReasons);
              reasons.push(...signReasons);
            }
          }

          // Contact / payment / identity detection (requires 3+ real words)
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

    /* ── 3. Final decision ───────────────────────────────── */
    // De-duplicate reasons
    const uniqueReasons = [...new Set(reasons)];

    if (uniqueReasons.length > 0) {
      return { approved: false, reasons: uniqueReasons.slice(0, 3) };
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
 * VENDOR COMPANY-NAME DETECTION (fuzzy)
 *
 * Blocks text that contains the vendor's company name or a close
 * misspelling of it.  Uses:
 *  1. Normalised substring match  (strips spaces & punctuation)
 *  2. Levenshtein distance on word n-grams of similar length
 *  3. Leet-speak / common substitution normalisation
 *
 * @param  {string} text        — the user-typed text
 * @param  {string} companyName — the vendor's company name
 * @returns {string[]}  array of reason strings (empty = clean)
 * ═══════════════════════════════════════════════════════════ */

/** Simple Levenshtein distance (no npm dep) */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalise text: lowercase, replace common leet-speak, strip non-alpha */
function normForFuzzy(str) {
  return str
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    .replace(/[^a-z]/g, '');          // keep only letters
}

function detectCompanyName(text, companyName) {
  if (!companyName || typeof companyName !== 'string') return [];
  const cn = companyName.trim();
  if (cn.length < 2) return [];                       // too short to be meaningful

  const normCN   = normForFuzzy(cn);
  const normText = normForFuzzy(text);
  if (normCN.length < 2) return [];

  // ── 1. Direct normalised substring match ──
  if (normText.includes(normCN)) {
    return ['Text contains the vendor company name'];
  }

  // ── 2. Sliding-window Levenshtein on the normalised text ──
  const maxDist = normCN.length <= 5 ? 1 : 2;        // tolerance
  const winLen  = normCN.length;
  for (let i = 0; i <= normText.length - winLen; i++) {
    const window = normText.substring(i, i + winLen);
    if (levenshtein(window, normCN) <= maxDist) {
      return ['Text contains a close variation of the vendor company name'];
    }
  }

  // ── 3. Also check windows that are ±1 char longer/shorter ──
  for (const delta of [-1, 1]) {
    const wl = winLen + delta;
    if (wl < 2) continue;
    for (let i = 0; i <= normText.length - wl; i++) {
      const window = normText.substring(i, i + wl);
      if (levenshtein(window, normCN) <= maxDist) {
        return ['Text contains a close variation of the vendor company name'];
      }
    }
  }

  return [];
}

/* ═══════════════════════════════════════════════════════════
 * TEXT FIELD MODERATION
 *
 * Runs the same contact/payment/identity detection patterns on raw text
 * fields (listing title, description, booking messages, reviews, etc.)
 * No OCR needed — just regex against the user-typed text.
 *
 * @param  {string}  text    — the text to moderate
 * @param  {object}  [opts]  — optional context
 * @param  {string}  [opts.companyName] — vendor company name to block
 * @returns {{ approved: boolean, reasons: string[] }}
 * ═══════════════════════════════════════════════════════════ */
function moderateText(text, opts = {}) {
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return { approved: true, reasons: [] };
  }

  // For direct text moderation (not OCR), skip the quality gate —
  // this IS real user-typed text, not noisy OCR output.
  const contactReasons   = detectContactInfo(text);
  const signReasons      = detectSignsAndStorefronts(text);
  const companyReasons   = opts.companyName
    ? detectCompanyName(text, opts.companyName)
    : [];
  const allReasons   = [...contactReasons, ...signReasons, ...companyReasons];
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
  detectCompanyName,
};
