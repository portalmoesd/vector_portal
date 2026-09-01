/**
 * Statistics proxy — relays requests to ex-trade-api.geostat.ge
 * and provides parsed FDI data from geostat.ge XLSX files.
 */
const express = require('express');
const XLSX = require('xlsx');
const https = require('node:https');
const router = express.Router();

const GEOSTAT_BASE = 'https://ex-trade-api.geostat.ge/api/trade';

// Geostat's HTTPS endpoints serve only the leaf cert, no intermediate.
// Browsers cache intermediates and paper over this; Node does not, and
// every request fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// Scope a permissive agent to *.geostat.ge ONLY — the rest of the
// process keeps full TLS verification. The route is locked down by
// hostname check inside `geostatHttp` so the agent can't accidentally
// be used elsewhere.
//
// Long-term: retrieve Geostat's missing intermediate cert and set
// NODE_EXTRA_CA_CERTS in Render to its path. Then this agent + the
// env-level NODE_TLS_REJECT_UNAUTHORIZED=0 can both be removed and
// verification is fully strict again.
const geostatAgent = new https.Agent({ rejectUnauthorized: false });

// Lightweight fetch-shaped wrapper around https.request — native fetch
// (undici) can't accept an https.Agent, and pulling undici as a direct
// dep clashes with Node's bundled version (causes UND_ERR_INVALID_ARG).
// Refuses non-geostat.ge hostnames to prevent accidental misuse.
function geostatHttp(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!u.hostname.endsWith('.geostat.ge')) {
      reject(new Error(`geostatHttp refused: ${u.hostname} is not a geostat.ge host`));
      return;
    }
    // Explicit Content-Length: without it Node sends the body chunked,
    // and Geostat's iisnode rejects chunked requests with an HTML error
    // page served as HTTP 200 — poisoning every POST from the server
    // while browser-direct calls (which always set the header) work.
    const headers = { ...(opts.headers || {}) };
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      agent: geostatAgent,
    }, (res) => {
      // Optional manual redirect handling (FDI XLSX path).
      if (opts.followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(geostatHttp(next, opts));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
          buffer: () => buf,
        });
      });
    });
    req.on('error', reject);
    if (opts.timeout) {
      req.setTimeout(opts.timeout, () => req.destroy(new Error('Geostat request timeout')));
    }
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Helper: proxy fetch with timeout ────────────────────────────────────────

