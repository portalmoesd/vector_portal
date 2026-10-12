# Country Profiles

Admin-only section with one page per economy, modelled on the layout of
openfactbook.org/countries but fed exclusively from the World Bank's World
Development Indicators (WDI) API. No external call happens when a page is
requested: a sync script pulls the data into Postgres, and the pages read
only from those tables.

## Pages

| URL | Page | Notes |
|---|---|---|
| `/countries` → `/pages/country-profiles.html` | Index | `?q=` search text, `?region=` World Bank region id; both shareable |
| `/countries/<slug>` → `/pages/country-profile.html?country=<slug>` | Profile | slug = World Bank name, lower-cased and hyphenated (`georgia`, `hong-kong-sar-china`); ISO3 also accepted |

Both pages are reachable only by the ADMIN role (sidebar entry "Country
Profiles"; other roles bounce to their dashboard, the API returns 403).

## Data

Source: World Bank WDI, `https://api.worldbank.org/v2`. Country list from
`/country?format=json&per_page=400`, aggregates (region id `NA`) excluded:
217 economies in 7 regions. Indicators from
`/country/all/indicator/{CODE}?format=json&per_page=20000`:

| Code | Section | Shown as |
|---|---|---|
| SP.POP.TOTL | People | Population (also a key-figure tile and chart series) |
| AG.SRF.TOTL.K2 | Overview | Surface area (tile) |
| NY.GDP.MKTP.CD | Economy | GDP, current US$ (tile and chart series) |
| NY.GDP.PCAP.CD | Economy | GDP per capita (tile) |
| NY.GDP.MKTP.KD.ZG | Economy | GDP growth (tile) |
| FP.CPI.TOTL.ZG | Economy | Inflation (tile) |
| SL.UEM.TOTL.ZS | Economy | Unemployment (tile) |
| NE.EXP.GNFS.CD | Trade | Exports of goods and services |
| NE.IMP.GNFS.CD | Trade | Imports of goods and services |
| SP.DYN.LE00.IN | People | Life expectancy at birth |
| SP.URB.TOTL.IN.ZS | People | Urban population, % |

Rules applied:

- Every stored value carries the indicator code, value, data year, source
  name, source URL (the request URL it came from) and retrieval timestamp.
- The page shows the latest available year per indicator next to each
  figure, with a link to the source. A missing value is "No data"; nothing is
  estimated or carried forward. Null values are not stored at all.
- Names, regions and income groups are used exactly as the source gives them.
  In the Georgian UI the portal's own Georgian country name (matched on ISO2)
  is shown as a display translation, with the English source name underneath.
- Flags: the bundled MIT-licensed circle-flags set under
  `frontend/assets/flags/`, keyed by ISO alpha-2. No hotlinking.

## Storage (Postgres, `server/schema.sql`)

- `stat_sources` — one row per source (`worldbank-wdi` today; IMF, Comtrade later).
- `stat_indicators` — code, source, the source's own indicator name, unit hint, profile section, order.
- `stat_countries` — the source's economy list with slug, region, income level, capital.
- `stat_observations` — (source, indicator, iso3, year) → value, plus source name/URL and `retrieved_at`.
- `stat_sync_runs` — one row per sync with status (`ok` / `partial` / `failed`) and a per-indicator log.

Adding a source means a new `stat_sources` row, its indicators in
`stat_indicators`, and a fetcher that writes `stat_observations`; the tables
and pages need no restructuring.

## Running the sync

```
npm run sync:country-profiles                       # everything
node server/country-profiles/sync.js --dry-run      # fetch + parse, write nothing
node server/country-profiles/sync.js --indicators SP.POP.TOTL,NY.GDP.MKTP.CD
```

`DATABASE_URL` must be set (`.env`). A full run takes well under a minute
when the API is responsive; individual WDI requests have taken 30–90 s on
slow days, so each request has a 120 s timeout and three retries.

The sync is idempotent. The country list and each indicator are replaced in
their own transaction only after the whole pull succeeded; a failed pull is
logged on the run row and the previous values stay in place. The run exits 0
on `ok`/`partial`, 2 on `failed`.

Schedule: the server runs the sync every Monday at 10:20 Tbilisi (in-process,
same pattern as the tourism and trade refreshes in `routes/statistics.js`)
and once at boot if the tables are empty. Admin Panel → Data Uploads →
"Country Profiles data" shows the last run, any failed indicators, and a
"Sync now" button. Set `COUNTRY_PROFILES_NO_SCHEDULE=1` to disable the
in-process schedule (e.g. when a Render cron job runs the CLI instead).

## API

- `GET /api/country-profiles/countries` — economies, regions, source, last sync.
- `GET /api/country-profiles/countries/:slug` — one profile: country facts, every indicator with its latest value/year/source, 20-year GDP and population series.
- `GET /api/country-profiles/status` — counts and the last five runs.
- `POST /api/country-profiles/sync` — start a sync (202; 409 if one is running).

## Tests

- `tests/server/country-profiles-sync.test.js` — parsing (aggregate exclusion, null handling, latest year, API error reporting, pagination, retries).
- `tests/server/country-profiles-filter.test.js` — index search/region filtering.
- `tests/dashboard/country-profiles.spec.js` — Playwright smoke tests for both pages (mocked API).
