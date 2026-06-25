'use strict';
/**
 * ProcurementIQ Phase 2.1 — Milestone 1 generator
 *
 * Flow: fetch -> parse -> sanitize -> enrich(categorize/tag/score) ->
 *       dedup -> threshold -> emit intelligence.json + manifest.json
 *
 * Safety: per-feed try/catch (one bad feed never fails the run). If ALL feeds
 * fail, the existing intelligence.json is NOT overwritten — last-good data is
 * preserved and manifest.status is set to "failed".
 *
 * Usage: node pipeline/generate.js [--out DIR] [--config FILE]
 */
const fs = require('fs');
const path = require('path');
const { parseFeed, parseDate } = require('./parse');
const { sanitizeHeadline, sanitizeSummary, sanitizeUrl } = require('./sanitize');
const { deterministicId, canonicalizeUrl, normalizeTitle } = require('./ids');
const { enrich, relevanceGate } = require('./enrich');

const SCHEMA_VERSION = '2.1';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT_DIR = arg('--out', path.join(__dirname, '..', 'data'));
const CONFIG = arg('--config', path.join(__dirname, 'feeds.config.json'));

async function fetchFeed(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ProcurementIQ-Pipeline/2.1 (+github-actions)' }
    });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.kind = 'http'; e.detail = 'HTTP ' + res.status; throw e; }
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') { const e = new Error('Timeout after ' + timeoutMs + 'ms'); e.kind = 'timeout'; e.detail = 'Timeout (' + (timeoutMs / 1000) + 's)'; throw e; }
    if (!err.kind) { err.kind = 'network'; err.detail = 'Network error: ' + err.message; }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Map an error from the feed loop into a concise human reason for the manifest.
function failureReason(err) {
  if (!err) return 'Reason Not Available';
  if (err.kind === 'http') return err.detail;          // e.g. "HTTP 404"
  if (err.kind === 'timeout') return err.detail;       // e.g. "Timeout (15s)"
  if (err.kind === 'parse') return 'Parse error';
  if (err.kind === 'network') return err.detail || 'Network error';
  return err.message || 'Reason Not Available';
}

function withinWindow(iso, days) {
  if (!iso) return true; // keep undated items (rare); they still get scored
  const ageDays = (Date.now() - new Date(iso).getTime()) / 864e5;
  return ageDays <= days;
}

// ── Deduplication ──────────────────────────────────────────────────────────
function tokenSet(title) {
  const STOP = new Set(['the','a','an','of','to','in','on','for','and','or','as','at','by','is','are','with','from','amid','over']);
  return new Set(normalizeTitle(title).split(' ').filter(w => w && !STOP.has(w)));
}
function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}
function dedupe(articles) {
  const byId = new Map();
  // 1. exact id (== canonical URL) collapse, keep higher tier/conf, merge tags, earliest date
  for (const a of articles) {
    const ex = byId.get(a.id);
    if (!ex) { byId.set(a.id, a); continue; }
    byId.set(a.id, resolveDup(ex, a));
  }
  let list = [...byId.values()];
  // 2. normalized-title + near-duplicate collapse
  const kept = [];
  const sets = [];
  for (const a of list) {
    const ts = tokenSet(a.headline);
    let dupIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      if (normalizeTitle(k.headline) === normalizeTitle(a.headline) || jaccard(sets[i], ts) >= 0.85) {
        dupIdx = i; break;
      }
    }
    if (dupIdx === -1) { kept.push(a); sets.push(ts); }
    else { kept[dupIdx] = resolveDup(kept[dupIdx], a); }
  }
  return kept;
}
function resolveDup(a, b) {
  // higher tier (lower number) wins; tie -> higher sourceConf
  const winner = (b.feedTier < a.feedTier) || (b.feedTier === a.feedTier && (b.sourceConf || 0) > (a.sourceConf || 0)) ? b : a;
  const loser = winner === a ? b : a;
  // merge tags (union)
  winner.tags = Array.from(new Set([...(winner.tags || []), ...(loser.tags || [])]));
  // keep earliest publishedAt
  if (loser.publishedAt && (!winner.publishedAt || new Date(loser.publishedAt) < new Date(winner.publishedAt))) {
    winner.publishedAt = loser.publishedAt;
  }
  return winner;
}

function readJSONSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const feeds = cfg.feeds || [];
  const recencyDays = cfg.recencyWindowDays || 30;
  const maxPerFeed = cfg.maxItemsPerFeed || 12;
  const amnsThreshold = cfg.amnsThreshold != null ? cfg.amnsThreshold : 40;

  const feedsFailed = [];
  let feedsSucceeded = 0;
  let collected = [];
  const rejected = {};

  // Read prior manifest to carry forward each feed's last-successful timestamp.
  const priorManifest = readJSONSafe(path.join(OUT_DIR, 'manifest.json')) || {};
  const priorHealth = {};
  (priorManifest.feedHealth || []).forEach(h => { priorHealth[h.name] = h; });

  const runAt = new Date().toISOString();
  const feedHealth = [];

  for (const feed of feeds) {
    const prior = priorHealth[feed.name] || {};
    try {
      const xml = await fetchFeed(feed.url);
      let rawItems;
      try {
        rawItems = parseFeed(xml); // throws on unparseable
      } catch (pe) {
        pe.kind = 'parse';
        throw pe;
      }
      let kept = 0;
      for (const it of rawItems) {
        if (kept >= maxPerFeed) break;
        const url = sanitizeUrl(it.link);
        const headline = sanitizeHeadline(it.title);
        if (!headline) continue; // skip empty/garbage items
        const summary = sanitizeSummary(it.description);
        const publishedAt = parseDate(it.pubDate);
        if (!withinWindow(publishedAt, recencyDays)) continue;

        const article = {
          headline, summary, url,
          source: feed.name,
          sourceConf: feed.sourceConf,
          feedTier: feed.tier,
          publishedAt,
          ingestedAt: new Date().toISOString()
        };
        article.id = deterministicId(article);
        enrich(article, feed);
        const gate = relevanceGate(article, { amnsFloor: cfg.relevanceFloor != null ? cfg.relevanceFloor : 55 });
        if (!gate.keep) { rejected[gate.reason] = (rejected[gate.reason] || 0) + 1; continue; }
        collected.push(article);
        kept++;
      }
      feedsSucceeded++;
      feedHealth.push({ name: feed.name, status: 'live', lastSuccess: runAt, reason: null, itemsKept: kept });
    } catch (err) {
      feedsFailed.push(feed.name);
      const reason = failureReason(err);
      console.error('[feed-fail] ' + feed.name + ': ' + reason);
      feedHealth.push({ name: feed.name, status: 'failed', lastSuccess: prior.lastSuccess || null, reason, itemsKept: 0 });
    }
  }

  // ── ALL-FAIL SAFETY: never overwrite last-good intelligence.json ──────────
  const intelPath = path.join(OUT_DIR, 'intelligence.json');
  const manifestPath = path.join(OUT_DIR, 'manifest.json');

  if (feedsSucceeded === 0) {
    const prior = readJSONSafe(intelPath);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: prior && prior.__lastGoodGeneratedAt ? prior.__lastGoodGeneratedAt : null,
      attemptedAt: new Date().toISOString(),
      status: 'failed',
      articleCount: prior && Array.isArray(prior.articles) ? prior.articles.length : 0,
      feedsAttempted: feeds.length,
      feedsSucceeded: 0,
      feedsFailed,
      feedHealth,
      sourceDistribution: priorManifest.sourceDistribution || {},
      rejected: { total: 0, byReason: {} }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.error('[ALL FEEDS FAILED] intelligence.json preserved; manifest.status=failed');
    return { status: 'failed', wrote: false };
  }

  // dedup + sort (AMNS desc, then breaking, then recency)
  let articles = dedupe(collected);
  articles.sort((x, y) => {
    if (!!y.breaking !== !!x.breaking) return (y.breaking ? 1 : 0) - (x.breaking ? 1 : 0);
    if (y.amnsScore !== x.amnsScore) return y.amnsScore - x.amnsScore;
    return new Date(y.publishedAt || 0) - new Date(x.publishedAt || 0);
  });

  const generatedAt = new Date().toISOString();
  const dates = articles.map(a => a.publishedAt).filter(Boolean).sort();
  const status = feedsFailed.length === 0 ? 'ok' : 'degraded';

  // Source distribution — article count by source, derived automatically.
  const sourceDistribution = {};
  articles.forEach(a => { sourceDistribution[a.source] = (sourceDistribution[a.source] || 0) + 1; });

  // Articles published today (by publish date, UTC) — for the governance KPI strip.
  const todayUTC = generatedAt.slice(0, 10);
  const publishedToday = articles.filter(a => (a.publishedAt || '').slice(0, 10) === todayUTC).length;

  const intelligence = {
    schemaVersion: SCHEMA_VERSION,
    __lastGoodGeneratedAt: generatedAt,
    articles
    // NOTE: commodities/peers/supplierRisk/opportunities remain in their
    // existing curated data/*.json files for Milestone 1 (out of scope here).
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    status,
    articleCount: articles.length,
    publishedToday,
    feedsAttempted: feeds.length,
    feedsSucceeded,
    feedsFailed,
    feedHealth,
    sourceDistribution,
    oldestArticle: dates[0] || null,
    newestArticle: dates[dates.length - 1] || null,
    rejected: {
      total: Object.values(rejected).reduce((a, b) => a + b, 0),
      byReason: rejected
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(intelPath, JSON.stringify(intelligence, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('[ok] wrote ' + articles.length + ' articles; status=' + status + '; failed=[' + feedsFailed.join(',') + ']');
  return { status, wrote: true, count: articles.length };
}

if (require.main === module) {
  main().catch(e => { console.error('[fatal]', e); process.exit(1); });
}
module.exports = { main, dedupe };
