/**
 * Pure assembly helpers for the pipeline: turn the loaded tables into the
 * input shape scoring.evaluate() expects. No I/O here, so the tests can
 * feed small hand-made tables.
 *
 * Tables:
 *   world.imports[hs4][year], world.exports[hs4][year], world.exportsTotal[year]
 *   partner.imports[hs4][year], partner.exports[hs4][year]      (this reporter)
 *   partner.suppliers[hs4][partnerCode][year]                    (this reporter's imports by supplier)
 *   partner.supplierIso[partnerCode] = ISO3
 *   georgia.products[hs4][year] (domestic exports, all destinations)
 *   georgia.total[year]
 *   georgia.destinations[hs4][geostatCountryId][year]
 */
'use strict';

const { toHs2022 } = require('./concordance');

// Sum Comtrade rows (reporter x product x year, partner = world) into
// per-reporter and world tables. Rows carry classificationCode so older
// editions are mapped onto HS2022 headings first.
function aggregateWorldRows(rows, acc) {
  acc.byReporter = acc.byReporter || {};
  acc.world = acc.world || { imports: {}, exports: {}, exportsTotal: {}, importsTotal: {} };
  for (const r of rows) {
    if (r.partnerCode !== 0) continue;
    const hs4 = toHs2022(r.cmdCode, r.classificationCode);
    const flow = r.flowCode === 'M' ? 'imports' : r.flowCode === 'X' ? 'exports' : null;
    if (!flow) continue;
    const rep = (acc.byReporter[r.reporterISO] = acc.byReporter[r.reporterISO] || { imports: {}, exports: {} });
    const t = (rep[flow][hs4] = rep[flow][hs4] || {});
    t[r.period] = (t[r.period] || 0) + r.primaryValue;
    const w = (acc.world[flow][hs4] = acc.world[flow][hs4] || {});
    w[r.period] = (w[r.period] || 0) + r.primaryValue;
    const tot = acc.world[`${flow}Total`];
    tot[r.period] = (tot[r.period] || 0) + r.primaryValue;
  }
  return acc;
}

// Comtrade rows (one reporter, imports by partner) -> suppliers[hs4][partnerCode][year]
function aggregateSupplierRows(rows) {
  const suppliers = {};
  const supplierIso = {};
  for (const r of rows) {
    if (r.flowCode !== 'M' || r.partnerCode === 0) continue;
    const hs4 = toHs2022(r.cmdCode, r.classificationCode);
    const code = String(r.partnerCode);
    supplierIso[code] = r.partnerISO || null;
    const t = (suppliers[hs4] = suppliers[hs4] || {});
    const s = (t[code] = t[code] || {});
    s[r.period] = (s[r.period] || 0) + r.primaryValue;
  }
  return { suppliers, supplierIso };
}

// Everything evaluate() needs for one partner x product.
function buildInput({ hs4, T, partner, world, georgia, georgiaLatestYears, trackRecordYears, distances, geostatIdOfPartner, georgiaCode }) {
  const supplierImports = (partner.suppliers && partner.suppliers[hs4]) || {};
  const supplierKm = {};
  let anyDistance = false;
  for (const code of Object.keys(supplierImports)) {
    const iso = partner.supplierIso[code];
    const km = iso && distances ? distances(partner.iso3, iso) : null;
    if (km != null) { supplierKm[code] = km; anyDistance = true; }
  }
  const georgiaKm = distances ? distances(partner.iso3, 'GEO') : null;
  const destinations = (georgia.destinations && georgia.destinations[hs4]) || {};
  const exportsToPartner = geostatIdOfPartner != null ? (destinations[String(geostatIdOfPartner)] || {}) : {};
  return {
    hs4,
    T,
    partnerImports: (partner.imports && partner.imports[hs4]) || {},
    partnerExports: (partner.exports && partner.exports[hs4]) || {},
    worldImports: (world.imports && world.imports[hs4]) || {},
    supplierImports,
    georgia: {
      latestYears: georgiaLatestYears,
      trackRecordYears,
      domesticExportsProduct: (georgia.products && georgia.products[hs4]) || {},
      domesticExportsTotal: georgia.total || {},
      exportsToPartner,
    },
    world: {
      exportsProduct: (world.exports && world.exports[hs4]) || {},
      exportsTotal: world.exportsTotal || {},
    },
    tariff: null, // version 1: no tariff data; scored as Equal and flagged
    distance: georgiaKm != null && anyDistance ? { georgiaKm, supplierKm: { ...supplierKm, [georgiaCode]: georgiaKm } } : null,
  };
}

module.exports = { aggregateWorldRows, aggregateSupplierRows, buildInput };
