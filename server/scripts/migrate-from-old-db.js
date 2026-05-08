/**
 * One-shot migration: copy users + content from a previous vector_portal
 * Postgres database into the current one.
 *
 * Policy: "old wins" — every table listed below is TRUNCATEd on the new DB
 * and refilled verbatim from the old DB, preserving SERIAL ids. Both sides
 * are assumed to share the schema in server/schema.sql.
 *
 * Usage:
 *   1. Create server/scripts/.migration.env (gitignored) with:
 *        DATABASE_URL=<new external Postgres URL>
 *        OLD_DATABASE_URL=<old external Postgres URL>
 *        MIGRATION_CONFIRM=yes
 *      Optionally:
 *        DRY_RUN=yes        # print row counts only, no destructive ops
 *   2. Run: node server/scripts/migrate-from-old-db.js
 *
 * Before any destructive op, the script writes a per-table NDJSON dump of
 * the new DB to server/scripts/.migration-backup-<timestamp>/. Recovery
 * from that dump is manual (see RESTORE.md scenario in the plan).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '.migration.env') });

const TABLE_ORDER = [
  'countries',
  'departments',
  'users',
  'country_assignments',
  'deputy_supervisor_links',
  'deputy_department_links',
  'events',
  'sections',
  'section_departments',
  'workflow_steps',
  'section_content',
  'section_files',
  'section_history',
  'section_comments',
  'section_return_requests',
  'event_templates',
  'event_template_sections',
  'event_template_section_departments',
  'admin_uploads',
];

// section_comments has a self-referential parent_id; insert ordered so
// parents land before children. Other tables don't have intra-table FKs.
const ORDER_BY_OVERRIDE = {
  section_comments: 'id ASC NULLS FIRST',
};

const DRY_RUN = process.env.DRY_RUN === 'yes';
const BATCH_ROWS = 200;

function buildPool(connectionString, label) {
  if (!connectionString) {
    throw new Error(`Missing connection string for ${label}`);
  }
  const cfg = { connectionString };
  if (connectionString.includes('render.com')) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return new Pool(cfg);
}

async function getColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return rows.map(r => ({ name: r.column_name, type: r.data_type }));
}

async function getColumnNames(pool, table) {
  const cols = await getColumns(pool, table);
  return cols.map(c => c.name);
}

async function tableHasIdSequence(client, table) {
  const { rows } = await client.query(
    `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
    [table]
  );
  return rows[0] && rows[0].seq;
}

function quoteIdent(ident) {
  return '"' + ident.replace(/"/g, '""') + '"';
}

async function rowCount(pool, table) {
  const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS c FROM ${quoteIdent(table)}`);
  return Number(rows[0].c);
}

async function dumpTableToNdjson(pool, table, outDir) {
  const cols = await getColumnNames(pool, table);
  if (cols.length === 0) return 0;
  const file = path.join(outDir, `${table}.ndjson`);
  const fd = fs.openSync(file, 'w');
  try {
    const orderBy = ORDER_BY_OVERRIDE[table] || (cols.includes('id') ? 'id ASC' : '1');
    const sql = `SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderBy}`;
    const { rows } = await pool.query(sql);
    for (const row of rows) {
      fs.writeSync(fd, JSON.stringify(row) + '\n');
    }
    return rows.length;
  } finally {
    fs.closeSync(fd);
  }
}

function buildInsert(table, cols, batch, jsonCols) {
  const colList = cols.map(quoteIdent).join(', ');
  const params = [];
  const valueGroups = batch.map(row => {
    const placeholders = cols.map(c => {
      let v = row[c];
      // pg's auto-stringification for JS objects bound to JSON/JSONB columns
      // is unreliable when the parameter type is inferred (rather than declared)
      // — explicit JSON.stringify avoids "invalid input syntax for type json".
      if (jsonCols.has(c) && v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) {
        v = JSON.stringify(v);
      }
      params.push(v);
      return '$' + params.length;
    });
    return '(' + placeholders.join(', ') + ')';
  });
  return {
    text: `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${valueGroups.join(', ')}`,
    values: params,
  };
}

async function copyTable(srcPool, dstClient, table) {
  const srcMeta = await getColumns(srcPool, table);
  const dstMeta = await getColumns(dstClient, table);
  const srcNames = srcMeta.map(c => c.name);
  const dstNames = dstMeta.map(c => c.name);
  const onlyOld = srcNames.filter(c => !dstNames.includes(c));
  const onlyNew = dstNames.filter(c => !srcNames.includes(c));
  if (onlyOld.length || onlyNew.length) {
    const detail = [];
    if (onlyOld.length) detail.push(`only in old: ${onlyOld.join(', ')}`);
    if (onlyNew.length) detail.push(`only in new: ${onlyNew.join(', ')}`);
    throw new Error(`Schema mismatch on table "${table}" — ${detail.join(' | ')}`);
  }
  const cols = srcNames;
  const jsonCols = new Set(
    dstMeta.filter(c => c.type === 'jsonb' || c.type === 'json').map(c => c.name)
  );
  const orderBy = ORDER_BY_OVERRIDE[table] || (cols.includes('id') ? 'id ASC' : '1');
  const { rows } = await srcPool.query(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderBy}`);
  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const batch = rows.slice(i, i + BATCH_ROWS);
    const { text, values } = buildInsert(table, cols, batch, jsonCols);
    await dstClient.query(text, values);
  }
  return rows.length;
}

async function resetSequences(client) {
  for (const table of TABLE_ORDER) {
    const seq = await tableHasIdSequence(client, table);
    if (!seq) continue;
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1))`,
      [seq]
    );
  }
}

async function main() {
  const newUrl = process.env.DATABASE_URL;
  const oldUrl = process.env.OLD_DATABASE_URL;
  const confirm = process.env.MIGRATION_CONFIRM;

  if (!newUrl || !oldUrl || confirm !== 'yes') {
    console.error('Aborting: required env vars not set.');
    console.error('  DATABASE_URL          (target / new DB)         :', newUrl ? 'set' : 'MISSING');
    console.error('  OLD_DATABASE_URL      (source / old DB)         :', oldUrl ? 'set' : 'MISSING');
    console.error('  MIGRATION_CONFIRM=yes (explicit go-ahead)       :', confirm === 'yes' ? 'set' : 'MISSING');
    console.error('Create server/scripts/.migration.env or export them in your shell.');
    process.exit(2);
  }
  if (newUrl === oldUrl) {
    console.error('Aborting: DATABASE_URL and OLD_DATABASE_URL are identical.');
    process.exit(2);
  }

  console.log(`Migration mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will TRUNCATE the new DB)'}`);
  console.log(`Source (old) : ${redact(oldUrl)}`);
  console.log(`Target (new) : ${redact(newUrl)}`);

  const oldPool = buildPool(oldUrl, 'old');
  const newPool = buildPool(newUrl, 'new');

  try {
    await oldPool.query('SELECT 1');
    await newPool.query('SELECT 1');
    console.log('Both connections OK.');

    console.log('\n── Schema diff ────────────────────────────────────────────');
    for (const table of TABLE_ORDER) {
      const oldCols = await getColumnNames(oldPool, table);
      const newCols = await getColumnNames(newPool, table);
      if (oldCols.length === 0) {
        throw new Error(`Source DB is missing table "${table}" — old DB schema not aligned.`);
      }
      if (newCols.length === 0) {
        throw new Error(`Target DB is missing table "${table}" — boot the new portal once to run the auto-migration first.`);
      }
      const onlyOld = oldCols.filter(c => !newCols.includes(c));
      const onlyNew = newCols.filter(c => !oldCols.includes(c));
      if (onlyOld.length || onlyNew.length) {
        const detail = [];
        if (onlyOld.length) detail.push(`only in old: ${onlyOld.join(', ')}`);
        if (onlyNew.length) detail.push(`only in new: ${onlyNew.join(', ')}`);
        throw new Error(`Schema mismatch on "${table}" — ${detail.join(' | ')}`);
      }
    }
    console.log('All tables present and column lists match.');

    console.log('\n── Old DB row counts ──────────────────────────────────────');
    let oldTotal = 0;
    for (const t of TABLE_ORDER) {
      const n = await rowCount(oldPool, t);
      oldTotal += n;
      console.log(`  ${t.padEnd(40)} ${n}`);
    }
    console.log(`  ${'TOTAL'.padEnd(40)} ${oldTotal}`);

    if (DRY_RUN) {
      console.log('\nDRY RUN complete — no changes made. Re-run without DRY_RUN=yes to migrate.');
      return;
    }

    console.log('\n── New DB row counts (pre-migration) ──────────────────────');
    for (const t of TABLE_ORDER) {
      const n = await rowCount(newPool, t);
      console.log(`  ${t.padEnd(40)} ${n}`);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, `.migration-backup-${ts}`);
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`\n── Backing up new DB to ${backupDir} ──`);
    let backupTotal = 0;
    for (const t of TABLE_ORDER) {
      const n = await dumpTableToNdjson(newPool, t, backupDir);
      backupTotal += n;
      console.log(`  ${t.padEnd(40)} ${n} rows → ${t}.ndjson`);
    }
    console.log(`Backed up ${backupTotal} rows.`);

    console.log('\n── BEGIN transaction on new DB ────────────────────────────');
    const client = await newPool.connect();
    try {
      await client.query('BEGIN');

      console.log('Truncating tables (reverse order, CASCADE)...');
      for (const t of [...TABLE_ORDER].reverse()) {
        await client.query(`TRUNCATE ${quoteIdent(t)} RESTART IDENTITY CASCADE`);
      }

      console.log('Copying tables (forward order)...');
      const t0 = Date.now();
      let copiedTotal = 0;
      for (const t of TABLE_ORDER) {
        const tStart = Date.now();
        const n = await copyTable(oldPool, client, t);
        copiedTotal += n;
        console.log(`  ${t.padEnd(40)} ${String(n).padStart(8)} rows  (${Date.now() - tStart} ms)`);
      }

      console.log('Resetting SERIAL sequences...');
      await resetSequences(client);

      await client.query('COMMIT');
      console.log(`\nCOMMIT — ${copiedTotal} rows copied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    } catch (err) {
      console.error('Error during transaction — rolling back.');
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    console.log('\n── Post-migration row counts ──────────────────────────────');
    for (const t of TABLE_ORDER) {
      const n = await rowCount(newPool, t);
      console.log(`  ${t.padEnd(40)} ${n}`);
    }
    console.log(`\nBackup of pre-migration new DB: ${backupDir}`);
    console.log('Migration complete. Restart the new portal so the auto-seed runs idempotently.');
  } finally {
    await oldPool.end();
    await newPool.end();
  }
}

function redact(url) {
  return url.replace(/:\/\/[^@]+@/, '://***@');
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
