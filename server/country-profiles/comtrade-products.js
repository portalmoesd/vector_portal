/**
 * Main traded products per economy — UN Comtrade, top HS4 headings by
 * share of the flow.
 *
 * Uses the export potential pipeline's Comtrade client (disk cache, one
 * call a second, daily budget, key rotation). One metered call per
 * reporter, year and flow, at HS4 with the world as partner; the response
 * is reduced to the top N shares before anything is stored, so the
 * database never holds raw trade values.
 *
 * Idempotent and resumable: an economy whose stored year already equals
 * its latest available year costs no call, so a run interrupted by the
 * daily budget picks up where it stopped. The products therefore follow
 * the trade data: the check runs after every trade sync, and an economy
 * is re-pulled only when Comtrade has published a newer year than the
 * one stored. Shares use the sum of the HS4 rows as denominator.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const comtrade = require('../export-potential/pipeline/comtrade');

const SOURCE = {
  id: 'un-comtrade',
  name: 'UN Comtrade',
  url: 'https://comtradeplus.un.org/',
  license: 'UN Comtrade terms of use; derived shares only',
};
const TOP_N = 5;
const FLOWS = ['X', 'M'];
const LOOKBACK_YEARS = 4; // how far back to look for a reporter's latest annual data

let running = false;
function isRunning() { return running; }
function hasKey() { return !!(process.env.COMTRADE_API_KEY || process.env.COMTRADE_API_KEY_SECONDARY); }

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Reduce one reporter/year/flow response (HS4 rows, partner = world) to the
 * top N headings by share. Rows that are not 4-digit codes (TOTAL, 2-digit
 * chapters if present) are ignored; the denominator is the sum of the HS4
 * rows. Returns [] when there is nothing to rank.
 */
