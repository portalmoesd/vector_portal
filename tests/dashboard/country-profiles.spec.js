/**
 * Country Profiles smoke tests — admin-only index and profile pages. Same
 * harness as export-potential.spec.js: static file server over frontend/,
 * every /api/** call mocked with a small fixture that follows the route's
 * contract, external scripts (Chart.js CDN) stubbed out.
 */
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../frontend');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.csv': 'text/csv' };

let server, origin;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server && server.close());

const ADMIN = { id: 1, fullName: 'Admin Test', username: 'admin', role: 'ADMIN' };
const DEPUTY = { id: 2, fullName: 'Deputy Test', username: 'dep', role: 'DEPUTY' };

const SOURCE = { id: 'worldbank-wdi', name: 'World Bank, World Development Indicators', url: 'https://data.worldbank.org/' };
const LAST_SYNC = { id: 1, trigger: 'cli', startedAt: '2026-10-12T06:20:00Z', finishedAt: '2026-10-12T06:21:00Z', status: 'ok', okCount: 12, failedCount: 0 };
const ECS = { id: 'ECS', name: 'Europe & Central Asia' };
const EAS = { id: 'EAS', name: 'East Asia & Pacific' };
const COUNTRIES = [
  { iso3: 'GEO', iso2: 'GE', slug: 'georgia', name: 'Georgia', nameKa: 'საქართველო', region: ECS, incomeLevel: { id: 'UMC', name: 'Upper middle income' }, capital: 'Tbilisi' },
  { iso3: 'TUR', iso2: 'TR', slug: 'turkiye', name: 'Türkiye', nameKa: 'თურქეთი', region: ECS, incomeLevel: { id: 'UMC', name: 'Upper middle income' }, capital: 'Ankara' },
  { iso3: 'JPN', iso2: 'JP', slug: 'japan', name: 'Japan', nameKa: 'იაპონია', region: EAS, incomeLevel: { id: 'HIC', name: 'High income' }, capital: 'Tokyo' },
  { iso3: 'HKG', iso2: 'HK', slug: 'hong-kong-sar-china', name: 'Hong Kong SAR, China', nameKa: 'ჰონკონგი', region: EAS, incomeLevel: { id: 'HIC', name: 'High income' }, capital: null },
];
const SRC_URL = 'https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&per_page=20000';
const ind = (code, name, unit, section, value, year) => ({
  code, name, unit, section, value, year,
  sourceName: SOURCE.name, sourceUrl: SRC_URL, retrievedAt: value == null ? null : '2026-10-12T06:20:30Z',
});
const GEORGIA = {
  source: SOURCE,
  lastSync: LAST_SYNC,
  country: { ...COUNTRIES[0], sourceUrl: 'https://api.worldbank.org/v2/country?format=json&per_page=400', retrievedAt: '2026-10-12T06:20:10Z' },
  indicators: [
    ind('SP.POP.TOTL', 'Population, total', 'count', 'people', 3694600, 2024),
    ind('AG.SRF.TOTL.K2', 'Surface area (sq. km)', 'sqkm', 'overview', 69700, 2023),
    ind('NY.GDP.MKTP.CD', 'GDP (current US$)', 'usd', 'economy', 33320000000, 2024),
    ind('NY.GDP.PCAP.CD', 'GDP per capita (current US$)', 'usd', 'economy', 9018.6, 2024),
    ind('NY.GDP.MKTP.KD.ZG', 'GDP growth (annual %)', 'pct', 'economy', 9.4, 2024),
    ind('FP.CPI.TOTL.ZG', 'Inflation, consumer prices (annual %)', 'pct', 'economy', 1.1, 2024),
    ind('SL.UEM.TOTL.ZS', 'Unemployment, total (% of total labor force) (modeled ILO estimate)', 'pct', 'economy', null, null),
    ind('NE.EXP.GNFS.CD', 'Exports of goods and services (current US$)', 'usd', 'trade', null, null),
    ind('NE.IMP.GNFS.CD', 'Imports of goods and services (current US$)', 'usd', 'trade', null, null),
    ind('SP.DYN.LE00.IN', 'Life expectancy at birth, total (years)', 'years', 'people', 73.7, 2023),
    ind('SP.URB.TOTL.IN.ZS', 'Urban population (% of total population)', 'pct', 'people', 61.2, 2024),
  ],
  series: {
    'NY.GDP.MKTP.CD': [{ year: 2022, value: 24.6e9 }, { year: 2023, value: 30.5e9 }, { year: 2024, value: 33.3e9 }],
    'SP.POP.TOTL': [{ year: 2022, value: 3712500 }, { year: 2023, value: 3728282 }, { year: 2024, value: 3694600 }],
  },
  texts: {
    source: { name: 'CIA World Factbook', url: 'https://github.com/factbook/factbook.json/tree/abc', dataDate: '2026-01', retrievedAt: '2026-10-13T00:00:00Z', discontinued: '2026-02-04' },
    sections: {
      Introduction: [{ field: 'Background', content: { text: 'The region of present-day Georgia once contained the ancient kingdoms of Colchis.<br /><br />Second paragraph.', items: [] }, edited: false }],
      Geography: [
        { field: 'Location', content: { text: 'Southwestern Asia, bordering the Black Sea', items: [] }, edited: false },
        { field: 'Area', content: { text: null, items: [{ label: 'total', text: '69,700 sq km' }, { label: 'land', text: '69,700 sq km' }] }, edited: false },
      ],
      'People and Society': [{ field: 'Languages', content: { text: null, items: [{ label: 'Languages', text: 'Georgian (official) 87.6%' }] }, edited: true }],
      Government: [
        { field: 'Government type', content: { text: 'parliamentary republic', items: [] }, edited: false },
        { field: 'Executive branch', content: { text: null, items: [{ label: 'election/appointment process', text: 'president elected by a College of Electors' }] }, edited: false },
      ],
    },
  },
};

