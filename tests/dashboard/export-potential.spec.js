/**
 * Export Potential page smoke tests — admin-only preview rendered on the
 * invented sample partner. Same harness as tour.spec.js: static file server
 * over frontend/, every /api/** call mocked (the result payload comes from
 * the real loader so the page is tested against the real contract).
 */
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');
const results = require('../../server/export-potential/results');
const { loadConfig } = require('../../server/export-potential/scoring');

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

// The page remembers the last partner; pin it so the tests see the sample
// partner whatever real result files are committed.
async function preparePage(page, { user = ADMIN, locale = 'en', country = 'SMP' } = {}) {
  await page.addInitScript(({ u, locale, country }) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('locale', locale);
    localStorage.setItem('exportPotentialCountry', country);
  }, { u: user, locale, country });
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(user);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    if (url.pathname === '/api/export-potential/countries') return json(results.listCountries());
    if (url.pathname === '/api/export-potential/config') return json(loadConfig());
    const m = url.pathname.match(/^\/api\/export-potential\/countries\/([^/]+)$/);
    if (m) {
      const r = results.getCountry(m[1]);
      return r ? json(r) : json({ error: 'No results for this country' }, 404);
    }
    return json([]);
  });
}

test('admin sees the sidebar entry and the sample partner renders with ratings, flags and the banner', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/export-potential.html`);

  await expect(page.locator('.gp-nav__link.active .gp-nav__label')).toHaveText('Export Potential');
  await expect(page.locator('#epSampleBanner')).toBeVisible();
  await expect(page.locator('#epCountrySearch')).toHaveValue(/Sample country/);
  await expect(page.locator('#epMeta')).toContainText('Data year: 2025');

  const rows = page.locator('#epTableBody tr.ep-row');
  await expect(rows).toHaveCount(8);
  // Sorted by rating then score: the first row is High.
  await expect(rows.first().locator('.pill')).toHaveText('High');
  const wine = page.locator('#epTableBody tr.ep-row[data-hs4="2204"]');
  await expect(wine.locator('.ep-name')).toHaveText('Wine');
  await expect(wine.locator('.ep-score__value')).toHaveText('77');
  await expect(page.locator('#epTableBody .ep-flag--cap')).toHaveCount(2);
  await expect(page.locator('#epTableBody .ep-flag--new')).toHaveCount(1);
  await expect(page.locator('#epTableBody .ep-flag--missing')).toHaveCount(1);

  // Tiles reflect the summary; the watch list has two products.
  await expect(page.locator('.ep-tile--high .ep-tile__value')).toHaveText('3');
  await expect(page.locator('.ep-tile--watch .ep-tile__value')).toHaveText('2');
  await expect(page.locator('#epWatchBody tr')).toHaveCount(2);
  await expect(page.locator('#epWatchBody')).toContainText('2024, 2025');

  // Footer credits the sources with the data year.
  await expect(page.locator('#epFooter')).toContainText('Geostat');
  await expect(page.locator('#epFooter')).toContainText('data year 2025');
});

test('a row expands into the four blocks in plain language', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/export-potential.html`);
  const wine = page.locator('#epTableBody tr.ep-row[data-hs4="2204"]');
  await wine.click();
  const details = page.locator('#epTableBody tr.ep-details');
  await expect(details).toHaveCount(1);
  await expect(details.locator('.ep-detail-block')).toHaveCount(4);
  await expect(details).toContainText('The market imports $31.6M of this product a year on average');
  await expect(details).toContainText('20 / 30 pts');
  await expect(details).toContainText('Georgia faces a 0.0% tariff; competitors face 5.0% on average');
  await expect(details).toContainText('Georgia exported this product to this market in 2 of the last 5 years');
  // A capped product explains the cap.
  await page.locator('#epTableBody tr.ep-row[data-hs4="0802"]').click();
  await expect(page.locator('#epTableBody tr.ep-details').nth(1)).toContainText('steep recent decline cap lowered the rating to Moderate');
  await wine.click();
  await expect(page.locator('#epTableBody tr.ep-details')).toHaveCount(1);
});

test('rating filter, product search and the methodology panel', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/export-potential.html`);
  await expect(page.locator('#epTableBody tr.ep-row')).toHaveCount(8);

  await page.click('#epRatingFilter [data-rating="Low"]');
  await expect(page.locator('#epTableBody tr.ep-row')).toHaveCount(1);
  await expect(page.locator('#epProductsCount')).toHaveText('1 of 8 products');
  await page.click('#epRatingFilter [data-rating="all"]');
  await page.fill('#epProductSearch', '22');
  await expect(page.locator('#epTableBody tr.ep-row')).toHaveCount(3);
  await page.fill('#epProductSearch', 'wine');
  await expect(page.locator('#epTableBody tr.ep-row')).toHaveCount(1);
  await page.fill('#epProductSearch', '');

  await page.click('#epMethodBtn');
  await expect(page.locator('#epMethod')).toBeVisible();
  await expect(page.locator('#epMethodBody')).toContainText('screening result, not a forecast');
  await expect(page.locator('#epMethodBody')).toContainText('at least $1.00M a year');
  await expect(page.locator('#epMethodBody')).toContainText('High: 65 points or more');
  await expect(page.locator('#epMethodBody')).toContainText('Over $100M');
});

test('the page is bilingual', async ({ page }) => {
  await preparePage(page, { locale: 'ka' });
  await page.goto(`${origin}/pages/export-potential.html`);
  await expect(page.locator('.page-title')).toHaveText('საექსპორტო პოტენციალი');
  await expect(page.locator('.gp-nav__link.active .gp-nav__label')).toHaveText('საექსპორტო პოტენციალი');
  const wine = page.locator('#epTableBody tr.ep-row[data-hs4="2204"]');
  await expect(wine.locator('.ep-name')).toHaveText('ღვინო');
  await expect(wine.locator('.pill')).toHaveText('მაღალი');
});

test('non-admin roles are bounced to their dashboard and see no sidebar entry', async ({ page }) => {
  await preparePage(page, { user: DEPUTY });
  await page.goto(`${origin}/pages/export-potential.html`);
  await page.waitForURL(/dashboard-deputy\.html/);
  await expect(page.locator('.gp-nav__link', { hasText: 'Export Potential' })).toHaveCount(0);
});

test('a real result file renders without the sample banner and hoists flags shared by every product', async ({ page }) => {
  test.skip(!results.listCountries().some((c) => c.code === 'TUR' && !c.sample), 'no real result file for TUR');
  await preparePage(page, { country: 'TUR' });
  await page.goto(`${origin}/pages/export-potential.html`);
  await expect(page.locator('#epCountrySearch')).toHaveValue(/Turkey|Türkiye/);
  await expect(page.locator('#epTableBody tr.ep-row').first()).toBeVisible();
  await expect(page.locator('#epSampleBanner')).toBeHidden();
  await expect(page.locator('#epMeta')).toContainText('UN Comtrade');
  await expect(page.locator('#epMeta .ep-meta__flags')).toContainText('Tariff data missing');
  await expect(page.locator('#epTableBody .ep-flag', { hasText: 'Tariff data missing' })).toHaveCount(0);
});
