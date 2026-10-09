/**
 * Export potential scoring engine.
 *
 * Pure functions: no I/O, no dates, no network. Every number comes from
 * config.json (see loadConfig); the code only carries the method's shape.
 *
 * Vocabulary (from the platform brief):
 *   T        the partner's data year
 *   window   the years T-4 .. T (shorter for a "new market", see gate2)
 *   M, X     the partner's imports / exports of the product from / to the world
 *   "world"  sums over the fixed set of reporting countries
 * All money values are US dollars; growth rates and shares are fractions;
 * tariffs are percentage points.
 *
 * Layers:
 *   gate1(...)          Georgia really supplies the product
 *   gate2(...)          the partner's import history decides the window
 *   computeMetrics(...) raw yearly series -> the indicator values
 *   scoreMetrics(...)   indicator values -> points per indicator and block
 *   rate(...)           total points + caps -> rating
 *   evaluate(...)       the whole chain for one partner x product
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const RATINGS = ['Low', 'Moderate', 'High'];
const RATING_RANK = { Low: 0, Moderate: 1, High: 2 };

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function avg(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function sum(values) {
  return values.reduce((s, v) => s + v, 0);
}

function pick(series, years) {
  return years.map((y) => num(series && series[y]));
}

function range(from, to) {
  const out = [];
  for (let y = from; y <= to; y++) out.push(y);
  return out;
}

// ── Gate 1: real Georgian supply ────────────────────────────────────────────
// `byYear` is Georgia's domestic exports of the product to all destinations
// (Geostat), `years` are Geostat's latest full years (cfg.gate1.years of them).
function gate1(byYear, years, cfg) {
  const g = cfg.gate1;
  const yrs = [...years].sort((a, b) => a - b).slice(-g.years);
  const values = pick(byYear, yrs);
  const yearsAboveZero = values.filter((v) => v > 0).length;
  const average = yrs.length === g.years ? avg(values) : 0;
  const pass = yrs.length === g.years && yearsAboveZero === g.years && average >= g.minAverageUsd;
  return { pass, years: yrs, values, average, yearsAboveZero };
}

// ── Gate 2: the partner's import history ────────────────────────────────────
// Counts consecutive years with M > 0 ending at T. The count is bounded by
// the years present in `importsByYear` (normally the window, T-4 .. T).
function gate2(importsByYear, T, cfg) {
  const g = cfg.gate2;
  let consecutiveYears = 0;
  while (num(importsByYear && importsByYear[T - consecutiveYears]) > 0) consecutiveYears++;
  let status;
  let windowYears = [];
  if (consecutiveYears >= g.establishedMinYears) {
    status = 'established';
    windowYears = range(T - cfg.windowYears + 1, T);
  } else if (consecutiveYears >= g.newMarketMinYears) {
    status = 'new';
    windowYears = range(T - consecutiveYears + 1, T);
  } else if (consecutiveYears >= g.watchMinYears) {
    status = 'watch';
  } else {
    status = 'none';
  }
  return { consecutiveYears, status, windowYears };
}

// ── Metrics from raw series ─────────────────────────────────────────────────
// input = {
//   T, hs4,
//   partnerImports:  { year: usd }      M, from the partner's trade source
//   partnerExports:  { year: usd }      X
//   worldImports:    { year: usd }      world imports of the product
//   supplierImports: { supplierCode: { year: usd } }   the partner's imports by supplier
//   georgia: {
//     latestYears:               [y, y, y]      Geostat's latest full years
//     trackRecordYears:          [y .. y]       the last five Geostat years
//     domesticExportsProduct:    { year: usd }  all destinations
//     domesticExportsTotal:      { year: usd }
//     exportsToPartner:          { year: usd }  domestic exports to this partner
//   },
//   world: { exportsProduct: { year: usd }, exportsTotal: { year: usd } },
//   tariff:   { georgiaRate, supplierRates: { supplierCode: pct } } | null
//   distance: { georgiaKm, supplierKm: { supplierCode: km } } | null
// }
function computeMetrics(input, windowYears, cfg) {
  const T = input.T;
  const years = [...windowYears].sort((a, b) => a - b);
  const start = years[0];
  const intervals = years.length - 1;
  const M = pick(input.partnerImports, years);
  const X = pick(input.partnerExports, years);
  const Mt = num(input.partnerImports[T]);
  const Mstart = num(input.partnerImports[start]);
  const Mt2 = num(input.partnerImports[T - 2]);
  const flags = [];

  // Demand size
  const avgImports = avg(M);

  // Demand growth
  const cagr = (a, b) => (a > 0 && b > 0 && intervals > 0) ? Math.pow(b / a, 1 / intervals) - 1 : null;
  const partnerGrowth = cagr(Mstart, Mt);
  const Wstart = num(input.worldImports && input.worldImports[start]);
  const Wt = num(input.worldImports && input.worldImports[T]);
  const worldGrowth = cagr(Wstart, Wt);
  if (worldGrowth == null) flags.push({ code: 'world_growth_missing', default: 'group_b' });
  const netChange2y = Mt2 > 0 ? (Mt - Mt2) / Mt2 : null;
  if (netChange2y == null) flags.push({ code: 'net_change_missing', default: 'zero' });

  // Deficit level and trend
  const avgExports = avg(X);
  const share = (y) => {
    const m = num(input.partnerImports[y]);
    return m > 0 ? (m - num(input.partnerExports[y])) / m : null;
  };
  const deficitShareT = share(T);
  const deficitShareT1 = share(T - 1);
  const deficitShareT2 = share(T - 2);

  // Supplier concentration over the window
  const supplierTotals = {};
  let supplierSum = 0;
  for (const [code, byYear] of Object.entries(input.supplierImports || {})) {
    const v = sum(pick(byYear, years));
    if (v > 0) { supplierTotals[code] = v; supplierSum += v; }
  }
  let hhi = null;
  if (supplierSum > 0) {
    hhi = 0;
    for (const v of Object.values(supplierTotals)) hhi += Math.pow(v / supplierSum, 2);
  } else {
    flags.push({ code: 'supplier_data_missing', default: 'concentration_high' });
  }

  // Tariff position: Georgia's rate against the import-weighted average of
  // the other suppliers' rates.
  const geoCode = String(cfg.georgiaSupplierCode);
  let georgiaTariff = null;
  let competitorsTariff = null;
  if (input.tariff && input.tariff.georgiaRate != null) {
    georgiaTariff = num(input.tariff.georgiaRate);
    let wsum = 0; let tsum = 0;
    for (const [code, v] of Object.entries(supplierTotals)) {
      if (code === geoCode) continue;
      const r = input.tariff.supplierRates && input.tariff.supplierRates[code];
      if (r == null) continue;
      wsum += v; tsum += num(r) * v;
    }
    competitorsTariff = wsum > 0 ? tsum / wsum : null;
  }
  if (georgiaTariff == null || competitorsTariff == null) {
    flags.push({ code: 'tariff_missing', default: cfg.competitionAccess.tariff.missingDefault });
  }

  // Distance fit: Georgia against the import-weighted average supplier distance.
  let georgiaKm = null;
  let avgSupplierKm = null;
  if (input.distance && input.distance.georgiaKm != null) {
    georgiaKm = num(input.distance.georgiaKm);
    let wsum = 0; let dsum = 0;
    for (const [code, v] of Object.entries(supplierTotals)) {
      const d = input.distance.supplierKm && input.distance.supplierKm[code];
      if (d == null) continue;
      wsum += v; dsum += num(d) * v;
    }
    avgSupplierKm = wsum > 0 ? dsum / wsum : null;
  }
  if (georgiaKm == null || avgSupplierKm == null) {
    flags.push({ code: 'distance_missing', default: cfg.competitionAccess.distance.missingDefault });
  }

  // Georgia's position
  const g = input.georgia || {};
  const w = input.world || {};
  const latest = [...(g.latestYears || [])].sort((a, b) => a - b).slice(-cfg.georgiaPosition.rca.years);
  const geoProd = avg(pick(g.domesticExportsProduct, latest));
  const geoTotal = avg(pick(g.domesticExportsTotal, latest));
  const worldProd = avg(pick(w.exportsProduct, latest));
  const worldTotal = avg(pick(w.exportsTotal, latest));
  let rca = null;
  if (geoTotal > 0 && worldProd > 0 && worldTotal > 0) {
    rca = (geoProd / geoTotal) / (worldProd / worldTotal);
  } else {
    flags.push({ code: 'rca_missing', default: 'zero' });
  }

  const trackYears = [...(g.trackRecordYears || [])].sort((a, b) => a - b).slice(-cfg.georgiaPosition.trackRecord.lookbackYears);
  const yearsWithExports = pick(g.exportsToPartner, trackYears).filter((v) => v > 0).length;

  const geoToPartnerWindow = sum(pick(g.exportsToPartner, years));
  const mWindow = sum(M);
  const sharePartnerImports = mWindow > 0 ? geoToPartnerWindow / mWindow : null;
  const geoProductWindow = sum(pick(g.domesticExportsProduct, years));
  const worldProductWindow = sum(pick(w.exportsProduct, years));
  const shareWorldExports = worldProductWindow > 0 ? geoProductWindow / worldProductWindow : null;
  if (sharePartnerImports == null || shareWorldExports == null) {
    flags.push({ code: 'headroom_missing', default: 'no_headroom' });
  }

  return {
    T,
    windowYears: years,
    avgImports,
    importsAtT: Mt,
    importsAtStart: Mstart,
    partnerGrowth,
    worldGrowth,
    netChange2y,
    avgExports,
    deficitShareT,
    deficitShareT1,
    deficitShareT2,
    supplierConcentration: hhi,
    supplierCount: Object.keys(supplierTotals).length,
    georgiaTariff,
    competitorsTariff,
    georgiaKm,
    avgSupplierKm,
    rca,
    trackRecordYears: trackYears,
    yearsWithExports,
    sharePartnerImports,
    shareWorldExports,
    flags,
  };
}

// ── Points from metrics ─────────────────────────────────────────────────────
// `m` holds the indicator values (as computeMetrics returns them, or given
// directly, as in the brief's check case).
function scoreMetrics(m, cfg) {
  const flags = [...(m.flags || [])];
  const ind = {};

  // Demand size (30)
  {
    const v = num(m.avgImports);
    let pts = 0; let tier = null;
    for (const t of cfg.demandSize.tiers) {
      const hit = t.exclusiveMin ? v > t.minUsd : v >= t.minUsd;
      if (hit) { pts = t.points; tier = t.label; break; }
    }
    ind.demandSize = { value: v, tier, points: pts };
  }

  // Demand growth (25)
  {
    const c = cfg.demandGrowth;
    const pg = m.partnerGrowth;
    const wg = m.worldGrowth;
    const net = m.netChange2y == null ? 0 : num(m.netChange2y);
    const groupA = pg != null && wg != null && pg > 0 && pg > wg;
    let pts;
    let rule;
    if (groupA) {
      if (net >= 0) { pts = c.groupA.netChangeNonNegative; rule = 'a_nonnegative'; }
      else if (net > c.groupA.declineThreshold) { pts = c.groupA.declineLessThanThreshold; rule = 'a_small_decline'; }
      else { pts = c.groupA.declineAtOrBeyondThreshold; rule = 'a_steep_decline'; }
    } else if (net > 0) {
      const aboveAvg = num(m.importsAtT) > num(m.avgImports);
      pts = aboveAvg ? c.groupB.positiveAboveAverage : c.groupB.positiveAtOrBelowAverage;
      rule = aboveAvg ? 'b_positive_above_average' : 'b_positive_at_or_below_average';
    } else { pts = c.groupB.nonPositive; rule = 'b_nonpositive'; }
    ind.demandGrowth = {
      partnerGrowth: pg, worldGrowth: wg, group: groupA ? 'A' : 'B',
      netChange2y: m.netChange2y == null ? null : net,
      importsAtT: num(m.importsAtT), rule, points: pts,
    };
  }

  // Competition and access (20)
  {
    const c = cfg.competitionAccess;
    const aM = num(m.avgImports); const aX = num(m.avgExports);
    let pts; let level;
    if (aM >= c.deficitLevel.ratio * aX && aM > 0) { pts = c.deficitLevel.importsAtLeastRatioOfExports; level = 'deficit'; }
    else if (aX >= c.deficitLevel.ratio * aM) { pts = c.deficitLevel.exportsAtLeastRatioOfImports; level = 'surplus'; }
    else { pts = c.deficitLevel.neither; level = 'balanced'; }
    ind.deficitLevel = { avgImports: aM, avgExports: aX, level, points: pts };

    const held = (a, b) => a != null && b != null && num(a) >= num(b);
    const curHeld = held(m.deficitShareT, m.deficitShareT1);
    const prevHeld = held(m.deficitShareT1, m.deficitShareT2);
    ind.deficitTrendCurrent = { shareT: m.deficitShareT ?? null, shareT1: m.deficitShareT1 ?? null, held: curHeld, points: curHeld ? c.deficitTrend.currentYear : 0 };
    ind.deficitTrendPrevious = { shareT1: m.deficitShareT1 ?? null, shareT2: m.deficitShareT2 ?? null, held: prevHeld, points: prevHeld ? c.deficitTrend.previousYear : 0 };

    const h = m.supplierConcentration;
    let hp; let hl;
    if (h == null) { hp = c.supplierConcentration.high; hl = 'missing'; }
    else if (h < c.supplierConcentration.lowMax) { hp = c.supplierConcentration.low; hl = 'low'; }
    else if (h <= c.supplierConcentration.midMax) { hp = c.supplierConcentration.mid; hl = 'mid'; }
    else { hp = c.supplierConcentration.high; hl = 'high'; }
    ind.supplierConcentration = { value: h ?? null, level: hl, points: hp };

    let position; let tp; let missing = false;
    if (m.georgiaTariff == null || m.competitorsTariff == null) {
      missing = true;
      position = c.tariff.missingDefault;
      if (!flags.some((f) => f.code === 'tariff_missing')) flags.push({ code: 'tariff_missing', default: position });
    } else {
      const diff = num(m.georgiaTariff) - num(m.competitorsTariff);
      if (Math.abs(diff) <= c.tariff.equalBandPercentagePoints) position = 'equal';
      else position = diff < 0 ? 'lower' : 'higher';
    }
    tp = c.tariff[position];
    ind.tariff = { georgiaRate: m.georgiaTariff ?? null, competitorsRate: m.competitorsTariff ?? null, position, missing, points: tp };

    let fit = null; let dp; let dmissing = false;
    if (m.georgiaKm == null || m.avgSupplierKm == null) {
      dmissing = true;
      dp = c.distance[c.distance.missingDefault];
      if (!flags.some((f) => f.code === 'distance_missing')) flags.push({ code: 'distance_missing', default: c.distance.missingDefault });
    } else {
      fit = num(m.georgiaKm) <= num(m.avgSupplierKm);
      dp = fit ? c.distance.fit : c.distance.noFit;
    }
    ind.distance = { georgiaKm: m.georgiaKm ?? null, avgSupplierKm: m.avgSupplierKm ?? null, fit, missing: dmissing, points: dp };
  }

  // Georgia's position (25)
  {
    const c = cfg.georgiaPosition;
    const r = m.rca;
    let rp; let rl;
    if (r == null) { rp = c.rca.none; rl = 'missing'; }
    else if (r >= c.rca.fullMin) { rp = c.rca.full; rl = 'full'; }
    else if (r >= c.rca.partialMin) { rp = c.rca.partial; rl = 'partial'; }
    else { rp = c.rca.none; rl = 'none'; }
    ind.rca = { value: r ?? null, level: rl, points: rp };

    const yrs = num(m.yearsWithExports);
    const ok = yrs >= c.trackRecord.minYearsWithExports;
    ind.trackRecord = { yearsWithExports: yrs, lookbackYears: c.trackRecord.lookbackYears, met: ok, points: ok ? c.trackRecord.points : 0 };

    const sp = m.sharePartnerImports; const sw = m.shareWorldExports;
    const has = sp != null && sw != null && num(sp) < num(sw);
    ind.headroom = { sharePartnerImports: sp ?? null, shareWorldExports: sw ?? null, hasHeadroom: sp == null || sw == null ? null : has, points: has ? c.headroom.points : 0 };
  }

  const blocks = {
    demandSize: ind.demandSize.points,
    demandGrowth: ind.demandGrowth.points,
    competitionAccess: ind.deficitLevel.points + ind.deficitTrendCurrent.points + ind.deficitTrendPrevious.points
      + ind.supplierConcentration.points + ind.tariff.points + ind.distance.points,
    georgiaPosition: ind.rca.points + ind.trackRecord.points + ind.headroom.points,
  };
  const score = blocks.demandSize + blocks.demandGrowth + blocks.competitionAccess + blocks.georgiaPosition;
  return { indicators: ind, blocks, score, flags };
}

// ── Rating with caps ────────────────────────────────────────────────────────
function rate(score, m, cfg) {
  const r = cfg.rating;
  let rating = score >= r.highMin ? 'High' : score >= r.moderateMin ? 'Moderate' : 'Low';
  const ratingBeforeCap = rating;
  let cap = null;
  const capTo = (name, maxRating) => {
    if (RATING_RANK[rating] > RATING_RANK[maxRating]) { rating = maxRating; cap = name; }
  };
  if (num(m.avgImports) < cfg.caps.smallMarket.averageImportsUnderUsd) {
    capTo('small_market', cfg.caps.smallMarket.maxRating);
  }
  if (m.netChange2y != null && num(m.netChange2y) <= cfg.caps.steepDecline.netChangeAtOrBelow) {
    capTo('steep_decline', cfg.caps.steepDecline.maxRating);
  }
  return { rating, ratingBeforeCap, cap };
}

// ── The whole chain for one partner x product ───────────────────────────────
function evaluate(input, cfg) {
  const hs4 = String(input.hs4);
  const T = input.T;
  const g1 = gate1(input.georgia.domesticExportsProduct, input.georgia.latestYears, cfg);
  if (!g1.pass) {
    return { hs4, status: 'gate1_failed', rating: 'Low', gate1: g1 };
  }
  const g2 = gate2(input.partnerImports, T, cfg);
  if (g2.status === 'watch') {
    const years = [];
    const imports = {};
    for (let y = T - g2.consecutiveYears + 1; y <= T; y++) { years.push(y); imports[y] = num(input.partnerImports[y]); }
    return { hs4, status: 'watch', gate1: g1, gate2: g2, yearsWithImports: years, imports };
  }
  if (g2.status === 'none') {
    return { hs4, status: 'none', gate1: g1, gate2: g2 };
  }
  const metrics = computeMetrics(input, g2.windowYears, cfg);
  const scored = scoreMetrics(metrics, cfg);
  const rated = rate(scored.score, metrics, cfg);
  const flags = [...scored.flags];
  if (g2.status === 'new') flags.unshift({ code: 'new_market', years: g2.consecutiveYears });
  if (rated.cap) flags.push({ code: `cap_${rated.cap}`, from: rated.ratingBeforeCap, to: rated.rating });

  const figures = {
    importsByYear: {}, exportsByYear: {}, worldImportsByYear: {}, georgiaExportsToPartnerByYear: {},
  };
  for (const y of g2.windowYears) {
    figures.importsByYear[y] = num(input.partnerImports[y]);
    figures.exportsByYear[y] = num(input.partnerExports[y]);
    figures.worldImportsByYear[y] = num(input.worldImports && input.worldImports[y]);
  }
  for (const y of metrics.trackRecordYears) {
    figures.georgiaExportsToPartnerByYear[y] = num(input.georgia.exportsToPartner && input.georgia.exportsToPartner[y]);
  }
  figures.georgiaDomesticExportsByYear = {};
  for (const y of g1.years) figures.georgiaDomesticExportsByYear[y] = num(input.georgia.domesticExportsProduct[y]);

  return {
    hs4,
    status: 'rated',
    rating: rated.rating,
    ratingBeforeCap: rated.ratingBeforeCap,
    cap: rated.cap,
    score: scored.score,
    blocks: scored.blocks,
    indicators: scored.indicators,
    gate1: { pass: true, years: g1.years, average: g1.average },
    gate2: { consecutiveYears: g2.consecutiveYears, status: g2.status },
    window: { start: g2.windowYears[0], end: g2.windowYears[g2.windowYears.length - 1], years: g2.windowYears },
    flags,
    figures,
  };
}

module.exports = {
  CONFIG_PATH,
  RATINGS,
  loadConfig,
  gate1,
  gate2,
  computeMetrics,
  scoreMetrics,
  rate,
  evaluate,
};