async function preparePage(page, { user = ADMIN, locale = 'en' } = {}) {
  await page.addInitScript(({ u, locale }) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('locale', locale);
  }, { u: user, locale });
  // Chart.js comes from a CDN; the smoke tests run offline, so the chart is skipped.
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(user);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    if (url.pathname === '/api/country-profiles/countries') return json({ source: SOURCE, lastSync: LAST_SYNC, regions: [EAS, ECS], countries: COUNTRIES });
    const m = url.pathname.match(/^\/api\/country-profiles\/countries\/([^/]+)$/);
    if (m) return m[1] === 'georgia' || m[1] === 'GEO' ? json(GEORGIA) : json({ error: 'Country not found' }, 404);
    return json([]);
  });
}

test('index: count line, flag cards, search and region filter kept in the URL, empty state with clear', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/country-profiles.html`);

  await expect(page.locator('.gp-nav__link.active .gp-nav__label')).toHaveText('Country Profiles');
  await expect(page.locator('#cpCount')).toHaveText('Showing 4 countries');
  const cards = page.locator('#cpGrid .cp-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toHaveAttribute('href', '/pages/country-profile.html?country=georgia');
  await expect(cards.first().locator('img')).toHaveAttribute('alt', 'Flag of Georgia');
  await expect(cards.first().locator('img')).toHaveAttribute('src', '/assets/flags/ge.svg');
  await expect(page.locator('#cpRegion option')).toHaveCount(3);

  await page.fill('#cpSearch', 'turk');
  await expect(cards).toHaveCount(1);
  await expect(page.locator('#cpCount')).toHaveText('Showing 1 countries');
  await expect(page).toHaveURL(/\?q=turk$/);

  await page.selectOption('#cpRegion', 'EAS');
  await expect(cards).toHaveCount(0);
  await expect(page.locator('#cpEmpty')).toBeVisible();
  await expect(page.locator('#cpEmptyText')).toHaveText('No countries match your filters.');
  await expect(page).toHaveURL(/\?q=turk&region=EAS$/);

  await page.click('#cpClear');
  await expect(cards).toHaveCount(4);
  await expect(page).toHaveURL(/country-profiles\.html$/);
  await expect(page.locator('#cpFooter')).toContainText('World Bank, World Development Indicators');
});

test('index: filters are restored from a shared link', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/country-profiles.html?region=ECS&q=geo`);
  await expect(page.locator('#cpSearch')).toHaveValue('geo');
  await expect(page.locator('#cpRegion')).toHaveValue('ECS');
  await expect(page.locator('#cpGrid .cp-card')).toHaveCount(1);
  await expect(page.locator('#cpGrid .cp-card__name')).toHaveText('Georgia');
});

