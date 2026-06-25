'use strict';
/**
 * ProcurementIQ Phase 2.1 — Enrichment: categorize, tag, AMNS, PIS.
 * Ports the v1.3 in-browser scoring logic to build-time so the dashboard
 * receives PRE-SCORED articles. Logic mirrors calcAMNS/calcPIS exactly,
 * plus a feed-tier prior for AMNS and heuristic PIS sub-scores.
 */

// ── AMNS dimensions (identical weights to v1.3) ────────────────────────────
const AMNS_DIMENSIONS = [
  { key: 'steel',     weight: 14, kw: ['steel','hrc','crc','rebar','flat steel','long steel','blast furnace','bof','eaf','slab','billet'] },
  { key: 'ironore',   weight: 11, kw: ['iron ore','pellet','fines','lumps','ore'] },
  { key: 'coal',      weight: 11, kw: ['coal','coke','coking','met coal','metallurgical','pci'] },
  { key: 'mining',    weight: 7,  kw: ['mining','mine','ore','raw material','beneficiation'] },
  { key: 'freight',   weight: 9,  kw: ['freight','shipping','container','teu','red sea','port','vessel','ocean','capesize','dry bulk'] },
  { key: 'logistics', weight: 7,  kw: ['logistics','supply chain','transit','rail','road','modal','warehouse','inventory'] },
  { key: 'energy',    weight: 9,  kw: ['energy','power','electricity','gas','natural gas','fuel','crude','oil','emission','carbon'] },
  { key: 'capex',     weight: 7,  kw: ['capex','capital','equipment','project','plant','expansion','greenfield','brownfield','epc'] },
  { key: 'opex',      weight: 6,  kw: ['mro','spare','consumable','maintenance','service','operational','ferro','alloy','refractory','scrap'] },
  { key: 'india',     weight: 8,  kw: ['india','indian','pli','gst','rbi','sebi','make in india'] },
  { key: 'sc',        weight: 6,  kw: ['supply chain','supplier','sourcing','procurement','vendor','nearshoring','china+1','resilience'] },
  { key: 'proc',      weight: 5,  kw: ['procurement','cogs','contract','negotiation','spend','category','tariff','price'] }
];
const AMNS_CORE_TAGS = { 'Steel':1,'Iron Ore':1,'Coal':1,'Coke':1,'Scrap':1,'Ferro Alloys':1,'Freight':0.8,'Energy':0.8,'India':0.8,'Red Sea':0.6 };

// ── Watchlist synonym dictionary (identical to v1.3 dashboard) ─────────────
const TAG_RULES = {
  'Steel': ['steel','hrc','crc','rebar'],
  'Iron Ore': ['iron ore','pellet','ore','fines'],
  'Coal': ['coal','coking','met coal','pci'],
  'Coke': ['coke'],
  'Scrap': ['scrap'],
  'Ferro Alloys': ['ferro','alloy','ferrochrome','silico-manganese'],
  'Freight': ['freight','capesize','container','teu','red sea','vessel','shipping','dry bulk'],
  'Logistics': ['logistics','port congestion','modal shift','air freight','warehouse','inland','rail corridor','3pl'],
  'Energy': ['energy','power','electricity','gas','natural gas','crude','oil'],
  'CBAM': ['cbam','carbon border'],
  'ESG': ['esg','csrd','scope 3','carbon','sustainab','circular','emission'],
  'Supplier Risk': ['supplier risk','financial stress','insolvency','bankrupt','single source','concentration'],
  'China': ['china','chinese','china+1'],
  'Middle East': ['red sea','houthi','middle east','gulf'],
  'Trade Tariffs': ['tariff','trade war','wto','duty'],
  'AI Procurement': ['genai','artificial intelligence','autonomous','agentic','llm'],
  'Digital Procurement': ['digital','automation','p2p','s2p','spend analytics','ariba'],
  'Category Strategy': ['category management','strategic sourcing','reverse auction']
};

// ── Category keyword sets ──────────────────────────────────────────────────
const CATEGORY_RULES = {
  'Commodity Intelligence': ['iron ore','coal','coke','scrap','steel','price','$/mt','pellet','ferro','aluminium','copper','commodity','tonnage'],
  'Risk Intelligence': ['disruption','shortage','sanction','force majeure','strike','outage','diverted','crisis','risk','delay','congestion'],
  'Supplier Intelligence': ['supplier','vendor','insolvency','bankrupt','capacity','financial stress','sourcing'],
  'Technology Intelligence': ['ai','artificial intelligence','automation','digital','platform','genai','software','technology'],
  'Sustainability Intelligence': ['cbam','carbon','esg','emission','green','sustainab','decarbon','scope 3','renewable'],
  'Market Intelligence': ['demand','output','forecast','capacity expansion','market','growth','production','export','import']
};

function hay(a) {
  return ((a.headline || '') + ' ' + (a.summary || '') + ' ' + (a.tags || []).join(' ') + ' ' + (a.category || '')).toLowerCase();
}

// ── Tagging ────────────────────────────────────────────────────────────────
function deriveTags(a) {
  const text = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();
  const tags = [];
  for (const [tag, syns] of Object.entries(TAG_RULES)) {
    if (syns.some(s => text.includes(s))) tags.push(tag);
  }
  return tags;
}

// ── Categorization (feed hint + keyword scoring) ───────────────────────────
function categorize(a, feedHints) {
  const text = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();
  const scores = {};
  for (const [cat, kws] of Object.entries(CATEGORY_RULES)) {
    scores[cat] = kws.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0);
  }
  // feed hint prior: +1.5 to hinted categories
  (feedHints || []).forEach(h => { if (scores[h] !== undefined) scores[h] += 1.5; });
  let best = 'Market Intelligence', bestScore = -1;
  for (const [cat, sc] of Object.entries(scores)) {
    if (sc > bestScore) { best = cat; bestScore = sc; }
  }
  return best;
}

