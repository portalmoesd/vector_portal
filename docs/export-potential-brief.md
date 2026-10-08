# Brief: Georgian export potential platform

## What we are building

A web page where a user picks a partner country and gets the list of Georgian products with export potential in that country, each rated High, Moderate or Low, plus a separate "Markets to watch" list.

The ratings come from a fixed scoring method described in full below. The method is settled; do not redesign it. Its point values and cut-offs are starting values that will be calibrated later, so every number in it must live in one configuration file, not in code.

The users are Georgian exporters and people who advise them. Most are not trade analysts, so the page must show plain labels and let the user see why a product got its rating.

## How to work

Work in four phases and stop for my review at the end of each one. Phase 0 matters most: several data questions below are unverified, and the design depends on the answers. Report what you find before building on it.

Where this brief marks something as "proposed default", use it unless you find a reason not to, and list it in your phase report so I can confirm it. Where it says "ask me", ask before deciding.

If your environment cannot reach a data source, tell me which file you need and I will download it into the repository.

## Architecture

Precompute, do not query live. The sources are rate-limited APIs and slow portals, and the results change about once a year.

1. A data pipeline (proposed default: Python with DuckDB or pandas) downloads and caches the raw sources, computes every metric for every product and partner country, applies the scoring, and writes one result file per partner country.
2. The web page is a static front end that loads the result file for the chosen country. No server-side computation at request time.
3. The pipeline takes an "as-of year" parameter. Everything is computed relative to it. This is required so the method can later be back-tested by running it with an older year.

Ask me about the front-end stack and hosting before Phase 2 if the repository does not already settle it.

## Product level and data year

- **Product level: 4-digit HS codes.** Every metric, gate and threshold in this brief is applied per 4-digit product.
- **Data year: 2025 wherever it exists.** T is set per partner country: 2025 if that country has reported 2025 annual data, otherwise its latest reported year. Every result carries its data year and source, and the page shows them.
- **Never mix sources inside one partner's window.** Different sources value imports differently, and a switch between them creates a false jump in exactly the recent-year changes this method scores.

## Data sources

### UN Comtrade API: partner-country and world figures (primary)

