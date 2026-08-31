/**
 * Diagnose an FDI-by-sector workbook the way the upload endpoint sees it.
 *
 * `POST /api/statistics/fdi-sectors/upload` only fails loudly on two things:
 * a missing header row and a file with no countries at all. Everything else
 * it cannot make sense of it skips silently — a period column whose header it
 * doesn't recognise, a country row whose code it can't read — so an upload can
 * report success while quietly dropping the very quarter that was added. This
 * prints what the parser in server/routes/statistics.js detects and, for each
 * thing it skips, why.
 *
 * Read-only: it touches no database and writes nothing.
 *
 *   node server/scripts/inspect-fdi-sectors.js <file.xlsx> [country-code]
 *
 * Pass a country code to also dump that country's parsed rows, to compare
 * against the workbook by eye.
 *
 * The detection rules below are a copy of parseFdiSectorsWorkbook's, not a
 * call into it: that module opens a database connection when required. Keep
 * the two in step when either changes.
 */

'use strict';

const path = require('path');
const XLSX = require('xlsx');

const HEADER_LABEL = 'ქვეყნის კოდი';
const HEADER_SEARCH_ROWS = 20; // parser scans only this far for the header
const FIRST_PERIOD_COL = 3;    // column D
const TOTAL_ROW = 'სულ';

const file = process.argv[2];
const wantedCountry = process.argv[3];
if (!file) {
  console.error('usage: node server/scripts/inspect-fdi-sectors.js <file.xlsx> [country-code]');
  process.exit(2);
}

const wb = XLSX.readFile(path.resolve(file));
const sheetName = wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
if (!sheet) {
  console.error('FAIL: the workbook has no sheets — upload would return 400.');
  process.exit(1);
}

console.log(`file    : ${path.resolve(file)}`);
console.log(`sheets  : ${wb.SheetNames.map((n) => JSON.stringify(n)).join(', ')}`);
console.log(`parsing : ${JSON.stringify(sheetName)} (the parser always takes the first sheet)`);
console.log(`range   : ${sheet['!ref'] || '(empty)'}`);
console.log('');

const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

// ── Header row ──────────────────────────────────────────────────────────
let headerIdx = -1;
for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
  if (String((rows[i] || [])[0] || '').trim() === HEADER_LABEL) { headerIdx = i; break; }
}

if (headerIdx < 0) {
  console.log(`HEADER ROW: not found — upload returns 400 "Header row with "${HEADER_LABEL}" not found".`);
  console.log(`Column A of the first ${HEADER_SEARCH_ROWS} rows, so you can see what it found instead:`);
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    console.log(`  row ${String(i + 1).padStart(2)}  A = ${JSON.stringify((rows[i] || [])[0])}`);
  }
  console.log('');
  console.log('Column A of the header row must equal that label exactly (trailing');
  console.log('spaces are tolerated, anything else is not) and sit in the first');
  console.log(`${HEADER_SEARCH_ROWS} rows. A title block pushing it lower fails the same way.`);
  process.exit(1);
}
console.log(`header row: ${headerIdx + 1} (spreadsheet numbering)`);

// ── Merged cells over the header ────────────────────────────────────────
// sheet_to_json gives a merged range's value to its top-left cell and null to
// the rest, so a period header written as one merge across several columns
// reaches the parser as a single labelled column followed by blanks — the
// commonest way a newly added quarter goes missing without any error.
const merges = (sheet['!merges'] || []).filter(
  (m) => m.s.r <= headerIdx && m.e.r >= headerIdx && m.e.c > m.s.c
);
if (merges.length) {
  console.log('');
  console.log(`WARNING: ${merges.length} merged cell(s) span the header row:`);
  for (const m of merges) {
    const from = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c });
    const to = XLSX.utils.encode_cell({ r: m.e.r, c: m.e.c });
    const value = (rows[m.s.r] || [])[m.s.c];
    console.log(`  ${from}:${to} = ${JSON.stringify(value)} — only ${from} carries this value; ` +
      `column${m.e.c - m.s.c > 1 ? 's' : ''} ${
        Array.from({ length: m.e.c - m.s.c }, (_, i) => XLSX.utils.encode_col(m.s.c + i + 1)).join(', ')
      } read as blank`);
  }
  console.log('  Unmerge them, or repeat the label in each column, so every period is labelled.');
}

// ── Period columns ──────────────────────────────────────────────────────
const header = rows[headerIdx];
const periodCols = [];
const skipped = [];
for (let c = FIRST_PERIOD_COL; c < header.length; c++) {
  const col = XLSX.utils.encode_col(c);
  const raw = String(header[c] || '').replace(/\*/g, '').trim();
  if (!raw) { skipped.push({ col, raw: header[c], why: 'header cell is empty' }); continue; }
  const m = /\b(20\d{2}|21\d{2})\b/.exec(raw);
  if (!m) { skipped.push({ col, raw, why: 'no 4-digit year 2000-2199 in the header' }); continue; }
  const year = parseInt(m[1], 10);
  if (year < 2000 || year > 2100) { skipped.push({ col, raw, why: `year ${year} outside 2000-2100` }); continue; }
  periodCols.push({ col, colIdx: c, label: raw });
}

