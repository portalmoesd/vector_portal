/**
 * Products Page
 * Product-centric trade statistics: search a product by name or 4-digit
 * HS code and see Georgia's trade in it — rank among products, export
 * with the domestic-export / re-export split, import, dynamics charts
 * and top partner countries. Period: a year with a 5-year window, or a
 * comparison of two chosen years. Data from ex-trade-api.geostat.ge.
 *
 * Calls the Geostat API directly from the browser.
 * Falls back to our backend proxy (/api/statistics/) if direct calls fail.
 */
(async function () {
  // ── Synchronous pre-localization ─────────────────────────────────────
  // Set static labels from the localStorage locales BEFORE the async init
  // so a Georgian UI doesn't flash the English fallback text. The later
  // applyReportLocale pass re-applies identical strings.
  {
    const earlySite = localStorage.getItem('locale') || 'ka';
    const early = localStorage.getItem('statReportLocale') || earlySite;
    const ka = early === 'ka';
    const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('pageTitle', ka ? 'პროდუქტები' : 'Products');
    setText('productLabel', ka ? 'პროდუქტი' : 'Product');
    setText('yearLabel', ka ? 'წელი' : 'Year');
    setText('periodLabel', ka ? 'პერიოდი' : 'Period');
    setText('flowLabel', ka ? 'მიმართულება' : 'Flow');
    const searchEl = document.getElementById('productSearch');
    if (searchEl) searchEl.placeholder = ka ? 'პროდუქტის სახელი ან HS კოდი...' : 'Product name or HS code...';
    const genBtn = document.getElementById('generateBtn');
    if (genBtn) genBtn.textContent = earlySite === 'ka' ? 'გენერაცია' : 'Generate';
    document.querySelectorAll('.stat-loading-label').forEach(el => {
      el.textContent = ka ? 'იტვირთება...' : 'Loading...';
    });
    document.querySelectorAll('#reportLangToggle .stat-lang-toggle__btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.reportLang === early);
    });
    const sw = document.getElementById('statModeSwitch');
    if (sw) {
      const labels = {
        latest: ka ? 'უახლესი სტატისტიკა' : 'Latest Statistics',
        comparison: ka ? 'ქვეყნების შედარება' : 'Country Comparison',
        products: ka ? 'პროდუქტები' : 'Products',
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
  const USD_COL_RE = /^usd1000_\d{4}(_\d+)*$/;

  // ── DOM refs ───────────────────────────────────────────────────────────
  const pageTitleEl = document.getElementById('pageTitle');
  const productSearch = document.getElementById('productSearch');
  const productDropdown = document.getElementById('productDropdown');
  const productValue = document.getElementById('productValue');
  const productLabelEl = document.getElementById('productLabel');
  const yearLabelEl = document.getElementById('yearLabel');
  const periodLabelEl = document.getElementById('periodLabel');
  const flowLabelEl = document.getElementById('flowLabel');
  const yearSelect = document.getElementById('prodYear');
  const periodModeSelect = document.getElementById('prodPeriodMode');
  const flowSelect = document.getElementById('prodFlow');
  const generateBtn = document.getElementById('generateBtn');
  const prodLoading = document.getElementById('prodLoading');
  const prodSections = document.getElementById('prodSections');
  const prodSummaryEl = document.getElementById('prodSummary');
  const prodChartHeader = document.getElementById('prodChartHeader');
  const prodChartCanvas = document.getElementById('prodChart');
  const exportDestCard = document.getElementById('exportDestCard');
  const exportDestHeader = document.getElementById('exportDestHeader');
  const exportDestTable = document.getElementById('exportDestTable');
  const importOrigCard = document.getElementById('importOrigCard');
  const importOrigHeader = document.getElementById('importOrigHeader');
  const importOrigTable = document.getElementById('importOrigTable');
  const subFlowsRow = document.getElementById('subFlowsRow');
  const domExpHeader = document.getElementById('domExpHeader');
  const domExpTable = document.getElementById('domExpTable');
  const reExpHeader = document.getElementById('reExpHeader');
  const reExpTable = document.getElementById('reExpTable');
  const reportLangToggle = document.getElementById('reportLangToggle');

  // ── State ──────────────────────────────────────────────────────────────
  let products = [];      // [{value, code, labelKa, labelEn, displayLabel}]
  let classData = null;
  let selectedProduct = null;
  let useProxy = false;
  let lastResult = null;
  let generating = false;
  const chartInstances = { main: null };

  let reportLocale = localStorage.getItem('statReportLocale') || I18n.getLocale() || 'ka';

  const SEARCH_PLACEHOLDER = { ka: 'პროდუქტის სახელი ან HS კოდი...', en: 'Product name or HS code...' };
  const LOADING_LABEL = { ka: 'იტვირთება...', en: 'Loading...' };
  // Export/import palette from the statistics page's dynamics chart.
  const EXP_COLOR = '#16a34a';
  const IMP_COLOR = '#dc2626';

  // ── Mode switch thumb (same mechanism as dashboards' mn-toggle) ────────
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

  // ── Load classificatory (dual-locale; pattern from statistics.js:163) ──
  const countryNameEnMap = {};
  const countryNameKaMap = {};
  const hs4LabelKaMap = {};
  const hs4LabelEnMap = {};
  let classDataKa = null;
  let classDataEn = null;
  let allCountryIds = [];

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
      for (const p of (enJson.data.hs4 || [])) {
        hs4LabelEnMap[p.value] = p.label.replace(/^\d+\s+/, '');
      }
    }
    if (kaJson && kaJson.success && kaJson.data) {
      classDataKa = kaJson.data;
      for (const c of (kaJson.data.countries || [])) {
        countryNameKaMap[c.value] = c.label.replace(/^\d+\s+/, '');
      }
      for (const p of (kaJson.data.hs4 || [])) {
        hs4LabelKaMap[p.value] = p.label.replace(/^\d+\s+/, '');
      }
    }
    const primary = reportLocale === 'ka' ? (classDataKa || classDataEn) : (classDataEn || classDataKa);
    if (primary) {
      classData = primary;
      allCountryIds = (primary.countries || []).map(c => c.value);
    }
  } catch (err) {
    console.error('Failed to load classificatory data:', err);
  }

  // ── Verify latest month (copied from statistics.js:215) ────────────────
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

  // Latest available period (copied from statistics.js:517)
  function detectLatestPeriod(cd) {
    if (cd.selected) {
      return { year: cd.selected.year, month: cd.selected.month };
    }
    const years = (cd.year || []).map(y => y.value).sort((a, b) => b - a);
    const months = (cd.month || []).map(m => m.value).sort((a, b) => b - a);
    return { year: years[0], month: months[0] };
  }

  const latestPeriod = classData ? detectLatestPeriod(classDataEn || classDataKa) : null;
  const availableYears = classData
    ? (classData.year || []).map(y => y.value).sort((a, b) => b - a)
    : [];
  const minYear = availableYears.length ? Math.min(...availableYears) : 2009;

  // ── HS4 short-name maps (copied from statistics.js:274-301) ────────────
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

  // Product list for the search box: classificatory hs4 entries with the
  // zero-padded code and the CSV short names (classificatory label as
  // fallback). One entry per HS4 code, both locales.
  const primaryClass = classDataEn || classDataKa;
  products = ((primaryClass && primaryClass.hs4) || [])
    .filter(p => p.value > 0)
    .map(p => {
      const code = String(p.value).padStart(4, '0');
      const nameKa = hs4NameMap[p.value] || hs4LabelKaMap[p.value] || hs4LabelEnMap[p.value] || `HS ${code}`;
      const nameEn = hs4NameMapEn[p.value] || hs4LabelEnMap[p.value] || `HS ${code}`;
      return {
        value: p.value,
        code,
        nameKa,
        nameEn,
        labelKa: `${code} ${nameKa}`,
        labelEn: `${code} ${nameEn}`,
        displayLabel: '',
      };
    });

  function productName(p, isKa) { return isKa ? p.nameKa : p.nameEn; }
  function productLabel(p, isKa) { return isKa ? p.labelKa : p.labelEn; }

  // ── Formatting helpers (copied from statistics.js) ─────────────────────

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

  // Georgian month forms (copied from statistics.js:1285-1287)
  const KA_MONTH_STEM = { 1:'იანვარ', 2:'თებერვალ', 3:'მარტ', 4:'აპრილ', 5:'მაის', 6:'ივნის', 7:'ივლის', 8:'აგვისტო', 9:'სექტემბერ', 10:'ოქტომბერ', 11:'ნოემბერ', 12:'დეკემბერ' };
  const KA_MONTH_LOC = { 1:'იანვარში', 2:'თებერვალში', 3:'მარტში', 4:'აპრილში', 5:'მაისში', 6:'ივნისში', 7:'ივლისში', 8:'აგვისტოში', 9:'სექტემბერში', 10:'ოქტომბერში', 11:'ნოემბერში', 12:'დეკემბერში' };

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

  function geOrdinal(n) {
    return n === 1 ? 'პირველ' : `მე-${n}`;
  }
  function enOrdinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ── Periods ────────────────────────────────────────────────────────────
  // P(y): the period for year y — full year, or Jan..latestMonth when y is
  // the current not-yet-closed year (isYtd).
  function P(y) {
    const partial = latestPeriod && y === latestPeriod.year && latestPeriod.month < 12;
    return {
      year: y,
      months: partial ? Array.from({ length: latestPeriod.month }, (_, i) => i + 1) : null,
      isYtd: !!partial,
    };
  }

  // buildPeriods: 'five' mode → year Y and the 4 preceding available years
  // as chart points, comparison base = same window a year earlier.
  // Compare mode (periodMode = other year) → exactly the two chosen years;
  // when either is the current partial year, BOTH are clipped to the same
  // Jan..M window for comparability. Change % is later vs earlier year.
  function buildPeriods(year, periodMode) {
    if (periodMode === 'five') {
      const points = [];
      for (let y = year - 4; y <= year; y++) {
        if (availableYears.includes(y)) points.push(P(y));
      }
      const chosen = P(year);
      const base = year - 1 >= minYear
        ? { year: year - 1, months: chosen.months, isYtd: false }
        : null;
      return { compareMode: false, points, chosen, base, baseIsNatural: true };
    }
    const other = Number(periodMode);
    const y1 = Math.min(year, other);
    const y2 = Math.max(year, other);
    let p1 = P(y1);
    let p2 = P(y2);
    if (p1.isYtd || p2.isYtd) {
      const months = Array.from({ length: latestPeriod.month }, (_, i) => i + 1);
      p1 = { year: y1, months, isYtd: true };
      p2 = { year: y2, months, isYtd: true };
    }
    return { compareMode: true, points: [p1, p2], chosen: p2, base: p1, baseIsNatural: y2 - y1 === 1 };
  }

  // Chart/table label for one period: "2023" or "Jan-Jun'26".
  function periodPointLabel(p, isKa) {
    if (!p.months) return String(p.year);
    const m = p.months;
    const shortYear = String(p.year).slice(2);
    if (m.length === 1) return `${monthShort(m[0], isKa)}'${shortYear}`;
    return `${monthShort(m[0], isKa)}-${monthShort(m[m.length - 1], isKa)}'${shortYear}`;
  }

  // Table-header form: "2025" or "Jan-Jun 2026" / "იან-ივნ 2026".
  function periodText(p, isKa) {
    if (!p.months) return String(p.year);
    const m = p.months;
    const part = m.length === 1
      ? monthShort(m[0], isKa)
      : `${monthShort(m[0], isKa)}-${monthShort(m[m.length - 1], isKa)}`;
    return `${part} ${p.year}`;
  }

  // Prose form: "In 2025" / "2025 წელს", "In January-June 2026" /
  // "2026 წლის იანვარ-ივნისში".
  function periodProse(p, isKa) {
    if (!p.months) return isKa ? `${p.year} წელს` : `in ${p.year}`;
    const m = p.months;
    const first = m[0];
    const last = m[m.length - 1];
    if (isKa) {
      const part = m.length === 1 ? KA_MONTH_LOC[last] : `${KA_MONTH_STEM[first]}-${KA_MONTH_LOC[last]}`;
      return `${p.year} წლის ${part}`;
    }
    const part = m.length === 1 ? monthLabel(last, false) : `${monthLabel(first, false)}-${monthLabel(last, false)}`;
    return `in ${part} ${p.year}`;
  }

  // ── Data fetch layer ───────────────────────────────────────────────────

  function sumUsdCols(row) {
    let s = 0;
    for (const k of Object.keys(row)) {
      if (!USD_COL_RE.test(k)) continue;
      const v = parseFloat(row[k]);
      if (!isNaN(v)) s += v;
    }
    return s;
  }

  function baseFilters(flow, period) {
    const f = {
      tradeFlow: flow,
      measurementUnits: [1],
      years: [period.year],
      locale: reportLocale,
    };
    if (period.months) f.months = period.months;
    return f;
  }

  // Georgia's total for one product+flow+period (thousand USD).
  async function fetchProductTotal(flow, period, hs4) {
    const json = await geostatPost('/get_data', {
      ...baseFilters(flow, period),
      hs4: [hs4],
      sum: true,
      page: 1,
      pageSize: 10,
    });
    if (!json.success || !Array.isArray(json.data)) return 0;
    const detail = json.data.find(r => !r.isGroupSummary && r.hs4 != null);
    if (detail) return sumUsdCols(detail);
    const summary = json.data.find(r => r.isGroupSummary);
    return summary ? sumUsdCols(summary) : 0;
  }

  // Rank of the product among all products for the flow+period, plus
  // Georgia's flow total. hs4:['all'], no countries, paginated.
  async function fetchProductRank(flow, period, hs4) {
    const rows = [];
    let totalThd = 0;
    let page = 1;
    let total = Infinity;
    while (rows.length < total && page < 10) {
      const json = await geostatPost('/get_data', {
        ...baseFilters(flow, period),
        hs4: ['all'],
        sum: true,
        page,
        pageSize: 500,
      });
      if (!json.success || !Array.isArray(json.data)) break;
      total = json.total || 0;
      for (const row of json.data) {
        if (row.isGroupSummary) {
          totalThd = sumUsdCols(row) || totalThd;
          continue;
        }
        if (row.hs4 == null) continue;
        rows.push({ hs4: row.hs4, thd: sumUsdCols(row) });
      }
      if (!json.data.length) break;
      page++;
    }
    rows.sort((a, b) => b.thd - a.thd);
    const idx = rows.findIndex(r => r.hs4 === hs4);
    if (!totalThd) totalThd = rows.reduce((s, r) => s + r.thd, 0);
    return {
      rank: idx >= 0 && rows[idx].thd > 0 ? idx + 1 : null,
      productCount: rows.length,
      totalMln: totalThd / 1000,
    };
  }

  // Per-country values for one product+flow+period. No sum (sum:true with
  // many countries triggers Geostat 5xx — server/routes/statistics.js:382);
  // rows may split per month, so values accumulate additively per country
  // (pattern from server fetchFlowRanking / parseAppendixGeostatJson).
  async function fetchPartners(flow, period, hs4) {
    const perCountry = new Map(); // cid -> thd
    let page = 1;
    let seen = 0;
    let total = Infinity;
    while (seen < total && page < 10) {
      const json = await geostatPost('/get_data', {
        ...baseFilters(flow, period),
        hs4: [hs4],
        countries: allCountryIds,
        page,
        pageSize: 500,
      });
      if (!json.success || !Array.isArray(json.data)) break;
      total = json.total || 0;
      let pageRows = 0;
      for (const row of json.data) {
        if (row.isGroupSummary || row.country == null) continue;
        pageRows++;
        const cid = String(row.country);
        perCountry.set(cid, (perCountry.get(cid) || 0) + sumUsdCols(row));
      }
      seen += pageRows;
      if (!json.data.length || pageRows === 0) break;
      page++;
    }
    return perCountry;
  }

  // ── Product search dropdown (pattern from country-comparison.js) ───────

  function renderProductDropdown(filter) {
    const isKa = reportLocale === 'ka';
    const q = (filter || '').trim().toLowerCase();
    const qDigits = /^\d+$/.test(q) ? q.replace(/^0+/, '') : null;
    const pool = products;
    const filtered = q
      ? pool.filter(p => {
          if (qDigits !== null) {
            return String(p.value).startsWith(qDigits) || p.code.startsWith(q);
          }
          return p.labelKa.toLowerCase().includes(q) || p.labelEn.toLowerCase().includes(q);
        })
      : pool;
    const shown = filtered.slice(0, 50);
    if (shown.length === 0) {
      productDropdown.innerHTML = `<div class="stat-dropdown__empty">${escapeHtml(I18n.tr('statistics.noResults'))}</div>`;
    } else {
      productDropdown.innerHTML = shown.map(p =>
        `<div class="stat-dropdown__item${selectedProduct && selectedProduct.value === p.value ? ' selected' : ''}" data-value="${p.value}">${escapeHtml(productLabel(p, isKa))}</div>`
      ).join('');
    }
    productDropdown.classList.remove('hidden');
  }

  productSearch.addEventListener('focus', () => renderProductDropdown(productSearch.value));
  productSearch.addEventListener('input', () => renderProductDropdown(productSearch.value));

  productDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.stat-dropdown__item');
    if (!item) return;
    const val = Number(item.dataset.value);
    selectedProduct = products.find(p => p.value === val) || null;
    if (selectedProduct) {
      productSearch.value = productLabel(selectedProduct, reportLocale === 'ka');
      productValue.value = selectedProduct.value;
      updateGenerateState();
    }
    productDropdown.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stat-search-wrap')) {
      productDropdown.classList.add('hidden');
    }
  });

  function updateGenerateState() {
    generateBtn.disabled = generating || !selectedProduct;
  }

  // ── Selects ────────────────────────────────────────────────────────────

  function populateSelects() {
    const isKa = reportLocale === 'ka';
    const prevYear = yearSelect.value;
    const prevPeriod = periodModeSelect.value || 'five';
    const prevFlow = flowSelect.value || 'trade';

    yearSelect.innerHTML = availableYears.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSelect.value = [...yearSelect.options].some(o => o.value === prevYear) ? prevYear : String(availableYears[0] || '');

    populatePeriodModeSelect(prevPeriod);

    flowSelect.innerHTML = `
      <option value="trade">${isKa ? 'ვაჭრობა' : 'Trade'}</option>
      <option value="export">${isKa ? 'ექსპორტი' : 'Export'}</option>
      <option value="import">${isKa ? 'იმპორტი' : 'Import'}</option>`;
    flowSelect.value = prevFlow;
  }

  // Period options: "5 years" (default) or any other year to compare with.
  function populatePeriodModeSelect(keepValue) {
    const isKa = reportLocale === 'ka';
    const year = Number(yearSelect.value);
    const keep = keepValue !== undefined ? keepValue : (periodModeSelect.value || 'five');
    let html = `<option value="five">${isKa ? '5 წელი' : '5 years'}</option>`;
    for (const y of availableYears) {
      if (y === year) continue;
      html += `<option value="${y}">${isKa ? `შედარება: ${y}` : `vs ${y}`}</option>`;
    }
    periodModeSelect.innerHTML = html;
    periodModeSelect.value = [...periodModeSelect.options].some(o => o.value === String(keep)) ? String(keep) : 'five';
  }

  yearSelect.addEventListener('change', () => populatePeriodModeSelect());

  // ── Report language ────────────────────────────────────────────────────

  function applyReportLocale() {
    const isKa = reportLocale === 'ka';
    classData = isKa ? (classDataKa || classDataEn) : (classDataEn || classDataKa);

    if (pageTitleEl) pageTitleEl.textContent = isKa ? 'პროდუქტები' : 'Products';
    productLabelEl.textContent = isKa ? 'პროდუქტი' : 'Product';
    yearLabelEl.textContent = isKa ? 'წელი' : 'Year';
    periodLabelEl.textContent = isKa ? 'პერიოდი' : 'Period';
    flowLabelEl.textContent = isKa ? 'მიმართულება' : 'Flow';
    productSearch.placeholder = SEARCH_PLACEHOLDER[reportLocale];
    document.querySelectorAll('.stat-loading-label').forEach(el => {
      el.textContent = LOADING_LABEL[reportLocale];
    });

    const modeSwitch = document.getElementById('statModeSwitch');
    if (modeSwitch) {
      const btnLatest = modeSwitch.querySelector('[data-mode="latest"]');
      const btnCmp = modeSwitch.querySelector('[data-mode="comparison"]');
      const btnProd = modeSwitch.querySelector('[data-mode="products"]');
      if (btnLatest) btnLatest.textContent = isKa ? 'უახლესი სტატისტიკა' : 'Latest Statistics';
      if (btnCmp) btnCmp.textContent = isKa ? 'ქვეყნების შედარება' : 'Country Comparison';
      if (btnProd) btnProd.textContent = isKa ? 'პროდუქტები' : 'Products';
      positionModeThumb();
    }

    if (selectedProduct) {
      productSearch.value = productLabel(selectedProduct, isKa);
    }
    if (!productDropdown.classList.contains('hidden')) renderProductDropdown(productSearch.value);

    populateSelects();

    if (reportLangToggle) {
      reportLangToggle.querySelectorAll('.stat-lang-toggle__btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.reportLang === reportLocale);
      });
    }

    if (lastResult) renderProducts();
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

  // ── Generate ───────────────────────────────────────────────────────────

  generateBtn.addEventListener('click', () => {
    if (generateBtn.disabled) return;
    generateProducts();
  });

  async function generateProducts() {
    if (!selectedProduct || generating) return;

    generating = true;
    updateGenerateState();
    prodSections.classList.add('hidden');
    prodLoading.classList.remove('hidden');

    const year = Number(yearSelect.value);
    const periodMode = periodModeSelect.value;
    const flowMode = flowSelect.value; // 'trade' | 'export' | 'import'
    const H = selectedProduct.value;

    try {
      const pp = buildPeriods(year, periodMode);
      const { points, chosen, base } = pp;
      const wantExport = flowMode !== 'import';
      const wantImport = flowMode !== 'export';

      // Per-(flow, period) caches so summary totals reuse chart points.
      const totalsCache = new Map();
      const totalFor = (flow, p) => {
        const key = `${flow}|${p.year}|${p.months ? p.months.join(',') : 'full'}`;
        if (!totalsCache.has(key)) totalsCache.set(key, fetchProductTotal(flow, p, H));
        return totalsCache.get(key);
      };
      const zero = Promise.resolve(0);
      const emptyMap = Promise.resolve(new Map());
      const emptyRank = Promise.resolve({ rank: null, productCount: 0, totalMln: 0 });

      // Pre-window year totals for the chart's first-point change label
      // (five-years mode only; compare mode labels only the second point).
      const chainPrevPeriod = !pp.compareMode && points[0].year - 1 >= minYear
        ? { year: points[0].year - 1, months: points[0].months }
        : null;

      const [
        expSeries, impSeries,
        chainPrevExp, chainPrevImp,
        expCur, expBase, domCur, domBase, reexCur, reexBase, impCur, impBase,
        expRank, impRank,
        expPartnersCur, expPartnersBase, domPartnersCur, domPartnersBase,
        reexPartnersCur, reexPartnersBase, impPartnersCur, impPartnersBase,
      ] = await Promise.all([
        wantExport ? Promise.all(points.map(p => totalFor(10, p))) : Promise.resolve([]),
        wantImport ? Promise.all(points.map(p => totalFor(11, p))) : Promise.resolve([]),
        wantExport && chainPrevPeriod ? totalFor(10, chainPrevPeriod) : Promise.resolve(null),
        wantImport && chainPrevPeriod ? totalFor(11, chainPrevPeriod) : Promise.resolve(null),
        wantExport ? totalFor(10, chosen) : zero,
        wantExport && base ? totalFor(10, base) : zero,
        wantExport ? totalFor(12, chosen) : zero,
        wantExport && base ? totalFor(12, base) : zero,
        wantExport ? totalFor(13, chosen) : zero,
        wantExport && base ? totalFor(13, base) : zero,
        wantImport ? totalFor(11, chosen) : zero,
        wantImport && base ? totalFor(11, base) : zero,
        wantExport ? fetchProductRank(10, chosen, H) : emptyRank,
        wantImport ? fetchProductRank(11, chosen, H) : emptyRank,
        wantExport ? fetchPartners(10, chosen, H) : emptyMap,
        wantExport && base ? fetchPartners(10, base, H) : emptyMap,
        wantExport ? fetchPartners(12, chosen, H) : emptyMap,
        wantExport && base ? fetchPartners(12, base, H) : emptyMap,
        wantExport ? fetchPartners(13, chosen, H) : emptyMap,
        wantExport && base ? fetchPartners(13, base, H) : emptyMap,
        wantImport ? fetchPartners(11, chosen, H) : emptyMap,
        wantImport && base ? fetchPartners(11, base, H) : emptyMap,
      ]);

      // Partner rows: current + base values (mln), sorted by current desc.
      // The export rows also carry the country's domestic export of the
      // product, for the domestic-export-share column.
      function buildPartnerRows(curMap, baseMap, extraMap) {
        const rows = [];
        for (const [cid, thd] of curMap.entries()) {
          const cur = thd / 1000;
          if (!(cur > 0)) continue;
          rows.push({
            cid,
            cur,
            prev: ((baseMap && baseMap.get(cid)) || 0) / 1000,
            dom: extraMap ? ((extraMap.get(cid) || 0) / 1000) : null,
          });
        }
        rows.sort((a, b) => b.cur - a.cur);
        return rows.slice(0, 15);
      }

      lastResult = {
        product: selectedProduct,
        flowMode,
        pp,
        series: {
          exp: expSeries.map(v => v / 1000),
          imp: impSeries.map(v => v / 1000),
        },
        chainPrev: chainPrevPeriod ? {
          exp: chainPrevExp != null ? chainPrevExp / 1000 : null,
          imp: chainPrevImp != null ? chainPrevImp / 1000 : null,
        } : null,
        totals: {
          exp: expCur / 1000, expBase: expBase / 1000,
          dom: domCur / 1000, domBase: domBase / 1000,
          reex: reexCur / 1000, reexBase: reexBase / 1000,
          imp: impCur / 1000, impBase: impBase / 1000,
        },
        ranks: { exp: expRank, imp: impRank },
        partners: {
          exp: buildPartnerRows(expPartnersCur, expPartnersBase, domPartnersCur),
          dom: buildPartnerRows(domPartnersCur, domPartnersBase, null),
          reex: buildPartnerRows(reexPartnersCur, reexPartnersBase, null),
          imp: buildPartnerRows(impPartnersCur, impPartnersBase, null),
        },
      };

      renderProducts();
    } catch (err) {
      console.error('Products generation error:', err);
      lastResult = null;
      prodSections.classList.remove('hidden');
      prodSummaryEl.classList.remove('hidden');
      prodSummaryEl.innerHTML = `<div class="msg msg-error">${escapeHtml(I18n.tr('statistics.reportFailed'))} ${escapeHtml(err.message)}</div>`;
    } finally {
      generating = false;
      prodLoading.classList.add('hidden');
      updateGenerateState();
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function renderProducts() {
    if (!lastResult) return;
    const isKa = reportLocale === 'ka';
    const r = lastResult;
    const wantExport = r.flowMode !== 'import';
    const wantImport = r.flowMode !== 'export';
    const name = productName(r.product, isKa);
    const labels = r.pp.points.map(p => periodPointLabel(p, isKa));
    const chosenText = periodText(r.pp.chosen, isKa);

    // Combined export/import dynamics chart
    const title = wantExport && wantImport
      ? `${name} - ${isKa ? 'ექსპორტ-იმპორტის დინამიკა, მლნ. $' : 'Export-Import Dynamics, mln $'}`
      : (wantExport
        ? `${name} - ${isKa ? 'ექსპორტის დინამიკა, მლნ. $' : 'Export Dynamics, mln $'}`
        : `${name} - ${isKa ? 'იმპორტის დინამიკა, მლნ. $' : 'Import Dynamics, mln $'}`);
    renderCombinedChart(title, labels,
      wantExport ? r.series.exp : null,
      wantImport ? r.series.imp : null,
      wantExport ? buildChangeLabels(r.series.exp, r.chainPrev ? r.chainPrev.exp : null, r.totals.expBase) : null,
      wantImport ? buildChangeLabels(r.series.imp, r.chainPrev ? r.chainPrev.imp : null, r.totals.impBase) : null,
      isKa);

    // Partner tables
    exportDestCard.classList.toggle('hidden', !wantExport);
    importOrigCard.classList.toggle('hidden', !wantImport);
    subFlowsRow.classList.toggle('hidden', !wantExport);
    if (wantExport) {
      renderPartnerHeader(exportDestHeader, name, isKa ? 'ძირითადი საექსპორტო მიმართულებები' : 'Top Export Destinations', chosenText);
      renderPartnerTable(exportDestTable, r.partners.exp, r.totals.exp, { showDomShare: true });
      renderPartnerHeader(domExpHeader, name, isKa ? 'ადგილობრივი ექსპორტის მიმართულებები' : 'Top Domestic Export Destinations', chosenText);
      renderPartnerTable(domExpTable, r.partners.dom, r.totals.dom, {});
      renderPartnerHeader(reExpHeader, name, isKa ? 'რეექსპორტის მიმართულებები' : 'Top Re-export Destinations', chosenText);
      renderPartnerTable(reExpTable, r.partners.reex, r.totals.reex, {});
    }
    if (wantImport) {
      renderPartnerHeader(importOrigHeader, name, isKa ? 'ძირითადი საიმპორტო ქვეყნები' : 'Top Import Origins', chosenText);
      renderPartnerTable(importOrigTable, r.partners.imp, r.totals.imp, {});
    }

    renderProductSummary();

    prodSections.classList.remove('hidden');
  }

  // Per-point change label for a chart series: consecutive points are
  // comparable prior periods (only the last point can be YTD); the first
  // point compares against the pre-window year (chainPrevMln); a YTD last
  // point compares against the same-months prior-year total (ytdBaseMln),
  // never against the full prior-year point. Compare mode labels only the
  // second point (change vs the first chosen period).
  function buildChangeLabels(series, chainPrevMln, ytdBaseMln) {
    const r = lastResult;
    const points = r.pp.points;
    return series.map((v, i) => {
      let prev = null;
      if (r.pp.compareMode) {
        prev = i === 1 ? series[0] : null;
      } else if (points[i].isYtd) {
        prev = r.pp.base ? ytdBaseMln : null;
      } else if (i === 0) {
        prev = chainPrevMln;
      } else {
        prev = series[i - 1];
      }
      if (!(prev > 0)) return null;
      const pct = calcChange(v, prev);
      return `${pct > 0 ? '+' : ''}${formatChangePct(pct)}`;
    });
  }

  function renderCombinedChart(title, labels, expSeries, impSeries, expChanges, impChanges, isKa) {
    const both = !!(expSeries && impSeries);
    const legendItems = [];
    if (expSeries) legendItems.push(`<div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:${EXP_COLOR}"></span>${isKa ? 'ექსპორტი' : 'Export'}</div>`);
    if (impSeries) legendItems.push(`<div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:${IMP_COLOR}"></span>${isKa ? 'იმპორტი' : 'Import'}</div>`);
    prodChartHeader.innerHTML = `
      <div class="stat-chart-title-row">
        <h3 class="stat-report__title">${escapeHtml(title)}</h3>
        <div class="stat-chart-legend">${legendItems.join('')}</div>
      </div>`;

    if (chartInstances.main) {
      chartInstances.main.destroy();
      chartInstances.main = null;
    }

    const makeDataset = (data, color, align) => ({
      data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.5,
      pointRadius: 4,
      pointBackgroundColor: color,
      tension: 0.3,
      datalabels: { align, color },
    });
    const datasets = [];
    const changesByDataset = [];
    // When the two series differ wildly in magnitude, the smaller line hugs
    // the chart floor and below-point labels would collide with the x-axis —
    // flip that series' labels above the line instead.
    const overallMax = Math.max(...(expSeries || [0]), ...(impSeries || [0]), 0.001);
    const impNearFloor = both && Math.max(...impSeries) < 0.25 * overallMax;
    if (expSeries) {
      datasets.push(makeDataset(expSeries, EXP_COLOR, 'top'));
      changesByDataset.push(expChanges);
    }
    if (impSeries) {
      datasets.push(makeDataset(impSeries, IMP_COLOR, both && !impNearFloor ? 'bottom' : 'top'));
      changesByDataset.push(impChanges);
    }

    chartInstances.main = new Chart(prodChartCanvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Extra bottom room so the import line's below-point labels don't
        // collide with the x-axis year ticks.
        layout: { padding: { top: 24, bottom: both ? 30 : 8, left: 40, right: 40 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          datalabels: {
            font: { size: 11, weight: '600' },
            clamp: true,
            textAlign: 'center',
            formatter: (v, ctx) => {
              const base = chartLabel(v);
              const arr = changesByDataset[ctx.datasetIndex];
              const change = arr && arr[ctx.dataIndex];
              return change ? `${base}\n${change}` : base;
            },
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
            grace: '18%',
          },
        },
      },
      plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
    });
  }

  function renderPartnerHeader(el, productNameText, sectionTitle, chosenText) {
    el.innerHTML = `<h3 class="stat-report__title">${escapeHtml(`${productNameText} - ${sectionTitle}, ${chosenText}`)}</h3>`;
  }

  // Partner table. Columns: Country | (base-year value in compare mode) |
  // value | Change % | Share % | (Domestic export share % for the export
  // destinations table). Top 10 with Show more (up to 15).
  function renderPartnerTable(el, rows, flowTotalMln, opts) {
    const isKa = reportLocale === 'ka';
    if (!rows || rows.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>${isKa ? 'მონაცემები ვერ მოიძებნა' : 'No data found'}</p></div>`;
      return;
    }
    const r = lastResult;
    const compareMode = r.pp.compareMode;
    const hasBase = !!r.pp.base;
    const hCountry = isKa ? 'ქვეყანა' : 'Country';
    const curText = periodText(r.pp.chosen, isKa);
    const baseText = hasBase ? periodText(r.pp.base, isKa) : '';
    const hChange = isKa ? 'ცვლილება<br>%' : 'Change<br>%';
    const hShare = isKa ? 'წილი<br>%' : 'Share<br>%';
    const hDom = isKa ? 'ადგ. ექსპორტის წილი<br>%' : 'Dom. export share<br>%';
    const mlnSuffix = isKa ? 'მლნ. $' : 'mln $';

    const INITIAL_COUNT = 10;
    const hasMore = rows.length > INITIAL_COUNT;

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th class="stat-col-product">${hCountry}</th>
          ${compareMode ? `<th class="stat-col-value">${baseText}<br>${mlnSuffix}</th>` : ''}
          <th class="stat-col-value">${curText}<br>${mlnSuffix}</th>
          <th class="stat-col-change">${hChange}</th>
          <th class="stat-col-change">${hShare}</th>
          ${opts.showDomShare ? `<th class="stat-col-reexport">${hDom}</th>` : ''}
        </tr>
      </thead>
      <tbody>`;

    rows.forEach((row, i) => {
      const countryName = isKa
        ? (countryNameKaMap[row.cid] || countryNameEnMap[row.cid] || row.cid)
        : (countryNameEnMap[row.cid] || countryNameKaMap[row.cid] || row.cid);
      const changeAvailable = hasBase;
      let changeCell = '-';
      let changeClass = '';
      if (changeAvailable) {
        const pct = calcChange(row.cur, row.prev);
        changeClass = pct > 0 ? 'stat-positive' : (pct < 0 ? 'stat-negative' : '');
        changeCell = `${pct > 0 ? '+' : ''}${formatChangePct(pct)}`;
      }
      const share = flowTotalMln > 0 ? (row.cur / flowTotalMln) * 100 : null;
      const shareCell = share != null ? `${share.toFixed(1)}%` : '-';
      const domShare = (opts.showDomShare && row.dom != null && row.cur > 0)
        ? `${Math.min(100, (row.dom / row.cur) * 100).toFixed(0)}%`
        : '-';
      const hiddenStyle = (hasMore && i >= INITIAL_COUNT) ? ' style="display:none" data-expandable' : '';
      html += `
        <tr${hiddenStyle}>
          <td class="stat-col-product">${escapeHtml(countryName)}</td>
          ${compareMode ? `<td class="stat-col-value">${row.prev > 0 ? formatMln(row.prev) : '-'}</td>` : ''}
          <td class="stat-col-value">${formatMln(row.cur)}</td>
          <td class="stat-col-change ${changeClass}">${changeCell}</td>
          <td class="stat-col-change">${shareCell}</td>
          ${opts.showDomShare ? `<td class="stat-col-reexport">${domShare}</td>` : ''}
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
        const trs = el.querySelectorAll('tr[data-expandable]');
        const expanded = trs[0]?.style.display !== 'none';
        trs.forEach(t => { t.style.display = expanded ? 'none' : ''; });
        btn.textContent = expanded ? btn.dataset.more : btn.dataset.less;
      });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────

  function renderProductSummary() {
    const r = lastResult;
    const isKa = reportLocale === 'ka';
    const name = productName(r.product, isKa);
    const wantExport = r.flowMode !== 'import';
    const wantImport = r.flowMode !== 'export';
    const prose = periodProse(r.pp.chosen, isKa);
    const mln = isKa ? 'მლნ. აშშ დოლარი' : 'mln USD';
    const t = r.totals;
    const hasBase = !!r.pp.base;
    // "vs 2023" wording when the comparison base is not the natural prior
    // year (compare mode with non-adjacent years).
    const vsBase = hasBase && !r.pp.baseIsNatural
      ? (isKa ? ` ${r.pp.base.year} წელთან შედარებით` : ` vs ${r.pp.base.year}`)
      : '';

    function changeTxt(cur, prev) {
      if (!hasBase || !(prev > 0)) return '';
      const pct = calcChange(cur, prev);
      return `${pct > 0 ? '+' : ''}${formatChangePct(pct)}${vsBase}`;
    }
    function paren(parts) {
      const list = parts.filter(Boolean);
      return list.length ? ` (${list.join(', ')})` : '';
    }

    // Top-5 partner listing: "Russia (170.7 mln USD, -7%, domestic export
    // share 96%)" — change omitted when no base, dom share only for export.
    // Countries holding less than 1% of the product's flow are skipped.
    function topList(rows, flowTotal, withDomShare) {
      return rows
        .filter(row => flowTotal > 0 && (row.cur / flowTotal) * 100 >= 1)
        .slice(0, 5).map(row => {
        const countryName = isKa
          ? (countryNameKaMap[row.cid] || countryNameEnMap[row.cid] || row.cid)
          : (countryNameEnMap[row.cid] || countryNameKaMap[row.cid] || row.cid);
        const parts = [`${formatMln2(row.cur)} ${mln}`];
        const ch = changeTxt(row.cur, row.prev);
        if (ch) parts.push(ch);
        if (withDomShare && row.dom != null && row.cur > 0) {
          parts.push(isKa
            ? `ადგ. ექსპორტის წილი ${Math.min(100, (row.dom / row.cur) * 100).toFixed(0)}%`
            : `domestic export share ${Math.min(100, (row.dom / row.cur) * 100).toFixed(0)}%`);
        } else if (!withDomShare && flowTotal > 0) {
          parts.push(isKa
            ? `წილი ${((row.cur / flowTotal) * 100).toFixed(1)}%`
            : `share ${((row.cur / flowTotal) * 100).toFixed(1)}%`);
        }
        return `${escapeHtml(countryName)} (${parts.join(', ')})`;
      }).join(', ');
    }

    const lines = [];

    if (wantExport) {
      lines.push(`<h4>${isKa ? 'ექსპორტი' : 'Export'}</h4>`);
      if (!(t.exp > INSIGNIFICANT_MLN)) {
        lines.push(`<p>${
          isKa
            ? `${prose} «${escapeHtml(name)}»-ის ექსპორტი საქართველოდან არ ფიქსირდება.`
            : `No exports of «${escapeHtml(name)}» from Georgia were recorded ${prose}.`
        }</p>`);
      } else {
        const domShare = t.exp > 0 ? (t.dom / t.exp) * 100 : 0;
        const reexShare = t.exp > 0 ? (t.reex / t.exp) * 100 : 0;
        const rankSentence = r.ranks.exp.rank
          ? (isKa
            ? `«${escapeHtml(name)}» ${prose} საქართველოდან ექსპორტირებულ პროდუქტებს შორის ${geOrdinal(r.ranks.exp.rank)} ადგილზეა. `
            : `«${escapeHtml(name)}» is ranked ${enOrdinal(r.ranks.exp.rank)} among Georgia's exported products ${prose}. `)
          : '';
        const expSentence = isKa
          ? `ამ პროდუქტის ექსპორტმა ${prose} შეადგინა ${formatMln2(t.exp)} ${mln}${paren([changeTxt(t.exp, t.expBase)])}.`
          : `Export of this product reached ${formatMln2(t.exp)} ${mln}${paren([changeTxt(t.exp, t.expBase)])}.`;
        const domSentence = isKa
          ? ` ადგილობრივმა ექსპორტმა შეადგინა ${formatMln2(t.dom)} ${mln}${paren([changeTxt(t.dom, t.domBase), `წილი ${domShare.toFixed(1)}%`])}, ხოლო რეექსპორტმა - ${formatMln2(t.reex)} ${mln}${paren([changeTxt(t.reex, t.reexBase), `წილი ${reexShare.toFixed(1)}%`])}.`
          : ` Domestic export amounted to ${formatMln2(t.dom)} ${mln}${paren([changeTxt(t.dom, t.domBase), `share ${domShare.toFixed(1)}%`])}, while re-export amounted to ${formatMln2(t.reex)} ${mln}${paren([changeTxt(t.reex, t.reexBase), `share ${reexShare.toFixed(1)}%`])}.`;
        const destSentence = r.partners.exp.length
          ? (isKa
            ? ` ძირითადი საექსპორტო მიმართულებები: ${topList(r.partners.exp, r.totals.exp, true)}.`
            : ` Main export destinations: ${topList(r.partners.exp, r.totals.exp, true)}.`)
          : '';
        lines.push(`<p>${rankSentence}${expSentence}${domSentence}${destSentence}</p>`);
      }
    }

    if (wantImport) {
      if (wantExport) lines.push('<hr />');
      lines.push(`<h4>${isKa ? 'იმპორტი' : 'Import'}</h4>`);
      if (!(t.imp > INSIGNIFICANT_MLN)) {
        lines.push(`<p>${
          isKa
            ? `${prose} «${escapeHtml(name)}»-ის იმპორტი საქართველოში არ ფიქსირდება.`
            : `No imports of «${escapeHtml(name)}» to Georgia were recorded ${prose}.`
        }</p>`);
      } else {
        const rankSentence = r.ranks.imp.rank
          ? (isKa
            ? `«${escapeHtml(name)}» ${prose} საქართველოში იმპორტირებულ პროდუქტებს შორის ${geOrdinal(r.ranks.imp.rank)} ადგილზეა. `
            : `«${escapeHtml(name)}» is ranked ${enOrdinal(r.ranks.imp.rank)} among Georgia's imported products ${prose}. `)
          : '';
        const impSentence = isKa
          ? `ამ პროდუქტის იმპორტმა ${prose} შეადგინა ${formatMln2(t.imp)} ${mln}${paren([changeTxt(t.imp, t.impBase)])}.`
          : `Import of this product reached ${formatMln2(t.imp)} ${mln}${paren([changeTxt(t.imp, t.impBase)])}.`;
        const origSentence = r.partners.imp.length
          ? (isKa
            ? ` ძირითადი საიმპორტო ქვეყნები: ${topList(r.partners.imp, r.totals.imp, false)}.`
            : ` Main import origins: ${topList(r.partners.imp, r.totals.imp, false)}.`)
          : '';
        lines.push(`<p>${rankSentence}${impSentence}${origSentence}</p>`);
      }
    }

    prodSummaryEl.innerHTML = lines.join('');
    prodSummaryEl.classList.remove('hidden');
  }

  // ── Initial UI state ───────────────────────────────────────────────────
  applyReportLocale();
})();
