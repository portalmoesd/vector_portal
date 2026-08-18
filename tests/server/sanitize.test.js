const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeEditorHtml } = require('../../server/helpers/sanitize');

test('passes through basic formatting', () => {
  assert.equal(
    sanitizeEditorHtml('<p>hello <b>world</b> <i>x</i> <u>y</u></p>'),
    '<p>hello <b>world</b> <i>x</i> <u>y</u></p>'
  );
});

test('strips script tags and their content', () => {
  assert.equal(sanitizeEditorHtml('<p>a<script>alert(1)</script>b</p>'), '<p>ab</p>');
});

test('strips event handler attributes', () => {
  assert.equal(sanitizeEditorHtml('<p onclick="evil()">x</p>'), '<p>x</p>');
});

test('strips javascript: hrefs but keeps safe links', () => {
  assert.equal(sanitizeEditorHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(
    sanitizeEditorHtml('<a href="https://example.ge/doc">x</a>'),
    '<a href="https://example.ge/doc">x</a>'
  );
});

test('removes iframes, objects and embeds entirely', () => {
  assert.equal(sanitizeEditorHtml('<iframe srcdoc="<script>1</script>"></iframe><p>ok</p>'), '<p>ok</p>');
  assert.equal(sanitizeEditorHtml('<object data="x"></object><embed src="y"><p>ok</p>'), '<p>ok</p>');
});

test('preserves tracked-change markup including author colour custom properties', () => {
  const ins = '<ins data-tc-id="tc1" data-tc-author="Bob" data-tc-initials="B" ' +
    'data-tc-time="2026-01-01T00:00:00Z" style="--tc-color:#1d4ed8;--tc-bg:rgba(29,78,216,.11)" title="Bob">added</ins>';
  assert.equal(sanitizeEditorHtml(ins), ins);
  const del = '<del data-tc-id="tc2" style="--tc-color:#b91c1c">gone</del>';
  assert.equal(sanitizeEditorHtml(del), del);
});

test('preserves format-change markers', () => {
  const fmt = '<span data-tc-fmt-id="tc3" data-tc-fmt-cmd="bold" data-tc-fmt-old="false" data-tc-author="A">x</span>';
  assert.equal(sanitizeEditorHtml(fmt), fmt);
});

test('preserves comment anchors but drops other classes', () => {
  assert.equal(
    sanitizeEditorHtml('<span class="gcp-cmt-anchor evil" data-cmt-anchor-id="cmt-a">x</span>'),
    '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-a">x</span>'
  );
});

test('filters style declarations to the allowlist', () => {
  assert.equal(
    sanitizeEditorHtml('<p style="text-align:center;color:#f00;position:fixed;background:url(javascript:x)">x</p>'),
    '<p style="text-align:center;color:#f00">x</p>'
  );
});

test('preserves tables with spans and cell styling', () => {
  const table = '<table><tbody><tr><td colspan="2" style="border:1px solid #d1d5db;background-color:#dbeafe">c</td></tr></tbody></table>';
  assert.equal(sanitizeEditorHtml(table), table);
});

test('preserves tracked table structure changes', () => {
  const table = '<table><tbody><tr data-tc-id="tc9" data-tc-tbl="row-add" data-tc-author="A"><td>x</td></tr>' +
    '<tr><td data-tc-id="tc10" data-tc-tbl="col-del" data-tc-author="B">y</td></tr></tbody></table>';
  assert.equal(sanitizeEditorHtml(table), table);
});

test('preserves block-level insertions from block paste', () => {
  const pasted = '<ins data-tc-id="tc11" data-tc-author="A"><p>pasted one</p><h2>heading</h2></ins>';
  assert.equal(sanitizeEditorHtml(pasted), pasted);
});

test('preserves discussion-point scaffolding', () => {
  const card = '<div data-dp-id="dp-a1"><h3 data-dp-field="topic">Trade turnover</h3>' +
    '<div data-dp-field="context"><p>context body</p></div>' +
    '<div data-dp-field="additional"><p>extra body</p></div></div>';
  assert.equal(sanitizeEditorHtml(card), card);
});

test('preserves tracked changes and comment anchors inside discussion points', () => {
  const card = '<div data-dp-id="dp-b2"><h3 data-dp-field="topic">Investments</h3>' +
    '<div data-dp-field="context"><p><ins data-tc-id="tc12" data-tc-author="A">new</ins>' +
    '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1">noted</span></p></div></div>';
  assert.equal(sanitizeEditorHtml(card), card);
});

test('strips classes from discussion-point scaffolding', () => {
  assert.equal(
    sanitizeEditorHtml('<div class="dp-card" data-dp-id="dp-c3"><h3 data-dp-field="topic">T</h3></div>'),
    '<div data-dp-id="dp-c3"><h3 data-dp-field="topic">T</h3></div>'
  );
});

test('handles null/empty input', () => {
  assert.equal(sanitizeEditorHtml(null), '');
  assert.equal(sanitizeEditorHtml(undefined), '');
  assert.equal(sanitizeEditorHtml(''), '');
});
