/**
 * Georgian country names, derived from the ISO-2 code.
 *
 * Source order:
 *   1. server/data/overrides/country-names-ka.json — manual overrides for
 *      names where ministry convention differs from CLDR (edit freely;
 *      applied on boot). Lives in overrides/ so the legacy admin-uploads
 *      disk migration doesn't sweep it into admin_uploads.
 *   2. Intl.DisplayNames(['ka']) — Node ships full ICU, so this covers every
 *      ISO region deterministically, unlike the browser-side fallback.
 */
const path = require('path');

let overrides = {};
try {
  overrides = require(path.join(__dirname, '../data/overrides/country-names-ka.json'));
} catch (_) { /* no overrides file — ICU only */ }

let displayNamesKa = null;

function georgianCountryName(code) {
  const iso = String(code || '').trim().toUpperCase();
  if (!iso) return null;
  const override = overrides[iso];
  if (override && String(override).trim()) return String(override).trim();
  try {
    if (!displayNamesKa) displayNamesKa = new Intl.DisplayNames(['ka'], { type: 'region' });
    const ka = displayNamesKa.of(iso);
    if (ka && ka !== iso) return ka;
  } catch (_) { /* unknown code or ICU without ka data */ }
  return null;
}

module.exports = { georgianCountryName, overrides };
