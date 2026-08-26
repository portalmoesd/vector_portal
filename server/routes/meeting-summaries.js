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

const router = express.Router();

// A summary counts as written when it holds something a reader would see.
// Mirrors GCP.DiscussionPoints.isBlankHtml on the client so both sides agree
// on when a row is done.
function isBlankHtml(html) {
  if (!html) return true;
  return String(html)
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim() === '';
}

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

    const clean = [];
    const seen = new Set();
    points.forEach((p) => {
      const sectionId = parseInt(p && p.sectionId, 10);
      const dpId = p && p.dpId ? String(p.dpId).slice(0, 60) : '';
      if (!sectionId || !dpId || !sectionIds.has(sectionId)) return;
      const key = `${sectionId}:${dpId}`;
      if (seen.has(key)) return;      // a duplicate id would break the upsert
      seen.add(key);
      clean.push({
        sectionId,
        dpId,
        position: clean.length,
        topic: String((p.topic == null ? '' : p.topic)).slice(0, 2000),
        contextHtml: sanitizeEditorHtml(p.contextHtml || ''),
        additionalHtml: sanitizeEditorHtml(p.additionalHtml || ''),
      });
    });

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
    const keptKeys = clean.map(p => `${p.sectionId}:${p.dpId}`);
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

module.exports = router;
module.exports.isBlankHtml = isBlankHtml;
