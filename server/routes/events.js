const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');
const { canCreateEvent, canEndEvent, ROLES } = require('../helpers/roles');
const { resolveEventNotificationDraft } = require('../helpers/event-notification-draft');
const { notifyEventCreated } = require('../helpers/notifications');

const router = express.Router();

// Event attachments are stored in the database (BYTEA), like section files.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/events — list events visible to current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const role = req.user.role;
    const userId = req.user.id;
    const isAdmin = role === ROLES.ADMIN || role === ROLES.PROTOCOL;
    const isCollabRole = role === ROLES.COLLABORATOR || role === ROLES.SUPER_COLLABORATOR;

    let whereClause = '';
    let params = [];

    if (isAdmin) {
      // ADMIN and PROTOCOL see all events
    } else if (isCollabRole) {
      // SC/Collaborator: must match BOTH country assignment AND section department
      whereClause = `WHERE (
        (
          e.country_id IN (SELECT country_id FROM country_assignments WHERE user_id = $1)
          AND EXISTS (
            SELECT 1 FROM sections s
            JOIN section_departments sd ON sd.section_id = s.id
            WHERE s.event_id = e.id
              AND sd.department_id = (SELECT department_id FROM users WHERE id = $1)
          )
        )
        OR e.document_submitter_id = $1
        OR e.deputy_id = $1
        OR e.supervisor_id = $1
        OR e.created_by_id = $1
      )`;
      params = [userId];
    } else {
      // Supervisor / Deputy: country assignment OR direct assignment OR
      // their department has any section in the event OR (for deputies)
      // they oversee any of the section departments via
      // deputy_department_links (which is what makes them the curator).
      // Without this, a supervisor / deputy without a country_assignment
      // never sees the event even though their department is on it.
      whereClause = `WHERE (
        e.country_id IN (SELECT country_id FROM country_assignments WHERE user_id = $1)
        OR e.document_submitter_id = $1
        OR e.deputy_id = $1
        OR e.supervisor_id = $1
        OR e.created_by_id = $1
        OR EXISTS (
          SELECT 1 FROM sections s
          JOIN section_departments sd ON sd.section_id = s.id
          WHERE s.event_id = e.id
            AND sd.department_id = (SELECT department_id FROM users WHERE id = $1)
        )
        OR EXISTS (
          SELECT 1 FROM sections s
          JOIN section_departments sd ON sd.section_id = s.id
          JOIN deputy_department_links ddl ON ddl.department_id = sd.department_id
          WHERE s.event_id = e.id AND ddl.deputy_id = $1
        )
      )`;
      params = [userId];
    }

    const { rows } = await db.query(
      `SELECT e.id, e.title, e.country_id, e.document_submitter_role,
              e.document_submitter_id, e.deputy_id, e.supervisor_id, e.curator_required,
              e.workflow_type,
              e.language, e.deadline_date, e.occasion, e.is_active,
              e.event_datetime,
              e.ended_at, e.status, e.created_at,
              c.name_en AS country_name, c.code AS country_code,
              ds.full_name AS document_submitter_name,
              ds.full_name_ka AS document_submitter_name_ka,
              sv.full_name AS supervisor_name,
              sv.full_name_ka AS supervisor_name_ka
       FROM events e
       JOIN countries c ON c.id = e.country_id
       JOIN users ds ON ds.id = e.document_submitter_id
       LEFT JOIN users sv ON sv.id = e.supervisor_id
       ${whereClause}
       ORDER BY e.created_at DESC`,
      params
    );
    // Event date/time is restricted: only the document owner, Protocol and Admin
    // may see it; everyone else sees only the deadline.
    const canSeeWhen = (ownerId) =>
      req.user.role === 'ADMIN' || req.user.role === 'PROTOCOL' || ownerId === req.user.id;
    res.json(rows.map(r => ({
      id: r.id,
      title: r.title,
      countryId: r.country_id,
      countryName: r.country_name,
      countryCode: r.country_code,
      documentSubmitterRole: r.document_submitter_role,
      documentSubmitterId: r.document_submitter_id,
      documentSubmitterName: r.document_submitter_name,
      documentSubmitterNameKa: r.document_submitter_name_ka,
      deputyId: r.deputy_id,
      supervisorId: r.supervisor_id,
      supervisorName: r.supervisor_name,
      supervisorNameKa: r.supervisor_name_ka,
      curatorRequired: r.curator_required,
      workflowType: r.workflow_type,
      language: r.language,
      deadlineDate: r.deadline_date,
      eventDateTime: canSeeWhen(r.document_submitter_id) ? r.event_datetime : null,
      occasion: r.occasion,
      isActive: r.is_active,
      endedAt: r.ended_at,
      status: r.status,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('List events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events — create event
router.post('/', requireAuth, denyAnalyst, async (req, res) => {
  try {
    if (!canCreateEvent(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to create events' });
    }

    const {
      title, countryId, documentSubmitterRole, documentSubmitterId,
      deputyId, supervisorId, curatorRequired, language, deadlineDate, occasion, sections,
      workflowType: rawWorkflowType, eventDateTime,
    } = req.body;
    // Normalise workflow type. Default 'advanced' preserves the existing
    // role-chain behaviour for clients that don't send the field. In
    // 'simple' mode the responsible-supervisor concept doesn't apply
    // (no Department A vs B), so supervisorId is forced to null.
    //
    // Simple workflow has no single final approver — it has a "Document Owner".
    // A Minister owner never acts (curators drive it), so a Minister forces
    // simple mode. For Minister and Deputy owners in simple mode the curator
    // step is mandatory (Minister relies on org-chart curators; a Deputy owner
    // also curates their own-department sections), so the curator flag is
    // forced on. Supervisor / Super-Collaborator owners keep the caller's
    // optional curator choice. In advanced mode the curator flag stays opt-in.
    const isMinisterDS = documentSubmitterRole === 'MINISTER';
    const workflowType = isMinisterDS
      ? 'simple'
      : (rawWorkflowType === 'simple' ? 'simple' : 'advanced');
    // Accept boolean true OR string 'yes' / 'true' for forgiving
    // intake from any caller that might serialise differently.
    const forceCurator = workflowType === 'simple'
      && (documentSubmitterRole === 'MINISTER' || documentSubmitterRole === 'DEPUTY');
    const effectiveCuratorRequired = forceCurator || curatorRequired === true
      || curatorRequired === 'true'
      || curatorRequired === 'yes';
    // The Document Owner sits outside the simple chain — curators are resolved
    // per-section from deputy_department_links, so no event-level deputy is
    // needed. (In advanced mode deputyId is the responsible/curator deputy.)
    const effectiveDeputyId = workflowType === 'simple' ? null : (deputyId || null);
    const effectiveSupervisorId = workflowType === 'simple' ? null : (supervisorId || null);
    console.log(`[events.create] workflow=${workflowType} owner=${documentSubmitterRole} curator_required=${effectiveCuratorRequired} (raw=${JSON.stringify(curatorRequired)})`);

    if (!title || !countryId || !documentSubmitterRole || !documentSubmitterId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── Role-based DS assignment validation ──────────────────────────────
    const creatorRole = req.user.role;
    if (creatorRole !== ROLES.ADMIN && creatorRole !== ROLES.PROTOCOL) {
      let allowed = false;

      if (creatorRole === ROLES.DEPUTY) {
        if (documentSubmitterRole === 'DEPUTY') {
          allowed = documentSubmitterId === req.user.id;
        } else if (documentSubmitterRole === 'SUPERVISOR') {
          const { rows } = await db.query(
            `SELECT 1 FROM deputy_supervisor_links WHERE deputy_id = $1 AND supervisor_id = $2`,
            [req.user.id, documentSubmitterId]
          );
          allowed = rows.length > 0;
        } else if (documentSubmitterRole === 'SUPER_COLLABORATOR') {
          const { rows } = await db.query(
            `SELECT 1 FROM users WHERE id = $1 AND role = 'SUPER_COLLABORATOR'
               AND department_id IN (
                 SELECT s.department_id FROM deputy_supervisor_links dsl
                 JOIN users s ON s.id = dsl.supervisor_id
                 WHERE dsl.deputy_id = $2 AND s.department_id IS NOT NULL
               )`,
            [documentSubmitterId, req.user.id]
          );
          allowed = rows.length > 0;
        }
      } else if (creatorRole === ROLES.SUPERVISOR) {
        if (documentSubmitterRole === 'SUPERVISOR') {
          allowed = documentSubmitterId === req.user.id;
        } else if (documentSubmitterRole === 'DEPUTY') {
          const { rows } = await db.query(
            `SELECT 1 FROM deputy_supervisor_links WHERE supervisor_id = $1 AND deputy_id = $2`,
            [req.user.id, documentSubmitterId]
          );
          allowed = rows.length > 0;
        } else if (documentSubmitterRole === 'SUPER_COLLABORATOR') {
          const { rows } = await db.query(
            `SELECT 1 FROM users WHERE id = $1 AND role = 'SUPER_COLLABORATOR' AND department_id = $2`,
            [documentSubmitterId, req.user.departmentId]
          );
          allowed = rows.length > 0;
        }
      } else if (creatorRole === ROLES.SUPER_COLLABORATOR) {
        if (documentSubmitterRole === 'SUPER_COLLABORATOR') {
          allowed = documentSubmitterId === req.user.id;
        } else if (documentSubmitterRole === 'SUPERVISOR') {
          const { rows } = await db.query(
            `SELECT 1 FROM users WHERE id = $1 AND role = 'SUPERVISOR' AND department_id = $2`,
            [documentSubmitterId, req.user.departmentId]
          );
          allowed = rows.length > 0;
        } else if (documentSubmitterRole === 'DEPUTY') {
          const { rows } = await db.query(
            `SELECT 1 FROM deputy_supervisor_links dsl
             JOIN users s ON s.id = dsl.supervisor_id
             WHERE dsl.deputy_id = $1 AND s.department_id = $2`,
            [documentSubmitterId, req.user.departmentId]
          );
          allowed = rows.length > 0;
        }
      }

      if (!allowed) {
        return res.status(403).json({ error: 'You are not authorized to assign this document submitter' });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [event] } = await client.query(
        `INSERT INTO events (title, country_id, document_submitter_role, document_submitter_id,
                             deputy_id, supervisor_id, curator_required, workflow_type, language,
                             deadline_date, occasion, created_by_id, event_datetime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [title, countryId, documentSubmitterRole, documentSubmitterId,
         effectiveDeputyId, effectiveSupervisorId, effectiveCuratorRequired, workflowType,
         language || 'EN', deadlineDate || null, occasion || null, req.user.id, eventDateTime || null]
      );

      if (sections && sections.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const { rows: [section] } = await client.query(
            'INSERT INTO sections (event_id, title, sort_order) VALUES ($1, $2, $3) RETURNING id',
            [event.id, sec.title, i]
          );

          if (sec.departmentIds && sec.departmentIds.length > 0) {
            for (const deptId of sec.departmentIds) {
              await client.query(
                'INSERT INTO section_departments (section_id, department_id) VALUES ($1, $2)',
                [section.id, deptId]
              );
            }
          }

          // Create section_content row
          await client.query(
            'INSERT INTO section_content (event_id, section_id) VALUES ($1, $2)',
            [event.id, section.id]
          );
        }
      }

      await client.query('COMMIT');
      // Notify every participant of the new event (best effort; never blocks).
      await notifyEventCreated(db, event.id, req.user.id);
      res.status(201).json({ id: event.id, success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id/notification-draft — email recipients and draft content
router.get('/:id/notification-draft', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid event id' });
    }

    const draft = await resolveEventNotificationDraft(db, eventId);
    if (!draft) return res.status(404).json({ error: 'Event not found' });

    res.json(draft);
  } catch (err) {
    console.error('Notification draft error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Event-level attachments ─────────────────────────────────────────────────

// POST /api/events/:id/files — upload event attachment(s)
router.post('/:id/files', requireAuth, denyAnalyst, upload.array('files', 10), async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid event id' });
    }

    const { rows: [event] } = await db.query('SELECT created_by_id FROM events WHERE id = $1', [eventId]);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Only the event creator or an admin/protocol user can attach files.
    if (event.created_by_id !== req.user.id && !['ADMIN', 'PROTOCOL'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to attach files to this event' });
    }

    const userRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    const uploaderName = userRow.rows[0]?.full_name || req.user.username;

    const uploaded = [];
    for (const f of (req.files || [])) {
      // Multipart filenames arrive latin1-decoded; re-decode as UTF-8 so
      // non-ASCII names (e.g. Georgian) are stored correctly.
      const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const { rows: [row] } = await db.query(
        `INSERT INTO event_files (event_id, original_name, mime_type, size, file_data, uploaded_by_id, uploaded_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, original_name, mime_type, size, created_at`,
        [eventId, originalName, f.mimetype, f.size, f.buffer, req.user.id, uploaderName]
      );
      uploaded.push(row);
    }

    res.status(201).json({ success: true, files: uploaded });
  } catch (err) {
    console.error('Event file upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id/files — list event attachment metadata
router.get('/:id/files', requireAuth, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const { rows } = await db.query(
      `SELECT id, original_name, mime_type, size, uploaded_by_id, uploaded_by_name, created_at
       FROM event_files WHERE event_id = $1 ORDER BY created_at`,
      [eventId]
    );
    res.json(rows);
  } catch (err) {
    console.error('List event files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id/files/:fileId/download — download an event attachment
router.get('/:id/files/:fileId/download', requireAuth, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const fileId = parseInt(req.params.fileId, 10);
    if (!Number.isInteger(eventId) || !Number.isInteger(fileId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const { rows: [file] } = await db.query(
      `SELECT original_name, mime_type, file_data FROM event_files WHERE id = $1 AND event_id = $2`,
      [fileId, eventId]
    );
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.file_data) return res.status(404).json({ error: 'File data not available' });

    res.set('Content-Type', file.mime_type || 'application/octet-stream');
    // RFC 5987: filename* carries the UTF-8 name; the ASCII filename is a fallback.
    const asciiName = file.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.set('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.send(file.file_data);
  } catch (err) {
    console.error('Event file download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id — event detail with sections
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [event] } = await db.query(
      `SELECT e.id, e.title, e.description, e.country_id, e.document_submitter_role,
              e.document_submitter_id, e.deputy_id, e.supervisor_id, e.curator_required,
              e.workflow_type,
              e.language, e.deadline_date, e.occasion, e.is_active,
              e.event_datetime,
              e.ended_at, e.status, e.created_at,
              c.name_en AS country_name, c.code AS country_code,
              ds.full_name AS document_submitter_name,
              ds.full_name_ka AS document_submitter_name_ka,
              dep.full_name AS deputy_name,
              dep.full_name_ka AS deputy_name_ka,
              sv.full_name AS supervisor_name,
              sv.full_name_ka AS supervisor_name_ka
       FROM events e
       JOIN countries c ON c.id = e.country_id
       JOIN users ds ON ds.id = e.document_submitter_id
       LEFT JOIN users dep ON dep.id = e.deputy_id
       LEFT JOIN users sv ON sv.id = e.supervisor_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: sections } = await db.query(
      `SELECT s.id, s.title, s.sort_order,
              array_agg(sd.department_id) AS department_ids
       FROM sections s
       LEFT JOIN section_departments sd ON sd.section_id = s.id
       WHERE s.event_id = $1
       GROUP BY s.id
       ORDER BY s.sort_order`,
      [req.params.id]
    );

    // Event date/time is restricted to the document owner, Protocol and Admin.
    const canSeeWhen = req.user.role === 'ADMIN' || req.user.role === 'PROTOCOL'
      || event.document_submitter_id === req.user.id;

    res.json({
      id: event.id,
      title: event.title,
      description: event.description,
      countryId: event.country_id,
      countryName: event.country_name,
      countryCode: event.country_code,
      documentSubmitterRole: event.document_submitter_role,
      documentSubmitterId: event.document_submitter_id,
      documentSubmitterName: event.document_submitter_name,
      documentSubmitterNameKa: event.document_submitter_name_ka,
      deputyId: event.deputy_id,
      deputyName: event.deputy_name,
      deputyNameKa: event.deputy_name_ka,
      supervisorId: event.supervisor_id,
      supervisorName: event.supervisor_name,
      supervisorNameKa: event.supervisor_name_ka,
      curatorRequired: event.curator_required,
      workflowType: event.workflow_type,
      language: event.language,
      deadlineDate: event.deadline_date,
      eventDateTime: canSeeWhen ? event.event_datetime : null,
      occasion: event.occasion,
      isActive: event.is_active,
      endedAt: event.ended_at,
      status: event.status,
      createdAt: event.created_at,
      sections: sections.map(s => ({
        id: s.id,
        title: s.title,
        sortOrder: s.sort_order,
        departmentIds: (s.department_ids || []).filter(Boolean),
      })),
    });
  } catch (err) {
    console.error('Get event error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/events/:id — edit event
router.patch('/:id', requireAuth, denyAnalyst, async (req, res) => {
  try {
    if (!canCreateEvent(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to edit events' });
    }

    const { title, language, deadlineDate, occasion, eventDateTime } = req.body;
    const sets = [];
    const params = [];
    let idx = 1;

    if (title !== undefined) { sets.push(`title = $${idx++}`); params.push(title); }
    if (language !== undefined) { sets.push(`language = $${idx++}`); params.push(language); }
    if (deadlineDate !== undefined) { sets.push(`deadline_date = $${idx++}`); params.push(deadlineDate || null); }
    if (eventDateTime !== undefined) { sets.push(`event_datetime = $${idx++}`); params.push(eventDateTime || null); }
    if (occasion !== undefined) { sets.push(`occasion = $${idx++}`); params.push(occasion || null); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    sets.push(`updated_at = now()`);
    params.push(req.params.id);

    await db.query(
      `UPDATE events SET ${sets.join(', ')} WHERE id = $${idx}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Edit event error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events/:id/sections — add section to existing event
router.post('/:id/sections', requireAuth, denyAnalyst, async (req, res) => {
  try {
    if (!canCreateEvent(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { title, departmentIds } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const eventId = req.params.id;

    // Get max sort order
    const { rows: [maxRow] } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM sections WHERE event_id = $1',
      [eventId]
    );

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [section] } = await client.query(
        'INSERT INTO sections (event_id, title, sort_order) VALUES ($1, $2, $3) RETURNING id',
        [eventId, title, maxRow.next_order]
      );

      if (departmentIds && departmentIds.length > 0) {
        for (const deptId of departmentIds) {
          await client.query(
            'INSERT INTO section_departments (section_id, department_id) VALUES ($1, $2)',
            [section.id, deptId]
          );
        }
      }

      await client.query(
        'INSERT INTO section_content (event_id, section_id) VALUES ($1, $2)',
        [eventId, section.id]
      );

      await client.query('COMMIT');
      res.status(201).json({ id: section.id, success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Add section error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events/:id/end — end an event
router.post('/:id/end', requireAuth, denyAnalyst, async (req, res) => {
  try {
    if (!canEndEvent(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to end events' });
    }

    await db.query(
      `UPDATE events SET is_active = false, ended_at = now(), status = 'ARCHIVED', updated_at = now()
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('End event error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
