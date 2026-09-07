/**
 * The meeting-summaries routes, mounted on a throwaway express app with the
 * pool stubbed (the notifications-read.test.js pattern) — no database.
 *
 * Pins the route-level halves of the batch: a send with nothing pending but an
 * unassigned row no longer early-returns (F1), /mine ages fully-done events
 * off after 30 days but never hides pending work (F6), and the read route
 * ships endedAt for the exports' date line (F4).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const queries = [];
// Per-test scripted answers, matched in order of these regex keys.
const script = { pendingCount: 0, unassignedCount: 0, agendaCount: 0, items: [] };

const EVENT_ROW = {
  id: 7, title: 'Berlin Summit', language: 'EN',
  event_datetime: '2026-08-20T10:00:00.000Z', ended_at: '2026-08-21T10:00:00.000Z',
  document_submitter_id: 5, document_submitter_role: 'DEPUTY', deputy_id: null,
  document_type: 'DISCUSSION_POINTS', status: 'COMPLETED',
  country_name: 'Germany', country_name_ka: 'გერმანია', country_code: 'DE',
};

async function dispatch(text) {
  if (/FROM events e JOIN countries c/.test(text)) return { rows: [EVENT_ROW] };
  if (/FROM events WHERE id = \$1/.test(text)) return { rows: [EVENT_ROW] };
  // countPending: agenda points with no summary row.
  if (/count\(\*\)::int AS n FROM meeting_agenda_points ap/.test(text)) {
    return { rows: [{ n: script.pendingCount }] };
  }
  // countUnassigned: summary rows with no assignees.
  if (/count\(\*\)::int AS n\s+FROM meeting_summaries ms/.test(text)) {
    return { rows: [{ n: script.unassignedCount }] };
  }
  // The live-agenda total the send route reports as alreadySent.
  if (/count\(\*\)::int AS n FROM meeting_agenda_points\s+WHERE/.test(text)) {
    return { rows: [{ n: script.agendaCount }] };
  }
  if (/ap\.id AS agenda_point_id/.test(text)) return { rows: script.items };
  // /mine grouping query.
  if (/AS my_pending/.test(text)) return { rows: [] };
  // sendForSummaries internals (UNASSIGNED_SQL / PENDING_SQL / inserts).
  if (/SELECT ms\.id AS summary_id/.test(text)) {
    return { rows: [{ summary_id: 11, section_id: 3, topic_snapshot: 'Orphan point' }] };
  }
  return { rows: [] };
}

require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    query: async (text, params) => { queries.push({ text, params }); return dispatch(text); },
    pool: {
      connect: async () => ({
        query: async (text, params) => { queries.push({ text, params }); return dispatch(text); },
        release: () => {},
      }),
    },
  },
};

require.cache[require.resolve('../../server/helpers/event-notification-draft')] = {
  id: require.resolve('../../server/helpers/event-notification-draft'),
  filename: require.resolve('../../server/helpers/event-notification-draft'),
  loaded: true,
  exports: {
    resolveStepUserIds: async () => [7],
    resolveEventParticipantIds: async () => [],
  },
};

const config = require('../../server/config');
const route = require('../../server/routes/meeting-summaries');

const TOKEN = jwt.sign({ id: 5, username: 'deputy', role: 'DEPUTY' }, config.jwtSecret);
let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meeting-summaries', route);
  await new Promise(done => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${server.address().port}/api/meeting-summaries`;
});

after(() => server && server.close());

async function call(method, path) {
  queries.length = 0;
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: method === 'POST' ? '{}' : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('a send with nothing pending but an orphaned row runs and reports the rescue', async () => {
  script.pendingCount = 0;
  script.unassignedCount = 1;
  script.agendaCount = 3;
  const { status, body } = await call('POST', '/7/send');
  assert.equal(status, 200);
  assert.equal(body.reassigned, 1);
  assert.equal(body.opened, 0);
  // The transaction actually ran — this used to be the early-return path.
  assert.ok(queries.some(q => /^BEGIN/.test(q.text)));
  assert.ok(queries.some(q => /INSERT INTO meeting_summary_assignees/.test(q.text)));
});

test('a send with nothing at all to do still short-circuits', async () => {
  script.pendingCount = 0;
  script.unassignedCount = 0;
  script.agendaCount = 3;
  let out = await call('POST', '/7/send');
  assert.equal(out.status, 200);
  assert.deepEqual(
    { opened: out.body.opened, reassigned: out.body.reassigned, alreadySent: out.body.alreadySent },
    { opened: 0, reassigned: 0, alreadySent: 3 });
  assert.ok(!queries.some(q => /^BEGIN/.test(q.text)));

  script.agendaCount = 0;
  out = await call('POST', '/7/send');
  assert.equal(out.status, 400);
  assert.match(out.body.error, /No meeting agenda/);
});

test('/mine keeps pending work forever and ages done events off after 30 days', async () => {
  const { status } = await call('GET', '/mine');
  assert.equal(status, 200);
  const q = queries.find(x => /AS my_pending/.test(x.text));
  assert.ok(q, 'the grouping query ran');
  assert.match(q.text, /HAVING count\(\*\) FILTER \(WHERE ms\.status = 'PENDING'\) > 0/);
  assert.match(q.text, /GREATEST\(ms\.updated_at, ms\.opened_at\)[\s\S]*interval '30 days'/);
});

test('the read route ships endedAt so the exports can print a date', async () => {
  script.items = [{
    agenda_point_id: 21, section_id: 3, section_title: 'Trade', dp_id: 'dp-1', kind: 'point',
    position: 0, topic_snapshot: 'T', context_snapshot: '<p>c</p>', additional_snapshot: '',
    removed_at: null, summary_id: 31, summary_html: '', status: 'PENDING',
    deadline_date: '2026-09-15', last_edited_at: null, last_edited_by: null,
    last_edited_by_ka: null, mine: true, assignees: [],
  }];
  const { status, body } = await call('GET', '/7');
  assert.equal(status, 200);
  assert.equal(body.endedAt, EVENT_ROW.ended_at);
  const q = queries.find(x => /FROM events e JOIN countries c/.test(x.text));
  assert.match(q.text, /e\.ended_at/);
});
