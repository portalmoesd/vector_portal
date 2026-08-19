/**
 * Dashboard attention badges: the green "document ready" cue.
 *
 * Green means "a finished document you have not opened yet" — a corner tick on
 * the card and a count on the segmented switch. Both are driven by the unread
 * 'completed' notifications the poll returns, and both have to disappear once
 * the user opens the event. (They used to be drawn from "this document is
 * finished" alone, so they never cleared.)
 *
 * All five dashboard pages load the same script, so exercising one covers them;
 * the Deputy shell is used because its three tabs include both a mixed
 * My Calendar list and the ministry-wide Library.
 *
 * No server and no database: the frontend is served from disk and every /api
 * call is answered from the fixture below, which also applies notification
 * reads the way the real endpoint does, so the 45s poll sees what it would see
 * in production.
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

// Two finished documents owned by the viewer: one still carrying its unread
// "new event" + "document ready" notifications, one whose notifications have
// already been read.
const LIBRARY = [
  { id: 1, title: 'Unopened Ready Document', countryCode: 'DE', countryName: 'Germany',
    documentSubmitterId: 3, endedAt: '2026-03-01T10:00:00.000Z', eventDateTime: '2026-03-01T10:00:00.000Z',
    language: 'EN', sections: [] },
  { id: 2, title: 'Already Opened Document', countryCode: 'DE', countryName: 'Germany',
    documentSubmitterId: 3, endedAt: '2026-03-02T10:00:00.000Z', eventDateTime: '2026-03-02T10:00:00.000Z',
    language: 'EN', sections: [] },
];

function freshNotifications() {
  return [
    { id: 11, type: 'event_created', eventId: 1, sectionId: null, meta: {}, isRead: false, createdAt: '2026-03-01T09:00:00.000Z' },
    { id: 12, type: 'completed', eventId: 1, sectionId: null, meta: {}, isRead: false, createdAt: '2026-03-01T10:00:00.000Z' },
    { id: 13, type: 'completed', eventId: 2, sectionId: null, meta: {}, isRead: true, createdAt: '2026-03-02T10:00:00.000Z' },
  ];
}

/**
 * Serve the dashboard with a stubbed API.
 *
 * `readFails` makes POST /api/notifications/read answer 500 and leaves the rows
 * unread, which is how a dropped request looks to the page.
 */
async function openDashboard(page, { readFails = false, user = USER, library = LIBRARY, events = [], page_ = 'deputy' } = {}) {
  const state = { notifications: freshNotifications(), posted: [] };

  await page.addInitScript(([user, origin_]) => {
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('locale', 'en');
    window.__origin = origin_;
  }, [user, origin]);

  // The page pulls html2pdf / docx / flatpickr off CDNs; the badges need none of
  // them, and the test must not depend on the network.
  await page.route(/^https:\/\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }));

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/me') return json(user);
    if (url.pathname === '/api/library') return json(library);
    if (url.pathname === '/api/notifications') {
      return json({
        unreadCount: state.notifications.filter(n => !n.isRead).length,
        notifications: state.notifications,
      });
    }
    if (url.pathname === '/api/notifications/read') {
      const body = JSON.parse(route.request().postData() || '{}');
      state.posted.push(body);
      if (readFails) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
      }
      // Mirror the real endpoint: mark this event's rows of these types read.
      const types = Array.isArray(body.type) ? body.type : [body.type];
      state.notifications = state.notifications.map(n =>
        (n.eventId === body.eventId && types.includes(n.type)) ? { ...n, isRead: true } : n);
      return json({ success: true });
    }
    if (url.pathname === '/api/events') return json(events);
    return json([]);   // /api/workflow/my-turn, anything else
  });

  await page.goto(`${origin}/pages/dashboard-${page_}.html`);
  // The default tab is not always the populated one (a Supervisor's My Calendar
  // holds only events they own), so wait for the list to have rendered at all.
  await page.waitForSelector('.mn-list .mn-card, .mn-list .empty-state');
  return state;
}

const card = (page, title) => page.locator('.mn-list .mn-card', { hasText: title });
const tab = (page, mode) => page.locator(`.mn-toggle__btn[data-mode="${mode}"]`);

