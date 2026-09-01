/**
 * Shared helpers for admin-only XLSX/CSV file uploads.
 *
 * Uploads are persisted in the `admin_uploads` Postgres table so they
 * survive container restarts and redeploys (Render's filesystem is
 * ephemeral; anything written under server/data/ at runtime is wiped
 * on the next deploy).
 *
 * Intended usage (from a specific route file):
 *
 *   const { upload, adminOnly, saveParsedAndRaw, loadParsed } =
 *     require('./admin-uploads');
 *
 *   router.post('/my-kind/upload', ...adminOnly, upload.single('file'),
 *     async (req, res) => {
 *       const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
 *       const parsed = parseMyKind(wb);
 *       parsed.uploadedAt = new Date().toISOString();
 *       await saveParsedAndRaw('my-kind', parsed, req.file.buffer);
 *       // ...update in-memory cache, return response...
 *     });
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// Legacy disk path — used only for one-shot migration of previously
// uploaded files the first time the DB-backed version boots.
const LEGACY_DATA_DIR = path.join(__dirname, '../data');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Spread this into route definitions: router.post('/x', ...adminOnly, handler)
const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * Persist a parsed dataset, and the original file behind it where there is one.
 *
 * `buffer` and `fileName` are COALESCEd rather than overwritten: a save that
 * carries only freshly parsed data — the companies summary, which is parsed in
 * the browser and posted as JSON — must not blank the file stored against that
 * kind by a separate upload.
 */
async function saveParsedAndRaw(kind, parsed, buffer, fileName) {
  await db.query(
    `INSERT INTO admin_uploads (kind, parsed_json, raw_bytes, file_name, uploaded_at)
     VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (kind) DO UPDATE
       SET parsed_json = EXCLUDED.parsed_json,
           raw_bytes   = COALESCE(EXCLUDED.raw_bytes, admin_uploads.raw_bytes),
           file_name   = COALESCE(EXCLUDED.file_name, admin_uploads.file_name),
           uploaded_at = EXCLUDED.uploaded_at`,
    [kind, JSON.stringify(parsed), buffer || null, fileName || null]
  );
}

/**
 * Store just the original file against a kind that already exists.
 *
 * For a dataset whose parsing happens in the browser, the file arrives on its
 * own after the summary has been saved — so this touches bytes and name only
 * and leaves parsed_json alone.
 */
async function saveRawFile(kind, buffer, fileName) {
  const { rowCount } = await db.query(
    `UPDATE admin_uploads SET raw_bytes = $2, file_name = $3
     WHERE kind = $1`,
    [kind, buffer, fileName || null]
  );
  return rowCount > 0;
}

async function loadParsed(kind) {
  try {
    const { rows } = await db.query(
      'SELECT parsed_json FROM admin_uploads WHERE kind = $1',
      [kind]
    );
    return rows.length ? rows[0].parsed_json : null;
  } catch (err) {
    console.error(`admin-uploads: loadParsed(${kind}) failed:`, err.message);
    return null;
  }
}

// One-shot migration: for each legacy file still on disk, if the DB
// doesn't already have that row, import it so admins don't have to
// re-upload after switching to the DB-backed store.
async function migrateLegacyDiskUploadsOnce() {
  if (!fs.existsSync(LEGACY_DATA_DIR)) return;
  let entries;
  try {
    entries = fs.readdirSync(LEGACY_DATA_DIR);
  } catch (_) { return; }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const kind = file.slice(0, -5);
    try {
      const { rows } = await db.query(
        'SELECT 1 FROM admin_uploads WHERE kind = $1',
        [kind]
      );
      if (rows.length) continue; // already in DB
      const jsonPath = path.join(LEGACY_DATA_DIR, `${kind}.json`);
      const xlsxPath = path.join(LEGACY_DATA_DIR, `${kind}.xlsx`);
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const buffer = fs.existsSync(xlsxPath) ? fs.readFileSync(xlsxPath) : null;
      await saveParsedAndRaw(kind, parsed, buffer);
      console.log(`admin-uploads: migrated "${kind}" from disk to DB`);
    } catch (err) {
      console.warn(`admin-uploads: legacy migration for "${kind}" failed:`, err.message);
    }
  }
}

module.exports = {
  upload,
  adminOnly,
  saveParsedAndRaw,
  saveRawFile,
  loadParsed,
  migrateLegacyDiskUploadsOnce,
};
