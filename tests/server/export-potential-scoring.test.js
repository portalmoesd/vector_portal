const test = require('node:test');
const assert = require('node:assert');
const {
  loadConfig, gate1, gate2, computeMetrics, scoreMetrics, rate, evaluate,
} = require('../../server/export-potential/scoring');

const cfg = loadConfig();
const M = 1e6;

// The brief's check case, given as indicator values: 77 points, High, no cap.
function checkCaseMetrics() {
  return {
    avgImports: 35 * M,
    importsAtT: 36 * M,
    partnerGrowth: 0.06,
    worldGrowth: 0.03,
    netChange2y: 0.04,
    avgExports: 5 * M,
    deficitShareT: 0.86, deficitShareT1: 0.86, deficitShareT2: 0.86,
    supplierConcentration: 0.45,
    georgiaTariff: 0, competitorsTariff: 5,
    georgiaKm: 2400, avgSupplierKm: 1500,
    rca: 3.2,
    yearsWithExports: 2,
    sharePartnerImports: 0.005, shareWorldExports: 0.012,
    flags: [],
  };
}

function scoreOf(overrides) {
  const m = { ...checkCaseMetrics(), ...overrides };
  const s = scoreMetrics(m, cfg);
  return { ...s, ...rate(s.score, m, cfg), m };
}

test('check case scores 77 points, High, no cap', () => {
  const r = scoreOf({});
  assert.strictEqual(r.score, 77);
  assert.strictEqual(r.rating, 'High');
  assert.strictEqual(r.cap, null);
  assert.deepStrictEqual(r.blocks, { demandSize: 20, demandGrowth: 25, competitionAccess: 15, georgiaPosition: 17 });
  const i = r.indicators;
  assert.strictEqual(i.demandSize.points, 20);
  assert.strictEqual(i.demandGrowth.points, 25);
  assert.strictEqual(i.deficitLevel.points, 4);
  assert.strictEqual(i.deficitTrendCurrent.points, 1);
  assert.strictEqual(i.deficitTrendPrevious.points, 1);
  assert.strictEqual(i.supplierConcentration.points, 3);
  assert.strictEqual(i.tariff.points, 6);
  assert.strictEqual(i.distance.points, 0);
  assert.strictEqual(i.rca.points, 10);
  assert.strictEqual(i.trackRecord.points, 0);
  assert.strictEqual(i.headroom.points, 7);
  assert.strictEqual(r.flags.length, 0);
});

test('demand size tiers and their boundaries', () => {
  const pts = (usd) => scoreOf({ avgImports: usd }).indicators.demandSize.points;
  assert.strictEqual(pts(100 * M + 1), 30);
  assert.strictEqual(pts(100 * M), 25);   // "over $100M" is strict
  assert.strictEqual(pts(50 * M), 25);
  assert.strictEqual(pts(50 * M - 1), 20);
  assert.strictEqual(pts(10 * M), 20);
  assert.strictEqual(pts(10 * M - 1), 12);
  assert.strictEqual(pts(2 * M), 12);
  assert.strictEqual(pts(2 * M - 1), 5);
  assert.strictEqual(pts(0), 5);
});

test('demand growth: group A rows', () => {
  const pts = (o) => scoreOf(o).indicators.demandGrowth.points;
  assert.strictEqual(pts({ netChange2y: 0 }), 25);
  assert.strictEqual(pts({ netChange2y: -0.0999 }), 18);
  assert.strictEqual(pts({ netChange2y: -0.10 }), 8);
  assert.strictEqual(pts({ netChange2y: -0.5 }), 8);
});

test('demand growth: group B rows', () => {
  const pts = (o) => scoreOf(o).indicators.demandGrowth.points;
  // partner growth not above world growth -> group B
  assert.strictEqual(scoreOf({ partnerGrowth: 0.03, worldGrowth: 0.03 }).indicators.demandGrowth.group, 'B');
  assert.strictEqual(scoreOf({ partnerGrowth: -0.01, worldGrowth: -0.05 }).indicators.demandGrowth.group, 'B');
  assert.strictEqual(pts({ partnerGrowth: 0.01, worldGrowth: 0.02, netChange2y: 0.05, importsAtT: 36 * M, avgImports: 35 * M }), 15);
  assert.strictEqual(pts({ partnerGrowth: 0.01, worldGrowth: 0.02, netChange2y: 0.05, importsAtT: 35 * M, avgImports: 35 * M }), 8);
  assert.strictEqual(pts({ partnerGrowth: 0.01, worldGrowth: 0.02, netChange2y: 0 }), 0);
  assert.strictEqual(pts({ partnerGrowth: 0.01, worldGrowth: 0.02, netChange2y: -0.3 }), 0);
});

