const { test, expect } = require('@playwright/test');
const { bootEditor, setCaret } = require('./helpers');

test.describe('editor UI and document operations', () => {
  test('backspace at block start merges the paragraph into the previous one', async ({ page }) => {
    // Regression: mergeBlockIntoPrevious used an undeclared variable and threw
    await bootEditor(page, { initialHtml: '<p>first</p><p>second</p>' });
    await page.evaluate(() => {
      const p2 = document.querySelectorAll('#host .gcp-re-body p')[1];
      const r = document.createRange();
      r.setStart(p2.firstChild, 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      document.querySelector('#host .gcp-re-body').focus();
      sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Backspace');
    const ps = page.locator('.gcp-re-body p');
    await expect(ps).toHaveCount(1);
    await expect(ps).toHaveText('firstsecond');
  });

  test('forward delete at block end merges the next paragraph in', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>first</p><p>second</p>' });
    await setCaret(page, 'p', 5);
    await page.keyboard.press('Delete');
    const ps = page.locator('.gcp-re-body p');
    await expect(ps).toHaveCount(1);
    await expect(ps).toHaveText('firstsecond');
  });

  test('table context menu opens and row/column operations work', async ({ page }) => {
    // Regression: the menu referenced an undeclared variable and never opened
    await bootEditor(page, {
      initialHtml: '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table><p>x</p>',
    });
    await page.locator('.gcp-re-body td').first().click({ button: 'right' });
    const menu = page.locator('.gcp-re-ctx');
    await expect(menu).toBeVisible();

    await menu.locator('.gcp-re-ctx-item', { hasText: 'Insert row below' }).click();
    await expect(page.locator('.gcp-re-body tr')).toHaveCount(3);

    await page.locator('.gcp-re-body td').first().click({ button: 'right' });
    await page.locator('.gcp-re-ctx .gcp-re-ctx-item', { hasText: 'Delete column' }).click();
    expect(await page.evaluate(() =>
      document.querySelector('#host .gcp-re-body tr').cells.length)).toBe(1);
  });

  test('initialHtml is sanitized: scripts and handlers stripped, tracked markup kept', async ({ page }) => {
    await bootEditor(page, {
      initialHtml:
        '<p>keep <b>bold</b></p><script>window.pwned = 1</script>' +
        '<img src="x" onerror="window.pwned = 2">' +
        '<a href="javascript:window.pwned=3">link</a>' +
        '<ins data-tc-id="tc1" data-tc-author="Bob" style="--tc-color:#1d4ed8">tracked</ins>' +
        '<span class="gcp-cmt-anchor" data-cmt-anchor-id="c1">anchored</span>',
    });
    expect(await page.evaluate(() => ({
      pwned: window.pwned || null,
      script: !!document.querySelector('#host script'),
      onerror: !!document.querySelector('#host [onerror]'),
      jsHref: !!document.querySelector('#host a[href^="javascript"]'),
      tracked: !!document.querySelector('#host ins[data-tc-id="tc1"]'),
      anchor: !!document.querySelector('#host .gcp-cmt-anchor'),
      bold: !!document.querySelector('#host b'),
    }))).toEqual({
      pwned: null, script: false, onerror: false, jsHref: false,
      tracked: true, anchor: true, bold: true,
    });
  });

  test('setHtml is sanitized too', async ({ page }) => {
    await bootEditor(page);
    await page.evaluate(() => window.ed.setHtml('<p>ok</p><iframe src="x"></iframe><p onclick="1">click</p>'));
    expect(await page.evaluate(() => ({
      iframe: !!document.querySelector('#host iframe'),
      onclick: !!document.querySelector('#host [onclick]'),
      text: document.querySelector('#host .gcp-re-body').textContent,
    }))).toEqual({ iframe: false, onclick: false, text: 'okclick' });
  });

  test('orphaned comments are computed on demand, never auto-deleted', async ({ page }) => {
    await bootEditor(page, {
      initialHtml: '<p>text <span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-live">kept</span></p>',
    });
    await page.evaluate(() => {
      window.ed.setComments([
        { id: 1, anchor_id: 'cmt-live', parent_id: null, author_name: 'A', comment_text: 'stays', created_at: '' },
        { id: 2, anchor_id: 'cmt-gone', parent_id: null, author_name: 'B', comment_text: 'orphan root', created_at: '' },
        { id: 3, anchor_id: null, parent_id: 2, author_name: 'C', comment_text: 'orphan reply', created_at: '' },
        { id: 4, anchor_id: null, parent_id: 1, author_name: 'D', comment_text: 'live reply', created_at: '' },
      ]);
    });
    // The old MutationObserver fired after 250ms — wait past it and make sure
    // nothing was deleted automatically.
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.deletedComments)).toEqual([]);
    expect(await page.evaluate(() => window.ed.getOrphanedCommentIds())).toEqual([2, 3]);
  });

  test('ctrl+z / ctrl+y undo and redo tracked typing', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>base</p>' });
    await setCaret(page, 'p', 4);
    await page.keyboard.type('Q');
    await expect(page.locator('.gcp-re-body')).toContainText('baseQ');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.gcp-re-body')).not.toContainText('baseQ');
    await page.keyboard.press('Control+y');
    await expect(page.locator('.gcp-re-body')).toContainText('baseQ');
  });

  test('no page errors during a typing/formatting/merge session', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await bootEditor(page, { initialHtml: '<p>alpha</p><p>beta</p>' });
    await setCaret(page, 'p', 5);
    await page.keyboard.type(' typed');
    await page.evaluate(() => {
      const p2 = document.querySelectorAll('#host .gcp-re-body p')[1];
      const r = document.createRange();
      r.setStart(p2.firstChild, 0); r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+z');
    expect(errors).toEqual([]);
  });
});