console.log('');
console.log(`period columns detected: ${periodCols.length}`);
for (const p of periodCols) console.log(`  ${p.col}  label ${JSON.stringify(p.label)}`);
if (!periodCols.length) {
  console.log('  none — upload returns 400 "No year/period columns found in header".');
}
if (skipped.length) {
  console.log('');
  console.log(`columns skipped (no error is raised for these — this is where a missing quarter hides):`);
  for (const s of skipped) console.log(`  ${s.col}  ${JSON.stringify(s.raw)} — ${s.why}`);
}
console.log('');
console.log(`Note: periods are recognised by their header label, from column ` +
  `${XLSX.utils.encode_col(FIRST_PERIOD_COL)} onwards — so an extra non-period column between them is`);
console.log('harmless, but a period sitting left of that column is invisible to the parser.');

// ── Country blocks ──────────────────────────────────────────────────────
const countries = {};
const sectorsSet = new Set();
const unmappedSectors = new Set();
const orphanRows = [];
let current = null;

// The same mapping the parser uses to shorten sector names. Only the keys
// matter here: a sector missing from it still parses, it just carries its
// full Georgian name into the table and has no English translation.
let SECTOR_NAMES = null;
try {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../routes/statistics.js'), 'utf8'
  );
  const block = /const SECTOR_NAMES = \{([\s\S]*?)\n\};/.exec(src);
  if (block) {
    SECTOR_NAMES = new Set(
      [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
    );
  }
} catch (_) { /* the sector-name check is a nicety; carry on without it */ }

for (let r = headerIdx + 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row) continue;
  const codeRaw = row[0] != null ? String(row[0]).trim() : '';
  const nameRaw = row[1] != null ? String(row[1]).trim() : '';
  const sectorRaw = row[2] != null ? String(row[2]).trim() : '';

  if (codeRaw && !isNaN(parseInt(codeRaw, 10))) {
    const code = String(parseInt(codeRaw, 10));
    current = { code, name: nameRaw };
    if (!countries[code]) countries[code] = { name: nameRaw, sectors: {}, totals: {} };
  } else if (codeRaw && !current) {
    orphanRows.push({ row: r + 1, codeRaw, why: 'column A is not a number and no country block has started yet' });
  }
  if (!current || !sectorRaw) continue;

  const values = {};
  for (const { colIdx, label } of periodCols) {
    const v = row[colIdx];
    if (v === null || v === undefined || v === '-' || v === '') { values[label] = null; continue; }
    const n = parseFloat(String(v).replace(/,/g, '').replace(/\s/g, '').replace(/ /g, ''));
    values[label] = isNaN(n) ? null : n / 1000; // thousand USD -> mln USD
  }

  if (sectorRaw === TOTAL_ROW) {
    countries[current.code].totals = values;
  } else {
    countries[current.code].sectors[sectorRaw] = values;
    sectorsSet.add(sectorRaw);
    if (SECTOR_NAMES && !SECTOR_NAMES.has(sectorRaw)) unmappedSectors.add(sectorRaw);
  }
}

const codes = Object.keys(countries);
console.log('');
console.log(`countries parsed: ${codes.length}`);
console.log(`sectors parsed  : ${sectorsSet.size}`);
if (!codes.length) {
  console.log('  none — upload returns 400 "No country data found in file".');
  process.exit(1);
}
console.log(`first few       : ${codes.slice(0, 8).map((c) => `${c} (${countries[c].name || '?'})`).join(', ')}`);

if (orphanRows.length) {
  console.log('');
  console.log(`rows before the first country block: ${orphanRows.length} (skipped, which is usually the grand-total block and correct)`);
  console.log(`  first at row ${orphanRows[0].row}: ${JSON.stringify(orphanRows[0].codeRaw)}`);
}

if (unmappedSectors.size) {
  console.log('');
  console.log(`sectors with no entry in SECTOR_NAMES (they parse, but show their full Georgian name and no English one):`);
  for (const s of unmappedSectors) console.log(`  ${JSON.stringify(s)}`);
}

// A country whose block carries no "სულ" row gets totals summed from its
// sectors, so an empty totals object here is not itself a fault.
const noTotals = codes.filter((c) => !Object.keys(countries[c].totals).length);
if (noTotals.length) {
  console.log('');
  console.log(`countries with no "${TOTAL_ROW}" row (totals get summed from their sectors): ${noTotals.length}`);
}

// ── One country in full ─────────────────────────────────────────────────
if (wantedCountry) {
  const key = String(parseInt(wantedCountry, 10));
  const c = countries[key];
  console.log('');
  if (!c) {
    console.log(`country ${wantedCountry}: not in this file — the statistics page hides the sector card for it.`);
    process.exit(0);
  }
  const labels = periodCols.map((p) => p.label);
  const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(2));
  const width = Math.max(20, ...Object.keys(c.sectors).map((s) => Math.min(s.length, 44)));
  console.log(`country ${key} (${c.name || '?'}) — mln USD, as the sector table would show it:`);
  console.log(`  ${'sector'.padEnd(width)}  ${labels.map((l) => l.padStart(12)).join('')}`);
  console.log(`  ${TOTAL_ROW.padEnd(width)}  ${labels.map((l) => fmt(c.totals[l]).padStart(12)).join('')}`);
  for (const [name, vals] of Object.entries(c.sectors)) {
    const shown = name.length > 44 ? `${name.slice(0, 41)}...` : name;
    console.log(`  ${shown.padEnd(width)}  ${labels.map((l) => fmt(vals[l]).padStart(12)).join('')}`);
  }
}
