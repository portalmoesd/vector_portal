const { test, expect } = require('@playwright/test');
const { bootEditor, setCaret } = require('./helpers');

test.describe('track changes — text edits', () => {
  test('typing is wrapped in a tracked <ins> with author attributes', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>hello</p>' });
    await setCaret(page, 'p', 5);
    await page.keyboard.type(' world');
    const ins = page.locator('.gcp-re-body ins[data-tc-id]');
    await expect(ins).toHaveCount(1);
    await expect(ins).toHaveText(' world');
    await expect(ins).toHaveAttribute('data-tc-author', 'Alice Author');
    await expect(ins).toHaveAttribute('data-tc-initials', 'AA');
  });

  test('backspace over existing text records a tracked <del> and keeps the text', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>hello</p>' });
    await setCaret(page, 'p', 4);
    await page.keyboard.press('Backspace');
    const del = page.locator('.gcp-re-body del[data-tc-id]');
    await expect(del).toHaveCount(1);
    await expect(del).toHaveText('l');
    // Nothing is lost until the change is accepted
    await expect(page.locator('.gcp-re-body p')).toHaveText('hello');
  });

  test('deleting your own insertion cancels silently — no <del> is recorded', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>base</p>' });
    await setCaret(page, 'p', 4);
    await page.keyboard.type('xyz');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.gcp-re-body ins[data-tc-id]')).toHaveText('xy');
    await expect(page.locator('.gcp-re-body del[data-tc-id]')).toHaveCount(0);
  });

  test('accept-all applies changes, reject-all restores the original', async ({ page }) => {
    const tracked =
      '<p>keep <del data-tc-id="tcA" data-tc-author="Bob">removed</del>' +
      '<ins data-tc-id="tcB" data-tc-author="Bob">added</ins> end</p>';

    await bootEditor(page, { initialHtml: tracked });
    await page.evaluate(() => window.ed.acceptAllChanges());
    await expect(page.locator('.gcp-re-body p')).toHaveText('keep added end');
    expect(await page.locator('.gcp-re-body [data-tc-id]').count()).toBe(0);

    await bootEditor(page, { initialHtml: tracked });
    await page.evaluate(() => window.ed.rejectAllChanges());
    await expect(page.locator('.gcp-re-body p')).toHaveText('keep removed end');
    expect(await page.locator('.gcp-re-body [data-tc-id]').count()).toBe(0);
  });

  test('getCleanHtml strips tracking markup and comment anchors', async ({ page }) => {
    await bootEditor(page, {
      initialHtml:
        '<p>a<del data-tc-id="tc1" data-tc-author="B">x</del>' +
        '<ins data-tc-id="tc2" data-tc-author="B">y</ins>' +
        '<span class="gcp-cmt-anchor" data-cmt-anchor-id="c1">z</span></p>',
    });
    const clean = await page.evaluate(() => window.ed.getCleanHtml());
    expect(clean).toBe('<p>ayz</p>');
  });

  test('inline format change is tracked and rejectable', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>make this bold</p>' });
    await page.evaluate(() => {
      const p = document.querySelector('#host .gcp-re-body p');
      const r = document.createRange();
      r.setStart(p.firstChild, 5);
      r.setEnd(p.firstChild, 9);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    });
    await page.locator('.gcp-re-btn[data-cmd="bold"]').dispatchEvent('mousedown');
    const mark = page.locator('.gcp-re-body [data-tc-fmt-cmd="bold"]');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText('this');
    expect(await page.evaluate(() =>
      !!document.querySelector('#host .gcp-re-body').querySelector('b, strong'))).toBe(true);

    await page.evaluate(() => window.ed.rejectAllChanges());
    expect(await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      return { bold: !!body.querySelector('b, strong'), marks: body.querySelectorAll('[data-tc-fmt-cmd]').length, text: body.textContent };
    })).toEqual({ bold: false, marks: 0, text: 'make this bold' });
  });

  test('pasted inline HTML is tracked as a single insertion', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>before after</p>' });
    await setCaret(page, 'p', 7);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<b>pasted</b> <i>rich</i>');
      document.querySelector('#host .gcp-re-body').dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true })
      );
    });
    const ins = page.locator('.gcp-re-body ins[data-tc-id]');
    await expect(ins).toHaveCount(1);
    await expect(ins).toHaveText('pasted rich');
    expect(await ins.locator('b').count()).toBe(1);
    expect(await ins.locator('i').count()).toBe(1);
  });

  test('composition input (IME/autocorrect) is wrapped in a tracked <ins>', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>text</p>' });
    await setCaret(page, 'p', 4);
    await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      // Simulate the browser inserting composed text natively
      const tn = body.querySelector('p').firstChild;
      tn.insertData(4, 'გამარჯობა');
      const r = document.createRange();
      r.setStart(tn, 4 + 'გამარჯობა'.length);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      body.dispatchEvent(new CompositionEvent('compositionend', { data: 'გამარჯობა', bubbles: true }));
    });
    const ins = page.locator('.gcp-re-body ins[data-tc-id]');
    await expect(ins).toHaveCount(1);
    await expect(ins).toHaveText('გამარჯობა');
    await expect(ins).toHaveAttribute('data-tc-author', 'Alice Author');
  });

  test('drag-delete inputType is intercepted and tracked', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>drag me now</p>' });
    await page.evaluate(() => {
      const p = document.querySelector('#host .gcp-re-body p');
      const r = document.createRange();
      r.setStart(p.firstChild, 0);
      r.setEnd(p.firstChild, 4);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      document.querySelector('#host .gcp-re-body').dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'deleteByDrag', bubbles: true, cancelable: true })
      );
    });
    const del = page.locator('.gcp-re-body del[data-tc-id]');
    await expect(del).toHaveCount(1);
    await expect(del).toHaveText('drag');
  });

  test('native historyUndo routes through the custom undo stack', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>base</p>' });
    await setCaret(page, 'p', 4);
    await page.keyboard.type('Z');
    await expect(page.locator('.gcp-re-body')).toContainText('baseZ');
    await page.evaluate(() => {
      document.querySelector('#host .gcp-re-body').dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
      );
    });
    await expect(page.locator('.gcp-re-body')).not.toContainText('baseZ');
    await expect(page.locator('.gcp-re-body')).toContainText('base');
  });
});
