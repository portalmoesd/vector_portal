/**
 * Disk cache for raw source responses. Every call to a rate-limited source
 * is cached under server/export-potential/cache/<source>/<sha1>.json, so a
 * stopped run resumes without repeating calls. The cache folder is
 * git-ignored: raw Comtrade records are never committed (publishing rule).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_ROOT = process.env.EXPORT_POTENTIAL_CACHE || path.join(__dirname, '..', 'cache');

// Canonical JSON: object keys sorted recursively, so the same request always
// yields the same key whatever the property order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function cacheKey(obj) {
  return crypto.createHash('sha1').update(canonical(obj)).digest('hex');
}

function cachePath(source, key) {
  return path.join(CACHE_ROOT, source, `${key}.json`);
}

function readCache(source, key) {
  const p = cachePath(source, key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(source, key, payload) {
  const p = cachePath(source, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { CACHE_ROOT, cacheKey, canonical, readCache, writeCache, sleep };
