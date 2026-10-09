/**
 * An invented partner country for previewing the Export Potential page
 * before the data pipeline has produced real result files.
 *
 * Every figure here is made up. The file is built through the real scoring
 * engine (so its points, caps and flags are always consistent with
 * config.json) and is marked `sample: true`; the page shows a banner on it.
 * The first product reproduces the brief's check case (77 points, High,
 * no cap) and the others exercise each path: both caps, a new market,
 * a Low rating, a missing-tariff flag, and the "Markets to watch" list.
 */
'use strict';

const { evaluate, loadConfig } = require('./scoring');

const T = 2025;
const WINDOW = [2021, 2022, 2023, 2024, 2025];
const LATEST = [2023, 2024, 2025];
const M = 1e6; // one million dollars

function series(years, values) {
  const out = {};
  years.forEach((y, i) => { if (values[i] != null) out[y] = values[i]; });
  return out;
}

// Geostat-like totals (domestic exports, all products) and a flat world total.
const GEORGIA_TOTAL = series(WINDOW, [2300 * M, 2500 * M, 2861 * M, 2990 * M, 3360 * M]);
const WORLD_TOTAL = series(WINDOW, [22000e3 * M, 24500e3 * M, 23500e3 * M, 24000e3 * M, 24500e3 * M]);

const SUPPLIER_KM = { 268: 2400, 380: 1200, 250: 1500, 724: 2000, 792: 1500, 840: 8000, 156: 7000, 276: 1000, 616: 900, 643: 1800, 804: 1100, 364: 1300, 51: 2500 };

// spec: { M, X, W: arrays over WINDOW in $M; suppliers: {code: share};
//         tariff: {georgia, others} | null; georgiaKm; geoProd, geoToPartner (arrays, $M);
//         worldProd ($M per year, constant) }
function build(hs4, s) {
  const supplierImports = {};
  const totalWindow = s.M.reduce((a, b) => a + (b || 0), 0) * M;
  for (const [code, share] of Object.entries(s.suppliers)) {
    supplierImports[code] = {};
    WINDOW.forEach((y, i) => { supplierImports[code][y] = (s.M[i] || 0) * M * share; });
  }
  const supplierRates = {};
  const supplierKm = {};
  for (const code of Object.keys(s.suppliers)) {
    supplierRates[code] = code === '268' ? (s.tariff ? s.tariff.georgia : null) : (s.tariff ? s.tariff.others : null);
    supplierKm[code] = SUPPLIER_KM[code] || 3000;
  }
  if (s.georgiaKm != null) supplierKm[268] = s.georgiaKm;
  return evaluate({
    hs4,
    T,
    partnerImports: series(WINDOW, s.M.map((v) => (v == null ? 0 : v * M))),
    partnerExports: series(WINDOW, s.X.map((v) => v * M)),
    worldImports: series(WINDOW, s.W.map((v) => v * M)),
    supplierImports,
    georgia: {
      latestYears: LATEST,
      trackRecordYears: WINDOW,
      domesticExportsProduct: series(WINDOW, s.geoProd.map((v) => v * M)),
      domesticExportsTotal: GEORGIA_TOTAL,
      exportsToPartner: series(WINDOW, s.geoToPartner.map((v) => v * M)),
    },
    world: {
      exportsProduct: series(WINDOW, WINDOW.map(() => s.worldProd * M)),
      exportsTotal: WORLD_TOTAL,
    },
    tariff: s.tariff ? { georgiaRate: s.tariff.georgia, supplierRates } : null,
    distance: { georgiaKm: s.georgiaKm != null ? s.georgiaKm : SUPPLIER_KM[268], supplierKm },
  }, loadConfig());
  void totalWindow;
}