async function geostatFetch(path, options = {}) {
  const url = `${GEOSTAT_BASE}${path}`;
  const res = await geostatHttp(url, {
    method: options.method,
    body: options.body,
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'VectorPortal/1.0',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Geostat API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Persisted trade cache (PostgreSQL) ──────────────────────────────────────
// Geostat publishes monthly trade data around the 18th-23rd; everything the
// trade endpoints compute is stable between releases. Computed results are
// kept in memory (fast path) AND in the trade_cache table so deploys don't
// wipe them. All DB failures degrade to the previous in-memory behavior.

const db = require('../db');

async function tradeCacheDbGet(key) {
  try {
    const { rows } = await db.query('SELECT data FROM trade_cache WHERE key = $1', [key]);
    return rows.length ? rows[0].data : null;
  } catch (err) {
    console.warn(`trade_cache get(${key}) failed:`, err.message);
    return null;
  }
}

async function tradeCacheDbSet(key, data) {
  try {
    await db.query(
      `INSERT INTO trade_cache (key, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(data)]
    );
  } catch (err) {
    console.warn(`trade_cache set(${key}) failed:`, err.message);
  }
}

async function tradeCacheDbDeleteByPrefix(prefix) {
  try {
    await db.query(`DELETE FROM trade_cache WHERE key LIKE $1 || '%'`, [prefix]);
  } catch (err) {
    console.warn(`trade_cache delete(${prefix}*) failed:`, err.message);
  }
}

// ── GET /api/statistics/classificatory ──────────────────────────────────────
// Returns countries, trade types, years, months, HS codes, etc.
// Served from a short-TTL cache: the payload only meaningfully changes once
// a month (`selected.month`), and the publication detector below refreshes
// it the moment a new month is spotted. The TTL bounds worst-case staleness
// to a few hours instead of hitting Geostat on every page load.

let classCache = { en: null, ka: null };
let classCacheTs = { en: 0, ka: 0 };
const CLASS_TTL = 3 * 60 * 60 * 1000;

router.get('/classificatory', async (req, res) => {
  const lang = req.query.lang === 'ka' ? 'ka' : 'en';
  if (classCache[lang] && Date.now() - classCacheTs[lang] < CLASS_TTL) {
    return res.json(classCache[lang]);
  }
  try {
    const data = await geostatFetch(`/classificatory?lang=${lang}`);
    classCache[lang] = data;
    classCacheTs[lang] = Date.now();
    tradeCacheDbSet(`classificatory:${lang}`, data);
    // A changed selected period means Geostat just published — kick the
    // detector without holding up this response.
    maybeDetectNewTradeMonth(data);
    res.json(data);
  } catch (err) {
    console.error('Statistics classificatory error:', err.message);
    if (classCache[lang]) {
      console.warn(`Serving stale classificatory (${lang}) from ${new Date(classCacheTs[lang]).toISOString()}`);
      return res.json(classCache[lang]);
    }
    const fromDb = await tradeCacheDbGet(`classificatory:${lang}`);
    if (fromDb) {
      console.warn(`Serving classificatory (${lang}) from DB cache (Geostat unreachable)`);
      classCache[lang] = fromDb; // keep ts=0 so the next request retries live
      return res.json(fromDb);
    }
    res.status(502).json({ error: 'Failed to fetch classificatory data from Geostat' });
  }
});

// ── POST /api/statistics/trade-data ─────────────────────────────────────────
// Proxies to /get_data with pagination

router.post('/trade-data', async (req, res) => {
  try {
    const data = await geostatFetch('/get_data', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (err) {
    console.error('Statistics trade-data error:', err.message);
    res.status(502).json({ error: 'Failed to fetch trade data from Geostat' });
  }
});

// ── POST /api/statistics/export-report ──────────────────────────────────────
// Fetches ALL pages of data for a given filter set (for report generation).
// Returns the complete dataset without pagination.

router.post('/export-report', async (req, res) => {
  try {
    const filters = { ...req.body };
    const allData = [];
    let page = 1;
    const pageSize = 200;
    let total = Infinity;

    while (allData.length < total && page < 100) {
      const result = await geostatFetch('/get_data', {
        method: 'POST',
        body: JSON.stringify({ ...filters, page, pageSize }),
      });

      if (!result.success) {
        throw new Error('Geostat API returned success=false');
      }

      total = result.total || 0;
      if (Array.isArray(result.data)) {
        allData.push(...result.data);
      }

      // Store metadata from first page
      if (page === 1) {
        res._meta = {
          units: result.units,
          type: result.type,
          headers: result.headers,
          missing: result.missing,
        };
      }

      if (!result.data || result.data.length === 0) break;
      page++;
    }

    res.json({
      success: true,
      data: allData,
      total: allData.length,
      ...(res._meta || {}),
    });
  } catch (err) {
    console.error('Statistics export-report error:', err.message);
    res.status(502).json({ error: 'Failed to fetch full report from Geostat' });
  }
});

// ── POST /api/statistics/country-ranking ────────────────────────────────────
// Returns the selected country's rank + share of Georgia totals for the
// given (year, months) across three trade flows. Caches the computed
// all-countries rankings as last-known-good (no TTL) so a transient
// Geostat partial outage can't poison serving from a previous good run.
// LRU eviction keeps the cache bounded at RANKING_CACHE_MAX entries.

const RANKING_CACHE_MAX = 32;
const rankingCache = new Map(); // key -> { data, ts }

function rankingCacheGet(key) {
  const entry = rankingCache.get(key);
  if (!entry) return null;
  return entry.data;
}

function rankingCacheSet(key, data) {
  if (rankingCache.size >= RANKING_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order)
    const oldestKey = rankingCache.keys().next().value;
    if (oldestKey !== undefined) rankingCache.delete(oldestKey);
  }
  rankingCache.set(key, { data, ts: Date.now() });
}

// Memory → DB → compute. Used by the route and by the publication
// detector's prewarm. `debug` is the route's optional _debug collector.
async function getCountryRanking(year, sortedMonths, debug) {
  const cacheKey = `${year}:${sortedMonths.join(',')}`;
  let cached = rankingCacheGet(cacheKey);
  if (cached) {
    if (debug) debug.cacheHit = true;
    return cached;
  }
  const fromDb = await tradeCacheDbGet(`ranking:${cacheKey}`);
  if (fromDb) {
    rankingCacheSet(cacheKey, fromDb);
    if (debug) debug.cacheHit = 'db';
    return fromDb;
  }

  const t0 = Date.now();
  const allCountryIds = await getAllCountryIds();
  if (debug) debug.classificatoryCountries = allCountryIds.length;
  console.log(`country-ranking: computing for ${year}/m${sortedMonths.join(',')}, ${allCountryIds.length} countries`);

  // 4 parallel Geostat calls: export + import + domestic export + re-export.
  // Each passes ALL country IDs + full months array + sum=true.
  const [exp, imp, domExp, reExp] = await Promise.all([
    fetchFlowRanking(10, year, sortedMonths, allCountryIds),
    fetchFlowRanking(11, year, sortedMonths, allCountryIds),
    fetchFlowRanking(12, year, sortedMonths, allCountryIds),
    fetchFlowRanking(13, year, sortedMonths, allCountryIds),
  ]);

  // Compute turnover per country = export + import
  const turnoverMap = {};
  const allCids = new Set([...Object.keys(exp.perCountry), ...Object.keys(imp.perCountry)]);
  let turnoverTotal = 0;
  for (const cid of allCids) {
    const val = (exp.perCountry[cid]?.valueMln || 0) + (imp.perCountry[cid]?.valueMln || 0);
    if (val > 0) turnoverMap[cid] = val;
  }
  // Sort and assign ranks for turnover
  const turnoverEntries = Object.entries(turnoverMap)
    .sort(([, a], [, b]) => b - a);
  turnoverTotal = turnoverEntries.reduce((s, [, v]) => s + v, 0);
  const turnoverRanked = {};
  turnoverEntries.forEach(([cid, valueMln], idx) => {
    turnoverRanked[cid] = {
      valueMln,
      rank: idx + 1,
      sharePct: turnoverTotal > 0 ? (100 * valueMln / turnoverTotal) : 0,
    };
  });

  cached = {
    totals: { turnover: turnoverTotal, export: exp.total, import: imp.total, domesticExport: domExp.total, reExport: reExp.total },
    flows: { turnover: turnoverRanked, export: exp.perCountry, import: imp.perCountry, domesticExport: domExp.perCountry, reExport: reExp.perCountry },
    flowStats: { export: exp.stats, import: imp.stats, domesticExport: domExp.stats, reExport: reExp.stats },
  };
  // Only cache when every flow returned data. Caching a partial
  // result would serve "0" for the empty flow until the entry is
  // replaced, which is exactly the appendix-zeros bug. With the
  // AND gate, a Geostat hiccup that leaves one flow empty means
  // we keep serving the previous good entry (or, on cold cache,
  // the partial response is returned but not stored, so the next
  // request retries).
  const flowCounts = {
    export: exp.stats.withTrade,
    import: imp.stats.withTrade,
    domesticExport: domExp.stats.withTrade,
    reExport: reExp.stats.withTrade,
  };
  const empties = Object.entries(flowCounts).filter(([, n]) => n === 0).map(([k]) => k);
  const allHaveData = empties.length === 0;
  if (!allHaveData && empties.length < 4) {
    console.warn(
      `country-ranking [${cacheKey}]: SKIP CACHE — partial Geostat (empty=${empties.join(',')}); ` +
      `previous good entry (if any) preserved.`
    );
  }
  if (allHaveData) {
    rankingCacheSet(cacheKey, cached);
    await tradeCacheDbSet(`ranking:${cacheKey}`, cached);
  }
  if (debug) {
    debug.computedMs = Date.now() - t0;
    debug.cached = allHaveData;
  }
  console.log(`country-ranking: completed in ${((Date.now() - t0) / 1000).toFixed(1)}s — exp:${exp.stats.withTrade} imp:${imp.stats.withTrade} domExp:${domExp.stats.withTrade} reExp:${reExp.stats.withTrade} countries`);
  return cached;
}

// Geostat row helpers
function extractRowValue(row) {
  for (const key of Object.keys(row)) {
    if (key.startsWith('usd1000_')) {
      const v = parseFloat(row[key]);
      if (!isNaN(v)) return v;
    }
  }
  return 0;
}

function extractRowCountryId(row) {
  // Geostat may use any of these field names for the country identifier.
  return row.country ?? row.country_id ?? row.countryId ?? row.country_code ?? null;
}

async function fetchFlowRanking(tradeFlowCode, year, months, allCountryIds) {
  // Single Geostat call: pass ALL country IDs + all months + NO sum.
  //
  // Earlier versions sent `sum: true` which reliably triggered iisnode
  // 502s on Geostat for some periods/flows (we saw the partial-failure
  // logs). The no-sum shape returns:
  //   - row 0: no `country` field; one `usd1000_<year>` (full year) or
  //     `usd1000_<year>_<m1>_<m2>...` (months-filtered) column carrying
  //     Georgia's total for the period
  //   - rows 1+: per-country with `country: <id>` and the same column
  //     key(s). Strings sometimes ("76019.5336591776"), sometimes
  //     numbers, sometimes the literal "-" when the country had no
  //     trade.

  let rawResponse = null;
  const perCountry = {}; // String(countryId) -> valueThd
  let georgiaTotalThd = 0;

  try {
    const json = await geostatFetch('/get_data', {
      method: 'POST',
      body: JSON.stringify({
        tradeFlow: tradeFlowCode,
        measurementUnits: [1],
        years: [year],
        months,
        countries: allCountryIds,
        locale: 'en',
        page: 1,
        pageSize: 500,
      }),
    });
    rawResponse = {
      success: json.success,
      total: json.total,
      rowCount: Array.isArray(json.data) ? json.data.length : 0,
    };

    if (json && Array.isArray(json.data)) {
      const summaryRow = json.data[0];
      // Discover the actual column key(s) Geostat returned. Match either
      // `usd1000_<year>` or `usd1000_<year>_<m>_<m>...` so we don't have
      // to guess Geostat's exact separator semantics.
      const valueColumns = [];
      if (summaryRow && typeof summaryRow === 'object') {
        for (const k of Object.keys(summaryRow)) {
          if (/^usd1000_\d{4}(?:_\d+)*$/.test(k)) valueColumns.push(k);
        }
      }
      rawResponse.summaryRowKeys = summaryRow ? Object.keys(summaryRow) : null;
      rawResponse.valueColumns = valueColumns;

      if (summaryRow && summaryRow.country == null) {
        // Sum across all matching value columns (handles per-month
        // breakdown if Geostat returns one column per month rather than
        // a single concatenated column).
        for (const col of valueColumns) {
          const v = parseFloat(summaryRow[col]);
          if (Number.isFinite(v)) georgiaTotalThd += v;
        }
      }
      const startIdx = (summaryRow && summaryRow.country == null) ? 1 : 0;
      for (let i = startIdx; i < json.data.length; i++) {
        const row = json.data[i];
        const cid = row.country;
        if (cid == null) continue;
        let sum = 0;
        let hasAny = false;
        for (const col of valueColumns) {
          const raw = row[col];
          if (raw == null || raw === '' || raw === '-') continue;
          const num = parseFloat(raw);
          if (Number.isFinite(num)) {
            sum += num;
            hasAny = true;
          }
        }
        if (hasAny && sum > 0) {
          perCountry[String(cid)] = sum;
        }
      }
    }
  } catch (err) {
    rawResponse = { error: err.message };
  }

  const countryCount = Object.keys(perCountry).length;
  const entries = Object.entries(perCountry)
    .map(([cid, thd]) => ({ cid, valueMln: thd / 1000 }))
    .filter((e) => e.valueMln > 0)
    .sort((a, b) => b.valueMln - a.valueMln);

  // Georgia total comes straight from the summary row Geostat returns;
  // fall back to summing per-country values if no summary row was
  // present (defensive — keeps shares sensible even if the response
  // shape changes).
  let total = georgiaTotalThd / 1000;
  if (total === 0 && entries.length > 0) {
    total = entries.reduce((s, e) => s + e.valueMln, 0);
  }
  const map = {};
  entries.forEach((e, idx) => {
    map[e.cid] = {
      valueMln: e.valueMln,
      rank: idx + 1,
      sharePct: total > 0 ? (100 * e.valueMln / total) : 0,
    };
  });

  const stats = { withTrade: countryCount, totalMln: total, rawResponse };
  console.log(`country-ranking [flow=${tradeFlowCode} ${year}/m${months.join(',')}]: ${countryCount} countries, total $${total.toFixed(1)}M`);
  // Diagnostic: when a flow returns zero countries, dump what Geostat
  // actually said. Lets us tell apart "Geostat returned success+empty"
  // from "Geostat threw" from "rows had unparseable country IDs".
  if (countryCount === 0) {
    console.warn(
      `country-ranking [flow=${tradeFlowCode} ${year}/m${months.join(',')}]: ZERO COUNTRIES — rawResponse=${JSON.stringify(rawResponse)}`
    );
  }
  return { total, perCountry: map, stats };
}

async function getAllCountryIds() {
  // Reuse whatever classificatory response we have in memory — countries
  // don't change between months, so the "last-known-good" entry is always
  // correct for ID extraction. Falls through to a live fetch only on a
  // cold start.
  if (classCache.en) {
    return (classCache.en.data?.countries || []).map((c) => c.value).filter((v) => v != null);
  }
  // Cold start: prefer the DB-cached classificatory over a live fetch so a
  // Geostat outage right after a deploy can't 502 the appendix/ranking.
  const fromDb = await tradeCacheDbGet('classificatory:en');
  if (fromDb && fromDb.data?.countries?.length) {
    classCache.en = fromDb; // keep ts=0 so other paths still refresh live
    return fromDb.data.countries.map((c) => c.value).filter((v) => v != null);
  }
  const data = await geostatFetch('/classificatory?lang=en');
  classCache.en = data;
  classCacheTs.en = Date.now();
  return (data.data?.countries || []).map((c) => c.value).filter((v) => v != null);
}

router.post('/country-ranking', async (req, res) => {
  const debug = {
    cacheKey: null,
    cacheHit: false,
    classificatoryCountries: 0,
    computedMs: 0,
    flowStats: null,
    countryIdRequested: null,
    countryIdType: null,
    countryFoundInFlows: null,
  };
  try {
    const { year, months, countryId } = req.body || {};
    // Validation
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      return res.status(400).json({ error: 'Invalid year', _debug: debug });
    }
    if (!Array.isArray(months) || months.length === 0 || months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
      return res.status(400).json({ error: 'Invalid months', _debug: debug });
    }
    if (countryId == null || countryId === '') {
      return res.status(400).json({ error: 'Invalid countryId', _debug: debug });
    }

    const sortedMonths = [...months].sort((a, b) => a - b);
    const cacheKey = `${year}:${sortedMonths.join(',')}`;
    debug.cacheKey = cacheKey;
    debug.countryIdRequested = String(countryId);
    debug.countryIdType = typeof countryId;

    const cached = await getCountryRanking(year, sortedMonths, debug);

    debug.flowStats = cached.flowStats || null;

    const idKey = String(countryId);
    const country = {
      turnover: cached.flows.turnover[idKey] || null,
      export: cached.flows.export[idKey] || null,
      import: cached.flows.import[idKey] || null,
      domesticExport: cached.flows.domesticExport[idKey] || null,
      reExport: cached.flows.reExport[idKey] || null,
    };
    debug.countryFoundInFlows = {
      turnover: !!country.turnover,
      export: !!country.export,
      import: !!country.import,
    };

    res.json({ success: true, totals: cached.totals, country, _debug: debug });
  } catch (err) {
    console.error('Statistics country-ranking error:', err.message);
    res.status(502).json({ error: 'Failed to fetch country ranking', reason: err.message, _debug: debug });
  }
});

// ── POST /api/statistics/country-ranking/debug ──────────────────────────
// Returns the RAW Geostat response for exactly one country/flow/period so
// we can inspect the row shape (isGroupSummary presence, usd1000_* field
// naming, any country-identifier field) straight from the browser console.
router.post('/country-ranking/debug', async (req, res) => {
  try {
    const { tradeFlow, year, months, countryId } = req.body || {};
    if (!['turnover', 'export', 'import'].includes(tradeFlow)) {
      return res.status(400).json({ error: 'tradeFlow must be turnover|export|import' });
    }
    if (!Number.isInteger(year)) return res.status(400).json({ error: 'Invalid year' });
    if (!Array.isArray(months) || months.length === 0) return res.status(400).json({ error: 'Invalid months' });
    if (countryId == null) return res.status(400).json({ error: 'Invalid countryId' });

    const filters = {
      tradeFlow,
      measurementUnits: [1],
      years: [year],
      months,
      countries: [countryId],
      locale: 'en',
      sum: true,
      page: 1,
      pageSize: 10,
    };
    const raw = await geostatFetch('/get_data', {
      method: 'POST',
      body: JSON.stringify(filters),
    });

    // Also show what fetchFlowRanking would have extracted.
    let extracted = 0;
    let extractionPath = null;
    if (raw && Array.isArray(raw.data)) {
      const summary = raw.data.find((r) => r.isGroupSummary);
      if (summary) { extracted = extractRowValue(summary); extractionPath = 'isGroupSummary'; }
      else { extracted = raw.data.reduce((s, r) => s + extractRowValue(r), 0); extractionPath = 'sum-all-rows'; }
    }

    res.json({
      success: true,
      filtersSent: filters,
      rawResponse: raw,
      extracted: { valueThd: extracted, valueMln: extracted / 1000, path: extractionPath },
    });
  } catch (err) {
    console.error('country-ranking/debug error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/statistics/country-appendix ───────────────────────────────────
// Returns the full appendix data set for one country in one shot. Replaces
// the old /country-aggregate endpoint that fanned out one Geostat call per
// column with sum:true — that pattern reliably triggered iisnode 502s on
// Geostat's side for some periods, leaving the appendix with 0s.
//
// New pattern (proved to work reliably on Geostat by manual testing):
//   - One multi-year call per flow, no `sum`, no `months`. Geostat returns
//     row 0 = Georgia totals per year (each year as a `usd1000_<year>`
//     column), rows 1+ = per-country values per year. For the current
//     calendar year Geostat already returns YTD up to the latest available
//     month, so 5 prior full years + current YTD come from this single call.
//   - One prior-year YTD call per flow (only when the current period is YTD,
//     i.e. latestMonth < 12). Same shape, plus `months: [1..latestMonth]`.
//
// Total: 4 Geostat calls per appendix render (export multi-year, import
// multi-year, export prior YTD, import prior YTD) — down from the 16 the
// old one-call-per-column path produced. Turnover is computed locally
// (export + import), no separate fetches.

const APPENDIX_CACHE_MAX = 32;
const appendixCache = new Map();   // key: `${latestYear}:${latestMonth}` -> data
const appendixInflight = new Map();

function appendixCacheGet(key) {
  const entry = appendixCache.get(key);
  return entry ? entry.data : null;
}

function appendixCacheSet(key, data) {
  if (appendixCache.size >= APPENDIX_CACHE_MAX) {
    const oldestKey = appendixCache.keys().next().value;
    if (oldestKey !== undefined) appendixCache.delete(oldestKey);
  }
  appendixCache.set(key, { data, ts: Date.now() });
}

// Parse a Geostat /get_data response in the new (no-sum) shape.
// - `data[0]` has no `country` field; its `usd1000_<year>` (multi-year call)
//   or `usd1000_<year>_<m1>_<m2>...` (call with `months` filter) values are
//   Georgia totals for that period.
// - `data[i>0]` rows have `country: <id>` and the same column keys; those
//   values are that country's total for the period (in 1000 USD, sometimes
//   returned as a string with many decimals, sometimes as the literal "-"
//   when the country had no trade in that year).
//
// Defensive: Geostat sometimes returns one column per requested month
// (`usd1000_<year>_1`, `_2`, `_3`) instead of one concatenated column,
// and sometimes splits a country across multiple rows (one per month).
// Sum across all matching columns for each year, and accumulate per-cid
// across rows, so YTD totals come out right either way.
function parseAppendixGeostatJson(json) {
  const result = { perYear: {}, errored: false, raw: null };
  if (!json || !Array.isArray(json.data)) {
    result.errored = true;
    result.raw = { success: !!(json && json.success), reason: 'missing data array' };
    return result;
  }
  result.raw = { success: !!json.success, total: json.total, rowCount: json.data.length };

  // Collect every `usd1000_<year>(_<m>...)` column key from every row,
  // grouped by year. Some Geostat responses only put the columns on row 0,
  // others spread per-month columns across per-country rows.
  const yearColumns = {}; // year -> Array<columnKey>
  for (const row of json.data) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) {
      const m = k.match(/^usd1000_(\d{4})(?:_\d+)*$/);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      if (!yearColumns[year]) yearColumns[year] = [];
      if (!yearColumns[year].includes(k)) yearColumns[year].push(k);
    }
  }
  result.raw.yearColumns = yearColumns;

  if (Object.keys(yearColumns).length === 0) {
    result.errored = true;
    result.raw.reason = 'no usd1000_<year> columns found';
    return result;
  }

  const summaryRow = json.data[0];
  const hasSummary = !!summaryRow && summaryRow.country == null;

  // Initialise perYear buckets — gtTotalThd from the summary row when it
  // exists, otherwise will be back-filled from per-country sums below.
  for (const yearStr of Object.keys(yearColumns)) {
    const year = parseInt(yearStr, 10);
    let gtTotal = 0;
    if (hasSummary) {
      for (const col of yearColumns[year]) {
        const v = parseFloat(summaryRow[col]);
        if (Number.isFinite(v)) gtTotal += v;
      }
    }
    result.perYear[year] = { gtTotalThd: gtTotal, perCountry: {} };
  }

  const startIdx = hasSummary ? 1 : 0;
  for (let i = startIdx; i < json.data.length; i++) {
    const row = json.data[i];
    const cid = row && row.country;
    if (cid == null) continue;
    const cidKey = String(cid);
    for (const yearStr of Object.keys(yearColumns)) {
      const year = parseInt(yearStr, 10);
      let sum = 0;
      let hasAny = false;
      for (const col of yearColumns[year]) {
        const raw = row[col];
        if (raw == null || raw === '' || raw === '-') continue;
        const num = parseFloat(raw);
        if (Number.isFinite(num)) {
          sum += num;
          hasAny = true;
        }
      }
      if (hasAny && sum !== 0) {
        const bucket = result.perYear[year];
        bucket.perCountry[cidKey] = (bucket.perCountry[cidKey] || 0) + sum;
      }
    }
  }

  // If Geostat omitted the summary row, derive the Georgia total from the
  // sum of per-country values so share-% calculations still make sense.
  if (!hasSummary) {
    for (const year of Object.keys(result.perYear)) {
      const bucket = result.perYear[year];
      if (bucket.gtTotalThd === 0) {
        bucket.gtTotalThd = Object.values(bucket.perCountry).reduce((s, v) => s + v, 0);
      }
    }
  }

  return result;
}

// Two parallel Geostat calls per flow: one multi-year (covers 5 full prior
// years + current YTD) and one prior-year YTD (only when latestMonth < 12).
async function fetchAppendixFlow(tradeFlow, latestYear, latestMonth, allCountryIds) {
  const years = [];
  for (let y = latestYear - 5; y <= latestYear; y++) years.push(y);
  const ytdMonths = Array.from({ length: latestMonth }, (_, i) => i + 1);
  const isPartialYear = latestMonth < 12;

  const multiPromise = geostatFetch('/get_data', {
    method: 'POST',
    body: JSON.stringify({
      tradeFlow,
      measurementUnits: [1],
      years,
      countries: allCountryIds,
      locale: 'en',
      page: 1,
      pageSize: 500,
    }),
  }).catch((err) => ({ __err: err.message }));

  const ytdPriorPromise = isPartialYear
    ? geostatFetch('/get_data', {
        method: 'POST',
        body: JSON.stringify({
          tradeFlow,
          measurementUnits: [1],
          years: [latestYear - 1],
          months: ytdMonths,
          countries: allCountryIds,
          locale: 'en',
          page: 1,
          pageSize: 500,
        }),
      }).catch((err) => ({ __err: err.message }))
    : Promise.resolve(null);

  const [multiRaw, ytdPriorRaw] = await Promise.all([multiPromise, ytdPriorPromise]);

  const multi = (multiRaw && multiRaw.__err)
    ? { perYear: {}, errored: true, raw: { error: multiRaw.__err } }
    : parseAppendixGeostatJson(multiRaw);
  const ytdPrior = !isPartialYear
    ? null
    : (ytdPriorRaw && ytdPriorRaw.__err)
      ? { perYear: {}, errored: true, raw: { error: ytdPriorRaw.__err } }
      : parseAppendixGeostatJson(ytdPriorRaw);

  return { multi, ytdPrior };
}

async function computeAppendixData(latestYear, latestMonth) {
  const key = `${latestYear}:${latestMonth}`;
  const cached = appendixCacheGet(key);
  if (cached) return cached;
  if (appendixInflight.has(key)) return appendixInflight.get(key);

  const promise = (async () => {
    const fromDb = await tradeCacheDbGet(`appendix:${key}`);
    if (fromDb) {
      appendixCacheSet(key, fromDb);
      return fromDb;
    }

    const allCountryIds = await getAllCountryIds();
    const [exp, imp] = await Promise.all([
      fetchAppendixFlow(10, latestYear, latestMonth, allCountryIds),
      fetchAppendixFlow(11, latestYear, latestMonth, allCountryIds),
    ]);

    const data = { exp, imp, latestYear, latestMonth };
    const expOk = !exp.multi.errored && (latestMonth >= 12 || (exp.ytdPrior && !exp.ytdPrior.errored));
    const impOk = !imp.multi.errored && (latestMonth >= 12 || (imp.ytdPrior && !imp.ytdPrior.errored));
    if (expOk && impOk) {
      appendixCacheSet(key, data);
      await tradeCacheDbSet(`appendix:${key}`, data);
    } else {
      console.warn(
        `country-appendix [${key}]: SKIP CACHE — partial Geostat ` +
        `(exp.multi.errored=${exp.multi.errored} exp.ytdPrior.errored=${exp.ytdPrior?.errored ?? 'n/a'} ` +
        `imp.multi.errored=${imp.multi.errored} imp.ytdPrior.errored=${imp.ytdPrior?.errored ?? 'n/a'}); ` +
        `exp.multi.raw=${JSON.stringify(exp.multi.raw)} imp.multi.raw=${JSON.stringify(imp.multi.raw)}`
      );
    }
    return data;
  })();

  appendixInflight.set(key, promise);
  try { return await promise; }
  finally { appendixInflight.delete(key); }
}

function buildAppendixColumns(latestYear, latestMonth) {
  const cols = [];
  if (latestMonth >= 12) {
    for (let y = latestYear - 5; y <= latestYear; y++) {
      cols.push({ kind: 'full', year: y, label: String(y) });
    }
  } else {
    for (let y = latestYear - 5; y <= latestYear - 1; y++) {
      cols.push({ kind: 'full', year: y, label: String(y) });
    }
    const months = [];
    for (let m = 1; m <= latestMonth; m++) months.push(m);
    const mm = String(latestMonth).padStart(2, '0');
    cols.push({ kind: 'ytd', year: latestYear - 1, months, label: `${latestYear - 1}.${mm}` });
    cols.push({ kind: 'ytd', year: latestYear, months, label: `${latestYear}.${mm}` });
  }
  return cols;
}

// Returns { country, total } in millions USD for one (flow, column).
// Source semantics:
//   kind='full'                            → flow.multi.perYear[year]
//   kind='ytd' && year=latestYear          → flow.multi.perYear[latestYear]
//                                            (current year column already
//                                             contains YTD when latestMonth<12)
//   kind='ytd' && year=latestYear-1        → flow.ytdPrior.perYear[year]
function lookupAppendixCell(flow, col, latestYear, idKey) {
  let bucket = null;
  if (col.kind === 'full') {
    bucket = flow.multi.perYear[col.year];
  } else if (col.kind === 'ytd') {
    if (col.year === latestYear) {
      bucket = flow.multi.perYear[latestYear];
    } else {
      bucket = flow.ytdPrior && flow.ytdPrior.perYear[col.year];
    }
  }
  if (!bucket) return { country: null, total: null };
  const totalMln = bucket.gtTotalThd / 1000;
  const countryThd = bucket.perCountry[idKey];
  // perCountry only contains entries where the country had trade. Missing
  // entries mean "no trade in this period" (legitimate 0 with healthy data).
  const countryMln = countryThd != null ? countryThd / 1000 : 0;
  return { country: countryMln, total: totalMln };
}

router.post('/country-appendix', async (req, res) => {
  try {
    const { latestYear, latestMonth, countryId } = req.body || {};
    if (!Number.isInteger(latestYear) || latestYear < 1990 || latestYear > 2100) {
      return res.status(400).json({ error: 'Invalid latestYear' });
    }
    if (!Number.isInteger(latestMonth) || latestMonth < 1 || latestMonth > 12) {
      return res.status(400).json({ error: 'Invalid latestMonth' });
    }
    if (countryId == null || countryId === '') {
      return res.status(400).json({ error: 'Invalid countryId' });
    }

    const data = await computeAppendixData(latestYear, latestMonth);
    const columns = buildAppendixColumns(latestYear, latestMonth);
    const idKey = String(countryId);

    const cells = columns.map((col) => {
      const expCell = lookupAppendixCell(data.exp, col, latestYear, idKey);
      const impCell = lookupAppendixCell(data.imp, col, latestYear, idKey);
      const totals = {
        export: expCell.total,
        import: impCell.total,
        turnover: (expCell.total != null && impCell.total != null)
          ? expCell.total + impCell.total : null,
      };
      const hasAny = (expCell.country != null && expCell.country > 0) ||
                     (impCell.country != null && impCell.country > 0);
      const country = hasAny
        ? {
            export: expCell.country,
            import: impCell.country,
            turnover: (expCell.country != null && impCell.country != null)
              ? expCell.country + impCell.country : null,
          }
        : null;
      return { totals, country };
    });

    res.json({
      success: true,
      latestYear,
      latestMonth,
      ytdMode: latestMonth < 12,
      columns,
      data: cells,
    });
  } catch (err) {
    console.error('Statistics country-appendix error:', err.message);
    res.status(502).json({ error: 'Failed to fetch country appendix', reason: err.message });
  }
});

// ── Monthly trade publication detector ──────────────────────────────────
// Geostat publishes monthly trade data around the 18th-23rd and quietly
// revises earlier months of the year at the same time. A daily check (plus
// an opportunistic trigger from the classificatory route) detects the new
// month via `selected.month` + probe-forward, drops cached computations for
// the affected years, prewarms the new period's ranking/appendix, and
// records the detection in trade_cache under 'trade-state'.

// Server-side twin of the frontend's verifyLatestMonth(): Geostat sometimes
// publishes a month's rows before bumping `selected.month`.
async function tradeHasDataFor(year, month) {
  try {
    const json = await geostatFetch('/get_data', {
      method: 'POST',
      body: JSON.stringify({
        tradeFlow: 10,
        measurementUnits: [1],
        years: [year],
        months: [month],
        sum: true,
        page: 1,
        pageSize: 1,
      }),
    });
    if (!json || !json.success || !Array.isArray(json.data)) return false;
    for (const row of json.data) {
      for (const k of Object.keys(row)) {
        if (k.startsWith('usd1000_')) {
          const v = parseFloat(row[k]);
          if (!isNaN(v) && v > 0) return true;
        }
      }
    }
    return false;
  } catch (_) { return false; }
}

async function invalidateTradeCaches(years) {
  for (const k of [...rankingCache.keys()]) {
    if (years.includes(parseInt(k, 10))) rankingCache.delete(k);
  }
  for (const k of [...appendixCache.keys()]) {
    if (years.includes(parseInt(k, 10))) appendixCache.delete(k);
  }
  for (const y of years) {
    await tradeCacheDbDeleteByPrefix(`ranking:${y}:`);
    await tradeCacheDbDeleteByPrefix(`appendix:${y}:`);
  }
}

let tradeCheckRunning = false;

async function checkTradePublication(trigger) {
  if (tradeCheckRunning) return;
  tradeCheckRunning = true;
  try {
    const data = await geostatFetch('/classificatory?lang=en');
    classCache.en = data;
    classCacheTs.en = Date.now();
    tradeCacheDbSet('classificatory:en', data);

    // Response shape is { success, data: { selected, countries… } } —
    // the period lives one level down, matching the frontend's enJson.data.
    const sel = data && data.data && data.data.selected;
    const year = parseInt(sel && sel.year, 10);
    let month = parseInt(sel && sel.month, 10);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      throw new Error('classificatory has no selected period');
    }
    lastSeenTradePeriod = `${sel.year}-${sel.month}`;
    if (month < 12) {
      const [p1, p2] = await Promise.all([
        tradeHasDataFor(year, month + 1),
        month + 2 <= 12 ? tradeHasDataFor(year, month + 2) : Promise.resolve(false),
      ]);
      if (p1) month = month + 1;
      if (p2) month = month + 2;
    }

    const state = await tradeCacheDbGet('trade-state');
    const now = new Date().toISOString();
    if (state && state.year === year && state.month === month) {
      await tradeCacheDbSet('trade-state', { ...state, checkedAt: now });
      return;
    }

    console.log(
      `trade: new month detected — ${year}-${String(month).padStart(2, '0')} ` +
      `(was ${state ? `${state.year}-${String(state.month).padStart(2, '0')}` : 'none'}, trigger=${trigger})`
    );
    // Revisions accompany each release; drop the affected years' caches.
    await invalidateTradeCaches([year, year - 1]);
    // Prewarm the standard report views so the first visitor is instant.
    const ytdMonths = Array.from({ length: month }, (_, i) => i + 1);
    try { await getCountryRanking(year, ytdMonths); } catch (e) { console.warn('trade prewarm ranking failed:', e.message); }
    try { await computeAppendixData(year, month); } catch (e) { console.warn('trade prewarm appendix failed:', e.message); }
    await tradeCacheDbSet('trade-state', { year, month, detectedAt: now, checkedAt: now });
  } catch (err) {
    console.warn('trade: publication check failed:', err.message);
  } finally {
    tradeCheckRunning = false;
  }
}

// Fire-and-forget trigger used by the classificatory route: kick a full
// check when the live response shows a different period than last seen.
let lastSeenTradePeriod = null;
function maybeDetectNewTradeMonth(data) {
  const sel = data && data.data && data.data.selected;
  if (!sel) return;
  const period = `${sel.year}-${sel.month}`;
  if (period === lastSeenTradePeriod) return;
  lastSeenTradePeriod = period;
  checkTradePublication('classificatory').catch(() => {});
}

// Daily check at 10:10 Tbilisi (= 06:10 UTC, Georgia has no DST), same
// anchoring approach as the tourism scheduler. Also run shortly after boot
// so a fresh container picks up anything it missed (delayed so the schema
// migration in index.js has finished).
function scheduleTradeCheck() {
  const UTC_HOUR = 6, UTC_MINUTE = 10;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), UTC_HOUR, UTC_MINUTE, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  console.log(`trade: next publication check in ${(delay / 3600000).toFixed(1)}h (${next.toISOString()}, 10:10 Tbilisi)`);
  setTimeout(() => {
    checkTradePublication('scheduled');
    setInterval(() => checkTradePublication('scheduled'), 24 * 60 * 60 * 1000);
  }, delay);
}
scheduleTradeCheck();
setTimeout(() => checkTradePublication('boot'), 15_000);

// ── GET /api/statistics/trade-status ─────────────────────────────────────
// Last detected trade period + when it was detected/checked, for the admin
// panel's data-status display.
router.get('/trade-status', async (req, res) => {
  const state = await tradeCacheDbGet('trade-state');
  res.json({ success: true, state: state || null });
});



// ── GET /api/statistics/fdi ──────────────────────────────────────────────
// Parses FDI by countries XLSX. Geostat re-publishes the file under a new
// /media/<id>/ URL each quarterly release, so the link is resolved from the
// FDI category page at refresh time. A refresh runs when an admin uploads
// the FDI-by-sector file (both series follow the same quarterly release);
// the parsed snapshot is persisted in admin_uploads and served unchanged
// until the next refresh.

const FDI_PAGE_URL = 'https://www.geostat.ge/ka/modules/categories/191/pirdapiri-utskhouri-investitsiebi';
const FDI_FALLBACK_URL = 'https://www.geostat.ge/media/79883/FDI_Geo_countries.xlsx';
const FDI_LOCAL = require('path').join(__dirname, '../data/FDI_Geo_countries.xlsx');
let fdiCache = { data: null };

async function resolveFdiAnnualUrl() {
  const pageRes = await geostatHttp(FDI_PAGE_URL, {
    headers: { 'User-Agent': 'VectorPortal/1.0' },
    timeout: 15_000,
    followRedirects: true,
  });
  if (!pageRes.ok) throw new Error(`FDI category page HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const m = /https?:\/\/[\w.]*geostat\.ge\/media\/\d+\/FDI_Geo_countries\.xlsx/i.exec(html);
  if (!m) throw new Error('FDI_Geo_countries.xlsx link not found on category page');
  // The page links bare geostat.ge, which 302s to www; geostatHttp only
  // accepts *.geostat.ge hosts, so normalize.
  return m[0].replace('//geostat.ge/', '//www.geostat.ge/');
}

// Downloads the current annual FDI workbook, parses it, persists the
// snapshot (DB + local xlsx fallback) and updates the in-memory cache.
async function refreshFdiAnnual() {
  let url;
  try {
    url = await resolveFdiAnnualUrl();
  } catch (resolveErr) {
    console.warn('FDI annual: link resolution failed, trying last known URL:', resolveErr.message);
    url = FDI_FALLBACK_URL;
  }
  const xlsxRes = await geostatHttp(url, {
    headers: { 'User-Agent': 'VectorPortal/1.0' },
    timeout: 15_000,
    followRedirects: true,
  });
  if (!xlsxRes.ok) throw new Error(`HTTP ${xlsxRes.status} for ${url}`);
  const buffer = xlsxRes.buffer();
  const result = parseFdiWorkbook(XLSX.read(buffer, { type: 'buffer' }));
  result.refreshedAt = new Date().toISOString();
  result.source = url;
  await saveParsedAndRaw('fdi-annual', result, buffer);
  try { require('fs').writeFileSync(FDI_LOCAL, buffer); } catch (_) { /* ephemeral/read-only fs */ }
  fdiCache.data = result;
  console.log(`FDI annual: refreshed from ${url} (${Object.keys(result.countries).length} countries, up to ${result.years[result.years.length - 1]})`);
  return result;
}

function parseFdiWorkbook(wb) {
  const ws = wb.Sheets['FDI (annual)'];
  if (!ws) throw new Error('Sheet "FDI (annual)" not found');

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headerRow = rows[3];
  if (!headerRow) throw new Error('Header row not found');

  const years = [];
  for (let c = 2; c < headerRow.length; c++) {
    const raw = String(headerRow[c] || '').replace('*', '').trim();
    const yr = parseInt(raw, 10);
    if (yr >= 1996 && yr <= 2100) {
      years.push({ col: c, year: yr });
    }
  }

  const countries = {};
  let totals = null; // grand totals per year from the "სულ"/"Total" row
  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const code = parseInt(row[0], 10);
    const label = String(row[0] || row[1] || '').trim().toLowerCase();

    // Capture the totals row (no numeric country code; label contains "სულ" or "total")
    if ((!code || isNaN(code)) && !totals &&
        (label.includes('სულ') || label.includes('total') || label.includes('ჯამი'))) {
      const t = {};
      for (const { col, year } of years) {
        const val = row[col];
        if (val === null || val === undefined || val === '-' || val === '') { t[year] = 0; continue; }
        const num = parseFloat(val);
        t[year] = isNaN(num) ? 0 : num; // Thsd. USD
      }
      totals = t;
      continue;
    }

    if (!code || isNaN(code)) continue;

    const values = {};
    for (const { col, year } of years) {
      const val = row[col];
      if (val === null || val === undefined || val === '-' || val === '') {
        values[year] = 0;
      } else {
        const num = parseFloat(val);
        values[year] = isNaN(num) ? 0 : num; // in Thsd. USD
      }
    }
    countries[code] = values;
  }

  const quarters = parseFdiQuarterSheet(wb, years.length ? years[years.length - 1].year : 0);
  return { success: true, years: years.map(y => y.year), countries, totals, quarters };
}

// Sums one or more quarter columns of the quarterly sheet into per-country
// values plus the grand total from the "სულ" row. Same row layout as the
// annual sheet: col A country code, col B name, values in Thsd. USD.
function sumFdiQuarterColumns(rows, colIdxs) {
  const countries = {};
  let total = null;
  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    let sum = 0;
    for (const c of colIdxs) {
      const num = parseFloat(row[c]);
      if (!isNaN(num)) sum += num;
    }
    const code = parseInt(row[0], 10);
    if (code && !isNaN(code)) { countries[code] = sum; continue; }
    const label = String(row[0] || row[1] || '').trim().toLowerCase();
    if (total === null && (label.includes('სულ') || label.includes('total') || label.includes('ჯამი'))) {
      total = sum;
    }
  }
  return { countries, total };
}

// The quarterly sheet ("FDI ") carries per-country values for quarters the
// annual sheet doesn't have yet (e.g. "I კვ. 2026*" while the annual sheet
// ends at 2025). Quarters of the same year are accumulated into one
// year-to-date entry (Q1, then Q1+Q2, ...), with the same quarters of the
// previous year summed for the change-% comparison.
function parseFdiQuarterSheet(wb, lastAnnualYear) {
  const sheetName = wb.SheetNames.find((n) => n.trim() === 'FDI');
  const ws = sheetName && wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headerRow = rows[3];
  if (!headerRow) return [];

  const ROMAN = { I: 1, II: 2, III: 3, IV: 4 };
  const cols = [];
  for (let c = 2; c < headerRow.length; c++) {
    const raw = String(headerRow[c] || '').trim();
    const m = /^(IV|III|II|I)\s*კვ\.?\s*(\d{4})(\*?)$/.exec(raw);
    if (!m) continue;
    cols.push({ col: c, quarter: ROMAN[m[1]], year: parseInt(m[2], 10), preliminary: m[3] === '*' });
  }

  const byYear = new Map();
  for (const q of cols) {
    if (q.year <= lastAnnualYear) continue;
    if (!byYear.has(q.year)) byYear.set(q.year, []);
    byYear.get(q.year).push(q);
  }

  const out = [];
  for (const [year, qcols] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    qcols.sort((a, b) => a.quarter - b.quarter);
    const cur = sumFdiQuarterColumns(rows, qcols.map((q) => q.col));
    const prevCols = qcols
      .map((q) => cols.find((p) => p.year === year - 1 && p.quarter === q.quarter))
      .filter(Boolean);
    const prev = prevCols.length === qcols.length
      ? sumFdiQuarterColumns(rows, prevCols.map((p) => p.col))
      : null;
    out.push({
      year,
      quarters: qcols.map((q) => q.quarter), // e.g. [1] or [1, 2]
      preliminary: qcols.some((q) => q.preliminary),
      countries: cur.countries, // Thsd. USD, year-to-date
      total: cur.total,         // Thsd. USD ("სულ" row, year-to-date)
      prev,                     // same quarters of the previous year (or null)
    });
  }
  return out;
}

router.get('/fdi', async (req, res) => {
  try {
    // Snapshot semantics: serve the last refreshed copy as-is. It's replaced
    // only by the next refresh, triggered from /fdi-sectors/upload.
    if (fdiCache.data) return res.json(fdiCache.data);

    const saved = await loadParsed('fdi-annual');
    if (saved) {
      fdiCache.data = saved;
      return res.json(saved);
    }

    // Nothing persisted yet (first boot before any sector upload): try a
    // live refresh, then the bundled workbook.
    try {
      return res.json(await refreshFdiAnnual());
    } catch (dlErr) {
      console.log('FDI bootstrap download failed, using local copy:', dlErr.message);
      const result = parseFdiWorkbook(XLSX.readFile(FDI_LOCAL));
      fdiCache.data = result;
      return res.json(result);
    }
  } catch (err) {
    console.error('FDI data error:', err.message);
    res.status(502).json({ error: 'Failed to load FDI data' });
  }
});

// ── GET /api/statistics/tourism ─────────────────────────────────────────
// Parses GNTA international visitor data XLSX from two sources:
// - Historical file (ID 10068): annual data 2011-2025 (stable ID)
// - Latest quarterly file: auto-discovered by scanning recent media IDs
// Merged result contains both annual + current period (e.g. 2026 Q1).

const path = require('path');
const fs = require('fs');
const { upload, adminOnly, saveParsedAndRaw, saveRawFile, loadParsed } = require('./admin-uploads');

const TOURISM_HISTORICAL_URL = 'https://api.gnta.ge/api/v1/web/media/download/10068';
const TOURISM_HISTORICAL_LOCAL = path.join(__dirname, '../data/gnta-visitors-historical.xlsx');
const TOURISM_QUARTERLY_LOCAL = path.join(__dirname, '../data/gnta-visitors-quarterly.xlsx');
const TOURISM_QUARTERLY_ID_FILE = path.join(__dirname, '../data/gnta-quarterly-id.txt');
const TOURISM_MEDIA_BASE = 'https://api.gnta.ge/api/v1/web/media/download';

// Starting baseline for scanning when no cached ID exists
const TOURISM_QUARTERLY_BASE_ID = 10700;
// Forward scan tuning: probe in concurrent batches until a long run of
// nonexistent IDs marks the end of GNTA's media ID space. GNTA assigns IDs
// across all site media, so a quarterly release can land far above the last
// checkpoint — the scan must not have a fixed-size window.
const TOURISM_SCAN_BATCH = 25;
const TOURISM_SCAN_END_GAP = 150;
const TOURISM_SCAN_MAX = 5000;
// Rewind the scan start below the checkpoint: GNTA uploads each release as
// a cluster of adjacent IDs (single-quarter, combined YTD, EN/KA variants),
// and the preferred combined file can sit a few IDs BELOW the one the
// checkpoint recorded. Without the rewind it would never be rescanned.
const TOURISM_SCAN_REWIND = 25;

let tourismCache = { data: null, ts: 0 };
const TOURISM_CACHE_TTL = 24 * 60 * 60 * 1000;
const TOURISM_DATA_FILE = path.join(__dirname, '../data/tourism-cache.json');

// Parse the historical file — country names in col A, years 2011-YYYY in cols B+
function parseHistoricalWorkbook(wb) {
  // Find the summary sheet (name matches year-range pattern)
  let ws = null;
  for (const name of wb.SheetNames) {
    if (/\d{4}.*-.*\d{4}/.test(name)) {
      ws = wb.Sheets[name];
      break;
    }
  }
  if (!ws) throw new Error('Historical summary sheet not found');

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headerRow = rows[0];
  if (!headerRow) throw new Error('Historical header row not found');

  const years = [];
  for (let c = 1; c < headerRow.length; c++) {
    const raw = String(headerRow[c] || '').replace('*', '').trim();
    const yr = parseInt(raw, 10);
    if (yr >= 2000 && yr <= 2100) years.push({ col: c, year: yr });
  }

  const countries = {};
  let totals = null; // grand totals per year — first non-country data row
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = String(row[0] || '').trim();
    if (!name) continue;

    // Capture the totals row — labelled with "განხორციელებული ვიზიტები"
    // (conducted visits). The exact label is:
    // "საერთაშორისო ვიზიტორების მიერ განხორციელებული ვიზიტები".
    if (!totals && name.includes('განხორციელებული ვიზიტები')) {
      const t = {};
      for (const { col, year } of years) {
        const v = row[col];
        if (v === null || v === undefined || v === '-' || v === '') { t[year] = 0; continue; }
        const num = parseFloat(String(v).replace(/,/g, ''));
        t[year] = isNaN(num) ? 0 : Math.round(num);
      }
      if (Object.values(t).some(v => v > 0)) totals = t;
    }

    if (name.startsWith('მათ შორის') || name.startsWith('საერთაშორისო') ||
        name.startsWith('სხვა ვიზიტ') || name.startsWith('წყარო')) continue;

    const values = {};
    let hasAnyValue = false;
    for (const { col, year } of years) {
      const val = row[col];
      if (val === null || val === undefined || val === '-' || val === '') {
        values[year] = 0;
      } else {
        const num = parseFloat(String(val).replace(/,/g, ''));
        values[year] = isNaN(num) ? 0 : Math.round(num);
        if (values[year] > 0) hasAnyValue = true;
      }
    }
    if (hasAnyValue) countries[name] = values;
  }

  return { years: years.map(y => y.year), countries, totals };
}

// Check if a workbook matches the quarterly file fingerprint.
// Returns { compareLabel, currentLabel, countries } or null if not a match.
function parseQuarterlyWorkbook(wb) {
  // Quarterly files: first sheet with country in col B, period headers in cols C/D
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rows.length < 10) continue;
    const header = rows[0] || [];

    // Fingerprint check: col B = "ქვეყანა", col C & D = year or quarter labels
    const colB = String(header[1] || '').trim();
    const colC = String(header[2] || '').trim();
    const colD = String(header[3] || '').trim();
    if (colB !== 'ქვეყანა') continue;

    // Accepts bare years ("2025"), single quarters ("2026 II კვ") and
    // combined ranges ("2026 I-II კვ" — GNTA's year-to-date files).
    const isPeriodLabel = s => /^\d{4}(\s+[IVX]+(-[IVX]+)?\s+კვ)?$/.test(s);
    if (!isPeriodLabel(colC) || !isPeriodLabel(colD)) continue;

    // Matched! Extract data.
    const countries = {};
    let periodTotals = null; // { current, compare } from the totals row
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = String(row[1] || '').trim();
      if (!name) continue;

      const parseVal = (v) => {
        if (v === null || v === undefined || v === '-' || v === '') return 0;
        const n = parseFloat(String(v).replace(/,/g, ''));
        return isNaN(n) ? 0 : Math.round(n);
      };

      // Capture the totals row — "...განხორციელებული ვიზიტები".
      if (!periodTotals && name.includes('განხორციელებული ვიზიტები')) {
        const t = { compare: parseVal(row[2]), current: parseVal(row[3]) };
        if (t.compare > 0 || t.current > 0) periodTotals = t;
      }

      if (name.startsWith('მათ შორის') || name.startsWith('საერთაშორისო') ||
          name.startsWith('სხვა ვიზიტ') || name.startsWith('წყარო')) continue;

      const compare = parseVal(row[2]);
      const current = parseVal(row[3]);
      if (compare > 0 || current > 0) {
        countries[name] = { compare, current };
      }
    }

    return { compareLabel: colC, currentLabel: colD, countries, periodTotals };
  }
  return null;
}

