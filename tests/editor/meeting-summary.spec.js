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
