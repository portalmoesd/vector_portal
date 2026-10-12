#!/usr/bin/env node
/**
 * Country profiles sync — pulls the World Bank country list and the WDI
 * indicators into Postgres (stat_* tables). The pages never call the API;
 * they read only what this script stored.
 *
 *   node server/country-profiles/sync.js            # full sync
 *   node server/country-profiles/sync.js --indicators SP.POP.TOTL,NY.GDP.MKTP.CD
 *   node server/country-profiles/sync.js --dry-run   # fetch and parse, write nothing
 *
 * Idempotent: every write is an upsert or a delete-and-replace inside one
 * transaction per indicator, so running it twice yields the same rows. A
 * failed pull (timeout, changed code, bad shape) is logged on the run row
 * and that indicator's previous values are left untouched — nothing is
 * estimated or filled in. The run itself is recorded in stat_sync_runs.
 *
 * Also used in-process: the route module schedules runSync() weekly and the
 * admin panel can trigger it.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const wb = require('./worldbank');

const INSERT_BATCH = 1000; // 8 params per row -> well under Postgres' 65535 limit

let running = false;
function isRunning() { return running; }

function stamp() { return new Date().toISOString().slice(11, 19); }
function defaultLog(msg) { process.stderr.write(`[country-profiles ${stamp()}] ${msg}\n`); }

/**
 * Run one sync. Resolves with a summary; never throws for a source-side
 * failure (those are recorded and returned), only for programmer errors or
 * an unreachable database.
 */
