/**
 * Round country flags helper.
 *
 * Flags live in this folder as SVGs named by lower-case ISO 3166-1 alpha-2
 * code (the same `code` stored on country records). Use flagUrl() to build a
 * src; it returns '' for a missing/blank code so callers can decide on a
 * fallback (e.g. hide the <img> or show a placeholder).
 */
function flagUrl(code) {
  const c = (code || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return '';
  return `/assets/flags/${c}.svg`;
}

// Optional: expose globally to match the project's non-module script style.
if (typeof window !== 'undefined') window.flagUrl = flagUrl;
