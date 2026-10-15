const test = require('node:test');
const assert = require('node:assert');
const wb = require('../../server/country-profiles/worldbank');

const countryJson = [
  { page: 1, pages: 1, per_page: '400', total: 5 },
  [
    { id: 'AFE', iso2Code: 'ZH', name: 'Africa Eastern and Southern', region: { id: 'NA', iso2code: 'NA', value: 'Aggregates' }, incomeLevel: { id: 'NA', value: 'Aggregates' }, capitalCity: '', longitude: '', latitude: '' },
    { id: 'GEO', iso2Code: 'GE', name: 'Georgia', region: { id: 'ECS', iso2code: 'Z7', value: 'Europe & Central Asia' }, incomeLevel: { id: 'UMC', value: 'Upper middle income' }, capitalCity: 'Tbilisi', longitude: '44.793', latitude: '41.71' },
    { id: 'HKG', iso2Code: 'HK', name: 'Hong Kong SAR, China', region: { id: 'EAS', iso2code: 'Z4', value: 'East Asia & Pacific' }, incomeLevel: { id: 'HIC', value: 'High income' }, capitalCity: '', longitude: '114.109', latitude: '22.3964' },
    { id: 'TUR', iso2Code: 'TR', name: 'Türkiye', region: { id: 'ECS', iso2code: 'Z7', value: 'Europe & Central Asia ' }, incomeLevel: { id: 'UMC', value: 'Upper middle income' }, capitalCity: 'Ankara', longitude: '32.3606', latitude: '39.7153' },
    { id: 'WLD', iso2Code: '1W', name: 'World', region: { id: 'NA', iso2code: 'NA', value: 'Aggregates' }, incomeLevel: { id: 'NA', value: 'Aggregates' }, capitalCity: '', longitude: '', latitude: '' },
  ],
];

test('country list: aggregates (region id NA) are excluded, names kept verbatim, slugs derived', () => {
  const { countries, aggregates, total } = wb.parseCountryList(countryJson);
  assert.strictEqual(total, 5);
  assert.deepStrictEqual(aggregates.map((a) => a.iso3), ['AFE', 'WLD']);
  assert.deepStrictEqual(countries.map((c) => c.iso3), ['GEO', 'HKG', 'TUR']);
  const geo = countries[0];
  assert.strictEqual(geo.name, 'Georgia');
  assert.strictEqual(geo.slug, 'georgia');
  assert.strictEqual(geo.iso2, 'GE');
  assert.strictEqual(geo.regionId, 'ECS');
  assert.strictEqual(geo.regionName, 'Europe & Central Asia');
  assert.strictEqual(geo.incomeName, 'Upper middle income');
  assert.strictEqual(geo.capital, 'Tbilisi');
  assert.strictEqual(geo.longitude, 44.793);
  // The source's trailing space on a region name is trimmed; nothing else changes.
  assert.strictEqual(countries[2].regionName, 'Europe & Central Asia');
  assert.strictEqual(countries[2].slug, 'turkiye');
  // No capital in the source -> null, never invented.
  assert.strictEqual(countries[1].capital, null);
  assert.strictEqual(countries[1].slug, 'hong-kong-sar-china');
});

test('slugify handles punctuation, accents and ampersands', () => {
  assert.strictEqual(wb.slugify("Cote d'Ivoire"), 'cote-d-ivoire');
  assert.strictEqual(wb.slugify('São Tomé and Principe'), 'sao-tome-and-principe');
  assert.strictEqual(wb.slugify('St. Kitts & Nevis'), 'st-kitts-and-nevis');
  assert.strictEqual(wb.slugify('  Lao PDR '), 'lao-pdr');
});

test('country list: an API error payload or an unexpected shape is reported, not swallowed', () => {
  assert.throws(() => wb.parseCountryList([{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }]), /API returned an error: 120 Invalid value/);
  assert.throws(() => wb.parseCountryList({ countries: [] }), /unexpected response shape/);
  assert.throws(() => wb.parseCountryList([{ page: 1, pages: 2, total: 500 }, []]), /span 2 pages/);
});

