/**
 * Opening Meeting Summary tasks.
 *
 * The Document Owner records a meeting agenda when they export, then sends it
 * out when the meeting is done. This is what "sending" does: for every
 * extracted point not already out, open a summary row, work out which
 * Supervisors owe it, and tell them.
 *
 * Nothing here is time-driven. A point is open once it has a summary row, so
 * sending again simply skips what is already out and picks up anything a later
 * re-export added — no extra state, and a double-click cannot double-assign.
 */
const db = require('../db');
const { resolveStepUserIds } = require('./event-notification-draft');
const { insertNotifications } = require('./notifications');
const { ymd } = require('./meeting-summary');

/**
 * Agenda points of one event that are still live and have no summary row yet.
 * This is the whole "what would sending do" question, and it is the same query
 * whether it is asked to preview a send or to perform one.
 */
const PENDING_SQL = `
  SELECT ap.id AS agenda_point_id, ap.section_id, ap.topic_snapshot
  FROM meeting_agenda_points ap
  WHERE ap.event_id = $1
    AND ap.removed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM meeting_summaries ms WHERE ms.agenda_point_id = ap.id
    )
  ORDER BY ap.position
`;

/** How many points a send would open right now. */
async function countPending(handle, eventId) {
  const { rows } = await handle.query(
    `SELECT count(*)::int AS n FROM meeting_agenda_points ap
     WHERE ap.event_id = $1 AND ap.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM meeting_summaries ms WHERE ms.agenda_point_id = ap.id)`,
    [eventId]
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * Open every not-yet-sent point of one event, in a single transaction.
 *
 * Notifications are written inside that transaction on purpose: sent after
 * COMMIT, a crash in between would leave a task open that nobody was ever told
 * about.
 *
 * Throws on failure so the caller can answer the request honestly — unlike the
 * timer this replaced, there is no next tick to quietly retry.
 */
async function sendForSummaries(eventId, actor, event, deadlineDate) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(PENDING_SQL, [eventId]);

    // Per supervisor, not per event: a supervisor who owns one point of five
    // must be told they owe one, not five.
    const pointsPerSupervisor = new Map();
    const unassignedTopics = [];
    let opened = 0;

    for (const row of rows) {
      // UNIQUE (agenda_point_id) makes this the claim: if a concurrent send
      // already opened this point, DO NOTHING returns no row and we skip it.
      const { rows: [summary] } = await client.query(
        `INSERT INTO meeting_summaries (agenda_point_id, event_id, deadline_date, opened_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agenda_point_id) DO NOTHING
         RETURNING id`,
        [row.agenda_point_id, eventId, deadlineDate, actor.id]
      );
      if (!summary) continue;
      opened += 1;

      // Reused rather than re-queried: this already applies the section's
      // departments and the country-assignment rule. resolveStepUserIds only
      // calls .query() on the handle it is given, so the transaction's client
      // keeps the whole send atomic.
      const ids = await resolveStepUserIds(client, eventId, row.section_id, 'SUPERVISOR');

      if (ids.length) {
        const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO meeting_summary_assignees (summary_id, user_id)
           VALUES ${values} ON CONFLICT DO NOTHING`,
          [summary.id, ...ids]
        );
        ids.forEach((id) => pointsPerSupervisor.set(id, (pointsPerSupervisor.get(id) || 0) + 1));
      } else {
        // No supervisor covers this point's departments. The row still exists
        // and must not vanish silently, so a human is told instead.
        unassignedTopics.push(row.topic_snapshot || '');
      }
    }

    if (opened) {
      const eventTitle = event.title || '';

      // Grouped by count so supervisors owing the same number share one insert.
      const byCount = new Map();
      pointsPerSupervisor.forEach((count, userId) => {
        if (!byCount.has(count)) byCount.set(count, []);
        byCount.get(count).push(userId);
      });
      for (const [count, userIds] of byCount) {
        await insertNotifications(client, userIds, {
          type: 'summary_due',
          eventId,
          meta: { eventTitle, deadlineDate: ymd(deadlineDate), pointCount: count },
        });
      }

      if (unassignedTopics.length) {
        await insertNotifications(client, await unassignedRecipients(client, actor, event), {
          type: 'summary_unassigned',
          eventId,
          meta: { eventTitle, count: unassignedTopics.length, topics: unassignedTopics.slice(0, 5) },
        });
      }
    }

    await client.query('COMMIT');
    console.log(`[meeting-summary] send event=${eventId} by=${actor.id} opened=${opened} ` +
      `supervisors=${pointsPerSupervisor.size} unassigned=${unassignedTopics.length}`);

    return {
      opened,
      supervisors: pointsPerSupervisor.size,
      unassigned: unassignedTopics.length,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Who hears that a point has no responsible department head.
 *
 * The person who sent, always — they are at the screen and can act on it. Plus
 * the owner, except where that is the Minister: a Minister-owned document has
 * no event-level deputy (simple workflow forces deputy_id to NULL) and the
 * Minister never logs in, so the warning would land nowhere. Protocol, who
 * runs the Minister's documents, hears it instead.
 */
async function unassignedRecipients(handle, actor, event) {
  const ids = new Set([actor.id]);
  if (event.document_submitter_role === 'MINISTER') {
    const { rows } = await handle.query(`SELECT id FROM users WHERE role = 'PROTOCOL'`);
    rows.forEach((r) => ids.add(r.id));
  } else {
    if (event.document_submitter_id) ids.add(event.document_submitter_id);
    if (event.deputy_id) ids.add(event.deputy_id);
  }
  return [...ids];
}

module.exports = { sendForSummaries, countPending, PENDING_SQL };
