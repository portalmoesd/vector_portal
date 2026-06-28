const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — the current user's recent notifications + unread count.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, type, event_id, section_id, meta, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
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

// POST /api/notifications/read — mark one ({ id }) or, with no id, all as read.
router.post('/read', requireAuth, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (id) {
      await db.query(
        'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
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
