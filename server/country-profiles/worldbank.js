/**
 * World Bank World Development Indicators (WDI) — fetch and parse.
 *
 * Pure parsing functions (parseCountryList, parseIndicatorPage, slugify) take
 * the decoded JSON the API returns and produce plain rows; they never touch
 * the network or the database, so the sync can be unit-tested offline. The
 * fetch helpers wrap the API's two endpoints with a timeout and retries.
 *
 * Names, regions and income groups are taken verbatim from the source. No
 * territory is added, renamed or dropped here beyond excluding the API's own
 * aggregates (entries whose region id is "NA").
 */
'use strict';

const API_BASE = 'https://api.worldbank.org/v2';

const SOURCE = {
  id: 'worldbank-wdi',
  name: 'World Bank, World Development Indicators',
  url: 'https://data.worldbank.org/',
  license: 'CC BY 4.0',
};

// The indicators the profile page shows, with the section each belongs to
// and a unit hint for formatting. Display names come from the API response
// (the source's own wording); `fallbackName` is used only if a pull returns
// no rows at all.
const INDICATORS = [
  { code: 'SP.POP.TOTL', section: 'people', unit: 'count', order: 10, fallbackName: 'Population, total' },
  { code: 'AG.SRF.TOTL.K2', section: 'overview', unit: 'sqkm', order: 20, fallbackName: 'Surface area (sq. km)' },
  { code: 'NY.GDP.MKTP.CD', section: 'economy', unit: 'usd', order: 30, fallbackName: 'GDP (current US$)' },
  { code: 'NY.GDP.PCAP.CD', section: 'economy', unit: 'usd', order: 40, fallbackName: 'GDP per capita (current US$)' },
  { code: 'NY.GDP.MKTP.KD.ZG', section: 'economy', unit: 'pct', order: 50, fallbackName: 'GDP growth (annual %)' },
  { code: 'FP.CPI.TOTL.ZG', section: 'economy', unit: 'pct', order: 60, fallbackName: 'Inflation, consumer prices (annual %)' },
  { code: 'SL.UEM.TOTL.ZS', section: 'economy', unit: 'pct', order: 70, fallbackName: 'Unemployment, total (% of total labor force) (modeled ILO estimate)' },
  { code: 'NE.EXP.GNFS.CD', section: 'trade', unit: 'usd', order: 80, fallbackName: 'Exports of goods and services (current US$)' },
  // Goods only, customs basis (WTO figures as republished in WDI).
  { code: 'TX.VAL.MRCH.CD.WT', section: 'trade', unit: 'usd', order: 82, fallbackName: 'Merchandise exports (current US$)' },
  { code: 'NE.IMP.GNFS.CD', section: 'trade', unit: 'usd', order: 90, fallbackName: 'Imports of goods and services (current US$)' },
  { code: 'TM.VAL.MRCH.CD.WT', section: 'trade', unit: 'usd', order: 92, fallbackName: 'Merchandise imports (current US$)' },
  { code: 'SP.DYN.LE00.IN', section: 'people', unit: 'years', order: 100, fallbackName: 'Life expectancy at birth, total (years)' },
  { code: 'SP.URB.TOTL.IN.ZS', section: 'people', unit: 'pct', order: 110, fallbackName: 'Urban population (% of total population)' },
];

const COUNTRY_PER_PAGE = 400;
const INDICATOR_PER_PAGE = 20000;

function countryListUrl() {
  return `${API_BASE}/country?format=json&per_page=${COUNTRY_PER_PAGE}`;
}

function indicatorUrl(code, page = 1) {
  const p = page > 1 ? `&page=${page}` : '';
  return `${API_BASE}/country/all/indicator/${encodeURIComponent(code)}?format=json&per_page=${INDICATOR_PER_PAGE}${p}`;
}

// URL-safe slug from the source name: "Hong Kong SAR, China" -> "hong-kong-sar-china".
function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The API signals a bad request as a one-element array holding a `message`
// list instead of the usual [meta, rows] pair. Surface that as an error so
// a changed or retired code is reported, never worked around.
function apiErrorMessage(json) {
  if (Array.isArray(json) && json.length === 1 && json[0] && Array.isArray(json[0].message)) {
    return json[0].message.map((m) => [m.id, m.key, m.value].filter(Boolean).join(' ')).join('; ') || 'API error';
  }
  return null;
}

function assertPair(json, what) {
  const apiErr = apiErrorMessage(json);
  if (apiErr) throw new Error(`${what}: API returned an error: ${apiErr}`);
  if (!Array.isArray(json) || json.length < 2 || !json[0] || typeof json[0] !== 'object' || !Array.isArray(json[1])) {
    throw new Error(`${what}: unexpected response shape`);
  }
}

/**
 * Parse the /country response. Returns the economies (aggregates excluded)
 * and the list of excluded aggregate entries for the log.
 */
