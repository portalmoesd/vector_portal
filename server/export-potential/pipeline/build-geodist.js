/**
 * One-off converter: CEPII GeoDist dyadic file (dist_cepii.xls, from
 * https://www.cepii.fr/distance/dist_cepii.zip, Etalab 2.0 licence) ->
 * server/data/export-potential/geodist.json, a compact table of simple
 * (capital-to-capital, "dist") and population-weighted ("distw") distances
 * in km between ISO3 pairs. Committed so the pipeline runs without the
 * 8 MB spreadsheet; re-run when CEPII publishes a new release.
 *
 *   node server/export-potential/pipeline/build-geodist.js /path/to/dist_cepii.xls
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const src = process.argv[2];
if (!src) { console.error('usage: build-geodist.js <dist_cepii.xls>'); process.exit(1); }
const wb = XLSX.readFile(src);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
const dist = {};
const distw = {};
let n = 0;
for (const r of rows) {
  const o = String(r.iso_o || '').trim(); const d = String(r.iso_d || '').trim();
  if (!/^[A-Z]{3}$/.test(o) || !/^[A-Z]{3}$/.test(d)) continue;
  const v = Number(r.dist); const w = Number(r.distw);
  if (!Number.isFinite(v)) continue;
  (dist[o] = dist[o] || {})[d] = Math.round(v);
  if (Number.isFinite(w)) (distw[o] = distw[o] || {})[d] = Math.round(w);
  n++;
}
const out = {
  source: 'CEPII GeoDist (Mayer & Zignago 2011), dist_cepii.xls',
  url: 'https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=6',
  licence: 'Etalab 2.0',
  builtAt: new Date().toISOString(),
  note: 'km; dist = simple distance between most populated cities, distw = population-weighted. GeoDist keeps a few pre-2000 ISO codes (ROM, YUG, ZAR, TMP, PAL); see aliases in geodist.js.',
  pairs: n,
  dist,
  distw,
};
const dest = path.join(__dirname, '..', '..', 'data', 'export-potential', 'geodist.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${dest}: ${n} pairs, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
