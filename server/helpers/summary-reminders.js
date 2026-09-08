/**
 * Deadline reminders for Meeting Summary tasks.
 *
 * A daily sweep, not a per-request hook: sending summaries stays owner-driven
 * (see meeting-summary-open.js), but a deadline that nobody is told about is
 * decoration. Once a day each assignee with PENDING work gets a
 * 'summary_due_soon' notification when their deadline is today or tomorrow,
 * and a 'summary_overdue' one once it has passed.
 *
 * Dedup lives in the SQL: the notifications table has no unique constraint and
 * insertNotifications() cannot dedup, so each INSERT…SELECT carries a
 * NOT EXISTS guard — at most one reminder of each type per (user, event),
 * which makes the sweep idempotent however often it runs.
 */
const db = require('../db');
const { tbilisiToday } = require('./meeting-summary');

// $1 = today as a Tbilisi 'YYYY-MM-DD'. Meta mirrors summary_due's shape
// (eventTitle / deadlineDate / pointCount) so the dashboard renders all three
// summary notification types the same way.
const DUE_SOON_SQL = `
  INSERT INTO notifications (user_id, type, event_id, meta)
  SELECT a.user_id, 'summary_due_soon', ms.event_id,
         jsonb_build_object(
           'eventTitle',   e.title,
           'deadlineDate', to_char(min(ms.deadline_date), 'YYYY-MM-DD'),
           'pointCount',   count(*)::int)
  FROM meeting_summary_assignees a
  JOIN meeting_summaries ms ON ms.id = a.summary_id
  JOIN meeting_agenda_points ap ON ap.id = ms.agenda_point_id
  JOIN events e ON e.id = ms.event_id
  WHERE ms.status = 'PENDING'
    AND ap.removed_at IS NULL
    AND ms.deadline_date >= $1::date
    AND ms.deadline_date <= $1::date + 1
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = a.user_id AND n.type = 'summary_due_soon' AND n.event_id = ms.event_id)
  GROUP BY a.user_id, ms.event_id, e.title
`;

const OVERDUE_SQL = `
  INSERT INTO notifications (user_id, type, event_id, meta)
  SELECT a.user_id, 'summary_overdue', ms.event_id,
         jsonb_build_object(
           'eventTitle',   e.title,
           'deadlineDate', to_char(min(ms.deadline_date), 'YYYY-MM-DD'),
           'pointCount',   count(*)::int)
  FROM meeting_summary_assignees a
  JOIN meeting_summaries ms ON ms.id = a.summary_id
  JOIN meeting_agenda_points ap ON ap.id = ms.agenda_point_id
  JOIN events e ON e.id = ms.event_id
  WHERE ms.status = 'PENDING'
    AND ap.removed_at IS NULL
    AND ms.deadline_date < $1::date
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = a.user_id AND n.type = 'summary_overdue' AND n.event_id = ms.event_id)
  GROUP BY a.user_id, ms.event_id, e.title
`;

let sweepRunning = false;

async function sweepSummaryReminders(now) {
  if (sweepRunning) return { dueSoon: 0, overdue: 0 };
  sweepRunning = true;
  try {
    const today = tbilisiToday(now);
    const dueSoon = await db.query(DUE_SOON_SQL, [today]);
    const overdue = await db.query(OVERDUE_SQL, [today]);
    if (dueSoon.rowCount || overdue.rowCount) {
      console.log(`[summary-reminders] due_soon=${dueSoon.rowCount} overdue=${overdue.rowCount}`);
    }
    return { dueSoon: dueSoon.rowCount, overdue: overdue.rowCount };
  } finally {
    sweepRunning = false;
  }
}

/**
 * Daily at 05:00 UTC (09:00 Tbilisi — no DST), plus a catch-up shortly after
 * boot so a container restarted past that hour still sends today's reminders.
 * Called from server/index.js, never at require time, and every timer is
 * unref'd so requiring this module can never keep a test process alive.
 */
function scheduleSummaryReminders() {
  const run = () => sweepSummaryReminders().catch((e) =>
    console.error('[summary-reminders] sweep failed:', e && e.message));

  const UTC_HOUR = 5;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), UTC_HOUR, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  console.log(`[summary-reminders] next sweep in ${((next - now) / 3600000).toFixed(1)}h (${next.toISOString()})`);
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000).unref();
  }, next - now).unref();
  setTimeout(run, 15_000).unref();
}

module.exports = { sweepSummaryReminders, scheduleSummaryReminders, DUE_SOON_SQL, OVERDUE_SQL };
