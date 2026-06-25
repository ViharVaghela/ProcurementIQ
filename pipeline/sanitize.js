'use strict';
/**
 * ProcurementIQ Phase 2.1 — Content Sanitization Layer
 * GOVERNANCE REQUIREMENT #1
 *
 * All RSS content is treated as UNTRUSTED. This module reduces feed
 * titles/descriptions to clean, readable PLAIN TEXT before anything enters
 * intelligence.json. No HTML is retained (safest posture for v2.1).
 *
 * Defense in depth: this is build-time sanitization; the dashboard ALSO
 * escapes at render time via its existing esc() helper. Neither layer is
 * trusted alone.
 */

// Decode the small set of HTML entities that legitimately appear in feed text.
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '\u2014', '&ndash;': '\u2013',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
  '&hellip;': '\u2026', '&trade;': '\u2122', '&copy;': '\u00A9', '&reg;': '\u00AE',
  '&eacute;': '\u00E9', '&deg;': '\u00B0'
};

function decodeEntities(str) {
  return str
    // numeric decimal entities
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      // Drop control chars; keep printable
      return code >= 32 && code !== 127 ? String.fromCodePoint(code) : ' ';
    })
    // numeric hex entities
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const code = parseInt(n, 16);
      return code >= 32 && code !== 127 ? String.fromCodePoint(code) : ' ';
    })
    // named entities
    .replace(/&[a-zA-Z]+;/g, (m) => (ENTITIES[m] !== undefined ? ENTITIES[m] : ' '));
}

/**
 * Strip ALL markup and dangerous constructs, returning plain text.
 * Handles: <script>/<style>/<iframe>/<object>/<embed>/<svg> (incl. contents),
 * all other tags, event handlers, javascript:/data: URIs, CDATA, comments.
 */
function stripToText(input) {
  if (input == null) return '';
  let s = String(input);

  // 1. Remove CDATA wrappers (common in RSS) but keep their inner text.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // 2. Remove HTML comments entirely.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // 3. Remove dangerous elements INCLUDING their inner content.
  //    (script/style/iframe/object/embed/svg/noscript/template)
  s = s.replace(/<(script|style|iframe|object|embed|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  //    Also handle unclosed/self-terminating dangerous tags.
  s = s.replace(/<(script|style|iframe|object|embed|svg|noscript|template)\b[^>]*>/gi, ' ');

  // 4. Neutralize any remaining javascript:/data:/vbscript: URIs that might
  //    survive as text before tag-stripping (belt and braces).
  s = s.replace(/(javascript|data|vbscript)\s*:/gi, '');

  // 5. Strip ALL remaining tags (no allow-list — plain text only).
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

  // 6. Remove any orphan angle brackets that weren't valid tags.
  s = s.replace(/[<>]/g, ' ');

  // 7. Decode entities to real characters.
  s = decodeEntities(s);

  // 8. Defensive second pass: re-strip in case decoding revealed markup
  //    (e.g. "&lt;script&gt;" -> "<script>"). This closes the encoded-payload hole.
  if (/<|>/.test(s)) {
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/[<>]/g, ' ');
  }

  // 9. Strip remaining control characters.
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');

  // 10. Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/** Sanitize a headline: plain text, length-bounded. */
function sanitizeHeadline(input, maxLen = 200) {
  const t = stripToText(input);
  return t.length > maxLen ? t.slice(0, maxLen - 1).trimEnd() + '\u2026' : t;
}

/** Sanitize a summary: plain text, length-bounded, sentence-aware truncation. */
function sanitizeSummary(input, maxLen = 300) {
  let t = stripToText(input);
  if (t.length <= maxLen) return t;
  t = t.slice(0, maxLen);
  // try to cut at the last sentence boundary or space for readability
  const lastPeriod = t.lastIndexOf('. ');
  const lastSpace = t.lastIndexOf(' ');
  if (lastPeriod > maxLen * 0.6) t = t.slice(0, lastPeriod + 1);
  else if (lastSpace > 0) t = t.slice(0, lastSpace) + '\u2026';
  return t.trim();
}

/** Validate/normalize a URL; only http(s) allowed. Returns '' if unsafe. */
function sanitizeUrl(input) {
  if (!input) return '';
  const raw = stripToText(input).trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  // reject anything with embedded script-y schemes after the fact
  if (/(javascript|data|vbscript)\s*:/i.test(raw)) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (e) {
    return '';
  }
}

module.exports = { stripToText, sanitizeHeadline, sanitizeSummary, sanitizeUrl, decodeEntities };
