/**
 * UN Comtrade client for the export potential pipeline.
 *
 *   - key from COMTRADE_API_KEY (never committed); COMTRADE_API_KEY_SECONDARY
 *     is used when the primary is rejected
 *   - every response cached on disk (cache.js); a cache hit costs no call
 *   - one call per second, retries with backoff on 429 / 5xx / network errors
 *   - a daily call budget (config.pipeline.comtrade.dailyCallBudget) tracked
 *     in cache/comtrade/budget.json so a long load stops cleanly and resumes
 *     the next day
 *   - totals only: partner2Code=0, customsCode=C00, motCode=0 (without them
 *     a single reporter-year explodes into 100k breakdown rows)
 *   - a response that hits the 100k record cap is reported as truncated so
 *     the caller can split the request
 *
 * Data availability (getDA) is public and not counted against the budget.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_ROOT, cacheKey, readCache, writeCache, sleep } = require('./cache');

const BASE = 'https://comtradeapi.un.org';
const RECORD_CAP = 100000;

let lastCallAt = 0;
let keyIndex = 0;

function keys() {
  return [process.env.COMTRADE_API_KEY, process.env.COMTRADE_API_KEY_SECONDARY].filter(Boolean);
}

function log(msg) {
  process.stderr.write(`[comtrade ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

// ── Daily budget ────────────────────────────────────────────────────────────
const budgetPath = path.join(CACHE_ROOT, 'comtrade', 'budget.json');

function readBudget() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const b = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
    if (b.date === today) return b;
  } catch (_) { /* first call today */ }
  return { date: today, calls: 0 };
}

function recordCall() {
  const b = readBudget();
  b.calls += 1;
  fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
  fs.writeFileSync(budgetPath, JSON.stringify(b));
  return b;
}

class BudgetExhausted extends Error {}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function rawGet(url, { useKey, timeoutMs }) {
  const wait = 1100 - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  const headers = { Accept: 'application/json' };
  if (useKey) {
    const ks = keys();
    if (!ks.length) throw new Error('COMTRADE_API_KEY is not set');
    headers['Ocp-Apim-Subscription-Key'] = ks[keyIndex % ks.length];
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { useKey = true, timeoutMs = 15 * 60 * 1000, retries = 4 } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let r;
    try {
      r = await rawGet(url, { useKey, timeoutMs });
    } catch (err) {
      if (attempt > retries) throw err;
      log(`network error (${err.message}); retry ${attempt}`);
      await sleep(5000 * attempt);
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      if (keys().length > 1 && attempt <= retries) { keyIndex++; log(`key rejected (${r.status}); switching key`); continue; }
      throw new Error(`Comtrade ${r.status}: ${r.text.slice(0, 200)}`);
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempt > retries) throw new Error(`Comtrade ${r.status} after ${retries} retries: ${r.text.slice(0, 200)}`);
      const backoff = r.status === 429 ? 60000 : 15000 * attempt;
      log(`HTTP ${r.status}; waiting ${backoff / 1000}s then retry ${attempt}`);
      await sleep(backoff);
      continue;
    }
    if (r.status !== 200) throw new Error(`Comtrade ${r.status}: ${r.text.slice(0, 200)}`);
    let json;
    try {
      json = JSON.parse(r.text);
    } catch (err) {
      throw new Error(`Comtrade returned non-JSON (${r.text.slice(0, 120)})`);
    }
    if (json.errorMessage || json.error) throw new Error(`Comtrade error: ${json.errorMessage || json.error}`);
    return json;
  }
}

function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return q.toString();
}

// ── Data availability (public) ──────────────────────────────────────────────
// Returns [{ reporterCode, reporterISO, reporterDesc, period, classificationCode, totalRecords }]
async function getDataAvailability(periods) {
  const params = { period: periods };
  const key = cacheKey({ da: params });
  const cached = readCache('comtrade', key);
  // Availability changes as countries publish; keep a cached copy for a day.
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return cached.data;
  const url = `${BASE}/public/v1/getDA/C/A/HS?${buildQuery(params)}`;
  log(`GET availability ${periods.join(',')}`);
  const json = await getJson(url, { useKey: false, timeoutMs: 120000 });
  const data = (json.data || []).map((r) => ({
    reporterCode: r.reporterCode,
    reporterISO: r.reporterISO,
    reporterDesc: r.reporterDesc,
    period: Number(r.period),
    classificationCode: r.classificationCode,
    totalRecords: r.totalRecords,
  }));
  writeCache('comtrade', key, { params, fetchedAt: Date.now(), data });
  return data;
}

