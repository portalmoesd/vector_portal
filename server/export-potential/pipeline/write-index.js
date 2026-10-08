/**
 * Writes server/data/export-potential/index.json: one small entry per
 * result file (partner, data year, source, rating counts). The portal lists
 * countries from this index instead of parsing every result file.
 *
 *   node server/export-potential/pipeline/write-index.js [resultsDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

function summarize(r) {
  const counts = { High: 0, Moderate: 0, Low: 0 };
  for (const p of r.products || []) if (counts[p.rating] != null) counts[p.rating]++;
  return { ...counts, watch: Array.isArray(r.watch) ? r.watch.length : 0, total: (r.products || []).length };
}

function writeIndex(resultsDir) {
  const entries = [];
  for (const f of fs.readdirSync(resultsDir).filter((n) => /^[A-Z0-9_-]+\.json$/i.test(n)).sort()) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')); } catch (_) { continue; }
    if (!r || !r.partner || !r.partner.iso3 || !Array.isArray(r.products)) continue;
    entries.push({
      code: r.partner.iso3,
      iso2: r.partner.iso2 || null,
      nameEn: r.partner.nameEn || r.partner.iso3,
      nameKa: r.partner.nameKa || r.partner.nameEn || r.partner.iso3,
      dataYear: r.dataYear,
      tradeSource: r.tradeSource ? { id: r.tradeSource.id, label: r.tradeSource.label, edition: r.tradeSource.edition } : null,
      sample: !!r.sample,
      file: f,
      summary: summarize(r),
    });
  }
  entries.sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const out = { generatedAt: new Date().toISOString(), countries: entries };
  const dest = path.join(resultsDir, '..', 'index.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 1));
  return { dest, count: entries.length };
}

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'export-potential', 'results');
  const { dest, count } = writeIndex(dir);
  console.log(`wrote ${dest} (${count} countries)`);
}

module.exports = { writeIndex, summarize };
