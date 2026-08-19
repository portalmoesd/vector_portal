/**
 * Country Comparison Page
 * Compares trade statistics (turnover / export / import + top products)
 * of two countries for a chosen period, using data from
 * ex-trade-api.geostat.ge.
 *
 * Calls the Geostat API directly from the browser.
 * Falls back to our backend proxy (/api/statistics/) if direct calls fail.
 */
(async function () {
  // ── Synchronous pre-localization ─────────────────────────────────────
  // Set static labels from the localStorage locales BEFORE the async init
  // so a Georgian UI doesn't flash the English fallback text. The later
  // I18n / applyReportLocale passes re-apply identical strings.
  {
    const earlySite = localStorage.getItem('locale') || 'ka';
    const early = localStorage.getItem('statReportLocale') || earlySite;
    const ka = early === 'ka';
    const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('country1Label', ka ? 'ქვეყანა 1' : 'Country 1');
    setText('country2Label', ka ? 'ქვეყანა 2' : 'Country 2');
    setText('periodLabelEl', ka ? 'პერიოდი' : 'Period');
    for (const id of ['country1Search', 'country2Search']) {
      const el = document.getElementById(id);
      if (el) el.placeholder = ka ? 'ქვეყნის ძებნა...' : 'Search country...';
    }
    const genBtn = document.getElementById('generateBtn');
    if (genBtn) genBtn.textContent = earlySite === 'ka' ? 'გენერაცია' : 'Generate';
    document.querySelectorAll('.stat-loading-label').forEach(el => {
      el.textContent = ka ? 'იტვირთება...' : 'Loading...';
    });
    document.querySelectorAll('#reportLangToggle .stat-lang-toggle__btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.reportLang === early);
    });
    // The mode-switch pill is interface chrome, so its labels follow the
    // site locale, like the page title and the Generate button.
    const sw = document.getElementById('statModeSwitch');
    if (sw) {
      const siteKa = earlySite === 'ka';
      const labels = {
        latest: siteKa ? 'უახლესი სტატისტიკა' : 'Latest Statistics',
        comparison: siteKa ? 'ქვეყნების შედარება' : 'Country Comparison',
        products: siteKa ? 'პროდუქტები' : 'Products',
      };
      for (const [mode, text] of Object.entries(labels)) {
        const btn = sw.querySelector(`[data-mode="${mode}"]`);
        if (btn) btn.textContent = text;
      }
    }
    positionModeThumb(); // hoisted function declaration
  }

  await App.init();

  const user = Api.getUser();
  if (!user) return;

  // ── Constants ──────────────────────────────────────────────────────────
  const GEOSTAT_API = 'https://ex-trade-api.geostat.ge/api/trade';
  const PROXY_API = `${API_BASE}/api/statistics`;
  // Geostat's ex-trade dataset starts at 2009.
  const MIN_YEAR = 2009;

  // ── DOM refs ───────────────────────────────────────────────────────────
  const country1Search = document.getElementById('country1Search');
  const country1Dropdown = document.getElementById('country1Dropdown');
  const country1Value = document.getElementById('country1Value');
  const country2Search = document.getElementById('country2Search');
  const country2Dropdown = document.getElementById('country2Dropdown');
  const country2Value = document.getElementById('country2Value');
  const country1Label = document.getElementById('country1Label');
  const country2Label = document.getElementById('country2Label');
  const periodLabelEl = document.getElementById('periodLabelEl');
  const periodModeSelect = document.getElementById('cmpPeriodMode');
  const monthSelect = document.getElementById('cmpMonth');
  const generateBtn = document.getElementById('generateBtn');
  const cmpLoading = document.getElementById('cmpLoading');
  const cmpSections = document.getElementById('cmpSections');
  const cmpSummaryEl = document.getElementById('cmpSummary');
  const turnoverChartHeader = document.getElementById('turnoverChartHeader');
  const turnoverCanvas = document.getElementById('cmpTurnoverChart');
  const exportChartHeader = document.getElementById('exportChartHeader');
  const exportCanvas = document.getElementById('cmpExportChart');
  const importChartHeader = document.getElementById('importChartHeader');
  const importCanvas = document.getElementById('cmpImportChart');
  const exportHeader1 = document.getElementById('exportHeader1');
  const exportTable1 = document.getElementById('exportTable1');
  const exportHeader2 = document.getElementById('exportHeader2');
  const exportTable2 = document.getElementById('exportTable2');
  const importHeader1 = document.getElementById('importHeader1');
  const importTable1 = document.getElementById('importTable1');
  const importHeader2 = document.getElementById('importHeader2');
  const importTable2 = document.getElementById('importTable2');
  const fdiSection = document.getElementById('fdiSection');
  const fdiChartHeader = document.getElementById('fdiChartHeader');
  const fdiCanvas = document.getElementById('cmpFdiChart');
  const fdiHeader1 = document.getElementById('fdiHeader1');
  const fdiTable1 = document.getElementById('fdiTable1');
  const fdiHeader2 = document.getElementById('fdiHeader2');
  const fdiTable2 = document.getElementById('fdiTable2');
  const fdiSectorsCard = document.getElementById('fdiSectorsCard');
  const fdiSectorsHeader = document.getElementById('fdiSectorsHeader');
  const fdiSectorsTable = document.getElementById('fdiSectorsTable');
  const tourismSection = document.getElementById('tourismSection');
  const tourismChartHeader = document.getElementById('tourismChartHeader');
  const tourismCanvas = document.getElementById('cmpTourismChart');
  const tourismTableHeader = document.getElementById('tourismTableHeader');
  const tourismTable = document.getElementById('tourismTable');
  const reportLangToggle = document.getElementById('reportLangToggle');

  // Sliding thumb of the Latest Statistics ⇄ Country Comparison switch
  // (same mechanism as the dashboards' mn-toggle, dashboard-minister.js).
  function positionModeThumb() {
    const sw = document.getElementById('statModeSwitch');
    const thumb = document.getElementById('statModeThumb');
    const active = sw && sw.querySelector('.stat-mode-switch__btn.active');
    if (!sw || !thumb || !active) return;
    thumb.style.left = active.offsetLeft + 'px';
    thumb.style.width = active.offsetWidth + 'px';
  }
  window.addEventListener('resize', positionModeThumb);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionModeThumb);

  // ── State ──────────────────────────────────────────────────────────────
  let countries = [];
  let classData = null;
  let selectedCountry1 = null;
  let selectedCountry2 = null;
  let useProxy = false;
  let lastResult = null; // everything needed to re-render on language toggle
  let generating = false;
  const chartInstances = { turnover: null, export: null, import: null, fdi: null, tourism: null };

  // Same per-page report language convention (and persisted key) as the
  // statistics page — independent from the global site locale.
  let reportLocale = localStorage.getItem('statReportLocale') || I18n.getLocale() || 'ka';

  const SEARCH_PLACEHOLDER = { ka: 'ქვეყნის ძებნა...', en: 'Search country...' };
  const LOADING_LABEL = { ka: 'იტვირთება...', en: 'Loading...' };

  // Two-country palette: same color = same country on every chart.
  const C1_COLOR = '#3b82f6'; // blue
  const C2_COLOR = '#f59e0b'; // amber (high contrast / colorblind-safe vs blue)

  // ── Geostat API helpers (copied from statistics.js:129/142) ────────────

  async function geostatGet(path) {
    if (!useProxy) {
      try {
        const res = await fetch(`${GEOSTAT_API}${path}`);
        if (res.ok) return res.json();
      } catch (_) { /* fall through to proxy */ }
      useProxy = true;
    }
    const res = await fetch(`${PROXY_API}${path}`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  async function geostatPost(path, body) {
    if (!useProxy) {
      try {
        const res = await fetch(`${GEOSTAT_API}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) return res.json();
      } catch (_) { /* fall through to proxy */ }
      useProxy = true;
    }
    const res = await fetch(`${PROXY_API}${path.replace('/get_data', '/trade-data')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  // ── Load classificatory data (copied from statistics.js:163-207) ───────
  const countryNameEnMap = {};
  const countryNameKaMap = {};
  let classDataKa = null;
  let classDataEn = null;

  try {
    const [enJson, kaJson] = await Promise.all([
      geostatGet('/classificatory?lang=en').catch(() => null),
      geostatGet('/classificatory?lang=ka').catch(() => null),
    ]);
    if (enJson && enJson.success && enJson.data) {
      classDataEn = enJson.data;
      for (const c of (enJson.data.countries || [])) {
        countryNameEnMap[c.value] = c.label.replace(/^\d+\s+/, '');
      }
    }
    if (kaJson && kaJson.success && kaJson.data) {
      classDataKa = kaJson.data;
      for (const c of (kaJson.data.countries || [])) {
        countryNameKaMap[c.value] = c.label.replace(/^\d+\s+/, '');
      }
    }
    const primary = reportLocale === 'ka' ? (classDataKa || classDataEn) : (classDataEn || classDataKa);
    if (primary) {
      classData = primary;
      countries = (primary.countries || []).map(c => {
        const baseLabel = c.label.replace(/^\d+\s+/, '');
        const kaName = countryNameKaMap[c.value] || baseLabel;
        const enName = countryNameEnMap[c.value] || baseLabel;
        return {
          ...c,
          displayLabelKa: kaName,
          displayLabelEn: enName,
          displayLabel: reportLocale === 'ka' ? kaName : enName,
        };
      });
    }
  } catch (err) {
    console.error('Failed to load classificatory data:', err);
  }

  // ── Verify latest month (copied from statistics.js:215-259) ────────────
  // Geostat sometimes publishes a new month's rows before bumping
  // `selected.month`; probe month+1 / month+2 once on init.
  async function verifyLatestMonth() {
    const primary = classDataEn || classDataKa;
    if (!primary || !primary.selected) return;
    const { year, month } = primary.selected;
    if (!Number.isInteger(year) || !Number.isInteger(month) || month >= 12) return;

    async function hasDataFor(m) {
      try {
        const json = await geostatPost('/get_data', {
          tradeFlow: 10,
          measurementUnits: [1],
          years: [year],
          months: [m],
          sum: true,
          page: 1,
          pageSize: 1,
        });
        if (!json || !json.success || !Array.isArray(json.data)) return false;
        for (const row of json.data) {
          for (const k of Object.keys(row)) {
            if (k.startsWith('usd1000_')) {
              const v = parseFloat(row[k]);
              if (!isNaN(v) && v > 0) return true;
            }
          }
        }
        return false;
      } catch (_) { return false; }
    }

    const [p1, p2] = await Promise.all([
      hasDataFor(month + 1),
      month + 2 <= 12 ? hasDataFor(month + 2) : Promise.resolve(false),
    ]);
    let verified = month;
    if (p1) verified = month + 1;
    if (p2) verified = month + 2;
    if (verified !== month) {
      if (classDataEn && classDataEn.selected) classDataEn.selected.month = verified;
      if (classDataKa && classDataKa.selected) classDataKa.selected.month = verified;
    }
  }

  try { await verifyLatestMonth(); } catch (_) { /* non-fatal */ }

  // ── Latest available period (copied from statistics.js:517) ────────────
  function detectLatestPeriod(cd) {
    if (cd.selected) {
      return { year: cd.selected.year, month: cd.selected.month };
    }
    const years = (cd.year || []).map(y => y.value).sort((a, b) => b - a);
    const months = (cd.month || []).map(m => m.value).sort((a, b) => b - a);
    return { year: years[0], month: months[0] };
  }

  const latestPeriod = classData ? detectLatestPeriod(classDataEn || classDataKa) : null;

  // ── Load HS4 short name mappings (copied from statistics.js:274-301) ───
  const hs4NameMap = {};
  const hs4NameMapEn = {};
  try {
    const csvRes = await fetch('/data/hs4-names-ka.csv');
    const csvText = await csvRes.text();
    for (const line of csvText.split('\n').slice(1)) {
      const comma = line.indexOf(',');
      if (comma < 0) continue;
      const code = parseInt(line.slice(0, comma).trim(), 10);
      const name = line.slice(comma + 1).trim().replace(/^"|"$/g, '');
      if (code && name) hs4NameMap[code] = name;
    }
  } catch (err) {
    console.error('Failed to load HS4 name mapping:', err);
  }
  try {
    const csvResEn = await fetch('/data/hs4-names-en.csv');
    const csvTextEn = await csvResEn.text();
    for (const line of csvTextEn.split('\n').slice(1)) {
      const comma = line.indexOf(',');
      if (comma < 0) continue;
      const code = parseInt(line.slice(0, comma).trim(), 10);
      const name = line.slice(comma + 1).trim().replace(/^"|"$/g, '');
      if (code && name) hs4NameMapEn[code] = name;
    }
  } catch (err) {
    console.error('Failed to load English HS4 name mapping:', err);
  }

  // ── Georgian grammar forms for country names (statistics.js:333-372) ───
  const countryGrammar = {}; // nominative → { nom, withCase, inCase, from, of }
  try {
    const csvRes = await fetch('/data/country-grammar.csv');
    if (csvRes.ok) {
      const csvText = await csvRes.text();
      const lines = csvText.split(/\r?\n/).slice(1);
      for (const line of lines) {
        if (!line.trim()) continue;
        const cells = [];
        let i = 0;
        while (i < line.length) {
          if (line[i] === '"') {
            let end = i + 1;
            while (end < line.length && line[end] !== '"') end++;
            cells.push(line.slice(i + 1, end));
            i = end + 2;
          } else {
            let end = i;
            while (end < line.length && line[end] !== ',') end++;
            cells.push(line.slice(i, end));
            i = end + 1;
          }
        }
        const [nom, withCase, inCase, from, of_] = cells.map(s => (s || '').trim());
        if (nom) countryGrammar[nom] = { nom, withCase, inCase, from, of: of_ };
      }
    }
  } catch (err) {
    console.warn('country-grammar load failed:', err && err.message);
  }

  function kaGrammarFallback(nom) {
    return { nom, withCase: nom + 'თან', inCase: nom + 'ში', from: nom + 'დან', of: nom + 'ის' };
  }
  function grammarFor(nominative) {
    return countryGrammar[nominative] || kaGrammarFallback(nominative || '');
  }

  // ── Country name mapping (GNTA tourism names) ──────────────────────────
  // GNTA tourism data is keyed by Georgian country names that don't always
  // match the Geostat classificatory labels. Copied from statistics.js:303-324.
  const countryNameMap = {}; // variant → canonical GNTA name
  try {
    const csvRes = await fetch('/data/country-name-mapping.csv');
    const csvText = await csvRes.text();
    for (const line of csvText.split('\n').slice(1)) {
      // CSV format: "variant","canonical"
      const match = line.match(/"([^"]*)","([^"]*)"/);
      if (match) countryNameMap[match[1].trim()] = match[2].trim();
    }
  } catch (err) {
    console.error('Failed to load country name mapping:', err);
  }

  // Apply canonical names to each country's KA display label, keeping the
  // original trade name as rawLabel (statistics.js:319-324).
  for (const c of countries) {
    c.rawLabel = c.displayLabelKa;
    const canonical = countryNameMap[c.displayLabelKa];
    if (canonical) c.displayLabelKa = canonical;
    c.displayLabel = reportLocale === 'ka' ? c.displayLabelKa : c.displayLabelEn;
  }

  // English → Georgian-canonical entries so GNTA resolution works when the
  // report language is English (statistics.js:442-450).
  for (const c of countries) {
    const englishName = countryNameEnMap[c.value];
    const georgianName = countryNameKaMap[c.value];
    const georgianCanonical = (georgianName && countryNameMap[georgianName]) || georgianName;
    if (englishName && georgianCanonical && !countryNameMap[englishName]) {
      countryNameMap[englishName] = georgianCanonical;
    }
  }

  // Resolve a classificatory country to a GNTA dataset key
  // (copied from statistics.js:1854).
  function resolveGntaName(country, gntaCountries) {
    const canonical = country.displayLabel;
    const raw = country.rawLabel || canonical;
    if (gntaCountries[canonical]) return canonical;
    if (gntaCountries[raw]) return raw;
    const mapped = countryNameMap[canonical];
    if (mapped && gntaCountries[mapped]) return mapped;
    const mappedRaw = countryNameMap[raw];
    if (mappedRaw && gntaCountries[mappedRaw]) return mappedRaw;
    const target = mapped || canonical;
    for (const [variant, canon] of Object.entries(countryNameMap)) {
      if (canon === target && gntaCountries[variant]) return variant;
    }
    for (const gntaName of Object.keys(gntaCountries)) {
      if (gntaName.includes(target) || target.includes(gntaName)) return gntaName;
    }
    return null;
  }

  // Georgian month forms (copied from statistics.js:1285-1287)
  const KA_MONTH_STEM = { 1:'იანვარ', 2:'თებერვალ', 3:'მარტ', 4:'აპრილ', 5:'მაის', 6:'ივნის', 7:'ივლის', 8:'აგვისტო', 9:'სექტემბერ', 10:'ოქტომბერ', 11:'ნოემბერ', 12:'დეკემბერ' };
  const KA_MONTH_LOC = { 1:'იანვარში', 2:'თებერვალში', 3:'მარტში', 4:'აპრილში', 5:'მაისში', 6:'ივნისში', 7:'ივლისში', 8:'აგვისტოში', 9:'სექტემბერში', 10:'ოქტომბერში', 11:'ნოემბერში', 12:'დეკემბერში' };

  // ── Formatting helpers (copied from statistics.js:1370-1396/1539/1836) ─

  function calcChange(current, previous) {
    if (!previous || previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / Math.abs(previous)) * 100;
  }

  function formatChangePct(pct) {
    const rounded = Math.round(pct);
    if (rounded === 0 && pct !== 0) {
      return pct.toFixed(1) + '%';
    }
    return rounded + '%';
  }

  function formatMln2(val) {
    return val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatMln(val) {
    let str;
    if (val >= 100) str = val.toFixed(1);
    else if (val >= 10) str = val.toFixed(2);
    else if (val >= 0.01) str = val.toFixed(2);
    else if (val > 0) str = val.toFixed(3);
    else str = '0.00';
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function chartLabel(val) {
    return val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const INSIGNIFICANT_MLN = 0.005;

  // ── Data fetch helpers (copied from statistics.js:1017/1046/1720) ──────

  function extractValue(row) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('usd1000_')) {
        const v = parseFloat(row[key]);
        if (!isNaN(v)) return v;
      }
    }
    return 0;
  }

  async function fetchTradeTotal(tradeFlow, years, months, countryId) {
    const filters = {
      tradeFlow,
      measurementUnits: [1],
      years,
      months,
      countries: [countryId],
      locale: reportLocale,
      sum: true,
      page: 1,
      pageSize: 10,
    };

    const json = await geostatPost('/get_data', filters);
    if (!json.success) return 0;

    if (Array.isArray(json.data)) {
      for (const row of json.data) {
        if (row.isGroupSummary) return extractValue(row);
      }
      if (json.data.length > 0) return extractValue(json.data[0]);
    }
    return 0;
  }

  async function fetchAllTradeData(tradeFlow, years, months, countryId) {
    const allData = [];
    let page = 1;
    let total = Infinity;
    const pageSize = 200;

    while (allData.length < total && page < 100) {
      const filters = {
        tradeFlow,
        measurementUnits: [1],
        years,
        months,
        countries: [countryId],
        hs4: ['all'],
        locale: reportLocale,
        sum: true,
        page,
        pageSize,
      };

      const json = await geostatPost('/get_data', filters);
      if (!json.success) throw new Error('Trade data fetch failed');

      total = json.total || 0;
      if (Array.isArray(json.data)) {
        allData.push(...json.data);
      }
      if (!json.data || json.data.length === 0) break;
      page++;
    }

    return allData;
  }

  // ── Product list build (copied from statistics.js:1654/1744) ───────────

  function cleanHs4Name(name, hs4Code) {
    if (hs4Code && hs4NameMap[hs4Code]) return hs4NameMap[hs4Code];
    return name.replace(/^\d{2,6}\s+/, '');
  }

  function cleanHs4NameEn(name, hs4Code) {
    if (hs4Code && hs4NameMapEn[hs4Code]) return hs4NameMapEn[hs4Code];
    return `HS ${hs4Code || '????'}`;
  }

  function buildProductList(currentData, prevData, reexportData) {
    const currentMap = {};
    for (const row of currentData) {
      if (row.isGroupSummary || !row.hs4) continue;
      const val = extractValue(row);
      if (val > 0) {
        if (!currentMap[row.hs4]) {
          currentMap[row.hs4] = {
            hs4: row.hs4,
            name: cleanHs4Name(row.hs4_name || `HS ${row.hs4}`, row.hs4),
            nameEn: cleanHs4NameEn(row.hs4_name || `HS ${row.hs4}`, row.hs4),
            valueThdUsd: 0,
          };
        }
        currentMap[row.hs4].valueThdUsd += val;
      }
    }

    const prevMap = {};
    for (const row of prevData) {
      if (row.isGroupSummary || !row.hs4) continue;
      const val = extractValue(row);
      if (val > 0) prevMap[row.hs4] = (prevMap[row.hs4] || 0) + val;
    }

    const reexportMap = {};
    if (reexportData) {
      for (const row of reexportData) {
        if (row.isGroupSummary || !row.hs4) continue;
        const val = extractValue(row);
        if (val > 0) reexportMap[row.hs4] = (reexportMap[row.hs4] || 0) + val;
      }
    }

    let products = Object.values(currentMap)
      .sort((a, b) => b.valueThdUsd - a.valueThdUsd)
      .map(p => ({
        ...p,
        valueMln: p.valueThdUsd / 1000,
        prevValueMln: (prevMap[p.hs4] || 0) / 1000,
        reexportMln: (reexportMap[p.hs4] || 0) / 1000,
      }));

    const significant = products.filter(p => p.valueMln >= 0.01);
    let result;
    if (significant.length >= 5) {
      result = significant.slice(0, 15);
    } else {
      result = products.slice(0, Math.max(5, significant.length));
    }

    return result.map(p => ({
      hs4: p.hs4,
      name: p.name,
      nameEn: p.nameEn,
      valueMln: p.valueMln,
      change: p.prevValueMln > 0
        ? ((p.valueMln - p.prevValueMln) / p.prevValueMln * 100)
        : (p.valueMln > 0 ? 100 : 0),
      reexportShare: p.valueMln > 0
        ? (p.reexportMln / p.valueMln * 100)
        : 0,
    }));
  }

  // ── Product table render (copied from statistics.js:1773, parameterised) ─
  // `changeAvailable` = false renders "—" in the Change column (no prior
  // period exists, e.g. the chosen year is 2009).

  // `sharedHs4` marks products that appear in BOTH countries' tables of the
  // pair (light-yellow row highlight). Expand buttons are wired per pair by
  // wireExpandPair so "Show more" uncovers both tables together.
  function renderProductTable(el, products, periodText, showReexport, changeAvailable, sharedHs4) {
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>${reportLocale === 'ka' ? 'მონაცემები ვერ მოიძებნა' : 'No data found'}</p></div>`;
      return;
    }

    const isKa = reportLocale === 'ka';
    const hProduct = isKa ? 'პროდუქცია (HS 4-ნიშნა)' : 'Product (HS 4-digit)';
    const hValue = isKa ? `${periodText}<br>მლნ. $` : `${periodText}<br>mln $`;
    const hChange = isKa ? 'ცვლილება<br>%' : 'Change<br>%';
    const hReexport = isKa ? 'რეექსპორტის წილი<br>%' : 'Re-export share<br>%';

    const INITIAL_COUNT = 10;
    const hasMore = products.length > INITIAL_COUNT;

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th class="stat-col-product">${hProduct}</th>
          <th class="stat-col-value">${hValue}</th>
          <th class="stat-col-change">${hChange}</th>
          ${showReexport ? `<th class="stat-col-reexport">${hReexport}</th>` : ''}
        </tr>
      </thead>
      <tbody>`;

    products.forEach((p, i) => {
      const changeClass = p.change > 0 ? 'stat-positive' : (p.change < 0 ? 'stat-negative' : '');
      const changeSign = p.change > 0 ? '+' : '';
      const changeCell = changeAvailable ? `${changeSign}${formatChangePct(p.change)}` : '—';
      const hiddenStyle = (hasMore && i >= INITIAL_COUNT) ? ' style="display:none" data-expandable' : '';
      const sharedClass = (sharedHs4 && sharedHs4.has(p.hs4)) ? ' class="cmp-shared-row"' : '';
      html += `
        <tr${sharedClass}${hiddenStyle}>
          <td class="stat-col-product">${escapeHtml(reportLocale !== 'ka' && p.nameEn ? p.nameEn : p.name)}</td>
          <td class="stat-col-value">${formatMln(p.valueMln)}</td>
          <td class="stat-col-change ${changeAvailable ? changeClass : ''}">${changeCell}</td>
          ${showReexport ? `<td class="stat-col-reexport">${p.reexportShare === 0 ? '-' : formatChangePct(p.reexportShare)}</td>` : ''}
        </tr>`;
    });

    html += '</tbody></table>';

    if (hasMore) {
      const showMoreText = isKa ? 'მეტის ჩვენება' : 'Show more';
      const showLessText = isKa ? 'ნაკლების ჩვენება' : 'Show less';
      html += `<button class="stat-expand-btn" data-more="${showMoreText}" data-less="${showLessText}">${showMoreText}</button>`;
    }

    el.innerHTML = html;
  }

  // Products present in both lists, matched by HS4 code.
  function sharedProductSet(list1, list2) {
    const codes2 = new Set(list2.map(p => p.hs4));
    return new Set(list1.map(p => p.hs4).filter(c => c !== undefined && codes2.has(c)));
  }

  // One expand state per table pair: pressing "Show more" on either side
  // uncovers (or hides) the extra rows in both tables together.
  function wireExpandPair(el1, el2) {
    const els = [el1, el2];
    const btns = els.map(el => el.querySelector('.stat-expand-btn')).filter(Boolean);
    if (!btns.length) return;
    let expanded = false;
    const apply = () => {
      for (const el of els) {
        el.querySelectorAll('tr[data-expandable]').forEach(r => { r.style.display = expanded ? '' : 'none'; });
      }
      for (const b of btns) b.textContent = expanded ? b.dataset.less : b.dataset.more;
    };
    for (const b of btns) {
      b.addEventListener('click', () => { expanded = !expanded; apply(); });
    }
  }

  function renderCmpSectionHeader(el, countryName, type, periodText) {
    const isKa = reportLocale === 'ka';
    const labels = {
      export: isKa ? 'ძირითადი საექსპორტო პროდუქცია' : 'Main Export Products',
      import: isKa ? 'ძირითადი საიმპორტო პროდუქცია' : 'Main Import Products',
    };
    const t = `${countryName} - ${labels[type]}, ${periodText}`;
    el.innerHTML = `<h3 class="stat-report__title">${escapeHtml(t)}</h3>`;
  }

  // ── Report language toggle ─────────────────────────────────────────────

  function monthArr(isKa) {
    const cd = isKa ? (classDataKa || classDataEn) : (classDataEn || classDataKa);
    return (cd && cd.month) || [];
  }

  function monthLabel(m, isKa) {
    const found = monthArr(isKa).find(x => x.value === m);
    return found ? found.label : `M${m}`;
  }

  function monthShort(m, isKa) {
    return monthLabel(m, isKa).slice(0, 3);
  }

  function applyReportLocale() {
    const isKa = reportLocale === 'ka';
    classData = isKa ? (classDataKa || classDataEn) : (classDataEn || classDataKa);
    for (const c of countries) {
      c.displayLabel = isKa ? c.displayLabelKa : c.displayLabelEn;
    }
    if (selectedCountry1) {
      selectedCountry1.displayLabel = isKa ? selectedCountry1.displayLabelKa : selectedCountry1.displayLabelEn;
      country1Search.value = selectedCountry1.displayLabel;
    }
    if (selectedCountry2) {
      selectedCountry2.displayLabel = isKa ? selectedCountry2.displayLabelKa : selectedCountry2.displayLabelEn;
      country2Search.value = selectedCountry2.displayLabel;
    }

    country1Label.textContent = isKa ? 'ქვეყანა 1' : 'Country 1';
    country2Label.textContent = isKa ? 'ქვეყანა 2' : 'Country 2';
    periodLabelEl.textContent = isKa ? 'პერიოდი' : 'Period';
    country1Search.placeholder = SEARCH_PLACEHOLDER[reportLocale];
    country2Search.placeholder = SEARCH_PLACEHOLDER[reportLocale];
    document.querySelectorAll('.stat-loading-label').forEach(el => {
      el.textContent = LOADING_LABEL[reportLocale];
    });

    populatePeriodSelects();

    if (reportLangToggle) {
      reportLangToggle.querySelectorAll('.stat-lang-toggle__btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.reportLang === reportLocale);
      });
    }

    // Re-render an already generated comparison in the new language —
    // everything needed is cached in lastResult, no refetch.
    if (lastResult) renderComparison();
  }

  if (reportLangToggle) {
    reportLangToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.stat-lang-toggle__btn');
      if (!btn) return;
      const next = btn.dataset.reportLang;
      if (!next || next === reportLocale) return;
      reportLocale = next;
      localStorage.setItem('statReportLocale', reportLocale);
      applyReportLocale();
    });
  }

  // ── Country pickers (factory rewritten from statistics.js:454-491) ─────

  function setupCountryPicker(inputEl, dropdownEl, hiddenEl, getOther, onSelect) {
    function render(filter) {
      const q = (filter || '').toLowerCase();
      const other = getOther();
      const pool = countries.filter(c => !other || c.value !== other.value);
      const filtered = q
        ? pool.filter(c => c.displayLabel.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
        : pool;
      const shown = filtered.slice(0, 50);

      if (shown.length === 0) {
        dropdownEl.innerHTML = `<div class="stat-dropdown__empty">${escapeHtml(I18n.tr('statistics.noResults'))}</div>`;
      } else {
        const current = Number(hiddenEl.value);
        dropdownEl.innerHTML = shown.map(c =>
          `<div class="stat-dropdown__item${current === c.value ? ' selected' : ''}" data-value="${c.value}">${escapeHtml(c.displayLabel)}</div>`
        ).join('');
      }
      dropdownEl.classList.remove('hidden');
    }

    inputEl.addEventListener('focus', () => render(inputEl.value));
    inputEl.addEventListener('input', () => render(inputEl.value));

    dropdownEl.addEventListener('click', (e) => {
      const item = e.target.closest('.stat-dropdown__item');
      if (!item) return;
      const val = Number(item.dataset.value);
      const country = countries.find(c => c.value === val) || null;
      if (country) {
        inputEl.value = country.displayLabel;
        hiddenEl.value = country.value;
        onSelect(country);
      }
      dropdownEl.classList.add('hidden');
    });
  }

  setupCountryPicker(
    country1Search, country1Dropdown, country1Value,
    () => selectedCountry2,
    (c) => { selectedCountry1 = c; updateGenerateState(); },
  );
  setupCountryPicker(
    country2Search, country2Dropdown, country2Value,
    () => selectedCountry1,
    (c) => { selectedCountry2 = c; updateGenerateState(); },
  );

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stat-search-wrap')) {
      country1Dropdown.classList.add('hidden');
      country2Dropdown.classList.add('hidden');
    }
  });

  function updateGenerateState() {
    generateBtn.disabled = generating ||
      !selectedCountry1 || !selectedCountry2 ||
      selectedCountry1.value === selectedCountry2.value;
  }

  // ── Period selects ─────────────────────────────────────────────────────

  function populatePeriodSelects() {
    const isKa = reportLocale === 'ka';
    const prevMode = periodModeSelect.value || 'latest';
    const prevMonth = monthSelect.value || '';

    const years = ((classData && classData.year) || [])
      .map(y => y.value)
      .filter(y => y >= MIN_YEAR)
      .sort((a, b) => b - a);

    let html = `<option value="latest">${isKa ? 'უახლესი' : 'Most recent'}</option>`;
    for (const y of years) {
      html += `<option value="${y}">${y}</option>`;
    }
    periodModeSelect.innerHTML = html;
    periodModeSelect.value = [...periodModeSelect.options].some(o => o.value === prevMode) ? prevMode : 'latest';

    populateMonthSelect(prevMonth);
  }

  function populateMonthSelect(keepValue) {
    const isKa = reportLocale === 'ka';
    const mode = periodModeSelect.value;
    const explicitYear = mode !== 'latest' ? Number(mode) : null;

    // Month selection only applies to an explicit year; "Most recent"
    // auto-detects its own year + month.
    monthSelect.disabled = !explicitYear;

    let months = monthArr(isKa).slice().sort((a, b) => a.value - b.value);
    // For the latest (partially published) year only offer published months.
    if (explicitYear && latestPeriod && explicitYear === latestPeriod.year && latestPeriod.month < 12) {
      months = months.filter(m => m.value <= latestPeriod.month);
    }

    let html = `<option value="">${isKa ? 'სრული წელი' : 'Full year'}</option>`;
    for (const m of months) {
      html += `<option value="${m.value}">${escapeHtml(m.label)}</option>`;
    }
    monthSelect.innerHTML = html;
    const keep = keepValue !== undefined ? keepValue : monthSelect.value;
    monthSelect.value = !explicitYear ? '' :
      ([...monthSelect.options].some(o => o.value === String(keep)) ? String(keep) : '');
  }

  periodModeSelect.addEventListener('change', () => populateMonthSelect(monthSelect.value));

  // ── Period point computation ───────────────────────────────────────────
  // Returns the x-axis period points for the charts plus the chosen period
  // (for tables/summary) and the same period one year earlier (for change %).
  //
  //  - latest:            5 full years before the latest period + the latest
  //                       period itself (YTD when the year is partial).
  //  - explicit year Y:   Y-3..Y+1 full years; Y+1 that is only partially
  //                       published is included as a YTD point; at the lower
  //                       bound the window shifts to keep 5 points.
  //  - year Y + month M:  cumulative Jan..M for 5 years; if Y+1's Jan..M is
  //                       not fully published the window slides back.

  function rangeMonths(m) {
    return Array.from({ length: m }, (_, i) => i + 1);
  }

  function computePeriodPoints(mode, latest, year, month) {
    const L = latest;
    const points = [];

    if (mode === 'latest') {
      const partial = L.month < 12;
      for (let y = L.year - 5; y < L.year; y++) {
        points.push({ year: y, months: null, isYtd: false });
      }
      points.push({ year: L.year, months: partial ? rangeMonths(L.month) : null, isYtd: partial });
    } else if (!month) {
      let end = Math.min(year + 1, L.year);
      let start = end - 4;
      if (start < MIN_YEAR) { start = MIN_YEAR; end = MIN_YEAR + 4; }
      for (let y = start; y <= end; y++) {
        const partial = y === L.year && L.month < 12;
        points.push({ year: y, months: partial ? rangeMonths(L.month) : null, isYtd: partial });
      }
    } else {
      let end = (year + 1 > L.year || (year + 1 === L.year && month > L.month)) ? year : year + 1;
      let start = end - 4;
      if (start < MIN_YEAR) { start = MIN_YEAR; end = MIN_YEAR + 4; }
      for (let y = start; y <= end; y++) {
        points.push({ year: y, months: rangeMonths(month), isYtd: false });
      }
    }

    const chosenYear = mode === 'latest' ? L.year : year;
    const chosen = points.find(p => p.year === chosenYear) || points[points.length - 1];
    const prevPeriod = chosen.year - 1 >= MIN_YEAR
      ? { year: chosen.year - 1, months: chosen.months }
      : null;

    return { points, chosen, prevPeriod };
  }

  // Label for one chart point: "2023", or "Jan-Jun'26" for a YTD point.
  function pointLabel(p, isKa) {
    if (!p.isYtd) return String(p.year);
    const shortYear = String(p.year).slice(2);
    const m = p.months;
    if (m.length === 1) {
      return `${monthShort(m[0], isKa)}'${shortYear}`;
    }
    return `${monthShort(m[0], isKa)}-${monthShort(m[m.length - 1], isKa)}'${shortYear}`;
  }

  // Human label of the chosen period, e.g. "2024", "Jan-Jun 2026" /
  // "იან-ივნ 2026" — used in table headers.
  function chosenPeriodText(chosen, isKa) {
    if (!chosen.months) return String(chosen.year);
    const m = chosen.months;
    const part = m.length === 1
      ? monthShort(m[0], isKa)
      : `${monthShort(m[0], isKa)}-${monthShort(m[m.length - 1], isKa)}`;
    return `${part} ${chosen.year}`;
  }

  // Prose form of the chosen period, e.g. "In 2024" / "2024 წელს",
  // "In January-June 2026" / "2026 წლის იანვარ-ივნისში".
  function chosenPeriodProse(chosen, isKa) {
    if (!chosen.months) {
      return isKa ? `${chosen.year} წელს` : `In ${chosen.year}`;
    }
    const m = chosen.months;
    const first = m[0];
    const last = m[m.length - 1];
    if (isKa) {
      const part = m.length === 1
        ? KA_MONTH_LOC[last]
        : `${KA_MONTH_STEM[first]}-${KA_MONTH_LOC[last]}`;
      return `${chosen.year} წლის ${part}`;
    }
    const part = m.length === 1
      ? monthLabel(last, false)
      : `${monthLabel(first, false)}-${monthLabel(last, false)}`;
    return `In ${part} ${chosen.year}`;
  }

  // ── FDI (investments) helpers ──────────────────────────────────────────
  // FDI data is annual (thousand USD, keyed by the same country codes as
  // the trade classificatory) plus quarterly YTD entries for years after
  // the last closed annual year. The FDI section follows the trade charts'
  // year window; month selection is ignored (no sub-annual history exists).

  const ROMAN_Q = ['', 'I', 'II', 'III', 'IV'];

  // Map the trade window's years onto FDI data points for one country.
  // Rank = position among countries with positive FDI in that period;
  // share = country value / grand total (adapted from statistics.js:2301).
  function buildFdiPoints(fdiJson, countryCode, points) {
    const allYears = fdiJson.years || [];
    const lastAnnual = allYears[allYears.length - 1];
    const countryData = fdiJson.countries[countryCode] || {};
    const totals = fdiJson.totals || {};

    function rankAndShare(year, ownVal) {
      const entries = [];
      for (const [code, data] of Object.entries(fdiJson.countries)) {
        const v = (data[year] || 0) / 1000;
        if (v > 0) entries.push({ code, v });
      }
      entries.sort((a, b) => b.v - a.v);
      const idx = entries.findIndex(e => e.code === String(countryCode));
      const rank = idx >= 0 ? idx + 1 : null;
      const totalMln = (totals[year] || 0) / 1000;
      const share = totalMln > 0 ? (ownVal / totalMln) * 100 : null;
      return { rank, share };
    }

    const out = [];
    const seen = new Set();
    for (const p of points) {
      if (seen.has(p.year)) continue;
      seen.add(p.year);
      if (allYears.includes(p.year)) {
        const val = (countryData[p.year] || 0) / 1000;
        const prev = (countryData[p.year - 1] || 0) / 1000;
        const rs = val > 0 ? rankAndShare(p.year, val) : { rank: null, share: null };
        out.push({ year: p.year, quarterInfo: null, valueMln: val, prevMln: prev, rank: rs.rank, share: rs.share, totalMln: (totals[p.year] || 0) / 1000 });
      } else if (p.year > lastAnnual) {
        const q = (fdiJson.quarters || []).find(x => x.year === p.year);
        if (!q) continue; // year beyond published FDI data — drop the point
        const qs = q.quarters || [q.quarter];
        const val = (q.countries[countryCode] || 0) / 1000;
        const prev = ((q.prev && q.prev.countries[countryCode]) || 0) / 1000;
        let rank = null, share = null;
        if (val > 0) {
          const entries = Object.entries(q.countries)
            .map(([code, v]) => ({ code, v }))
            .filter(e => e.v > 0)
            .sort((a, b) => b.v - a.v);
          const idx = entries.findIndex(e => e.code === String(countryCode));
          rank = idx >= 0 ? idx + 1 : null;
          const totalMln = (q.total || 0) / 1000;
          share = totalMln > 0 ? (val / totalMln) * 100 : null;
        }
        out.push({
          year: p.year,
          quarterInfo: { quarters: qs, preliminary: !!q.preliminary },
          valueMln: val, prevMln: prev, rank, share,
          totalMln: (q.total || 0) / 1000,
        });
      }
    }
    return out;
  }

  // "2024", or "2026 I კვ*" / "2026 Q1*" for a quarterly YTD point
  // (label style from statistics.js:2329-2340).
  function fdiPointLabel(p, isKa) {
    if (!p.quarterInfo) return String(p.year);
    const qs = p.quarterInfo.quarters;
    const star = p.quarterInfo.preliminary ? '*' : '';
    if (isKa) {
      const roman = qs.length > 1 ? `${ROMAN_Q[qs[0]]}-${ROMAN_Q[qs[qs.length - 1]]}` : ROMAN_Q[qs[0]];
      return `${p.year} ${roman} კვ${star}`;
    }
    const range = qs.length > 1 ? `${qs[0]}-Q${qs[qs.length - 1]}` : `${qs[0]}`;
    return `${p.year} Q${range}${star}`;
  }

  // Prose form of one FDI point's period, e.g. "2024 წელს" / "In 2024",
  // "2026 წლის I კვარტალში" / "In 2026 Q1".
  function fdiPeriodProse(p, isKa) {
    if (!p.quarterInfo) {
      return isKa ? `${p.year} წელს` : `In ${p.year}`;
    }
    const qs = p.quarterInfo.quarters;
    if (isKa) {
      const roman = qs.length > 1 ? `${ROMAN_Q[qs[0]]}-${ROMAN_Q[qs[qs.length - 1]]}` : ROMAN_Q[qs[0]];
      return `${p.year} წლის ${roman} ${qs.length > 1 ? 'კვარტლებში' : 'კვარტალში'}`;
    }
    const range = qs.length > 1 ? `Q${qs[0]}-Q${qs[qs.length - 1]}` : `Q${qs[0]}`;
    return `In ${p.year} ${range}`;
  }

  // ── Tourism helpers ────────────────────────────────────────────────────
  // GNTA visitor data is annual (2011+) plus a single current YTD quarterly
  // period (e.g. "2026 I-II კვ" vs "2025 I-II კვ"). The tourism section
  // follows the trade charts' year window; the month selection is ignored
  // (no sub-annual history exists) and years before 2011 are dropped.

  // GNTA period labels arrive in Georgian ("2026 I-II კვ"); English gets
  // "2026 Q1-Q2". Bare year labels pass through (statistics.js:2077).
  function localizePeriodLabel(label, isKa) {
    if (isKa) return label || '';
    const m = /^(\d{4})\s+([IVX]+(?:-[IVX]+)?)\s+კვ$/.exec(label || '');
    if (!m) return label || '';
    const romanToInt = { I: 1, II: 2, III: 3, IV: 4 };
    const q = m[2].split('-').map(r => `Q${romanToInt[r] || r}`).join('-');
    return `${m[1]} ${q}`;
  }

  // Prose form of one tourism point's period: "2024 წელს" / "In 2024",
  // "2026 წლის I-II კვარტლებში" / "In Q1-Q2 2026".
  function tourismPeriodProse(p, isKa) {
    if (!p.isCurrent) {
      return isKa ? `${p.year} წელს` : `In ${p.year}`;
    }
    const m = /^(\d{4})\s+([IVX]+(?:-[IVX]+)?)\s+კვ$/.exec(p.label || '');
    if (!m) return isKa ? (p.label || '') : `In ${localizePeriodLabel(p.label, false)}`;
    if (isKa) {
      return `${m[1]} წლის ${m[2]} ${m[2].includes('-') ? 'კვარტლებში' : 'კვარტალში'}`;
    }
    const romanToInt = { I: 1, II: 2, III: 3, IV: 4 };
    const q = m[2].split('-').map(r => `Q${romanToInt[r] || r}`).join('-');
    return `In ${q} ${m[1]}`;
  }

  // Map the trade window's years onto tourism points for one country.
  // Rank = position among resolved real countries (aggregates excluded via
  // validNames) with positive visitors; share = own value / grand total
  // from the source file (adapted from statistics.js:1934-2004).
  function buildTourismPoints(tJson, gntaKey, points, validNames) {
    const countryData = gntaKey ? tJson.countries[gntaKey] : null;
    const annual = (countryData && countryData.annual) || {};
    const allYears = tJson.years || [];
    const lastAnnual = allYears[allYears.length - 1];
    const annualTotals = (tJson.totals && tJson.totals.annual) || {};

    function rankShare(pickVal, totalVal) {
      if (!gntaKey) return { rank: null, share: null };
      const entries = [];
      for (const [name, d] of Object.entries(tJson.countries)) {
        if (!validNames.has(name)) continue;
        const val = pickVal(d) || 0;
        if (val > 0) entries.push({ name, val });
      }
      entries.sort((a, b) => b.val - a.val);
      const idx = entries.findIndex(e => e.name === gntaKey);
      const rank = idx >= 0 ? idx + 1 : null;
      const ownVal = pickVal(countryData) || 0;
      const share = totalVal && totalVal > 0 ? (ownVal / totalVal) * 100 : null;
      return { rank, share };
    }

    const out = [];
    const seen = new Set();
    for (const p of points) {
      if (seen.has(p.year)) continue;
      seen.add(p.year);
      if (allYears.includes(p.year)) {
        const val = annual[p.year] || 0;
        const prev = annual[p.year - 1] || 0;
        const pct = prev > 0 ? ((val - prev) / prev * 100) : (val > 0 ? 100 : 0);
        const rs = val > 0
          ? rankShare(d => (d.annual && d.annual[p.year]) || 0, annualTotals[p.year])
          : { rank: null, share: null };
        out.push({ year: p.year, label: String(p.year), isCurrent: false, visitors: val, changePct: pct, rank: rs.rank, share: rs.share, total: annualTotals[p.year] || null });
      } else if (p.year > lastAnnual && tJson.currentPeriod) {
        const m = /(\d{4})/.exec(tJson.currentPeriod.label || '');
        if (!m || Number(m[1]) !== p.year) continue; // no published period for this year
        const cur = (countryData && countryData.current) || 0;
        const cmp = (countryData && countryData.compare) || 0;
        const pct = cmp > 0 ? ((cur - cmp) / cmp * 100) : (cur > 0 ? 100 : 0);
        const rs = cur > 0
          ? rankShare(d => d.current || 0, tJson.totals ? tJson.totals.current : null)
          : { rank: null, share: null };
        out.push({ year: p.year, label: tJson.currentPeriod.label, isCurrent: true, visitors: cur, changePct: pct, rank: rs.rank, share: rs.share, total: (tJson.totals && tJson.totals.current) || null });
      }
      // Years before the first annual year (2011) are dropped.
    }
    return out;
  }

  // ── Generate ───────────────────────────────────────────────────────────

  generateBtn.addEventListener('click', () => {
    if (generateBtn.disabled) return;
    generateComparison();
  });

  async function generateComparison() {
    if (!selectedCountry1 || !selectedCountry2 || generating) return;
    if (!latestPeriod) {
      cmpSections.classList.remove('hidden');
      cmpSummaryEl.classList.remove('hidden');
      cmpSummaryEl.innerHTML = `<div class="msg msg-error">${escapeHtml(I18n.tr('statistics.reportFailed'))}</div>`;
      return;
    }

    generating = true;
    updateGenerateState();
    cmpSections.classList.add('hidden');
    cmpLoading.classList.remove('hidden');

    const mode = periodModeSelect.value;
    const year = mode !== 'latest' ? Number(mode) : null;
    const month = mode !== 'latest' && monthSelect.value ? Number(monthSelect.value) : null;

    try {
      const pp = computePeriodPoints(mode === 'latest' ? 'latest' : 'year', latestPeriod, year, month);
      const { points, chosen, prevPeriod } = pp;

      // Totals cache: chosen/prev-period totals overlap the chart points,
      // so identical (flow, period, country) requests are fetched once.
      const totalsCache = new Map();
      function totalFor(flow, period, cid) {
        const key = `${flow}|${period.year}|${period.months ? period.months.join(',') : 'full'}|${cid}`;
        if (!totalsCache.has(key)) {
          totalsCache.set(key, fetchTradeTotal(flow, [period.year], period.months || undefined, cid));
        }
        return totalsCache.get(key);
      }

      const c1 = selectedCountry1.value;
      const c2 = selectedCountry2.value;
      const prevOrZero = (flow, cid) => prevPeriod ? totalFor(flow, prevPeriod, cid) : Promise.resolve(0);
      const chosenYearsArr = [chosen.year];
      const chosenMonthsArr = chosen.months || undefined;
      const prevYearsArr = prevPeriod ? [prevPeriod.year] : null;
      const prevMonthsArr = prevPeriod && prevPeriod.months ? prevPeriod.months : undefined;

      // Prior-period totals needed for the charts' per-point change labels:
      // the year before the window start (the first point has no in-chart
      // predecessor) and the same-months window a year before a YTD point
      // (a YTD point can't be compared against the full prior year).
      const firstPoint = points[0];
      const chainPrevPeriod = firstPoint.year - 1 >= MIN_YEAR
        ? { year: firstPoint.year - 1, months: firstPoint.months }
        : null;
      const ytdPoint = points.find(p => p.isYtd);
      const ytdPrevPeriod = ytdPoint ? { year: ytdPoint.year - 1, months: ytdPoint.months } : null;
      const chainOrNull = (flow, cid) => chainPrevPeriod ? totalFor(flow, chainPrevPeriod, cid) : Promise.resolve(null);
      const ytdOrNull = (flow, cid) => ytdPrevPeriod ? totalFor(flow, ytdPrevPeriod, cid) : Promise.resolve(null);

      // Country ranking for the chosen period (rank among all partner
      // countries, from the backend's cached all-country computation).
      // Best-effort: on failure the summary just omits the rank clauses.
      const rankingMonths = chosen.months || Array.from({ length: 12 }, (_, i) => i + 1);
      const rankingFor = (cid) => fetch(`${PROXY_API}/country-ranking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: chosen.year, months: rankingMonths, countryId: cid }),
      }).then(r => r.json()).catch(() => null);

      const [
        exp1Series, imp1Series, exp2Series, imp2Series,
        exp1Prev, imp1Prev, exp2Prev, imp2Prev,
        expHs1, expHs1Prev, reexHs1, impHs1, impHs1Prev,
        expHs2, expHs2Prev, reexHs2, impHs2, impHs2Prev,
        fdiJson, fdiSectorsJson, tourismJson,
        chainPrevExp1, chainPrevImp1, chainPrevExp2, chainPrevImp2,
        ytdPrevExp1, ytdPrevImp1, ytdPrevExp2, ytdPrevImp2,
        rankingJson1, rankingJson2,
      ] = await Promise.all([
        Promise.all(points.map(p => totalFor(10, p, c1))),
        Promise.all(points.map(p => totalFor(11, p, c1))),
        Promise.all(points.map(p => totalFor(10, p, c2))),
        Promise.all(points.map(p => totalFor(11, p, c2))),
        prevOrZero(10, c1), prevOrZero(11, c1),
        prevOrZero(10, c2), prevOrZero(11, c2),
        fetchAllTradeData(10, chosenYearsArr, chosenMonthsArr, c1),
        prevPeriod ? fetchAllTradeData(10, prevYearsArr, prevMonthsArr, c1) : Promise.resolve([]),
        fetchAllTradeData(13, chosenYearsArr, chosenMonthsArr, c1),
        fetchAllTradeData(11, chosenYearsArr, chosenMonthsArr, c1),
        prevPeriod ? fetchAllTradeData(11, prevYearsArr, prevMonthsArr, c1) : Promise.resolve([]),
        fetchAllTradeData(10, chosenYearsArr, chosenMonthsArr, c2),
        prevPeriod ? fetchAllTradeData(10, prevYearsArr, prevMonthsArr, c2) : Promise.resolve([]),
        fetchAllTradeData(13, chosenYearsArr, chosenMonthsArr, c2),
        fetchAllTradeData(11, chosenYearsArr, chosenMonthsArr, c2),
        prevPeriod ? fetchAllTradeData(11, prevYearsArr, prevMonthsArr, c2) : Promise.resolve([]),
        // FDI is best-effort: a failure hides the investments section but
        // must not fail the trade report.
        fetch(`${PROXY_API}/fdi`).then(r => r.json()).catch(() => null),
        fetch(`${PROXY_API}/fdi-sectors`).then(r => r.json()).catch(() => null),
        fetch(`${PROXY_API}/tourism`).then(r => r.json()).catch(() => null),
        chainOrNull(10, c1), chainOrNull(11, c1), chainOrNull(10, c2), chainOrNull(11, c2),
        ytdOrNull(10, c1), ytdOrNull(11, c1), ytdOrNull(10, c2), ytdOrNull(11, c2),
        rankingFor(c1), rankingFor(c2),
      ]);

      const toMln = arr => arr.map(v => v / 1000);
      const chosenIdx = points.indexOf(chosen);

      let fdi = { available: false };
      if (fdiJson && fdiJson.success) {
        fdi = {
          available: true,
          points1: buildFdiPoints(fdiJson, c1, points),
          points2: buildFdiPoints(fdiJson, c2, points),
        };
      }

      // Sector breakdown exists only from ~2020 on (admin-uploaded file):
      // keep the period columns that fall inside the chosen year window and
      // hide the tables entirely when nothing overlaps.
      let fdiSectors = { available: false };
      if (fdiSectorsJson && fdiSectorsJson.success && !fdiSectorsJson.empty) {
        const windowYears = points.map(p => p.year);
        const minY = Math.min(...windowYears);
        const maxY = Math.max(...windowYears);
        const labels = (fdiSectorsJson.years || []).filter(l => {
          const m = String(l).match(/(19|20)\d{2}/);
          return m && Number(m[0]) >= minY && Number(m[0]) <= maxY;
        });
        if (labels.length) {
          fdiSectors = {
            available: true,
            labels,
            sectorNameMap: fdiSectorsJson.sectorNameMap || {},
            c1: (fdiSectorsJson.countries && fdiSectorsJson.countries[String(c1)]) || null,
            c2: (fdiSectorsJson.countries && fdiSectorsJson.countries[String(c2)]) || null,
          };
        }
      }

      // Tourism is best-effort like FDI: a failure hides its section.
      let tourism = { available: false };
      if (tourismJson && tourismJson.success && tourismJson.countries) {
        const validNames = new Set();
        for (const c of countries) {
          const resolved = resolveGntaName(c, tourismJson.countries);
          if (resolved) validNames.add(resolved);
        }
        const key1 = resolveGntaName(selectedCountry1, tourismJson.countries);
        const key2 = resolveGntaName(selectedCountry2, tourismJson.countries);
        const tPoints1 = buildTourismPoints(tourismJson, key1, points, validNames);
        const tPoints2 = buildTourismPoints(tourismJson, key2, points, validNames);
        if (tPoints1.length) tourism = { available: true, points1: tPoints1, points2: tPoints2 };
      }

      lastResult = {
        country1: selectedCountry1,
        country2: selectedCountry2,
        points,
        chosen,
        prevPeriod,
        monthMode: !!month,
        series: {
          exp1: toMln(exp1Series), imp1: toMln(imp1Series),
          exp2: toMln(exp2Series), imp2: toMln(imp2Series),
        },
        totals: {
          c1: {
            export: exp1Series[chosenIdx] / 1000, import: imp1Series[chosenIdx] / 1000,
            exportPrev: exp1Prev / 1000, importPrev: imp1Prev / 1000,
          },
          c2: {
            export: exp2Series[chosenIdx] / 1000, import: imp2Series[chosenIdx] / 1000,
            exportPrev: exp2Prev / 1000, importPrev: imp2Prev / 1000,
          },
        },
        products: {
          export1: buildProductList(expHs1, expHs1Prev, reexHs1),
          export2: buildProductList(expHs2, expHs2Prev, reexHs2),
          import1: buildProductList(impHs1, impHs1Prev, null),
          import2: buildProductList(impHs2, impHs2Prev, null),
        },
        fdi,
        fdiSectors,
        tourism,
        chainPrev: chainPrevPeriod ? {
          exp1: chainPrevExp1 / 1000, imp1: chainPrevImp1 / 1000,
          exp2: chainPrevExp2 / 1000, imp2: chainPrevImp2 / 1000,
        } : null,
        ytdPrev: ytdPrevPeriod ? {
          exp1: ytdPrevExp1 / 1000, imp1: ytdPrevImp1 / 1000,
          exp2: ytdPrevExp2 / 1000, imp2: ytdPrevImp2 / 1000,
        } : null,
        rankings: {
          c1: (rankingJson1 && rankingJson1.success && rankingJson1.country) || null,
          c2: (rankingJson2 && rankingJson2.success && rankingJson2.country) || null,
        },
      };

      renderComparison();
    } catch (err) {
      console.error('Comparison generation error:', err);
      lastResult = null;
      cmpSections.classList.remove('hidden');
      cmpSummaryEl.classList.remove('hidden');
      cmpSummaryEl.innerHTML = `<div class="msg msg-error">${escapeHtml(I18n.tr('statistics.reportFailed'))} ${escapeHtml(err.message)}</div>`;
    } finally {
      generating = false;
      cmpLoading.classList.add('hidden');
      updateGenerateState();
    }
  }

  // ── Render (from lastResult; called on generate and language toggle) ───

  function renderComparison() {
    if (!lastResult) return;
    const isKa = reportLocale === 'ka';
    const r = lastResult;
    const name1 = isKa ? r.country1.displayLabelKa : r.country1.displayLabelEn;
    const name2 = isKa ? r.country2.displayLabelKa : r.country2.displayLabelEn;

    const labels = r.points.map(p => pointLabel(p, isKa));
    const turnover1 = r.series.exp1.map((v, i) => v + r.series.imp1[i]);
    const turnover2 = r.series.exp2.map((v, i) => v + r.series.imp2[i]);

    // Per-point change vs the comparable prior period: full-year points
    // compare against the previous chart point (same-window years), the
    // first point against the pre-window year, and a YTD point against the
    // same months of the prior year (both fetched separately). Null = no
    // comparable prior period, the label shows just the value.
    function buildChangeLabels(series, chainPrevVal, ytdPrevVal) {
      return series.map((v, i) => {
        const p = r.points[i];
        let prev = null;
        if (p.isYtd) prev = ytdPrevVal;
        else if (i === 0) prev = chainPrevVal;
        else if (!r.points[i - 1].isYtd) prev = series[i - 1];
        if (!(prev > 0)) return null;
        const pct = calcChange(v, prev);
        return `${pct > 0 ? '+' : ''}${formatChangePct(pct)}`;
      });
    }
    const cp = r.chainPrev;
    const yp = r.ytdPrev;
    const changes = {
      turnover1: buildChangeLabels(turnover1, cp ? cp.exp1 + cp.imp1 : null, yp ? yp.exp1 + yp.imp1 : null),
      turnover2: buildChangeLabels(turnover2, cp ? cp.exp2 + cp.imp2 : null, yp ? yp.exp2 + yp.imp2 : null),
      exp1: buildChangeLabels(r.series.exp1, cp ? cp.exp1 : null, yp ? yp.exp1 : null),
      exp2: buildChangeLabels(r.series.exp2, cp ? cp.exp2 : null, yp ? yp.exp2 : null),
      imp1: buildChangeLabels(r.series.imp1, cp ? cp.imp1 : null, yp ? yp.imp1 : null),
      imp2: buildChangeLabels(r.series.imp2, cp ? cp.imp2 : null, yp ? yp.imp2 : null),
    };

    // In month mode all points are the same Jan..M window — put the window
    // in the chart title once instead of repeating it on every x label.
    let titleSuffix = '';
    if (r.monthMode && r.chosen.months) {
      const m = r.chosen.months;
      const part = m.length === 1
        ? monthLabel(m[0], isKa)
        : `${monthLabel(m[0], isKa)}-${monthLabel(m[m.length - 1], isKa)}`;
      titleSuffix = ` (${part})`;
    }

    renderLineChart('turnover', turnoverChartHeader, turnoverCanvas,
      (isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover') + titleSuffix,
      labels, turnover1, turnover2, name1, name2, 'line', chartLabel, changes.turnover1, changes.turnover2);
    renderLineChart('export', exportChartHeader, exportCanvas,
      (isKa ? 'ექსპორტი' : 'Export') + titleSuffix,
      labels, r.series.exp1, r.series.exp2, name1, name2, 'line', chartLabel, changes.exp1, changes.exp2);
    renderLineChart('import', importChartHeader, importCanvas,
      (isKa ? 'იმპორტი' : 'Import') + titleSuffix,
      labels, r.series.imp1, r.series.imp2, name1, name2, 'line', chartLabel, changes.imp1, changes.imp2);

    const periodText = chosenPeriodText(r.chosen, isKa);
    const changeAvailable = !!r.prevPeriod;
    const sharedExport = sharedProductSet(r.products.export1, r.products.export2);
    const sharedImport = sharedProductSet(r.products.import1, r.products.import2);
    renderCmpSectionHeader(exportHeader1, name1, 'export', periodText);
    renderProductTable(exportTable1, r.products.export1, periodText, true, changeAvailable, sharedExport);
    renderCmpSectionHeader(exportHeader2, name2, 'export', periodText);
    renderProductTable(exportTable2, r.products.export2, periodText, true, changeAvailable, sharedExport);
    wireExpandPair(exportTable1, exportTable2);
    renderCmpSectionHeader(importHeader1, name1, 'import', periodText);
    renderProductTable(importTable1, r.products.import1, periodText, false, changeAvailable, sharedImport);
    renderCmpSectionHeader(importHeader2, name2, 'import', periodText);
    renderProductTable(importTable2, r.products.import2, periodText, false, changeAvailable, sharedImport);
    wireExpandPair(importTable1, importTable2);

    renderInvestments(name1, name2, isKa);

    renderTourismCmp(name1, name2, isKa);

    renderComparisonSummary();

    cmpSections.classList.remove('hidden');
  }

  // ── Investments (FDI) render ───────────────────────────────────────────

  function renderInvestments(name1, name2, isKa) {
    const r = lastResult;
    const f = r.fdi;
    if (!f || !f.available || !f.points1.length) {
      fdiSection.classList.add('hidden');
      return;
    }
    fdiSection.classList.remove('hidden');

    const labels = f.points1.map(p => fdiPointLabel(p, isKa));
    renderLineChart('fdi', fdiChartHeader, fdiCanvas,
      isKa ? 'პირდაპირი უცხოური ინვესტიციები, მლნ. $' : 'FDI, mln $',
      labels, f.points1.map(p => p.valueMln), f.points2.map(p => p.valueMln), name1, name2, 'bar');

    renderCmpFdiHeader(fdiHeader1, name1, isKa);
    renderCmpFdiTable(fdiTable1, f.points1, isKa);
    renderCmpFdiHeader(fdiHeader2, name2, isKa);
    renderCmpFdiTable(fdiTable2, f.points2, isKa);

    const s = r.fdiSectors;
    if (s && s.available && (s.c1 || s.c2)) {
      fdiSectorsCard.classList.remove('hidden');
      renderCmpFdiSectors(s, name1, name2, isKa);
    } else {
      fdiSectorsCard.classList.add('hidden');
    }
  }

  // ── Tourism render ─────────────────────────────────────────────────────

  function renderTourismCmp(name1, name2, isKa) {
    const t = lastResult.tourism;
    if (!t || !t.available || !t.points1.length) {
      tourismSection.classList.add('hidden');
      return;
    }
    tourismSection.classList.remove('hidden');

    const title = isKa ? 'საერთაშორისო ვიზიტორები' : 'International Visitors';
    const labels = t.points1.map(p => localizePeriodLabel(p.label, isKa));
    renderLineChart('tourism', tourismChartHeader, tourismCanvas, title,
      labels, t.points1.map(p => p.visitors), t.points2.map(p => p.visitors),
      name1, name2, 'bar', v => Number(v).toLocaleString());

    renderTourismTableCmp(t, name1, name2, isKa);
  }

  // Merged visitors table, sectors-table style: metric column groups with
  // the two countries paired inside each group. Columns: Period | total
  // visitors to Georgia | Visitors | Rank | Change % | Share %.
  function renderTourismTableCmp(t, name1, name2, isKa) {
    tourismTableHeader.innerHTML = `<h3 class="stat-report__title">${isKa ? 'ვიზიტორები' : 'Visitors'}</h3>`;

    const hPeriod = isKa ? 'პერიოდი' : 'Period';
    const hTotal = isKa ? 'სულ ვიზიტორები' : 'Total visitors';
    const hVisitors = isKa ? 'ვიზიტორები' : 'Visitors';
    const hRank = isKa ? 'ადგილი' : 'Rank';
    const hChange = isKa ? 'ცვლილება, %' : 'Change, %';
    const hShare = isKa ? 'წილი, %' : 'Share, %';
    const metricHeads = [hVisitors, hRank, hChange, hShare];
    const countryPair =
      `<th class="stat-col-value cmp-sec-a" style="color:${C1_COLOR};font-weight:600;" title="${escapeHtml(name1)}">${escapeHtml(name1.slice(0, 3))}</th>` +
      `<th class="stat-col-value cmp-sec-b" style="color:${C2_COLOR};font-weight:600;" title="${escapeHtml(name2)}">${escapeHtml(name2.slice(0, 3))}</th>`;

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th rowspan="2">${hPeriod}</th>
          <th rowspan="2" class="stat-col-value">${hTotal}</th>
          ${metricHeads.map(h => `<th class="stat-col-value" colspan="2" style="text-align:center;">${h}</th>`).join('')}
        </tr>
        <tr>${metricHeads.map(() => countryPair).join('')}</tr>
      </thead>
      <tbody>`;

    const metricCells = (p) => {
      const has = p.visitors > 0;
      const visitors = has ? Number(p.visitors).toLocaleString() : '-';
      const rank = has && p.rank ? String(p.rank) : '-';
      let change = '-';
      let changeClass = '';
      if (has && p.changePct !== null && p.changePct !== undefined) {
        changeClass = p.changePct > 0 ? 'stat-positive' : (p.changePct < 0 ? 'stat-negative' : '');
        change = `${p.changePct > 0 ? '+' : ''}${formatChangePct(p.changePct)}`;
      }
      const share = has && p.share != null ? `${p.share.toFixed(1)}%` : '-';
      return { visitors, rank, change, changeClass, share };
    };

    const rows1 = [...t.points1].reverse();
    const rows2 = [...t.points2].reverse();
    rows1.forEach((p1, i) => {
      const m1 = metricCells(p1);
      const m2 = metricCells(rows2[i]);
      const totalCell = p1.total > 0 ? Number(p1.total).toLocaleString() : '-';
      html += `<tr>
        <td>${escapeHtml(localizePeriodLabel(p1.label, isKa))}</td>
        <td class="stat-col-value">${totalCell}</td>
        <td class="stat-col-value cmp-sec-a">${m1.visitors}</td><td class="stat-col-value cmp-sec-b">${m2.visitors}</td>
        <td class="stat-col-value cmp-sec-a">${m1.rank}</td><td class="stat-col-value cmp-sec-b">${m2.rank}</td>
        <td class="stat-col-value cmp-sec-a ${m1.changeClass}">${m1.change}</td><td class="stat-col-value cmp-sec-b ${m2.changeClass}">${m2.change}</td>
        <td class="stat-col-value cmp-sec-a">${m1.share}</td><td class="stat-col-value cmp-sec-b">${m2.share}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    tourismTable.innerHTML = html;
  }

  function renderCmpFdiHeader(el, countryName, isKa) {
    const t = `${countryName} - ${isKa ? 'პირდაპირი უცხოური ინვესტიციები' : 'Foreign Direct Investment'}`;
    el.innerHTML = `<h3 class="stat-report__title">${escapeHtml(t)}</h3>`;
  }

  // Copied from statistics.js:2732 (renderFdiTable), parameterised: rows
  // come from buildFdiPoints and the period label is locale-built.
  function renderCmpFdiTable(el, points, isKa) {
    const data = [...points].reverse();
    const hYear = isKa ? 'წელი' : 'Year';
    const hTotal = isKa ? 'სულ FDI, მლნ. $' : 'Total FDI, mln $';
    const hRank = isKa ? 'ადგილი' : 'Rank';
    const hValue = isKa ? 'მოცულობა, მლნ. $' : 'Volume, mln $';
    const hChange = isKa ? 'ცვლილება, %' : 'Change, %';
    const hShare = isKa ? 'წილი, %' : 'Share, %';

    const showRank = data.some(p => p.valueMln > 0 && p.rank);

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th>${hYear}</th>
          <th class="stat-col-value">${hTotal}</th>
          ${showRank ? `<th class="stat-col-change">${hRank}</th>` : ''}
          <th class="stat-col-value">${hValue}</th>
          <th class="stat-col-change">${hChange}</th>
          <th class="stat-col-change">${hShare}</th>
        </tr>
      </thead>
      <tbody>`;

    for (const p of data) {
      const isCurNeg = !(p.valueMln > 0);
      const isPrevNeg = !(p.prevMln > 0);
      const valueCell = isCurNeg ? '-' : formatMln(p.valueMln);
      let changeCell = '-';
      let changeClass = '';
      if (!isCurNeg && !isPrevNeg) {
        const pct = ((p.valueMln - p.prevMln) / p.prevMln) * 100;
        changeClass = pct > 0 ? 'stat-positive' : (pct < 0 ? 'stat-negative' : '');
        const sign = pct > 0 ? '+' : '';
        changeCell = `${sign}${formatChangePct(pct)}`;
      }
      const rankCell = (!isCurNeg && p.rank) ? String(p.rank) : '-';
      const shareCell = (!isCurNeg && p.share != null) ? `${(Math.round(p.share * 10) / 10).toFixed(1)}%` : '-';
      // Total FDI into Georgia for the period; a negative grand total
      // (net disinvestment) is shown signed rather than hidden.
      const totalCell = p.totalMln
        ? (p.totalMln < 0 ? `-${formatMln(Math.abs(p.totalMln))}` : formatMln(p.totalMln))
        : '-';
      html += `
        <tr>
          <td>${escapeHtml(fdiPointLabel(p, isKa))}</td>
          <td class="stat-col-value">${totalCell}</td>
          ${showRank ? `<td class="stat-col-change">${rankCell}</td>` : ''}
          <td class="stat-col-value">${valueCell}</td>
          <td class="stat-col-change ${changeClass}">${changeCell}</td>
          <td class="stat-col-change">${shareCell}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    el.innerHTML = html;
  }

  // Merged sectors table for both countries — adapted from
  // statistics.js:2459 (renderFdiSectorsTable). Two-row header: each
  // window-filtered period label spans two country sub-columns, colored
  // with the chart palette so columns match the lines in the charts.
  function renderCmpFdiSectors(state, name1, name2, isKa) {
    const labels = state.labels;
    const yrRange = labels.length > 1 ? `${labels[0]}–${labels[labels.length - 1]}` : `${labels[0]}`;
    const title = isKa
      ? `ინვესტიციები სექტორების მიხედვით, ${yrRange}`
      : `FDI by Sector, ${yrRange}`;
    fdiSectorsHeader.innerHTML = `<h3 class="stat-report__title">${escapeHtml(title)}</h3><div style="font-size:0.85rem;color:var(--text-secondary);">${isKa ? 'მლნ. აშშ დოლარი' : 'mln USD'}</div>`;

    const fmt = (v) => {
      if (v === null || v === undefined || v === 0) return '-';
      const sign = v < 0 ? '-' : '';
      const abs = Math.abs(v);
      const str = abs >= 100 ? abs.toFixed(1) : abs.toFixed(2);
      return sign + str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    };
    const cellCls = (v) => (v === null || v === undefined || v === 0) ? '' : (v < 0 ? 'stat-negative' : '');

    const sectorHeader = isKa ? 'სექტორი' : 'Sector';
    const totalLabel = isKa ? 'სულ' : 'Total';
    const c1 = state.c1;
    const c2 = state.c2;

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th rowspan="2">${sectorHeader}</th>
          ${labels.map(y => `<th class="stat-col-value" colspan="2" style="text-align:center;">${escapeHtml(String(y))}</th>`).join('')}
        </tr>
        <tr>
          ${labels.map(() =>
            `<th class="stat-col-value cmp-sec-a" style="color:${C1_COLOR};font-weight:600;" title="${escapeHtml(name1)}">${escapeHtml(name1.slice(0, 3))}</th>` +
            `<th class="stat-col-value cmp-sec-b" style="color:${C2_COLOR};font-weight:600;" title="${escapeHtml(name2)}">${escapeHtml(name2.slice(0, 3))}</th>`
          ).join('')}
        </tr>
      </thead>
      <tbody>`;

    // Totals row first (bold).
    html += `<tr><td style="font-weight:700;">${totalLabel}</td>`;
    for (const y of labels) {
      html += `<td class="stat-col-value cmp-sec-a ${cellCls(c1 && c1.totals ? c1.totals[y] : null)}" style="font-weight:700;">${fmt(c1 && c1.totals ? c1.totals[y] : null)}</td>`;
      html += `<td class="stat-col-value cmp-sec-b ${cellCls(c2 && c2.totals ? c2.totals[y] : null)}" style="font-weight:700;">${fmt(c2 && c2.totals ? c2.totals[y] : null)}</td>`;
    }
    html += `</tr>`;

    // Union of both countries' sectors, sorted by combined value at the
    // latest shown period; a country with no entry renders "-" throughout.
    const sectorNames = [...new Set([
      ...Object.keys((c1 && c1.sectors) || {}),
      ...Object.keys((c2 && c2.sectors) || {}),
    ])];
    const sortLabel = labels[labels.length - 1];
    const sortVal = (cs, s) => (cs && cs.sectors && cs.sectors[s] && cs.sectors[s][sortLabel]) || 0;
    sectorNames.sort((a, b) =>
      (sortVal(c1, b) + sortVal(c2, b)) - (sortVal(c1, a) + sortVal(c2, a)));

    for (const sector of sectorNames) {
      const displayName = isKa ? sector : (state.sectorNameMap[sector] || sector);
      html += `<tr><td>${escapeHtml(displayName)}</td>`;
      for (const y of labels) {
        const v1 = (c1 && c1.sectors && c1.sectors[sector]) ? c1.sectors[sector][y] : null;
        const v2 = (c2 && c2.sectors && c2.sectors[sector]) ? c2.sectors[sector][y] : null;
        html += `<td class="stat-col-value cmp-sec-a ${cellCls(v1)}">${fmt(v1)}</td>`;
        html += `<td class="stat-col-value cmp-sec-b ${cellCls(v2)}">${fmt(v2)}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    fdiSectorsTable.innerHTML = html;
  }

  // ── Line charts ────────────────────────────────────────────────────────

  function renderLineChart(key, headerEl, canvas, title, labels, series1, series2, name1, name2, chartType = 'line', valueFormatter = chartLabel, changes1 = null, changes2 = null) {
    headerEl.innerHTML = `
      <div class="stat-chart-title-row">
        <h3 class="stat-report__title">${escapeHtml(title)}</h3>
        <div class="stat-chart-legend">
          <div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:${C1_COLOR}"></span>${escapeHtml(name1)}</div>
          <div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:${C2_COLOR}"></span>${escapeHtml(name2)}</div>
        </div>
      </div>`;

    if (chartInstances[key]) {
      chartInstances[key].destroy();
      chartInstances[key] = null;
    }

    const isBar = chartType === 'bar';
    const makeDataset = (name, data, color, otherData, isFirst) => isBar
      ? {
          label: name,
          data,
          backgroundColor: color,
          borderRadius: 3,
          datalabels: { anchor: 'end', align: 'end', color },
        }
      : {
          label: name,
          data,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: color,
          tension: 0.3,
          // Side picked per point, so the two series' labels never share
          // the gap between the lines.
          datalabels: { align: pairedLabelAlign(data, otherData, isFirst), color },
        };

    chartInstances[key] = new Chart(canvas, {
      type: chartType,
      data: {
        labels,
        datasets: [
          makeDataset(name1, series1, C1_COLOR, isBar ? null : series2, true),
          makeDataset(name2, series2, C2_COLOR, isBar ? null : series1, false),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 24, bottom: isBar ? 8 : 30, left: 40, right: 40 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          datalabels: {
            font: { size: 11, weight: '600' },
            clamp: true,
            textAlign: 'center',
            // Last resort for labels the per-point placement cannot pull
            // apart (neighbouring points on a narrow chart): the plugin
            // hides the lower-priority one, keeping the most recent
            // periods — it ranks by data index descending.
            display: 'auto',
            // Second label line = change vs the comparable prior period,
            // when the caller provides per-point change arrays; dropped
            // when the points sit too close together for two text lines.
            formatter: pointLabelFormatter(valueFormatter, [changes1, changes2]),
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { font: { size: 11 } },
          },
          y: {
            display: false,
            grid: { display: false },
            beginAtZero: true,
            // Lift a floor-hugging series off the chart bottom so its
            // below-point labels have room inside the plot area.
            grace: isBar ? 0 : '18%',
          },
        },
      },
      plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
    });
  }

  // ── Summary overview ───────────────────────────────────────────────────

  function renderComparisonSummary() {
    const r = lastResult;
    const isKa = reportLocale === 'ka';
    const name1 = isKa ? r.country1.displayLabelKa : r.country1.displayLabelEn;
    const name2 = isKa ? r.country2.displayLabelKa : r.country2.displayLabelEn;
    const g1 = grammarFor(r.country1.displayLabelKa);
    const g2 = grammarFor(r.country2.displayLabelKa);
    const prose = chosenPeriodProse(r.chosen, isKa);
    const mln = isKa ? 'მლნ. აშშ დოლარი' : 'mln USD';

    // Country names, metric labels and every figure are bolded so they
    // stand out from the surrounding prose. b() escapes its argument, so
    // it replaces escapeHtml() at those call sites.
    const b = (x) => `<strong>${escapeHtml(String(x))}</strong>`;

    const t = r.totals;
    const metrics = {
      turnover: {
        v1: t.c1.export + t.c1.import, p1: t.c1.exportPrev + t.c1.importPrev,
        v2: t.c2.export + t.c2.import, p2: t.c2.exportPrev + t.c2.importPrev,
      },
      export: { v1: t.c1.export, p1: t.c1.exportPrev, v2: t.c2.export, p2: t.c2.exportPrev },
      import: { v1: t.c1.import, p1: t.c1.importPrev, v2: t.c2.import, p2: t.c2.importPrev },
    };

    // "( +12%, rank 5 )" clause: change vs the same period a year earlier
    // (when a prior period exists) plus the country's rank among Georgia's
    // partners for the chosen period (when the ranking endpoint delivered).
    function rankOf(which, metricKey) {
      const rk = r.rankings && r.rankings[which];
      return (rk && rk[metricKey] && rk[metricKey].rank) || null;
    }
    function changeClause(v, p, rank) {
      const parts = [];
      if (r.prevPeriod && p >= INSIGNIFICANT_MLN) {
        const pct = calcChange(v, p);
        parts.push(b(`${pct > 0 ? '+' : ''}${formatChangePct(pct)}`));
      }
      if (v >= INSIGNIFICANT_MLN && rank) {
        parts.push(isKa ? `ადგილი: ${b(rank)}` : `rank ${b(rank)}`);
      }
      return parts.length ? ` (${parts.join(', ')})` : '';
    }

    // Sentence comparing the two values: times / percent / roughly equal.
    function compareSentence(metricKey, v1, v2) {
      if (v1 < INSIGNIFICANT_MLN && v2 < INSIGNIFICANT_MLN) return '';
      const subject = {
        turnover: isKa ? 'ბრუნვა' : 'turnover',
        export: isKa ? 'ექსპორტი' : 'exports',
        import: isKa ? 'იმპორტი' : 'imports',
        fdi: isKa ? 'ინვესტიციები' : 'FDI',
        tourism: isKa ? 'ვიზიტორები' : 'visitor numbers',
      }[metricKey];
      const [bigName, big, smallName, small, bigGen, smallGen] = v1 >= v2
        ? [name1, v1, name2, v2, g1.of, g2.of]
        : [name2, v2, name1, v1, g2.of, g1.of];
      if (small < INSIGNIFICANT_MLN) {
        return isKa
          ? ` ${b(smallGen)} შემთხვევაში ${b(subject)} უმნიშვნელოა.`
          : ` For ${b(smallName)}, ${b(subject)} ${['turnover', 'fdi'].includes(metricKey) ? 'was' : 'were'} negligible.`;
      }
      const ratio = big / small;
      if (Math.abs(v1 - v2) / Math.max(v1, v2) <= 0.01) {
        return isKa
          ? ` ორი ქვეყნის მაჩვენებლები თითქმის თანაბარია.`
          : ` The two countries' figures are roughly equal.`;
      }
      if (ratio >= 2) {
        const times = ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, '');
        return isKa
          ? ` ${b(bigGen)} მაჩვენებელი დაახლოებით ${b(`${times}-ჯერ`)} აღემატება ${b(smallGen)} მაჩვენებელს.`
          : ` The figure for ${b(bigName)} is about ${b(`${times} times`)} higher than for ${b(smallName)}.`;
      }
      const pctMore = Math.round((ratio - 1) * 100);
      return isKa
        ? ` ${b(bigGen)} მაჩვენებელი დაახლოებით ${b(`${pctMore}%-ით`)} აღემატება ${b(smallGen)} მაჩვენებელს.`
        : ` The figure for ${b(bigName)} is about ${b(`${pctMore}%`)} higher than for ${b(smallName)}.`;
    }

    function valuePhrase(v) {
      if (v < INSIGNIFICANT_MLN) {
        return isKa ? 'შეადგინა უმნიშვნელო ოდენობა' : 'was negligible';
      }
      return isKa ? `შეადგინა ${b(`${formatMln2(v)} ${mln}`)}` : `amounted to ${b(`${formatMln2(v)} ${mln}`)}`;
    }

    const m = metrics;
    const lines = [];

    // Turnover
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} საქართველოს ${b('სავაჭრო ბრუნვამ')} ${b(g1.withCase)} ${valuePhrase(m.turnover.v1)}${changeClause(m.turnover.v1, m.turnover.p1, rankOf('c1', 'turnover'))}, ხოლო ${b(g2.withCase)} ${valuePhrase(m.turnover.v2)}${changeClause(m.turnover.v2, m.turnover.p2, rankOf('c2', 'turnover'))}.`
        : `${prose}, Georgia's ${b('trade turnover')} with ${b(name1)} ${valuePhrase(m.turnover.v1)}${changeClause(m.turnover.v1, m.turnover.p1, rankOf('c1', 'turnover'))}, while ${b('turnover')} with ${b(name2)} ${valuePhrase(m.turnover.v2)}${changeClause(m.turnover.v2, m.turnover.p2, rankOf('c2', 'turnover'))}.`
    }${compareSentence('turnover', m.turnover.v1, m.turnover.v2)}</p>`);

    // Export
    lines.push('<hr class="stat-summary__divider">');
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'ექსპორტი' : 'Export'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} საქართველოდან ${b('ექსპორტმა')} ${b(g1.inCase)} ${valuePhrase(m.export.v1)}${changeClause(m.export.v1, m.export.p1, rankOf('c1', 'export'))}, ხოლო ${b(g2.inCase)} ${valuePhrase(m.export.v2)}${changeClause(m.export.v2, m.export.p2, rankOf('c2', 'export'))}.`
        : `${prose}, Georgia's ${b('exports')} to ${b(name1)} ${valuePhrase(m.export.v1)}${changeClause(m.export.v1, m.export.p1, rankOf('c1', 'export'))}, while ${b('exports')} to ${b(name2)} ${valuePhrase(m.export.v2)}${changeClause(m.export.v2, m.export.p2, rankOf('c2', 'export'))}.`
    }${compareSentence('export', m.export.v1, m.export.v2)}</p>`);

    // Import
    lines.push('<hr class="stat-summary__divider">');
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'იმპორტი' : 'Import'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} ${b('იმპორტმა')} ${b(g1.from)} ${valuePhrase(m.import.v1)}${changeClause(m.import.v1, m.import.p1, rankOf('c1', 'import'))}, ხოლო ${b(g2.from)} ${valuePhrase(m.import.v2)}${changeClause(m.import.v2, m.import.p2, rankOf('c2', 'import'))}.`
        : `${prose}, Georgia's ${b('imports')} from ${b(name1)} ${valuePhrase(m.import.v1)}${changeClause(m.import.v1, m.import.p1, rankOf('c1', 'import'))}, while ${b('imports')} from ${b(name2)} ${valuePhrase(m.import.v2)}${changeClause(m.import.v2, m.import.p2, rankOf('c2', 'import'))}.`
    }${compareSentence('import', m.import.v1, m.import.v2)}</p>`);

    // Investments — based on the FDI point for the chosen year (annual when
    // closed, quarterly YTD for the current year, else the latest point in
    // the window). Skipped entirely when the FDI fetch failed.
    if (r.fdi && r.fdi.available && r.fdi.points1.length) {
      const pts1 = r.fdi.points1;
      const pts2 = r.fdi.points2;
      let idx = pts1.findIndex(p => p.year === r.chosen.year);
      if (idx < 0) idx = pts1.length - 1;
      const f1 = pts1[idx];
      const f2 = pts2[idx];
      const fdiProse = fdiPeriodProse(f1, isKa);

      // "(+12%, rank 5)" — change only when the prior year had investment.
      function fdiExtras(p) {
        const parts = [];
        if (p.prevMln > 0 && p.valueMln > 0) {
          const pct = calcChange(p.valueMln, p.prevMln);
          parts.push(b(`${pct > 0 ? '+' : ''}${formatChangePct(pct)}`));
        }
        if (p.valueMln > 0 && p.rank) {
          parts.push(isKa ? `ადგილი: ${b(p.rank)}` : `rank ${b(p.rank)}`);
        }
        return parts.length ? ` (${parts.join(', ')})` : '';
      }

      // Per-country clause; negative/zero FDI reads as "no investment".
      function fdiFragment(g, name, p) {
        if (!(p.valueMln > 0)) {
          return isKa
            ? `${b(g.from)} ინვესტიცია არ ფიქსირდება`
            : `no investment was recorded from ${b(name)}`;
        }
        return isKa
          ? `${b(g.from)} შემოსულმა ${b('ინვესტიციებმა')} შეადგინა ${b(`${formatMln2(p.valueMln)} ${mln}`)}${fdiExtras(p)}`
          : `${b('FDI')} from ${b(name)} amounted to ${b(`${formatMln2(p.valueMln)} ${mln}`)}${fdiExtras(p)}`;
      }

      lines.push('<hr class="stat-summary__divider">');
      lines.push(`<h4 class="stat-summary__heading">${isKa ? 'ინვესტიციები' : 'Investments'}</h4>`);
      lines.push(`<p>${
        isKa
          ? `${fdiProse} ${fdiFragment(g1, name1, f1)}, ხოლო ${fdiFragment(g2, name2, f2)}.`
          : `${fdiProse}, ${fdiFragment(g1, name1, f1)}, while ${fdiFragment(g2, name2, f2)}.`
      }${(f1.valueMln > 0 && f2.valueMln > 0) ? compareSentence('fdi', f1.valueMln, f2.valueMln) : ''}</p>`);
    }

    // Tourism — based on the visitor point for the chosen year (annual when
    // covered, current YTD for the current year, else the latest point in
    // the window). Skipped entirely when the tourism fetch failed.
    if (r.tourism && r.tourism.available && r.tourism.points1.length) {
      const pts1 = r.tourism.points1;
      const pts2 = r.tourism.points2;
      let tIdx = pts1.findIndex(p => p.year === r.chosen.year);
      if (tIdx < 0) tIdx = pts1.length - 1;
      const t1 = pts1[tIdx];
      const t2 = pts2[tIdx];
      const tProse = tourismPeriodProse(t1, isKa);

      function tourismExtras(p) {
        const parts = [];
        if (p.visitors > 0 && p.changePct !== null && p.changePct !== undefined) {
          parts.push(b(`${p.changePct > 0 ? '+' : ''}${formatChangePct(p.changePct)}`));
        }
        if (p.visitors > 0 && p.rank) {
          parts.push(isKa ? `ადგილი: ${b(p.rank)}` : `rank ${b(p.rank)}`);
        }
        return parts.length ? ` (${parts.join(', ')})` : '';
      }

      function tourismFragment(g, name, p) {
        if (!(p.visitors > 0)) {
          return isKa
            ? `${b(g.from)} ვიზიტორები არ ფიქსირდება`
            : `no visitors were recorded from ${b(name)}`;
        }
        return isKa
          ? `${b(g.from)} საქართველოში განხორციელდა ${b(`${Number(p.visitors).toLocaleString()} ვიზიტი`)}${tourismExtras(p)}`
          : `${b(`${Number(p.visitors).toLocaleString()} visits`)} were made from ${b(name)} to Georgia${tourismExtras(p)}`;
      }

      lines.push('<hr class="stat-summary__divider">');
      lines.push(`<h4 class="stat-summary__heading">${isKa ? 'ტურიზმი' : 'Tourism'}</h4>`);
      lines.push(`<p>${
        isKa
          ? `${tProse} ${tourismFragment(g1, name1, t1)}, ხოლო ${tourismFragment(g2, name2, t2)}.`
          : `${tProse}, ${tourismFragment(g1, name1, t1)}, while ${tourismFragment(g2, name2, t2)}.`
      }${(t1.visitors > 0 && t2.visitors > 0) ? compareSentence('tourism', t1.visitors, t2.visitors) : ''}</p>`);
    }

    cmpSummaryEl.innerHTML = lines.join('');
    cmpSummaryEl.classList.remove('hidden');
  }

  // ── Initial UI state ───────────────────────────────────────────────────
  applyReportLocale();
})();
