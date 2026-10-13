#!/usr/bin/env node
/**
 * CIA World Factbook text — extract and import.
 *
 *   node server/country-profiles/import-factbook.js --extract /path/to/factbook.json [--snapshot 2026-01]
 *       Rebuild server/data/factbook/profiles/*.json from an upstream
 *       factbook.json checkout (development step; the output is committed).
 *
 *   node server/country-profiles/import-factbook.js
 *       Load the committed files into the database (also runs at boot when
 *       stat_country_texts is empty). Edited rows are never overwritten.
 */
'use strict';

const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fb = require('./factbook');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[a.slice(2)] = true; else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.extract) {
    const dir = path.resolve(String(args.extract));
    let commit = null;
    try { commit = execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* not a git checkout */ }
    const report = fb.extractAll(dir, { snapshotDate: args.snapshot || null, upstreamCommit: commit });
    console.log(`extracted ${report.written} profiles, ${report.fields} fields, into ${fb.PROFILES_DIR}`);
    if (report.missing.length) console.log(`no upstream file for: ${report.missing.map((m) => `${m.iso3} (${m.gec})`).join(', ')}`);
    return;
  }
  if (!require('../config').databaseUrl) { console.error('DATABASE_URL is not set (see .env.example)'); process.exit(1); }
  const db = require('../db');
  const fs = require('fs');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  const r = await fb.importFactbook(db, { log: console.log });
  await db.pool.end();
  console.log(`done: ${r.rows} rows, ${r.countries} countries`);
}

main().catch((err) => { console.error(err); process.exit(1); });
