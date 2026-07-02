const express = require('express');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');
const { sanitizeEditorHtml } = require('../helpers/sanitize');

const router = express.Router();

// GET /api/workflow/comments?event_id=X&section_id=Y
router.get('/', requireAuth, async (req, res) => {
  try {
    const { event_id, section_id } = req.query;
    const { rows } = await db.query(
      `SELECT sc.id, sc.anchor_id, sc.parent_id, sc.content, sc.created_at,
              sc.user_id, u.full_name, u.full_name_ka, u.username
       FROM section_comments sc
       JOIN users u ON u.id = sc.user_id
       WHERE sc.event_id = $1 AND sc.section_id = $2
       ORDER BY sc.created_at`,
      [event_id, section_id]
    );
    res.json(rows.map(r => ({
      id: r.id,
      anchorId: r.anchor_id,
      parentId: r.parent_id || null,
      content: r.content,
      createdAt: r.created_at,
      userId: r.user_id,
      userName: r.full_name,
      userNameKa: r.full_name_ka,
      username: r.username,
    })));
  } catch (err) {
    console.error('List comments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workflow/comments
router.post('/', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId, anchorId, parentId, content, htmlContent } = req.body;
    const { rows } = await db.query(
      `INSERT INTO section_comments (event_id, section_id, user_id, parent_id, anchor_id, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [eventId, sectionId, req.user.id, parentId || null, anchorId || null, content]
    );

    // Auto-save editor HTML so the comment anchor is persisted
    if (htmlContent) {
      await db.query(
        `UPDATE section_content
         SET html_content = $1, last_updated_at = now(),
             last_updated_by_user_id = $2
         WHERE event_id = $3 AND section_id = $4`,
        [sanitizeEditorHtml(htmlContent), req.user.id, eventId, sectionId]
      );
    }

    res.status(201).json({ id: rows[0].id, success: true });
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workflow/comments/delete  (frontend calls this as POST)
router.post('/delete', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { commentId } = req.body;
    await db.query('DELETE FROM section_comments WHERE id = $1 AND user_id = $2', [commentId, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Keep DELETE /:id for API consumers
router.delete('/:id', requireAuth, denyAnalyst, async (req, res) => {
  try {
    await db.query('DELETE FROM section_comments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
