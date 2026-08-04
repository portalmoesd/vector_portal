/**
 * Country Comparison Page (admin-only)
 * Compares trade statistics (turnover / export / import + top products)
 * of two countries for a chosen period, using data from
 * ex-trade-api.geostat.ge.
 *
 * Calls the Geostat API directly from the browser.
 * Falls back to our backend proxy (/api/statistics/) if direct calls fail.
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  // App.init() already redirects non-admins; this is belt-and-braces so the
  // page logic never runs for anyone else.
  if (!user || user.role !== 'ADMIN') return;

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
  const reportLangToggle = document.getElementById('reportLangToggle');

  // ── State ──────────────────────────────────────────────────────────────
  let countries = [];
  let classData = null;
  let selectedCountry1 = null;
  let selectedCountry2 = null;
  let useProxy = false;
  let lastResult = null; // everything needed to re-render on language toggle
  let generating = false;
  const chartInstances = { turnover: null, export: null, import: null };

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

  function renderProductTable(el, products, periodText, showReexport, changeAvailable) {
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
      html += `
        <tr${hiddenStyle}>
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

    const btn = el.querySelector('.stat-expand-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const rows = el.querySelectorAll('tr[data-expandable]');
        const expanded = rows[0]?.style.display !== 'none';
        rows.forEach(r => r.style.display = expanded ? 'none' : '');
        btn.textContent = expanded ? btn.dataset.more : btn.dataset.less;
      });
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

      const [
        exp1Series, imp1Series, exp2Series, imp2Series,
        exp1Prev, imp1Prev, exp2Prev, imp2Prev,
        expHs1, expHs1Prev, reexHs1, impHs1, impHs1Prev,
        expHs2, expHs2Prev, reexHs2, impHs2, impHs2Prev,
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
      ]);

      const toMln = arr => arr.map(v => v / 1000);
      const chosenIdx = points.indexOf(chosen);

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
      labels, turnover1, turnover2, name1, name2);
    renderLineChart('export', exportChartHeader, exportCanvas,
      (isKa ? 'ექსპორტი' : 'Export') + titleSuffix,
      labels, r.series.exp1, r.series.exp2, name1, name2);
    renderLineChart('import', importChartHeader, importCanvas,
      (isKa ? 'იმპორტი' : 'Import') + titleSuffix,
      labels, r.series.imp1, r.series.imp2, name1, name2);

    const periodText = chosenPeriodText(r.chosen, isKa);
    const changeAvailable = !!r.prevPeriod;
    renderCmpSectionHeader(exportHeader1, name1, 'export', periodText);
    renderProductTable(exportTable1, r.products.export1, periodText, true, changeAvailable);
    renderCmpSectionHeader(exportHeader2, name2, 'export', periodText);
    renderProductTable(exportTable2, r.products.export2, periodText, true, changeAvailable);
    renderCmpSectionHeader(importHeader1, name1, 'import', periodText);
    renderProductTable(importTable1, r.products.import1, periodText, false, changeAvailable);
    renderCmpSectionHeader(importHeader2, name2, 'import', periodText);
    renderProductTable(importTable2, r.products.import2, periodText, false, changeAvailable);

    renderComparisonSummary();

    cmpSections.classList.remove('hidden');
  }

  // ── Line charts ────────────────────────────────────────────────────────

  function renderLineChart(key, headerEl, canvas, title, labels, series1, series2, name1, name2) {
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

    chartInstances[key] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: name1,
            data: series1,
            borderColor: C1_COLOR,
            backgroundColor: C1_COLOR,
            borderWidth: 2.5,
            pointRadius: 4,
            pointBackgroundColor: C1_COLOR,
            tension: 0.3,
            datalabels: { align: 'top', color: C1_COLOR },
          },
          {
            label: name2,
            data: series2,
            borderColor: C2_COLOR,
            backgroundColor: C2_COLOR,
            borderWidth: 2.5,
            pointRadius: 4,
            pointBackgroundColor: C2_COLOR,
            tension: 0.3,
            datalabels: { align: 'bottom', color: C2_COLOR },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 24, bottom: 8, left: 40, right: 40 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          datalabels: {
            font: { size: 11, weight: '600' },
            clamp: true,
            formatter: (v) => chartLabel(v),
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

    const t = r.totals;
    const metrics = {
      turnover: {
        v1: t.c1.export + t.c1.import, p1: t.c1.exportPrev + t.c1.importPrev,
        v2: t.c2.export + t.c2.import, p2: t.c2.exportPrev + t.c2.importPrev,
      },
      export: { v1: t.c1.export, p1: t.c1.exportPrev, v2: t.c2.export, p2: t.c2.exportPrev },
      import: { v1: t.c1.import, p1: t.c1.importPrev, v2: t.c2.import, p2: t.c2.importPrev },
    };

    // "(+12%)" clause vs the same period a year earlier; empty when there is
    // no prior period or no prior trade to compare against.
    function changeClause(v, p) {
      if (!r.prevPeriod || p < INSIGNIFICANT_MLN) return '';
      const pct = calcChange(v, p);
      const sign = pct > 0 ? '+' : '';
      return ` (${sign}${formatChangePct(pct)})`;
    }

    // Sentence comparing the two values: times / percent / roughly equal.
    function compareSentence(metricKey, v1, v2) {
      if (v1 < INSIGNIFICANT_MLN && v2 < INSIGNIFICANT_MLN) return '';
      const subject = {
        turnover: isKa ? 'ბრუნვა' : 'turnover',
        export: isKa ? 'ექსპორტი' : 'exports',
        import: isKa ? 'იმპორტი' : 'imports',
      }[metricKey];
      const [bigName, big, smallName, small, bigGen, smallGen] = v1 >= v2
        ? [name1, v1, name2, v2, g1.of, g2.of]
        : [name2, v2, name1, v1, g2.of, g1.of];
      if (small < INSIGNIFICANT_MLN) {
        return isKa
          ? ` ${escapeHtml(smallGen)} შემთხვევაში ${subject} უმნიშვნელოა.`
          : ` For ${escapeHtml(smallName)}, ${subject} ${metricKey === 'turnover' ? 'was' : 'were'} negligible.`;
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
          ? ` ${escapeHtml(bigGen)} მაჩვენებელი დაახლოებით ${times}-ჯერ აღემატება ${escapeHtml(smallGen)} მაჩვენებელს.`
          : ` The figure for ${escapeHtml(bigName)} is about ${times} times higher than for ${escapeHtml(smallName)}.`;
      }
      const pctMore = Math.round((ratio - 1) * 100);
      return isKa
        ? ` ${escapeHtml(bigGen)} მაჩვენებელი დაახლოებით ${pctMore}%-ით აღემატება ${escapeHtml(smallGen)} მაჩვენებელს.`
        : ` The figure for ${escapeHtml(bigName)} is about ${pctMore}% higher than for ${escapeHtml(smallName)}.`;
    }

    function valuePhrase(v) {
      if (v < INSIGNIFICANT_MLN) {
        return isKa ? 'შეადგინა უმნიშვნელო ოდენობა' : 'was negligible';
      }
      return isKa ? `შეადგინა ${formatMln2(v)} ${mln}` : `amounted to ${formatMln2(v)} ${mln}`;
    }

    const m = metrics;
    const lines = [];

    // Turnover
    lines.push(`<h4>${isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} საქართველოს სავაჭრო ბრუნვამ ${escapeHtml(g1.withCase)} ${valuePhrase(m.turnover.v1)}${changeClause(m.turnover.v1, m.turnover.p1)}, ხოლო ${escapeHtml(g2.withCase)} ${valuePhrase(m.turnover.v2)}${changeClause(m.turnover.v2, m.turnover.p2)}.`
        : `${prose}, Georgia's trade turnover with ${escapeHtml(name1)} ${valuePhrase(m.turnover.v1)}${changeClause(m.turnover.v1, m.turnover.p1)}, while turnover with ${escapeHtml(name2)} ${valuePhrase(m.turnover.v2)}${changeClause(m.turnover.v2, m.turnover.p2)}.`
    }${compareSentence('turnover', m.turnover.v1, m.turnover.v2)}</p>`);

    // Export
    lines.push('<hr />');
    lines.push(`<h4>${isKa ? 'ექსპორტი' : 'Export'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} საქართველოდან ექსპორტმა ${escapeHtml(g1.inCase)} ${valuePhrase(m.export.v1)}${changeClause(m.export.v1, m.export.p1)}, ხოლო ${escapeHtml(g2.inCase)} ${valuePhrase(m.export.v2)}${changeClause(m.export.v2, m.export.p2)}.`
        : `${prose}, Georgia's exports to ${escapeHtml(name1)} ${valuePhrase(m.export.v1)}${changeClause(m.export.v1, m.export.p1)}, while exports to ${escapeHtml(name2)} ${valuePhrase(m.export.v2)}${changeClause(m.export.v2, m.export.p2)}.`
    }${compareSentence('export', m.export.v1, m.export.v2)}</p>`);

    // Import
    lines.push('<hr />');
    lines.push(`<h4>${isKa ? 'იმპორტი' : 'Import'}</h4>`);
    lines.push(`<p>${
      isKa
        ? `${prose} იმპორტმა ${escapeHtml(g1.from)} ${valuePhrase(m.import.v1)}${changeClause(m.import.v1, m.import.p1)}, ხოლო ${escapeHtml(g2.from)} ${valuePhrase(m.import.v2)}${changeClause(m.import.v2, m.import.p2)}.`
        : `${prose}, Georgia's imports from ${escapeHtml(name1)} ${valuePhrase(m.import.v1)}${changeClause(m.import.v1, m.import.p1)}, while imports from ${escapeHtml(name2)} ${valuePhrase(m.import.v2)}${changeClause(m.import.v2, m.import.p2)}.`
    }${compareSentence('import', m.import.v1, m.import.v2)}</p>`);

    cmpSummaryEl.innerHTML = lines.join('');
    cmpSummaryEl.classList.remove('hidden');
  }

  // ── Initial UI state ───────────────────────────────────────────────────
  applyReportLocale();
})();
