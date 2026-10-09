#!/usr/bin/env node
/**
 * Writes docs/export-potential-phase1-summary.md from the result files:
 * ratings per partner country, the RCA tier distribution, growth groups,
 * caps and flags. Run after run.js.
 *
 *   node server/export-potential/pipeline/write-summary.js [resultsDir] [outFile]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'export-potential', 'results');
const out = process.argv[3] || path.join(__dirname, '..', '..', '..', 'docs', 'export-potential-phase1-summary.md');

const rows = [];
const totals = { High: 0, Moderate: 0, Low: 0, watch: 0, products: 0 };
const rca = { full: 0, partial: 0, none: 0, missing: 0 };
const groups = { A: 0, B: 0 };
const flags = {};
const indicatorFull = {};
const indicatorCount = {};
const indicatorMax = { demandSize: 30, demandGrowth: 25, deficitLevel: 4, deficitTrendCurrent: 1, deficitTrendPrevious: 1, supplierConcentration: 6, tariff: 6, distance: 2, rca: 10, trackRecord: 8, headroom: 7 };
const scoreHist = {};
let runDate = null;
let asOf = null;
let geoYears = null;

for (const f of fs.readdirSync(dir).filter((n) => /^[A-Z0-9]+\.json$/.test(n)).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (r.sample) continue;
  runDate = runDate || (r.pipeline && r.pipeline.runDate);
  asOf = asOf || (r.pipeline && r.pipeline.asOfYear);
  geoYears = geoYears || (r.georgiaSource && r.georgiaSource.latestYears);
  const c = { High: 0, Moderate: 0, Low: 0 };
  for (const p of r.products) {
    c[p.rating]++;
    totals[p.rating]++;
    totals.products++;
    const lvl = p.indicators.rca.level;
    rca[lvl in rca ? lvl : 'missing']++;
    groups[p.indicators.demandGrowth.group]++;
    for (const fl of p.flags) flags[fl.code] = (flags[fl.code] || 0) + 1;
    for (const [k, max] of Object.entries(indicatorMax)) {
      indicatorCount[k] = (indicatorCount[k] || 0) + 1;
      if (p.indicators[k] && p.indicators[k].points >= max) indicatorFull[k] = (indicatorFull[k] || 0) + 1;
    }
    const bucket = Math.min(9, Math.floor(p.score / 10)) * 10;
    scoreHist[bucket] = (scoreHist[bucket] || 0) + 1;
  }
  totals.watch += r.watch.length;
  rows.push({ iso3: r.partner.iso3, name: r.partner.nameEn, T: r.dataYear, cohort: r.pipeline && r.pipeline.cohort, ...c, watch: r.watch.length, total: r.products.length });
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(0)}%` : '—');
const lines = [];
lines.push(`# Export potential — Phase 1 summary`);
lines.push('');
lines.push(`Pipeline run ${runDate ? runDate.slice(0, 10) : '—'}, as-of year ${asOf}. ${rows.length} partner countries, ${totals.products.toLocaleString('en-US')} rated partner × product pairs, ${totals.watch} "markets to watch" entries. Georgia's side from Geostat domestic exports, latest full years ${geoYears ? geoYears.join('–') : '—'}; partner and world figures from UN Comtrade. Tariffs are not loaded in version 1 (every pair scored as Equal and flagged).`);
lines.push('');
lines.push('## Ratings overall');
lines.push('');
lines.push('| Rating | Pairs | Share |');
lines.push('|---|---|---|');
for (const k of ['High', 'Moderate', 'Low']) lines.push(`| ${k} | ${totals[k].toLocaleString('en-US')} | ${pct(totals[k], totals.products)} |`);
lines.push('');
lines.push('Score distribution (points, before caps):');
lines.push('');
lines.push('| Points | Pairs |');
lines.push('|---|---|');
for (const b of Object.keys(scoreHist).map(Number).sort((a, b) => a - b)) lines.push(`| ${b}–${b === 90 ? 100 : b + 9} | ${scoreHist[b].toLocaleString('en-US')} |`);
lines.push('');
lines.push('## RCA tiers (Georgia\'s comparative advantage)');
lines.push('');
lines.push('| Tier | Pairs | Share |');
lines.push('|---|---|---|');
lines.push(`| RCA ≥ 1 (10 points) | ${rca.full.toLocaleString('en-US')} | ${pct(rca.full, totals.products)} |`);
lines.push(`| 0.7 ≤ RCA < 1 (5 points) | ${rca.partial.toLocaleString('en-US')} | ${pct(rca.partial, totals.products)} |`);
lines.push(`| RCA < 0.7 (0 points) | ${rca.none.toLocaleString('en-US')} | ${pct(rca.none, totals.products)} |`);
if (rca.missing) lines.push(`| not computable | ${rca.missing} | ${pct(rca.missing, totals.products)} |`);
lines.push('');
lines.push('RCA is a property of the product, not the partner, so these shares are the gate-1 products weighted by how many partners rate them.');
lines.push('');
lines.push('## How often each indicator gives full points');
lines.push('');
lines.push('| Indicator | Full points | Share of pairs |');
lines.push('|---|---|---|');
for (const [k, max] of Object.entries(indicatorMax)) lines.push(`| ${k} (${max}) | ${(indicatorFull[k] || 0).toLocaleString('en-US')} | ${pct(indicatorFull[k] || 0, indicatorCount[k])} |`);
lines.push('');
lines.push(`Demand growth: group A (growing faster than the world) ${groups.A.toLocaleString('en-US')} pairs (${pct(groups.A, totals.products)}), group B ${groups.B.toLocaleString('en-US')}.`);
lines.push('');
lines.push('## Flags');
lines.push('');
lines.push('| Flag | Pairs |');
lines.push('|---|---|');
for (const [k, v] of Object.entries(flags).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v.toLocaleString('en-US')} |`);
lines.push('');
lines.push('## Per partner country');
lines.push('');
lines.push('Sorted by the number of High ratings. T is the partner\'s data year (cohort a: as-of year; cohort b: one year earlier).');
lines.push('');
lines.push('| Partner | T | High | Moderate | Low | Watch | Rated |');
lines.push('|---|---|---|---|---|---|---|');
rows.sort((a, b) => b.High - a.High || b.Moderate - a.Moderate || a.name.localeCompare(b.name));
for (const r of rows) lines.push(`| ${r.name} (${r.iso3}) | ${r.T} | ${r.High} | ${r.Moderate} | ${r.Low} | ${r.watch} | ${r.total} |`);
lines.push('');
fs.writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}: ${rows.length} partners`);
