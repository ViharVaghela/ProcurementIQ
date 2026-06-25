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
const { enrich } = require('./enrich');

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
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
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

  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url);
      const rawItems = parseFeed(xml); // throws on unparseable -> caught below
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
        if (article.amnsScore < amnsThreshold) continue; // quality gate
        collected.push(article);
        kept++;
      }
      feedsSucceeded++;
    } catch (err) {
      feedsFailed.push(feed.name);
      console.error('[feed-fail] ' + feed.name + ': ' + err.message);
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
      feedsFailed
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
    feedsAttempted: feeds.length,
    feedsSucceeded,
    feedsFailed,
    oldestArticle: dates[0] || null,
    newestArticle: dates[dates.length - 1] || null
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
