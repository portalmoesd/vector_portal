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
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
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

// ── GET /api/statistics/classificatory ──────────────────────────────────────
// Returns countries, trade types, years, months, HS codes, etc.
// Strategy: fetch live every time, fall back to last-known-good only if
// Geostat is unreachable. `selected.month` changes when Geostat publishes
// a new month, so a stale cache can make the whole page display an old
// period — don't gate freshness behind a TTL.

let classCache = { en: null, ka: null, ts: 0 };

router.get('/classificatory', async (req, res) => {
  const lang = req.query.lang === 'ka' ? 'ka' : 'en';
  try {
    const data = await geostatFetch(`/classificatory?lang=${lang}`);
    classCache[lang] = data;
    classCache.ts = Date.now();
    res.json(data);
  } catch (err) {
    console.error('Statistics classificatory error:', err.message);
    if (classCache[lang]) {
      console.warn(`Serving stale classificatory (${lang}) from ${new Date(classCache.ts).toISOString()}`);
      return res.json(classCache[lang]);
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
  const data = await geostatFetch('/classificatory?lang=en');
  classCache.en = data;
  classCache.ts = Date.now();
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

    let cached = rankingCacheGet(cacheKey);
    debug.cacheHit = !!cached;

    if (!cached) {
      const t0 = Date.now();
      const allCountryIds = await getAllCountryIds();
      debug.classificatoryCountries = allCountryIds.length;
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
      if (allHaveData) rankingCacheSet(cacheKey, cached);
      debug.computedMs = Date.now() - t0;
      debug.cached = allHaveData;
      console.log(`country-ranking: completed in ${(debug.computedMs / 1000).toFixed(1)}s — exp:${exp.stats.withTrade} imp:${imp.stats.withTrade} domExp:${domExp.stats.withTrade} reExp:${reExp.stats.withTrade} countries`);
    }

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



// ── GET /api/statistics/fdi ──────────────────────────────────────────────
// Parses FDI by countries XLSX. Tries to download fresh from geostat.ge,
// falls back to local bundled copy. Cached for 24 hours (updates quarterly).

const FDI_URL = 'https://www.geostat.ge/media/77508/FDI_Geo_countries.xlsx';
const FDI_LOCAL = require('path').join(__dirname, '../data/FDI_Geo_countries.xlsx');
let fdiCache = { data: null, ts: 0 };
const FDI_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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

  return { success: true, years: years.map(y => y.year), countries, totals };
}

router.get('/fdi', async (req, res) => {
  try {
    if (fdiCache.data && Date.now() - fdiCache.ts < FDI_CACHE_TTL) {
      return res.json(fdiCache.data);
    }

    let wb;
    try {
      // Try downloading fresh copy — same TLS-chain workaround as
      // geostatFetch since www.geostat.ge shares the broken cert chain.
      const xlsxRes = await geostatHttp(FDI_URL, {
        headers: { 'User-Agent': 'VectorPortal/1.0' },
        timeout: 15_000,
        followRedirects: true,
      });
      if (!xlsxRes.ok) throw new Error(`HTTP ${xlsxRes.status}`);
      const buffer = xlsxRes.buffer();
      wb = XLSX.read(buffer, { type: 'buffer' });

      // Save fresh copy locally for future fallback
      require('fs').writeFileSync(FDI_LOCAL, buffer);
      console.log('FDI data refreshed from geostat.ge');
    } catch (dlErr) {
      // Fall back to local file
      console.log('FDI download failed, using local copy:', dlErr.message);
      wb = XLSX.readFile(FDI_LOCAL);
    }

    const result = parseFdiWorkbook(wb);
    fdiCache = { data: result, ts: Date.now() };
    res.json(result);
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

const TOURISM_HISTORICAL_URL = 'https://api.gnta.ge/api/v1/web/media/download/10068';
const TOURISM_HISTORICAL_LOCAL = path.join(__dirname, '../data/gnta-visitors-historical.xlsx');
const TOURISM_QUARTERLY_LOCAL = path.join(__dirname, '../data/gnta-visitors-quarterly.xlsx');
const TOURISM_QUARTERLY_ID_FILE = path.join(__dirname, '../data/gnta-quarterly-id.txt');
const TOURISM_MEDIA_BASE = 'https://api.gnta.ge/api/v1/web/media/download';

// Starting baseline for scanning when no cached ID exists
const TOURISM_QUARTERLY_BASE_ID = 10290;
const TOURISM_QUARTERLY_SCAN_RANGE = 200;

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

    const isPeriodLabel = s => /^\d{4}(\s+[IVX]+\s+კვ)?$/.test(s);
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

// Scan media IDs to find the latest quarterly XLSX.
// Returns { id, wb, parsed } for the highest-ID matching file, or null.
async function findLatestQuarterlyFile(lastKnownId) {
  const startId = lastKnownId || TOURISM_QUARTERLY_BASE_ID;
  const endId = startId + TOURISM_QUARTERLY_SCAN_RANGE;
  let bestMatch = null;

  // Scan high-to-low so we can short-circuit once we find the newest
  for (let id = endId; id >= startId; id--) {
    try {
      // HEAD to check content-type first (cheap)
      const headRes = await fetch(`${TOURISM_MEDIA_BASE}/${id}`, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!headRes.ok) continue;
      const ct = headRes.headers.get('content-type') || '';
      if (!ct.includes('spreadsheet')) continue;

      // Download and try to parse
      const getRes = await fetch(`${TOURISM_MEDIA_BASE}/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!getRes.ok) continue;
      const buffer = Buffer.from(await getRes.arrayBuffer());
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parsed = parseQuarterlyWorkbook(wb);
      if (parsed && Object.keys(parsed.countries).length > 50) {
        bestMatch = { id, buffer, parsed };
        break; // highest-ID match found
      }
    } catch (_) { /* skip */ }
  }
  return bestMatch;
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

    try {
      const scanStart = quarterlyId || TOURISM_QUARTERLY_BASE_ID;
      const match = await findLatestQuarterlyFile(scanStart);
      if (match) {
        quarterly = match.parsed;
        quarterlyId = match.id;
        fs.writeFileSync(TOURISM_QUARTERLY_LOCAL, match.buffer);
        writeCachedQuarterlyId(match.id);
        console.log(`tourism: quarterly file discovered: ID ${match.id} (${match.parsed.currentLabel})`);
      } else if (quarterlyId) {
        const localWb = XLSX.readFile(TOURISM_QUARTERLY_LOCAL);
        quarterly = parseQuarterlyWorkbook(localWb);
      }
    } catch (err) {
      console.log('tourism: quarterly discovery failed, trying local:', err.message);
      try {
        const localWb = XLSX.readFile(TOURISM_QUARTERLY_LOCAL);
        quarterly = parseQuarterlyWorkbook(localWb);
      } catch (_) { /* no local either */ }
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
    console.log(`tourism: refresh completed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${Object.keys(countries).length} countries`);
    console.log(`tourism: annual totals sample:`, JSON.stringify(historical.totals ? Object.entries(historical.totals).slice(-3) : 'null'));
    console.log(`tourism: quarterly totals:`, JSON.stringify(quarterly?.periodTotals || 'null'));
  } catch (err) {
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

// Schedule daily refresh at 11:00 AM server time
function scheduleTourismRefresh() {
  const HOUR = 11;
  const now = new Date();
  const next = new Date();
  next.setHours(HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log(`tourism: next scheduled refresh in ${(delay / 3600000).toFixed(1)}h (${next.toISOString()})`);
  setTimeout(() => {
    refreshTourismData();
    setInterval(refreshTourismData, 24 * 60 * 60 * 1000);
  }, delay);
}

// Init: load from disk, schedule daily refresh
loadTourismFromDisk();
scheduleTourismRefresh();

router.get('/tourism', async (req, res) => {
  try {
    // Serve from memory/disk cache if available
    if (tourismCache.data) {
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

// ── POST /api/statistics/fdi-sectors(/upload) ───────────────────────────
// FDI breakdown by country × sector × year. Data comes from an admin-uploaded
// XLSX file. No initial data is bundled — the endpoint returns {empty:true}
// until the first upload.

const { upload, adminOnly, saveParsedAndRaw, loadParsed } = require('./admin-uploads');

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
    await saveParsedAndRaw('fdi-sectors', parsed, req.file.buffer);
    fdiSectorsCache.data = parsed;
    console.log(`fdi-sectors: uploaded (${countryCount} countries, ${parsed.sectors.length} sectors, years ${parsed.years.join(',')})`);
    res.json({
      success: true,
      uploadedAt: parsed.uploadedAt,
      yearsCovered: parsed.years,
      countryCount,
      sectorCount: parsed.sectors.length,
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

module.exports = router;
