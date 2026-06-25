'use strict';
/**
 * ProcurementIQ Phase 2.1 — Deterministic Article ID Architecture
 * GOVERNANCE REQUIREMENT #2
 *
 * id = "a_" + sha256(canonicalURL).slice(0,12)
 * Fallback when no URL: sha256(source + "|" + normalizedHeadline + "|" + pubDate)
 *
 * Properties:
 *  - Stable across rebuilds (URL is invariant -> same hash forever)
 *  - Dedup-safe (same URL -> same id, cannot double-add)
 *  - Bookmark-safe (saved id keeps resolving while article is in window)
 */
const crypto = require('crypto');

function shortHash(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex').slice(0, 12);
}

// Canonicalize a URL for stable identity: lowercase host, strip tracking params,
// strip fragment and trailing slash. Keeps the path/meaningful query intact.
function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    const TRACKING = /^(utm_\w*|fbclid|gclid|mc_cid|mc_eid|ref|source|amp)$/i;
    // collect non-tracking params, sorted for stable ordering
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING.test(k)) kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = kept.map(([k, v]) => k + '=' + v).join('&');
    // rebuild from parts so we control trailing slash + query precisely
    const host = u.host.toLowerCase();
    let pathName = u.pathname.replace(/\/+$/, ''); // strip trailing slash(es)
    let s = u.protocol + '//' + host + pathName;
    if (qs) s += '?' + qs;
    return s.toLowerCase();
  } catch (e) {
    return String(url || '').trim().toLowerCase();
  }
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce a permanent deterministic id for an article.
 * @param {{url?:string, source?:string, headline?:string, publishedAt?:string}} a
 */
function deterministicId(a) {
  const url = (a.url || '').trim();
  if (url) {
    return 'a_' + shortHash(canonicalizeUrl(url));
  }
  // Fallback: source + normalized title + publish date (date-only for stability)
  const datePart = (a.publishedAt || '').slice(0, 10);
  const basis = (a.source || '') + '|' + normalizeTitle(a.headline) + '|' + datePart;
  return 'a_' + shortHash(basis);
}

module.exports = { deterministicId, canonicalizeUrl, normalizeTitle, shortHash };
