# Export potential platform — Phase 0 report (data discovery)

Date: 2026-10-08. Brief: "Georgian export potential platform". This report answers the
unverified points in the brief, lists the proposed defaults taken, and states what was
built alongside it (the admin-only page shell). Please confirm the defaults and the
open questions before Phase 1 (the pipeline).

## 1. Where it lives

The brief assumes a standalone static site. The repository already settles the stack:
Vector Portal is an Express app with static HTML/vanilla-JS pages, PostgreSQL, bilingual
EN/KA, deployed on Render. The portal already talks to Geostat's trade API and ships
HS4 product names in both languages. So:

- **Front end:** a new page `/pages/export-potential.html` inside the portal, reachable
  from the sidebar by ADMIN only (for now). Non-admin roles are bounced to their dashboard
  and the API returns 403.
- **Data flow:** precompute, never query live (as the brief requires). The page loads one
  result file per partner from `GET /api/export-potential/countries/:iso3`; the server
  only reads files, it computes nothing at request time.
- **Pipeline language (deviation from the proposed Python default):** Node.js. The
  portal, its tests and its deployment are Node-only; Python is not installed on the
  server and would add a second runtime. The scoring engine and the pipeline
  (`server/export-potential/pipeline/`) are in Node, with every number in
  `server/export-potential/config.json`. The result-file contract is language-neutral.
- **Interface language:** both English and Georgian, following the portal's site
  language switch. Product names come from the portal's existing HS4 name lists
  (`frontend/data/hs4-names-en.csv`, `hs4-names-ka.csv`), so no new source is needed
  for Georgian product names. Country names in Georgian: the portal's `countries`
  table plus Geostat's Georgian labels.

## 2. UN Comtrade

Verified from the live API and the subscription page (uncomtrade.org/docs/subscriptions):

| Item | Finding |
|---|---|
| Free registered key | 100,000 records per call, **500 calls per day, 1 call per second** |
| Preview endpoint (no key) | 500 records, one period and one product per call; rate-limited (we hit HTTP 429 after a few calls) |
| Data availability endpoint | Public, no key needed; used below |
| Classification per dataset | The availability feed lists each reporter-year in its **original** HS edition only. 107 of the 115 reporters with 2025 data switch editions inside 2021–2025 (typically HS2017 for 2020–2021, HS2022 from 2022) |
| Conversion to one edition | The documented way is to request the data with the classification code `H6` in the path instead of `HS`; the public preview returned 0 rows for a 2020 (HS2017) dataset under `H6`, so **this must be confirmed with the key on day one**. Fallback: request as reported and map HS2017→HS2022 at 4 digits (a short concordance; only a handful of 4-digit headings differ between those editions) |
| CIF/FOB | Imports CIF, exports FOB; accepted and stated on the methodology panel |

**2025 coverage, annual HS data (as of 2026-10-08):**

| Reporters | Count |
|---|---|
| Reporting at all (2020–2025 feed) | 179 |
| With 2025 annual data | 115 |
| With a complete 2021–2025 window | 108 |
| Latest year 2024 | 37 |
| Latest year 2023 | 20 |
| Latest year 2022 or older | 7 |
| With a complete 2020–2024 window | 139 |

Georgia itself reports 2025. Major partners with 2025: EU members (DEU, FRA, ITA, ESP, NLD, POL, …), TUR, CHN, USA, GBR, ARM, AZE, KAZ, KGZ, MDA, UKR is **not** in the 2025 list (latest 2024), nor RUS (not in the feed at all for these years).

**Verified with the key (2026-10-08).** Four facts changed the plan:

- Without `partner2Code=0&customsCode=C00&motCode=0` one reporter-year comes back as
  100,000 breakdown rows (second partner, customs procedure, mode of transport); with
  them it is about 1,200 rows at HS4. The client always sends them.
- One call may carry many reporters and years (`reporterCode=792,276,...`), so world
  figures need only a few dozen calls, not one per reporter-year.
- Comtrade does **not** convert an older dataset to HS2022 on request (`H6` in the path
  returns no rows for an HS2017 year). Data are taken as reported and mapped at four
  digits by a short concordance (`pipeline/concordance.js`): 8803→8807, 8107→8112,
  2848→2853 for HS2017 rows, plus 6908→6907 and 8469→8472 for HS2012 rows. Headings
  new in HS2022 (3827, 8485, 8524, 8549, 8806) start in 2022 and are listed in the run
  summary. None of the 143 gate-1 products is affected.
