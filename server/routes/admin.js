const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Deputy-Supervisor Links ──────────────────────────────────────────────────

// GET /api/admin/deputy-supervisor-links
router.get('/deputy-supervisor-links', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT dsl.id, dsl.deputy_id, dsl.supervisor_id,
              d.full_name AS deputy_name, d.full_name_ka AS deputy_name_ka,
              s.full_name AS supervisor_name, s.full_name_ka AS supervisor_name_ka,
              dept.name_en AS supervisor_department
       FROM deputy_supervisor_links dsl
       JOIN users d ON d.id = dsl.deputy_id
       JOIN users s ON s.id = dsl.supervisor_id
       LEFT JOIN departments dept ON dept.id = s.department_id
       ORDER BY d.full_name, s.full_name`
    );
    res.json(rows.map(r => ({
      id: r.id,
      deputyId: r.deputy_id,
      deputyName: r.deputy_name,
      deputyNameKa: r.deputy_name_ka,
      supervisorId: r.supervisor_id,
      supervisorName: r.supervisor_name,
      supervisorNameKa: r.supervisor_name_ka,
      supervisorDepartment: r.supervisor_department,
    })));
  } catch (err) {
    console.error('List links error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/deputy-supervisor-links
router.post('/deputy-supervisor-links', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { deputyId, supervisorId } = req.body;
    if (!deputyId || !supervisorId) {
      return res.status(400).json({ error: 'deputyId and supervisorId are required' });
    }

    // Validate roles
    const { rows: [deputy] } = await db.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'DEPUTY'", [deputyId]
    );
    if (!deputy) return res.status(422).json({ error: 'Invalid deputy user' });

    const { rows: [supervisor] } = await db.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'SUPERVISOR'", [supervisorId]
    );
    if (!supervisor) return res.status(422).json({ error: 'Invalid supervisor user' });

    const { rows } = await db.query(
      `INSERT INTO deputy_supervisor_links (deputy_id, supervisor_id)
       VALUES ($1, $2) RETURNING id`,
      [deputyId, supervisorId]
    );

    res.status(201).json({ id: rows[0].id, success: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This link already exists' });
    }
    console.error('Create link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/deputy-supervisor-links/:id
router.delete('/deputy-supervisor-links/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM deputy_supervisor_links WHERE id = $1', [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Filtered Supervisor Dropdown ─────────────────────────────────────────────

// GET /api/admin/supervisors?deputy_id=X — get supervisors linked to a deputy
router.get('/supervisors', requireAuth, async (req, res) => {
  try {
    const { deputy_id } = req.query;
    if (!deputy_id) return res.status(400).json({ error: 'deputy_id is required' });

    const { role, id: userId } = req.user;
    const isUnrestricted = role === 'ADMIN' || role === 'PROTOCOL';

    let query, params;
    if (isUnrestricted) {
      query = `SELECT u.id, u.full_name, u.full_name_ka, u.department_id, d.name_en AS department_name
               FROM deputy_supervisor_links dsl
               JOIN users u ON u.id = dsl.supervisor_id
               LEFT JOIN departments d ON d.id = u.department_id
               WHERE dsl.deputy_id = $1
               ORDER BY u.full_name`;
      params = [deputy_id];
    } else {
      // Non-admin users can only select themselves as responsible supervisor
      query = `SELECT u.id, u.full_name, u.full_name_ka, u.department_id, d.name_en AS department_name
               FROM deputy_supervisor_links dsl
               JOIN users u ON u.id = dsl.supervisor_id
               LEFT JOIN departments d ON d.id = u.department_id
               WHERE dsl.deputy_id = $1 AND dsl.supervisor_id = $2
               ORDER BY u.full_name`;
      params = [deputy_id, userId];
    }

    const { rows } = await db.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentId: r.department_id,
      departmentName: r.department_name,
    })));
  } catch (err) {
    console.error('Filter supervisors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Department Hierarchy ─────────────────────────────────────────────────────

// GET /api/admin/department-hierarchy — shows Dept → Supervisor(s) → SC(s) → Collaborator(s)
router.get('/department-hierarchy', requireAuth, async (req, res) => {
  try {
    const { rows: depts } = await db.query(
      `SELECT id, name, name_en, is_external FROM departments ORDER BY name_en`
    );
    const { rows: users } = await db.query(
      `SELECT id, full_name, full_name_ka, email, role, department_id
       FROM users
       WHERE department_id IS NOT NULL
         AND role IN ('SUPERVISOR', 'SUPER_COLLABORATOR', 'COLLABORATOR')
       ORDER BY role, full_name`
    );

    // Group users by department
    const byDept = {};
    for (const u of users) {
      if (!byDept[u.department_id]) byDept[u.department_id] = [];
      byDept[u.department_id].push({
        id: u.id,
        fullName: u.full_name,
        fullNameKa: u.full_name_ka,
        email: u.email,
        role: u.role,
      });
    }

    // Also fetch deputy links to show which deputy oversees which departments
    const { rows: links } = await db.query(
      `SELECT dsl.deputy_id, dsl.supervisor_id, d.full_name AS deputy_name, s.department_id
       FROM deputy_supervisor_links dsl
       JOIN users d ON d.id = dsl.deputy_id
       JOIN users s ON s.id = dsl.supervisor_id
       WHERE s.department_id IS NOT NULL`
    );

    // Map department → deputy names
    const deptDeputies = {};
    for (const l of links) {
      if (!deptDeputies[l.department_id]) deptDeputies[l.department_id] = new Set();
      deptDeputies[l.department_id].add(l.deputy_name);
    }

    const hierarchy = depts
      .filter(d => byDept[d.id] && byDept[d.id].length > 0)
      .map(d => {
        const members = byDept[d.id] || [];
        return {
          departmentId: d.id,
          departmentName: d.name,
          departmentNameEn: d.name_en,
          isExternal: d.is_external,
          deputies: Array.from(deptDeputies[d.id] || []),
          supervisors: members.filter(u => u.role === 'SUPERVISOR'),
          superCollaborators: members.filter(u => u.role === 'SUPER_COLLABORATOR'),
          collaborators: members.filter(u => u.role === 'COLLABORATOR'),
        };
      });

    res.json(hierarchy);
  } catch (err) {
    console.error('Department hierarchy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Deputies list (for dropdowns) ────────────────────────────────────────────

router.get('/deputies', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, full_name_ka, department_id, is_minister
       FROM users WHERE role = 'DEPUTY' ORDER BY is_minister DESC, full_name`
    );
    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentId: r.department_id,
      isMinister: r.is_minister,
    })));
  } catch (err) {
    console.error('List deputies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Minister (for the create-event Document Submitter picker) ────────────────

// GET /api/admin/minister — the single MINISTER user, or null if none exists.
router.get('/minister', requireAuth, async (req, res) => {
  try {
    const { rows: [m] } = await db.query(
      `SELECT id, full_name, full_name_ka FROM users WHERE role = 'MINISTER' ORDER BY id LIMIT 1`
    );
    res.json(m ? { id: m.id, fullName: m.full_name, fullNameKa: m.full_name_ka } : null);
  } catch (err) {
    console.error('Get minister error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── All supervisors list (for dropdowns) ────────────────────────────────────

router.get('/all-supervisors', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.role = 'SUPERVISOR'
       ORDER BY u.full_name`
    );
    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentName: r.department_name,
    })));
  } catch (err) {
    console.error('List all supervisors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Role-aware linked endpoints (for event creation dropdowns) ──────────────

// GET /api/admin/linked-deputies — deputies the current user can assign as DS
router.get('/linked-deputies', requireAuth, async (req, res) => {
  try {
    const { role, id, departmentId } = req.user;
    let rows;

    if (role === 'ADMIN' || role === 'PROTOCOL') {
      ({ rows } = await db.query(
        `SELECT id, full_name, full_name_ka, department_id, is_minister FROM users WHERE role = 'DEPUTY' ORDER BY is_minister DESC, full_name`
      ));
    } else if (role === 'DEPUTY') {
      // Only themselves
      ({ rows } = await db.query(
        `SELECT id, full_name, full_name_ka, department_id, is_minister FROM users WHERE id = $1`, [id]
      ));
    } else if (role === 'SUPERVISOR') {
      // Deputies linked to this supervisor
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, u.department_id, u.is_minister
         FROM deputy_supervisor_links dsl
         JOIN users u ON u.id = dsl.deputy_id
         WHERE dsl.supervisor_id = $1
         ORDER BY u.is_minister DESC, u.full_name`, [id]
      ));
    } else if (role === 'SUPER_COLLABORATOR') {
      // Deputies linked to supervisors in the same department
      ({ rows } = await db.query(
        `SELECT DISTINCT u.id, u.full_name, u.department_id, u.is_minister
         FROM deputy_supervisor_links dsl
         JOIN users u ON u.id = dsl.deputy_id
         JOIN users s ON s.id = dsl.supervisor_id
         WHERE s.department_id = $1
         ORDER BY u.is_minister DESC, u.full_name`, [departmentId]
      ));
    } else {
      rows = [];
    }

    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentId: r.department_id,
      isMinister: r.is_minister,
    })));
  } catch (err) {
    console.error('Linked deputies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/linked-supervisors — supervisors the current user can assign as DS
router.get('/linked-supervisors', requireAuth, async (req, res) => {
  try {
    const { role, id, departmentId } = req.user;
    let rows;

    if (role === 'ADMIN' || role === 'PROTOCOL') {
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.role = 'SUPERVISOR'
         ORDER BY u.full_name`
      ));
    } else if (role === 'DEPUTY') {
      // Supervisors linked to this deputy
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM deputy_supervisor_links dsl
         JOIN users u ON u.id = dsl.supervisor_id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE dsl.deputy_id = $1
         ORDER BY u.full_name`, [id]
      ));
    } else if (role === 'SUPERVISOR') {
      // Only themselves
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = $1`, [id]
      ));
    } else if (role === 'SUPER_COLLABORATOR') {
      // Supervisors in the same department
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.role = 'SUPERVISOR' AND u.department_id = $1
         ORDER BY u.full_name`, [departmentId]
      ));
    } else {
      rows = [];
    }

    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentName: r.department_name,
    })));
  } catch (err) {
    console.error('Linked supervisors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/linked-super-collaborators — SCs the current user can assign as DS
router.get('/linked-super-collaborators', requireAuth, async (req, res) => {
  try {
    const { role, id, departmentId } = req.user;
    let rows;

    if (role === 'ADMIN' || role === 'PROTOCOL') {
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.role = 'SUPER_COLLABORATOR'
         ORDER BY u.full_name`
      ));
    } else if (role === 'DEPUTY') {
      // SCs in departments of linked supervisors
      ({ rows } = await db.query(
        `SELECT DISTINCT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.role = 'SUPER_COLLABORATOR'
           AND u.department_id IN (
             SELECT s.department_id FROM deputy_supervisor_links dsl
             JOIN users s ON s.id = dsl.supervisor_id
             WHERE dsl.deputy_id = $1 AND s.department_id IS NOT NULL
           )
         ORDER BY u.full_name`, [id]
      ));
    } else if (role === 'SUPERVISOR') {
      // SCs in the same department
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.role = 'SUPER_COLLABORATOR' AND u.department_id = $1
         ORDER BY u.full_name`, [departmentId]
      ));
    } else if (role === 'SUPER_COLLABORATOR') {
      // Only themselves
      ({ rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = $1`, [id]
      ));
    } else {
      rows = [];
    }

    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentName: r.department_name,
    })));
  } catch (err) {
    console.error('Linked super-collaborators error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── All super-collaborators list (for dropdowns) ────────────────────────────

router.get('/all-super-collaborators', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.role = 'SUPER_COLLABORATOR'
       ORDER BY u.full_name`
    );
    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      fullNameKa: r.full_name_ka,
      departmentName: r.department_name,
    })));
  } catch (err) {
    console.error('List all super-collaborators error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
