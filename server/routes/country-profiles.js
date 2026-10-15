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
const { SOURCE, INDICATORS } = require('../country-profiles/worldbank');
const factbook = require('../country-profiles/factbook');
const products = require('../country-profiles/comtrade-products');
const { productName } = require('../export-potential/results');

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
       WHERE i.source_id = $2 AND i.code = ANY($3::text[])
       ORDER BY i.display_order`,
      [c.iso3, SOURCE.id, INDICATORS.map((i) => i.code)]
    );
    const compilerOf = new Map(INDICATORS.map((i) => [i.code, i.compiler || null]));
    const indicators = ind.map((r) => ({
      code: r.code,
      name: r.name,
      unit: r.unit,
      section: r.section,
      compiler: compilerOf.get(r.code) || null,
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

    // Main traded products (UN Comtrade, top HS4 shares), per flow.
    const { rows: prodRows } = await db.query(
      `SELECT flow, year, rank, hs4, share, source_name, source_url, retrieved_at
       FROM stat_country_products WHERE iso3 = $1 ORDER BY flow, rank`,
      [c.iso3]
    );
    const mainProducts = {};
    for (const r of prodRows) {
      if (!mainProducts[r.flow]) mainProducts[r.flow] = { year: Number(r.year), sourceName: r.source_name, sourceUrl: r.source_url, retrievedAt: r.retrieved_at, items: [] };
      mainProducts[r.flow].items.push({ rank: Number(r.rank), hs4: r.hs4, name: productName(r.hs4), share: Number(r.share) });
    }

    // Descriptive text (Factbook snapshot), grouped by section in display order.
    const { rows: txt } = await db.query(
      `SELECT section, field, display_order, content, source_name, source_url, data_date, retrieved_at, edited_at
       FROM stat_country_texts WHERE iso3 = $1 ORDER BY section, display_order`,
      [c.iso3]
    );
    // Grouped by the page section each row is shown in (see DISPLAY in
    // factbook.js); `field` is the source's name, `label` what the page shows.
    const texts = { sections: {}, source: null };
    for (const r of txt) {
      // The keep rules are applied here too, so rows left over from an
      // earlier, wider snapshot never reach the page.
      if (!factbook.isFieldKept(r.section, r.field)) continue;
      const content = factbook.filterContent(r.section, r.field, r.content);
      if (!content) continue;
      const { page, label } = factbook.displayPlacement(r.section, r.field);
      if (!page) continue;
      if (!texts.sections[page]) texts.sections[page] = [];
      texts.sections[page].push({ section: r.section, field: r.field, label, content, edited: !!r.edited_at });
      if (!texts.source) {
        texts.source = { name: r.source_name, url: r.source_url, dataDate: r.data_date, retrievedAt: r.retrieved_at, discontinued: '2026-02-04' };
      }
    }

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
      mainProducts,
      texts,
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
    const { rows: [fbRow] } = await db.query(
      `SELECT (SELECT count(*)::int FROM stat_country_texts) AS fields,
              (SELECT count(DISTINCT iso3)::int FROM stat_country_texts) AS countries,
              (SELECT count(*)::int FROM stat_country_texts WHERE edited_at IS NOT NULL) AS edited`
    );
    const fbMeta = factbook.readMeta();
    const { rows: [prod] } = await db.query(
      `SELECT count(DISTINCT iso3)::int AS countries, count(*)::int AS rows, min(year)::int AS min_year, max(year)::int AS max_year FROM stat_country_products`
    );
    const { rows: prodRuns } = await db.query(
      `SELECT id, trigger, started_at, finished_at, status, ok_count, failed_count, log
       FROM stat_sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [products.SOURCE.id]
    );
    res.json({
      source: SOURCE, running: isRunning(), countries: counts.countries, observations: counts.observations, runs: rows.map(runRow),
      factbook: { ...fbRow, snapshotDate: fbMeta && fbMeta.snapshotDate, extractedAt: fbMeta && fbMeta.extractedAt, pending: await factbook.needsImport(db) },
      products: { ...prod, keyConfigured: products.hasKey(), running: products.isRunning(), lastRun: prodRuns[0] ? runRow(prodRuns[0]) : null },
    });
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

