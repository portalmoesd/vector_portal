const { test, expect } = require('@playwright/test');
const { bootDiscussionPoints } = require('./helpers');

const TWO_POINTS =
  '<div data-dp-id="dp-1"><h3 data-dp-field="topic">Trade turnover</h3>' +
  '<div data-dp-field="context"><p>context one</p></div>' +
  '<div data-dp-field="additional"><p>extra one</p></div></div>' +
  '<div data-dp-id="dp-2"><h3 data-dp-field="topic">Investments</h3>' +
  '<div data-dp-field="context"><p>context two</p></div>' +
  '<div data-dp-field="additional"><p>extra two</p></div></div>';

test.describe('DiscussionPointsEditor', () => {
  test('renders one card per point with three fields each', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });

    await expect(page.locator('.gcp-dp-card')).toHaveCount(2);
    await expect(page.locator('.gcp-dp-topic')).toHaveCount(2);
    // Two rich fields per card => four editor bodies.
    await expect(page.locator('.gcp-dp-field .gcp-re-body')).toHaveCount(4);

    await expect(page.locator('.gcp-dp-topic').first()).toHaveValue('Trade turnover');
    await expect(page.locator('.gcp-dp-topic').nth(1)).toHaveValue('Investments');
  });

  test('round-trips content through getHtml without mutating it', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });
    const out = await page.evaluate(() => window.ed.getHtml());
    expect(out).toBe(TWO_POINTS);
  });

  test('getHtml is stable across calls (no autosave storm)', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });
    const [a, b, c] = await page.evaluate(() =>
      [window.ed.getHtml(), window.ed.getHtml(), window.ed.getHtml()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('parses legacy free-form content into a single point without losing it', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: '<p>legacy prose</p><p>second para</p>' });

    await expect(page.locator('.gcp-dp-card')).toHaveCount(1);
    await expect(page.locator('.gcp-dp-topic')).toHaveValue('');
    const html = await page.evaluate(() => window.ed.getHtml());
    expect(html).toContain('legacy prose');
    expect(html).toContain('second para');
  });

  test('typing in Context stays inside that field', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });

    const firstContext = page.locator('.gcp-dp-card').first().locator('.gcp-re-body').first();
    await firstContext.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' APPENDED');

    const points = await page.evaluate(() => window.ed.getPoints());
    expect(points).toHaveLength(2);
    expect(points[0].contextHtml).toContain('APPENDED');
    // The neighbouring fields and the second card are untouched.
    expect(points[0].additionalHtml).not.toContain('APPENDED');
    expect(points[1].contextHtml).toBe('<p>context two</p>');
    expect(points[1].additionalHtml).toBe('<p>extra two</p>');
  });

  test('typed text is tracked as an insertion', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });
    const firstContext = page.locator('.gcp-dp-card').first().locator('.gcp-re-body').first();
    await firstContext.click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');

    const html = await page.evaluate(() => window.ed.getHtml());
    expect(html).toMatch(/<ins[^>]*data-tc-id/);
    // The insertion lives inside the context field, not loose in the section.
    const inContext = await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = window.ed.getHtml();
      return !!d.querySelector('[data-dp-field="context"] ins[data-tc-id]');
    });
    expect(inContext).toBe(true);
  });

  test('Backspace at the start of Context cannot merge into another field', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });

    const secondCardContext = page.locator('.gcp-dp-card').nth(1).locator('.gcp-re-body').first();
    await secondCardContext.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    // Both cards, both topics and all four fields still exist and are separate.
    await expect(page.locator('.gcp-dp-card')).toHaveCount(2);
    const points = await page.evaluate(() => window.ed.getPoints());
    expect(points[0].topic).toBe('Trade turnover');
    expect(points[1].topic).toBe('Investments');
    expect(points[0].contextHtml).toBe('<p>context one</p>');
    expect(points[0].additionalHtml).toBe('<p>extra one</p>');
  });

  test('adds, reorders and deletes points', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });

    await page.locator('.gcp-dp-add').click();
    await expect(page.locator('.gcp-dp-card')).toHaveCount(3);
    await page.locator('.gcp-dp-topic').nth(2).fill('Third topic');

    // Move the third point up one slot.
    await page.locator('.gcp-dp-card').nth(2).locator('.gcp-dp-up').click();
    let topics = await page.evaluate(() => window.ed.getPoints().map(p => p.topic));
    expect(topics).toEqual(['Trade turnover', 'Third topic', 'Investments']);

    // Delete it again (window.confirm fallback — no ActionDialog in the fixture).
    page.on('dialog', d => d.accept());
    await page.locator('.gcp-dp-card').nth(1).locator('.gcp-dp-del').click();
    await expect(page.locator('.gcp-dp-card')).toHaveCount(2);
    topics = await page.evaluate(() => window.ed.getPoints().map(p => p.topic));
    expect(topics).toEqual(['Trade turnover', 'Investments']);
  });

  test('drops points the author left completely empty', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS });
    await page.locator('.gcp-dp-add').click();
    // The new card is untouched, so it must not reach the database.
    const html = await page.evaluate(() => window.ed.getHtml());
    expect(html).toBe(TWO_POINTS);
  });

  test('serializes an empty section to the empty string', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: '' });
    await expect(page.locator('.gcp-dp-card')).toHaveCount(0);
    expect(await page.evaluate(() => window.ed.getHtml())).toBe('');
  });

  test('read-only mode hides the structural controls', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: TWO_POINTS, readOnly: true });

    await expect(page.locator('.gcp-dp-card')).toHaveCount(2);
    await expect(page.locator('.gcp-dp-topic').first()).toBeDisabled();
    await expect(page.locator('.gcp-dp-add')).toBeHidden();
    await expect(page.locator('.gcp-dp-card-actions')).toHaveCount(0);
    const editable = await page.evaluate(() =>
      [...document.querySelectorAll('.gcp-dp-field .gcp-re-body')]
        .map(b => b.getAttribute('contenteditable')));
    expect(editable).toEqual(['false', 'false', 'false', 'false']);
  });
});

