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

async function saveParsedAndRaw(kind, parsed, buffer) {
  await db.query(
    `INSERT INTO admin_uploads (kind, parsed_json, raw_bytes, uploaded_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (kind) DO UPDATE
       SET parsed_json = EXCLUDED.parsed_json,
           raw_bytes   = COALESCE(EXCLUDED.raw_bytes, admin_uploads.raw_bytes),
           uploaded_at = EXCLUDED.uploaded_at`,
    [kind, JSON.stringify(parsed), buffer || null]
  );
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
  loadParsed,
  migrateLegacyDiskUploadsOnce,
};
