const test = require('node:test');
const assert = require('node:assert');
const { aggregateWorldRows, aggregateSupplierRows, buildInput } = require('../../server/export-potential/pipeline/build');
const { toHs2022, NEW_IN_HS2022 } = require('../../server/export-potential/pipeline/concordance');
const { distanceKm } = require('../../server/export-potential/pipeline/geodist');
const { loadConfig, evaluate } = require('../../server/export-potential/scoring');

test('concordance maps deleted HS2017 headings onto HS2022 and leaves others alone', () => {
  assert.strictEqual(toHs2022('8803', 'H5'), '8807');
  assert.strictEqual(toHs2022(8803, 'H6'), '8803');
  assert.strictEqual(toHs2022('2204', 'H5'), '2204');
  assert.strictEqual(toHs2022('6908', 'H4'), '6907');
  assert.strictEqual(toHs2022('101', 'H6'), '0101');
  assert.ok(NEW_IN_HS2022.includes('8806'));
});

test('world rows aggregate per reporter and across reporters, with concordance applied', () => {
  const rows = [
    { reporterISO: 'TUR', period: 2021, flowCode: 'M', partnerCode: 0, cmdCode: '2204', classificationCode: 'H5', primaryValue: 10 },
    { reporterISO: 'TUR', period: 2021, flowCode: 'M', partnerCode: 0, cmdCode: '8803', classificationCode: 'H5', primaryValue: 5 },
    { reporterISO: 'DEU', period: 2021, flowCode: 'M', partnerCode: 0, cmdCode: '8807', classificationCode: 'H6', primaryValue: 7 },
    { reporterISO: 'DEU', period: 2021, flowCode: 'X', partnerCode: 0, cmdCode: '2204', classificationCode: 'H6', primaryValue: 3 },
    { reporterISO: 'DEU', period: 2021, flowCode: 'M', partnerCode: 268, cmdCode: '2204', classificationCode: 'H6', primaryValue: 99 }, // not a world row
  ];
  const acc = aggregateWorldRows(rows, {});
  assert.strictEqual(acc.world.imports['2204'][2021], 10);
  assert.strictEqual(acc.world.imports['8807'][2021], 12);
  assert.strictEqual(acc.world.exports['2204'][2021], 3);
  assert.strictEqual(acc.world.exportsTotal[2021], 3);
  assert.strictEqual(acc.byReporter.TUR.imports['8807'][2021], 5);
  assert.strictEqual(acc.byReporter.DEU.exports['2204'][2021], 3);
});

test('supplier rows exclude the world row and keep partner ISO codes', () => {
  const rows = [
    { reporterISO: 'TUR', period: 2025, flowCode: 'M', partnerCode: 0, partnerISO: 'W00', cmdCode: '2204', classificationCode: 'H6', primaryValue: 100 },
    { reporterISO: 'TUR', period: 2025, flowCode: 'M', partnerCode: 268, partnerISO: 'GEO', cmdCode: '2204', classificationCode: 'H6', primaryValue: 40 },
    { reporterISO: 'TUR', period: 2025, flowCode: 'M', partnerCode: 380, partnerISO: 'ITA', cmdCode: '2204', classificationCode: 'H6', primaryValue: 60 },
  ];
  const { suppliers, supplierIso } = aggregateSupplierRows(rows);
  assert.deepStrictEqual(Object.keys(suppliers['2204']).sort(), ['268', '380']);
  assert.strictEqual(suppliers['2204']['268'][2025], 40);
  assert.strictEqual(supplierIso['380'], 'ITA');
});

test('GeoDist lookup resolves aliases and is symmetric', () => {
  assert.strictEqual(distanceKm('GEO', 'TUR'), distanceKm('TUR', 'GEO'));
  assert.ok(distanceKm('GEO', 'TUR') > 1000 && distanceKm('GEO', 'TUR') < 1500);
  assert.ok(distanceKm('GEO', 'ROU') > 0);   // Romania is ROM in GeoDist
  assert.ok(distanceKm('DEU', 'S19') > 0);   // Comtrade's "Other Asia, nes" read as Taiwan
  assert.strictEqual(distanceKm('GEO', 'ZZZ'), null);
});