function parseCountryList(json) {
  assertPair(json, 'country list');
  const [meta, rows] = json;
  if (Number(meta.pages) > 1) {
    throw new Error(`country list: ${meta.total} entries span ${meta.pages} pages; raise per_page`);
  }
  const countries = [];
  const aggregates = [];
  const seenSlugs = new Map();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    const regionId = r.region && r.region.id;
    if (!regionId || regionId === 'NA') { aggregates.push({ iso3: r.id, name: r.name }); continue; }
    const c = {
      iso3: r.id.toUpperCase(),
      iso2: r.iso2Code ? String(r.iso2Code).toUpperCase() : null,
      name: r.name.trim(),
      slug: slugify(r.name),
      regionId: regionId.trim(),
      regionName: (r.region.value || '').trim(),
      incomeId: (r.incomeLevel && r.incomeLevel.id || '').trim() || null,
      incomeName: (r.incomeLevel && r.incomeLevel.value || '').trim() || null,
      capital: (r.capitalCity || '').trim() || null,
      longitude: toNumber(r.longitude),
      latitude: toNumber(r.latitude),
    };
    if (!c.slug) c.slug = c.iso3.toLowerCase();
    if (seenSlugs.has(c.slug)) c.slug = `${c.slug}-${c.iso3.toLowerCase()}`;
    seenSlugs.set(c.slug, c.iso3);
    countries.push(c);
  }
  return { countries, aggregates, total: Number(meta.total) || rows.length };
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one page of /country/all/indicator/{code}. Rows with a null value or
 * without an ISO3 code (some aggregates) are dropped; "No data" on the page
 * is the absence of a row, never a stored placeholder.
 */
function parseIndicatorPage(json, code) {
  assertPair(json, `indicator ${code}`);
  const [meta, rows] = json;
  let indicatorName = null;
  const out = [];
  for (const r of rows) {
    if (!r || !r.indicator) continue;
    if (code && r.indicator.id !== code) throw new Error(`indicator ${code}: response carries ${r.indicator.id}`);
    if (!indicatorName && r.indicator.value) indicatorName = String(r.indicator.value).trim();
    const iso3 = (r.countryiso3code || '').trim().toUpperCase();
    const year = Number(r.date);
    const value = r.value == null ? null : Number(r.value);
    if (!/^[A-Z0-9]{3}$/.test(iso3) || !Number.isInteger(year) || value == null || !Number.isFinite(value)) continue;
    out.push({ iso3, year, value });
  }
  return {
    meta: {
      page: Number(meta.page) || 1,
      pages: Number(meta.pages) || 1,
      total: Number(meta.total) || 0,
      lastUpdated: meta.lastupdated || null,
    },
    indicatorName,
    rows: out,
  };
}

// Latest available year per (iso3) from a flat row list — used by tests and
// by the sync log; the pages compute it in SQL.
function latestByCountry(rows) {
  const latest = new Map();
  for (const r of rows) {
    const cur = latest.get(r.iso3);
    if (!cur || r.year > cur.year) latest.set(r.iso3, r);
  }
  return latest;
}

// ── Network ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a JSON document with a timeout and exponential-backoff retries. The
 * WDI API is sometimes slow (30–90 s for a 17k-row indicator), so the
 * default timeout is generous.
 */
async function fetchJson(url, { timeoutMs = 120000, retries = 3, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch (_) { throw new Error('response is not JSON'); }
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`timed out after ${timeoutMs / 1000}s`) : err;
      if (attempt < retries) {
        const wait = 2000 * 2 ** attempt;
        log(`${url} failed (${lastErr.message}); retry ${attempt + 1}/${retries} in ${wait / 1000}s`);
        await sleep(wait);
      }
    } finally {
      clearTimeout(timer);
    }
    attempt++;
  }
  throw lastErr;
}

async function fetchCountryList(opts) {
  const url = countryListUrl();
  const json = await fetchJson(url, opts);
  return { url, ...parseCountryList(json) };
}

/**
 * Fetch every page of one indicator and return the merged rows. The first
 * page's URL is recorded as the source URL for the stored values.
 */
async function fetchIndicator(code, opts) {
  const url = indicatorUrl(code, 1);
  const first = parseIndicatorPage(await fetchJson(url, opts), code);
  const rows = [...first.rows];
  let indicatorName = first.indicatorName;
  for (let page = 2; page <= first.meta.pages; page++) {
    const next = parseIndicatorPage(await fetchJson(indicatorUrl(code, page), opts), code);
    rows.push(...next.rows);
    indicatorName = indicatorName || next.indicatorName;
  }
  return { url, meta: first.meta, indicatorName, rows };
}

module.exports = {
  API_BASE, SOURCE, INDICATORS,
  countryListUrl, indicatorUrl, slugify,
  parseCountryList, parseIndicatorPage, latestByCountry, apiErrorMessage,
  fetchJson, fetchCountryList, fetchIndicator,
};
