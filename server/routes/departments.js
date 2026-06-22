const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/departments
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, name_en, is_external FROM departments ORDER BY is_external, name'
    );
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      nameEn: r.name_en,
      isExternal: r.is_external,
    })));
  } catch (err) {
    console.error('List departments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/departments (admin only)
router.post('/', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { name, nameEn, isExternal } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { rows } = await db.query(
      'INSERT INTO departments (name, name_en, is_external) VALUES ($1, $2, $3) RETURNING id',
      [name, nameEn || null, isExternal || false]
    );
    res.status(201).json({ id: rows[0].id, success: true });
  } catch (err) {
    console.error('Create department error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/departments/:id (admin only) — update names / type
router.put('/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { name, nameEn, isExternal } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const result = await db.query(
      'UPDATE departments SET name = $1, name_en = $2, is_external = $3, updated_at = now() WHERE id = $4',
      [name, nameEn || null, isExternal || false, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Department not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Update department error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/departments/grouped — departments grouped by deputy for picker UI
router.get('/grouped', requireAuth, async (req, res) => {
  try {
    const { rows: depts } = await db.query(
      'SELECT id, name, name_en, is_external FROM departments ORDER BY name_en'
    );

    // Get deputy → department mapping through direct deputy-department links
    const { rows: links } = await db.query(
      `SELECT ddl.deputy_id, u.full_name AS deputy_name,
              ddl.department_id
       FROM deputy_department_links ddl
       JOIN users u ON u.id = ddl.deputy_id
       ORDER BY u.full_name, ddl.department_id`
    );

    // Group departments by deputy
    const deputyMap = new Map();
    const assignedDeptIds = new Set();
    for (const l of links) {
      if (!deputyMap.has(l.deputy_id)) {
        deputyMap.set(l.deputy_id, { deputyName: l.deputy_name, departmentIds: [] });
      }
      deputyMap.get(l.deputy_id).departmentIds.push(l.department_id);
      assignedDeptIds.add(l.department_id);
    }

    const deputies = Array.from(deputyMap.values());

    // Departments not assigned to any deputy
    const unassigned = depts
      .filter(d => !assignedDeptIds.has(d.id))
      .map(d => d.id);

    res.json({
      departments: depts.map(d => ({
        id: d.id,
        name: d.name,
        nameEn: d.name_en,
        isExternal: d.is_external,
      })),
      deputies,
      unassignedDepartmentIds: unassigned,
    });
  } catch (err) {
    console.error('Grouped departments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