const indicatorJson = [
  { page: 1, pages: 1, per_page: 20000, total: 6, sourceid: '2', lastupdated: '2026-10-08' },
  [
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'GE', value: 'Georgia' }, countryiso3code: 'GEO', date: '2025', value: null, unit: '', obs_status: '', decimal: 0 },
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'GE', value: 'Georgia' }, countryiso3code: 'GEO', date: '2024', value: 3694600, unit: '', obs_status: '', decimal: 0 },
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'GE', value: 'Georgia' }, countryiso3code: 'GEO', date: '2023', value: 3728282, unit: '', obs_status: '', decimal: 0 },
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'TR', value: 'Turkiye' }, countryiso3code: 'TUR', date: '2025', value: 85664944, unit: '', obs_status: '', decimal: 0 },
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'XX', value: 'Some aggregate' }, countryiso3code: '', date: '2025', value: 123, unit: '', obs_status: '', decimal: 0 },
    { indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'TR', value: 'Turkiye' }, countryiso3code: 'TUR', date: '2024', value: '85326000', unit: '', obs_status: '', decimal: 0 },
  ],
];

test('indicator page: null values and rows without ISO3 are dropped; the latest year is per country', () => {
  const parsed = wb.parseIndicatorPage(indicatorJson, 'SP.POP.TOTL');
  assert.strictEqual(parsed.indicatorName, 'Population, total');
  assert.strictEqual(parsed.meta.lastUpdated, '2026-10-08');
  assert.deepStrictEqual(parsed.rows, [
    { iso3: 'GEO', year: 2024, value: 3694600 },
    { iso3: 'GEO', year: 2023, value: 3728282 },
    { iso3: 'TUR', year: 2025, value: 85664944 },
    { iso3: 'TUR', year: 2024, value: 85326000 },
  ]);
  const latest = wb.latestByCountry(parsed.rows);
  // Georgia's 2025 value is null in the source, so 2024 is the latest — an
  // old value is never presented as current.
  assert.deepStrictEqual(latest.get('GEO'), { iso3: 'GEO', year: 2024, value: 3694600 });
  assert.deepStrictEqual(latest.get('TUR'), { iso3: 'TUR', year: 2025, value: 85664944 });
});

test('indicator page: a response for a different code, or an API error, throws', () => {
  assert.throws(() => wb.parseIndicatorPage(indicatorJson, 'NY.GDP.MKTP.CD'), /carries SP.POP.TOTL/);
  assert.throws(() => wb.parseIndicatorPage([{ message: [{ id: '175', key: 'Invalid indicator', value: 'x' }] }], 'BAD.CODE'), /API returned an error/);
});

test('fetchIndicator follows pagination and records the first page URL as the source URL', async () => {
  const pageOf = (page, rows) => [{ page, pages: 2, per_page: 2, total: 4, lastupdated: '2026-10-08' }, rows];
  const row = (iso3, year, value) => ({ indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' }, countryiso3code: iso3, date: String(year), value });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = /[&?]page=(\d+)/.test(url) ? Number(url.match(/[&?]page=(\d+)/)[1]) : 1;
    const body = page === 1 ? pageOf(1, [row('GEO', 2024, 33e9), row('GEO', 2023, 30e9)]) : pageOf(2, [row('TUR', 2024, 1.3e12), row('TUR', 2023, null)]);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const r = await wb.fetchIndicator('NY.GDP.MKTP.CD', { fetchImpl, retries: 0 });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(r.url, wb.indicatorUrl('NY.GDP.MKTP.CD'));
  assert.ok(r.url.startsWith('https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD?'));
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.indicatorName, 'GDP (current US$)');
});

test('fetchJson retries on failure and then reports the last error', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 503, text: async () => '' }; };
  const logs = [];
  await assert.rejects(wb.fetchJson('https://example.test/x', { fetchImpl, retries: 2, log: (m) => logs.push(m) }), /HTTP 503/);
  assert.strictEqual(n, 3);
  assert.strictEqual(logs.length, 2);
}, { timeout: 20000 });

test('the configured indicator list matches the brief', () => {
  assert.deepStrictEqual(wb.INDICATORS.map((i) => i.code), [
    'SP.POP.TOTL', 'AG.SRF.TOTL.K2', 'NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'NY.GDP.MKTP.KD.ZG',
    'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS', 'TX.VAL.MRCH.CD.WT', 'TM.VAL.MRCH.CD.WT', 'SP.DYN.LE00.IN', 'SP.URB.TOTL.IN.ZS',
  ]);
  // Trade figures are the WTO's, republished in the WDI; everything else is the World Bank's own.
  for (const i of wb.INDICATORS) assert.strictEqual(i.compiler || null, i.section === 'trade' ? 'WTO' : null, i.code);
  for (const i of wb.INDICATORS) assert.ok(['overview', 'people', 'economy', 'trade'].includes(i.section), i.code);
});
