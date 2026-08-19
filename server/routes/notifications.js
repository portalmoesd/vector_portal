const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — the current user's recent notifications + unread count.
router.get('/', requireAuth, async (req, res) => {
  try {
    // The recent window, plus every unread row however old. The dashboard derives
    // its attention dots (your-turn / new event / document ready) from the unread
    // entries in this response, so an unread notification pushed out of the recent
    // window by newer traffic would silently drop its badge.
    const { rows } = await db.query(
      `(SELECT id, type, event_id, section_id, meta, is_read, created_at
        FROM notifications
        WHERE user_id = $1 AND is_read = FALSE
        ORDER BY created_at DESC
        LIMIT 200)
       UNION
       (SELECT id, type, event_id, section_id, meta, is_read, created_at
        FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50)
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    const { rows: [count] } = await db.query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({
      unreadCount: count.n,
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        eventId: r.event_id,
        sectionId: r.section_id,
        meta: r.meta || {},
        isRead: r.is_read,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('Notifications list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/read — mark one ({ id }), an event's notifications of
// one or more types ({ eventId, type } — a string or an array), or, with no body,
// all as read.
router.post('/read', requireAuth, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    const eventId = req.body && req.body.eventId;
    const type = req.body && req.body.type;
    if (id) {
      await db.query(
        'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
    } else if (eventId && type) {
      // An event the user opens can carry more than one attention notification
      // (created, then later published), and they all clear on that one open —
      // hence a list, matched in a single statement.
      const types = (Array.isArray(type) ? type : [type]).filter(Boolean);
      if (types.length) {
        await db.query(
          `UPDATE notifications SET is_read = TRUE
           WHERE user_id = $1 AND event_id = $2 AND type = ANY($3) AND is_read = FALSE`,
          [req.user.id, eventId, types]
        );
      }
    } else {
      await db.query(
        'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
        [req.user.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Notifications read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