// Parse a period header label into { year, startQ, endQ }.
// "2026 I-II კვ" → { year: 2026, startQ: 1, endQ: 2 }; "2026 II კვ" →
// { year: 2026, startQ: 2, endQ: 2 }; bare "2025" → startQ/endQ 0.
function parsePeriodLabel(label) {
  const m = /^(\d{4})(?:\s+([IVX]+)(?:-([IVX]+))?\s+კვ)?$/.exec(label || '');
  if (!m) return null;
  const roman = { I: 1, II: 2, III: 3, IV: 4 };
  const startQ = m[2] ? (roman[m[2]] || 0) : 0;
  const endQ = m[3] ? (roman[m[3]] || 0) : startQ;
  return { year: parseInt(m[1], 10), startQ, endQ };
}

// HEAD-probe a media ID. Returns { exists, isSpreadsheet }. Network errors
// and timeouts count as existing-but-not-spreadsheet so a transient failure
// never fakes the end of the ID space (TOURISM_SCAN_MAX bounds the scan).
async function probeMediaId(id) {
  try {
    const r = await fetch(`${TOURISM_MEDIA_BASE}/${id}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return { exists: false, isSpreadsheet: false };
    const ct = r.headers.get('content-type') || '';
    return { exists: true, isSpreadsheet: ct.includes('spreadsheet') };
  } catch (_) {
    return { exists: true, isSpreadsheet: false };
  }
}

// Scan media IDs to find the latest quarterly XLSX.
// Returns { id, buffer, parsed } for the highest-ID matching file, or null.
async function findLatestQuarterlyFile(lastKnownId) {
  const startId = Math.max(
    TOURISM_QUARTERLY_BASE_ID - TOURISM_SCAN_REWIND,
    (lastKnownId || TOURISM_QUARTERLY_BASE_ID) - TOURISM_SCAN_REWIND
  );
  const maxId = startId + TOURISM_SCAN_MAX;

  // Phase 1: probe forward in concurrent batches, collecting spreadsheet
  // candidates, until TOURISM_SCAN_END_GAP consecutive IDs don't exist.
  const candidates = [];
  let consecutiveMissing = 0;
  let lastProbedId = startId;
  outer:
  for (let base = startId; base <= maxId; base += TOURISM_SCAN_BATCH) {
    const ids = [];
    for (let id = base; id < base + TOURISM_SCAN_BATCH && id <= maxId; id++) ids.push(id);
    const results = await Promise.all(ids.map(probeMediaId));
    for (let i = 0; i < ids.length; i++) {
      lastProbedId = ids[i];
      if (results[i].exists) {
        consecutiveMissing = 0;
        if (results[i].isSpreadsheet) candidates.push(ids[i]);
      } else {
        consecutiveMissing++;
        if (consecutiveMissing >= TOURISM_SCAN_END_GAP) break outer;
      }
    }
  }
  console.log(`tourism: scan probed ids ${startId}-${lastProbedId}, ${candidates.length} spreadsheet candidates`);

  // Phase 2: download + fingerprint every candidate and keep the one
  // covering the widest, most recent period. GNTA publishes both a
  // single-quarter file ("2026 II კვ") and a combined year-to-date file
  // ("2026 I-II კვ") per release — we want the combined one, which may
  // have a lower media ID than its single-quarter sibling. Score by
  // (year, ending quarter, quarter span, id), lexicographic.
  let best = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const id = candidates[i];
    try {
      const getRes = await fetch(`${TOURISM_MEDIA_BASE}/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!getRes.ok) continue;
      const buffer = Buffer.from(await getRes.arrayBuffer());
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parsed = parseQuarterlyWorkbook(wb);
      if (!parsed || Object.keys(parsed.countries).length <= 50) continue;
      const p = parsePeriodLabel(parsed.currentLabel);
      if (!p) continue;
      const score = [p.year, p.endQ, p.endQ - p.startQ + 1, id];
      if (!best || lexGreater(score, best.score)) {
        best = { id, buffer, parsed, score };
      }
    } catch (_) { /* skip */ }
  }
  return best ? { id: best.id, buffer: best.buffer, parsed: best.parsed } : null;
}