async function runSync({ db, trigger = 'cli', log = defaultLog, indicators = null, dryRun = false, fetchOptions = {} } = {}) {
  if (running) { log('a sync is already running; skipped'); return { skipped: true }; }
  running = true;
  const started = Date.now();
  const wanted = indicators ? wb.INDICATORS.filter((i) => indicators.includes(i.code)) : wb.INDICATORS;
  const unknown = indicators ? indicators.filter((c) => !wb.INDICATORS.some((i) => i.code === c)) : [];
  const entries = [];
  const note = (level, step, message, extra) => {
    const e = { at: new Date().toISOString(), level, step, message, ...(extra || {}) };
    entries.push(e);
    log(`${level === 'error' ? 'ERROR ' : ''}${step}: ${message}`);
  };
  for (const c of unknown) note('error', c, 'not a configured indicator');

  let runId = null;
  const fetchOpts = { log: (m) => note('warn', 'fetch', m), ...fetchOptions };
  let ok = 0; let failed = unknown.length;

  try {
    if (!dryRun) {
      await db.query(
        `INSERT INTO stat_sources (id, name, url, license) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, license = EXCLUDED.license`,
        [wb.SOURCE.id, wb.SOURCE.name, wb.SOURCE.url, wb.SOURCE.license]
      );
      const { rows: [run] } = await db.query(
        'INSERT INTO stat_sync_runs (source_id, trigger) VALUES ($1, $2) RETURNING id',
        [wb.SOURCE.id, trigger]
      );
      runId = run.id;
    }

    // ── 1. Country list ────────────────────────────────────────────────
    let knownIso3 = null;
    try {
      const list = await wb.fetchCountryList(fetchOpts);
      note('info', 'countries', `${list.countries.length} economies, ${list.aggregates.length} aggregates excluded`);
      knownIso3 = new Set(list.countries.map((c) => c.iso3));
      if (!dryRun) await replaceCountries(db, list);
      ok++;
    } catch (err) {
      note('error', 'countries', `pull failed, previous list kept: ${err.message}`);
      failed++;
      if (!dryRun) {
        const { rows } = await db.query('SELECT iso3 FROM stat_countries WHERE source_id = $1', [wb.SOURCE.id]);
        knownIso3 = new Set(rows.map((r) => r.iso3));
      }
    }

    // ── 2. Indicators, one transaction each ────────────────────────────
    for (const ind of wanted) {
      const t0 = Date.now();
      try {
        const pulled = await wb.fetchIndicator(ind.code, fetchOpts);
        const rows = knownIso3 ? pulled.rows.filter((r) => knownIso3.has(r.iso3)) : pulled.rows;
        if (!pulled.rows.length) throw new Error('no rows returned');
        const latest = wb.latestByCountry(rows);
        let maxYear = 0;
        for (const r of latest.values()) if (r.year > maxYear) maxYear = r.year;
        if (!dryRun) await replaceIndicator(db, ind, pulled, rows);
        ok++;
        note('info', ind.code, `${rows.length} values for ${latest.size} economies, latest year ${maxYear}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
          { values: rows.length, countries: latest.size, latestYear: maxYear, sourceLastUpdated: pulled.meta.lastUpdated });
      } catch (err) {
        failed++;
        note('error', ind.code, `pull failed, previous values kept: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }

  const status = failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial';
  if (!dryRun && runId != null) {
    await db.query(
      `UPDATE stat_sync_runs SET finished_at = now(), status = $2, ok_count = $3, failed_count = $4, log = $5::jsonb WHERE id = $1`,
      [runId, status, ok, failed, JSON.stringify(entries)]
    );
  }
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${status} (${ok} ok, ${failed} failed)${dryRun ? ' [dry run]' : ''}`);
  return { runId, status, ok, failed, entries, dryRun };
}

async function replaceCountries(db, list) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    for (const c of list.countries) {
      await client.query(
        `INSERT INTO stat_countries (iso3, iso2, slug, name, region_id, region_name, income_id, income_name, capital, longitude, latitude, source_id, source_url, retrieved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (iso3) DO UPDATE SET
           iso2 = EXCLUDED.iso2, slug = EXCLUDED.slug, name = EXCLUDED.name,
           region_id = EXCLUDED.region_id, region_name = EXCLUDED.region_name,
           income_id = EXCLUDED.income_id, income_name = EXCLUDED.income_name,
           capital = EXCLUDED.capital, longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude,
           source_id = EXCLUDED.source_id, source_url = EXCLUDED.source_url, retrieved_at = EXCLUDED.retrieved_at`,
        [c.iso3, c.iso2, c.slug, c.name, c.regionId, c.regionName, c.incomeId, c.incomeName, c.capital, c.longitude, c.latitude, wb.SOURCE.id, list.url, now]
      );
    }
    // Follow the source: an economy it no longer lists is removed.
    await client.query(
      'DELETE FROM stat_countries WHERE source_id = $1 AND NOT (iso3 = ANY($2::text[]))',
      [wb.SOURCE.id, list.countries.map((c) => c.iso3)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceIndicator(db, ind, pulled, rows) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO stat_indicators (code, source_id, name, unit, section, display_order, source_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (code) DO UPDATE SET source_id = EXCLUDED.source_id, name = EXCLUDED.name, unit = EXCLUDED.unit,
         section = EXCLUDED.section, display_order = EXCLUDED.display_order, source_url = EXCLUDED.source_url, updated_at = now()`,
      [ind.code, wb.SOURCE.id, pulled.indicatorName || ind.fallbackName, ind.unit, ind.section, ind.order, pulled.url]
    );
    await client.query('DELETE FROM stat_observations WHERE source_id = $1 AND indicator_code = $2', [wb.SOURCE.id, ind.code]);
    const retrieved = new Date();
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      const params = [];
      const tuples = batch.map((r, j) => {
        const b = j * 8;
        params.push(wb.SOURCE.id, ind.code, r.iso3, r.year, r.value, wb.SOURCE.name, pulled.url, retrieved);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      await client.query(
        `INSERT INTO stat_observations (source_id, indicator_code, iso3, year, value, source_name, source_url, retrieved_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (source_id, indicator_code, iso3, year) DO UPDATE SET value = EXCLUDED.value,
           source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, retrieved_at = EXCLUDED.retrieved_at`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args['dry-run'];
  const indicators = args.indicators ? String(args.indicators).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const db = dryRun ? null : require('../db');
  if (!dryRun && !require('../config').databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  if (!dryRun) {
    // Make sure the stat_* tables exist when the script runs before the server ever did.
    const fs = require('fs');
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  }
  const result = await runSync({ db, trigger: 'cli', indicators, dryRun });
  if (db) await db.pool.end();
  process.exit(result.status === 'failed' ? 2 : 0);
}

module.exports = { runSync, isRunning };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
