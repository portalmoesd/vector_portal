/**
 * CIA World Factbook text for the Country Profiles pages.
 *
 * The Factbook was discontinued by the CIA on 4 February 2026. What remains
 * is the public-domain final snapshot republished by the factbook.json
 * project (CC0). This module has two halves:
 *
 *   extract  — pure functions that turn one upstream profile into the four
 *              sections we show (Introduction, Geography, People and
 *              Society, Government), with the officials fields removed and
 *              the HTML reduced to a small safe vocabulary. The CLI writes
 *              the result to server/data/factbook/profiles/<ISO3>.json,
 *              which is committed, so the import needs no network.
 *   import   — loads those files into stat_country_texts. Idempotent; rows
 *              an admin has edited (edited_at set) are never overwritten.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');

const DATA_DIR = path.join(__dirname, '..', 'data', 'factbook');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const MAPPING_FILE = path.join(DATA_DIR, 'gec-to-iso3.json');

const SOURCE = {
  id: 'cia-factbook',
  name: 'CIA World Factbook',
  url: 'https://github.com/factbook/factbook.json',
  license: 'Public domain (US Government work); factbook.json conversion CC0 1.0',
};

const SECTIONS = ['Introduction', 'Geography', 'People and Society', 'Government'];

// Fields dropped at extraction time and never stored: officials (out of
// scope for the portal) and the geography detail the page does not show.
const EXCLUDED_FIELDS = {
  Geography: [
    'Location', 'Geographic coordinates', 'Area', 'Area - comparative', 'Maritime claims',
    'Land use', 'Irrigated land',
  ],
  Government: ['Diplomatic representation in the US', 'Diplomatic representation from the US'],
};

// Where each stored section lands on the profile page. A field-level entry
// overrides the section default and may rename the field for display; the
// source's own field name stays in the database.
const PAGE_SECTIONS = ['introduction', 'overview', 'people', 'government'];
const DISPLAY = {
  Introduction: { page: 'introduction' },
  Geography: {
    page: 'overview',
    fields: { 'Map references': { label: 'Continent' } },
  },
  'People and Society': { page: 'people' },
  Government: { page: 'government' },
};

// Resolve the page section and display label for one stored row.
function displayPlacement(section, field) {
  const d = DISPLAY[section] || { page: null };
  const f = (d.fields || {})[field] || {};
  return { page: f.page || d.page || null, label: f.label || field };
}
const EXCLUDED_ITEMS = {
  Government: { 'Executive branch': ['chief of state', 'head of government', 'cabinet'] },
};

const SANITIZE = {
  allowedTags: ['br', 'p', 'em', 'strong', 'i', 'b', 'sup', 'sub', 'ul', 'ol', 'li'],
  allowedAttributes: {},
  // The source uses <br><br> as paragraph breaks; keep them, drop the rest.
};

function cleanText(raw) {
  if (raw == null) return null;
  let s = sanitizeHtml(String(raw), SANITIZE).trim();
  s = s.replace(/^(<br\s*\/?>\s*)+/i, '').replace(/(\s*<br\s*\/?>)+$/i, '').trim();
  return s || null;
}

/**
 * Normalize one Factbook field: {text} or {sub: {text}, ...} (optionally
 * with its own "note") into { text, items: [{label, text}] }.
 */
function normalizeField(section, field, value) {
  const out = { text: null, items: [] };
  if (!value || typeof value !== 'object') return out;
  const dropItems = (EXCLUDED_ITEMS[section] || {})[field] || [];
  for (const [rawKey, v] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key === 'text') { out.text = cleanText(v); continue; }
    if (dropItems.includes(key)) continue;
    const text = v && typeof v === 'object' ? cleanText(v.text) : cleanText(v);
    if (text) out.items.push({ label: key, text });
  }
  return out;
}

/**
 * Extract the four sections from one upstream profile object.
 * Returns { sections: { [section]: [{ field, order, content }] } }.
 */
function extractProfile(profile) {
  const sections = {};
  for (const section of SECTIONS) {
    const src = profile && profile[section];
    if (!src || typeof src !== 'object') continue;
    const skip = EXCLUDED_FIELDS[section] || [];
    const rows = [];
    let order = 0;
    for (const [field, value] of Object.entries(src)) {
      if (skip.includes(field)) continue;
      const content = normalizeField(section, field, value);
      if (!content.text && !content.items.length) continue;
      rows.push({ field, order: (order += 10), content });
    }
    if (rows.length) sections[section] = rows;
  }
  return { sections };
}

function factbookName(profile) {
  const cn = profile && profile.Government && profile.Government['Country name'];
  const short = cn && cn['conventional short form'] && cn['conventional short form'].text;
  const long = cn && cn['conventional long form'] && cn['conventional long form'].text;
  return cleanText(short && short !== 'none' ? short : long) || null;
}

function readMapping() {
  return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8')); // { ISO3: gec }
}

/**
 * Build the committed data files from an upstream factbook.json checkout.
 * Returns a report; throws if the checkout is missing.
 */