function lexGreater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Period score for a parsed quarterly workbook: [year, endQ, span].
// Used to make sure a refresh never replaces the local file with one
// covering a NARROWER period (e.g. Q2-only over combined I-II).
function quarterlyPeriodScore(parsed) {
  const p = parsed && parsePeriodLabel(parsed.currentLabel);
  return p ? [p.year, p.endQ, p.endQ - p.startQ + 1] : null;
}

function readCachedQuarterlyId() {
  try {
    const txt = fs.readFileSync(TOURISM_QUARTERLY_ID_FILE, 'utf8').trim();
    const id = parseInt(txt, 10);
    return isNaN(id) ? null : id;
  } catch (_) { return null; }
}

function writeCachedQuarterlyId(id) {
  try { fs.writeFileSync(TOURISM_QUARTERLY_ID_FILE, String(id)); } catch (_) {}
}

// ── Refresh tourism data: fetch, parse, merge, save to disk ──────────
// Called by the daily scheduler and on first request if no cached file.
let tourismRefreshRunning = false;
let tourismStatus = { lastRefreshAt: null, lastError: null };

async function refreshTourismData() {
  if (tourismRefreshRunning) return;
  tourismRefreshRunning = true;
  const t0 = Date.now();
  console.log('tourism: refreshing data...');

  try {
    // 1. Fetch historical file (stable ID)
    let histWb;
    try {
      const r = await fetch(TOURISM_HISTORICAL_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      histWb = XLSX.read(buf, { type: 'buffer' });
      fs.writeFileSync(TOURISM_HISTORICAL_LOCAL, buf);
    } catch (err) {
      console.log('tourism: historical download failed, using local:', err.message);
      histWb = XLSX.readFile(TOURISM_HISTORICAL_LOCAL);
    }
    const historical = parseHistoricalWorkbook(histWb);

    // 2. Discover + fetch latest quarterly file
    let quarterly = null;
    let quarterlyId = readCachedQuarterlyId();

    let localParsed = null;
    try { localParsed = parseQuarterlyWorkbook(XLSX.readFile(TOURISM_QUARTERLY_LOCAL)); } catch (_) {}

    try {
      const scanStart = quarterlyId || TOURISM_QUARTERLY_BASE_ID;
      const match = await findLatestQuarterlyFile(scanStart);
      const matchScore = match ? quarterlyPeriodScore(match.parsed) : null;
      const localScore = quarterlyPeriodScore(localParsed);
      // Accept the scanned file only when it covers at least as wide and
      // recent a period as the bundled local one — GNTA sometimes exposes
      // only the single-quarter sibling, and that must not overwrite a
      // local combined (I-II) baseline. Remote wins ties.
      if (match && matchScore && (!localScore || !lexGreater(localScore, matchScore))) {
        quarterly = match.parsed;
        quarterlyId = match.id;
        fs.writeFileSync(TOURISM_QUARTERLY_LOCAL, match.buffer);
        writeCachedQuarterlyId(match.id);
        console.log(`tourism: quarterly file discovered: ID ${match.id} (${match.parsed.currentLabel})`);
      } else {
        if (match && localParsed) {
          console.log(`tourism: scan best (${match.parsed.currentLabel}) narrower than local (${localParsed.currentLabel}) — keeping local`);
        }
        quarterly = localParsed;
      }
    } catch (err) {
      console.log('tourism: quarterly discovery failed, using local:', err.message);
      quarterly = localParsed;
    }

    // 3. Merge
    const countries = {};
    for (const [name, years] of Object.entries(historical.countries)) {
      countries[name] = { annual: years, current: null, compare: null };
    }
    let currentPeriod = null;
    if (quarterly) {
      currentPeriod = {
        label: quarterly.currentLabel,
        compareLabel: quarterly.compareLabel,
      };
      if (!/კვ/.test(quarterly.currentLabel)) {
        currentPeriod = null;
      }
      if (currentPeriod) {
        for (const [name, vals] of Object.entries(quarterly.countries)) {
          if (!countries[name]) {
            countries[name] = { annual: {}, current: null, compare: null };
          }
          countries[name].current = vals.current;
          countries[name].compare = vals.compare;
        }
      }
    }

    const result = {
      success: true,
      years: historical.years,
      currentPeriod,
      countries,
      totals: {
        annual: historical.totals || {},
        current: quarterly && quarterly.periodTotals ? quarterly.periodTotals.current : null,
        compare: quarterly && quarterly.periodTotals ? quarterly.periodTotals.compare : null,
      },
    };

    // Save to disk + memory cache
    fs.writeFileSync(TOURISM_DATA_FILE, JSON.stringify(result));
    tourismCache = { data: result, ts: Date.now() };
    tourismStatus = { lastRefreshAt: new Date().toISOString(), lastError: null };
    console.log(`tourism: refresh completed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${Object.keys(countries).length} countries`);
    console.log(`tourism: annual totals sample:`, JSON.stringify(historical.totals ? Object.entries(historical.totals).slice(-3) : 'null'));
    console.log(`tourism: quarterly totals:`, JSON.stringify(quarterly?.periodTotals || 'null'));
  } catch (err) {
    tourismStatus.lastError = err.message;
    console.error('tourism: refresh failed:', err.message);
  } finally {
    tourismRefreshRunning = false;
  }
}

// Load cached data from disk on startup (instant, no network)
function loadTourismFromDisk() {
  try {
    if (fs.existsSync(TOURISM_DATA_FILE)) {
      const raw = fs.readFileSync(TOURISM_DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.success) {
        tourismCache = { data, ts: Date.now() };
        console.log('tourism: loaded from disk cache');
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// Schedule daily refresh at 10:00 Tbilisi time. Georgia is UTC+4 with no
// DST, so the target is a fixed 06:00 UTC regardless of server timezone.
function scheduleTourismRefresh() {
  const TBILISI_HOUR = 10;
  const UTC_HOUR = TBILISI_HOUR - 4;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), UTC_HOUR, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  console.log(`tourism: next scheduled refresh in ${(delay / 3600000).toFixed(1)}h (${next.toISOString()}, 10:00 Tbilisi)`);
  setTimeout(() => {
    refreshTourismData();
    setInterval(refreshTourismData, 24 * 60 * 60 * 1000);
  }, delay);
}

// Init: load from disk, schedule daily refresh. Also refresh shortly after
// boot so a restarted/redeployed container picks up anything it missed
// (same approach as the trade boot check).
loadTourismFromDisk();
scheduleTourismRefresh();
setTimeout(() => { refreshTourismData(); }, 20_000);

router.get('/tourism', async (req, res) => {
  try {
    // Serve from memory/disk cache if available
    if (tourismCache.data) {
      // Staleness backstop: if the daily scheduler somehow stopped firing
      // (container clock suspension etc.), refresh in the background.
      if (Date.now() - tourismCache.ts > TOURISM_CACHE_TTL && !tourismRefreshRunning) {
        refreshTourismData().catch(() => {});
      }
      return res.json(tourismCache.data);
    }
    // First request ever with no disk cache — do one blocking refresh
    await refreshTourismData();
    if (tourismCache.data) {
      return res.json(tourismCache.data);
    }
    res.status(502).json({ error: 'Tourism data not available yet' });
  } catch (err) {
    console.error('Tourism data error:', err.message);
    res.status(502).json({ error: 'Failed to load tourism data' });
  }
});

// Observability: current checkpoint, period and refresh state.
router.get('/tourism-status', (req, res) => {
  res.json({
    success: true,
    state: {
      quarterlyId: readCachedQuarterlyId(),
      currentPeriod: (tourismCache.data && tourismCache.data.currentPeriod)
        ? tourismCache.data.currentPeriod.label : null,
      lastRefreshAt: tourismStatus.lastRefreshAt,
      lastError: tourismStatus.lastError,
      refreshRunning: tourismRefreshRunning,
    },
  });
});

// Manual force-refresh (fire-and-forget — a full scan can take a while).
// Poll /tourism-status to observe completion.
router.post('/tourism/refresh', ...adminOnly, (req, res) => {
  if (tourismRefreshRunning) {
    return res.json({ success: true, started: false, alreadyRunning: true });
  }
  refreshTourismData().catch(() => {});
  res.json({ success: true, started: true });
});

// ── POST /api/statistics/fdi-sectors(/upload) ───────────────────────────
// FDI breakdown by country × sector × year. Data comes from an admin-uploaded
// XLSX file. No initial data is bundled — the endpoint returns {empty:true}
// until the first upload.

let fdiSectorsCache = { data: null };

// Sector name mapping: full Georgian name → { short (Georgian), en (English) }
const SECTOR_NAMES = {
  'სულ': { short: 'სულ', en: 'Total' },
  'სოფლის, სატყეო და თევზის მეურნეობა': { short: 'სოფლის მეურნეობა', en: 'Agriculture' },
  'დამამუშავებელი მრეწველობა': { short: 'დამამუშავებელი მრეწველობა', en: 'Manufacturing' },
  'ელექტროენერგიის, აირის, ორთქლის და კონდიცირებული ჰაერის მიწოდება': { short: 'ენერგეტიკა', en: 'Energy' },
  'მშენებლობა': { short: 'მშენებლობა', en: 'Construction' },
  'საბითუმო და საცალო ვაჭრობა; ავტომობილების და მოტოციკლების რემონტი': { short: 'საბითუმო და საცალო ვაჭრობა', en: 'Wholesale and Retail Trade' },
  'ტრანსპორტი და დასაწყობება': { short: 'ტრანსპორტი', en: 'Transport' },
  'განთავსების საშუალებებით უზრუნველყოფის და საკვების მიწოდების საქმიანობები': { short: 'სასტუმროები და რესტორნები', en: 'Hotels and Restaurants' },
  'ინფორმაცია და კომუნიკაცია': { short: 'ინფორმაცია და კომუნიკაცია', en: 'Information and Communication' },
  'საფინანსო და სადაზღვევო საქმიანობები': { short: 'საფინანსო და სადაზღვევო საქმიანობები', en: 'Financial and Insurance Activities' },
  'უძრავ ქონებასთან დაკავშირებული საქმიანობები': { short: 'უძრავი ქონება', en: 'Real Estate' },
  'პროფესიული, სამეცნიერო და ტექნიკური საქმიანობები': { short: 'სამეცნიერო საქმიანობები', en: 'Scientific Activities' },
  'ადმინისტრაციული და დამხმარე მომსახურების საქმიანობები': { short: 'ადმინისტრაციული საქმიანობები', en: 'Administrative Activities' },
  'განათლება': { short: 'განათლება', en: 'Education' },
  'ჯანდაცვა და სოციალური მომსახურების საქმიანობები': { short: 'ჯანდაცვა', en: 'Healthcare' },
  'სამთომოპოვებითი მრეწველობა და კარიერების დამუშავება': { short: 'სამთომოპოვებითი მრეწველობა', en: 'Mining and Quarrying' },
  'წყალმომარაგება; კანალიზაცია, ნარჩენების მართვა და დაბინძურებისაგან გასუფთავების საქმიანობები': { short: 'წყალმომარაგება', en: 'Water Supply' },
  'სხვა სახის მომსახურება': { short: 'სხვა სახის მომსახურება', en: 'Other Services' },
  'ხელოვნება, გართობა და დასვენება': { short: 'ხელოვნება', en: 'Arts' },
};

function sectorShortName(fullName) {
  const m = SECTOR_NAMES[fullName];
  return m ? m.short : fullName;
}

function sectorEnName(fullName) {
  const m = SECTOR_NAMES[fullName];
  return m ? m.en : fullName;
}

/**
 * Columns from D onwards that carry numbers but were not read as periods.
 *
 * A period column whose header the parser cannot make sense of is dropped in
 * silence — which is how a newly added quarter goes missing from an upload
 * that otherwise reports success. The commonest cause is a merged header
 * cell: a merge gives its value to its top-left cell only, so a quarter
 * labelled by one merge across several columns arrives as one labelled
 * column followed by blanks.
 *
 * Only columns holding actual numbers are reported, so the trailing empty
 * columns every workbook carries stay quiet.
 */
function unreadPeriodColumns(rows, headerIdx, header, periodCols) {
  const taken = new Set(periodCols.map((p) => p.col));
  const ignored = [];
  for (let c = 3; c < header.length; c++) {
    if (taken.has(c)) continue;
    let carriesData = false;
    for (let r = headerIdx + 1; r < rows.length && !carriesData; r++) {
      const v = (rows[r] || [])[c];
      if (v === null || v === undefined || v === '' || v === '-') continue;
      const n = parseFloat(String(v).replace(/,/g, '').replace(/\s/g, ''));
      if (!isNaN(n)) carriesData = true;
    }
    if (carriesData) {
      ignored.push({ column: XLSX.utils.encode_col(c), header: String(header[c] == null ? '' : header[c]).trim() });
    }
  }
  return ignored;
}

function parseFdiSectorsWorkbook(wb) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Workbook has no sheets');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Find the header row: it has "ქვეყნის კოდი" in column A.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i] || [];
    if (String(row[0] || '').trim() === 'ქვეყნის კოდი') { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('Header row with "ქვეყნის კოდი" not found');

  // Detect period columns from the header (D onwards). Accepts:
  //   "2025"           → label "2025"
  //   "2025*"          → label "2025" (preliminary marker stripped)
  //   "2026 I კვ"      → label "2026 I კვ" (quarterly)
  //   "Q1 2026"        → label "Q1 2026"
  // Any header whose stripped form contains a 4-digit year in [2000..2100]
  // counts. The raw label is preserved so the UI can render "2026 I კვ"
  // instead of just "2026".
  const header = rows[headerIdx];
  const periodCols = [];
  for (let c = 3; c < header.length; c++) {
    const raw = String(header[c] || '').replace(/\*/g, '').trim();
    if (!raw) continue;
    const m = /\b(20\d{2}|21\d{2})\b/.exec(raw);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    if (year < 2000 || year > 2100) continue;
    periodCols.push({ col: c, label: raw });
  }
  if (!periodCols.length) throw new Error('No year/period columns found in header');
  const years = periodCols.map(p => p.label); // strings (may include quarter suffix)

  function parseNum(v) {
    if (v === null || v === undefined || v === '-' || v === '') return null;
    const s = String(v).replace(/,/g, '').replace(/\s/g, '').replace(/\u00A0/g, '');
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return n / 1000; // thousand USD → mln USD
  }

  const countries = {};
  const sectorsSet = new Set();
  let current = null;

  // Skip the grand-total block at the top: first country block starts when a
  // row has a non-empty country code in col A.
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const codeRaw = row[0] != null ? String(row[0]).trim() : '';
    const nameRaw = row[1] != null ? String(row[1]).trim() : '';
    const sectorRaw = row[2] != null ? String(row[2]).trim() : '';

    if (codeRaw && !isNaN(parseInt(codeRaw, 10))) {
      // Start a new country block (the row itself may be "სულ" or a sector —
      // but typically it's the total row).
      const code = String(parseInt(codeRaw, 10));
      current = { code, name: nameRaw };
      if (!countries[code]) countries[code] = { name: nameRaw, sectors: {}, totals: {} };
    }
    if (!current || !sectorRaw) continue;

    const values = {};
    for (const { col, label } of periodCols) values[label] = parseNum(row[col]);

    if (sectorRaw === 'სულ') {
      countries[current.code].totals = values;
    } else {
      // Store using the short Georgian name as the key
      const shortName = sectorShortName(sectorRaw);
      countries[current.code].sectors[shortName] = values;
      sectorsSet.add(shortName);
    }
  }

  // Countries whose block has no "სულ" row get totals computed by summing
  // their sector values per period. A period where every sector is empty
  // stays null so the UI keeps rendering "-".
  for (const country of Object.values(countries)) {
    if (Object.keys(country.totals).length) continue;
    for (const { label } of periodCols) {
      let sum = null;
      for (const vals of Object.values(country.sectors)) {
        const v = vals[label];
        if (v !== null && v !== undefined) sum = (sum || 0) + v;
      }
      country.totals[label] = sum;
    }
  }

  // Build sector name mapping for the API response (short KA → EN)
  const sectorNameMap = {};
  for (const s of sectorsSet) {
    // Find the English name by checking all mappings
    for (const [full, m] of Object.entries(SECTOR_NAMES)) {
      if (m.short === s) { sectorNameMap[s] = m.en; break; }
    }
    if (!sectorNameMap[s]) sectorNameMap[s] = s;
  }

  return {
    uploadedAt: new Date().toISOString(),
    years,
    sectors: Array.from(sectorsSet),
    sectorNameMap,
    countries,
    // Kept with the snapshot, not just reported once: it records what this
    // stored dataset left behind, so a table missing a period can be
    // explained long after the upload that produced it.
    ignoredColumns: unreadPeriodColumns(rows, headerIdx, header, periodCols),
  };
}

async function loadFdiSectorsFromDb() {
  const parsed = await loadParsed('fdi-sectors');
  if (parsed) {
    fdiSectorsCache.data = parsed;
    console.log(`fdi-sectors: loaded from DB (${Object.keys(parsed.countries || {}).length} countries, years ${parsed.years?.join(',')})`);
  }
}

// Init: load any previously uploaded data on module load.
loadFdiSectorsFromDb().catch((err) => console.warn('fdi-sectors load failed:', err.message));

router.get('/fdi-sectors', (req, res) => {
  const data = fdiSectorsCache.data;
  if (!data) return res.json({ success: true, empty: true });
  res.json({
    success: true,
    uploadedAt: data.uploadedAt,
    years: data.years,
    sectors: data.sectors,
    sectorNameMap: data.sectorNameMap || {},
    countries: data.countries,
    yearsCovered: data.years,
    countryCount: Object.keys(data.countries).length,
    sectorCount: data.sectors.length,
  });
});

router.post('/fdi-sectors/upload', ...adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const parsed = parseFdiSectorsWorkbook(wb);
    const countryCount = Object.keys(parsed.countries).length;
    if (!countryCount) return res.status(400).json({ error: 'No country data found in file' });
    await saveParsedAndRaw('fdi-sectors', parsed, req.file.buffer, uploadedFileName(req.file));
    fdiSectorsCache.data = parsed;
    console.log(`fdi-sectors: uploaded (${countryCount} countries, ${parsed.sectors.length} sectors, years ${parsed.years.join(',')})`);
    if (parsed.ignoredColumns.length) {
      console.warn('fdi-sectors: columns with data but no readable period header were ignored:',
        parsed.ignoredColumns.map((c) => `${c.column}${c.header ? ` (${c.header})` : ' (blank header)'}`).join(', '));
    }

    // Both FDI series follow the same quarterly Geostat release, so refresh
    // the annual-by-country snapshot alongside the sector upload. A failed
    // refresh doesn't fail the upload — the previous snapshot stays.
    let fdiAnnual;
    try {
      const annual = await refreshFdiAnnual();
      fdiAnnual = { refreshed: true, latestYear: annual.years[annual.years.length - 1] };
    } catch (annErr) {
      console.warn('fdi-sectors upload: annual FDI refresh failed:', annErr.message);
      fdiAnnual = { refreshed: false, error: annErr.message };
    }

    res.json({
      success: true,
      uploadedAt: parsed.uploadedAt,
      yearsCovered: parsed.years,
      countryCount,
      sectorCount: parsed.sectors.length,
      ignoredColumns: parsed.ignoredColumns,
      fdiAnnual,
    });
  } catch (err) {
    console.error('fdi-sectors upload error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to parse uploaded file' });
  }
});