function topProducts(rows, n = TOP_N) {
  const byCode = new Map();
  for (const r of rows || []) {
    const code = String(r.cmdCode || '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    const v = Number(r.primaryValue);
    if (!Number.isFinite(v) || v <= 0) continue;
    byCode.set(code, (byCode.get(code) || 0) + v);
  }
  let total = 0;
  for (const v of byCode.values()) total += v;
  if (!(total > 0)) return [];
  return [...byCode.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([hs4, v], i) => ({ rank: i + 1, hs4, share: v / total }));
}

/**
 * Comtrade's reference list maps one ISO3 code to several areas for some
 * economies, historical ones included ("Fed. Rep. of Germany (...1990)"
 * precedes "Germany" in the file; the USA has 840, 841 and 842). Pick the
 * candidate with the latest published annual HS year; on a tie prefer a
 * name without a "(...YYYY)" closing year. Returns { code, year } or null.
 */
function pickReporter(candidates, daRows) {
  let best = null;
  for (const c of candidates || []) {
    const year = latestYearFor(daRows, c.code);
    if (year == null) continue;
    const historical = /\(\.\.\./.test(c.text || '');
    if (!best || year > best.year || (year === best.year && best.historical && !historical)) best = { code: c.code, year, historical };
  }
  return best ? { code: best.code, year: best.year } : null;
}

/**
 * From the public data-availability rows, the latest annual HS year a
 * reporter has published, or null. `rows` are getDataAvailability() rows.
 */
function latestYearFor(rows, reporterCode) {
  let best = null;
  for (const r of rows || []) {
    if (Number(r.reporterCode) !== Number(reporterCode)) continue;
    if (!/^H/.test(String(r.classificationCode || ''))) continue;
    if (best == null || r.period > best) best = Number(r.period);
  }
  return best;
}

// ── Sync ──────────────────────────────────────────────────────────────────

/**
 * Sync the top products for every economy in stat_countries (or `only`
 * ISO3 codes). Returns a summary; source-side failures are recorded per
 * economy, never thrown.
 */
async function syncProducts({ db, trigger = 'cli', log = () => {}, only = null, budget = Infinity, dryRun = false } = {}) {
  if (running) { log('a products sync is already running; skipped'); return { skipped: true }; }
  running = true;
  const started = Date.now();
  const entries = [];
  const note = (level, step, message, extra) => {
    entries.push({ at: new Date().toISOString(), level, step, message, ...(extra || {}) });
    log(`${level === 'error' ? 'ERROR ' : ''}${step}: ${message}`);
  };
  let ok = 0; let failed = 0; let skipped = 0; let calls = 0; let runId = null; let stoppedByBudget = false;

  try {
    if (!hasKey()) {
      note('error', 'comtrade', 'COMTRADE_API_KEY is not set; nothing pulled');
      failed = 1;
    } else {
      if (!dryRun) {
        await db.query(
          `INSERT INTO stat_sources (id, name, url, license) VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, license = EXCLUDED.license`,
          [SOURCE.id, SOURCE.name, SOURCE.url, SOURCE.license]
        );
        const { rows: [run] } = await db.query('INSERT INTO stat_sync_runs (source_id, trigger) VALUES ($1, $2) RETURNING id', [SOURCE.id, trigger]);
        runId = run.id;
      }

      // Reporters: the portal's economies matched to Comtrade reporter codes
      // via the public reference list, then their latest published year.
      const thisYear = new Date().getUTCFullYear();
      const years = []; for (let y = thisYear - LOOKBACK_YEARS; y <= thisYear; y++) years.push(y);
      const [areas, da] = await Promise.all([comtrade.getPartnerAreas(), comtrade.getDataAvailability(years)]);
      const candidatesByIso3 = new Map();
      for (const a of areas) {
        if (!a.iso3 || a.isGroup) continue;
        if (!candidatesByIso3.has(a.iso3)) candidatesByIso3.set(a.iso3, []);
        candidatesByIso3.get(a.iso3).push({ code: a.code, text: a.text });
      }

      const { rows: countries } = await db.query(
        `SELECT iso3 FROM stat_countries ${only ? 'WHERE iso3 = ANY($1::text[])' : ''} ORDER BY iso3`,
        only ? [only] : []
      );
      const { rows: stored } = await db.query('SELECT iso3, flow, max(year) AS year FROM stat_country_products WHERE source_id = $1 GROUP BY iso3, flow', [SOURCE.id]);
      const storedYear = new Map(stored.map((r) => [`${r.iso3}:${r.flow}`, Number(r.year)]));

      for (const { iso3 } of countries) {
        const candidates = candidatesByIso3.get(iso3);
        const picked = candidates ? pickReporter(candidates, da) : null;
        if (!picked) { skipped++; note('info', iso3, !candidates ? 'not a Comtrade reporter' : 'no annual HS data in the look-back window'); continue; }
        const { code: reporterCode, year } = picked;
        for (const flow of FLOWS) {
          const have = storedYear.get(`${iso3}:${flow}`);
          if (have === year) { skipped++; continue; } // already current
          if (have != null && have > year) { skipped++; continue; } // never replace with an older year
          try {
            const res = await comtrade.getTrade({ reporterCode, period: year, flowCode: flow, partnerCode: 0, cmdCode: 'AG4' }, { budget });
            if (!res.fromCache) calls++;
            if (res.truncated) throw new Error('response truncated at the record cap');
            const top = topProducts(res.rows, TOP_N);
            if (!top.length) throw new Error('no HS4 rows returned');
            if (!dryRun) await replaceProducts(db, iso3, flow, year, top, reporterCode);
            ok++;
            note('info', `${iso3}/${flow}`, `${have != null ? `${have} -> ` : ''}${year}: ${top.map((p) => `${p.hs4} ${(p.share * 100).toFixed(1)}%`).join(', ')}`);
          } catch (err) {
            if (err instanceof comtrade.BudgetExhausted) { stoppedByBudget = true; note('warn', 'budget', `${err.message}; remaining economies resume on the next run`); break; }
            failed++;
            note('error', `${iso3}/${flow}`, `pull failed, previous products kept: ${err.message}`);
          }
        }
        if (stoppedByBudget) break;
      }
    }
  } finally {
    running = false;
  }

  const status = failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial';
  if (!dryRun && runId != null) {
    await db.query(
      'UPDATE stat_sync_runs SET finished_at = now(), status = $2, ok_count = $3, failed_count = $4, log = $5::jsonb WHERE id = $1',
      [runId, status, ok, failed, JSON.stringify(entries)]
    );
  }
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${status} (${ok} pulled, ${skipped} already current or unavailable, ${failed} failed, ${calls} Comtrade calls)${stoppedByBudget ? ' [budget reached]' : ''}`);
  return { runId, status, ok, failed, skipped, calls, stoppedByBudget, entries };
}

async function replaceProducts(db, iso3, flow, year, top, reporterCode) {
  const client = await db.pool.connect();
  const url = `https://comtradeplus.un.org/TradeFlow?Frequency=A&Flows=${flow}&CommodityCodes=AG4&Partners=0&Reporters=${reporterCode}&period=${year}&AggregateBy=none&BreakdownMode=plus`;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM stat_country_products WHERE iso3 = $1 AND flow = $2', [iso3, flow]);
    for (const p of top) {
      await client.query(
        `INSERT INTO stat_country_products (iso3, flow, year, rank, hs4, share, source_id, source_name, source_url, retrieved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
        [iso3, flow, year, p.rank, p.hs4, p.share, SOURCE.id, SOURCE.name, url]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[a.slice(2)] = true; else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!require('../config').databaseUrl) { console.error('DATABASE_URL is not set (see .env.example)'); process.exit(1); }
  const db = require('../db');
  const fs = require('fs');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  const only = args.countries ? String(args.countries).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean) : null;
  const budget = args.budget ? Number(args.budget) : (require('../export-potential/scoring').loadConfig().pipeline.comtrade.dailyCallBudget || Infinity);
  const r = await syncProducts({ db, trigger: 'cli', only, budget, dryRun: !!args['dry-run'], log: (m) => process.stderr.write(`[country-products ${new Date().toISOString().slice(11, 19)}] ${m}\n`) });
  await db.pool.end();
  process.exit(r.status === 'failed' ? 2 : 0);
}

module.exports = { SOURCE, TOP_N, FLOWS, topProducts, latestYearFor, pickReporter, syncProducts, isRunning, hasKey };

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