test.describe('DiscussionPointsEditor comments', () => {
  const ANCHORED =
    '<div data-dp-id="dp-1"><h3 data-dp-field="topic">One</h3>' +
    '<div data-dp-field="context"><p>a <span class="gcp-cmt-anchor" data-cmt-anchor-id="an-1">x</span></p></div>' +
    '<div data-dp-field="additional"><p>b <span class="gcp-cmt-anchor" data-cmt-anchor-id="an-2">y</span></p></div></div>' +
    '<div data-dp-id="dp-2"><h3 data-dp-field="topic">Two</h3>' +
    '<div data-dp-field="context"><p>c</p></div>' +
    '<div data-dp-field="additional"><p>d</p></div></div>';

  const COMMENTS = [
    { id: 1, anchor_id: 'an-1', parent_id: null, author_name: 'A', comment_text: 'first', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, anchor_id: null, parent_id: 1, author_name: 'B', comment_text: 'reply', created_at: '2026-01-01T00:01:00Z' },
    { id: 3, anchor_id: 'an-2', parent_id: null, author_name: 'C', comment_text: 'second', created_at: '2026-01-01T00:02:00Z' },
  ];

  test('renders each comment exactly once across the fields', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: ANCHORED });
    await page.evaluate(cs => window.ed.setComments(cs), COMMENTS);

    // Two anchored roots => two balloons total, not one per field editor.
    await expect(page.locator('.gcp-re-balloon')).toHaveCount(2);
  });

  test('does not report comments anchored in sibling fields as orphaned', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: ANCHORED });
    await page.evaluate(cs => window.ed.setComments(cs), COMMENTS);

    // Both anchors are present somewhere in the section, so nothing is orphaned.
    // A naive per-field delegation would return every other field's ids here,
    // and the pages delete whatever this returns on the next save.
    const orphans = await page.evaluate(() => window.ed.getOrphanedCommentIds());
    expect(orphans).toEqual([]);
  });

  test('reports a comment as orphaned once its anchor is removed, with replies', async ({ page }) => {
    await bootDiscussionPoints(page, { initialHtml: ANCHORED });
    await page.evaluate(cs => window.ed.setComments(cs), COMMENTS);

    await page.evaluate(() => window.ed.removeCommentAnchor('an-1'));
    const orphans = await page.evaluate(() => window.ed.getOrphanedCommentIds());
    expect(orphans.sort()).toEqual([1, 2]);   // root plus its reply
  });
});
