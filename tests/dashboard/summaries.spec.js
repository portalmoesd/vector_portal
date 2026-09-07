/**
 * The dashboard Summaries tab: the Meeting Summary task list.
 *
 * The tab is injected for every role but stays hidden until
 * /api/meeting-summaries/mine returns rows — the gate is data-driven, exactly
 * like the assignments themselves. A red count badge carries the number of
 * points still owed, a card per event opens the Meeting Summary modal, and a
 * summary_due notification lands on the tab rather than on an event card.
 *
 * The Supervisor shell is used because supervisors are who assignments resolve
 * to, and their dashboard has the side notification panel the routing test
 * clicks. No server and no database: the frontend is served from disk and
 * every /api call is answered from the fixture below.
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

const USER = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: null };

const PAST = '2020-01-01';    // long overdue
const FUTURE = '2099-01-01';  // comfortably ahead

const mineRow = (over = {}) => ({
  eventId: 1, title: 'Berlin Summit', countryCode: 'DE', countryName: 'Germany',
  countryNameKa: 'გერმანია', deadlineDate: FUTURE, myTotal: 3, myPending: 2, ...over,
});

// Enough for GET /api/meeting-summaries/:id to render the modal's empty branch.
const SUMMARY_DOC = {
  eventId: 1, title: 'Berlin Summit', language: 'EN', items: [],
  progress: { done: 0, total: 0 }, unsentCount: 0, canSend: false, canEditAny: false,
};

/**
 * Serve the dashboard with a stubbed API. `state.mine` is mutable so a test can
 * change what the next 45s poll sees.
 */
async function openDashboard(page, { mine = [], notifications = [] } = {}) {
  const state = { mine, notifications };

  await page.addInitScript(([user]) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('locale', 'en');
  }, [USER]);

  // CDN scripts (html2pdf, docx, flatpickr) are irrelevant here and the test
  // must not depend on the network.
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/me') return json(USER);
    if (url.pathname === '/api/library') return json([]);
    if (url.pathname === '/api/notifications') {
      return json({
        unreadCount: state.notifications.filter(n => !n.isRead).length,
        notifications: state.notifications,
      });
    }
    if (url.pathname === '/api/notifications/read') return json({ success: true });
    // The specific route has to win over any /api/meeting-summaries/ prefix.
    if (url.pathname === '/api/meeting-summaries/mine') return json(state.mine);
    if (/^\/api\/meeting-summaries\/\d+$/.test(url.pathname)) return json(SUMMARY_DOC);
    return json([]);   // /api/events, /api/workflow/my-turn, anything else
  });

  await page.goto(`${origin}/pages/dashboard-supervisor.html`);
  await page.waitForSelector('.mn-list .mn-card, .mn-list .empty-state');
  return state;
}

const tab = (page, mode) => page.locator(`.mn-toggle__btn[data-mode="${mode}"]`);

test.describe('the Summaries tab', () => {
  test('stays hidden when the user has no summary tasks', async ({ page }) => {
    await openDashboard(page);
    await expect(tab(page, 'summaries')).toBeHidden();
    // The other segments are untouched by the hidden button.
    await expect(tab(page, 'meetings')).toBeVisible();
    await expect(tab(page, 'tasks')).toBeVisible();
  });

  test('appears with a red badge counting the pending points across events', async ({ page }) => {
    await openDashboard(page, { mine: [
      mineRow(),
      mineRow({ eventId: 2, title: 'Paris Visit', countryCode: 'FR', countryName: 'France', countryNameKa: 'საფრანგეთი', myPending: 1 }),
    ] });
    await expect(tab(page, 'summaries')).toBeVisible();
    await expect(tab(page, 'summaries')).toHaveAttribute('data-dot', 'red');
    await expect(tab(page, 'summaries')).toHaveAttribute('data-count', '3');
  });

  test('caps the badge at 9+', async ({ page }) => {
    await openDashboard(page, { mine: [mineRow({ myTotal: 12, myPending: 12 })] });
    await expect(tab(page, 'summaries')).toHaveAttribute('data-count', '9+');
  });

  test('shows no badge when every summary is written, but the tab still lists them', async ({ page }) => {
    await openDashboard(page, { mine: [mineRow({ myPending: 0 })] });
    const t = tab(page, 'summaries');
    await expect(t).toBeVisible();
    await expect(t).not.toHaveAttribute('data-dot', /.*/);

    await t.click();
    const card = page.locator('.mn-list [data-summary-event="1"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.mn-chip--ready')).toHaveText('Done');
    // A finished task shows no deadline nag.
    await expect(card.locator('.is-overdue, .is-soon')).toHaveCount(0);
  });

  test('pending cards carry the count chip and overdue colouring', async ({ page }) => {
    await openDashboard(page, { mine: [
      mineRow({ deadlineDate: PAST }),
      mineRow({ eventId: 2, title: 'Paris Visit', myPending: 0 }),
    ] });
    await tab(page, 'summaries').click();

    const pending = page.locator('.mn-list [data-summary-event="1"]');
    await expect(pending.locator('.mn-chip--todo')).toHaveText('2 left');
    await expect(pending).toHaveClass(/mn-card--overdue/);
    await expect(pending.locator('.mn-card__meta .is-overdue')).toHaveCount(1);
    // Outstanding work sorts above finished work.
    await expect(page.locator('.mn-list [data-summary-event]').first()).toHaveAttribute('data-summary-event', '1');
  });

  test('clicking a card opens the Meeting Summary modal', async ({ page }) => {
    await openDashboard(page, { mine: [mineRow()] });
    await tab(page, 'summaries').click();
    await page.click('[data-summary-event="1"]');
    await expect(page.locator('.ms-overlay')).toBeVisible();
    await expect(page.locator('.ms-head h2')).toContainText('Berlin Summit');
  });

  test('a summary_due notification routes to the tab, revealing it if needed', async ({ page }) => {
    // /mine deliberately empty: the click itself must reveal the tab, so a
    // notification arriving before the poll still leads somewhere.
    await openDashboard(page, { notifications: [
      { id: 21, type: 'summary_due', eventId: 1, sectionId: null,
        meta: { eventTitle: 'Berlin Summit', deadlineDate: FUTURE, pointCount: 2 },
        isRead: false, createdAt: '2026-03-01T10:00:00.000Z' },
    ] });

    await page.click('.mn-notifs .mn-notif[data-type="summary_due"]');
    const t = tab(page, 'summaries');
    await expect(t).toBeVisible();
    await expect(t).toHaveClass(/is-active/);
    await expect(page.locator('.mn-list .empty-state')).toContainText('No meeting summaries');
  });

  test('finishing the last task never yanks the tab away mid-session', async ({ page }) => {
    await page.clock.install();
    const state = await openDashboard(page, { mine: [mineRow()] });
    await tab(page, 'summaries').click();
    await expect(page.locator('[data-summary-event="1"]')).toHaveCount(1);

    // The next poll finds nothing left — the tab must stay put, list emptied,
    // badge gone. It hides again only on the next page load.
    state.mine = [];
    await page.clock.runFor(46_000);
    const t = tab(page, 'summaries');
    await expect(t).toBeVisible();
    await expect(t).toHaveClass(/is-active/);
    await expect(t).not.toHaveAttribute('data-dot', /.*/);
    await expect(page.locator('.mn-list .empty-state')).toContainText('No meeting summaries');
  });
});
