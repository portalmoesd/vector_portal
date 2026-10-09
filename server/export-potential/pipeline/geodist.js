/**
 * Distances between countries from the committed GeoDist table
 * (server/data/export-potential/geodist.json, built by build-geodist.js).
 * Looks up by ISO3; GeoDist's pre-2000 codes are aliased, and Comtrade's
 * "Other Asia, nes" (S19) is read as Taiwan.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'export-potential', 'geodist.json');

const ALIASES = {
  ROU: 'ROM', SRB: 'YUG', MNE: 'YUG', COD: 'ZAR', TLS: 'TMP', PSE: 'PAL', SSD: 'SDN', S19: 'TWN',
  XKX: 'YUG', // Kosovo: not in GeoDist; nearest available entry
};

let table = null;
function load() {
  if (!table) table = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return table;
}

function norm(iso3) {
  const c = String(iso3 || '').trim().toUpperCase();
  return ALIASES[c] || c;
}

// km between two ISO3 countries for the chosen measure ('dist' | 'distw'), or null.
function distanceKm(fromIso3, toIso3, measure = 'dist') {
  const t = load();
  const m = t[measure] || t.dist;
  const a = norm(fromIso3); const b = norm(toIso3);
  const v = (m[a] && m[a][b]) ?? (m[b] && m[b][a]);
  return Number.isFinite(v) ? v : null;
}

module.exports = { distanceKm, FILE };
