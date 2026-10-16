const test = require('node:test');
const assert = require('node:assert');
const cp = require('../../server/country-profiles/comtrade-products');

test('topProducts ranks HS4 headings by share of the HS4 total, ignoring TOTAL and chapter rows', () => {
  const rows = [
    { cmdCode: 'TOTAL', primaryValue: 1000 },
    { cmdCode: '87', primaryValue: 400 },
    { cmdCode: '8703', primaryValue: 400 },
    { cmdCode: '2204', primaryValue: 250 },
    { cmdCode: '7202', primaryValue: 150 },
    { cmdCode: '2603', primaryValue: 100 },
    { cmdCode: '0802', primaryValue: 60 },
    { cmdCode: '3004', primaryValue: 40 },
    { cmdCode: '9999', primaryValue: 0 },
    { cmdCode: '1234', primaryValue: 'n/a' },
  ];
  const top = cp.topProducts(rows, 5);
  assert.deepStrictEqual(top.map((p) => p.hs4), ['8703', '2204', '7202', '2603', '0802']);
  assert.deepStrictEqual(top.map((p) => p.rank), [1, 2, 3, 4, 5]);
  assert.ok(Math.abs(top[0].share - 0.4) < 1e-9);
  assert.ok(Math.abs(top[4].share - 0.06) < 1e-9);
  // Shares are of the HS4 sum (1000), not of the TOTAL row.
  const sum = top.reduce((a, p) => a + p.share, 0);
  assert.ok(sum < 1 && sum > 0.95);
});

test('topProducts merges duplicate codes, breaks ties by code, and returns [] with nothing to rank', () => {
  const top = cp.topProducts([
    { cmdCode: '0101', primaryValue: 10 }, { cmdCode: '0101', primaryValue: 10 },
    { cmdCode: '0102', primaryValue: 20 }, { cmdCode: '0103', primaryValue: 5 },
  ], 2);
  // 0101 merges to 20, ties with 0102 (20) and wins on code; total is 45.
  assert.deepStrictEqual(top.map((p) => p.hs4), ['0101', '0102']);
  for (const p of top) assert.ok(Math.abs(p.share - 20 / 45) < 1e-9);
  assert.deepStrictEqual(cp.topProducts([], 5), []);
  assert.deepStrictEqual(cp.topProducts([{ cmdCode: 'TOTAL', primaryValue: 5 }], 5), []);
  assert.deepStrictEqual(cp.topProducts(null, 5), []);
});

test('latestYearFor picks the newest annual HS year of the reporter', () => {
  const da = [
    { reporterCode: 268, period: 2023, classificationCode: 'H6' },
    { reporterCode: 268, period: 2025, classificationCode: 'H6' },
    { reporterCode: 268, period: 2024, classificationCode: 'H6' },
    { reporterCode: 276, period: 2024, classificationCode: 'H6' },
    { reporterCode: 268, period: 2026, classificationCode: 'S4' }, // SITC, not HS
  ];
  assert.strictEqual(cp.latestYearFor(da, 268), 2025);
  assert.strictEqual(cp.latestYearFor(da, '276'), 2024);
  assert.strictEqual(cp.latestYearFor(da, 999), null);
});

test('pickReporter resolves duplicate ISO3 areas to the one with recent data, never a historical one', () => {
  const da = [
    { reporterCode: 276, period: 2025, classificationCode: 'H6' },
    { reporterCode: 276, period: 2024, classificationCode: 'H6' },
    { reporterCode: 842, period: 2024, classificationCode: 'H6' },
    { reporterCode: 840, period: 2024, classificationCode: 'H6' },
    { reporterCode: 757, period: 2025, classificationCode: 'H6' },
  ];
  // Germany: the historical area comes first in the reference file and has no data.
  assert.deepStrictEqual(cp.pickReporter([{ code: 280, text: 'Fed. Rep. of Germany (...1990)' }, { code: 276, text: 'Germany' }], da), { code: 276, year: 2025 });
  // Tie on year: prefer the area without a closing year in its name; a plain tie keeps the first.
  assert.deepStrictEqual(cp.pickReporter([{ code: 841, text: 'USA and Puerto Rico (...1980)' }, { code: 840, text: 'United States of America' }, { code: 842, text: 'USA' }], da), { code: 840, year: 2024 });
  assert.deepStrictEqual(cp.pickReporter([{ code: 756, text: 'Switzerland ' }, { code: 757, text: 'Switzerland' }], da), { code: 757, year: 2025 });
  assert.strictEqual(cp.pickReporter([{ code: 999, text: 'Nowhere' }], da), null);
  assert.strictEqual(cp.pickReporter([], da), null);
});

test('configuration: top five, both flows, derived shares only', () => {
  assert.strictEqual(cp.TOP_N, 5);
  assert.deepStrictEqual(cp.FLOWS, ['X', 'M']);
  assert.strictEqual(cp.SOURCE.id, 'un-comtrade');
});

test('syncProducts without a Comtrade key reports the failure instead of pulling', async () => {
  const saved = [process.env.COMTRADE_API_KEY, process.env.COMTRADE_API_KEY_SECONDARY];
  delete process.env.COMTRADE_API_KEY; delete process.env.COMTRADE_API_KEY_SECONDARY;
  try {
    const logs = [];
    const r = await cp.syncProducts({ db: null, dryRun: true, log: (m) => logs.push(m) });
    assert.strictEqual(r.status, 'failed');
    assert.ok(logs.some((m) => /COMTRADE_API_KEY is not set/.test(m)));
  } finally {
    if (saved[0]) process.env.COMTRADE_API_KEY = saved[0];
    if (saved[1]) process.env.COMTRADE_API_KEY_SECONDARY = saved[1];
  }
});