- Each call takes one to three minutes to answer whatever its size, so wall-clock time,
  not the quota, is the constraint.

**Call count.** About 230 calls for both cohorts from an empty cache (world figures for
138 reporters over five years at 32 reporters per call, plus one call per partner for
its imports of the gate-1 products by supplier over the whole window). That is half a
day of quota and about six hours of wall-clock time, resumable from the on-disk cache.

**Proposed default, fixed reporter set for "world":** the 108 reporters with a complete
2021–2025 window (for T = 2025 partners) and the 139 with a complete 2020–2024 window
(for T = 2024 partners).

## 3. Geostat

Verified against `ex-trade-api.geostat.ge/api/trade` (the JSON API behind the portal,
which this repository already uses for the Statistics pages):

- **Domestic exports are exposed separately** (trade flow 12 "Domestic Export"; 10 is
  total export, 13 re-export) at HS4 level, by destination country, by year. One call
  returns several years as columns (`usd1000_2023`, `usd1000_2024`, `usd1000_2025`).
- Values are thousand USD; the pipeline converts to USD.
- 2025 is a complete year (the API's current period is August 2026). Latest three full
  years: 2023, 2024, 2025.
- Country ids are UN M49 numeric codes (004 Afghanistan, 792 Türkiye), the same codes
  Comtrade uses for reporters, so Geostat destinations join Comtrade reporters directly.
- Rate: the portal already calls this API in production at low volume; the pipeline
  needs about 150 calls in total (one per gate-1 product for the destination breakdown,
  plus totals), well within reason. Terms: the portal's existing use is the precedent;
  no terms page forbids API access. Please confirm you are comfortable continuing on
  that basis.

**Product code matching.** Geostat's HS4 list has 1,233 codes; HS2022 has 1,229
4-digit headings. 11 Geostat codes are not in HS2022: 2848, 6908, 8107, 8469, 8803
(headings deleted by HS2022; all have zero recent domestic exports) and 9801–9805,
9905 (Georgia's national chapters 98/99). **Only one gate-1 product is affected:
9801 "Parts of motor cars from the group 87"**, a national code with no Comtrade
counterpart. Proposed default: exclude 9801 (and the other national codes) from
scoring and list it in the summary as "not matchable".

## 4. Gate 1 count

From Geostat domestic exports by HS4, latest three full years 2023–2025:

| | Products |
|---|---|
| Any domestic export in 2023–2025 | 919 |
| Above zero in all three years | 663 |
| **Pass gate 1** (average ≥ $1M and above zero each year) | **144** |

Largest: 2204 wine ($266M average), 7202 ferro-alloys, 2616 precious-metal ores,
2603 copper ores, 2208 spirits, 2201 waters, 2202 soft drinks, 3102 fertilisers,
0802 nuts, 7108 gold, 6109 T-shirts, 0102 live cattle.

## 5. Tariffs (WITS / UNCTAD TRAINS)

Tested live on the SDMX API (no registration was needed for these calls):

- **MFN for a whole reporter-year in one call:** `reporter/792/partner/000/product/all/year/2022`
  returned 5,613 HS6 lines for Türkiye (1 MB JSON). Feasible: one call per reporter-year.
- **Georgia's preferential rates in one call:** `reporter/792/partner/268/product/all/year/2021`
  returned 3,614 lines, 3,613 at 0% (the Georgia–Türkiye FTA). Lines not in the file
  (e.g. wine 2204) are not covered by the agreement and fall back to MFN, which is exactly
  the brief's rule.
- **Latest tariff year varies by reporter** and lags: Türkiye's 2024 MFN returned "no
  records". The availability endpoint per reporter lists the years and the partner codes
  that have preferential data.
- **Competitors' tariffs** are the heavy part: each other supplier's applied rate requires
  the reporter's preferential file for that supplier's partner group (about 25 partner
  codes per reporter-year), i.e. roughly 25–30 calls per reporter, **about 3,000 calls
  for 108 reporters, one tariff year**. WITS publishes no daily quota; calls took 1–2 s.
  Specific (non-ad-valorem) duties come without an AVE in the "reported" dataset.

Proposed default for version 1: **score every pair as Equal (3 points) and flag
"tariff data missing"**, as the brief allows; build the tariff loader as a Phase 1b
addition once the Comtrade load is running, starting with Georgia's own rate (cheap)
and the MFN file (cheap), and adding competitor preferences after. Say so if you want
tariffs in version 1 regardless.

## 6. Licences

| Source | Licence | Use |
|---|---|---|
| CEPII GeoDist | **Etalab 2.0** (open licence, attribution required) | Distances, fine to use |
| CEPII BACI | Etalab 2.0 | Fallback trade source, ends 2024 |
| UN Comtrade | Derived figures may be published; no bulk raw records | The page shows derived figures only and offers no raw download |
| ITC Trade Map / Market Access Map | Forbidden by the brief | Not used |

## 7. Partner cohorts (proposed)

| Cohort | Source and T | Reporters |
|---|---|---|
| A | Comtrade, T = 2025 | 108 with a complete 2021–2025 window |
| B | Comtrade, T = 2024 | 31 more with a complete 2020–2024 window |
| C | BACI fallback, T = 2024, labelled "2024 data" | partners that never report, or lack a complete Comtrade window (e.g. Russia, Ukraine's missing years) |

Open question: BACI covers about 220 importers. Do you want every BACI importer in
cohort C, or only partners above some trade threshold with Georgia?

## 8. Decisions taken as proposed defaults (please confirm)

1. Node.js pipeline inside this repository instead of Python (section 1).
2. Tier boundaries are lower-inclusive except "Over $100M", which is strict: exactly
   $100M scores 25, exactly $50M scores 25, exactly $2M scores 12; concentration exactly
   0.4 or 0.6 scores 3. The unit tests pin these.
3. Missing distance data scores 0 points and is flagged (the brief gives no default).
4. Missing supplier breakdown scores the concentration as "over 0.6" (0 points) and is
   flagged; missing world growth puts the product in group B and is flagged; a missing
   two-year change counts as zero and is flagged.
5. Gate-1 products with no Comtrade counterpart (national code 9801) are excluded and
   listed as unmatchable.
6. Products that fail gate 1 are not shown (as the brief proposes).
7. Result files are committed to the repository under
   `server/data/export-potential/results/` (Render's disk is wiped on deploy, so
   runtime-written files would not survive; committed JSON does).

## 9. Questions for you

- Comtrade subscription key: please add it to the Render environment as
  `COMTRADE_API_KEY` when Phase 1 starts (never committed).
- Tariffs in version 1: Equal-and-flagged (proposed) or full tariff load?
- BACI cohort scope (section 7).
- Any partner countries to exclude or prioritise for the first download days.

## 10. What is built

Phase 1 ran on 2026-10-08 with the key you provided; the ratings per country are in
`docs/export-potential-phase1-summary.md` and the result files are committed. Beyond the
page shell listed below: `server/export-potential/pipeline/` (Comtrade and Geostat clients
with an on-disk cache and daily budget, HS concordance, GeoDist table, orchestrator,
partner prefetch, index and summary writers; see its README).


- `server/export-potential/config.json` — every threshold, weight and year rule.
- `server/export-potential/scoring.js` — gates, metrics, scoring, caps; pure functions.
- `server/export-potential/sample.js` — an invented partner built through the engine so
  the page can be previewed; marked and shown as sample data.
- `server/export-potential/results.js`, `server/routes/export-potential.js` — result
  file loader and admin-only API.
- `frontend/pages/export-potential.html` + `js/pages/export-potential.js` +
  `css/export-potential.css` — the page: country picker, rating filter, product search,
  expandable rows in plain language, flags as labels, Markets to watch, methodology
  panel rendered from the configuration, attribution footer with the data year.
- Tests: `tests/server/export-potential-scoring.test.js` (the brief's check case = 77
  points High no cap, every tier boundary, both caps, new-market and watch paths, gate
  failures, missing-data defaults, and a guard that no threshold is hard-coded),
  `tests/server/export-potential-results.test.js` (contract, enrichment, admin-only
  API), `tests/dashboard/export-potential.spec.js` (page rendering, filters,
  methodology, Georgian, non-admin bounce).
