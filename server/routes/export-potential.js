/**
 * Export potential — admin-only preview of the precomputed ratings.
 *
 * No computation at request time: the handlers serve the result files the
 * pipeline wrote (plus the invented sample partner) and the method's
 * configuration, which the page renders on its methodology panel. Derived
 * figures only (scores, growth rates, shares); no raw trade records are
 * exposed, in line with UN Comtrade's publishing terms.
 */
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const results = require('../export-potential/results');
const { loadConfig } = require('../export-potential/scoring');

const router = express.Router();
const adminOnly = [requireAuth, requireRole('ADMIN')];

// GET /api/export-potential/countries — partners with a result file
router.get('/countries', ...adminOnly, (req, res) => {
  try {
    res.json(results.listCountries());
  } catch (err) {
    console.error('export-potential countries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export-potential/countries/:code — one partner's full result
router.get('/countries/:code', ...adminOnly, (req, res) => {
  try {
    const r = results.getCountry(req.params.code);
    if (!r) return res.status(404).json({ error: 'No results for this country' });
    res.json(r);
  } catch (err) {
    console.error('export-potential country error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export-potential/config — the method's thresholds and weights
router.get('/config', ...adminOnly, (req, res) => {
  try {
    res.json(loadConfig());
  } catch (err) {
    console.error('export-potential config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
