/**
 * contentFilter.js — Comprehensive content detection engine
 *
 * Detects contact info, payment details, location/identity data,
 * profanity, and obfuscation patterns in user-submitted text.
 *
 * Used by:
 *   - Service listing creation/edit (description, amenities, rules, cancellation)
 *   - User reviews
 *   - Any other user-facing text field
 */

/* ═══════════════════════════════════════════════════════════
 * NUMBER-WORD → DIGIT NORMALISER
 * Converts "five five five one two three four" → "5551234"
 * ═══════════════════════════════════════════════════════════ */
const WORD_TO_DIGIT = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

function normaliseNumberWords(text) {
  const words = Object.keys(WORD_TO_DIGIT).join('|');
  const re = new RegExp(`\\b(${words})\\b`, 'gi');
  return text.replace(re, (m) => WORD_TO_DIGIT[m.toLowerCase()] || m);
}

/* ═══════════════════════════════════════════════════════════
 * STRIP common obfuscation characters to normalise text
 * ═══════════════════════════════════════════════════════════ */
function deobfuscate(text) {
  let t = text;
  // Normalise number words first ("five five five" → "555")
  t = normaliseNumberWords(t);
  // Collapse deliberate spacing in digit/letter sequences ("5 5 5" → "555")
  // Only collapse single-char tokens separated by spaces
  t = t.replace(/\b(\w)\s+(?=\w\b)/g, '$1');
  return t;
}

/* ═══════════════════════════════════════════════════════════
 * DETECTION RULES  — each returns { detected: bool, matches: string[] }
 *
 * Every function receives the ORIGINAL text AND the de-obfuscated
 * version so it can catch both raw and hidden patterns.
 * ═══════════════════════════════════════════════════════════ */

// ─── 1. Phone Numbers ──────────────────────────────────────
function detectPhoneNumbers(raw, clean) {
  const patterns = [
    // Standard US: (xxx) xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, xxx xxx xxxx
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    // International with country code +xx
    /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g,
    // 10+ consecutive digits (after deobfuscation)
    /\d{10,}/g,
    // 1-800 / 1-888 style
    /1[-.\s]?8[0-9]{2}[-.\s]?\d{3}[-.\s]?\d{4}/gi,
    // "one eight hundred" style already normalised by deobfuscate
  ];
  const matches = new Set();
  for (const p of patterns) {
    for (const src of [raw, clean]) {
      const found = src.match(p);
      if (found) found.forEach((m) => matches.add(m.trim()));
    }
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'phone_number' };
}

// ─── 2. Email Addresses ────────────────────────────────────
function detectEmails(raw, clean) {
  const matches = new Set();
  // Standard email
  const std = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  // Obfuscated: "name at domain dot com"
  const obf = /[a-zA-Z0-9._%+\-]+\s*(?:\[?\s*at\s*\]?|@)\s*[a-zA-Z0-9.\-]+\s*(?:\[?\s*dot\s*\]?|\.)\s*[a-zA-Z]{2,}/gi;
  for (const p of [std, obf]) {
    for (const src of [raw, clean]) {
      const found = src.match(p);
      if (found) found.forEach((m) => matches.add(m.trim()));
    }
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'email' };
}

// ─── 3. Social Media Handles ───────────────────────────────
function detectSocialHandles(raw, _clean) {
  const matches = new Set();
  const text = raw.toLowerCase();

  // Platform keyword + handle patterns
  const platformPatterns = [
    /(?:instagram|insta|ig|snap(?:chat)?|tik\s*tok|telegram|whats\s*app|discord|twitter|x\.com|facebook|fb|linkedin|youtube|yt|pinterest|threads)[\s:@=]*[@]?[\w.]{2,30}/gi,
    // "my ig is @…" / "add me on snap …"
    /(?:my|add\s+me\s+on|follow\s+me\s+on|find\s+me\s+on|hit\s+me\s+up\s+on|hmu\s+on|reach\s+me\s+on)\s+(?:instagram|insta|ig|snap(?:chat)?|tik\s*tok|telegram|whats\s*app|discord|twitter|facebook|fb)[\s:@=]*[@]?[\w.]{0,30}/gi,
    // Bare @handle (3+ chars, not an email)
    /(?<!\w)@[a-zA-Z][\w.]{2,29}(?!\.\w{2,4}\b)/g,
  ];
  for (const p of platformPatterns) {
    const found = raw.match(p);
    if (found) found.forEach((m) => matches.add(m.trim()));
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'social_handle' };
}

