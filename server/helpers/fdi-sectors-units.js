/**
 * Unit normalization for the admin-uploaded FDI-by-sector dataset.
 *
 * Every consumer of this dataset (statistics table, country comparison,
 * PDF/Word exports) displays mln USD, but the ministry's workbook has
 * carried mixed units between releases — and even between columns of one
 * file: annual columns pasted from Geostat's thousand-USD series next to a
 * quarterly column typed in mln USD. So each period column is normalized
 * independently, using the economy-wide magnitude of the column (the summed
 * absolute country totals) to tell the units apart: Georgia's whole-economy
 * FDI per period sits in the hundreds-to-low-thousands range in mln USD,
 * and six digits or more in thousand USD — the two never meet the
 * threshold from the same side.
 *
 * The pass is idempotent (a divided column falls far below the threshold),
 * so it is safe to apply both to fresh uploads and to snapshots stored
 * before this normalization existed.
 */

// Economy-wide mln-USD figures never reach this; thousand-USD figures for
// any period with meaningful investment (≥ 20 mln USD) always do.
const THSD_USD_THRESHOLD = 20000;

function normalizeFdiSectorsUnits(parsed) {
  if (!parsed || !parsed.countries || !Array.isArray(parsed.years)) return parsed;
  const countries = Object.values(parsed.countries);
  for (const period of parsed.years) {
    let magnitude = 0;
    for (const country of countries) {
      const v = country.totals ? country.totals[period] : null;
      if (typeof v === 'number') magnitude += Math.abs(v);
    }
    if (magnitude <= THSD_USD_THRESHOLD) continue;
    for (const country of countries) {
      if (country.totals && typeof country.totals[period] === 'number') {
        country.totals[period] /= 1000;
      }
      for (const vals of Object.values(country.sectors || {})) {
        if (typeof vals[period] === 'number') vals[period] /= 1000;
      }
    }
  }
  return parsed;
}

module.exports = { normalizeFdiSectorsUnits, THSD_USD_THRESHOLD };
