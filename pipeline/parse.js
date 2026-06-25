'use strict';
/**
 * ProcurementIQ Phase 2.1 — Minimal RSS/Atom parser (zero dependencies)
 *
 * Handles RSS 2.0 <item> and Atom <entry>. Tolerant of malformed feeds:
 * a feed that cannot be parsed throws, and the caller skips it (never
 * partially ingests). Raw field values are returned untouched — the
 * sanitization layer is responsible for cleaning them.
 */

function firstTag(block, names) {
  for (const name of names) {
    // <tag ...>value</tag>
    const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i');
    const m = block.match(re);
    if (m) return m[1];
  }
  return '';
}

// Atom <link href="..."/> or <link>...</link>
function extractLink(block) {
  // Atom: prefer rel="alternate" or first href
  const hrefAlt = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (hrefAlt) return hrefAlt[1];
  const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1];
  // RSS: <link>url</link>
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss) return rss[1].trim();
  return '';
}

function parseFeed(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new Error('Empty feed body');
  }
  // Quick sanity: must look like XML/feed
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml) && !/<entry[\s>]/i.test(xml)) {
    throw new Error('Not a recognizable RSS/Atom document');
  }

  const items = [];
  // RSS items
  const rssBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of rssBlocks) {
    items.push({
      title: firstTag(block, ['title']),
      description: firstTag(block, ['description', 'content:encoded', 'summary']),
      link: extractLink(block),
      pubDate: firstTag(block, ['pubDate', 'dc:date', 'date', 'published', 'updated'])
    });
  }
  // Atom entries
  const atomBlocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomBlocks) {
    items.push({
      title: firstTag(block, ['title']),
      description: firstTag(block, ['summary', 'content']),
      link: extractLink(block),
      pubDate: firstTag(block, ['published', 'updated'])
    });
  }

  return items;
}

// Parse a date string into ISO 8601; return null if unparseable.
function parseDate(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = { parseFeed, parseDate };