// ── Reference lists (public) ────────────────────────────────────────────────
async function getPartnerAreas() {
  const key = cacheKey({ ref: 'partnerAreas' });
  const cached = readCache('comtrade', key);
  if (cached) return cached.data;
  const json = await getJson(`${BASE}/files/v1/app/reference/partnerAreas.json`, { useKey: false, timeoutMs: 60000 });
  const data = (json.results || []).map((x) => ({
    code: Number(x.id), text: x.text, iso3: x.PartnerCodeIsoAlpha3 || null, iso2: x.PartnerCodeIsoAlpha2 || null, isGroup: !!x.isGroup,
  }));
  writeCache('comtrade', key, { fetchedAt: Date.now(), data });
  return data;
}

// ── Trade data (metered) ────────────────────────────────────────────────────
// get({ reporterCode, period, flowCode, partnerCode, cmdCode }) -> rows
// rows: { reporterCode, reporterISO, period, flowCode, partnerCode, partnerISO,
//         cmdCode, classificationCode, primaryValue }
// includeDesc=false leaves the ISO fields empty, so they are filled from the
// public reference list (Comtrade's own codes: 842 USA, 251 France, ...).
let isoByCode = null;
async function withIso(rows) {
  if (!isoByCode) {
    isoByCode = new Map();
    for (const a of await getPartnerAreas()) if (!isoByCode.has(a.code)) isoByCode.set(a.code, a.iso3);
  }
  for (const r of rows) {
    if (!r.reporterISO) r.reporterISO = isoByCode.get(r.reporterCode) || String(r.reporterCode);
    if (!r.partnerISO) r.partnerISO = isoByCode.get(r.partnerCode) || String(r.partnerCode);
  }
  return rows;
}

async function getTrade(params, { budget = Infinity } = {}) {
  const full = {
    typeCode: 'C', freqCode: 'A', clCode: 'HS',
    reporterCode: params.reporterCode,
    period: params.period,
    flowCode: params.flowCode,
    partnerCode: params.partnerCode, // undefined -> all partners
    cmdCode: params.cmdCode,
    partner2Code: 0, customsCode: 'C00', motCode: 0, includeDesc: false,
  };
  const key = cacheKey({ trade: full });
  const cached = readCache('comtrade', key);
  if (cached) return { rows: await withIso(cached.rows), truncated: cached.truncated, fromCache: true };

  const b = readBudget();
  if (b.calls >= budget) throw new BudgetExhausted(`daily Comtrade budget reached (${b.calls} calls today)`);

  const { typeCode, freqCode, clCode, ...query } = full;
  const url = `${BASE}/data/v1/get/${typeCode}/${freqCode}/${clCode}?${buildQuery(query)}`;
  const label = `${Array.isArray(full.reporterCode) ? full.reporterCode.length + ' reporters' : full.reporterCode} ${Array.isArray(full.period) ? full.period.join('/') : full.period} ${full.flowCode} ${full.partnerCode == null ? 'all partners' : 'p' + full.partnerCode} ${Array.isArray(full.cmdCode) ? full.cmdCode.length + ' codes' : full.cmdCode}`;
  log(`GET ${label} (call ${b.calls + 1} today)`);
  const t0 = Date.now();
  recordCall();
  const json = await getJson(url);
  const data = json.data || [];
  const rows = data.map((r) => ({
    reporterCode: r.reporterCode,
    reporterISO: r.reporterISO,
    period: Number(r.period),
    flowCode: r.flowCode,
    partnerCode: r.partnerCode,
    partnerISO: r.partnerISO,
    cmdCode: String(r.cmdCode),
    classificationCode: r.classificationCode,
    primaryValue: Number(r.primaryValue) || 0,
  }));
  const truncated = (json.count || 0) >= RECORD_CAP || data.length >= RECORD_CAP;
  log(`  ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s${truncated ? ' (TRUNCATED)' : ''}`);
  writeCache('comtrade', key, { params: full, fetchedAt: Date.now(), count: json.count, truncated, rows });
  return { rows: await withIso(rows), truncated, fromCache: false };
}

module.exports = { getDataAvailability, getPartnerAreas, getTrade, readBudget, BudgetExhausted, RECORD_CAP };
