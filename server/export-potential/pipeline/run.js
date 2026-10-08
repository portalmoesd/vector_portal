#!/usr/bin/env node
/**
 * Export potential pipeline.
 *
 *   node server/export-potential/pipeline/run.js --as-of 2025 [options]
 *
 *   --as-of YEAR        the as-of year; everything is computed relative to it
 *   --cohorts a,b       which partner cohorts to build (default: a,b)
 *   --partners TUR,DEU  only these partners (ISO3); default: every cohort member
 *   --out DIR           result folder (default: server/data/export-potential/results)
 *   --budget N          Comtrade calls allowed today (default: config)
 *   --dry-run           print cohorts and the planned call count, make no data calls
 *   --quick             DEVELOPMENT ONLY: the "world" is just the selected
 *                       partners; results are marked partialWorld and must
 *                       not be published
 *
 * Steps: data availability -> cohorts -> Georgia (Geostat) -> world
 * (Comtrade, fixed reporter set per cohort) -> each partner's imports by
 * supplier (Comtrade) -> score -> one result file per partner.
 * Every raw response is cached on disk, so a run stopped by the daily
 * budget resumes where it left off. The COMTRADE_API_KEY comes from the
 * environment (or a git-ignored .env); it is never written anywhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { loadConfig, evaluate } = require('../scoring');
const comtrade = require('./comtrade');
const geostat = require('./geostat');
const { distanceKm } = require('./geodist');
const { aggregateWorldRows, aggregateSupplierRows, buildInput } = require('./build');
const { NEW_IN_HS2022 } = require('./concordance');

module.exports = { roundDeep };

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

function log(msg) {
  process.stderr.write(`[pipeline ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

// Round the numbers in a result so the committed files stay small: money
// and distances to whole units, ratios and rates to six decimals.
function roundDeep(v) {
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = roundDeep(v[k]);
    return o;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Money and distances are the only values that reach 1000; ratios,
    // rates and shares stay well below it.
    if (Math.abs(v) >= 1000) return Math.round(v);
    return Math.round(v * 1e6) / 1e6;
  }
  return v;
}

function range(a, b) { const o = []; for (let y = a; y <= b; y++) o.push(y); return o; }
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

async function main() {
  const args = parseArgs(process.argv);
  const asOf = Number(args['as-of']);
  if (!Number.isInteger(asOf)) { console.error('--as-of YEAR is required'); process.exit(1); }
  const cfg = loadConfig();
  const p = cfg.pipeline;
  const budget = args.budget ? Number(args.budget) : p.comtrade.dailyCallBudget;
  const outDir = args.out || path.join(__dirname, '..', '..', 'data', 'export-potential', 'results');
  const cohortKeys = String(args.cohorts || Object.keys(p.cohorts).join(',')).split(',').filter(Boolean);
  const onlyPartners = args.partners ? String(args.partners).toUpperCase().split(',').filter(Boolean) : null;
  const quick = !!args.quick;
  const dryRun = !!args['dry-run'];
  const runDate = new Date().toISOString();
  const W = cfg.windowYears;

  // ── 1. Data availability and reference lists ─────────────────────────
  const daYears = range(asOf - W - 1, asOf);
  const da = await comtrade.getDataAvailability(daYears);
  const partnerAreas = await comtrade.getPartnerAreas();
  const areaByCode = new Map(partnerAreas.map((a) => [a.code, a]));
  const areasByIso = new Map();
  for (const a of partnerAreas) if (a.iso3 && !a.isGroup) { if (!areasByIso.has(a.iso3)) areasByIso.set(a.iso3, []); areasByIso.get(a.iso3).push(a); }

  const reporters = new Map(); // iso3 -> { code, name, years: { year: cls } }
  for (const r of da) {
    // Georgia is the exporter, never a partner; the EU aggregate would double-count its members.
    if (!r.reporterISO || r.reporterISO === 'EUR' || r.reporterISO === 'GEO') continue;
    const area = areaByCode.get(r.reporterCode);
    if (area && area.isGroup) continue;
    const rep = reporters.get(r.reporterISO) || { code: r.reporterCode, iso3: r.reporterISO, name: r.reporterDesc, years: {} };
    rep.years[r.period] = r.classificationCode;
    reporters.set(r.reporterISO, rep);
  }

  // ── 2. Cohorts ───────────────────────────────────────────────────────
  const cohorts = [];
  const taken = new Set();
  for (const key of cohortKeys) {
    const c = p.cohorts[key];
    if (!c) throw new Error(`unknown cohort ${key}`);
    const T = asOf + c.yearOffset;
    const window = range(T - W + 1, T);
    const members = [...reporters.values()].filter((r) => !taken.has(r.iso3) && window.every((y) => r.years[y]));
    for (const m of members) taken.add(m.iso3);
    members.sort((a, b) => a.iso3.localeCompare(b.iso3));
    cohorts.push({ key, T, window, members });
    log(`cohort ${key}: T=${T}, window ${window[0]}-${T}, ${members.length} reporters`);
  }

  const wanted = (cohort) => cohort.members.filter((m) => !onlyPartners || onlyPartners.includes(m.iso3));
  if (onlyPartners) {
    const found = new Set(cohorts.flatMap((c) => wanted(c).map((m) => m.iso3)));
    for (const iso of onlyPartners) if (!found.has(iso)) log(`WARNING: ${iso} is in no cohort (no complete Comtrade window); BACI fallback not implemented yet`);
  }

  if (dryRun) {
    let calls = 0;
    for (const c of cohorts) {
      const worldSet = quick ? wanted(c) : c.members;
      calls += Math.ceil(worldSet.length / p.comtrade.worldChunkReporters) * c.window.length * 2;
      calls += wanted(c).length;
    }
    log(`dry run: about ${calls} Comtrade calls (before cache hits); budget today ${budget}, used ${comtrade.readBudget().calls}`);
    for (const c of cohorts) log(`cohort ${c.key} partners: ${wanted(c).map((m) => m.iso3).join(' ')}`);
    return;
  }

  // ── 3. Georgia (Geostat) ─────────────────────────────────────────────
  const classEn = await geostat.classificatory('en');
  const classKa = await geostat.classificatory('ka');
  const geoCountries = classEn.countries || [];
  const geoLabelEn = new Map(geoCountries.map((c) => [c.value, String(c.label).replace(/^\d+\s+/, '')]));
  const geoLabelKa = new Map((classKa.countries || []).map((c) => [c.value, String(c.label).replace(/^\d+\s+/, '')]));
  const geostatIdByIso3 = new Map();
  for (const c of geoCountries) {
    const a = areaByCode.get(c.value);
    if (a && a.iso3 && !geostatIdByIso3.has(a.iso3)) geostatIdByIso3.set(a.iso3, c.value);
  }
  const allGeostatIds = geoCountries.map((c) => c.value);

  const georgiaYears = range(asOf - W, asOf);
  const geo = await geostat.domesticExportsByProduct(georgiaYears);
  let latestYear = asOf;
  if (!(geo.total[asOf] > 0)) { latestYear = asOf - 1; log(`WARNING: Geostat has no ${asOf} total; using ${latestYear} as the latest full year`); }
  const georgiaLatestYears = range(latestYear - p.georgiaLatestYears + 1, latestYear);
  const trackRecordYears = range(latestYear - p.trackRecordYears + 1, latestYear);
  const excluded = new Set((p.excludedProducts && p.excludedProducts.codes) || []);
  const { gate1 } = require('../scoring');
  const gate1Codes = Object.keys(geo.products)
    .filter((hs4) => !excluded.has(hs4) && gate1(geo.products[hs4], georgiaLatestYears, cfg).pass)
    .sort();
  const excludedPassing = Object.keys(geo.products).filter((hs4) => excluded.has(hs4) && gate1(geo.products[hs4], georgiaLatestYears, cfg).pass);
  log(`Georgia: ${Object.keys(geo.products).length} products with domestic exports; ${gate1Codes.length} pass gate 1 (${georgiaLatestYears.join('/')}); excluded national codes passing: ${excludedPassing.join(',') || 'none'}`);

  const destinations = {};
  for (const hs4 of gate1Codes) {
    destinations[hs4] = await geostat.domesticExportsByDestination(hs4, georgiaYears, allGeostatIds);
  }
  const georgia = { products: geo.products, total: geo.total, destinations };

  // ── 4 + 5. Per cohort: world, then partners ──────────────────────────
  const summary = { asOf, runDate, cohorts: {}, partners: [], rcaTiers: { full: 0, partial: 0, none: 0, missing: 0 }, newHs2022Headings: NEW_IN_HS2022 };
  fs.mkdirSync(outDir, { recursive: true });

  for (const cohort of cohorts) {
    const partners = wanted(cohort);
    if (!partners.length) continue;
    const worldSet = quick ? partners : cohort.members;
    log(`cohort ${cohort.key}: loading world figures from ${worldSet.length} reporters x ${cohort.window.length} years${quick ? ' (QUICK: partial world)' : ''}`);
    const acc = {};
    const loadWorld = async (codes, year, flow) => {
      let res;
      try {
        res = await comtrade.getTrade({ reporterCode: codes, period: year, flowCode: flow, partnerCode: 0, cmdCode: 'AG4' }, { budget });
      } catch (err) {
        if (err.timedOut && codes.length > 1) {
          log(`server timeout on ${codes.length} reporters; splitting`);
          const half = Math.ceil(codes.length / 2);
          await loadWorld(codes.slice(0, half), year, flow);
          await loadWorld(codes.slice(half), year, flow);
          return;
        }
        throw err;
      }
      const { rows, truncated } = res;
      if (truncated && codes.length > 1) {
        const half = Math.ceil(codes.length / 2);
        await loadWorld(codes.slice(0, half), year, flow);
        await loadWorld(codes.slice(half), year, flow);
        return;
      }
      if (truncated) log(`WARNING: ${codes[0]} ${year} ${flow} truncated at the record cap`);
      aggregateWorldRows(rows, acc);
    };
    for (const year of cohort.window) {
      for (const codes of chunk(worldSet.map((m) => m.code), p.comtrade.worldChunkReporters)) {
        await loadWorld(codes, year, 'M');
        await loadWorld(codes, year, 'X');
      }
    }
    const missingWorld = worldSet.filter((m) => !acc.byReporter[m.iso3]);
    if (missingWorld.length) log(`WARNING: no world rows for ${missingWorld.map((m) => m.iso3).join(',')}`);
    summary.cohorts[cohort.key] = { T: cohort.T, window: cohort.window, worldReporters: worldSet.length, partialWorld: quick };

    // Partners ordered by Georgia's domestic exports to them (largest first).
    const geoExportsTo = (m) => {
      const id = geostatIdByIso3.get(m.iso3) ?? (m.iso3 === 'S19' ? geostatIdByIso3.get('TWN') : undefined);
      if (id == null) return 0;
      let s = 0;
      for (const hs4 of gate1Codes) for (const v of Object.values((destinations[hs4] || {})[String(id)] || {})) s += v;
      return s;
    };
    partners.sort((a, b) => geoExportsTo(b) - geoExportsTo(a));

    for (const m of partners) {
      const rep = acc.byReporter[m.iso3];
      if (!rep) { log(`${m.iso3}: skipped, no world-side rows`); continue; }
      const supplierRows = [];
      const loadSuppliers = async (years) => {
        let res;
        try {
          res = await comtrade.getTrade({ reporterCode: m.code, period: years, flowCode: 'M', cmdCode: gate1Codes }, { budget });
        } catch (err) {
          if (err.timedOut && years.length > 1) {
            log(`${m.iso3}: server timeout; splitting years`);
            const half = Math.ceil(years.length / 2);
            await loadSuppliers(years.slice(0, half));
            await loadSuppliers(years.slice(half));
            return;
          }
          throw err;
        }
        const { rows, truncated } = res;
        if (truncated && years.length > 1) {
          const half = Math.ceil(years.length / 2);
          await loadSuppliers(years.slice(0, half));
          await loadSuppliers(years.slice(half));
          return;
        }
        if (truncated) log(`WARNING: ${m.iso3} ${years.join('/')} supplier breakdown truncated`);
        supplierRows.push(...rows);
      };
      for (const years of chunk(cohort.window, p.comtrade.partnerYearsPerCall)) await loadSuppliers(years);
      const { suppliers, supplierIso } = aggregateSupplierRows(supplierRows);
      const partner = { iso3: m.iso3, imports: rep.imports, exports: rep.exports, suppliers, supplierIso };
      // Comtrade files Taiwan under "Other Asia, nes" (S19); Geostat lists it as TWN.
      const geostatId = geostatIdByIso3.get(m.iso3) ?? (m.iso3 === 'S19' ? geostatIdByIso3.get('TWN') : undefined);
      if (geostatId == null) log(`${m.iso3}: no Geostat country id; Georgia's exports to it count as zero`);

      const products = [];
      const watch = [];
      for (const hs4 of gate1Codes) {
        const input = buildInput({
          hs4, T: cohort.T, partner, world: acc.world, georgia, georgiaLatestYears, trackRecordYears,
          distances: (a, b) => distanceKm(a, b, p.distanceMeasure), geostatIdOfPartner: geostatId, georgiaCode: String(cfg.georgiaSupplierCode),
        });
        const r = evaluate(input, cfg);
        if (r.status === 'rated') {
          products.push(r);
          const lvl = r.indicators.rca.level;
          summary.rcaTiers[lvl in summary.rcaTiers ? lvl : 'missing']++;
        } else if (r.status === 'watch') {
          watch.push({ hs4: r.hs4, yearsWithImports: r.yearsWithImports, imports: r.imports });
        }
      }
      const area = (areasByIso.get(m.iso3) || []).find((a) => a.code === m.code) || (areasByIso.get(m.iso3) || [])[0];
      const result = {
        schemaVersion: 1,
        sample: false,
        partner: {
          iso3: m.iso3,
          m49: geostatId ?? null,
          comtradeCode: m.code,
          iso2: (area && area.iso2) || null,
          nameEn: (geostatId != null && geoLabelEn.get(geostatId)) || (area && area.text) || m.name,
          nameKa: (geostatId != null && geoLabelKa.get(geostatId)) || (area && area.text) || m.name,
        },
        dataYear: cohort.T,
        window: { start: cohort.window[0], end: cohort.T, years: cohort.window },
        tradeSource: { id: 'comtrade', label: 'UN Comtrade', edition: 'HS2022', editionsByYear: cohort.window.reduce((o, y) => { o[y] = m.years[y]; return o; }, {}) },
        georgiaSource: { id: 'geostat', label: 'Geostat', latestYears: georgiaLatestYears },
        pipeline: { runDate, asOfYear: asOf, configVersion: cfg.version, cohort: cohort.key, worldReporters: worldSet.length, partialWorld: quick || undefined },
        products,
        watch,
      };
      const counts = { High: 0, Moderate: 0, Low: 0 };
      for (const pr of products) counts[pr.rating]++;
      fs.writeFileSync(path.join(outDir, `${m.iso3}.json`), JSON.stringify(roundDeep(result)));
      summary.partners.push({ iso3: m.iso3, cohort: cohort.key, T: cohort.T, ...counts, watch: watch.length, georgiaExportsUsd: Math.round(geoExportsTo(m)) });
      log(`${m.iso3} (${result.partner.nameEn}): High ${counts.High}, Moderate ${counts.Moderate}, Low ${counts.Low}, watch ${watch.length}`);
    }
  }

  if (!quick) {
    const { writeIndex } = require('./write-index');
    const idx = writeIndex(outDir);
    log(`index: ${idx.count} countries in ${idx.dest}`);
  }
  const summaryPath = path.join(outDir, '..', `summary-${asOf}${quick ? '-quick' : ''}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  log(`done: ${summary.partners.length} partners written to ${outDir}; summary at ${summaryPath}; Comtrade calls today: ${comtrade.readBudget().calls}`);
}

if (require.main === module) main().catch((err) => {
  if (err instanceof comtrade.BudgetExhausted) {
    log(`${err.message}. Completed partners are written; re-run tomorrow to continue (cached calls are free).`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