test.describe('the green "document ready" cue', () => {
  test('marks only the documents the user has not opened', async ({ page }) => {
    await openDashboard(page);
    // A Deputy's finished documents live on Archive; My Calendar carries only
    // the events still to come, so it is empty for this fixture.
    await expect(page.locator('.mn-list .empty-state')).toHaveCount(1);
    await page.click('.mn-toggle__btn[data-mode="docs"]');
    await expect(page.locator('.mn-list .mn-card')).toHaveCount(2);

    await expect(card(page, 'Unopened Ready Document').locator('.mn-card__attn--ready')).toHaveCount(1);
    // Finished, but its notification was already read — no cue at all. (Drawing
    // one on every finished document is what made the badge permanent.)
    await expect(card(page, 'Already Opened Document').locator('.mn-card__attn')).toHaveCount(0);

    // The switch counts the same thing: one unopened document, not two finished ones.
    await expect(tab(page, 'docs')).toHaveAttribute('data-dot', 'green');
    await expect(tab(page, 'docs')).toHaveAttribute('data-count', '1');
  });

  test('a finished document still says so, cue or no cue', async ({ page }) => {
    // The chip earns its place where a list mixes states. The Supervisor has no
    // Archive tab, so their My Calendar still holds finished and in-preparation
    // events together — the case a Deputy's used to be.
    const SV = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: null };
    await openDashboard(page, { user: SV, page_: 'supervisor' });
    // Status lives on the chip, which stays; the corner dot is only the cue.
    await expect(card(page, 'Already Opened Document').locator('.mn-chip--ready')).toHaveCount(1);
  });
});

test.describe('the readiness chip', () => {
  // Supervisors have no Library tab, so their Other Events list carries finished
  // and in-preparation events together — the one place where the chip is the
  // only thing telling them apart once the green cue has cleared.
  const SUPERVISOR = { id: 3, fullName: 'Supervisor Test', username: 'sv', role: 'SUPERVISOR', departmentId: null };
  const OTHERS_EVENT = { id: 5, title: 'Still In Preparation', countryCode: 'DE', countryName: 'Germany',
    documentSubmitterId: 99, deadlineDate: '2026-04-01', isActive: true, language: 'EN', sections: [] };

  test('appears on a list that mixes finished and in-preparation events', async ({ page }) => {
    // Other Events is the events the user contributes to but does not own, so
    // the finished ones have to be somebody else's document too.
    const contributed = LIBRARY.map(d => ({ ...d, documentSubmitterId: 99 }));
    await openDashboard(page, { user: SUPERVISOR, library: contributed, events: [OTHERS_EVENT], page_: 'supervisor' });
    await page.click('.mn-toggle__btn[data-mode="tasks"]');

    await expect(card(page, 'Still In Preparation').locator('.mn-chip--prep')).toHaveCount(1);
    // The finished ones on the same list are the reason the chip is there.
    await expect(card(page, 'Unopened Ready Document').locator('.mn-chip--ready')).toHaveCount(1);
  });

  test('stays off a list that is all one state', async ({ page }) => {
    // A Deputy's Other Events holds only in-preparation work (finished documents
    // live on their Library tab), so a chip on every card would say nothing.
    await openDashboard(page, { events: [OTHERS_EVENT] });
    await page.click('.mn-toggle__btn[data-mode="tasks"]');

    await expect(card(page, 'Still In Preparation')).toHaveCount(1);
    await expect(card(page, 'Still In Preparation').locator('.mn-chip')).toHaveCount(0);
  });
});

test.describe('opening an event clears the cue', () => {

  test('opening the event clears it, on the card and on the switch', async ({ page }) => {
    const state = await openDashboard(page);
    await page.click('.mn-toggle__btn[data-mode="docs"]');   // finished documents live here

    await card(page, 'Unopened Ready Document').click();
    // The corner dot is CSS-hidden while a card is expanded, so close it again —
    // that is exactly where the old behaviour showed itself.
    await page.click('.mn-card__close');

    await expect(card(page, 'Unopened Ready Document').locator('.mn-card__attn')).toHaveCount(0);
    await expect(tab(page, 'meetings')).not.toHaveAttribute('data-dot', /.*/);
    await expect(tab(page, 'docs')).not.toHaveAttribute('data-dot', /.*/);

    // One request, carrying both of the event's cue notifications: an event that
    // was created and later published holds both, and clearing one would leave
    // the other's dot on a card the user has just read.
    expect(state.posted).toEqual([{ eventId: 1, type: ['event_created', 'completed'] }]);
  });

  test('a failed read puts the cue back', async ({ page }) => {
    // The dot goes on the click rather than after the round-trip. That optimism
    // must not survive a request that did not land.
    await openDashboard(page, { readFails: true });
    await page.click('.mn-toggle__btn[data-mode="docs"]');   // finished documents live here

    await card(page, 'Unopened Ready Document').click();
    await page.click('.mn-card__close');

    await expect(card(page, 'Unopened Ready Document').locator('.mn-card__attn--ready')).toHaveCount(1);
    await expect(tab(page, 'docs')).toHaveAttribute('data-dot', 'green');
  });
});