// POST /api/country-profiles/import-factbook — (re)load the committed
// Factbook snapshot into the database now. Idempotent; edited rows are kept.
// Runs inline: a full load is a few seconds.
let factbookImportRunning = false;
router.post('/import-factbook', ...adminOnly, async (req, res) => {
  if (factbookImportRunning) return res.status(409).json({ error: 'A Factbook import is already running' });
  factbookImportRunning = true;
  try {
    const r = await factbook.importFactbook(db, { log: (m) => console.log(`country-profiles: ${m}`), trigger: 'admin' });
    res.json({ ok: true, rows: r.rows, countries: r.countries, edited: r.edited });
  } catch (err) {
    console.error('country-profiles factbook import error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    factbookImportRunning = false;
  }
});

// POST /api/country-profiles/sync-products — start a Comtrade products sync
router.post('/sync-products', ...adminOnly, (req, res) => {
  if (!products.hasKey()) return res.status(409).json({ error: 'COMTRADE_API_KEY is not set on the server' });
  if (products.isRunning()) return res.status(409).json({ error: 'A products sync is already running' });
  startProductsSync('admin');
  res.status(202).json({ started: true });
});

function startProductsSync(trigger) {
  const log = (m) => console.log(`country-products: ${m}`);
  let budget = Infinity;
  try { budget = require('../export-potential/scoring').loadConfig().pipeline.comtrade.dailyCallBudget || Infinity; } catch (_) { /* default */ }
  products.syncProducts({ db, trigger, log, budget }).catch((err) => console.error('country-products: sync crashed:', err.message));
}

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
    if (count === 0) {
      console.log('country-profiles: no data yet, running the first sync');
      startSync('boot');
    } else {
      // A deploy that adds an indicator should not wait for the weekly run:
      // pull just the configured indicators the database has no row for.
      const { rows } = await db.query('SELECT code FROM stat_indicators WHERE source_id = $1', [SOURCE.id]);
      const have = new Set(rows.map((r) => r.code));
      const missing = INDICATORS.map((i) => i.code).filter((c) => !have.has(c));
      if (missing.length) {
        console.log(`country-profiles: ${missing.length} configured indicator(s) not synced yet (${missing.join(', ')}), pulling them`);
        runSync({ db, trigger: 'boot', log: (m) => console.log(`country-profiles: ${m}`), indicators: missing })
          .catch((err) => console.error('country-profiles: sync crashed:', err.message));
      }
    }
  } catch (err) {
    console.warn('country-profiles: boot check skipped:', err.message);
  }
  // Main products: with a Comtrade key, pull economies that have none yet
  // (a resumable run; already-current economies cost no call).
  try {
    if (products.hasKey()) {
      const { rows: [{ count }] } = await db.query(
        `SELECT count(*)::int AS count FROM stat_countries c WHERE NOT EXISTS (SELECT 1 FROM stat_country_products p WHERE p.iso3 = c.iso3)`
      );
      if (count > 0) { console.log(`country-products: ${count} economies without products yet, pulling them`); startProductsSync('boot'); }
    } else {
      console.log('country-products: COMTRADE_API_KEY not set; main products are not pulled');
    }
  } catch (err) {
    console.warn('country-products: boot check skipped:', err.message);
  }
  // The Factbook text ships with the repository; load it into the database
  // (where it can be edited later) whenever the committed snapshot changed.
  try {
    if (await factbook.needsImport(db)) {
      console.log('country-profiles: factbook snapshot not yet imported, loading it');
      await factbook.importFactbook(db, { log: (m) => console.log(`country-profiles: ${m}`), trigger: 'boot' });
    }
  } catch (err) {
    console.warn('country-profiles: factbook import skipped:', err.message);
  }
}

// Monthly products refresh (Comtrade annual data moves slowly): the 2nd of
// each month at 10:40 Tbilisi, after the weekly World Bank run has had its turn.
function scheduleMonthlyProducts() {
  const UTC_HOUR = 6, UTC_MINUTE = 40, DAY = 2;
  const now = new Date();
  let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), DAY, UTC_HOUR, UTC_MINUTE, 0, 0));
  if (next <= now) next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, DAY, UTC_HOUR, UTC_MINUTE, 0, 0));
  const delay = next - now;
  console.log(`country-products: next scheduled sync in ${(delay / 3600000).toFixed(1)}h (${next.toISOString()})`);
  setTimeout(() => {
    if (products.hasKey()) startProductsSync('scheduled');
    scheduleMonthlyProducts();
  }, delay);
}

if (process.env.NODE_ENV !== 'test' && !process.env.COUNTRY_PROFILES_NO_SCHEDULE) {
  scheduleWeeklySync();
  scheduleMonthlyProducts();
  setTimeout(bootCheck, 30_000);
}

module.exports = router;
