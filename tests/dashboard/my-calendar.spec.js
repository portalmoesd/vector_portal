/**
 * My Calendar holds the schedule; Archive holds the days that have passed.
 *
 * The split is by DATE, not by document status. That distinction matters here:
 * publishing a document sets is_active=false, so a finished event leaves
 * /api/events and lives only in /api/library — and in this workflow the briefing
 * is normally finished BEFORE its meeting. Filtering the tab by "still in
 * preparation" therefore hides exactly the events a minister needs to see, which
 * is the regression the first test below pins down.
 *
 * An event leaves My Calendar only once its meeting day has passed AND its
 * document is finished. Unfinished work stays however old it is — that is the
 * overdue pile, and Archive would bury it.
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

// Dates are relative to today so the suite never drifts into a wrong season.
function tbKey(d) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}
const DAY = 86400000;
// Midday UTC keeps the Tbilisi day (UTC+4) the same as the UTC day.
const noonOn = (offsetDays) => `${tbKey(new Date(Date.now() + offsetDays * DAY))}T12:00:00.000Z`;

// Four owned events spanning both axes: finished / unfinished × past / future.
const READY_FUTURE = { id: 1, title: 'Ready For Tomorrow', countryCode: 'DE', countryName: 'Germany',
  documentSubmitterId: 3, endedAt: noonOn(-2), eventDateTime: noonOn(1), language: 'EN', sections: [] };
const READY_PAST = { id: 2, title: 'Finished Yesterday', countryCode: 'FR', countryName: 'France',
  documentSubmitterId: 3, endedAt: noonOn(-1), eventDateTime: noonOn(-1), language: 'EN', sections: [] };
const OPEN_PAST = { id: 3, title: 'Overdue From Yesterday', countryCode: 'IT', countryName: 'Italy',
  documentSubmitterId: 3, eventDateTime: noonOn(-1), deadlineDate: tbKey(new Date(Date.now() - DAY)),
  isActive: true, language: 'EN', sections: [] };
const OPEN_FUTURE = { id: 4, title: 'In Preparation For Tomorrow', countryCode: 'JP', countryName: 'Japan',
  documentSubmitterId: 3, eventDateTime: noonOn(1), deadlineDate: tbKey(new Date(Date.now() + DAY)),
  isActive: true, language: 'EN', sections: [] };

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
    if (url.pathname === '/api/library') return json([READY_FUTURE, READY_PAST]);
    if (url.pathname === '/api/events') return json([OPEN_PAST, OPEN_FUTURE]);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    return json([]);
  });
  await page.goto(`${origin}/pages/dashboard-${page_}.html`);
  await page.waitForSelector('.mn-list .mn-card, .mn-list .empty-state');
}

const cards = (page) => page.locator('.mn-list .mn-card');
const tabBtn = (page, mode) => page.locator(`.mn-toggle__btn[data-mode="${mode}"]`);
const goTo = (page, mode) => page.click(`.mn-toggle__btn[data-mode="${mode}"]`);

test.describe('a Deputy (Minister and Protocol behave the same)', () => {
  test('a finished document for an upcoming meeting stays on My Calendar', async ({ page }) => {
    // The regression: the document is published before the meeting, which takes
    // the event out of /api/events. Keying the tab off that emptied it.
    await openDashboard(page);
    await expect(cards(page).filter({ hasText: 'Ready For Tomorrow' })).toHaveCount(1);
  });

  test('My Calendar keeps every event whose day has not passed, plus the overdue', async ({ page }) => {
    await openDashboard(page);

    await expect(cards(page)).toHaveCount(3);
    // Membership, not order — the date grouping keys off the browser's local day,
    // so the group order shifts with the viewer's timezone.
    for (const title of [
      'Ready For Tomorrow',            // finished, still ahead
      'In Preparation For Tomorrow',   // unfinished, ahead
      'Overdue From Yesterday',        // unfinished and late — must not be buried
    ]) {
      await expect(cards(page).filter({ hasText: title })).toHaveCount(1);
    }
    await expect(cards(page).filter({ hasText: 'Finished Yesterday' })).toHaveCount(0);
  });

  test('yesterday\'s finished meeting is on Archive', async ({ page }) => {
    await openDashboard(page);
    await goTo(page, 'docs');
    await expect(cards(page).filter({ hasText: 'Finished Yesterday' })).toHaveCount(1);
  });

  test('the calendar and its day preview still carry every owned event', async ({ page }) => {
    await openDashboard(page);

    // Yesterday's two meetings are both marked, finished or not.
    const yesterday = tbKey(new Date(Date.now() - DAY));
    await expect(page.locator(`.dp-cal-grid__day[data-cal-date="${yesterday}"]`))
      .toHaveClass(/dp-cal-grid__day--has-event/);
    await page.click(`.dp-cal-grid__day[data-cal-date="${yesterday}"]`);
    const rows = page.locator('.mn-day__row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Finished Yesterday' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Overdue From Yesterday' })).toHaveCount(1);
  });

  test('opening from the day preview lands on the tab that holds the event', async ({ page }) => {
    await openDashboard(page);

    // Yesterday's finished one lives on Archive now.
    const yesterday = tbKey(new Date(Date.now() - DAY));
    await page.click(`.dp-cal-grid__day[data-cal-date="${yesterday}"]`);
    await page.locator('.mn-day__row').filter({ hasText: 'Finished Yesterday' }).click();
    await expect(tabBtn(page, 'docs')).toHaveClass(/is-active/);
    await expect(page.locator('.mn-list .mn-card.is-expanded')).toContainText('Finished Yesterday');

    // Tomorrow's finished one is still on My Calendar, so it opens there.
    const tomorrow = tbKey(new Date(Date.now() + DAY));
    await page.click(`.dp-cal-grid__day[data-cal-date="${tomorrow}"]`);
    await page.locator('.mn-day__row').filter({ hasText: 'Ready For Tomorrow' }).click();
    await expect(tabBtn(page, 'meetings')).toHaveClass(/is-active/);
    await expect(page.locator('.mn-list .mn-card.is-expanded')).toContainText('Ready For Tomorrow');
  });
});

test.describe('a Supervisor, who has no Archive tab', () => {
  test('keeps every owned event on My Calendar', async ({ page }) => {
    await openDashboard(page, { user: SUPERVISOR, page_: 'supervisor' });

    // Moving any of them out would leave nowhere to find them.
    await expect(cards(page)).toHaveCount(4);
    await expect(tabBtn(page, 'docs')).toHaveCount(0);
  });
});
