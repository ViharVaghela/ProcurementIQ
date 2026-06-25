# ProcurementIQ — Phase 2.1 Milestone 1 Pipeline

Automated intelligence ingestion. Runs in GitHub Actions (zero npm dependencies — pure Node 20).

## Flow
```
feeds.config.json → generate.js
   fetch → parse → sanitize → categorize → tag → score (AMNS+PIS) → dedup → threshold
   → data/intelligence.json + data/manifest.json (committed only if changed)
```

## Files
- `feeds.config.json` — feed registry (tier, sourceConf, category hints, thresholds). Edit this to add/remove feeds.
- `sanitize.js` — strips all HTML/scripts/handlers/URIs to plain text (governance requirement).
- `ids.js` — deterministic article IDs (`a_` + sha256(canonical URL)[:12]); URL-canonicalization + title fallback.
- `parse.js` — minimal RSS 2.0 + Atom parser; throws on unparseable feeds.
- `enrich.js` — categorization, tagging, AMNS (with feed-tier prior), heuristic PIS.
- `generate.js` — orchestrator; dedup + all-fail safety + manifest.

## Run locally
```
node pipeline/generate.js --out data
```

## Safety guarantees
- One bad feed never fails the run (per-feed try/catch).
- If ALL feeds fail, `intelligence.json` is NOT overwritten; manifest.status = "failed".
- Empty feed = valid (0 items), not a failure. Missing/malformed = failure.
- AMNS < threshold (default 40) is dropped.

## Migration note (for later)
`manifest.idMigrationMap` maps legacy integer IDs (1–28) → hash IDs. The dashboard
consumes it once (guarded by `piq_id_migrated_v21`) so existing saved bookmarks survive.
When the pipeline fully replaces the seed, the map can be dropped from future manifests.

## Out of scope (per Milestone 1)
No commodity automation, supplier monitoring, alerts, notifications, or GenAI summarization.
Commodities/peers/supplier-risk/opportunities remain curated in their existing data/*.json.
