/**
 * Meeting Summaries — the post-meeting half of a Discussion Points document.
 *
 * Before a meeting the Document Owner opens the export picker and chooses which
 * discussion points to take along. That choice used to be transient; POST
 * /agenda persists it as the meeting agenda. One hour after the meeting the
 * scheduler (server/helpers/meeting-summary-scheduler.js) opens a summary row
 * per extracted point and assigns it to the Supervisors of that point's
 * section, who then fill in the right-hand column here.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');
const { sanitizeEditorHtml } = require('../helpers/sanitize');
const { canSeeEventDateTime } = require('../helpers/roles');
const {
  isBlankHtml, ymd, normalizeAgendaPoints, agendaKeys,
} = require('../helpers/meeting-summary');

const router = express.Router();

// ─── POST /api/meeting-summaries/agenda ──────────────────────────────────────
// Record which discussion points the Document Owner extracted for the meeting.
//
// Owner-only, enforced here rather than trusted from the client: the export
// buttons are visible to everyone who can read the document, and only the
// owner's selection is the agenda of record.
//
// Re-exporting replaces the agenda without destroying written summaries:
//   still selected  -> keep the row (and its summary), refresh the snapshot
//   newly selected  -> insert
//   no longer there -> mark removed_at (soft), never DELETE
router.post('/agenda', requireAuth, denyAnalyst, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const eventId = parseInt(req.body.eventId, 10);
    const points = Array.isArray(req.body.points) ? req.body.points : [];
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    const { rows: [event] } = await client.query(
      `SELECT document_submitter_id, document_type, status, event_datetime
       FROM events WHERE id = $1`,
      [eventId]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.document_type !== 'DISCUSSION_POINTS') {
      return res.status(400).json({ error: 'Not a Discussion Points document' });
    }
    if (event.status !== 'COMPLETED' && event.status !== 'ARCHIVED') {
      return res.status(400).json({ error: `Event is ${event.status}, not a published document` });
    }
    if (event.document_submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the Document Owner can record the meeting agenda' });
    }

    // Only points that belong to this event's sections may be recorded.
    const { rows: ownSections } = await client.query(
      'SELECT id FROM sections WHERE event_id = $1', [eventId]
    );
    const sectionIds = new Set(ownSections.map(r => r.id));

    const clean = normalizeAgendaPoints(points, sectionIds).map((p) => Object.assign({}, p, {
      contextHtml: sanitizeEditorHtml(p.contextHtml),
      additionalHtml: sanitizeEditorHtml(p.additionalHtml),
    }));

    if (!clean.length) {
      return res.status(400).json({ error: 'No valid discussion points to record' });
    }

    await client.query('BEGIN');

    for (const p of clean) {
      await client.query(
        `INSERT INTO meeting_agenda_points
           (event_id, section_id, dp_id, position, topic_snapshot,
            context_snapshot, additional_snapshot, recorded_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id, section_id, dp_id) DO UPDATE
           SET position            = EXCLUDED.position,
               topic_snapshot      = EXCLUDED.topic_snapshot,
               context_snapshot    = EXCLUDED.context_snapshot,
               additional_snapshot = EXCLUDED.additional_snapshot,
               recorded_by_id      = EXCLUDED.recorded_by_id,
               removed_at          = NULL,
               updated_at          = now()`,
        [eventId, p.sectionId, p.dpId, p.position, p.topic,
         p.contextHtml, p.additionalHtml, req.user.id]
      );
    }

    // Anything not in this selection drops off the agenda. Soft, so a summary
    // already written against it survives and stays visible, flagged.
    const keptKeys = agendaKeys(clean);
    await client.query(
      `UPDATE meeting_agenda_points
       SET removed_at = now(), updated_at = now()
       WHERE event_id = $1
         AND removed_at IS NULL
         AND (section_id || ':' || dp_id) <> ALL($2::text[])`,
      [eventId, keptKeys]
    );

    await client.query('COMMIT');

    console.log(`[meeting-summaries.agenda] event=${eventId} owner=${req.user.id} points=${clean.length}`);
    res.json({
      success: true,
      recorded: clean.length,
      // The scheduler can only open summaries once a meeting time exists.
      hasMeetingTime: !!event.event_datetime,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ }
    console.error('Record meeting agenda error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── GET /api/meeting-summaries/mine ─────────────────────────────────────────
// The current user's open summary rows, grouped by event, for the dashboard
// panel and its badge.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT e.id AS event_id, e.title, c.code AS country_code,
              c.name_en AS country_name, c.name_ka AS country_name_ka,
              min(ms.deadline_date) AS deadline_date,
              count(*)::int AS my_total,
              count(*) FILTER (WHERE btrim(regexp_replace(
                regexp_replace(ms.summary_html, '<[^>]*>', '', 'g'),
                '&nbsp;', ' ', 'g')) = '')::int AS my_pending
       FROM meeting_summary_assignees a
       JOIN meeting_summaries ms ON ms.id = a.summary_id
       JOIN meeting_agenda_points ap ON ap.id = ms.agenda_point_id
       JOIN events e ON e.id = ms.event_id
       JOIN countries c ON c.id = e.country_id
       WHERE a.user_id = $1 AND ap.removed_at IS NULL
       GROUP BY e.id, e.title, c.code, c.name_en, c.name_ka
       ORDER BY min(ms.deadline_date) NULLS LAST, e.title`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({
      eventId: r.event_id,
      title: r.title,
      countryCode: r.country_code,
      countryName: r.country_name,
      countryNameKa: r.country_name_ka,
      deadlineDate: ymd(r.deadline_date),
      myTotal: r.my_total,
      myPending: r.my_pending,
    })));
  } catch (err) {
    console.error('My meeting summaries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/meeting-summaries/:eventId ─────────────────────────────────────
// The whole two-column table for one document: every extracted point with its
// summary. Readable by anyone who can already see the document in the Library
// — write access is per row and much narrower (assignees only).
router.get('/:eventId', requireAuth, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    if (!eventId) return res.status(400).json({ error: 'Invalid event id' });

    const { rows: [event] } = await db.query(
      `SELECT e.id, e.title, e.language, e.event_datetime, e.document_submitter_id,
              c.name_en AS country_name, c.name_ka AS country_name_ka, c.code AS country_code
       FROM events e JOIN countries c ON c.id = e.country_id
       WHERE e.id = $1`,
      [eventId]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows } = await db.query(
      `SELECT ap.id AS agenda_point_id, ap.section_id, s.title AS section_title,
              ap.dp_id, ap.position, ap.topic_snapshot,
              ap.context_snapshot, ap.additional_snapshot, ap.removed_at,
              ms.id AS summary_id, ms.summary_html, ms.status, ms.deadline_date,
              ms.last_edited_at,
              u.full_name AS last_edited_by, u.full_name_ka AS last_edited_by_ka,
              EXISTS (SELECT 1 FROM meeting_summary_assignees a
                      WHERE a.summary_id = ms.id AND a.user_id = $2) AS mine,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', au.id, 'fullName', au.full_name, 'fullNameKa', au.full_name_ka)
                       ORDER BY au.full_name)
                FROM meeting_summary_assignees a2
                JOIN users au ON au.id = a2.user_id
                WHERE a2.summary_id = ms.id
              ), '[]') AS assignees
       FROM meeting_agenda_points ap
       JOIN sections s ON s.id = ap.section_id
       LEFT JOIN meeting_summaries ms ON ms.agenda_point_id = ap.id
       LEFT JOIN users u ON u.id = ms.last_edited_by_user_id
       WHERE ap.event_id = $1
       ORDER BY ap.position`,
      [eventId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No meeting agenda recorded' });

    // A point dropped by a later re-export is hidden once nothing was written
    // against it, and kept — flagged — when a summary already exists, so no
    // written work disappears silently.
    const visible = rows.filter((r) => !r.removed_at || !isBlankHtml(r.summary_html));

    const items = visible.map((r) => ({
      agendaPointId: r.agenda_point_id,
      summaryId: r.summary_id,
      sectionId: r.section_id,
      sectionTitle: r.section_title,
      dpId: r.dp_id,
      position: r.position,
      topic: r.topic_snapshot,
      contextHtml: r.context_snapshot,
      additionalHtml: r.additional_snapshot,
      summaryHtml: r.summary_html || '',
      filled: !isBlankHtml(r.summary_html),
      // No summary row yet means the meeting has not passed (or has no time),
      // so the task simply has not opened.
      opened: !!r.summary_id,
      removedFromAgenda: !!r.removed_at,
      deadlineDate: ymd(r.deadline_date),
      assignees: r.assignees || [],
      lastEditedBy: r.last_edited_by,
      lastEditedByKa: r.last_edited_by_ka,
      lastEditedAt: r.last_edited_at,
      // Only an assignee may write, and only once the task has opened.
      canEdit: !!r.summary_id && !!r.mine && !r.removed_at,
    }));

    const counted = items.filter((i) => !i.removedFromAgenda);
    res.json({
      eventId: event.id,
      title: event.title,
      language: event.language,
      countryName: event.country_name,
      countryNameKa: event.country_name_ka,
      countryCode: event.country_code,
      // Reused verbatim; the rule is deliberately not widened by this feature.
      eventDateTime: canSeeEventDateTime(req.user.role, req.user.id, event.document_submitter_id)
        ? event.event_datetime : null,
      hasMeetingTime: !!event.event_datetime,
      opened: counted.some((i) => i.opened),
      canEditAny: items.some((i) => i.canEdit),
      progress: {
        done: counted.filter((i) => i.filled).length,
        total: counted.length,
        unassigned: counted.filter((i) => i.opened && !i.assignees.length).length,
      },
      items,
    });
  } catch (err) {
    console.error('Meeting summary read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/meeting-summaries/row/:id ──────────────────────────────────────
// Write one summary cell. Assignees only; several supervisors may share a row,
// in which case the last save wins — hence the recorded author and timestamp,
// which is how the other one sees they were overwritten.
router.put('/row/:id', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const summaryId = parseInt(req.params.id, 10);
    if (!summaryId) return res.status(400).json({ error: 'Invalid summary id' });

    const { rows: [allowed] } = await db.query(
      `SELECT 1 FROM meeting_summary_assignees WHERE summary_id = $1 AND user_id = $2`,
      [summaryId, req.user.id]
    );
    if (!allowed) {
      return res.status(403).json({ error: 'Only an assigned supervisor can write this summary' });
    }

    const summaryHtml = sanitizeEditorHtml(req.body.summaryHtml || '');
    const status = isBlankHtml(summaryHtml) ? 'PENDING' : 'SUBMITTED';

    const { rows: [row] } = await db.query(
      `UPDATE meeting_summaries
       SET summary_html = $1, status = $2, last_edited_by_user_id = $3,
           last_edited_at = now(), updated_at = now()
       WHERE id = $4
       RETURNING id, status, last_edited_at`,
      [summaryHtml, status, req.user.id, summaryId]
    );
    if (!row) return res.status(404).json({ error: 'Summary not found' });

    const { rows: [me] } = await db.query(
      'SELECT full_name, full_name_ka FROM users WHERE id = $1', [req.user.id]
    );

    res.json({
      success: true,
      filled: status === 'SUBMITTED',
      status: row.status,
      lastEditedBy: me ? me.full_name : null,
      lastEditedByKa: me ? me.full_name_ka : null,
      lastEditedAt: row.last_edited_at,
    });
  } catch (err) {
    console.error('Meeting summary write error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
