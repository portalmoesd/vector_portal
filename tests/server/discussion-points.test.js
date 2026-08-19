const { test } = require('node:test');
const assert = require('node:assert/strict');
const DP = require('../../frontend/js/core/discussion-points');
const { sanitizeEditorHtml } = require('../../server/helpers/sanitize');

// Only the DOM-free half of the module is exercised here — serialisation,
// export rendering and labelling. parsePoints() needs a real DOM and is
// covered by tests/editor/discussion-points.spec.js.

const POINTS = [
  { id: 'dp-1', topic: 'Trade turnover', contextHtml: '<p>ctx one</p>', additionalHtml: '<p>extra one</p>' },
  { id: 'dp-2', topic: 'Investments', contextHtml: '<p>ctx two</p>', additionalHtml: '<p>extra two</p>' },
];

test('serializes points to the persisted card markup', () => {
  assert.equal(
    DP.serializePoints(POINTS),
    '<div data-dp-id="dp-1"><h3 data-dp-field="topic">Trade turnover</h3>' +
    '<div data-dp-field="context"><p>ctx one</p></div>' +
    '<div data-dp-field="additional"><p>extra one</p></div></div>' +
    '<div data-dp-id="dp-2"><h3 data-dp-field="topic">Investments</h3>' +
    '<div data-dp-field="context"><p>ctx two</p></div>' +
    '<div data-dp-field="additional"><p>extra two</p></div></div>'
  );
});

test('serialization is deterministic', () => {
  // The editor pages autosave by string-comparing getHtml() against the last
  // saved value every 20s, so an unstable serializer would save forever.
  assert.equal(DP.serializePoints(POINTS), DP.serializePoints(POINTS));
});

test('an empty list serializes to the empty string', () => {
  assert.equal(DP.serializePoints([]), '');
  assert.equal(DP.serializePoints(null), '');
});

test('escapes topic text rather than trusting it as markup', () => {
  const out = DP.serializePoints([{ id: 'dp-x', topic: '<img src=x onerror=alert(1)>' }]);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!out.includes('<img'));
});

test('empty rich fields fall back to an empty paragraph', () => {
  const out = DP.serializePoints([{ id: 'dp-x', topic: 'T', contextHtml: '', additionalHtml: '' }]);
  assert.equal(
    out,
    '<div data-dp-id="dp-x"><h3 data-dp-field="topic">T</h3>' +
    '<div data-dp-field="context"><p><br></p></div>' +
    '<div data-dp-field="additional"><p><br></p></div></div>'
  );
});

test('persisted markup survives the server sanitizer unchanged', () => {
  // The scaffolding is carried by data attributes precisely so the allowlist
  // in server/helpers/sanitize.js keeps it. Guards against a silent strip.
  const html = DP.serializePoints([{
    id: 'dp-1',
    topic: 'სავაჭრო ბრუნვა',
    contextHtml: '<p>a <ins data-tc-id="tc1" data-tc-author="A">new</ins> ' +
      '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-9">noted</span></p>',
    additionalHtml: '<p>b</p>',
  }]);
  assert.equal(sanitizeEditorHtml(html), html);
});

test('isBlankHtml recognises visually empty bodies', () => {
  assert.equal(DP.isBlankHtml(''), true);
  assert.equal(DP.isBlankHtml('<p><br></p>'), true);
  assert.equal(DP.isBlankHtml('<p>&nbsp;</p>'), true);
  assert.equal(DP.isBlankHtml('<p>x</p>'), false);
});

test('topicLabel falls back to a numbered label in the document language', () => {
  assert.equal(DP.topicLabel({ topic: 'Real topic' }, 'KA', 0), 'Real topic');
  assert.equal(DP.topicLabel({ topic: '   ' }, 'EN', 2), 'Point 3');
  assert.equal(DP.topicLabel({ topic: '' }, 'KA', 0), 'საკითხი 1');
  assert.equal(DP.topicLabel({ topic: '' }, 'RU', 1), 'Вопрос 2');
});

test('export labels follow the document language, defaulting to Georgian', () => {
  assert.equal(DP.exportLabels('EN').context, 'Discussion Point');
  assert.equal(DP.exportLabels('ka').additional, 'დამატებითი ინფორმაცია');
  assert.equal(DP.exportLabels('FR').context, 'განსახილველი საკითხი');
  assert.equal(DP.exportLabels(undefined).context, 'განსახილველი საკითხი');
});

test('toExportHtml numbers the selected points and labels each field', () => {
  const out = DP.toExportHtml(POINTS, 'EN');
  assert.ok(out.includes('>1. Trade turnover<'));
  assert.ok(out.includes('>2. Investments<'));
  assert.ok(out.includes('<b>Discussion Point</b>'));
  assert.ok(out.includes('<b>Additional Information</b>'));
  assert.ok(out.includes('<p>ctx one</p>'));
});

test('toExportHtml renumbers from 1 when only a subset is exported', () => {
  const out = DP.toExportHtml([POINTS[1]], 'EN');
  assert.ok(out.includes('>1. Investments<'));
  assert.ok(!out.includes('Trade turnover'));
});

test('toExportHtml omits a field label when that field is empty', () => {
  const out = DP.toExportHtml([{ id: 'dp-x', topic: 'T', contextHtml: '<p>c</p>', additionalHtml: '<p><br></p>' }], 'EN');
  assert.ok(out.includes('<b>Discussion Point</b>'));
  assert.ok(!out.includes('<b>Additional Information</b>'));
});

test('toExportHtml preserves track changes and comment anchors', () => {
  // The Word path turns these into native revisions and comments, so they must
  // survive the render untouched.
  const out = DP.toExportHtml([{
    id: 'dp-1', topic: 'T',
    contextHtml: '<p><ins data-tc-id="tc1">added</ins><del data-tc-id="tc2">gone</del>' +
      '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1">x</span></p>',
    additionalHtml: '',
  }], 'EN');
  assert.ok(out.includes('<ins data-tc-id="tc1">added</ins>'));
  assert.ok(out.includes('<del data-tc-id="tc2">gone</del>'));
  assert.ok(out.includes('data-cmt-anchor-id="cmt-1"'));
});

test('toExportHtml emits h3 headings so the Word exporter maps them to Heading 3', () => {
  const out = DP.toExportHtml([POINTS[0]], 'EN');
  assert.match(out, /^<h3\b/);
});

test('an empty selection exports nothing', () => {
  assert.equal(DP.toExportHtml([], 'EN'), '');
  assert.equal(DP.toExportHtml(null, 'EN'), '');
});
