/**
 * The Meeting Summary table — the two-column view a Supervisor fills in after
 * a meeting: the extracted discussion point on the left, their summary on the
 * right.
 *
 * Serverless, like the other editor specs: the module sources are injected
 * into a blank page and Api/I18n/toast/LibraryDoc are stubbed, so the whole
 * table is exercised without a server or a database.
 *
 * What it pins:
 *  - the left column renders the agenda *snapshot*, so it cannot shift under a
 *    supervisor when the owner reopens and edits the document;
 *  - only rows the viewer is assigned to mount an editor — everyone else's are
 *    read-only, which is the client half of the server's assignee-only rule;
 *  - a point nobody was assigned to is visibly flagged rather than silently
 *    blank;
 *  - saving posts the edited HTML and re-renders the attribution line, which is
 *    how a supervisor discovers a co-assignee overwrote them.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/user/vector_portal';
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DOC = {
  eventId: 1, title: 'Trade meeting', language: 'EN',
  countryCode: 'TL', countryName: 'Testland', endedAt: null,
  hasMeetingTime: true, opened: true, canEditAny: true,
  progress: { done: 1, total: 2, unassigned: 1 },
  items: [
    { agendaPointId: 1, summaryId: 1, sectionId: 1, sectionTitle: 'Trade', dpId: 'dp-a',
      position: 0, topic: 'Trade turnover', contextHtml: '<p>Context one</p>',
      additionalHtml: '<p>Extra one</p>', summaryHtml: '<p>Agreed to raise targets.</p>',
      filled: true, opened: true, removedFromAgenda: false, deadlineDate: '2026-09-02',
      assignees: [{ id: 2, fullName: 'Sup A1' }], lastEditedBy: 'Sup A1',
      lastEditedAt: '2026-08-26T11:00:00Z', canEdit: true },
    { agendaPointId: 3, summaryId: 3, sectionId: 3, sectionTitle: 'Orphan', dpId: 'dp-c',
      position: 1, topic: 'Nobody owns this', contextHtml: '<p>Context three</p>',
      additionalHtml: '', summaryHtml: '', filled: false, opened: true,
      removedFromAgenda: false, deadlineDate: '2026-09-02', assignees: [],
      lastEditedBy: null, lastEditedAt: null, canEdit: false },
  ],
};

test('meeting summary table renders and saves', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: read('frontend/js/core/discussion-points.js') });
  await page.addScriptTag({ content: read('frontend/js/simple-editor.js') });
  await page.evaluate((doc) => {
    window.__saved = null;
    window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    window.localizedName = (a) => a || '';
    window.formatDate = d => String(d).slice(0, 10);
    window.I18n = { tr: k => k, translateRoot: () => {} };
    window.toast = { success(){}, error(){}, warn(){} };
    window.__exportedSections = null;
    window.LibraryDoc = {
      exportHtmlAsPdf(d, secs) { window.__exportedSections = secs; },
      exportSectionsAsDocx(d, secs) { window.__exportedSections = secs; },
      canActAsOwner(d, viewer) {
        if (!d || !viewer) return false;
        if (viewer.role === 'ADMIN') return true;
        if (d.documentSubmitterId && d.documentSubmitterId === viewer.id) return true;
        return viewer.role === 'PROTOCOL' && d.documentSubmitterRole === 'MINISTER';
      },
    };
    window.Api = {
      get: async () => doc,
      put: async (p, b) => { window.__saved = { path: p, body: b };
        return { success: true, filled: true, status: 'SUBMITTED',
                 lastEditedBy: 'Sup A2', lastEditedAt: '2026-08-26T12:00:00Z' }; },
    };
  }, DOC);
  await page.addScriptTag({ content: read('frontend/js/core/meeting-summary.js') });

  await page.evaluate(() => window.GCP.MeetingSummary.open(1));
  await page.waitForSelector('.ms-overlay');

  // Two rows, two columns.
  await expect(page.locator('.ms-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.ms-table thead th')).toHaveCount(2);

  // Left column shows the snapshot, numbered, with the export field labels.
  await expect(page.locator('.ms-table tbody tr').first()).toContainText('1. Trade turnover');
  await expect(page.locator('.ms-table tbody tr').first()).toContainText('Context one');

  // Editable row mounts the lightweight editor; read-only row does not.
  await expect(page.locator('tr[data-row="0"] .se-body')).toHaveCount(1);
  await expect(page.locator('tr[data-row="1"] .se-body')).toHaveCount(0);
  await expect(page.locator('tr[data-row="1"] .ms-ro--empty')).toContainText('Not yet written');

  // The unassigned row is flagged.
  await expect(page.locator('tr[data-row="1"] .ms-chip--unassigned')).toHaveCount(1);

  // Saving posts the edited HTML and refreshes the byline.
  await page.evaluate(() => {
    document.querySelector('tr[data-row="0"] .se-body').innerHTML = '<p>Revised text</p>';
  });
  await page.click('tr[data-row="0"] .ms-btn--primary');
  await page.waitForFunction(() => window.__saved !== null);
  const saved = await page.evaluate(() => window.__saved);
  expect(saved.path).toBe('/api/meeting-summaries/row/1');
  expect(saved.body.summaryHtml).toContain('Revised text');
  await expect(page.locator('tr[data-row="0"] .ms-byline')).toContainText('Sup A2');

  // Re-saving a row that already counted must not count it twice.
  await expect(page.locator('[data-progress]')).toContainText('1 of 2');

  expect(errors).toEqual([]);
});

test('exporting after a save carries the saved text, not the loaded one', async ({ page }) => {
  // Regression: the save used to update only the byline, leaving the loaded
  // document stale — so an export taken straight afterwards printed the old
  // text, and "Not yet written" for a row that had just been filled in.
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: read('frontend/js/core/discussion-points.js') });
  await page.addScriptTag({ content: read('frontend/js/simple-editor.js') });
  await page.evaluate((doc) => {
    window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    window.localizedName = a => a || '';
    window.formatDate = d => String(d).slice(0, 10);
    window.I18n = { tr: k => k, translateRoot: () => {} };
    window.toast = { success(){}, error(){}, warn(){} };
    window.__exportedSections = null;
    window.LibraryDoc = {
      exportHtmlAsPdf(d, secs) { window.__exportedSections = secs; },
      exportSectionsAsDocx(d, secs) { window.__exportedSections = secs; },
      canActAsOwner(d, viewer) {
        if (!d || !viewer) return false;
        if (viewer.role === 'ADMIN') return true;
        if (d.documentSubmitterId && d.documentSubmitterId === viewer.id) return true;
        return viewer.role === 'PROTOCOL' && d.documentSubmitterRole === 'MINISTER';
      },
    };
    // Start from an unwritten row so the export would say "Not yet written".
    const blank = JSON.parse(JSON.stringify(doc));
    blank.items[0].summaryHtml = '';
    blank.items[0].filled = false;
    blank.progress = { done: 0, total: 2, unassigned: 1 };
    window.Api = {
      get: async () => blank,
      put: async () => ({ success: true, filled: true, status: 'SUBMITTED',
                          lastEditedBy: 'Sup A1', lastEditedAt: '2026-08-26T12:00:00Z' }),
    };
  }, DOC);
  await page.addScriptTag({ content: read('frontend/js/core/meeting-summary.js') });

  await page.evaluate(() => window.GCP.MeetingSummary.open(1));
  await page.waitForSelector('.ms-overlay');
  await expect(page.locator('[data-progress]')).toContainText('0 of 2');

  await page.evaluate(() => {
    document.querySelector('tr[data-row="0"] .se-body').innerHTML = '<p>Freshly written</p>';
  });
  await page.click('tr[data-row="0"] .ms-btn--primary');
  await expect(page.locator('[data-progress]')).toContainText('1 of 2');

  await page.click('[data-act="pdf"]');
  await page.waitForFunction(() => window.__exportedSections !== null);
  const html = await page.evaluate(() => window.__exportedSections[0].htmlContent);
  expect(html).toContain('Freshly written');
  expect(html).not.toContain('Not yet written</i></p></td></tr><tr><td><p class="ms-point-title">1.');

  expect(errors).toEqual([]);
});

// ── Sending ──────────────────────────────────────────────────────────────────
// Summaries go out when the Document Owner presses the button, not on a timer,
// so the button's presence and wording are the whole contract here.

async function openWith(page, overrides, opts = {}) {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: read('frontend/js/core/discussion-points.js') });
  await page.addScriptTag({ content: read('frontend/js/simple-editor.js') });
  await page.evaluate(({ base, over, confirmResult }) => {
    window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    window.localizedName = a => a || '';
    window.formatDate = d => String(d).slice(0, 10);
    window.I18n = { tr: k => k, translateRoot: () => {} };
    window.toast = { success(){}, error(){}, warn(){} };
    window.LibraryDoc = { exportHtmlAsPdf(){}, exportSectionsAsDocx(){},
      canActAsOwner(d, v) {
        if (!d || !v) return false;
        if (v.role === 'ADMIN') return true;
        if (d.documentSubmitterId && d.documentSubmitterId === v.id) return true;
        return v.role === 'PROTOCOL' && d.documentSubmitterRole === 'MINISTER';
      } };
    window.__sent = null;
    window.__confirmed = null;
    window.GCP = window.GCP || {};
    window.GCP.ActionDialog = {
      confirm(msg) { window.__confirmed = msg; return Promise.resolve(confirmResult); },
    };
    const doc = Object.assign(JSON.parse(JSON.stringify(base)), over);
    window.Api = {
      get: async () => doc,
      put: async () => ({ success: true, filled: true, status: 'SUBMITTED' }),
      post: async (path) => { window.__sent = path; return { opened: doc.unsentCount, supervisors: 2, unassigned: 0 }; },
    };
  }, { base: DOC, over: overrides, confirmResult: opts.confirm !== false });
  await page.addScriptTag({ content: read('frontend/js/core/meeting-summary.js') });
  await page.evaluate(() => window.GCP.MeetingSummary.open(1));
  await page.waitForSelector('.ms-overlay');
}

test('a viewer who may send gets the button, one who may not does not', async ({ page }) => {
  await openWith(page, { canSend: true, unsentCount: 2, opened: false });
  await expect(page.locator('[data-act="send"]')).toHaveCount(1);

  await openWith(page, { canSend: false, unsentCount: 2, opened: false });
  await expect(page.locator('[data-act="send"]')).toHaveCount(0);
  // ...and is told what it is waiting on instead of being left guessing.
  await expect(page.locator('.ms-note')).toContainText('waiting for the document owner');
});

test('nothing left to send means no button', async ({ page }) => {
  await openWith(page, { canSend: true, unsentCount: 0, opened: true });
  await expect(page.locator('[data-act="send"]')).toHaveCount(0);
});

test('the button reads "send new points" once some are already out', async ({ page }) => {
  // A re-export that adds a point after the first send is the common case, and
  // the wording has to say it is a top-up rather than the first send.
  await openWith(page, { canSend: true, unsentCount: 1, opened: true });
  await expect(page.locator('[data-act="send"]')).toContainText('Send new points (1)');

  await openWith(page, { canSend: true, unsentCount: 2, opened: false });
  await expect(page.locator('[data-act="send"]')).toContainText('Send for Meeting Summary (2)');
});

test('sending confirms first, then posts', async ({ page }) => {
  await openWith(page, { canSend: true, unsentCount: 2, opened: false });
  await page.click('[data-act="send"]');
  await page.waitForFunction(() => window.__sent !== null);
  expect(await page.evaluate(() => window.__confirmed)).toBeTruthy();
  expect(await page.evaluate(() => window.__sent)).toBe('/api/meeting-summaries/1/send');
});

test('declining the confirmation sends nothing', async ({ page }) => {
  // Sending assigns work to other people; a mis-click must not do it.
  await openWith(page, { canSend: true, unsentCount: 2, opened: false }, { confirm: false });
  await page.click('[data-act="send"]');
  await page.waitForFunction(() => window.__confirmed !== null);
  expect(await page.evaluate(() => window.__sent)).toBeNull();
  await expect(page.locator('[data-act="send"]')).toBeEnabled();
});

test('sending still works where the styled dialog is absent', async ({ page }) => {
  // Regression: the Archive page loads a smaller set of core modules than the
  // dashboards, and calling GCP.ActionDialog.confirm there threw — leaving the
  // button a silent no-op that showed no dialog and sent nothing.
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: read('frontend/js/core/discussion-points.js') });
  await page.addScriptTag({ content: read('frontend/js/simple-editor.js') });
  await page.evaluate(() => {
    window.escapeHtml = s => String(s == null ? '' : s);
    window.localizedName = a => a || '';
    window.formatDate = d => String(d).slice(0, 10);
    window.I18n = { tr: k => k, translateRoot: () => {} };
    window.toast = { success(){}, error(){}, warn(){} };
    window.LibraryDoc = { canActAsOwner: () => true };
    window.__sent = null;
    // No GCP.ActionDialog at all — exactly the Archive page's situation.
    window.GCP = {};
    window.confirm = () => true;
    window.Api = { post: async (p) => { window.__sent = p; return { opened: 1, supervisors: 1, unassigned: 0 }; } };
  });
  await page.addScriptTag({ content: read('frontend/js/core/meeting-summary.js') });

  const out = await page.evaluate(() => window.GCP.MeetingSummary.sendWithConfirm(4, 1));
  expect(out).toMatchObject({ opened: 1 });
  expect(await page.evaluate(() => window.__sent)).toBe('/api/meeting-summaries/4/send');
});

test('a top-up send shows each row its own deadline', async ({ page }) => {
  // Deadlines run a week from the send, so points added by a later send are
  // due after the first batch. One header chip would show the wrong date on
  // the newer rows — and an "Overdue" chip once the first batch's date passed.
  await openWith(page, {
    canSend: false, unsentCount: 0, opened: true, canEditAny: false,
    items: [
      { agendaPointId: 1, summaryId: 1, sectionId: 1, sectionTitle: 'Trade', dpId: 'dp-a',
        position: 0, topic: 'First batch', contextHtml: '', additionalHtml: '',
        summaryHtml: '', filled: false, opened: true, removedFromAgenda: false,
        deadlineDate: '2099-01-01', assignees: [{ id: 2, fullName: 'Sup A1' }],
        lastEditedBy: null, lastEditedAt: null, canEdit: false },
      { agendaPointId: 2, summaryId: 2, sectionId: 2, sectionTitle: 'Tourism', dpId: 'dp-b',
        position: 1, topic: 'Added later', contextHtml: '', additionalHtml: '',
        summaryHtml: '', filled: false, opened: true, removedFromAgenda: false,
        deadlineDate: '2099-02-02', assignees: [{ id: 3, fullName: 'Sup B1' }],
        lastEditedBy: null, lastEditedAt: null, canEdit: false },
    ],
  });
  await expect(page.locator('tr[data-row="0"]')).toContainText('2099-01-01');
  await expect(page.locator('tr[data-row="1"]')).toContainText('2099-02-02');
  // The header chip stands down while the rows disagree.
  await expect(page.locator('.ms-meta .ms-chip')).toHaveCount(0);
});