test('trade deficit level and trend', () => {
  const lvl = (m, x) => scoreOf({ avgImports: m, avgExports: x }).indicators.deficitLevel.points;
  assert.strictEqual(lvl(10 * M, 5 * M), 4);
  assert.strictEqual(lvl(10 * M, 5 * M + 1), 2);
  assert.strictEqual(lvl(5 * M, 10 * M), 0);
  assert.strictEqual(lvl(6 * M, 10 * M), 2);
  const tr = scoreOf({ deficitShareT: 0.5, deficitShareT1: 0.6, deficitShareT2: 0.6 });
  assert.strictEqual(tr.indicators.deficitTrendCurrent.points, 0);
  assert.strictEqual(tr.indicators.deficitTrendPrevious.points, 1);
});

test('supplier concentration boundaries', () => {
  const pts = (h) => scoreOf({ supplierConcentration: h }).indicators.supplierConcentration.points;
  assert.strictEqual(pts(0.399), 6);
  assert.strictEqual(pts(0.4), 3);
  assert.strictEqual(pts(0.6), 3);
  assert.strictEqual(pts(0.601), 0);
});

test('tariff position, the equal band and the missing-data default', () => {
  const r = (g, c) => scoreOf({ georgiaTariff: g, competitorsTariff: c }).indicators.tariff;
  assert.strictEqual(r(0, 5).points, 6);
  assert.strictEqual(r(4.5, 5).points, 3);
  assert.strictEqual(r(5.5, 5).points, 3);
  assert.strictEqual(r(5.6, 5).points, 0);
  const missing = scoreOf({ georgiaTariff: null, competitorsTariff: null });
  assert.strictEqual(missing.indicators.tariff.points, 3);
  assert.strictEqual(missing.indicators.tariff.missing, true);
  assert.ok(missing.flags.some((f) => f.code === 'tariff_missing' && f.default === 'equal'));
});

test('distance fit', () => {
  assert.strictEqual(scoreOf({ georgiaKm: 1500, avgSupplierKm: 1500 }).indicators.distance.points, 2);
  assert.strictEqual(scoreOf({ georgiaKm: 1501, avgSupplierKm: 1500 }).indicators.distance.points, 0);
  const missing = scoreOf({ georgiaKm: null });
  assert.strictEqual(missing.indicators.distance.points, 0);
  assert.ok(missing.flags.some((f) => f.code === 'distance_missing'));
});

test("Georgia's position: RCA tiers, track record, headroom", () => {
  const rca = (v) => scoreOf({ rca: v }).indicators.rca.points;
  assert.strictEqual(rca(1), 10);
  assert.strictEqual(rca(0.999), 5);
  assert.strictEqual(rca(0.7), 5);
  assert.strictEqual(rca(0.699), 0);
  assert.strictEqual(scoreOf({ yearsWithExports: 3 }).indicators.trackRecord.points, 8);
  assert.strictEqual(scoreOf({ yearsWithExports: 2 }).indicators.trackRecord.points, 0);
  assert.strictEqual(scoreOf({ sharePartnerImports: 0.012, shareWorldExports: 0.012 }).indicators.headroom.points, 0);
  assert.strictEqual(scoreOf({ sharePartnerImports: 0.0119, shareWorldExports: 0.012 }).indicators.headroom.points, 7);
});

test('rating boundaries', () => {
  const m = checkCaseMetrics();
  assert.strictEqual(rate(65, m, cfg).rating, 'High');
  assert.strictEqual(rate(64, m, cfg).rating, 'Moderate');
  assert.strictEqual(rate(40, m, cfg).rating, 'Moderate');
  assert.strictEqual(rate(39, m, cfg).rating, 'Low');
});

test('small market cap: average imports under $2M cannot be High', () => {
  // A tiny deficit market with everything else in Georgia's favour: 70
  // points, High on points alone.
  const small = { avgImports: 2 * M - 1, importsAtT: 2.2 * M, avgExports: 0.5 * M, netChange2y: 0.2, yearsWithExports: 5 };
  const r = scoreOf(small);
  assert.strictEqual(r.score, 70);
  assert.strictEqual(r.rating, 'Moderate');
  assert.strictEqual(r.ratingBeforeCap, 'High');
  assert.strictEqual(r.cap, 'small_market');
  const ok = scoreOf({ ...small, avgImports: 2 * M });
  assert.strictEqual(ok.rating, 'High');
  assert.strictEqual(ok.cap, null);
});

