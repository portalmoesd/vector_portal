/**
 * Meeting Summary scheduler.
 *
 * One hour after a Discussion Points meeting, every point the Document Owner
 * extracted for it becomes a summary task for the Supervisors responsible for
 * that point's section. This module is what opens those tasks.
 *
 * Shape follows scheduleTradeCheck() in server/routes/statistics.js: a
 * module-level timer started at require time, plus a delayed boot run so
 * migrate() in server/index.js has finished creating the tables.
 */
const db = require('../db');
const { resolveStepUserIds } = require('../helpers/event-notification-draft');
const { insertNotifications } = require('../helpers/notifications');
const { ymd } = require('../helpers/meeting-summary');

// The SLA is "one hour after the meeting", and event_datetime is a wall-clock
// instant rather than a date, so the daily anchoring the statistics jobs use
// would be up to 24h late here. A quarter-hour tick bounds lateness at 15
// minutes against a 7-day window, for one indexed query per tick.
const TICK_MS = 15 * 60 * 1000;
const BOOT_DELAY_MS = 20_000;
const BATCH_LIMIT = 50;

// Guards against a slow tick stacking with the next one (mirrors the
// in-flight flags the statistics schedulers keep).
let tickRunning = false;

/**
 * Points that are due and have no summary row yet.
 *
 * There is deliberately no lower bound on event_datetime: "due and not yet
 * opened" is the whole idempotency and catch-up mechanism. A restart, a long
 * outage, or a re-export that adds points to an already-open agenda all
 * self-heal on the next tick, with no marker table and no in-memory state.
 */
const DUE_SQL = `
  SELECT ap.id AS agenda_point_id, ap.event_id, ap.section_id,
         ap.topic_snapshot, e.title AS event_title,
         -- The deadline is the meeting's *Tbilisi* calendar day plus 7. The
         -- server runs in UTC, so a plain ::date cast would put a meeting held
         -- after 20:00 UTC (i.e. after midnight in Tbilisi) a day early.
         ((e.event_datetime AT TIME ZONE 'Asia/Tbilisi')::date + 7) AS deadline_date
  FROM meeting_agenda_points ap
  JOIN events e ON e.id = ap.event_id
  WHERE ap.removed_at IS NULL
    AND e.document_type = 'DISCUSSION_POINTS'
    AND e.event_datetime IS NOT NULL
    AND e.event_datetime + INTERVAL '1 hour' <= now()
    AND NOT EXISTS (
      SELECT 1 FROM meeting_summaries ms WHERE ms.agenda_point_id = ap.id
    )
  ORDER BY e.event_datetime, ap.position
  LIMIT $1
`;

/**
 * Open every due point of one event, in a single transaction.
 *
 * Notifications are written inside that transaction on purpose: if they were
 * sent after COMMIT, a crash in between would leave a task open that nobody
 * was ever told about.
 */
async function openEvent(eventId, rows) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Per supervisor, not per event: a supervisor who owns one point of five
    // must be told they owe one, not five.
    const pointsPerSupervisor = new Map();
    const unassignedTopics = [];
    let opened = 0;

    for (const row of rows) {
      // UNIQUE (agenda_point_id) makes this the claim: if a concurrent tick
      // already opened this point, DO NOTHING returns no row and we skip it.
      const { rows: [summary] } = await client.query(
        `INSERT INTO meeting_summaries (agenda_point_id, event_id, deadline_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (agenda_point_id) DO NOTHING
         RETURNING id`,
        [row.agenda_point_id, eventId, row.deadline_date]
      );
      if (!summary) continue;
      opened += 1;

      // Reused rather than re-queried: this already applies the section's
      // departments and the country-assignment rule. resolveStepUserIds only
      // calls .query() on the handle it is given, so the transaction's client
      // keeps the whole open atomic.
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
        // and must not vanish silently, so the owner is told instead.
        unassignedTopics.push(row.topic_snapshot || '');
      }
    }

    if (opened) {
      const eventTitle = rows[0].event_title;
      // A DATE comes back as a Date object; keep it a plain YYYY-MM-DD string
      // so the notification meta reads as a date rather than a UTC instant.
      const deadlineDate = ymd(rows[0].deadline_date);

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
          meta: { eventTitle, deadlineDate, pointCount: count },
        });
      }

      if (unassignedTopics.length) {
        const { rows: [ev] } = await client.query(
          'SELECT document_submitter_id, deputy_id FROM events WHERE id = $1', [eventId]
        );
        const owners = [ev && ev.document_submitter_id, ev && ev.deputy_id].filter(Boolean);
        if (owners.length) {
          await insertNotifications(client, owners, {
            type: 'summary_unassigned',
            eventId,
            meta: { eventTitle, count: unassignedTopics.length, topics: unassignedTopics.slice(0, 5) },
          });
        }
      }
    }

    await client.query('COMMIT');
    if (opened) {
      console.log(`[meeting-summary] event=${eventId} opened=${opened} ` +
        `supervisors=${pointsPerSupervisor.size} unassigned=${unassignedTopics.length}`);
    }
    return opened;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ }
    // One bad event must not stop the others, and the point stays unopened so
    // the next tick retries it.
    console.error(`[meeting-summary] opening event ${eventId} failed:`, err.message);
    return 0;
  } finally {
    client.release();
  }
}

async function runTick(reason) {
  if (tickRunning) return 0;
  tickRunning = true;
  try {
    const { rows } = await db.query(DUE_SQL, [BATCH_LIMIT]);
    if (!rows.length) return 0;

    const byEvent = new Map();
    rows.forEach((r) => {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id).push(r);
    });

    let opened = 0;
    for (const [eventId, eventRows] of byEvent) {
      opened += await openEvent(eventId, eventRows);
    }
    if (opened) console.log(`[meeting-summary] ${reason} tick opened ${opened} summary row(s)`);
    return opened;
  } catch (err) {
    console.error('[meeting-summary] tick failed:', err.message);
    return 0;
  } finally {
    tickRunning = false;
  }
}

function start() {
  // Align to the next quarter hour so ticks land on predictable clock times.
  const delay = TICK_MS - (Date.now() % TICK_MS);
  setTimeout(() => {
    runTick('scheduled');
    setInterval(() => runTick('scheduled'), TICK_MS);
  }, delay);
  setTimeout(() => runTick('boot'), BOOT_DELAY_MS);
}

if (process.env.NODE_ENV !== 'test') start();

module.exports = { runTick, openEvent, DUE_SQL, TICK_MS };