// ─── 4. Links / URLs / Invite Codes ───────────────────────
function detectLinks(raw, _clean) {
  const matches = new Set();
  const patterns = [
    // Standard URLs
    /https?:\/\/[^\s<>"']+/gi,
    // www. links
    /www\.[^\s<>"']+/gi,
    // Platform short links
    /(?:discord\.gg|t\.me|wa\.me|linktr\.ee|bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|rb\.gy|is\.gd|v\.gd|shorturl\.at|tiny\.cc)\/[\w\-+]+/gi,
    // Domain patterns without protocol
    /[a-zA-Z0-9\-]+\.(?:com|net|org|io|co|me|app|dev|xyz|gg|info|biz|us|uk|ca|de|fr|link|site|online|store|shop|tech|page)(?:\/[^\s]*)?/gi,
  ];
  for (const p of patterns) {
    const found = raw.match(p);
    if (found) found.forEach((m) => matches.add(m.trim()));
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'link' };
}

// ─── 5. Intent Phrases ("text me", "call me", "DM me") ────
function detectIntentPhrases(raw, _clean) {
  const matches = new Set();
  const patterns = [
    /\b(?:text|call|dm|message|hit|hmu|reach|contact|ring|buzz|ping|holler\s+at)\s+(?:me|us)\b/gi,
    /\b(?:send|give)\s+(?:me|us)\s+(?:a\s+)?(?:text|message|call|dm)\b/gi,
    /\b(?:text|call|dm|message)\s+(?:me|us)\s+(?:at|on|@)\b/gi,
    /\b(?:let'?s?\s+)?(?:take\s+(?:this|it)\s+)?(?:off\s*(?:the\s*)?(?:platform|app|site))\b/gi,
    /\b(?:talk|chat|connect|communicate)\s+(?:outside|off\s*(?:the\s*)?(?:platform|app|site|here))\b/gi,
  ];
  for (const p of patterns) {
    const found = raw.match(p);
    if (found) found.forEach((m) => matches.add(m.trim()));
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'intent_phrase' };
}

// ─── 6. Payment / Money Platforms ──────────────────────────
function detectPaymentInfo(raw, clean) {
  const matches = new Set();
  const patterns = [
    // CashApp $cashtag
    /\$[a-zA-Z][\w]{1,20}/g,
    // Obfuscated "$cashtag" → "$ n a m e"
    /\$\s+[a-zA-Z\s]{3,30}/g,
    // Platform mentions + handle
    /(?:cash\s*app|venmo|zelle|paypal|apple\s*pay|google\s*pay|gpay)[\s:@$]*[\w@$.]{0,30}/gi,
    // "send money", "pay me"
    /\b(?:send|wire|transfer)\s+(?:me\s+)?(?:money|payment|funds|cash)\b/gi,
    /\b(?:pay|venmo|zelle|cashapp)\s+(?:me|us)\b/gi,
    // Crypto addresses (BTC: 1/3/bc1, ETH: 0x)
    /\b(?:1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}\b/g,
    /\b0x[a-fA-F0-9]{40}\b/g,
    // Crypto keywords
    /\b(?:btc|eth|usdt|usdc|bitcoin|ethereum|crypto|wallet\s*address)\b/gi,
    // Bank details
    /\b(?:routing\s*(?:number|#|no)?|account\s*(?:number|#|no)?|iban|swift|bic)[\s:]*[\w\d]{6,34}\b/gi,
    // Gift card patterns
    /\b(?:gift\s*card|prepaid\s*card|itunes\s*card|amazon\s*card|google\s*play\s*card)\b/gi,
  ];
  for (const p of patterns) {
    for (const src of [raw, clean]) {
      const found = src.match(p);
      if (found) found.forEach((m) => matches.add(m.trim()));
    }
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'payment' };
}

// ─── 7. Location / Identity Data ───────────────────────────
function detectLocationIdentity(raw, _clean) {
  const matches = new Set();
  const patterns = [
    // Street address: "123 Main St", "456 Oak Ave Apt 2"
    /\b\d{1,5}\s+[A-Za-z]+\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|pl(?:ace)?|way|cir(?:cle)?|pkwy|parkway|ter(?:race)?)\b/gi,
    // Apt/Unit/Suite
    /\b(?:apt|apartment|unit|suite|ste|floor|fl|bldg|building)\s*[#.]?\s*\w{1,10}\b/gi,
    // ZIP code (5 or 9 digit)
    /\b\d{5}(?:-\d{4})?\b/g,
    // "Send me your address" / "meet me at"
    /\b(?:send|give)\s+(?:me|us)\s+(?:your\s+)?(?:address|location)\b/gi,
    /\b(?:meet|come|stop\s+by)\s+(?:me\s+)?(?:at|to)\s+\d/gi,
    // SSN pattern
    /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
    // DOB patterns: "born on", "date of birth"
    /\b(?:date\s+of\s+birth|dob|born\s+on|birthday\s+is)\b/gi,
  ];
  for (const p of patterns) {
    const found = raw.match(p);
    if (found) found.forEach((m) => matches.add(m.trim()));
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'location_identity' };
}

// ─── 8. Custom Banned Words (admin word bank) ──────────────
function detectBannedWords(raw, _clean, bannedWords = []) {
  if (!bannedWords || bannedWords.length === 0) return { detected: false, matches: [], category: 'banned_word' };
  const matches = new Set();
  const lower = raw.toLowerCase();
  for (const word of bannedWords) {
    const w = word.toLowerCase().trim();
    if (!w) continue;
    // Escape regex special chars, then do word-boundary match
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    const found = raw.match(re);
    if (found) found.forEach((m) => matches.add(m.trim()));
  }
  return { detected: matches.size > 0, matches: [...matches], category: 'banned_word' };
}


/* ═══════════════════════════════════════════════════════════
 * MAIN SCAN FUNCTION
 *
 * @param {string} text — raw user input
 * @param {Object} options
 *   @param {boolean} options.checkPhoneNumbers       (default: true)
 *   @param {boolean} options.checkEmails              (default: true)
 *   @param {boolean} options.checkSocialHandles       (default: true)
 *   @param {boolean} options.checkLinks               (default: true)
 *   @param {boolean} options.checkIntentPhrases       (default: true)
 *   @param {boolean} options.checkPaymentInfo         (default: true)
 *   @param {boolean} options.checkLocationIdentity    (default: true)
 *   @param {boolean} options.checkBannedWords         (default: true)
 *   @param {string[]} options.bannedWords             (default: [])
 *
 * @returns {Object} { clean: bool, violations: [...], summary: string }
 * ═══════════════════════════════════════════════════════════ */
function scanContent(text, options = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { clean: true, violations: [], summary: '' };
  }

  const raw = text;
  const clean = deobfuscate(text);

  const checks = [];

  if (options.checkPhoneNumbers !== false)    checks.push(detectPhoneNumbers(raw, clean));
  if (options.checkEmails !== false)          checks.push(detectEmails(raw, clean));
  if (options.checkSocialHandles !== false)   checks.push(detectSocialHandles(raw, clean));
  if (options.checkLinks !== false)           checks.push(detectLinks(raw, clean));
  if (options.checkIntentPhrases !== false)   checks.push(detectIntentPhrases(raw, clean));
  if (options.checkPaymentInfo !== false)     checks.push(detectPaymentInfo(raw, clean));
  if (options.checkLocationIdentity !== false) checks.push(detectLocationIdentity(raw, clean));
  if (options.checkBannedWords !== false)     checks.push(detectBannedWords(raw, clean, options.bannedWords || []));

  const violations = checks.filter((c) => c.detected);
  const allMatches = violations.flatMap((v) => v.matches);

  const CATEGORY_LABELS = {
    phone_number: 'Phone number',
    email: 'Email address',
    social_handle: 'Social media handle',
    link: 'Link/URL',
    intent_phrase: 'Off-platform intent',
    payment: 'Payment/financial info',
    location_identity: 'Location/identity data',
    banned_word: 'Prohibited word',
  };

  const summaryParts = violations.map(
    (v) => `${CATEGORY_LABELS[v.category] || v.category}: ${v.matches.join(', ')}`
  );

  return {
    clean: violations.length === 0,
    violations,
    allMatches,
    summary: summaryParts.join(' | '),
  };
}

module.exports = { scanContent, deobfuscate };