test('steep decline cap: a two-year change of -10% or worse cannot be High', () => {
  // Decline of 10% in group A gives 8 growth points: 60 total, Moderate on
  // points alone, so lift the track record to push it over 65 first.
  const r = scoreOf({ netChange2y: -0.10, yearsWithExports: 5 });
  assert.strictEqual(r.score, 68);
  assert.strictEqual(r.rating, 'Moderate');
  assert.strictEqual(r.cap, 'steep_decline');
  const notQuite = scoreOf({ netChange2y: -0.0999, yearsWithExports: 5 });
  assert.strictEqual(notQuite.rating, 'High');
  assert.strictEqual(notQuite.cap, null);
});

test('a cap that does not change the rating is not recorded', () => {
  const r = scoreOf({ avgImports: 1 * M, netChange2y: -0.5, rca: 0, yearsWithExports: 0, sharePartnerImports: 0.1, shareWorldExports: 0.01 });
  assert.strictEqual(r.rating, 'Low');
  assert.strictEqual(r.cap, null);
});

test('gate 1: average over the latest three years and above zero in each', () => {
  const years = [2023, 2024, 2025];
  assert.strictEqual(gate1({ 2023: 1.2 * M, 2024: 0.9 * M, 2025: 0.9 * M }, years, cfg).pass, true);
  assert.strictEqual(gate1({ 2023: 3 * M, 2024: 0, 2025: 3 * M }, years, cfg).pass, false);
  assert.strictEqual(gate1({ 2023: M, 2024: M, 2025: M - 3 }, years, cfg).pass, false);
  // Extra older years are ignored; only the latest three count.
  assert.strictEqual(gate1({ 2021: 0, 2022: 0, 2023: M, 2024: M, 2025: M }, [2021, 2022, 2023, 2024, 2025], cfg).pass, true);
});

test('gate 2: consecutive years of imports decide the window', () => {
  const T = 2025;
  const g = (vals) => gate2(Object.fromEntries([2021, 2022, 2023, 2024, 2025].map((y, i) => [y, vals[i]])), T, cfg);
  let r = g([1, 1, 1, 1, 1]);
  assert.strictEqual(r.status, 'established');
  assert.deepStrictEqual(r.windowYears, [2021, 2022, 2023, 2024, 2025]);
  r = g([0, 1, 1, 1, 1]);
  assert.strictEqual(r.status, 'new');
  assert.deepStrictEqual(r.windowYears, [2022, 2023, 2024, 2025]);
  r = g([0, 0, 1, 1, 1]);
  assert.strictEqual(r.status, 'new');
  assert.deepStrictEqual(r.windowYears, [2023, 2024, 2025]);
  assert.strictEqual(g([0, 0, 0, 1, 1]).status, 'watch');
  assert.strictEqual(g([0, 0, 0, 0, 1]).status, 'watch');
  assert.strictEqual(g([0, 0, 0, 0, 0]).status, 'none');
  // A gap breaks the run: imports in 2021-2023 but none in 2024 count as 1 year.
  r = g([1, 1, 1, 0, 1]);
  assert.strictEqual(r.consecutiveYears, 1);
  assert.strictEqual(r.status, 'watch');
});

// ── Raw series through computeMetrics ──────────────────────────────────────

function rawInput(overrides = {}) {
  const years = [2021, 2022, 2023, 2024, 2025];
  const s = (vals) => Object.fromEntries(years.map((y, i) => [y, vals[i]]));
  const base = {
    hs4: '2204',
    T: 2025,
    partnerImports: s([28 * M, 29.7 * M, 31.5 * M, 33.4 * M, 35.4 * M]),
    partnerExports: s([5 * M, 5 * M, 5 * M, 5 * M, 5 * M]),
    worldImports: s([40000 * M, 41200 * M, 42400 * M, 43700 * M, 45000 * M]),
    supplierImports: {
      380: s([16.8 * M, 17.8 * M, 18.9 * M, 20.0 * M, 21.2 * M]),
      250: s([7 * M, 7.4 * M, 7.9 * M, 8.4 * M, 8.9 * M]),
      724: s([2.8 * M, 3 * M, 3.2 * M, 3.3 * M, 3.5 * M]),
      268: s([1.4 * M, 1.5 * M, 1.5 * M, 1.7 * M, 1.8 * M]),
    },
    georgia: {
      latestYears: [2023, 2024, 2025],
      trackRecordYears: years,
      domesticExportsProduct: s([237 * M, 251 * M, 258 * M, 275 * M, 267 * M]),
      domesticExportsTotal: s([2300 * M, 2500 * M, 2861 * M, 2990 * M, 3360 * M]),
      exportsToPartner: s([0, 0, 0, 0.15 * M, 0.2 * M]),
    },
    world: {
      exportsProduct: s(years.map(() => 40000 * M)),
      exportsTotal: s(years.map(() => 24000e3 * M)),
    },
    tariff: { georgiaRate: 0, supplierRates: { 380: 5, 250: 5, 724: 5, 268: 0 } },
    distance: { georgiaKm: 2400, supplierKm: { 380: 1200, 250: 1500, 724: 2000, 268: 2400 } },
  };
  return { ...base, ...overrides };
}