- Site: https://comtradeplus.un.org. Free subscription key, which I will provide; read it from an environment variable and never commit it.
- Limits, as far as I could confirm: about 500 calls a day and up to 100,000 records per call on the free key. Check the current limits in Phase 0.
- Needed, for each reporting country and each year of its window, at 4 digits:
  - imports of each product by supplying country (gives total imports, supplier shares and Georgia's competitors);
  - exports of each product to the world.
- World figures (world imports per product for growth, world exports per product and in total for RCA) are sums across reporting countries. Compute them over a fixed set of countries that reported in every year of the window. Otherwise a country appearing or dropping out looks like world growth or decline.
- Request one HS edition for all years so codes are comparable. Comtrade can return data converted to a chosen edition; confirm how in Phase 0.
- Cache every raw response on disk and make the download resumable. With these limits a full load takes many days of calls. Estimate the call count in Phase 0 and propose a schedule.
- Imports are reported including freight and insurance and exports excluding them. That slightly overstates imports against exports in the deficit and headroom metrics. Accept this and note it on the methodology page.

Check in Phase 0, using the API's data availability endpoint: which countries have 2025 annual data, and which have a complete window.

**Publishing rule.** Comtrade's terms allow publishing transformed data freely: scores, ratings, growth rates, shares, averages and indices. Raw records may not be republished in bulk (100,000 records or more needs a licence). So the page shows derived figures only and offers no raw data download.

### CEPII BACI: fallback only

- Page: https://www.cepii.fr/DATA_DOWNLOAD/baci/doc/baci_webpage.html. Free bulk download, Etalab Open Licence 2.0.
- All files are at 6 digits (the "HS17" and "HS22" in file names are classification editions, not digit levels); sum to 4 digits. The current release ends at 2024.
- Proposed default: use BACI, for the whole window ending 2024, only for partner countries that do not report to Comtrade at all or lack a complete Comtrade window. Label those results "2024 data".
- Do not use BACI for Georgia's own exports. It includes re-exports, which are more than half of Georgia's recorded exports.

### Geostat: Georgia's domestic exports

- Portal: https://ex-trade.geostat.ge/en (a JavaScript app). It has data through 2025.
- Needed: Georgia's **domestic exports** (re-exports excluded) by product code, by destination country and by year, for at least the last five years, plus total domestic exports per year. Aggregate to 4 digits.

Unverified, check in Phase 0:
- Does the portal expose domestic exports separately from total exports at product and destination level?
- Is there a bulk export or a JSON endpoint behind the app? Check the portal's terms before automating anything, keep request rates low, and if automated access is not permitted, tell me and I will export the files by hand.

### Product code matching

Geostat codes and the Comtrade edition you request may follow different HS editions. At 4 digits most codes are stable, but some change between editions. Report in Phase 0 how many of Georgia's exported products map cleanly and how you will handle the rest.

### Tariffs: World Bank WITS (UNCTAD TRAINS)

- API: https://wits.worldbank.org/witsapiintro.aspx (free, registration).
- Needed: the tariff the partner applies to the product from Georgia (preferential rate where one exists, otherwise the general rate), and the tariffs it applies to its other suppliers. Tariffs are set at 6 digits or finer; use the simple average across the 4-digit product.
- This is the heaviest data task and its feasibility is unverified. In Phase 0, test it on a few country and product pairs and report the cost of doing it for all pairs. If it is not practical for version 1, score every pair as "Equal" (3 points) and flag it as "tariff data missing" in the output.

### Distances: CEPII GeoDist

- Country-to-country distances from CEPII (cepii.fr). Check its licence in Phase 0; I have not verified it.

### Sources that must not be used

- **ITC Trade Map and Market Access Map.** Their terms forbid automated extraction, redistribution and commercial use.

### Attribution

The page footer must credit UN Comtrade, Geostat and, where used, CEPII BACI, WITS / UNCTAD TRAINS and CEPII GeoDist, with links and the data year.

## The method

Notation: T is the partner's data year (see above). The five-year window is T−4 to T. "Partner" is the country the user selected. "Product" is a 4-digit HS code. All values are in US dollars. M and X are the partner's imports and exports of the product from and to the world, from that partner's trade source. "World" figures come from the fixed set of reporting countries.

### Gate 1: real Georgian supply

Georgia's domestic exports of the product (Geostat, all destinations) average at least $1,000,000 a year over Geostat's latest three full years, and are above zero in each of those three years. This gate is the same for every partner.

- Fail: the product is rated Low and not scored. Proposed default: such products are not shown on the page, because they are the thousands of products Georgia does not export.

### Gate 2: the partner's import history

Count the consecutive years, ending at T and going backwards, in which the partner's imports of the product (M) are above zero.

| Consecutive years | Result |
|---|---|
| 5 or more | Pass: established market. Use the five-year window. |
| 3 or 4 | Pass, flagged "new market". Use only those years as the window for every windowed metric, and compare with world figures over the same years. |
| 1 or 2 | Not rated. The product goes to the "Markets to watch" list for this partner. |
| 0 | Not shown. |

### Scoring: 100 points

All "average" figures are simple averages over the window.

**Demand size (30 points).** Average yearly M over the window.

| Average imports | Points |
|---|---|
| Over $100M | 30 |
| $50M to $100M | 25 |
| $10M to $50M | 20 |
| $2M to $10M | 12 |
| Under $2M | 5 |

**Demand growth (25 points).**

- Partner growth = (M at T ÷ M at start of window)^(1 ÷ number of intervals) − 1. Compute world growth the same way from world imports of the product over the same years.
- Group A: partner growth is positive and above world growth. Group B: everything else.
- Net change over the last two years = (M at T − M at T−2) ÷ M at T−2.

| Group | Last two years | Points |
|---|---|---|
| A | Net change of zero or more | 25 |
| A | Decline of less than 10% | 18 |
| A | Decline of 10% or more | 8 |
| B | Net change above zero, and M at T above the window average | 15 |
| B | Net change above zero, and M at T at or below the window average | 8 |
| B | Net change of zero or less | 0 |

**Competition and access (20 points).**

| Indicator | Rule | Points |
|---|---|---|
| Trade deficit level | Average M is at least twice average X | 4 |
| | Neither is twice the other | 2 |
| | Average X is at least twice average M | 0 |
| Deficit trend, current year | Deficit share at T is at or above deficit share at T−1 | 1, else 0 |
| Deficit trend, previous year | Deficit share at T−1 is at or above deficit share at T−2 | 1, else 0 |
| Supplier concentration | Index under 0.4 | 6 |
| | 0.4 to 0.6 | 3 |
| | Over 0.6 | 0 |
| Tariff position | Georgia's tariff is lower than the competitors' average | 6 |
| | Equal (proposed default: within 0.5 percentage points) | 3 |
| | Higher | 0 |
| Distance fit | Georgia's distance to the partner is at or below the average supplier distance | 2, else 0 |

- Deficit share for a year = (M − X) ÷ M.
- Supplier concentration = sum of squared supplier shares of the partner's imports of the product, on a 0 to 1 scale, using imports summed over the window.
- Competitors' average tariff = the tariffs applied to the partner's other suppliers, weighted by each supplier's share of imports.
- Average supplier distance = suppliers' distances to the partner, weighted by import value over the window.

**Georgia's position (25 points).**

| Indicator | Rule | Points |
|---|---|---|
| Comparative advantage (RCA) | 1 or more | 10 |
| | 0.7 up to 1 | 5 |
| | Below 0.7 | 0 |
| Track record | Georgia's domestic exports of the product to the partner are above zero in at least three of the last five years | 8, else 0 |
| Headroom | Georgia's share of the partner's imports is below Georgia's share of world exports of the product | 7, else 0 |

- RCA = (Georgia's domestic exports of the product ÷ Georgia's total domestic exports) ÷ (world exports of the product ÷ world total exports), each averaged over Geostat's latest three full years. Georgian figures from Geostat, world figures from the trade source.
- Georgia's share of the partner's imports = Georgia's domestic exports of the product to the partner (Geostat) ÷ M, over the window.
- Georgia's share of world exports = Georgia's domestic exports of the product (Geostat) ÷ world exports of the product, over the window.

### Rating

| Rating | Rule |
|---|---|
| High | 65 points or more |
| Moderate | 40 to 64 |
| Low | Under 40, or gate 1 failed |

Two caps apply after the points are added:

- **Small market:** average M under $2M means the rating cannot be above Moderate.
- **Steep recent decline:** a two-year net change of −10% or worse means the rating cannot be High.

Record on each result which cap, if any, changed the rating.

### Check case

Use this invented case as a unit test. It must produce 77 points and High, with no cap applied.

| Input | Value | Points |
|---|---|---|
| Georgia's domestic exports | $4M average, all three years above zero | Gate 1 pass |
| Partner import history | All five years | Gate 2 pass, established |
| Average imports | $35M | 20 |
| Growth | 6% a year against 3% for the world; +4% over two years | 25 |
| Deficit level | Imports $35M, exports $5M | 4 |
| Deficit trend | Share held in both years | 2 |
| Supplier concentration | 0.45 | 3 |
| Tariff | Georgia 0%, competitors 5% | 6 |
| Distance | Georgia farther than average | 0 |
| RCA | 3.2 | 10 |
| Track record | Two of five years | 0 |
| Headroom | 0.5% of partner imports against 1.2% of world exports | 7 |

Add tests for each tier boundary, both caps, the "new market" path and the "Markets to watch" path.

## Output per partner country

For each product that passes gate 1 and is rated: product code and name, rating, total score, the four block scores, each indicator's raw value and points, and flags (new market, cap applied, any missing data and the default used in its place).

For "Markets to watch": product code and name, the years with imports and the import values.

Include the data year T, the trade source used and the pipeline run date in every file.

## The page

- A country selector, then a table of products sorted by rating and score, with filters for rating.
- Each row expands to show the four block scores and the underlying figures, in plain language ("The market imports $35M a year", not "avg_M").
- A separate "Markets to watch" section.
- A methodology page that explains the gates, the scoring and the limits, and states that a rating is a screening result, not a forecast.
- Flags shown as visible labels on the row, and the data year shown for the selected country.

Ask me: the interface language or languages (English, Georgian or both) and where product names in Georgian should come from if needed.

## Phases

**Phase 0: data discovery.** Answer the unverified points above (Comtrade limits, 2025 coverage and download schedule, Geostat access, product code matching, tariff feasibility, GeoDist licence). Report how many 4-digit products pass gate 1 and how many partner countries get 2025 data, older Comtrade data or the BACI fallback. Deliver a short written report and stop.

**Phase 1: pipeline.** Load the data, compute the metrics, score and rate. All thresholds and weights in one configuration file. Unit tests including the check case. Deliver result files for all partner countries and a summary: how many products are High, Moderate and Low per country, and how many products fall in each RCA tier (I expect most to score the full 10 points and want to see whether that is true).

**Phase 2: the page.** Build the front end on the result files.

**Phase 3: back-test.** Run the pipeline with an older T, then compare the ratings with how Georgia's domestic exports of each product to each partner actually changed afterwards. Report whether High-rated pairs grew more than the others. This will be used to adjust the weights.

## Things to avoid

- Hard-coding any threshold, weight or year.
- Using total exports, Comtrade or BACI for Georgia's side of any metric.
- Mixing trade sources inside one partner's window.
- Publishing or offering downloads of raw Comtrade records.
- Filling missing data silently. Use the stated default and flag it.
- Changing the method. If something in it looks wrong or cannot be computed, tell me.