// ── POST /api/statistics/companies/data ─────────────────────────────────
// Active-companies registry broken down by partner-country composition.
// The source XLSX is ~27 MB with ~152K rows. Parsing that synchronously
// in Node exceeds the upstream proxy timeout AND can OOM the container,
// so the aggregation is performed client-side in the admin browser and
// the already-aggregated JSON is POSTed here. The payload is tiny (one
// entry per country).

let companiesCache = { data: null };

async function loadCompaniesFromDb() {
  const parsed = await loadParsed('companies');
  if (parsed) {
    companiesCache.data = parsed;
    console.log(`companies: loaded from DB (${Object.keys(parsed.countries || {}).length} countries, ${parsed.activeCount || 0} active)`);
  }
}
loadCompaniesFromDb().catch((err) => console.warn('companies load failed:', err.message));

router.get('/companies', (req, res) => {
  const data = companiesCache.data;
  if (!data) return res.json({ success: true, empty: true });
  res.json({
    success: true,
    uploadedAt: data.uploadedAt,
    countries: data.countries,
    countryCount: Object.keys(data.countries).length,
    activeCount: data.activeCount,
  });
});

function sanitizeCounts(raw) {
  const out = {};
  for (const k of ['total', 'solo', 'withGeorgia', 'withGeorgiaAndThird', 'withThirdOnly']) {
    const n = Number(raw && raw[k]);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  return out;
}

router.post('/companies/data', ...adminOnly, async (req, res) => {
  try {
    const { countries, activeCount } = req.body || {};
    if (!countries || typeof countries !== 'object') {
      return res.status(400).json({ error: 'Missing "countries" object' });
    }
    const clean = {};
    for (const [name, counts] of Object.entries(countries)) {
      if (!name || typeof name !== 'string') continue;
      clean[name] = sanitizeCounts(counts);
    }
    if (!Object.keys(clean).length) {
      return res.status(400).json({ error: 'No valid country entries' });
    }
    const parsed = {
      uploadedAt: new Date().toISOString(),
      activeCount: Number.isFinite(Number(activeCount)) ? Math.round(Number(activeCount)) : 0,
      countries: clean,
    };
    await saveParsedAndRaw('companies', parsed);
    companiesCache.data = parsed;
    console.log(`companies: data saved (${Object.keys(clean).length} countries, ${parsed.activeCount} active)`);
    res.json({
      success: true,
      uploadedAt: parsed.uploadedAt,
      countryCount: Object.keys(clean).length,
      activeCount: parsed.activeCount,
    });
  } catch (err) {
    console.error('companies data save error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to save companies data' });
  }
});