test('computeMetrics reproduces the check case from raw yearly series', () => {
  const input = rawInput();
  const m = computeMetrics(input, [2021, 2022, 2023, 2024, 2025], cfg);
  assert.ok(Math.abs(m.partnerGrowth - 0.06) < 0.002);
  assert.ok(Math.abs(m.worldGrowth - 0.03) < 0.002);
  assert.ok(Math.abs(m.supplierConcentration - 0.435) < 0.01);
  assert.strictEqual(m.georgiaTariff, 0);
  assert.strictEqual(m.competitorsTariff, 5);
  assert.strictEqual(m.yearsWithExports, 2);
  assert.ok(m.sharePartnerImports < m.shareWorldExports);
  const r = evaluate(input, cfg);
  assert.strictEqual(r.status, 'rated');
  assert.strictEqual(r.score, 77);
  assert.strictEqual(r.rating, 'High');
  assert.strictEqual(r.cap, null);
  assert.deepStrictEqual(r.window.years, [2021, 2022, 2023, 2024, 2025]);
});

test('new-market path: shorter window, world growth over the same years, flag set', () => {
  const input = rawInput();
  input.partnerImports = { 2021: 0, 2022: 0, 2023: 12 * M, 2024: 15 * M, 2025: 14 * M };
  input.worldImports = { 2021: 1, 2022: 1, 2023: 60000 * M, 2024: 65000 * M, 2025: 68000 * M };
  const r = evaluate(input, cfg);
  assert.strictEqual(r.status, 'rated');
  assert.strictEqual(r.gate2.status, 'new');
  assert.deepStrictEqual(r.window.years, [2023, 2024, 2025]);
  assert.ok(r.flags.some((f) => f.code === 'new_market' && f.years === 3));
  // Growth measured 2023 -> 2025 only: (14/12)^(1/2) - 1 and (68000/60000)^(1/2) - 1.
  assert.ok(Math.abs(r.indicators.demandGrowth.partnerGrowth - (Math.sqrt(14 / 12) - 1)) < 1e-9);
  assert.ok(Math.abs(r.indicators.demandGrowth.worldGrowth - (Math.sqrt(68000 / 60000) - 1)) < 1e-9);
  assert.strictEqual(r.indicators.demandSize.value, (12 + 15 + 14) / 3 * M);
});

test('markets-to-watch path: one or two years of imports, not rated', () => {
  const input = rawInput();
  input.partnerImports = { 2021: 0, 2022: 0, 2023: 0, 2024: 0.4 * M, 2025: 0.9 * M };
  const r = evaluate(input, cfg);
  assert.strictEqual(r.status, 'watch');
  assert.deepStrictEqual(r.yearsWithImports, [2024, 2025]);
  assert.deepStrictEqual(r.imports, { 2024: 0.4 * M, 2025: 0.9 * M });
  assert.strictEqual(r.score, undefined);
});

test('gate 1 failure is Low and not scored', () => {
  const input = rawInput();
  input.georgia.domesticExportsProduct = { 2023: 0.5 * M, 2024: 0.6 * M, 2025: 0.4 * M };
  const r = evaluate(input, cfg);
  assert.strictEqual(r.status, 'gate1_failed');
  assert.strictEqual(r.rating, 'Low');
  assert.strictEqual(r.score, undefined);
});

test('missing tariff data in raw input is defaulted and flagged, never silent', () => {
  const input = rawInput({ tariff: null });
  const r = evaluate(input, cfg);
  assert.strictEqual(r.indicators.tariff.points, 3);
  assert.ok(r.flags.some((f) => f.code === 'tariff_missing'));
  assert.strictEqual(r.score, 74);
});

test('every number used by the engine lives in the configuration file', () => {
  const src = require('fs').readFileSync(require.resolve('../../server/export-potential/scoring.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Money, point, year and percentage thresholds must not appear inline.
  for (const literal of ['1000000', '100000000', '2000000', '0.4', '0.6', '0.7', '0.5', '65', '40', '25', '30']) {
    const re = new RegExp(`(?<![\\w.])${literal.replace('.', '\\.')}(?![\\w.])`);
    assert.ok(!re.test(code), `scoring.js hard-codes ${literal}`);
  }
});