test('profile: breadcrumb, header, tiles with year and source, only sections with data, "No data" never filled', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/country-profile.html?country=georgia`);

  const crumbs = page.locator('#cpBreadcrumb li');
  await expect(crumbs).toHaveText(['Home', 'Countries', 'Europe & Central Asia', 'Georgia']);
  await expect(crumbs.nth(2).locator('a')).toHaveAttribute('href', '/pages/country-profiles.html?region=ECS');
  await expect(page.locator('.cp-header__name')).toHaveText('Georgia');
  await expect(page.locator('.cp-header__flag')).toHaveAttribute('alt', 'Flag of Georgia');
  await expect(page.locator('.cp-header__facts')).toContainText('Tbilisi');
  await expect(page.locator('.cp-header__facts')).toContainText('Upper middle income');

  const tiles = page.locator('.cp-tile');
  await expect(tiles).toHaveCount(7);
  const gdp = page.locator('.cp-tile[data-code="NY.GDP.MKTP.CD"]');
  await expect(gdp.locator('.cp-tile__value')).toHaveText('$33.3B');
  await expect(gdp.locator('.cp-src__year')).toHaveText('2024');
  await expect(gdp.locator('.cp-src a')).toHaveAttribute('href', SRC_URL);
  await expect(page.locator('.cp-tile[data-code="SP.POP.TOTL"] .cp-tile__value')).toHaveText('3,694,600');
  await expect(page.locator('.cp-tile[data-code="AG.SRF.TOTL.K2"] .cp-tile__value')).toHaveText('69,700 km²');
  await expect(page.locator('.cp-tile[data-code="SL.UEM.TOTL.ZS"] .cp-tile__value')).toHaveText('No data');

  // Trade has no values at all, so the section and its nav entry are absent.
  await expect(page.locator('.cp-section')).toHaveCount(6);
  await expect(page.locator('#cpTocList a')).toHaveText(['Introduction', 'Overview', 'Geography', 'People', 'Government', 'Economy']);
  await expect(page.locator('#section-trade')).toHaveCount(0);

  // Factbook text: HTML rendered, sub-items as a list, attribution with snapshot and discontinuation.
  await expect(page.locator('#section-introduction .cp-text-field__text')).toContainText('kingdoms of Colchis');
  await expect(page.locator('#section-introduction .cp-text-field__text br')).toHaveCount(2);
  await expect(page.locator('#section-geography .cp-text-field[data-field="Area"] dt')).toHaveText(['total', 'land']);
  await expect(page.locator('#section-geography .cp-fb-note')).toContainText('CIA World Factbook');
  await expect(page.locator('#section-geography .cp-fb-note')).toContainText('snapshot 2026-01');
  await expect(page.locator('#section-geography .cp-fb-note')).toContainText('publication discontinued on 04/02/2026');
  await expect(page.locator('#section-people .cp-text-block__title')).toHaveText('From the World Factbook');
  await expect(page.locator('#section-people .cp-text-field__label .pill')).toHaveText('edited');
  await expect(page.locator('#section-government .cp-text-field')).toHaveCount(2);
  await expect(page.locator('#section-economy .cp-row[data-code="SL.UEM.TOTL.ZS"] .cp-row__value')).toHaveText('No data');
  await expect(page.locator('#section-people .cp-row[data-code="SP.DYN.LE00.IN"] .cp-row__value')).toHaveText('73.7 years');
  await expect(page.locator('#section-people .cp-row[data-code="SP.DYN.LE00.IN"] .cp-src__year')).toHaveText('2023');
  // No chart without the chart library (stubbed in this harness).
  await expect(page.locator('#cpChart')).toHaveCount(0);
  await expect(page.locator('#cpFooter')).toContainText('latest year the source has published');
});

test('profile: unknown country shows a not-found message with a way back', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/country-profile.html?country=atlantis`);
  await expect(page.locator('#cpError')).toContainText('Country not found.');
  await expect(page.locator('#cpError a')).toHaveAttribute('href', '/pages/country-profiles.html');
});

test('pages are bilingual: Georgian names and labels in the ka locale', async ({ page }) => {
  await preparePage(page, { locale: 'ka' });
  await page.goto(`${origin}/pages/country-profiles.html`);
  await expect(page.locator('#cpCount')).toHaveText('ნაჩვენებია 4 ქვეყანა');
  // Sorted by the Georgian label: თ (Türkiye) precedes ი (Japan) in the Georgian alphabet.
  await expect(page.locator('#cpGrid .cp-card__name').first()).toHaveText('თურქეთი');
  await page.goto(`${origin}/pages/country-profile.html?country=georgia`);
  await expect(page.locator('.cp-header__name')).toHaveText('საქართველო');
  await expect(page.locator('.cp-header__alt')).toHaveText('Georgia');
  await expect(page.locator('.cp-tile[data-code="SL.UEM.TOTL.ZS"] .cp-tile__value')).toHaveText('მონაცემები არ არის');
  await expect(page.locator('#cpTocList a').first()).toHaveText('შესავალი');
  await expect(page.locator('#cpTocList a').nth(1)).toHaveText('მიმოხილვა');
});

test('non-admin users are bounced to their dashboard', async ({ page }) => {
  await preparePage(page, { user: DEPUTY });
  await page.goto(`${origin}/pages/country-profiles.html`);
  await expect(page).toHaveURL(/dashboard-deputy\.html$/);
  await page.goto(`${origin}/pages/country-profile.html?country=georgia`);
  await expect(page).toHaveURL(/dashboard-deputy\.html$/);
});