// ─── Stored original files ───────────────────────────────────────────────────
// The admin uploads the datasets that drive these pages; these hand the
// original files back. Only the three real datasets are addressable: the
// legacy disk migration also swept server/data/*.json into admin_uploads
// (countries, departments, users, tourism-cache), and those are not files
// anyone uploaded.
const DOWNLOADABLE_KINDS = ['fdi-sectors', 'companies', 'fdi-annual'];

/**
 * The name a multipart upload arrived with.
 *
 * Busboy hands filenames back as latin1, so a Georgian or otherwise non-ASCII
 * name is mojibake unless it is read back as UTF-8 — the same fix the event
 * attachment upload applies.
 */
function uploadedFileName(file) {
  if (!file || !file.originalname) return null;
  try {
    return Buffer.from(file.originalname, 'latin1').toString('utf8');
  } catch (_) {
    return file.originalname;
  }
}

/**
 * An attachment Content-Disposition carrying a name of any script.
 *
 * RFC 5987: filename* holds the UTF-8 name and the plain filename is the ASCII
 * fallback. encodeURIComponent leaves an apostrophe alone, and since ' is the
 * ext-value delimiter a name like "company's registry.xlsx" would otherwise
 * add a third one and make the parameter unparseable.
 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(name).replace(/'/g, '%27');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Fallback name for a file stored before the name was kept. */
