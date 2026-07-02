const { test, expect } = require('@playwright/test');
const { bootEditor, setCaret } = require('./helpers');

function pasteHtml(page, html) {
  return page.evaluate(h => {
    const dt = new DataTransfer();
    dt.setData('text/html', h);
    document.querySelector('#host .gcp-re-body').dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, html);
}

test.describe('block-aware tracked paste', () => {
  test('multi-paragraph paste preserves structure and is fully tracked', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>alpha omega</p>' });
    await setCaret(page, 'p', 6);
    await pasteHtml(page, '<p>first <b>rich</b></p><h2>heading</h2><ul><li>one</li><li>two</li></ul>');

    const state = await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      return {
        h2: body.querySelectorAll('h2').length,
        li: body.querySelectorAll('li').length,
        bold: body.querySelectorAll('b').length,
        // every pasted block must live inside a tracked insertion
        untrackedH2: !!body.querySelector('h2:not(ins h2)'),
        text: body.textContent,
      };
    });
    expect(state.h2).toBe(1);
    expect(state.li).toBe(2);
    expect(state.bold).toBe(1);
    expect(state.untrackedH2).toBe(false);
    expect(state.text).toContain('first rich');
    expect(state.text).toContain('heading');
  });

  test('reject-all after a block paste restores the original document', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>alpha omega</p>' });
    await setCaret(page, 'p', 6);
    await pasteHtml(page, '<p>pasted one</p><p>pasted two</p>');
    await expect(page.locator('.gcp-re-body ins[data-tc-id]')).not.toHaveCount(0);

    await page.evaluate(() => window.ed.rejectAllChanges());
    expect(await page.evaluate(() => window.ed.getHtml())).toBe('<p>alpha omega</p>');
  });

  test('accept-all after a block paste keeps the pasted blocks unwrapped', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>alpha omega</p>' });
    await setCaret(page, 'p', 6);
    await pasteHtml(page, '<p>pasted one</p><p>pasted two</p>');
    await page.evaluate(() => window.ed.acceptAllChanges());

    const state = await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      return {
        tracked: body.querySelectorAll('[data-tc-id]').length,
        paragraphs: [...body.querySelectorAll('p')].map(p => p.textContent),
      };
    });
    expect(state.tracked).toBe(0);
    expect(state.paragraphs).toEqual(['alpha ', 'pasted one', 'pasted two', 'omega']);
  });

  test('leading inline content merges into the current paragraph', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>start end</p>' });
    await setCaret(page, 'p', 6);
    await pasteHtml(page, 'inline lead<p>block follows</p>');

    const state = await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      const firstP = body.querySelector('p');
      return {
        firstText: firstP.textContent,
        leadTracked: !!firstP.querySelector('ins[data-tc-id]'),
        blockText: body.textContent,
      };
    });
    expect(state.firstText).toContain('inline lead');
    expect(state.leadTracked).toBe(true);
    expect(state.blockText).toContain('block follows');
  });

  test('pasted table survives with structure intact', async ({ page }) => {
    await bootEditor(page, { initialHtml: '<p>doc</p>' });
    await setCaret(page, 'p', 3);
    await pasteHtml(page, '<table><tbody><tr><td>x1</td><td>x2</td></tr></tbody></table>');

    const state = await page.evaluate(() => {
      const body = document.querySelector('#host .gcp-re-body');
      return {
        cells: body.querySelectorAll('td').length,
        insideIns: !!body.querySelector('ins[data-tc-id] table'),
      };
    });
    expect(state.cells).toBe(2);
    expect(state.insideIns).toBe(true);
  });
});
