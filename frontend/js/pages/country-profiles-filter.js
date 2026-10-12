/**
 * Country Profiles index filter — pure function shared by the page and the
 * server-side unit tests (plain script in the browser, CommonJS under node).
 *
 *   filterCountries(countries, { q: 'geor', region: 'ECS' })
 *
 * `q` matches case- and accent-insensitively against the source name, the
 * Georgian display name and the ISO codes; `region` is an exact region id.
 */
(function (root) {
  function fold(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  function filterCountries(countries, { q = '', region = '' } = {}) {
    const needle = fold(q);
    const regionId = String(region || '').trim();
    return (countries || []).filter((c) => {
      if (regionId && !(c.region && c.region.id === regionId)) return false;
      if (!needle) return true;
      return [c.name, c.nameKa, c.iso3, c.iso2].some((v) => v && fold(v).includes(needle));
    });
  }

  // Region list from a country list: unique, sorted by name.
  function regionsOf(countries) {
    const seen = new Map();
    for (const c of countries || []) {
      if (c.region && c.region.id && !seen.has(c.region.id)) seen.set(c.region.id, { id: c.region.id, name: c.region.name });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const api = { filterCountries, regionsOf, fold };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CountryProfilesFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
