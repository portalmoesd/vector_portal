const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users — list all users (admin only)
router.get('/', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.role,
              u.department_id, u.is_external, u.entity_name, u.must_change_password,
              d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY u.full_name`
    );
    res.json(rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      username: r.username,
      email: r.email,
      role: r.role,
      departmentId: r.department_id,
      departmentName: r.department_name,
      isExternal: r.is_external,
      entityName: r.entity_name,
      mustChangePassword: r.must_change_password,
    })));
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users — create user (admin only)
router.post('/', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { fullName, username, email, password, role, departmentId, isExternal, entityName, countryIds } = req.body;
    if (!fullName || !username || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // External users have an entity name and no department; internal users
    // have a department and no entity. Normalise here so the DB never
    // ends up with a stale department_id on an external user (or vice versa).
    const ext = !!isExternal;
    const dept = ext ? null : (departmentId || null);
    const entity = ext ? (entityName?.trim() || null) : null;

    const hash = await bcrypt.hash(password, 10);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO users (full_name, username, email, password_hash, role, department_id, is_external, entity_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [fullName, username, email, hash, role, dept, ext, entity]
      );

      const userId = rows[0].id;

      // Assign countries for Collaborator/Super-Collaborator
      if (Array.isArray(countryIds) && countryIds.length > 0) {
        for (const cId of countryIds) {
          await client.query(
            'INSERT INTO country_assignments (user_id, country_id) VALUES ($1, $2)',
            [userId, cId]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ id: userId, success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/users/:id — update user (admin only)
router.patch('/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { fullName, email, role, departmentId, isExternal, entityName, password, countryIds } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    if (fullName !== undefined) { sets.push(`full_name = $${idx++}`); params.push(fullName); }
    if (email !== undefined) { sets.push(`email = $${idx++}`); params.push(email); }
    if (role !== undefined) { sets.push(`role = $${idx++}`); params.push(role); }

    // Department / entity / external are coupled: external users have an
    // entity name and no department, internal users have a department and
    // no entity. When isExternal is in the payload, normalise all three
    // together so the DB never stores both at once.
    if (isExternal !== undefined) {
      const ext = !!isExternal;
      sets.push(`is_external = $${idx++}`); params.push(ext);
      if (ext) {
        sets.push(`department_id = $${idx++}`); params.push(null);
        sets.push(`entity_name = $${idx++}`); params.push(entityName?.trim() || null);
      } else {
        sets.push(`department_id = $${idx++}`); params.push(departmentId || null);
        sets.push(`entity_name = $${idx++}`); params.push(null);
      }
    } else if (departmentId !== undefined) {
      sets.push(`department_id = $${idx++}`); params.push(departmentId || null);
    }

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      sets.push(`password_hash = $${idx++}`);
      params.push(hash);
      sets.push(`must_change_password = true`);
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(userId);
        await client.query(
          `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`,
          params
        );
      }

      // Update country assignments if provided
      if (countryIds !== undefined) {
        await client.query('DELETE FROM country_assignments WHERE user_id = $1', [userId]);
        if (Array.isArray(countryIds) && countryIds.length > 0) {
          for (const cId of countryIds) {
            await client.query(
              'INSERT INTO country_assignments (user_id, country_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [userId, cId]
            );
          }
        }
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:id/countries — get country assignments for a user
router.get('/:id/countries', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name_en, c.code
       FROM country_assignments ca
       JOIN countries c ON c.id = ca.country_id
       WHERE ca.user_id = $1
       ORDER BY c.name_en`,
      [req.params.id]
    );
    res.json(rows.map(r => ({ id: r.id, nameEn: r.name_en, code: r.code })));
  } catch (err) {
    console.error('Get user countries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
