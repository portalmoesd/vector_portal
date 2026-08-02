const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/countries
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name_en, name_ka, code FROM countries ORDER BY name_en'
    );
    res.json(rows.map(r => ({
      id: r.id,
      nameEn: r.name_en,
      nameKa: r.name_ka,
      code: r.code,
    })));
  } catch (err) {
    console.error('List countries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
