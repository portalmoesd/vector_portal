/**
 * POST /api/notifications/read — which rows each body shape marks read.
 *
 * The dashboard clears every attention notification an event carries in one
 * call when the user opens its card (an event that was created and later
 * published holds both 'event_created' and 'completed'), so the route takes a
 * list of types as well as a single one.
 *
 * The route is mounted on a throwaway express app with `../db` stubbed, so the
 * test records the SQL and parameters without needing a database.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const queries = [];
// Stand in for the pool before the route module can pull in the real one.
require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    query: async (text, params) => {
      queries.push({ text, params });
      // The list route reads a scalar off the unread-count query.
      return { rows: /COUNT\(/.test(text) ? [{ n: 0 }] : [] };
    },
    pool: {},
  },
};

const config = require('../../server/config');
const notifications = require('../../server/routes/notifications');

const TOKEN = jwt.sign({ id: 7, username: 'deputy', role: 'DEPUTY' }, config.jwtSecret);
let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notifications);
  await new Promise(done => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${server.address().port}/api/notifications/read`;
});

after(() => server && server.close());

async function post(body) {
  queries.length = 0;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return queries;
}

test('a list of types clears them all in one statement', async () => {
  const [q, ...rest] = await post({ eventId: 42, type: ['event_created', 'completed'] });
  assert.equal(rest.length, 0);
  assert.match(q.text, /SET is_read = TRUE/);
  assert.match(q.text, /type = ANY\(\$3\)/);
  assert.deepEqual(q.params, [7, 42, ['event_created', 'completed']]);
  // Scoped to the caller and left alone once read.
  assert.match(q.text, /user_id = \$1/);
  assert.match(q.text, /is_read = FALSE/);
});

test('a single type still works', async () => {
  const [q] = await post({ eventId: 42, type: 'completed' });
  assert.deepEqual(q.params, [7, 42, ['completed']]);
});

test('an empty type list touches nothing', async () => {
  assert.deepEqual(await post({ eventId: 42, type: [] }), []);
});

test('an id marks that one notification', async () => {
  const [q] = await post({ id: 5 });
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(q.params, [5, 7]);
});

test('an empty body marks everything read', async () => {
  const [q] = await post({});
  assert.match(q.text, /WHERE user_id = \$1 AND is_read = FALSE/);
  assert.deepEqual(q.params, [7]);
});

test('the recent-notifications window always includes unread rows', async () => {
  // The dashboard derives its attention dots from the unread rows in this
  // response; one pushed out of the recent window by newer traffic would
  // silently drop its badge.
  queries.length = 0;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const [list] = queries;
  assert.match(list.text, /is_read = FALSE[\s\S]*UNION/);
  assert.match(list.text, /ORDER BY created_at DESC$/);
});

test('the route file lives where the test thinks it does', () => {
  // Guards the require.cache stub above: a moved db module would silently load
  // the real pool and the assertions would stop meaning anything.
  assert.ok(require.resolve('../../server/db').endsWith(path.join('server', 'db.js')));
});
