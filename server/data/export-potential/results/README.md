# Export potential result files

One JSON file per partner country, named by ISO3 code (`TUR.json`, `DEU.json`).
The pipeline writes them; the portal only reads them (`server/export-potential/results.js`)
and serves them to the admin-only Export Potential page. Nothing is computed at request time.

Only derived figures belong here (scores, growth rates, shares, averages, indices).
Raw UN Comtrade records must not be stored in this folder (publishing rule in the brief).

## Contract (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "partner": { "iso3": "TUR", "m49": 792, "iso2": "TR", "nameEn": "Türkiye", "nameKa": "თურქეთი" },
  "dataYear": 2025,
  "window": { "start": 2021, "end": 2025, "years": [2021, 2022, 2023, 2024, 2025] },
  "tradeSource": { "id": "comtrade", "label": "UN Comtrade", "edition": "HS2022" },
  "georgiaSource": { "id": "geostat", "label": "Geostat", "latestYears": [2023, 2024, 2025] },
  "pipeline": { "runDate": "2026-10-08T10:00:00Z", "asOfYear": 2025, "configVersion": 1 },
  "products": [ "... one entry per product that passed gate 1 and was rated, as returned by scoring.evaluate() ..." ],
  "watch": [ { "hs4": "0806", "yearsWithImports": [2024, 2025], "imports": { "2024": 400000, "2025": 900000 } } ]
}
```

`tradeSource.id` is `comtrade` or `baci` (fallback, labelled "2024 data"). Product
names are optional: the loader fills `name.en` / `name.ka` from the portal's HS4 name
lists when a product carries only its code.

A product entry is exactly what `server/export-potential/scoring.js` → `evaluate()`
returns for a rated product: `hs4`, `rating`, `ratingBeforeCap`, `cap`, `score`,
`blocks`, `indicators` (raw value and points for every indicator), `gate1`, `gate2`,
`window`, `flags` and `figures`.

`../index.json` (written by the pipeline, `pipeline/write-index.js`) lists every file with
its rating counts; the portal lists countries from it and parses a result file only when
that country is opened.

The loader also serves an invented partner (`SMP`, built
by `server/export-potential/sample.js`) so the page can be previewed. It is marked
`sample: true` and the page shows a banner on it.