function extractAll(upstreamDir, { snapshotDate, upstreamCommit } = {}) {
  const mapping = readMapping();
  const files = new Map(); // gec -> path
  for (const region of fs.readdirSync(upstreamDir)) {
    const dir = path.join(upstreamDir, region);
    if (!fs.statSync(dir).isDirectory() || region.startsWith('.') || region === 'meta') continue;
    for (const f of fs.readdirSync(dir)) if (/^[a-z]{2}\.json$/.test(f)) files.set(f.slice(0, 2), path.join(dir, f));
  }
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const report = { written: 0, missing: [], fields: 0 };
  for (const [iso3, gec] of Object.entries(mapping)) {
    const file = files.get(gec);
    if (!file) { report.missing.push({ iso3, gec }); continue; }
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { sections } = extractProfile(profile);
    for (const rows of Object.values(sections)) report.fields += rows.length;
    const out = { iso3, gec, name: factbookName(profile), sections };
    fs.writeFileSync(path.join(PROFILES_DIR, `${iso3}.json`), JSON.stringify(out, null, 1) + '\n');
    report.written++;
  }
  const meta = {
    source: SOURCE,
    snapshotDate: snapshotDate || null,
    upstream: { repo: 'https://github.com/factbook/factbook.json', commit: upstreamCommit || null },
    discontinued: '2026-02-04',
    sections: SECTIONS,
    excludedFields: EXCLUDED_FIELDS,
    excludedItems: EXCLUDED_ITEMS,
    extractedAt: new Date().toISOString(),
    profiles: report.written,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  return report;
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { return null; }
}

function listProfiles() {
  let names = [];
  try { names = fs.readdirSync(PROFILES_DIR).filter((f) => /^[A-Z0-9]{3}\.json$/.test(f)); } catch (_) { /* none yet */ }
  return names.sort().map((f) => path.join(PROFILES_DIR, f));
}

/**
 * Load the committed data files into stat_country_texts. Rows are upserted;
 * an edited row (edited_at set) keeps its content, only its original_content
 * is refreshed. Returns { rows, countries, skippedEdited }.
 */
async function importFactbook(db, { log = () => {} } = {}) {
  const meta = readMeta();
  if (!meta) throw new Error(`no ${META_FILE}; run the extract step first`);
  const files = listProfiles();
  if (!files.length) throw new Error(`no profiles under ${PROFILES_DIR}`);
  await db.query(
    `INSERT INTO stat_sources (id, name, url, license) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, license = EXCLUDED.license`,
    [SOURCE.id, SOURCE.name, SOURCE.url, SOURCE.license]
  );
  const retrieved = meta.extractedAt ? new Date(meta.extractedAt) : new Date();
  const sourceUrl = meta.upstream && meta.upstream.commit
    ? `${meta.upstream.repo}/tree/${meta.upstream.commit}` : SOURCE.url;
  const client = await db.pool.connect();
  let rows = 0; let countries = 0;
  const keepSet = new Set(); const keep = [];
  try {
    await client.query('BEGIN');
    for (const file of files) {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      countries++;
      for (const [section, list] of Object.entries(p.sections || {})) {
        for (const r of list) {
          const k = `${section}\u0000${r.field}`;
          if (!keepSet.has(k)) { keepSet.add(k); keep.push({ section, field: r.field }); }
          await client.query(
            `INSERT INTO stat_country_texts
               (iso3, section, field, display_order, content, original_content, source_id, source_name, source_url, data_date, retrieved_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$5::jsonb,$6,$7,$8,$9,$10)
             ON CONFLICT (iso3, section, field) DO UPDATE SET
               display_order = EXCLUDED.display_order,
               original_content = EXCLUDED.original_content,
               content = CASE WHEN stat_country_texts.edited_at IS NULL THEN EXCLUDED.content ELSE stat_country_texts.content END,
               source_url = EXCLUDED.source_url, data_date = EXCLUDED.data_date, retrieved_at = EXCLUDED.retrieved_at,
               updated_at = now()`,
            [p.iso3, section, r.field, r.order, JSON.stringify(r.content), SOURCE.id, SOURCE.name, sourceUrl, meta.snapshotDate, retrieved]
          );
          rows++;
        }
      }
    }
    // Fields no longer shipped (excluded since the last import) are removed,
    // unless an admin has edited them.
    const { rowCount: removed } = await client.query(
      `DELETE FROM stat_country_texts t WHERE t.source_id = $1 AND t.edited_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(section, field)
                         WHERE k.section = t.section AND k.field = t.field)`,
      [SOURCE.id, keep.map((k) => k.section), keep.map((k) => k.field)]
    );
    await client.query('COMMIT');
    if (removed) log(`factbook: ${removed} rows of excluded fields removed`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows: [{ count: edited }] } = await db.query('SELECT count(*)::int AS count FROM stat_country_texts WHERE edited_at IS NOT NULL');
  log(`factbook: ${rows} fields for ${countries} countries loaded (${edited} edited rows kept)`);
  return { rows, countries, edited };
}

module.exports = {
  SOURCE, SECTIONS, EXCLUDED_FIELDS, EXCLUDED_ITEMS, PAGE_SECTIONS, DISPLAY, displayPlacement, DATA_DIR, PROFILES_DIR, META_FILE,
  cleanText, normalizeField, extractProfile, factbookName, extractAll, readMeta, listProfiles, importFactbook,
};
