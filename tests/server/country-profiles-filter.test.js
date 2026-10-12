const test = require('node:test');
const assert = require('node:assert');
const { filterCountries, regionsOf } = require('../../frontend/js/pages/country-profiles-filter');

const list = [
  { iso3: 'GEO', iso2: 'GE', name: 'Georgia', nameKa: 'საქართველო', region: { id: 'ECS', name: 'Europe & Central Asia' } },
  { iso3: 'TUR', iso2: 'TR', name: 'Türkiye', nameKa: 'თურქეთი', region: { id: 'ECS', name: 'Europe & Central Asia' } },
  { iso3: 'JPN', iso2: 'JP', name: 'Japan', nameKa: 'იაპონია', region: { id: 'EAS', name: 'East Asia & Pacific' } },
  { iso3: 'CIV', iso2: 'CI', name: "Cote d'Ivoire", nameKa: null, region: { id: 'SSF', name: 'Sub-Saharan Africa' } },
];

test('no filters returns everything', () => {
  assert.strictEqual(filterCountries(list, {}).length, 4);
  assert.strictEqual(filterCountries(list).length, 4);
});

test('search is case- and accent-insensitive and matches names, Georgian names and ISO codes', () => {
  assert.deepStrictEqual(filterCountries(list, { q: 'geor' }).map((c) => c.iso3), ['GEO']);
  assert.deepStrictEqual(filterCountries(list, { q: 'TURK' }).map((c) => c.iso3), ['TUR']);
  assert.deepStrictEqual(filterCountries(list, { q: 'türk' }).map((c) => c.iso3), ['TUR']);
  assert.deepStrictEqual(filterCountries(list, { q: 'იაპ' }).map((c) => c.iso3), ['JPN']);
  assert.deepStrictEqual(filterCountries(list, { q: 'jp' }).map((c) => c.iso3), ['JPN']);
  assert.deepStrictEqual(filterCountries(list, { q: "d'iv" }).map((c) => c.iso3), ['CIV']);
  assert.deepStrictEqual(filterCountries(list, { q: '   ' }).length, 4);
});

test('region filter is exact on the region id and combines with search', () => {
  assert.deepStrictEqual(filterCountries(list, { region: 'ECS' }).map((c) => c.iso3), ['GEO', 'TUR']);
  assert.deepStrictEqual(filterCountries(list, { region: 'ECS', q: 'tur' }).map((c) => c.iso3), ['TUR']);
  assert.deepStrictEqual(filterCountries(list, { region: 'EAS', q: 'tur' }), []);
  assert.deepStrictEqual(filterCountries(list, { region: 'NOPE' }), []);
});

test('regionsOf lists each region once, sorted by name', () => {
  assert.deepStrictEqual(regionsOf(list), [
    { id: 'EAS', name: 'East Asia & Pacific' },
    { id: 'ECS', name: 'Europe & Central Asia' },
    { id: 'SSF', name: 'Sub-Saharan Africa' },
  ]);
});
