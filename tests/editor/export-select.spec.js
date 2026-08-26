/**
 * Export picker (LibraryDoc.showSectionSelectModal).
 *
 * Discussion-point documents get a two-level Section -> Topic tree; every other
 * document keeps the flat section list. Loads library-doc.js and
 * discussion-points.js into a blank page with the handful of app globals the
 * modal touches — no server needed.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8')
  .replace(/<\/script>/g, '<\\/script>');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.I18n = { tr: k => k, t: k => k, getLocale: () => 'ka' };
  window.escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.toast = { warn: m => { window.__warn = m; }, error(){}, info(){} };
  window.Api = { get: async () => [], getUser: () => ({ id: 1, role: 'ADMIN' }) };
  window.formatDate = d => d;
  window.localizedCountryName = c => c.name_en;
  window.SectionVisibility = { seesAllSections: () => true, isOwnSection: () => true };
</script>
<script>${read('frontend/js/core/discussion-points.js')}</script>
<script>${read('frontend/js/core/library-doc.js')}</script>
</body></html>`;

const card = (id, topic, ctx, add) =>
  `<div data-dp-id="${id}"><h3 data-dp-field="topic">${topic}</h3>` +
  `<div data-dp-field="context">${ctx}</div>` +
  `<div data-dp-field="additional">${add}</div></div>`;

const DP_DOC = {
  documentType: 'DISCUSSION_POINTS',
  language: 'EN',
  sections: [
    { id: 1, title: 'Section A', htmlContent: card('dp-1', 'Trade', '<p>trade ctx</p>', '<p>trade add</p>') +
                                              card('dp-2', 'Investments', '<p>inv ctx</p>', '<p>inv add</p>') },
    { id: 2, title: 'Section B', htmlContent: card('dp-3', 'Tourism', '<p>tour ctx</p>', '<p>tour add</p>') },
  ],
};

const OTHER_DOC = {
  documentType: 'OTHER',
  language: 'EN',
  sections: [
    { id: 1, title: 'Plain A', htmlContent: '<p>a</p>' },
    { id: 2, title: 'Plain B', htmlContent: '<p>b</p>' },
  ],
};

async function openPicker(page, doc) {
  await page.setContent(PAGE);
  await page.evaluate(d => {
    window.__exported = null;
    window.__warn = null;
    LibraryDoc.showSectionSelectModal(d, 'Export', secs => { window.__exported = secs; });
  }, doc);
}

const exported = page => page.evaluate(() => window.__exported);

test.describe('export picker — discussion points', () => {
  test('renders a topic checkbox under each section', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await expect(page.locator('.section-check')).toHaveCount(2);
    await expect(page.locator('.point-check')).toHaveCount(3);
    await expect(page.locator('#sectionChecklist')).toContainText('Trade');
    await expect(page.locator('#sectionChecklist')).toContainText('Tourism');
  });

  test('exports every point when nothing is deselected', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out).toHaveLength(2);
    expect(out[0].selectedPointCount).toBe(2);
    expect(out[1].selectedPointCount).toBe(1);
  });

  test('exports a partially selected section', async ({ page }) => {
    // Regression: a partially selected section is `checked` AND `indeterminate`,
    // and querySelectorAll('.section-check:checked') does NOT match an
    // indeterminate checkbox — reading the parents dropped the section entirely.
    await openPicker(page, DP_DOC);
    await page.evaluate(() => {
      const cb = document.querySelector('.point-check[data-idx="0"][data-point="0"]');
      cb.checked = false; cb.dispatchEvent(new Event('change'));
    });

    const parent = await page.evaluate(() => {
      const s = document.querySelector('.section-check[data-idx="0"]');
      return { checked: s.checked, indeterminate: s.indeterminate };
    });
    expect(parent).toEqual({ checked: true, indeterminate: true });

    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out).toHaveLength(2);
    expect(out[0].selectedPointCount).toBe(1);
    expect(out[0].htmlContent).toContain('Investments');
    expect(out[0].htmlContent).not.toContain('Trade');
  });

  test('drops a section whose topics are all deselected', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.evaluate(() => {
      const s = document.querySelector('.section-check[data-idx="1"]');
      s.checked = false; s.dispatchEvent(new Event('change'));
    });
    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Section A');
  });

  test('warns instead of exporting when nothing is selected', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.click('#selectAllSections');   // unchecks everything
    await page.click('#exportConfirmBtn');
    expect(await exported(page)).toBeNull();
    expect(await page.evaluate(() => window.__warn)).toBe('library.sectionSelect.warnEmptyTopics');
  });

  test('renders selected points as numbered headings with labelled fields', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.click('#exportConfirmBtn');
    const html = (await exported(page))[0].htmlContent;
    expect(html).toContain('>1. Trade<');
    expect(html).toContain('>2. Investments<');
    expect(html).toContain('<b>Discussion Point</b>');
    expect(html).toContain('<b>Additional Information</b>');
    // The storage scaffolding must not reach the exporters.
    expect(html).not.toContain('data-dp-id');
    expect(html).not.toContain('data-dp-field');
  });

  test('numbering restarts at 1 for a partial export', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.evaluate(() => {
      const cb = document.querySelector('.point-check[data-idx="0"][data-point="0"]');
      cb.checked = false; cb.dispatchEvent(new Event('change'));
    });
    await page.click('#exportConfirmBtn');
    expect((await exported(page))[0].htmlContent).toContain('>1. Investments<');
  });

  test('select-all clears the indeterminate state on both levels', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.evaluate(() => {
      const cb = document.querySelector('.point-check[data-idx="0"][data-point="0"]');
      cb.checked = false; cb.dispatchEvent(new Event('change'));
    });
    // Off, then on again.
    await page.click('#selectAllSections');
    await page.click('#selectAllSections');
    const state = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('.section-check')].map(c => c.checked && !c.indeterminate),
      points: [...document.querySelectorAll('.point-check')].map(c => c.checked),
    }));
    expect(state.sections).toEqual([true, true]);
    expect(state.points).toEqual([true, true, true]);
  });
});

test.describe('export picker — other documents', () => {
  test('keeps the flat section list', async ({ page }) => {
    await openPicker(page, OTHER_DOC);
    await expect(page.locator('.section-check')).toHaveCount(2);
    await expect(page.locator('.point-check')).toHaveCount(0);
  });

  test('passes section HTML through untouched', async ({ page }) => {
    await openPicker(page, OTHER_DOC);
    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out.map(s => s.htmlContent)).toEqual(['<p>a</p>', '<p>b</p>']);
  });

  test('honours a deselected section', async ({ page }) => {
    await openPicker(page, OTHER_DOC);
    await page.uncheck('.section-check[data-idx="0"]');
    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Plain B');
  });
});

test.describe('comment pruning for partial exports', () => {
  const COMMENTS = [
    { id: 1, anchorId: 'keep', parentId: null, authorName: 'A', text: 'kept' },
    { id: 2, anchorId: null, parentId: 1, authorName: 'B', text: 'reply to kept' },
    { id: 3, anchorId: 'drop', parentId: null, authorName: 'C', text: 'dropped' },
    { id: 4, anchorId: null, parentId: 3, authorName: 'D', text: 'reply to dropped' },
  ];

  test('keeps only comments whose anchor survived, with their replies', async ({ page }) => {
    // buildDocx registers every comment it is handed but only references the
    // ones whose anchor it meets, so an unpruned list leaves dangling entries
    // in word/comments.xml.
    await page.setContent(PAGE);
    const kept = await page.evaluate(cs => LibraryDoc.commentsAnchoredIn(
      '<p>x <span class="gcp-cmt-anchor" data-cmt-anchor-id="keep">y</span></p>', cs), COMMENTS);
    expect(kept.map(c => c.id)).toEqual([1, 2]);
  });

  test('drops everything when no anchor survives', async ({ page }) => {
    await page.setContent(PAGE);
    const kept = await page.evaluate(cs => LibraryDoc.commentsAnchoredIn('<p>no anchors</p>', cs), COMMENTS);
    expect(kept).toEqual([]);
  });
});

test.describe('recording the meeting agenda', () => {
  // The owner's export selection is the record of what went into the meeting.
  // It is captured here, in the only place that still knows which points were
  // chosen — by the time onExport runs, the sections carry rendered HTML and
  // point identity is gone.

  // Drives the real export path — LibraryDoc.exportPdf — rather than the modal
  // alone, since that is where the recording hangs off. html2pdf is absent
  // here, so the print fallback is stubbed out.
  async function exportAs(page, doc, viewerId, opts = {}) {
    await page.setContent(PAGE);
    await page.evaluate(({ d, id, fail, role }) => {
      window.__exported = null;
      window.__posted = null;
      window.Api.getUser = () => ({ id, role: role || 'SUPER_COLLABORATOR' });
      window.Api.get = async () => d;
      window.Api.post = async (path, body) => {
        window.__posted = { path, body };
        if (fail) throw new Error('recording failed');
        return { success: true };
      };
      window.open = () => ({
        document: { write(html) { window.__exported = html; }, close() {} },
        print() {},
      });
      LibraryDoc.exportPdf(d.eventId);
    }, { d: doc, id: viewerId, fail: !!opts.fail, role: opts.role || null });
    await page.waitForSelector('#exportConfirmBtn');
  }

  const OWNED = { ...DP_DOC, eventId: 7, documentSubmitterId: 1 };

  test('the picker hands back the chosen points, not just their HTML', async ({ page }) => {
    await openPicker(page, DP_DOC);
    await page.click('#exportConfirmBtn');
    const out = await exported(page);
    expect(out[0].selectedPoints.map(p => p.id)).toEqual(['dp-1', 'dp-2']);
    expect(out[1].selectedPoints.map(p => p.id)).toEqual(['dp-3']);
    // The existing contract is unchanged.
    expect(out[0].selectedPointCount).toBe(2);
  });

  test('the owner exporting records exactly what was ticked', async ({ page }) => {
    await exportAs(page, OWNED, 1);
    await page.evaluate(() => {
      const cb = document.querySelector('.point-check[data-idx="0"][data-point="0"]');
      cb.checked = false; cb.dispatchEvent(new Event('change'));
    });
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__posted !== null);
    const posted = await page.evaluate(() => window.__posted);
    expect(posted.path).toBe('/api/meeting-summaries/agenda');
    expect(posted.body.eventId).toBe(7);
    expect(posted.body.points.map(p => p.dpId)).toEqual(['dp-2', 'dp-3']);
    expect(posted.body.points[0]).toMatchObject({ sectionId: 1, topic: 'Investments' });
    expect(posted.body.points[1]).toMatchObject({ sectionId: 2, topic: 'Tourism' });
  });

  test('Protocol records for a Minister-owned document', async ({ page }) => {
    // The Minister is read-only and never logs in to export, so without this
    // a Minister's agenda could never be recorded by anyone at all.
    await exportAs(page, { ...OWNED, documentSubmitterId: 42, documentSubmitterRole: 'MINISTER' },
      7, { role: 'PROTOCOL' });
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__posted !== null);
    const posted = await page.evaluate(() => window.__posted);
    expect(posted.path).toBe('/api/meeting-summaries/agenda');
  });

  test("Protocol's standing does not extend past the Minister", async ({ page }) => {
    // On someone else's document Protocol is no different from any other reader.
    await exportAs(page, { ...OWNED, documentSubmitterId: 42, documentSubmitterRole: 'DEPUTY' },
      7, { role: 'PROTOCOL' });
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__exported !== null);
    expect(await page.evaluate(() => window.__posted)).toBeNull();
  });

  test("an admin's export does not rewrite someone else's agenda", async ({ page }) => {
    // Admin authority belongs on the deliberate, confirmed act of sending, not
    // on a casual export. Recording happens silently as a side effect, and an
    // admin exporting a partial selection would drop the owner's other points
    // off the agenda without anyone being told — revoking supervisors' access
    // to summaries already assigned to them.
    await exportAs(page, { ...OWNED, documentSubmitterId: 42, documentSubmitterRole: 'DEPUTY' },
      7, { role: 'ADMIN' });
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__exported !== null);
    expect(await page.evaluate(() => window.__posted)).toBeNull();
  });

  test('a non-owner records nothing', async ({ page }) => {
    // Everyone who can read the document can export it; only the owner's
    // selection is the agenda of record.
    await exportAs(page, OWNED, 99);
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__exported !== null);
    expect(await page.evaluate(() => window.__posted)).toBeNull();
  });

  test('a document that is not discussion points records nothing', async ({ page }) => {
    await exportAs(page, { ...OTHER_DOC, eventId: 8, documentSubmitterId: 1 }, 1);
    await page.click('#exportConfirmBtn');
    await page.waitForFunction(() => window.__exported !== null);
    expect(await page.evaluate(() => window.__posted)).toBeNull();
  });

  test('a failed recording still lets the export through', async ({ page }) => {
    // Recording is fire-and-forget on purpose: it must never cost the user
    // the file they asked for.
    await exportAs(page, OWNED, 1, { fail: true });
    await page.click('#exportConfirmBtn');
    // The file is still produced even though the recording threw.
    await page.waitForFunction(() => window.__exported !== null);
    expect(await page.evaluate(() => window.__exported)).toContain('Investments');
  });
});
