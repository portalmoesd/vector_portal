const test = require('node:test');
const assert = require('node:assert');
const { normalizeFdiSectorsUnits } = require('../../server/helpers/fdi-sectors-units');

// A dataset shaped like the parsed FDI-sectors snapshot: annual columns in
// thousand USD (Geostat-style magnitudes), the quarterly column already in
// mln USD — the mixed-unit file that motivated per-column normalization.
function mixedUnitsDataset() {
  return {
    years: ['2024', '2025', '2026 II კვ'],
    sectors: ['ენერგეტიკა'],
    sectorNameMap: { 'ენერგეტიკა': 'Energy' },
    countries: {
      '528': {
        name: 'ნიდერლანდები',
        totals: { '2024': 176235.1, '2025': -44307.8, '2026 II კვ': 236.0 },
        sectors: {
          'ენერგეტიკა': { '2024': 120000.0, '2025': -50000.0, '2026 II კვ': 150.0 },
        },
      },
      '840': {
        name: 'აშშ',
        totals: { '2024': 250000.0, '2025': 90000.0, '2026 II კვ': null },
        sectors: {
          'ენერგეტიკა': { '2024': 250000.0, '2025': 90000.0, '2026 II კვ': null },
        },
      },
    },
  };
}

test('thousand-USD columns are divided to mln, mln columns pass through', () => {
  const out = normalizeFdiSectorsUnits(mixedUnitsDataset());
  const nl = out.countries['528'];
  assert.strictEqual(nl.totals['2024'], 176235.1 / 1000);
  assert.strictEqual(nl.totals['2025'], -44307.8 / 1000);
  assert.strictEqual(nl.totals['2026 II კვ'], 236.0);
  assert.strictEqual(nl.sectors['ენერგეტიკა']['2024'], 120.0);
  assert.strictEqual(nl.sectors['ენერგეტიკა']['2026 II კვ'], 150.0);
  assert.strictEqual(out.countries['840'].totals['2026 II კვ'], null);
});

test('normalization is idempotent', () => {
  const once = normalizeFdiSectorsUnits(mixedUnitsDataset());
  const twice = normalizeFdiSectorsUnits(JSON.parse(JSON.stringify(once)));
  assert.deepStrictEqual(twice, once);
});

test('an all-mln dataset is left untouched', () => {
  const parsed = {
    years: ['2024'],
    countries: {
      '528': {
        totals: { '2024': 19.67 },
        sectors: { 'ენერგეტიკა': { '2024': 19.67 } },
      },
    },
  };
  const out = normalizeFdiSectorsUnits(JSON.parse(JSON.stringify(parsed)));
  assert.strictEqual(out.countries['528'].totals['2024'], 19.67);
});

test('empty or missing data passes through without throwing', () => {
  assert.strictEqual(normalizeFdiSectorsUnits(null), null);
  const bare = { years: [], countries: {} };
  assert.deepStrictEqual(normalizeFdiSectorsUnits(bare), bare);
});
