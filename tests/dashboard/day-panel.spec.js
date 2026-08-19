/**
 * The day preview panel — Minister / Protocol / Deputy.
 *
 * These roles trade the side-column notification center for a preview of one
 * day's schedule: today on load, another day once it is picked on the calendar,
 * and the normal inline event card when a row is clicked. Their notifications
 * move to a bell in the hero.
 *
 * The Deputy shell is used because its calendar is the hybrid one (owned
 * meetings plus contributed events), and the Supervisor shell to prove the other
 * three roles were left alone.
 *
 * Same harness as badges.spec.js: no server and no database, the frontend is
 * served from disk and every /api call is answered from the fixture.
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

const USER = { id: 3, fullName: 'Deputy Test', username: 'deputy', role: 'DEPUTY', departmentId: null };

// The page keys days off the Tbilisi date, so the fixture has to as well.
function tbKey(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

const TODAY = tbKey();
const [Y, M, D] = TODAY.split('-').map(Number);
// Two other days in the same month, both distinct from today, so the month grid
// always holds all three regardless of when the suite runs.
const pick = (...taken) => [1, 2, 3, 4].find(n => !taken.includes(n));
const OTHER_D = pick(D);
const EMPTY_D = pick(D, OTHER_D);
const dayKey = (d) => `${Y}-${String(M).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// Georgia is UTC+4 year-round (no DST), so 06:00Z is 10:00 in Tbilisi that day.
const at = (d, utcHour) => `${dayKey(d)}T${String(utcHour).padStart(2, '0')}:00:00.000Z`;

// Two meetings today — the case the old calendar could not show, since clicking
// a day opened only the first match — and one on another day.
const LIBRARY = [
  { id: 1, title: 'Morning Briefing', countryCode: 'DE', countryName: 'Germany',
    documentSubmitterId: 3, endedAt: at(D, 6), eventDateTime: at(D, 6), language: 'EN', sections: [] },
  { id: 2, title: 'Afternoon Session', countryCode: 'FR', countryName: 'France',
    documentSubmitterId: 3, endedAt: at(D, 10), eventDateTime: at(D, 10), language: 'EN', sections: [] },
  { id: 3, title: 'Other Day Meeting', countryCode: 'IT', countryName: 'Italy',
    documentSubmitterId: 3, endedAt: at(OTHER_D, 6), eventDateTime: at(OTHER_D, 6), language: 'EN', sections: [] },
];

async function openDashboard(page, { user = USER, library = LIBRARY, events = [], page_ = 'deputy' } = {}) {
  await page.addInitScript(([user, origin_]) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('locale', 'en');
    window.__origin = origin_;
  }, [user, origin]);

  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json(user);
    if (url.pathname === '/api/library') return json(library);
    if (url.pathname === '/api/events') return json(events);
    if (url.pathname === '/api/notifications') return json({ unreadCount: 0, notifications: [] });
    return json([]);
  });

  await page.goto(`${origin}/pages/dashboard-${page_}.html`);
  await page.waitForSelector('.mn-list .mn-card, .mn-list .empty-state');
}

const rows = (page) => page.locator('.mn-day__row');
const dayCell = (page, d) => page.locator(`.dp-cal-grid__day[data-cal-date="${dayKey(d)}"]`);

test.describe('the day preview', () => {
  test('opens on today and lists every event on the day', async ({ page }) => {
    await openDashboard(page);

    await expect(page.locator('.mn-day')).toHaveCount(1);
    await expect(page.locator('.mn-day__title')).toContainText('Today');
    // Both of today's meetings, in time order — the calendar day marker used to
    // reach only the first of them.
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0)).toContainText('Morning Briefing');
    await expect(rows(page).nth(0)).toContainText('10:00');
    await expect(rows(page).nth(1)).toContainText('Afternoon Session');
    await expect(rows(page).nth(1)).toContainText('14:00');
    // Today is ringed on the calendar.
    await expect(dayCell(page, D)).toHaveClass(/dp-cal-grid__day--selected/);
  });

  test('picking a day switches the list to that day', async ({ page }) => {
    await openDashboard(page);

    await dayCell(page, OTHER_D).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Other Day Meeting');
    await expect(dayCell(page, OTHER_D)).toHaveClass(/dp-cal-grid__day--selected/);
    await expect(dayCell(page, D)).not.toHaveClass(/dp-cal-grid__day--selected/);
  });

  test('an empty day says so, and "Show today" comes back', async ({ page }) => {
    await openDashboard(page);

    // Days without events are selectable now; they were inert before.
    await dayCell(page, EMPTY_D).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('.mn-day__empty')).toHaveText('No events on this day');

    const today = page.locator('.mn-day__today');
    await expect(today).toBeVisible();
    await today.click();
    await expect(rows(page)).toHaveCount(2);
    await expect(today).toBeHidden();
  });

  test('clicking a row opens that event\'s card below', async ({ page }) => {
    await openDashboard(page);

    await rows(page).filter({ hasText: 'Afternoon Session' }).click();

    const open = page.locator('.mn-list .mn-card.is-expanded');
    await expect(open).toHaveCount(1);
    await expect(open).toContainText('Afternoon Session');
    // The row tracks the open card, and the calendar keeps the day.
    await expect(rows(page).filter({ hasText: 'Afternoon Session' })).toHaveClass(/is-open/);
    await expect(dayCell(page, D)).toHaveClass(/dp-cal-grid__day--selected/);
  });

  test('an event that lands on the day by its deadline says so, not a time', async ({ page }) => {
    // A Deputy's calendar is the hybrid one: events they only contribute to sit
    // on it too, and those often carry no shared meeting time. Rendering "00:00"
    // for one would invent a meeting that does not exist.
    const contributed = { id: 9, title: 'Contributed Report', countryCode: 'PL', countryName: 'Poland',
      documentSubmitterId: 99, deadlineDate: dayKey(D), eventDateTime: null, isActive: true, language: 'EN', sections: [] };
    await openDashboard(page, { events: [contributed] });

    const row = rows(page).filter({ hasText: 'Contributed Report' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.mn-day__when')).toHaveText('Deadline');
  });

  test('notifications moved to a bell in the hero', async ({ page }) => {
    await openDashboard(page);

    await expect(page.locator('.mn-hero__bell')).toHaveCount(1);
    // The side column no longer carries the notification center.
    await expect(page.locator('.mn-notifs')).toHaveCount(0);

    await page.click('.mn-hero__bell');
    await expect(page.locator('.modal-card .mn-notifs__list')).toBeVisible();
  });
});

test.describe('the roles that keep the notification center', () => {
  const SUPERVISOR = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: null };

  test('a Supervisor gets no day panel and no bell', async ({ page }) => {
    await openDashboard(page, { user: SUPERVISOR, page_: 'supervisor' });

    await expect(page.locator('.mn-day')).toHaveCount(0);
    await expect(page.locator('.mn-hero__bell')).toHaveCount(0);
    // The panel is present (hidden while the list is empty, as it always was).
    await expect(page.locator('.mn-notifs')).toHaveCount(1);
    // And an empty day stays inert for them.
    await expect(page.locator(`.dp-cal-grid__day[data-cal-date="${dayKey(EMPTY_D)}"]`)).toHaveCount(0);
  });
});
