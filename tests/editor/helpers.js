/**
 * Test fixtures for GCP.RichEditor: loads the editor source into a blank page
 * (no server needed) and provides DOM helpers used across specs.
 */
const fs = require('fs');
const path = require('path');

const escapeScript = s => s.replace(/<\/script>/g, '<\\/script>');
const coreSrc = escapeScript(
  fs.readFileSync(path.join(__dirname, '../../frontend/js/core/editor-core.js'), 'utf8'));
const editorSrc = escapeScript(
  fs.readFileSync(path.join(__dirname, '../../frontend/js/core/editor.js'), 'utf8'));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" style="width:1200px"></div>
<script>window.I18n = { tr: k => k };</script>
<script>${coreSrc}</script>
<script>${editorSrc}</script>
</body></html>`;

/**
 * Boot a RichEditor into the page as window.ed.
 * @param {import('@playwright/test').Page} page
 * @param {object} opts - RichEditor options (initialHtml, authorName, ...)
 */
async function bootEditor(page, opts = {}) {
  await page.setContent(PAGE);
  await page.evaluate(options => {
    window.deletedComments = [];
    window.ed = GCP.RichEditor(Object.assign({
      container: document.getElementById('host'),
      authorName: 'Alice Author',
      onDeleteComment: id => window.deletedComments.push(id),
    }, options));
  }, opts);
}

/**
 * Place a collapsed caret inside the nth text node of the element matching
 * `selector` (within the editor body), at `offset`.
 */
async function setCaret(page, selector, offset) {
  await page.evaluate(({ selector, offset }) => {
    const el = document.querySelector('#host .gcp-re-body').querySelector(selector);
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const tn = tw.nextNode();
    const r = document.createRange();
    r.setStart(tn, offset);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.querySelector('#host .gcp-re-body').focus();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { selector, offset });
}

/** Editor body innerHTML with volatile tracking attributes normalized. */
async function bodyHtml(page) {
  return page.evaluate(() => {
    const clone = document.querySelector('#host .gcp-re-body').cloneNode(true);
    let n = 0;
    const idMap = new Map();
    clone.querySelectorAll('[data-tc-id], [data-tc-fmt-id]').forEach(el => {
      for (const attr of ['data-tc-id', 'data-tc-fmt-id']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        if (!idMap.has(v)) idMap.set(v, 'tc' + (++n));
        el.setAttribute(attr, idMap.get(v));
      }
      el.removeAttribute('data-tc-time');
    });
    return clone.innerHTML;
  });
}

module.exports = { bootEditor, setCaret, bodyHtml };
