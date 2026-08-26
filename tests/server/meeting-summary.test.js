const { test } = require('node:test');
const assert = require('node:assert/strict');
const MS = require('../../server/helpers/meeting-summary');
const DP = require('../../frontend/js/core/discussion-points');
const { sanitizeEditorHtml } = require('../../server/helpers/sanitize');

// The pure half of the Meeting Summary feature: what the agenda upsert keeps,
// when a task comes due, and when a row counts as written. The SQL itself is
// exercised against a real database by hand; these pin the arithmetic and the
// normalisation that decide what that SQL is handed.

// ── isBlankHtml ──────────────────────────────────────────────────────────────

test('a summary counts as written only when a reader would see something', () => {
  assert.equal(MS.isBlankHtml(''), true);
  assert.equal(MS.isBlankHtml(null), true);
  assert.equal(MS.isBlankHtml('<p><br></p>'), true);
  assert.equal(MS.isBlankHtml('<p>&nbsp;</p>'), true);
  assert.equal(MS.isBlankHtml('<p>  </p>'), true);
  assert.equal(MS.isBlankHtml('<p>Agreed.</p>'), false);
  assert.equal(MS.isBlankHtml('<p><b>x</b></p>'), false);
});

test('the server blank test agrees with the editor one', () => {
  // The client hides a row it considers empty and the server decides the row's
  // status; a disagreement would show "written" against an empty cell.
  for (const html of ['', '<p><br></p>', '<p>&nbsp;</p>', '<p>text</p>', '<p><i>x</i></p>']) {
    assert.equal(MS.isBlankHtml(html), DP.isBlankHtml(html), `disagreed on ${JSON.stringify(html)}`);
  }
});

// ── Due and deadline arithmetic ──────────────────────────────────────────────

test('a summary task comes due one hour after the meeting', () => {
  assert.equal(MS.dueAt('2026-09-01T10:00:00+04:00').toISOString(), '2026-09-01T07:00:00.000Z');
  assert.equal(MS.dueAt(null), null);
  assert.equal(MS.dueAt('not a date'), null);
});

test('the deadline is the meeting day plus seven', () => {
  assert.equal(MS.deadlineFromMeeting('2026-09-01T10:00:00+04:00'), '2026-09-08');
});

test('the deadline is anchored to Tbilisi, not to the server clock', () => {
  // The app runs in UTC, where a meeting held just after midnight in Tbilisi
  // falls on the previous calendar day. Reading the day in UTC would issue the
  // deadline a day early — 2026-09-07 instead of 2026-09-08.
  assert.equal(MS.deadlineFromMeeting('2026-09-01T01:00:00+04:00'), '2026-09-08');
  // And a late-evening meeting must not roll forward either.
  assert.equal(MS.deadlineFromMeeting('2026-09-01T23:30:00+04:00'), '2026-09-08');
});

test('no meeting time means no deadline rather than a guessed one', () => {
  assert.equal(MS.deadlineFromMeeting(null), null);
  assert.equal(MS.deadlineFromMeeting('nonsense'), null);
});

// ── ymd ──────────────────────────────────────────────────────────────────────

test('a DATE renders as a plain day, not a UTC instant', () => {
  assert.equal(MS.ymd('2026-09-08'), '2026-09-08');
  assert.equal(MS.ymd(new Date(2026, 8, 8)), '2026-09-08');
  assert.equal(MS.ymd(null), null);
});

// ── normalizeAgendaPoints ────────────────────────────────────────────────────

const SECTIONS = new Set([1, 2]);

test('normalising keeps the selected points and numbers them from zero', () => {
  const out = MS.normalizeAgendaPoints([
    { sectionId: 1, dpId: 'dp-a', topic: 'A' },
    { sectionId: 2, dpId: 'dp-b', topic: 'B' },
  ], SECTIONS);
  assert.deepEqual(out.map(p => [p.dpId, p.position]), [['dp-a', 0], ['dp-b', 1]]);
});

test('a point from another document is dropped', () => {
  // The owner posts the selection, so the section has to be checked against
  // the event rather than trusted.
  const out = MS.normalizeAgendaPoints([
    { sectionId: 1, dpId: 'dp-a' },
    { sectionId: 99, dpId: 'dp-x' },
  ], SECTIONS);
  assert.deepEqual(out.map(p => p.dpId), ['dp-a']);
});

test('a repeated point is collapsed', () => {
  // Two rows with the same (section, dp_id) would collide on the table's
  // unique key halfway through the upsert.
  const out = MS.normalizeAgendaPoints([
    { sectionId: 1, dpId: 'dp-a', topic: 'first' },
    { sectionId: 1, dpId: 'dp-a', topic: 'second' },
  ], SECTIONS);
  assert.equal(out.length, 1);
  assert.equal(out[0].topic, 'first');
});

test('points with no id or no section are dropped', () => {
  const out = MS.normalizeAgendaPoints([
    { sectionId: 1, dpId: '' },
    { sectionId: null, dpId: 'dp-b' },
    { sectionId: 1, dpId: 'dp-c' },
  ], SECTIONS);
  assert.deepEqual(out.map(p => p.dpId), ['dp-c']);
});

test('an over-long topic is truncated to fit its column', () => {
  const out = MS.normalizeAgendaPoints(
    [{ sectionId: 1, dpId: 'dp-a', topic: 'x'.repeat(5000) }], SECTIONS);
  assert.equal(out[0].topic.length, 2000);
});

test('a dp id is truncated to the column width', () => {
  const out = MS.normalizeAgendaPoints(
    [{ sectionId: 1, dpId: 'd'.repeat(200) }], SECTIONS);
  assert.equal(out[0].dpId.length, 60);
});

// ── agendaKeys ───────────────────────────────────────────────────────────────

test('agenda keys are what the soft-remove sweep compares against', () => {
  const points = MS.normalizeAgendaPoints([
    { sectionId: 1, dpId: 'dp-a' }, { sectionId: 2, dpId: 'dp-b' },
  ], SECTIONS);
  assert.deepEqual(MS.agendaKeys(points), ['1:dp-a', '2:dp-b']);
});

test('re-exporting a subset leaves the dropped points out of the kept keys', () => {
  // Those are exactly the rows the sweep marks removed_at — soft, so a summary
  // already written against one survives.
  const first = MS.normalizeAgendaPoints(
    [{ sectionId: 1, dpId: 'dp-a' }, { sectionId: 1, dpId: 'dp-b' }], SECTIONS);
  const second = MS.normalizeAgendaPoints([{ sectionId: 1, dpId: 'dp-a' }], SECTIONS);
  const dropped = MS.agendaKeys(first).filter(k => !MS.agendaKeys(second).includes(k));
  assert.deepEqual(dropped, ['1:dp-b']);
});

// ── Sanitization of what a supervisor types ──────────────────────────────────

test('everything the summary editor can emit survives sanitization', () => {
  // The summary cell uses the Task field's editor; if the sanitizer stripped
  // its output, saved text would come back altered.
  const html = '<p>Agreed to <b>raise</b> <i>targets</i>, <u>noted</u> ' +
    '<span style="color:#c0392b">risk</span>.</p><p>Second line.</p>';
  assert.equal(sanitizeEditorHtml(html), html);
});

test('markup a summary must never carry is stripped', () => {
  const out = sanitizeEditorHtml('<p class="evil">text</p><script>alert(1)</script>');
  assert.equal(out, '<p>text</p>');
});
