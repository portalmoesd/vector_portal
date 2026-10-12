/**
 * Country profiles — admin-only pages fed from the stat_* tables.
 *
 * No external call happens at request time: the handlers read what the sync
 * (server/country-profiles/sync.js) stored, and every figure carries its
 * data year, source name, source URL and retrieval date so the page can
 * attribute it. The weekly schedule and the admin "Sync now" trigger live
 * here too, following the tourism/trade refresh pattern in statistics.js.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runSync, isRunning } = require('../country-profiles/sync');
const { SOURCE } = require('../country-profiles/worldbank');

const router = express.Router();
const adminOnly = [requireAuth, requireRole('ADMIN')];

const CHART_SERIES = ['NY.GDP.MKTP.CD', 'SP.POP.TOTL'];
const CHART_YEARS = 20;

function countryRow(r) {
  return {
    iso3: r.iso3,
    iso2: r.iso2,
    slug: r.slug,
    name: r.name,
    nameKa: r.name_ka || null,
    region: { id: r.region_id, name: r.region_name },
    incomeLevel: { id: r.income_id, name: r.income_name },
    capital: r.capital,
  };
}

// Georgian names come from the portal's own country list (matched on ISO2)
// purely as a display translation; the source's English name stays canonical.
const COUNTRY_SELECT = `
  SELECT sc.*, pc.name_ka
  FROM stat_countries sc
  LEFT JOIN countries pc ON pc.code = sc.iso2`;

async function lastRun() {
  const { rows } = await db.query(
    `SELECT id, trigger, started_at, finished_at, status, ok_count, failed_count
     FROM stat_sync_runs WHERE source_id = $1 AND status <> 'running' ORDER BY started_at DESC LIMIT 1`,
    [SOURCE.id]
  );
  return rows[0] ? runRow(rows[0]) : null;
}

function runRow(r) {
  return {
    id: r.id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, okCount: r.ok_count, failedCount: r.failed_count, log: r.log,
  };
}

// GET /api/country-profiles/countries — every economy plus the region list
router.get('/countries', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(`${COUNTRY_SELECT} ORDER BY sc.name`);
    const regions = [];
    const seen = new Set();
    for (const r of rows) {
      if (r.region_id && !seen.has(r.region_id)) { seen.add(r.region_id); regions.push({ id: r.region_id, name: r.region_name }); }
    }
    regions.sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      source: SOURCE,
      lastSync: await lastRun(),
      regions,
      countries: rows.map(countryRow),
    });
  } catch (err) {
    console.error('country-profiles countries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/country-profiles/countries/:slug — one profile (slug or ISO3)
router.get('/countries/:slug', ...adminOnly, async (req, res) => {
  try {
    const key = String(req.params.slug || '').trim();
    if (!/^[a-z0-9-]{1,80}$/i.test(key)) return res.status(404).json({ error: 'Country not found' });
    const { rows: [c] } = await db.query(
      `${COUNTRY_SELECT} WHERE sc.slug = $1 OR sc.iso3 = $2 LIMIT 1`,
      [key.toLowerCase(), key.toUpperCase()]
    );
    if (!c) return res.status(404).json({ error: 'Country not found' });

    // Every configured indicator, with the latest stored value (if any).
    const { rows: ind } = await db.query(
      `SELECT i.code, i.name, i.unit, i.section, i.display_order, i.source_url AS indicator_url,
              o.year, o.value, o.source_name, o.source_url, o.retrieved_at
       FROM stat_indicators i
       LEFT JOIN LATERAL (
         SELECT year, value, source_name, source_url, retrieved_at
         FROM stat_observations o
         WHERE o.indicator_code = i.code AND o.iso3 = $1
         ORDER BY year DESC LIMIT 1
       ) o ON true
       WHERE i.source_id = $2
       ORDER BY i.display_order`,
      [c.iso3, SOURCE.id]
    );
    const indicators = ind.map((r) => ({
      code: r.code,
      name: r.name,
      unit: r.unit,
      section: r.section,
      value: r.value == null ? null : Number(r.value),
      year: r.year == null ? null : Number(r.year),
      sourceName: r.source_name || SOURCE.name,
      sourceUrl: r.source_url || r.indicator_url || SOURCE.url,
      retrievedAt: r.retrieved_at,
    }));

    const fromYear = new Date().getUTCFullYear() - CHART_YEARS;
    const { rows: ser } = await db.query(
      `SELECT indicator_code, year, value FROM stat_observations
       WHERE iso3 = $1 AND indicator_code = ANY($2::text[]) AND year >= $3
       ORDER BY indicator_code, year`,
      [c.iso3, CHART_SERIES, fromYear]
    );
    const series = {};
    for (const code of CHART_SERIES) series[code] = [];
    for (const r of ser) series[r.indicator_code].push({ year: Number(r.year), value: Number(r.value) });

    res.json({
      source: SOURCE,
      lastSync: await lastRun(),
      country: {
        ...countryRow(c),
        sourceUrl: c.source_url,
        retrievedAt: c.retrieved_at,
      },
      indicators,
      series,
    });
  } catch (err) {
    console.error('country-profiles country error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/country-profiles/status — recent sync runs for the admin panel
router.get('/status', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, trigger, started_at, finished_at, status, ok_count, failed_count, log
       FROM stat_sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 5`,
      [SOURCE.id]
    );
    const { rows: [counts] } = await db.query(
      `SELECT (SELECT count(*)::int FROM stat_countries WHERE source_id = $1) AS countries,
              (SELECT count(*)::int FROM stat_observations WHERE source_id = $1) AS observations`,
      [SOURCE.id]
    );
    res.json({ source: SOURCE, running: isRunning(), countries: counts.countries, observations: counts.observations, runs: rows.map(runRow) });
  } catch (err) {
    console.error('country-profiles status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/country-profiles/sync — start a sync in the background
router.post('/sync', ...adminOnly, (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A sync is already running' });
  startSync('admin');
  res.status(202).json({ started: true });
});

function startSync(trigger) {
  const log = (m) => console.log(`country-profiles: ${m}`);
  runSync({ db, trigger, log }).catch((err) => console.error('country-profiles: sync crashed:', err.message));
}

// Weekly refresh on Mondays at 10:20 Tbilisi (06:20 UTC, Georgia has no DST),
// anchored the same way as the tourism and trade schedulers. WDI updates a
// few times a year, so weekly is plenty. A boot check fills an empty database
// once the schema migration in index.js has had time to finish.
function scheduleWeeklySync() {
  const UTC_HOUR = 6, UTC_MINUTE = 20, MONDAY = 1;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), UTC_HOUR, UTC_MINUTE, 0, 0));
  while (next <= now || next.getUTCDay() !== MONDAY) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  console.log(`country-profiles: next scheduled sync in ${(delay / 3600000).toFixed(1)}h (${next.toISOString()}, Monday 10:20 Tbilisi)`);
  setTimeout(() => {
    startSync('scheduled');
    setInterval(() => startSync('scheduled'), 7 * 24 * 60 * 60 * 1000);
  }, delay);
}

async function bootCheck() {
  try {
    const { rows: [{ count }] } = await db.query('SELECT count(*)::int AS count FROM stat_countries');
    if (count === 0) { console.log('country-profiles: no data yet, running the first sync'); startSync('boot'); }
  } catch (err) {
    console.warn('country-profiles: boot check skipped:', err.message);
  }
}

if (process.env.NODE_ENV !== 'test' && !process.env.COUNTRY_PROFILES_NO_SCHEDULE) {
  scheduleWeeklySync();
  setTimeout(bootCheck, 30_000);
}

module.exports = router;
