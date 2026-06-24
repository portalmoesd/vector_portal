# Country flags (round)

Round (circular) SVG flags for every country, named by **ISO 3166-1 alpha-2**
code in lower case — e.g. `ge.svg`, `us.svg`, `de.svg`. This matches the
`code` field stored on country records throughout the portal, so a flag can be
resolved directly:

```js
const src = `/assets/flags/${country.code.toLowerCase()}.svg`;
```

See `flags.js` for a small helper (`flagUrl`) that handles missing codes.

## Source / license

Flags are from [HatScripts/circle-flags](https://github.com/HatScripts/circle-flags)
(the `gh-pages` branch), distributed under the **MIT License**. Alias files in
the upstream set were resolved to their real SVG targets when imported.