const PRODUCTS = [
  // The brief's check case: $35M-scale market growing 6% a year against 3%
  // for the world, deficit, concentration 0.45, Georgia tariff-advantaged
  // but far, strong RCA, thin track record, headroom. 77 points, High.
  ['2204', {
    M: [28.0, 29.7, 31.5, 33.4, 35.4], X: [5, 5, 5, 5, 5], W: [40000, 41200, 42400, 43700, 45000],
    suppliers: { 380: 0.60, 250: 0.25, 724: 0.10, 268: 0.05 }, tariff: { georgia: 0, others: 5 }, georgiaKm: 2400,
    geoProd: [237, 251, 258, 275, 267], geoToPartner: [0, 0, 0, 0.15, 0.2], worldProd: 40000,
  }],
  // Steep recent decline: High on points, capped to Moderate.
  ['0802', {
    M: [60, 70, 90, 80, 75], X: [10, 10, 10, 10, 10], W: [10000, 10200, 10400, 10600, 10800],
    suppliers: { 792: 0.50, 840: 0.30, 268: 0.15, 380: 0.05 }, tariff: { georgia: 0, others: 3 }, georgiaKm: 1000,
    geoProd: [95, 110, 120, 118, 125], geoToPartner: [9, 10, 12, 11, 11], worldProd: 12000,
  }],
  // Small market: High on points, capped to Moderate.
  ['2201', {
    M: [1.0, 1.2, 1.4, 1.6, 1.9], X: [0.1, 0.1, 0.1, 0.1, 0.1], W: [3000, 3100, 3250, 3400, 3500],
    suppliers: { 380: 0.2, 250: 0.2, 276: 0.2, 616: 0.2, 268: 0.2 }, tariff: { georgia: 0, others: 4 }, georgiaKm: 900,
    geoProd: [140, 150, 156, 160, 170], geoToPartner: [0.2, 0.25, 0.3, 0.3, 0.35], worldProd: 3000,
  }],
  // New market: imports only since 2023, so a three-year window. Tariff
  // data missing, scored as Equal and flagged.
  ['7202', {
    M: [null, null, 12, 15, 14], X: [20, 20, 20, 20, 20], W: [60000, 61000, 62000, 65000, 68000],
    suppliers: { 156: 0.9, 268: 0.1 }, tariff: null, georgiaKm: 1200,
    geoProd: [220, 240, 243, 235, 250], geoToPartner: [0, 0, 0, 0, 4], worldProd: 70000,
  }],
  // Low: shrinking surplus market, one dominant supplier, higher tariff.
  ['3102', {
    M: [9, 8, 7, 6.5, 6], X: [30, 30, 30, 30, 30], W: [30000, 31000, 29000, 28500, 28000],
    suppliers: { 643: 0.85, 268: 0.10, 804: 0.05 }, tariff: { georgia: 5, others: 0 }, georgiaKm: 2500,
    geoProd: [120, 130, 136, 140, 131], geoToPartner: [0.5, 0, 0.6, 0, 0.7], worldProd: 90000,
  }],
  // Moderate: group B growth, balanced tariffs, partial RCA.
  ['2208', {
    M: [20, 18, 19, 21, 24], X: [8, 8, 8, 8, 8], W: [50000, 52000, 55000, 58000, 62000],
    suppliers: { 826: 0.3, 250: 0.3, 840: 0.2, 380: 0.15, 268: 0.05 }, tariff: { georgia: 10, others: 10.2 }, georgiaKm: 2400,
    geoProd: [180, 200, 210, 215, 217], geoToPartner: [0, 0, 0, 1.0, 1.2], worldProd: 70000,
  }],
  // High: large, fast-growing deficit market where Georgia already sells.
  ['6109', {
    M: [150, 160, 170, 185, 200], X: [50, 50, 50, 50, 50], W: [45000, 46000, 47500, 49000, 50500],
    suppliers: { 156: 0.6, 792: 0.2, 50: 0.1, 268: 0.1 }, tariff: { georgia: 0, others: 8 }, georgiaKm: 2400,
    geoProd: [60, 66, 68, 70, 69], geoToPartner: [3, 4, 5, 5, 6], worldProd: 50000,
  }],
  // Moderate: group A growth with a small recent decline.
  ['2616', {
    M: [5, 6, 8, 9, 8.5], X: [0, 0, 0, 0, 0], W: [20000, 21000, 23000, 26000, 29000],
    suppliers: { 51: 0.9, 268: 0.1 }, tariff: { georgia: 2, others: 2 }, georgiaKm: 2500,
    geoProd: [180, 200, 220, 230, 227], geoToPartner: [0, 0, 0, 0, 0], worldProd: 90000,
  }],
  // Markets to watch: one and two years of imports.
  ['0806', {
    M: [null, null, null, 0.4, 0.9], X: [0, 0, 0, 0, 0], W: [9000, 9000, 9000, 9000, 9000],
    suppliers: { 792: 1 }, tariff: null, geoProd: [40, 45, 50, 52, 55], geoToPartner: [0, 0, 0, 0, 0], worldProd: 10000,
  }],
  ['2009', {
    M: [null, null, null, null, 0.3], X: [0, 0, 0, 0, 0], W: [15000, 15000, 15000, 15000, 15000],
    suppliers: { 792: 1 }, tariff: null, geoProd: [20, 22, 24, 25, 26], geoToPartner: [0, 0, 0, 0, 0], worldProd: 16000,
  }],
];

function buildSampleResult() {
  const products = [];
  const watch = [];
  for (const [hs4, spec] of PRODUCTS) {
    const r = build(hs4, spec);
    if (r.status === 'rated') products.push(r);
    else if (r.status === 'watch') watch.push({ hs4: r.hs4, yearsWithImports: r.yearsWithImports, imports: r.imports });
  }
  return {
    schemaVersion: 1,
    sample: true,
    partner: { iso3: 'SMP', m49: null, iso2: null, nameEn: 'Sample country (invented data)', nameKa: 'სანიმუშო ქვეყანა (გამოგონილი მონაცემები)' },
    dataYear: T,
    window: { start: WINDOW[0], end: T, years: WINDOW },
    tradeSource: { id: 'sample', label: 'Invented sample data', edition: 'HS2022' },
    georgiaSource: { id: 'sample', label: 'Invented sample data', latestYears: LATEST },
    pipeline: { runDate: null, asOfYear: T, note: 'Built in memory by server/export-potential/sample.js' },
    products,
    watch,
  };
}

module.exports = { buildSampleResult };
