const express = require('express');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');

const router = express.Router();

// GET /api/templates — list templates visible to the current user
// Returns: default templates + templates created by the current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: templates } = await db.query(
      `SELECT et.id, et.name, et.document_submitter_role, et.curator_required,
              et.is_default, et.created_at, et.created_by_id,
              COALESCE(u.full_name, 'System') AS created_by_name,
              u.full_name_ka AS created_by_name_ka
       FROM event_templates et
       LEFT JOIN users u ON u.id = et.created_by_id
       WHERE et.is_default = true OR et.created_by_id = $1
       ORDER BY et.is_default DESC, et.name`,
      [req.user.id]
    );

    // Enrich with sections
    const result = [];
    for (const t of templates) {
      const { rows: sections } = await db.query(
        `SELECT ets.id, ets.title, ets.sort_order,
                array_agg(etsd.department_id) AS department_ids
         FROM event_template_sections ets
         LEFT JOIN event_template_section_departments etsd ON etsd.template_section_id = ets.id
         WHERE ets.template_id = $1
         GROUP BY ets.id
         ORDER BY ets.sort_order`,
        [t.id]
      );

      result.push({
        id: t.id,
        name: t.name,
        documentSubmitterRole: t.document_submitter_role,
        curatorRequired: t.curator_required,
        isDefault: t.is_default,
        createdAt: t.created_at,
        createdById: t.created_by_id,
        createdByName: t.created_by_name,
        createdByNameKa: t.created_by_name_ka,
        sections: sections.map(s => ({
          id: s.id,
          title: s.title,
          sortOrder: s.sort_order,
          departmentIds: (s.department_ids || []).filter(Boolean),
        })),
      });
    }

    res.json(result);
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/templates — create template
router.post('/', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { name, documentSubmitterRole, curatorRequired, sections } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [template] } = await client.query(
        `INSERT INTO event_templates (name, created_by_id, document_submitter_role, curator_required, is_default)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
        [name, req.user.id, documentSubmitterRole || 'DEPUTY', curatorRequired || false]
      );

      if (sections && sections.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const { rows: [tplSec] } = await client.query(
            `INSERT INTO event_template_sections (template_id, title, sort_order)
             VALUES ($1, $2, $3) RETURNING id`,
            [template.id, sec.title, sec.sortOrder || i]
          );

          if (sec.departmentIds && sec.departmentIds.length > 0) {
            for (const deptId of sec.departmentIds) {
              await client.query(
                `INSERT INTO event_template_section_departments (template_section_id, department_id)
                 VALUES ($1, $2)`,
                [tplSec.id, deptId]
              );
            }
          }
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ id: template.id, success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create template error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/templates/:id — update own template (not default)
router.put('/:id', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { name, documentSubmitterRole, curatorRequired, sections } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Verify the template exists, belongs to the user and is not a default.
      const { rows: [existing] } = await client.query(
        `SELECT id FROM event_templates
         WHERE id = $1 AND created_by_id = $2 AND is_default = false
         FOR UPDATE`,
        [req.params.id, req.user.id]
      );
      if (!existing) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Template not found or cannot be edited' });
      }

      await client.query(
        `UPDATE event_templates
         SET name = $1, document_submitter_role = $2, curator_required = $3, updated_at = now()
         WHERE id = $4`,
        [name, documentSubmitterRole || 'DEPUTY', curatorRequired || false, existing.id]
      );

      // Replace sections wholesale (cascade removes section departments).
      await client.query(
        'DELETE FROM event_template_sections WHERE template_id = $1',
        [existing.id]
      );

      if (sections && sections.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const { rows: [tplSec] } = await client.query(
            `INSERT INTO event_template_sections (template_id, title, sort_order)
             VALUES ($1, $2, $3) RETURNING id`,
            [existing.id, sec.title, sec.sortOrder || i]
          );

          if (sec.departmentIds && sec.departmentIds.length > 0) {
            for (const deptId of sec.departmentIds) {
              await client.query(
                `INSERT INTO event_template_section_departments (template_section_id, department_id)
                 VALUES ($1, $2)`,
                [tplSec.id, deptId]
              );
            }
          }
        }
      }

      await client.query('COMMIT');
      res.json({ id: existing.id, success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Update template error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/templates/:id — delete own template (not default)
router.delete('/:id', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM event_templates WHERE id = $1 AND created_by_id = $2 AND is_default = false',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found or cannot be deleted' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete template error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
