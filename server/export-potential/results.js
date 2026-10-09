/**
 * Loader for the per-partner result files the pipeline writes.
 *
 * One JSON file per partner country under server/data/export-potential/
 * results/<ISO3>.json (contract: see README.md in that folder). Files are
 * parsed on first use and re-read when their mtime changes. Product names
 * come from the portal's HS4 name lists (frontend/data/hs4-names-*.csv), so
 * result files only need codes.
 *
 * The invented sample partner (sample.js) is always listed last, marked
 * `sample: true`, so the page can be previewed before real files exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildSampleResult } = require('./sample');

const RESULTS_DIR = path.join(__dirname, '../data/export-potential/results');
const INDEX_FILE = path.join(__dirname, '../data/export-potential/index.json');
const NAMES_DIR = path.join(__dirname, '../../frontend/data');
// Parsed result files kept in memory (a file is a few hundred KB; 138 of
// them would not be worth holding at once).
const FILE_CACHE_MAX = 12;

let namesCache = null;
function loadNames() {
  if (namesCache) return namesCache;
  const read = (file) => {
    const map = {};
    try {
      const text = fs.readFileSync(path.join(NAMES_DIR, file), 'utf8');
      for (const line of text.split('\n').slice(1)) {
        const comma = line.indexOf(',');
        if (comma < 0) continue;
        const code = line.slice(0, comma).trim().replace(/^"|"$/g, '');
        const name = line.slice(comma + 1).trim().replace(/^"|"$/g, '');
        if (/^\d{3,4}$/.test(code) && name) map[code.padStart(4, '0')] = name;
      }
    } catch (err) {
      console.warn(`export-potential: could not read ${file}:`, err.message);
    }
    return map;
  };
  namesCache = { en: read('hs4-names-en.csv'), ka: read('hs4-names-ka.csv') };
  return namesCache;
}

function productName(hs4) {
  const names = loadNames();
  const code = String(hs4).padStart(4, '0');
  return { en: names.en[code] || `HS ${code}`, ka: names.ka[code] || names.en[code] || `HS ${code}` };
}

function isValidResult(r) {
  return r && typeof r === 'object' && r.partner && typeof r.partner.iso3 === 'string'
    && Number.isInteger(r.dataYear) && Array.isArray(r.products);
}

function summarize(r) {
  const counts = { High: 0, Moderate: 0, Low: 0 };
  for (const p of r.products) if (counts[p.rating] != null) counts[p.rating]++;
  return { ...counts, watch: Array.isArray(r.watch) ? r.watch.length : 0, total: r.products.length };
}

const RATING_RANK = { High: 2, Moderate: 1, Low: 0 };

function enrich(r) {
  const products = r.products.map((p) => ({
    ...p,
    hs4: String(p.hs4).padStart(4, '0'),
    name: p.name && p.name.en ? p.name : productName(p.hs4),
  })).sort((a, b) => (RATING_RANK[b.rating] - RATING_RANK[a.rating]) || (b.score - a.score) || a.hs4.localeCompare(b.hs4));
  const watch = (r.watch || []).map((w) => ({
    ...w,
    hs4: String(w.hs4).padStart(4, '0'),
    name: w.name && w.name.en ? w.name : productName(w.hs4),
  })).sort((a, b) => a.hs4.localeCompare(b.hs4));
  return { ...r, products, watch, summary: summarize(r) };
}

function countrySummary(r) {
  return {
    code: r.partner.iso3,
    iso2: r.partner.iso2 || null,
    nameEn: r.partner.nameEn || r.partner.iso3,
    nameKa: r.partner.nameKa || r.partner.nameEn || r.partner.iso3,
    dataYear: r.dataYear,
    tradeSource: r.tradeSource || null,
    sample: !!r.sample,
    summary: summarize(r),
  };
}

const fileCache = new Map(); // iso3 -> { mtimeMs, result }

function readFile(file) {
  const full = path.join(RESULTS_DIR, file);
  const stat = fs.statSync(full);
  const code = path.basename(file, '.json').toUpperCase();
  const cached = fileCache.get(code);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    console.warn(`export-potential: ${file} is not valid JSON:`, err.message);
    return null;
  }
  if (!isValidResult(parsed) || parsed.partner.iso3.toUpperCase() !== code) {
    console.warn(`export-potential: ${file} does not match the result contract; skipped`);
    return null;
  }
  const result = { ...parsed, sample: !!parsed.sample };
  fileCache.delete(code);
  fileCache.set(code, { mtimeMs: stat.mtimeMs, result });
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value);
  return result;
}

// The pipeline writes index.json next to the results folder; it is used
// when present and newer than every result file, otherwise files are scanned.
let indexCache = null;
function readIndex() {
  let stat;
  try { stat = fs.statSync(INDEX_FILE); } catch (_) { return null; }
  if (indexCache && indexCache.mtimeMs === stat.mtimeMs) return indexCache.entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    const entries = (parsed.countries || []).filter((c) => c && typeof c.code === 'string' && Number.isInteger(c.dataYear));
    indexCache = { mtimeMs: stat.mtimeMs, entries };
    return entries;
  } catch (err) {
    console.warn('export-potential: index.json unreadable, scanning files:', err.message);
    return null;
  }
}

function listFiles() {
  let names = [];
  try {
    names = fs.readdirSync(RESULTS_DIR).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f));
  } catch (_) { /* no results directory yet */ }
  return names.sort();
}

let sampleCache = null;
function sampleResult() {
  if (!sampleCache) sampleCache = buildSampleResult();
  return sampleCache;
}

function listCountries() {
  const files = new Set(listFiles().map((f) => path.basename(f, '.json').toUpperCase()));
  const indexed = readIndex();
  const out = [];
  if (indexed) {
    for (const c of indexed) {
      if (!files.has(c.code.toUpperCase())) continue; // stale index entry
      out.push({ code: c.code, iso2: c.iso2 || null, nameEn: c.nameEn, nameKa: c.nameKa || c.nameEn, dataYear: c.dataYear, tradeSource: c.tradeSource || null, sample: !!c.sample, summary: c.summary });
    }
  } else {
    for (const f of listFiles()) {
      const r = readFile(f);
      if (r) out.push(countrySummary(r));
    }
  }
  out.sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  out.push(countrySummary(sampleResult()));
  return out;
}

function getCountry(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9_-]{1,8}$/.test(c)) return null;
  const sample = sampleResult();
  if (c === sample.partner.iso3) return enrich(sample);
  const file = listFiles().find((f) => path.basename(f, '.json').toUpperCase() === c);
  if (!file) return null;
  const r = readFile(file);
  return r ? enrich(r) : null;
}

module.exports = { RESULTS_DIR, INDEX_FILE, listCountries, getCountry, enrich, productName, isValidResult };
