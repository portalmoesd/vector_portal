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
    { ...ind('TX.VAL.MRCH.CD.WT', 'Merchandise exports (current US$)', 'usd', 'trade', 7290000000, 2025), compiler: 'WTO' },
    { ...ind('TM.VAL.MRCH.CD.WT', 'Merchandise imports (current US$)', 'usd', 'trade', null, null), compiler: 'WTO' },
    ind('SP.DYN.LE00.IN', 'Life expectancy at birth, total (years)', 'years', 'people', 73.7, 2023),
    ind('SP.URB.TOTL.IN.ZS', 'Urban population (% of total population)', 'pct', 'people', 61.2, 2024),
  ],
  series: {
    'NY.GDP.MKTP.CD': [{ year: 2022, value: 24.6e9 }, { year: 2023, value: 30.5e9 }, { year: 2024, value: 33.3e9 }],
    'SP.POP.TOTL': [{ year: 2022, value: 3712500 }, { year: 2023, value: 3728282 }, { year: 2024, value: 3694600 }],
  },
  texts: {
    source: { name: 'CIA World Factbook', url: 'https://github.com/factbook/factbook.json/tree/abc', dataDate: '2026-01', retrievedAt: '2026-10-13T00:00:00Z', discontinued: '2026-02-04' },
    // Keyed by page section; `label` is what the page shows, `field` the source name.
    sections: {
      introduction: [{ section: 'Introduction', field: 'Background', label: 'Background', content: { text: 'The region of present-day Georgia once contained the ancient kingdoms of Colchis.<br /><br />Second paragraph.', items: [] }, edited: false }],
      overview: [
        { section: 'Geography', field: 'Map references', label: 'Continent', content: { text: 'Asia', items: [] }, edited: false },
        { section: 'Geography', field: 'Land boundaries', label: 'Land boundaries', content: { text: null, items: [{ label: 'total', text: '1,814 km' }, { label: 'border countries', text: 'Armenia 219 km; Azerbaijan 428 km' }] }, edited: false },
      ],
      people: [{ section: 'People and Society', field: 'Languages', label: 'Languages', content: { text: null, items: [{ label: 'Languages', text: 'Georgian (official) 87.6%' }] }, edited: true }],
      government: [
        { section: 'Government', field: 'Country name', label: 'Country name', content: { text: null, items: [{ label: 'conventional long form', text: 'none' }, { label: 'local long form', text: 'Republic of Georgia' }, { label: 'local short form', text: "Sak'art'velo" }] }, edited: false },
        { section: 'Government', field: 'Government type', label: 'Government type', content: { text: 'parliamentary republic', items: [] }, edited: false },
        { section: 'Government', field: 'Executive branch', label: 'Executive branch', content: { text: null, items: [{ label: 'election/appointment process', text: 'president elected by a College of Electors' }] }, edited: false },
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

test('profile: breadcrumb, hero, key figures with year and source, only sections with data, "No data" never filled', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/country-profile.html?country=georgia`);

  const crumbs = page.locator('#cpBreadcrumb li');
  await expect(crumbs).toHaveText(['Home', 'Countries', 'Europe & Central Asia', 'Georgia']);
  await expect(crumbs.nth(2).locator('a')).toHaveAttribute('href', '/pages/country-profiles.html?region=ECS');

  // Hero: name, flag alt, pills, quick facts drawn from both sources.
  await expect(page.locator('.cp-hero__name')).toHaveText('Georgia');
  await expect(page.locator('.cp-hero__flag')).toHaveAttribute('alt', 'Flag of Georgia');
  await expect(page.locator('.cp-hero__pills .pill')).toHaveText(['Europe & Central Asia', 'Upper middle income']);
  await expect(page.locator('.cp-hero__fact[data-fact="capital"] dd')).toHaveText('Tbilisi');
  // The hero shows the official name only; local-language variants and
  // government detail stay in the Government section.
  await expect(page.locator('.cp-hero__official')).toHaveText('Republic of Georgia');
  await expect(page.locator('.cp-hero')).not.toContainText("Sak'art'velo");
  await expect(page.locator('.cp-hero')).not.toContainText('parliamentary republic');

  // Key figures: seven, each with its year tag linking to the source.
  const kf = page.locator('.cp-kf .cp-kf__item');
  await expect(kf).toHaveCount(7);
  const gdp = page.locator('.cp-kf__item[data-code="NY.GDP.MKTP.CD"]');
  await expect(gdp.locator('.cp-kf__value')).toHaveText('$33.3B');
  await expect(gdp.locator('.cp-tag__year')).toHaveText('2024');
  // References are plain text (the source URLs are raw API responses), with
  // the full indicator name, source and retrieval date in the tooltip.
  await expect(gdp.locator('.cp-tag')).toHaveAttribute('title', 'GDP (current US$) · World Bank, World Development Indicators · retrieved 12/10/2026');
  await expect(page.locator('.cp-kf a, .cp-section .cp-attrib a, .cp-hero__src a, #cpFooter a')).toHaveCount(0);
  await expect(page.locator('.cp-kf__item[data-code="SP.POP.TOTL"] .cp-kf__value')).toHaveText('3,694,600');
  await expect(page.locator('.cp-kf__item[data-code="AG.SRF.TOTL.K2"] .cp-kf__value')).toHaveText('69,700 km²');
  await expect(page.locator('.cp-kf__item[data-code="SL.UEM.TOTL.ZS"] .cp-kf__value')).toHaveText('No data');
  await expect(page.locator('.cp-kf .cp-attrib')).toContainText('World Bank, World Development Indicators');

  await expect(page.locator('.cp-section')).toHaveCount(6);
  await expect(page.locator('#cpTocList a')).toHaveText(['Introduction', 'Overview', 'People', 'Government', 'Economy', 'Trade']);

  // Trade: WTO merchandise figures only, credited to the WTO; a missing one reads "No data".
  const trade = page.locator('#section-trade');
  await expect(trade.locator('.cp-kf__item')).toHaveCount(2);
  await expect(trade.locator('.cp-kf__item[data-code="TX.VAL.MRCH.CD.WT"] .cp-kf__value')).toHaveText('$7.29B');
  await expect(trade.locator('.cp-kf__item[data-code="TX.VAL.MRCH.CD.WT"] .cp-tag__src')).toHaveText('WTO');
  await expect(trade.locator('.cp-kf__item[data-code="TM.VAL.MRCH.CD.WT"] .cp-kf__value')).toHaveText('No data');
  await expect(trade.locator('.cp-attrib')).toContainText('World Trade Organization figures, published in the World Bank, World Development Indicators');
  await expect(page.locator('.cp-kf__item[data-code="NY.GDP.MKTP.CD"] .cp-tag__src')).toHaveText('World Bank');

  // Tables: World Bank rows carry a year tag, Factbook rows sit under a group
  // caption with the display label and sub-entries as a list.
  await expect(page.locator('#section-economy .cp-tr[data-code="SL.UEM.TOTL.ZS"] .cp-tr__value')).toHaveText('No data');
  await expect(page.locator('#section-people .cp-tr[data-code="SP.DYN.LE00.IN"] .cp-tr__value')).toHaveText('73.7 years');
  await expect(page.locator('#section-people .cp-tr[data-code="SP.DYN.LE00.IN"] .cp-tag__year')).toHaveText('2023');
  await expect(page.locator('#section-introduction .cp-prose')).toContainText('kingdoms of Colchis');
  await expect(page.locator('#section-introduction .cp-prose br')).toHaveCount(2);
  await expect(page.locator('#section-overview .cp-table__group')).toHaveText('From the World Factbook');
  await expect(page.locator('#section-overview .cp-tr[data-field="Map references"] .cp-tr__label')).toHaveText('Continent');
  await expect(page.locator('#section-overview .cp-tr[data-field="Map references"] .cp-tr__value')).toHaveText('Asia');
  await expect(page.locator('#section-overview .cp-tr[data-field="Land boundaries"] dt')).toHaveText(['total', 'border countries']);
  await expect(page.locator('#section-overview .cp-attrib')).toContainText('CIA World Factbook');
  await expect(page.locator('#section-overview .cp-attrib')).toContainText('snapshot 2026-01');
  await expect(page.locator('#section-overview .cp-attrib')).toContainText('publication discontinued on 04/02/2026');
  await expect(page.locator('#section-people .cp-tr[data-field="Languages"] .cp-tr__label .pill')).toHaveText('edited');
  await expect(page.locator('#section-government .cp-tr')).toHaveCount(3);
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
  await expect(page.locator('.cp-hero__name')).toHaveText('საქართველო');
  await expect(page.locator('.cp-hero__official')).toContainText('Georgia');
  await expect(page.locator('.cp-kf__item[data-code="SL.UEM.TOTL.ZS"] .cp-kf__value')).toHaveText('მონაცემები არ არის');
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