test('buildInput wires the tables into an evaluate() input that scores', () => {
  const cfg = loadConfig();
  const years = [2021, 2022, 2023, 2024, 2025];
  const s = (vals) => Object.fromEntries(years.map((y, i) => [y, vals[i]]));
  const M = 1e6;
  const partner = {
    iso3: 'TUR',
    imports: { 2204: s([28 * M, 29.7 * M, 31.5 * M, 33.4 * M, 35.4 * M]) },
    exports: { 2204: s([5 * M, 5 * M, 5 * M, 5 * M, 5 * M]) },
    suppliers: { 2204: { 380: s([16 * M, 17 * M, 18 * M, 19 * M, 20 * M]), 268: s([2 * M, 2 * M, 2 * M, 2 * M, 2 * M]) } },
    supplierIso: { 380: 'ITA', 268: 'GEO' },
  };
  const world = { imports: { 2204: s([40000 * M, 41200 * M, 42400 * M, 43700 * M, 45000 * M]) }, exports: { 2204: s(years.map(() => 40000 * M)) }, exportsTotal: s(years.map(() => 24e9 * M)) };
  const georgia = { products: { 2204: s([237 * M, 251 * M, 258 * M, 275 * M, 267 * M]) }, total: s([2300 * M, 2500 * M, 2861 * M, 2990 * M, 3360 * M]), destinations: { 2204: { 792: s([1 * M, 1.5 * M, 2 * M, 2 * M, 2 * M]) } } };
  const input = buildInput({ hs4: '2204', T: 2025, partner, world, georgia, georgiaLatestYears: [2023, 2024, 2025], trackRecordYears: years, distances: (a, b) => distanceKm(a, b), geostatIdOfPartner: 792, georgiaCode: '268' });
  assert.strictEqual(input.tariff, null);
  assert.ok(input.distance.georgiaKm > 0);
  assert.ok(input.distance.supplierKm['380'] > 0);
  assert.strictEqual(input.georgia.exportsToPartner[2025], 2 * M);
  const r = evaluate(input, cfg);
  assert.strictEqual(r.status, 'rated');
  assert.ok(r.flags.some((f) => f.code === 'tariff_missing'));
  assert.strictEqual(r.indicators.tariff.points, 3);
  assert.strictEqual(r.indicators.trackRecord.points, 8);
  assert.strictEqual(r.indicators.distance.fit, true); // Georgia is nearer Türkiye than Italy is
});

test('cache keys differ per request and ignore property order', () => {
  const { cacheKey, canonical } = require('../../server/export-potential/pipeline/cache');
  assert.strictEqual(cacheKey({ a: 1, b: [1, 2] }), cacheKey({ b: [1, 2], a: 1 }));
  assert.notStrictEqual(cacheKey({ geostat: { path: '/classificatory?lang=en', body: null } }), cacheKey({ geostat: { path: '/get_data', body: { years: [2025] } } }));
  assert.notStrictEqual(cacheKey({ trade: { reporterCode: 792, period: 2025 } }), cacheKey({ trade: { reporterCode: 792, period: 2024 } }));
  assert.strictEqual(canonical({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
});

test('result rounding keeps ratios and rounds money and distances', () => {
  const { roundDeep } = require('../../server/export-potential/pipeline/run');
  assert.deepStrictEqual(roundDeep({ usd: 48718570.6, rca: 1.23456789, share: 0.0204029830891, km: 2707.96, growth: -0.312545241525, years: [2021], nested: { v: 0.5 } }),
    { usd: 48718571, rca: 1.234568, share: 0.020403, km: 2708, growth: -0.312545, years: [2021], nested: { v: 0.5 } });
});
