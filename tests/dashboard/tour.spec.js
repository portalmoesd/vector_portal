/**
 * Guided tour smoke tests — the Help button starts the driver.js walkthrough,
 * Escape tears it down cleanly, and a hand-off record resumes on statistics.
 *
 * Same harness as my-calendar.spec.js: static file server over frontend/, all
 * /api/** mocked, https:// CDN requests stubbed. The tour engine is vendored
 * (/vendor/driver/), so it works under the CDN stub.
 */
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../frontend');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };

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

const SUPERVISOR = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: 1 };

async function preparePage(page, { resume = null } = {}) {
  await page.addInitScript(({ u, resume }) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('locale', 'en');
    if (resume) sessionStorage.setItem('vp.tour', JSON.stringify(resume));
  }, { u: SUPERVISOR, resume });
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(SUPERVISOR);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    return json([]);
  });
}

const popover = (page) => page.locator('.driver-popover.vp-tour');

test('Help button starts the tour and Next advances it', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/dashboard-supervisor.html`);
  await page.waitForSelector('#helpBtn');

  await page.click('#helpBtn');
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Welcome to Vector Portal');
  const progress = popover(page).locator('.driver-popover-progress-text');
  const before = await progress.textContent();

  await popover(page).locator('.driver-popover-next-btn').click();
  await expect(popover(page)).toBeVisible();
  await expect(progress).not.toHaveText(before);
});

test('Escape ends the tour and cleans up its state', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/dashboard-supervisor.html`);
  await page.waitForSelector('#helpBtn');

  await page.click('#helpBtn');
  await expect(popover(page)).toBeVisible();
  // Step 2 highlights the sidebar and force-expands it.
  await popover(page).locator('.driver-popover-next-btn').click();
  await expect(page.locator('body')).toHaveClass(/vp-tour-sidebar/);

  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/vp-tour-sidebar/);
  await expect(page.locator('body')).not.toHaveClass(/gp-sidebar-expanded/);
  expect(await page.evaluate(() => sessionStorage.getItem('vp.tour'))).toBeNull();
});

test('a hand-off record resumes the tour on statistics', async ({ page }) => {
  await preparePage(page, {
    resume: { v: 1, tourId: 'grand', page: '/pages/statistics.html', step: 0, ts: Date.now() },
  });
  await page.goto(`${origin}/pages/statistics.html`);

  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Statistics');
  // The record is consumed on resume, so a reload must not restart the tour.
  expect(await page.evaluate(() => sessionStorage.getItem('vp.tour'))).toBeNull();
});

test('a stale hand-off record is discarded, not resumed', async ({ page }) => {
  await preparePage(page, {
    resume: { v: 1, tourId: 'grand', page: '/pages/statistics.html', step: 0, ts: Date.now() - 10 * 60 * 1000 },
  });
  await page.goto(`${origin}/pages/statistics.html`);
  await page.waitForSelector('#helpBtn');

  await expect(popover(page)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('vp.tour'))).toBeNull();
});
