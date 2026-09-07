/**
 * sendForSummaries — the retro-assignment sweep.
 *
 * A summary row opened when no supervisor covered its section used to be
 * orphaned forever: the pending query only sees points with no summary row at
 * all. These tests pin the rescue path: a later send re-resolves assignees for
 * zero-assignee rows, refreshes their deadline (measured from the send — the
 * supervisor only now received the task), and notifies them, all inside the
 * one transaction.
 *
 * Both ../db and the step resolver are stubbed in require.cache before the
 * helper loads, so no database is needed.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// What resolveStepUserIds answers on the next call(s).
let resolverIds = [];
const resolverCalls = [];

const clientQueries = [];
let released = false;

const fakeClient = {
  query: async (text, params) => {
    clientQueries.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    // The retro-assign sweep: rows that exist with nobody assigned.
    if (/SELECT ms\.id AS summary_id/.test(text)) {
      return { rows: [{ summary_id: 11, section_id: 3, topic_snapshot: 'Orphan point' }] };
    }
    // The pending open query: nothing new to open in these tests.
    if (/agenda_point_id, ap\.section_id, ap\.topic_snapshot/.test(text)) return { rows: [] };
    return { rows: [] };
  },
};

require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    query: async () => ({ rows: [] }),
    pool: {
      connect: async () => {
        released = false;
        return Object.assign(Object.create(fakeClient), {
          release: () => { released = true; },
        });
      },
    },
  },
};

require.cache[require.resolve('../../server/helpers/event-notification-draft')] = {
  id: require.resolve('../../server/helpers/event-notification-draft'),
  filename: require.resolve('../../server/helpers/event-notification-draft'),
  loaded: true,
  exports: {
    resolveStepUserIds: async (handle, eventId, sectionId, role) => {
      resolverCalls.push({ eventId, sectionId, role });
      return resolverIds;
    },
    resolveEventParticipantIds: async () => [],
  },
};

const { sendForSummaries } = require('../../server/helpers/meeting-summary-open');

const EVENT = { id: 7, title: 'Berlin Summit', document_submitter_id: 5, document_submitter_role: 'DEPUTY', deputy_id: 9 };
const ACTOR = { id: 5 };

beforeEach(() => {
  clientQueries.length = 0;
  resolverCalls.length = 0;
});

test('an orphaned row is re-assigned, re-deadlined and its supervisor notified', async () => {
  resolverIds = [7];
  const out = await sendForSummaries(7, ACTOR, EVENT, '2026-09-15');

  assert.deepEqual(out, { opened: 0, reassigned: 1, supervisors: 1, unassigned: 0 });
  assert.deepEqual(resolverCalls, [{ eventId: 7, sectionId: 3, role: 'SUPERVISOR' }]);

  const assign = clientQueries.find(q => /INSERT INTO meeting_summary_assignees/.test(q.text));
  assert.ok(assign, 'assignee insert ran');
  assert.deepEqual(assign.params, [11, 7]);

  const deadline = clientQueries.find(q => /UPDATE meeting_summaries SET deadline_date/.test(q.text));
  assert.ok(deadline, 'deadline refreshed for the newly-told supervisor');
  assert.match(deadline.text, /updated_at = now\(\)/);
  assert.deepEqual(deadline.params, ['2026-09-15', 11]);

  // Notifications fire even though opened === 0 — that was the old gate's bug.
  const notif = clientQueries.find(q => /INSERT INTO notifications/.test(q.text));
  assert.ok(notif, 'summary_due notification inserted');
  assert.ok(notif.params.includes('summary_due'));
  assert.ok(notif.params.some(p => typeof p === 'string' && p.includes('"pointCount":1')));

  assert.ok(clientQueries.some(q => /^COMMIT/.test(q.text)));
  assert.ok(!clientQueries.some(q => /^ROLLBACK/.test(q.text)));
  assert.equal(released, true);
});

test('a row that still resolves to nobody stays flagged, quietly', async () => {
  resolverIds = [];
  const out = await sendForSummaries(7, ACTOR, EVENT, '2026-09-15');

  assert.deepEqual(out, { opened: 0, reassigned: 0, supervisors: 0, unassigned: 1 });
  assert.ok(!clientQueries.some(q => /INSERT INTO meeting_summary_assignees/.test(q.text)));
  assert.ok(!clientQueries.some(q => /UPDATE meeting_summaries SET deadline_date/.test(q.text)));
  // Nothing opened and nothing reassigned → no notifications at all; the
  // owner already heard about this row when it was first opened.
  assert.ok(!clientQueries.some(q => /INSERT INTO notifications/.test(q.text)));
  assert.ok(clientQueries.some(q => /^COMMIT/.test(q.text)));
});
