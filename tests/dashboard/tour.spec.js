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

// Minimal Geostat classificatory payload: enough for statistics.js to build
// its country list. Served for both the direct Geostat URL and the proxy
// (both carry /api/ in the path, so the same route matches them).
const CLASSIFICATORY = {
  success: true,
  data: {
    countries: [{ value: 156, label: '156 China' }, { value: 840, label: '840 USA' }],
    months: [{ value: 8, label: 'August' }],
    years: [{ value: 2026, label: '2026' }],
    selected: { month: 8, year: 2026 },
  },
};

async function preparePage(page, { resume = null, countries = false } = {}) {
  await page.addInitScript(({ u, resume }) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('locale', 'en');
    if (resume) sessionStorage.setItem('vp.tour', JSON.stringify(resume));
    // The CDN stub below serves flatpickr as an empty file; the create-event
    // form calls flatpickr() during init, so give it a minimal stand-in.
    window.flatpickr = () => ({});
  }, { u: SUPERVISOR, resume });
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(SUPERVISOR);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    if (countries && url.pathname.includes('/classificatory')) {
      // Delayed on purpose: the tour's country pick must keep re-querying
      // until the list arrives, not give up after one attempt.
      await new Promise(r => setTimeout(r, 1500));
      return json(CLASSIFICATORY);
    }
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

test('the create-event form defaults to Discussion Points with a required meeting time', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/dashboard-supervisor.html`);
  await page.click('.mn-createbtn');
  await page.waitForSelector('#newTitle');

  await expect(page.locator('#newDocumentType')).toHaveValue('DISCUSSION_POINTS');
  await expect(page.locator('#eventDateTimeGroup')).toBeVisible();
  await expect(page.locator('#eventDateTimeLabel')).toHaveText(/\*/);
});

test('the create step opens the form, tours it, and returns to the dashboard tour', async ({ page }) => {
  await preparePage(page);
  await page.goto(`${origin}/pages/dashboard-supervisor.html`);
  await page.waitForSelector('#helpBtn');
  await page.click('#helpBtn');

  const title = popover(page).locator('.driver-popover-title');
  const next = popover(page).locator('.driver-popover-next-btn');

  // Walk to the "Create an event" step.
  for (let i = 0; i < 12 && (await title.textContent()) !== 'Create an event'; i++) {
    await next.click();
  }
  await expect(title).toHaveText('Create an event');

  // Next opens the form and hands off to the create-form walkthrough.
  await next.click();
  await expect(page.locator('#ecModal')).toBeVisible();
  await expect(title).toHaveText('Creating an event');

  // Walk the form to its final step, then finish. Steps below the modal
  // body's fold (Attachments onward) must be scrolled into its visible area —
  // driver skips its own scroll for anchors clipped by a scroll container.
  const anchorInModalView = () => page.evaluate(() => {
    const body = document.getElementById('ecModalBody');
    const el = document.querySelector('.driver-active-element');
    if (!body || !el || !body.contains(el)) return true;
    const pr = body.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top >= pr.top - 1 && er.bottom <= pr.bottom + 1;
  });
  for (let i = 0; i < 20 && (await title.textContent()) !== 'Back to the tour'; i++) {
    await next.click();
    // Let driver's 400ms highlight transition finish before checking — a
    // mid-transition click leaves the active-element marker on the old step.
    await page.waitForTimeout(500);
    await expect.poll(anchorInModalView).toBe(true);
  }
  await expect(title).toHaveText('Back to the tour');
  await next.click();

  // The form closes and the dashboard tour resumes on the step after Create.
  await expect(page.locator('#ecModal')).toBeHidden();
  await expect(title).toHaveText('Templates');
});

test('the generate step picks the country from the dropdown and generates the report', async ({ page }) => {
  await preparePage(page, { countries: true });
  await page.goto(`${origin}/pages/statistics.html`);
  await page.waitForSelector('#helpBtn');
  await page.click('#helpBtn');

  const title = popover(page).locator('.driver-popover-title');
  const next = popover(page).locator('.driver-popover-next-btn');
  for (let i = 0; i < 8 && (await title.textContent()) !== 'Generate'; i++) {
    await next.click();
    await page.waitForTimeout(500);
  }
  await expect(title).toHaveText('Generate');

  await next.click();
  // The dropdown item must actually be picked — not just the text typed —
  // which enables Generate; the click on it then opens the report container.
  await expect(page.locator('#countrySearch')).toHaveValue('China');
  await expect(page.locator('#generateBtn')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#statSections')).toBeVisible({ timeout: 15000 });
  await expect(title).toHaveText('Report sections', { timeout: 15000 });
});

test('the generate step still picks the country without the StatsPage hook', async ({ page }) => {
  await preparePage(page, { countries: true });
  await page.goto(`${origin}/pages/statistics.html`);
  await page.waitForSelector('#helpBtn');
  // A stale cached statistics.js would not define the hook; the tour then
  // falls back to simulating the search and dropdown click.
  await page.evaluate(() => { delete window.StatsPage; });
  await page.click('#helpBtn');

  const title = popover(page).locator('.driver-popover-title');
  const next = popover(page).locator('.driver-popover-next-btn');
  for (let i = 0; i < 8 && (await title.textContent()) !== 'Generate'; i++) {
    await next.click();
    await page.waitForTimeout(500);
  }
  await next.click();
  await expect(page.locator('#generateBtn')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#statSections')).toBeVisible({ timeout: 15000 });
  await expect(title).toHaveText('Report sections', { timeout: 15000 });
});

test('the generate step resumes past itself when no country data ever arrives', async ({ page }) => {
  test.setTimeout(60000);
  await preparePage(page);
  await page.goto(`${origin}/pages/statistics.html`);
  await page.waitForSelector('#helpBtn');
  await page.click('#helpBtn');

  const title = popover(page).locator('.driver-popover-title');
  const next = popover(page).locator('.driver-popover-next-btn');
  for (let i = 0; i < 8 && (await title.textContent()) !== 'Generate'; i++) {
    await next.click();
    await page.waitForTimeout(500);
  }
  await expect(title).toHaveText('Generate');

  await next.click();
  // This harness serves no country data at all, so after the pick deadline
  // the tour resumes past the generate step, skipping the hidden
  // report-section steps rather than hanging.
  await expect(title).toHaveText('Report sections', { timeout: 30000 });
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
