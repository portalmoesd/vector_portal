const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');

const router = express.Router();

// Use memory storage — files are stored in the database (BYTEA), not on disk
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/workflow/files/upload
router.post('/upload', requireAuth, denyAnalyst, upload.array('files', 10), async (req, res) => {
  try {
    const { eventId, sectionId } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    // Look up uploader name from DB (JWT only has id/username/role)
    const userRow = await db.query(`SELECT full_name FROM users WHERE id = $1`, [req.user.id]);
    const uploaderName = userRow.rows[0]?.full_name || req.user.username;

    const uploaded = [];
    for (const f of (req.files || [])) {
      // Multipart filenames arrive latin1-decoded; re-decode as UTF-8 so
      // non-ASCII names (e.g. Georgian) are stored correctly.
      const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const storedName = Date.now() + '-' + Math.round(Math.random() * 1e9) + '-' + originalName;
      const row = await db.query(
        `INSERT INTO section_files (event_id, section_id, original_name, stored_name, mime_type, size, uploaded_by_id, uploaded_by_name, file_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, original_name, stored_name, mime_type, size, uploaded_by_id, created_at`,
        [eventId, sectionId, originalName, storedName, f.mimetype, f.size, req.user.id, uploaderName, f.buffer]
      );
      uploaded.push(row.rows[0]);
    }

    res.json({ success: true, files: uploaded });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workflow/files/list
router.get('/list', requireAuth, async (req, res) => {
  try {
    const { eventId, sectionId } = req.query;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const result = await db.query(
      `SELECT id, original_name, stored_name, mime_type, size, uploaded_by_id, uploaded_by_name, created_at
       FROM section_files
       WHERE event_id = $1 AND section_id = $2
       ORDER BY created_at DESC`,
      [eventId, sectionId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workflow/files/download
router.get('/download', requireAuth, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const result = await db.query(
      `SELECT original_name, mime_type, file_data FROM section_files WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const file = result.rows[0];
    if (!file.file_data) {
      return res.status(404).json({ error: 'File data not available. Please re-upload the file.' });
    }

    res.set('Content-Type', file.mime_type || 'application/octet-stream');
    // RFC 5987: filename* carries the UTF-8 name; the ASCII filename is a fallback.
    const asciiName = file.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.set('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.send(file.file_data);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workflow/files/delete
router.post('/delete', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const result = await db.query(
      `SELECT uploaded_by_id FROM section_files WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const file = result.rows[0];

    // Only the uploader or an admin can delete
    if (file.uploaded_by_id !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not authorized to delete this file' });
    }

    // Remove from DB (file_data is deleted with the row)
    await db.query(`DELETE FROM section_files WHERE id = $1`, [id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