// ── AMNS (ported calcAMNS + tier prior) ────────────────────────────────────
function calcAMNS(a, feedTier) {
  const h = hay(a);
  let raw = 0, maxRaw = 0;
  AMNS_DIMENSIONS.forEach(d => { maxRaw += d.weight; if (d.kw.some(k => h.includes(k))) raw += d.weight; });
  let score = Math.round(Math.pow(raw / maxRaw, 0.72) * 100);
  let boost = 0;
  (a.tags || []).forEach(t => { if (AMNS_CORE_TAGS[t]) boost += AMNS_CORE_TAGS[t] * 7; });
  if (a.urgency === 'ACTION') boost += 5;
  if ((a.costImpact || 0) >= 4) boost += 4;
  if (a.steelStream) boost += 15;
  score = Math.min(100, Math.round(score + boost));
  // Feed-tier prior: Tier 1 sets a relevance floor
  if (feedTier === 1) score = Math.max(score, 70);
  else if (feedTier === 2) score = Math.max(score, 50);
  return score;
}
function amnsBand(s) {
  if (s >= 95) return 'Critical';
  if (s >= 80) return 'High';
  if (s >= 60) return 'Medium';
  return 'Low';
}

// ── PIS heuristic sub-scores (1-5 each) ────────────────────────────────────
function clamp(n) { return Math.max(1, Math.min(5, n)); }

function pisCostImpact(text, cat) {
  let s = 1;
  if (/\b(\d{1,2}(\.\d+)?)\s*%/.test(text)) s += 2;        // explicit % move
  if (/(surge|spike|soar|jump|rally|plunge|crash)/.test(text)) s += 2;
  if (/(\$\/mt|\$\/ton|\/tonne|price|cost)/.test(text)) s += 1;
  if (/(stable|steady|unchanged|ease|eased)/.test(text)) s -= 1;
  if (cat === 'Commodity Intelligence') s += 1;
  return clamp(s);
}
function pisSupplyRisk(text) {
  let s = 1;
  if (/(shortage|outage|disruption|diverted|force majeure|sanction|halt|suspend|blockade)/.test(text)) s += 3;
  if (/(delay|congestion|constraint|tight|deficit)/.test(text)) s += 1;
  return clamp(s);
}
function pisUrgency(text, publishedAt) {
  let s = 2;
  if (/(immediate|imminent|urgent|deadline|now|breaking|alert)/.test(text)) s += 2;
  // recency: within 48h adds urgency
  if (publishedAt) {
    const ageH = (Date.now() - new Date(publishedAt).getTime()) / 36e5;
    if (ageH <= 24) s += 1; else if (ageH <= 48) s += 0;
  }
  return clamp(s);
}
function pisStrategic(text) {
  let s = 1;
  if (/(capacity expansion|long-term|decarbon|policy|regulation|investment|strategy|cbam|transition|roadmap)/.test(text)) s += 3;
  if (/(forecast|outlook|trend|structural)/.test(text)) s += 1;
  return clamp(s);
}

function deriveUrgency(text) {
  if (/(immediate|imminent|urgent|deadline|breaking|alert|surge|spike|shortage|disruption)/.test(text)) return 'ACTION';
  if (/(forecast|outlook|monitor|trend|expansion|plan)/.test(text)) return 'MONITOR';
  return 'INFO';
}

// ── Risk / Opportunity scores (for filters/widgets) ────────────────────────
function deriveRiskScore(text, supplyRisk) {
  let s = supplyRisk - 1;
  if (/(risk|threat|crisis|disruption|shortage|sanction)/.test(text)) s += 1;
  return clamp(s);
}
function deriveOppScore(text) {
  let s = 1;
  if (/(opportunity|saving|cost reduction|dip|drop|discount|incentive|favourable|favorable)/.test(text)) s += 3;
  if (/(decline|fall|lower|ease)/.test(text)) s += 1;
  return clamp(s);
}

/**
 * Enrich a raw (already-sanitized) article in place and return it.
 * @param {object} a  has headline, summary, url, source, sourceConf, publishedAt
 * @param {object} feed feed config (tier, steelStream, categoryHints)
 */
function enrich(a, feed) {
  a.steelStream = !!feed.steelStream;
  a.tags = deriveTags(a);
  a.category = categorize(a, feed.categoryHints);
  const text = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();

  a.urgency = deriveUrgency(text);
  a.costImpact = pisCostImpact(text, a.category);
  a.supplyRisk = pisSupplyRisk(text);
  a.urgencyScore = pisUrgency(text, a.publishedAt);
  a.strategic = pisStrategic(text);
  a.riskScore = deriveRiskScore(text, a.supplyRisk);
  a.oppScore = deriveOppScore(text);

  a.amnsScore = calcAMNS(a, feed.tier);
  a.amnsBand = amnsBand(a.amnsScore);

  // recency flags
  if (a.publishedAt) {
    const ageH = (Date.now() - new Date(a.publishedAt).getTime()) / 36e5;
    a.breaking = ageH <= 12 && a.urgency === 'ACTION';
    a.trending = ageH <= 48 && a.amnsScore >= 80;
  } else {
    a.breaking = false; a.trending = false;
  }
  return a;
}

module.exports = { enrich, calcAMNS, amnsBand, deriveTags, categorize };
