#!/usr/bin/env node
/**
 * Warms the Comtrade cache with every partner's supplier breakdown (one call
 * per partner) so a main run reaches its partner phase with cache hits.
 * Safe to run alongside run.js: both read and write the same on-disk cache
 * and share the daily budget file. Uses COMTRADE_API_KEY like run.js; point
 * it at the secondary key to run with a second rate-limit slot.
 *
 *   node server/export-potential/pipeline/prefetch-partners.js --as-of 2025 [--cohorts a,b] [--partners TUR,DEU]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const { loadConfig, gate1 } = require('../scoring');
const comtrade = require('./comtrade');
const geostat = require('./geostat');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
  }
  return out;
}
const log = (m) => process.stderr.write(`[prefetch ${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const range = (a, b) => { const o = []; for (let y = a; y <= b; y++) o.push(y); return o; };

async function main() {
  const args = parseArgs(process.argv);
  const asOf = Number(args['as-of']);
  if (!Number.isInteger(asOf)) throw new Error('--as-of YEAR is required');
  const cfg = loadConfig(); const p = cfg.pipeline; const W = cfg.windowYears;
  const cohortKeys = String(args.cohorts || Object.keys(p.cohorts).join(',')).split(',');
  const only = args.partners ? String(args.partners).toUpperCase().split(',') : null;

  const da = await comtrade.getDataAvailability(range(asOf - W - 1, asOf));
  const areas = await comtrade.getPartnerAreas();
  const groups = new Set(areas.filter((a) => a.isGroup).map((a) => a.code));
  const reporters = new Map();
  for (const r of da) {
    if (!r.reporterISO || r.reporterISO === 'EUR' || r.reporterISO === 'GEO' || groups.has(r.reporterCode)) continue;
    const rep = reporters.get(r.reporterISO) || { code: r.reporterCode, iso3: r.reporterISO, years: {} };
    rep.years[r.period] = r.classificationCode; reporters.set(r.reporterISO, rep);
  }
  const geo = await geostat.domesticExportsByProduct(range(asOf - W, asOf));
  const latest = geo.total[asOf] > 0 ? asOf : asOf - 1;
  const latestYears = range(latest - p.georgiaLatestYears + 1, latest);
  const excluded = new Set((p.excludedProducts && p.excludedProducts.codes) || []);
  const gate1Codes = Object.keys(geo.products).filter((h) => !excluded.has(h) && gate1(geo.products[h], latestYears, cfg).pass).sort();
  log(`${gate1Codes.length} gate-1 products`);

  const taken = new Set();
  for (const key of cohortKeys) {
    const T = asOf + p.cohorts[key].yearOffset; const window = range(T - W + 1, T);
    const members = [...reporters.values()].filter((r) => !taken.has(r.iso3) && window.every((y) => r.years[y]));
    for (const m of members) taken.add(m.iso3);
    const wanted = members.filter((m) => !only || only.includes(m.iso3));
    log(`cohort ${key}: ${wanted.length} partners`);
    for (const m of wanted) {
      const fetchYears = async (years) => {
        const { rows, truncated, fromCache } = await comtrade.getTrade({ reporterCode: m.code, period: years, flowCode: 'M', cmdCode: gate1Codes }, { budget: p.comtrade.dailyCallBudget });
        if (truncated && years.length > 1) { const h = Math.ceil(years.length / 2); await fetchYears(years.slice(0, h)); await fetchYears(years.slice(h)); return; }
        if (!fromCache) log(`${m.iso3}: ${rows.length} rows`);
      };
      await fetchYears(window);
    }
  }
  log(`done; Comtrade calls today: ${comtrade.readBudget().calls}`);
}

main().catch((err) => { if (err instanceof comtrade.BudgetExhausted) { log(err.message); process.exit(0); } console.error(err); process.exit(1); });
