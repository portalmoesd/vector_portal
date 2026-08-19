/**
 * My Calendar holds what is still to come.
 *
 * The tab used to list every event the user owns, finished or not, which meant a
 * completed document appeared twice: once here and once on Archive. My Calendar
 * now carries only the events still in preparation, and finished ones are found
 * on Archive.
 *
 * Two things deliberately did NOT move:
 *  - the mini-calendar and its day preview still show finished meetings, because
 *    a meeting that already happened is still part of that day;
 *  - the Supervisor's My Calendar still holds both, since that role has no
 *    Archive tab for the finished ones to move to.
 *
 * Same harness as badges.spec.js: no server, no database.
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

const DEPUTY = { id: 3, fullName: 'Deputy Test', username: 'deputy', role: 'DEPUTY', departmentId: null };
const SUPERVISOR = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: null };

function tbKey(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}
const TODAY = tbKey();
const at = (utcHour) => `${TODAY}T${String(utcHour).padStart(2, '0')}:00:00.000Z`;

// Both owned by the viewer, both meeting today: one finished, one still in prep.
const FINISHED = { id: 1, title: 'Finished Meeting', countryCode: 'DE', countryName: 'Germany',
  documentSubmitterId: 3, endedAt: at(6), eventDateTime: at(6), language: 'EN', sections: [] };
const IN_PREP = { id: 2, title: 'Upcoming Meeting', countryCode: 'FR', countryName: 'France',
  documentSubmitterId: 3, eventDateTime: at(10), deadlineDate: TODAY, isActive: true, language: 'EN', sections: [] };

async function openDashboard(page, { user = DEPUTY, page_ = 'deputy' } = {}) {
  await page.addInitScript((u) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('locale', 'en');
  }, user);
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(user);
    if (url.pathname === '/api/library') return json([FINISHED]);
    if (url.pathname === '/api/events') return json([IN_PREP]);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    return json([]);
  });
  await page.goto(`${origin}/pages/dashboard-${page_}.html`);
  await page.waitForSelector('.mn-list .mn-card, .mn-list .empty-state');
}

const cards = (page) => page.locator('.mn-list .mn-card');
const tabBtn = (page, mode) => page.locator(`.mn-toggle__btn[data-mode="${mode}"]`);

test.describe('a Deputy (Minister and Protocol behave the same)', () => {
  test('My Calendar lists what is still to come, Archive the finished', async ({ page }) => {
    await openDashboard(page);

    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toContainText('Upcoming Meeting');
    await expect(cards(page)).not.toContainText('Finished Meeting');

    await page.click('.mn-toggle__btn[data-mode="docs"]');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toContainText('Finished Meeting');
  });

  test('the calendar and its day preview still carry the finished meeting', async ({ page }) => {
    await openDashboard(page);

    // Both meetings are on today, so today is marked and the preview lists both.
    await expect(page.locator(`.dp-cal-grid__day[data-cal-date="${TODAY}"]`))
      .toHaveClass(/dp-cal-grid__day--has-event/);
    await expect(page.locator('.mn-day__row')).toHaveCount(2);
    await expect(page.locator('.mn-day__row')).toContainText(['Finished Meeting', 'Upcoming Meeting']);
  });

  test('opening a finished meeting from the day preview lands on Archive', async ({ page }) => {
    await openDashboard(page);

    await page.locator('.mn-day__row').filter({ hasText: 'Finished Meeting' }).click();

    // It is not on My Calendar any more, so it has to open on the tab that holds it.
    await expect(tabBtn(page, 'docs')).toHaveClass(/is-active/);
    const open = page.locator('.mn-list .mn-card.is-expanded');
    await expect(open).toHaveCount(1);
    await expect(open).toContainText('Finished Meeting');
  });
});

test.describe('a Supervisor, who has no Archive tab', () => {
  test('keeps finished and in-preparation events together on My Calendar', async ({ page }) => {
    await openDashboard(page, { user: SUPERVISOR, page_: 'supervisor' });

    // Dropping the finished ones here would leave nowhere to find them.
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page)).toContainText(['Finished Meeting', 'Upcoming Meeting']);
    await expect(tabBtn(page, 'docs')).toHaveCount(0);
  });
});
