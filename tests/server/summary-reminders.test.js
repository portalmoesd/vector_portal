/**
 * The daily Meeting Summary deadline-reminder sweep.
 *
 * The SQL runs against a stubbed pool — these tests pin the shape that makes
 * the sweep safe to run every day: single INSERT…SELECT statements (dedup must
 * live in the SQL, since the notifications table has no unique constraint and
 * insertNotifications cannot dedup), Tbilisi-anchored day arithmetic, and the
 * summary_due meta shape the dashboard already renders.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const queries = [];
require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    query: async (text, params) => {
      queries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
    pool: {},
  },
};

const { sweepSummaryReminders } = require('../../server/helpers/summary-reminders');

async function sweep(now) {
  queries.length = 0;
  await sweepSummaryReminders(now);
  return queries;
}

test('one idempotent INSERT…SELECT per reminder type, nothing else', async () => {
  const qs = await sweep('2026-09-01T10:00:00Z');
  assert.equal(qs.length, 2);
  for (const q of qs) {
    assert.match(q.text, /INSERT INTO notifications[\s\S]*SELECT/);
    // Dedup is the NOT EXISTS guard — a VALUES insert could not carry one.
    assert.doesNotMatch(q.text, /VALUES/);
    assert.match(q.text, /NOT EXISTS/);
    // Only unwritten rows on live agenda points nag anyone.
    assert.match(q.text, /status = 'PENDING'/);
    assert.match(q.text, /removed_at IS NULL/);
  }
});

test('due-soon covers today and tomorrow; overdue everything before today', async () => {
  const [dueSoon, overdue] = await sweep('2026-09-01T10:00:00Z');
  assert.match(dueSoon.text, /'summary_due_soon'/);
  assert.match(dueSoon.text, /deadline_date >= \$1::date/);
  assert.match(dueSoon.text, /deadline_date <= \$1::date \+ 1/);
  assert.match(overdue.text, /'summary_overdue'/);
  assert.match(overdue.text, /deadline_date < \$1::date/);
  // Each type dedups against itself, per user and event.
  assert.match(dueSoon.text, /n\.type = 'summary_due_soon' AND n\.event_id = ms\.event_id/);
  assert.match(overdue.text, /n\.type = 'summary_overdue' AND n\.event_id = ms\.event_id/);
});

test('the day parameter is the Tbilisi calendar day', async () => {
  let qs = await sweep('2026-09-01T10:00:00Z');
  assert.deepEqual(qs[0].params, ['2026-09-01']);
  assert.deepEqual(qs[1].params, ['2026-09-01']);
  // After 20:00 UTC the Tbilisi day has turned.
  qs = await sweep('2026-09-01T20:30:00Z');
  assert.deepEqual(qs[0].params, ['2026-09-02']);
});

test('the meta matches the shape summary_due already uses', async () => {
  // The dashboard renders eventTitle / deadlineDate / pointCount for every
  // summary notification type; a drifted meta would render blanks.
  const qs = await sweep('2026-09-01T10:00:00Z');
  for (const q of qs) {
    assert.match(q.text, /'eventTitle',\s+e\.title/);
    assert.match(q.text, /'deadlineDate',\s+to_char\(min\(ms\.deadline_date\), 'YYYY-MM-DD'\)/);
    assert.match(q.text, /'pointCount',\s+count\(\*\)::int/);
  }
});