function fallbackFileName(kind, uploadedAt) {
  const day = uploadedAt ? new Date(uploadedAt).toISOString().slice(0, 10) : 'stored';
  return `${kind}-${day}.xlsx`;
}

// GET /api/statistics/uploads — what is stored, for the admin page.
// Deliberately reads length(raw_bytes) rather than the bytes: the companies
// registry runs to tens of megabytes and listing must not haul it into memory.
router.get('/uploads', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT kind, file_name, uploaded_at, file_uploaded_at,
              length(raw_bytes) AS file_size
       FROM admin_uploads
       WHERE kind = ANY($1) AND raw_bytes IS NOT NULL
       ORDER BY kind`,
      [DOWNLOADABLE_KINDS]
    );
    res.json(rows.map((r) => {
      // The file's own timestamp, not the dataset's. A browser-parsed upload
      // saves its summary first and its file after, so a failed second step
      // leaves an older file behind newer figures — and saying so is better
      // than stamping the old workbook with the new date.
      const fileAt = r.file_uploaded_at || r.uploaded_at;
      return {
        kind: r.kind,
        fileName: r.file_name || fallbackFileName(r.kind, fileAt),
        fileSize: Number(r.file_size || 0),
        uploadedAt: fileAt,
        // True when the stored file predates the data it sits beside.
        stale: !!r.file_uploaded_at && r.file_uploaded_at < r.uploaded_at,
      };
    }));
  } catch (err) {
    console.error('admin uploads list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/statistics/uploads/:kind/download — hand the original file back.
router.get('/uploads/:kind/download', ...adminOnly, async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!DOWNLOADABLE_KINDS.includes(kind)) {
      return res.status(404).json({ error: 'Unknown upload' });
    }
    const { rows: [row] } = await db.query(
      `SELECT raw_bytes, file_name, COALESCE(file_uploaded_at, uploaded_at) AS uploaded_at
       FROM admin_uploads WHERE kind = $1`,
      [kind]
    );
    if (!row) return res.status(404).json({ error: 'Nothing uploaded for this dataset' });
    if (!row.raw_bytes) {
      return res.status(404).json({ error: 'The original file was not kept for this upload' });
    }

    const name = row.file_name || fallbackFileName(kind, row.uploaded_at);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', contentDisposition(name));
    res.send(row.raw_bytes);
  } catch (err) {
    console.error('admin upload download error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/statistics/companies/file — archive the original companies file.
//
// The registry is parsed in the browser and only its summary is posted (see
// /companies/data), so the file itself has to arrive separately to be
// downloadable later. Bytes and name only: parsed_json belongs to the summary
// save, and a failure here must leave the already-saved statistics untouched.
router.post('/companies/file', ...adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
    const stored = await saveRawFile('companies', req.file.buffer, uploadedFileName(req.file));
    if (!stored) {
      return res.status(409).json({ error: 'Upload the companies data before archiving its file' });
    }
    console.log(`companies: archived original file (${req.file.size} bytes)`);
    res.json({ success: true, fileSize: req.file.size, fileName: uploadedFileName(req.file) });
  } catch (err) {
    console.error('companies file archive error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to store the file' });
  }
});

module.exports = router;
