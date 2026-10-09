# Export potential pipeline

Precomputes the export potential ratings: one result file per partner country under
`server/data/export-potential/results/`, read by the admin-only page. Nothing is
computed at request time.

```
COMTRADE_API_KEY=... node server/export-potential/pipeline/run.js --as-of 2025
```

| Option | Meaning |
|---|---|
| `--as-of YEAR` | required; every window, year and cohort is computed relative to it (back-testing = an older year) |
| `--cohorts a,b` | `a`: partners with a complete Comtrade window ending at the as-of year; `b`: ending one year earlier (default both) |
| `--partners TUR,DEU` | only these partners (ISO3); default all cohort members |
| `--out DIR` | results folder (default the committed one) |
| `--budget N` | Comtrade calls allowed today (default `pipeline.comtrade.dailyCallBudget` in config.json) |
| `--dry-run` | print cohorts and the planned number of calls; no data calls |
| `--quick` | development only: the "world" is just the selected partners; output is marked `partialWorld` and must not be published |

The key is read from the environment or a git-ignored `.env`; it is never written to
disk. `COMTRADE_API_KEY_SECONDARY` is used if the primary is rejected.

## Steps

1. **Availability** (public endpoint): which reporters have which years, in which HS
   edition. Georgia and the EU aggregate are never partners.
2. **Cohorts**: a partner's data year T is the as-of year if it has a complete
   five-year window ending there, otherwise one year earlier. The "world" for each
   cohort is the fixed set of reporters with a complete window, so a country
   appearing or dropping out never looks like world growth.
3. **Georgia** (Geostat, domestic exports, flow 12): every HS4 product per year, then
   gate 1 over Geostat's latest three full years; for each passing product, exports
   by destination per year. Geostat national codes (chapters 98/99) are excluded.
4. **World** (Comtrade): per cohort, for each window year, imports from and exports to
   the world at HS4 for all products, requested 32 reporters per call, totals only
   (`partner2Code=0`, `customsCode=C00`, `motCode=0`). Older HS editions are mapped
   onto HS2022 headings at four digits (`concordance.js`). A response that hits the
   100k record cap is split and re-requested.
5. **Partner**: one call per partner for its imports of the gate-1 products by
   supplier over the whole window; the supplier shares give concentration, and
   supplier ISO codes join the GeoDist distance table.
6. **Score** every gate-1 product with `scoring.evaluate()` and write the result file.
   Tariffs are not loaded in version 1: every pair is scored as Equal and flagged.

Every raw response is cached under `server/export-potential/cache/` (git-ignored; raw
Comtrade records must not be committed). A run stopped by the daily budget writes the
partners it completed and resumes from the cache next time. A summary
(`server/data/export-potential/summary-<year>.json`) lists the ratings per partner
and the RCA tier distribution.

## Budget

About 230 Comtrade calls for both cohorts (139 partners) from an empty cache; the
free key allows 500 a day. Comtrade answers in one to three minutes per call whatever its size, so a full load takes several hours of wall-clock time; calls carry 32 reporters at a time to keep their number low.

## Data files

- `server/data/export-potential/geodist.json`: CEPII GeoDist distances (Etalab 2.0),
  built by `build-geodist.js` from `dist_cepii.xls`.
