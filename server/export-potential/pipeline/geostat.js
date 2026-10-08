/**
 * Geostat external-trade API client for the pipeline (domestic exports by
 * HS4, by destination, by year). Same transport quirks as the portal's
 * statistics proxy (leaf-only TLS chain, explicit Content-Length), every
 * response cached on disk, one call per second.
 */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const { cacheKey, readCache, writeCache, sleep } = require('./cache');

const BASE = 'https://ex-trade-api.geostat.ge/api/trade';
// Geostat serves a leaf-only certificate chain (see server/routes/statistics.js),
// so verification is relaxed for this host only.
const agent = new https.Agent({ rejectUnauthorized: false });
let lastCallAt = 0;

// When the environment routes outbound HTTPS through a proxy (HTTPS_PROXY),
// open a CONNECT tunnel and run TLS over it; https.request ignores the
// variable on its own.
function openSocket(hostname) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return Promise.resolve(null);
  const pu = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: pu.hostname, port: pu.port || 80, method: 'CONNECT', path: `${hostname}:443` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
      resolve(tls.connect({ socket, servername: hostname, rejectUnauthorized: false }));
    });
    req.on('error', reject);
    req.end();
  });
}

function log(msg) {
  process.stderr.write(`[geostat ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

async function request(path, body) {
  const u = new URL(`${BASE}${path}`);
  if (!u.hostname.endsWith('.geostat.ge')) throw new Error('refused non-geostat host');
  const socket = await openSocket(u.hostname);
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', 'User-Agent': 'VectorPortal/1.0 export-potential' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const opts = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: payload ? 'POST' : 'GET', headers };
    if (socket) opts.createConnection = () => socket; else opts.agent = agent;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`Geostat ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`Geostat non-JSON: ${text.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Geostat timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(path, body, { ttlMs = Infinity } = {}) {
  const key = cacheKey({ geostat: { path, body } });
  const cached = readCache('geostat', key);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.data;
  const wait = 1000 - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      data = await request(path, body);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      log(`${err.message}; retry ${attempt}`);
      await sleep(5000 * attempt);
    }
  }
  writeCache('geostat', key, { path, body, fetchedAt: Date.now(), data });
  return data;
}

function num(v) {
  if (v == null || v === '' || v === '-') return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

const USD_COL = /^usd1000_(\d{4})$/;

// Year columns of a row -> { year: usd } (Geostat reports thousand USD).
function yearValues(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const m = USD_COL.exec(k);
    if (m) out[Number(m[1])] = num(row[k]) * 1000;
  }
  return out;
}

async function classificatory(lang) {
  const data = await call(`/classificatory?lang=${lang}`, null, { ttlMs: 7 * 24 * 3600 * 1000 });
  return data.data;
}

// Georgia's domestic exports (flow 12) of every HS4 product, per year.
// Returns { total: { year: usd }, products: { hs4: { year: usd } } }
async function domesticExportsByProduct(years) {
  log(`domestic exports by HS4 for ${years.join(',')}`);
  const total = {};
  const products = {};
  for (let page = 1; page < 20; page++) {
    const json = await call('/get_data', {
      tradeFlow: 12, measurementUnits: [1], years, hs4: ['all'], locale: 'en', sum: true, page, pageSize: 500,
    });
    const rows = (json && json.data) || [];
    for (const r of rows) {
      if (r.isGroupSummary) { Object.assign(total, yearValues(r)); continue; }
      if (r.hs4 == null) continue;
      products[String(r.hs4).padStart(4, '0')] = yearValues(r);
    }
    if (rows.length < 500) break;
  }
  return { total, products };
}

// Georgia's domestic exports of one HS4 product by destination, per year.
// Returns { geostatCountryId: { year: usd } }
async function domesticExportsByDestination(hs4, years, countryIds) {
  const out = {};
  for (let page = 1; page < 10; page++) {
    const json = await call('/get_data', {
      tradeFlow: 12, measurementUnits: [1], years, hs4: [Number(hs4)], countries: countryIds, locale: 'en', page, pageSize: 500,
    });
    const rows = (json && json.data) || [];
    let n = 0;
    for (const r of rows) {
      if (r.isGroupSummary || r.country == null) continue;
      n++;
      const cid = String(r.country);
      const vals = yearValues(r);
      out[cid] = out[cid] || {};
      for (const [y, v] of Object.entries(vals)) out[cid][y] = (out[cid][y] || 0) + v;
    }
    if (rows.length < 500 || n === 0) break;
  }
  return out;
}

module.exports = { classificatory, domesticExportsByProduct, domesticExportsByDestination };
