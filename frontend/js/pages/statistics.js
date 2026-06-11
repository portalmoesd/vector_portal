/**
 * Statistics Page
 * Generates trade overview, export products, and import products reports
 * for a selected country using data from ex-trade-api.geostat.ge.
 *
 * Calls the Geostat API directly from the browser.
 * Falls back to our backend proxy (/api/statistics/) if direct calls fail.
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  // ── Constants ──────────────────────────────────────────────────────────
  const GEOSTAT_API = 'https://ex-trade-api.geostat.ge/api/trade';
  const PROXY_API = `${API_BASE}/api/statistics`;

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('countrySearch');
  const dropdown = document.getElementById('countryDropdown');
  const countryValue = document.getElementById('countryValue');
  const generateBtn = document.getElementById('generateBtn');
  const exportPdfBtn = document.getElementById('exportPdfBtn');
  const exportWordBtn = document.getElementById('exportWordBtn');
  const statSections = document.getElementById('statSections');
  const reportLoading = document.getElementById('reportLoading');
  const tradeSummaryEl = document.getElementById('tradeSummary');
  const overviewHeader = document.getElementById('overviewHeader');
  const overviewTable = document.getElementById('overviewTable');
  const exportHeader = document.getElementById('exportHeader');
  const exportTable = document.getElementById('exportTable');
  const exportIncreaseHeader = document.getElementById('exportIncreaseHeader');
  const exportIncreaseTable = document.getElementById('exportIncreaseTable');
  const exportDropHeader = document.getElementById('exportDropHeader');
  const exportDropTable = document.getElementById('exportDropTable');
  const importHeader = document.getElementById('importHeader');
  const importTable = document.getElementById('importTable');
  const importIncreaseHeader = document.getElementById('importIncreaseHeader');
  const importIncreaseTable = document.getElementById('importIncreaseTable');
  const importDropHeader = document.getElementById('importDropHeader');
  const importDropTable = document.getElementById('importDropTable');
  const turnoverChartHeader = document.getElementById('turnoverChartHeader');
  const turnoverChartCanvas = document.getElementById('turnoverChart');
  const dynamicsChartHeader = document.getElementById('dynamicsChartHeader');
  const tradeChartsRowEl = document.getElementById('tradeChartsRow');
  const dynamicsChartCanvas = document.getElementById('dynamicsChart');
  // Investments tab
  // investmentsArea removed — unified scroll layout
  const investmentsLoading = document.getElementById('investmentsLoading');
  const fdiTable = document.getElementById('fdiTable');
  const fdiChartHeader = document.getElementById('fdiChartHeader');
  const fdiRowEl = document.getElementById('fdiRow');
  // `tourismHeader` / `fdiHeader` were per-table headers above the table
  // column; removed when we merged the summary + row into a single card.
  const fdiChartCanvas = document.getElementById('fdiChart');
  // Tourism tab
  // tourismArea removed — unified scroll layout
  const tourismLoading = document.getElementById('tourismLoading');
  const tourismSummaryEl = document.getElementById('tourismSummary');
  const investmentsSummaryEl = document.getElementById('investmentsSummary');
  const companiesSummaryEl = document.getElementById('companiesSummary');
  const companiesLoading = document.getElementById('companiesLoading');
  const fdiSectorsCardEl = document.getElementById('fdiSectorsCard');
  const fdiSectorsHeaderEl = document.getElementById('fdiSectorsHeader');
  const fdiSectorsTableEl = document.getElementById('fdiSectorsTable');
  const tourismTableEl = document.getElementById('tourismTable');
  const tourismChartHeader = document.getElementById('tourismChartHeader');
  const tourismRowEl = document.getElementById('tourismRow');
  const tourismChartCanvas = document.getElementById('tourismChart');
  // Appendix tab
  const appendixLoadingEl = document.getElementById('appendixLoading');
  const appendixHeaderEl = document.getElementById('appendixHeader');
  const appendixTableEl = document.getElementById('appendixTable');

  // ── State ────────────────────────────────────────────────────────────────
  let countries = [];
  let classData = null;
  let selectedCountry = null;
  let useProxy = false;
  let turnoverChartInstance = null;
  let dynamicsChartInstance = null;
  let fdiChartInstance = null;
  let tourismChartInstance = null;
  let countryNameMap = {}; // variant → canonical GNTA name

  // Per-(country, locale) cache of fully-rendered reports. When the user
  // switches the report language to one we already generated for the
  // selected country, we replay the cached state instead of refetching
  // from Geostat. Shape: country.value → { en?: Snapshot, ka?: Snapshot }.
  // Snapshot = { panels: {id: html}, rowHidden: {id: bool},
  //              cardDisplay: {id: ''|'none'},
  //              pdfState: deep-cloned subset }.
  const reportCache = new Map();
  // activeTab removed — unified scroll layout with scroll-spy

  // ── Report locale ────────────────────────────────────────────────────────
  // The statistics page has its own language toggle (inside the controls
  // card) that drives the entire report — tabs, section headings, country
  // names, generated content, and the PDF export language. It is
  // independent of the global site locale, which on this page only
  // translates "Statistics" / "Country" / "Generate".
  let reportLocale = localStorage.getItem('statReportLocale') || I18n.getLocale() || 'ka';

  const TAB_LABELS = {
    ka: { trade: 'ვაჭრობა', tourism: 'ტურიზმი', investments: 'ინვესტიციები', companies: 'კომპანიები', appendix: 'დანართი' },
    en: { trade: 'Trade',    tourism: 'Tourism',  investments: 'Investments',  companies: 'Companies',  appendix: 'Appendix' },
  };
  const SEARCH_PLACEHOLDER = {
    ka: 'ქვეყნის ძებნა...',
    en: 'Search country...',
  };
  const LOADING_LABEL = { ka: 'იტვირთება...', en: 'Loading...' };

  // ── PDF state ────────────────────────────────────────────────────────────
  // Captured alongside each tab's render so the PDF builder doesn't scrape
  // the DOM. Each sub-object is set to null before the tab re-renders, and
  // populated on successful completion.
  const pdfState = {
    country: null,
    trade: null,      // { overview, prevYear, prevPrevYear, latestYear, latestMonth, periodLabel, monthNames, hasExport, hasImport, exportGrowing, importGrowing, exportProducts, importProducts, exportChange, importChange }
    tourism: null,    // { hasData, quarterlyRows, annualRows }
    investments: null, // { hasData, tableData }
    appendix: null,   // { latestYear, latestMonth, columns, data } — multi-year trade matrix
  };

  // ── Geostat API helpers (direct + proxy fallback) ────────────────────────

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

  // ── Load classificatory data ─────────────────────────────────────────────
  // Load BOTH Georgian and English classificatories up-front so the page
  // can flip the report language without a round-trip. classDataKa and
  // classDataEn hold the month/year/HS tables in each language; classData
  // points at whichever one matches the current reportLocale.
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

  // Probe-forward: Geostat sometimes publishes a new month's data before
  // updating `selected.month` in the classificatory, which leaves the
  // whole page pinned to the previous month. Verify `selected.month` by
  // asking /get_data whether month+1 and month+2 already have rows for
  // Georgia. Both probes run in parallel, so worst-case added latency is
  // one Geostat round trip and happens only once on page init.
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
      console.log(`[stats] probe-forward: classificatory selected month ${month} → verified ${verified}`);
      if (classDataEn && classDataEn.selected) classDataEn.selected.month = verified;
      if (classDataKa && classDataKa.selected) classDataKa.selected.month = verified;
    }
  }

  try { await verifyLatestMonth(); } catch (_) { /* non-fatal */ }

  function applyReportLocaleToCountries() {
    const ka = reportLocale === 'ka';
    // Swap classData so month/year labels pick up the new locale.
    classData = ka ? (classDataKa || classDataEn) : (classDataEn || classDataKa);
    for (const c of countries) {
      c.displayLabel = ka ? c.displayLabelKa : c.displayLabelEn;
    }
    if (selectedCountry) {
      selectedCountry.displayLabel = ka ? selectedCountry.displayLabelKa : selectedCountry.displayLabelEn;
    }
  }

  // ── Load HS4 short name mapping ──────────────────────────────────────────
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

  // ── Load country name mapping (for tourism tab) ────────────────────────
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

  // Apply canonical names from the mapping to each country's KA display
  // label. countryNameMap is Georgian-only (GNTA source), so we leave the
  // English name alone.
  for (const c of countries) {
    c.rawLabel = c.displayLabelKa;
    const canonical = countryNameMap[c.displayLabelKa];
    if (canonical) c.displayLabelKa = canonical;
    c.displayLabel = reportLocale === 'ka' ? c.displayLabelKa : c.displayLabelEn;
  }

  // ── Load Georgian grammar forms for country names ─────────────────────
  // CSV shape:  nominative,comitative,locative,ablative,genitive
  //   ქვეყანა,ქვეყანასთან,ქვეყანაში,ქვეყნიდან,ქვეყნის
  // Keyed by the nominative form (which matches the canonicalised
  // displayLabelKa after the previous loop). Used everywhere the report
  // needs an inflected form — right now just the ablative ("from X") but
  // the rest are loaded so future sentences can pick them up trivially.
  const countryGrammar = {}; // nominative → { nom, withCase, inCase, from, of }
  try {
    const csvRes = await fetch('/data/country-grammar.csv');
    if (csvRes.ok) {
      const csvText = await csvRes.text();
      // Parse CSV line-by-line; cells are either quoted ("...") or bare.
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
            i = end + 2; // skip closing quote + comma
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

  // Fallback when a country isn't in the grammar sheet — matches the
  // previous naive behaviour (drop final vowel, add "იდან" for ablative).
  function kaGrammarFallback(nom) {
    return { nom, withCase: nom + 'თან', inCase: nom + 'ში', from: nom + 'დან', of: nom + 'ის' };
  }
  function grammarFor(nominative) {
    return countryGrammar[nominative] || kaGrammarFallback(nominative || '');
  }



  const reportLangToggle = document.getElementById('reportLangToggle');

  function applyReportLocale(regenerate = true) {
    const ka = reportLocale === 'ka';

    // Tabs
    document.querySelectorAll('.stat-tab').forEach(btn => {
      const key = btn.dataset.tab;
      const label = TAB_LABELS[reportLocale] && TAB_LABELS[reportLocale][key];
      if (label) btn.textContent = label;
    });

    // Section h2 headings
    document.querySelectorAll('[data-stat-heading]').forEach(h => {
      const key = h.dataset.statHeading;
      const label = TAB_LABELS[reportLocale] && TAB_LABELS[reportLocale][key];
      if (label) h.textContent = label;
    });

    // Country search input + placeholder
    searchInput.placeholder = SEARCH_PLACEHOLDER[reportLocale];

    // Loading spinner labels
    document.querySelectorAll('.stat-loading-label').forEach(el => {
      el.textContent = LOADING_LABEL[reportLocale];
    });

    // Country objects + currently-selected country label
    applyReportLocaleToCountries();
    if (selectedCountry) searchInput.value = selectedCountry.displayLabel;

    // Dropdown items (if open)
    if (!dropdown.classList.contains('hidden')) renderDropdown(searchInput.value);

    // Toggle button pressed state
    if (reportLangToggle) {
      reportLangToggle.querySelectorAll('.stat-lang-toggle__btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.reportLang === reportLocale);
      });
    }

    // Re-render the report if one has been generated
    if (regenerate && selectedCountry && pdfState.trade) {
      runFullGenerate();
    }
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

  // Initial render — set labels + button state from the persisted preference.
  applyReportLocale(false);

  // Add English → Georgian canonical entries so resolveGntaName works
  // when the UI is in English. The shared numeric country ID bridges
  // the two classificatories — always use the Georgian canonical as
  // the target (since GNTA tourism data is always in Georgian).
  for (const c of countries) {
    const englishName = countryNameEnMap[c.value];
    const georgianName = countryNameKaMap[c.value];
    // Apply any variant→canonical mapping to the Georgian name too
    const georgianCanonical = (georgianName && countryNameMap[georgianName]) || georgianName;
    if (englishName && georgianCanonical && !countryNameMap[englishName]) {
      countryNameMap[englishName] = georgianCanonical;
    }
  }

  // ── Country search dropdown ──────────────────────────────────────────────

  function renderDropdown(filter) {
    const q = (filter || '').toLowerCase();
    const filtered = q
      ? countries.filter(c => c.displayLabel.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
      : countries;
    const shown = filtered.slice(0, 50);

    if (shown.length === 0) {
      dropdown.innerHTML = `<div class="stat-dropdown__empty">${escapeHtml(I18n.tr('statistics.noResults'))}</div>`;
    } else {
      dropdown.innerHTML = shown.map(c =>
        `<div class="stat-dropdown__item${selectedCountry && selectedCountry.value === c.value ? ' selected' : ''}" data-value="${c.value}">${escapeHtml(c.displayLabel)}</div>`
      ).join('');
    }
    dropdown.classList.remove('hidden');
  }

  searchInput.addEventListener('focus', () => renderDropdown(searchInput.value));
  searchInput.addEventListener('input', () => renderDropdown(searchInput.value));

  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.stat-dropdown__item');
    if (!item) return;
    const val = Number(item.dataset.value);
    selectedCountry = countries.find(c => c.value === val) || null;
    if (selectedCountry) {
      searchInput.value = selectedCountry.displayLabel;
      countryValue.value = selectedCountry.value;
      generateBtn.disabled = false;
    }
    dropdown.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stat-search-wrap')) {
      dropdown.classList.add('hidden');
    }
  });

  // ── Tab navigation (scroll-to-section) ───────────────────────────────────

  document.querySelectorAll('.stat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const section = document.getElementById('section-' + tab.dataset.tab);
      if (section) section.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Scroll-spy: update active tab as the user scrolls past sections
  const sectionEls = document.querySelectorAll('.stat-section');
  const scrollSpy = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const tabName = entry.target.id.replace('section-', '');
        document.querySelectorAll('.stat-tab').forEach(b =>
          b.classList.toggle('active', b.dataset.tab === tabName));
      }
    }
  }, { rootMargin: '-160px 0px -60% 0px' });
  sectionEls.forEach(s => scrollSpy.observe(s));

  // ── Determine latest available period ────────────────────────────────────

  function detectLatestPeriod(cd) {
    if (cd.selected) {
      return { year: cd.selected.year, month: cd.selected.month };
    }
    const years = (cd.year || []).map(y => y.value).sort((a, b) => b - a);
    const months = (cd.month || []).map(m => m.value).sort((a, b) => b - a);
    return { year: years[0], month: months[0] };
  }

  // ── Generate report ──────────────────────────────────────────────────────

  const globalReportLoading = document.getElementById('globalReportLoading');

  // ── Per-(country, locale) report cache ──────────────────────────────
  // Section panel IDs whose innerHTML we snapshot. Each is text/markup
  // that the renderers populate; restoring innerHTML brings the panel
  // back exactly. Chart canvases live in sibling elements not in this
  // list, so they're untouched by the restore — Chart.js instances are
  // destroyed and rebuilt explicitly in restoreReportSnapshot.
  const SNAPSHOT_PANEL_IDS = [
    'tradeSummary',
    'overviewHeader', 'overviewTable',
    'exportHeader', 'exportTable',
    'exportIncreaseHeader', 'exportIncreaseTable',
    'exportDropHeader', 'exportDropTable',
    'importHeader', 'importTable',
    'importIncreaseHeader', 'importIncreaseTable',
    'importDropHeader', 'importDropTable',
    'turnoverChartHeader', 'dynamicsChartHeader',
    'tourismSummary', 'tourismTable', 'tourismChartHeader',
    'investmentsSummary', 'fdiTable', 'fdiChartHeader',
    'fdiSectorsHeader', 'fdiSectorsTable',
    'companiesSummary',
    'appendixHeader', 'appendixTable',
  ];
  // Container rows whose `hidden` class we snapshot.
  const SNAPSHOT_ROW_IDS = [
    'tradeChartsRow', 'tourismRow', 'fdiRow', 'fdiSectorsCard',
  ];
  // Card-style headers — each lives inside a `.card` whose
  // `display` style is toggled by showCard / hideCard.
  const SNAPSHOT_CARD_HEADER_IDS = [
    'exportHeader', 'exportIncreaseHeader', 'exportDropHeader',
    'importHeader', 'importIncreaseHeader', 'importDropHeader',
  ];

  function captureReportSnapshot() {
    const panels = {};
    for (const id of SNAPSHOT_PANEL_IDS) {
      const el = document.getElementById(id);
      if (el) panels[id] = el.innerHTML;
    }
    const rowHidden = {};
    for (const id of SNAPSHOT_ROW_IDS) {
      const el = document.getElementById(id);
      if (el) rowHidden[id] = el.classList.contains('hidden');
    }
    const cardDisplay = {};
    for (const id of SNAPSHOT_CARD_HEADER_IDS) {
      const el = document.getElementById(id);
      const card = el && el.closest('.card');
      if (card) cardDisplay[id] = card.style.display || '';
    }
    // Deep-clone the data subtrees of pdfState that the renderers /
    // PDF builder consume. country / countryGrammar / countryNameEn
    // are rebound on restore from the live selectedCountry, so we
    // don't include them.
    const clone = (v) => v == null ? v : structuredClone(v);
    return {
      panels,
      rowHidden,
      cardDisplay,
      pdfState: {
        trade: clone(pdfState.trade),
        tourism: clone(pdfState.tourism),
        investments: clone(pdfState.investments),
        investmentsSectors: clone(pdfState.investmentsSectors),
        companies: clone(pdfState.companies),
        appendix: clone(pdfState.appendix),
      },
    };
  }

  function restoreReportSnapshot(snap) {
    // Tear down any live Chart.js instances bound to the canvases
    // we're about to repopulate.
    try { if (turnoverChartInstance) turnoverChartInstance.destroy(); } catch (_) {}
    try { if (dynamicsChartInstance) dynamicsChartInstance.destroy(); } catch (_) {}
    try { if (tourismChartInstance) tourismChartInstance.destroy(); } catch (_) {}
    try { if (fdiChartInstance) fdiChartInstance.destroy(); } catch (_) {}
    turnoverChartInstance = null;
    dynamicsChartInstance = null;
    tourismChartInstance = null;
    fdiChartInstance = null;
    try { const c = Chart.getChart(turnoverChartCanvas); if (c) c.destroy(); } catch (_) {}
    try { const c = Chart.getChart(dynamicsChartCanvas); if (c) c.destroy(); } catch (_) {}
    try { const c = Chart.getChart(tourismChartCanvas);  if (c) c.destroy(); } catch (_) {}
    try { const c = Chart.getChart(fdiChartCanvas);      if (c) c.destroy(); } catch (_) {}

    // Restore panel HTML.
    for (const id of SNAPSHOT_PANEL_IDS) {
      const el = document.getElementById(id);
      if (el && snap.panels[id] !== undefined) el.innerHTML = snap.panels[id];
    }
    // Restore row visibility.
    for (const id of SNAPSHOT_ROW_IDS) {
      const el = document.getElementById(id);
      if (el && snap.rowHidden[id] !== undefined) el.classList.toggle('hidden', !!snap.rowHidden[id]);
    }
    // Restore card display.
    for (const id of SNAPSHOT_CARD_HEADER_IDS) {
      const el = document.getElementById(id);
      const card = el && el.closest('.card');
      if (card && snap.cardDisplay[id] !== undefined) card.style.display = snap.cardDisplay[id];
    }

    // Rebind pdfState. country / countryNameEn / countryGrammar are
    // re-derived from the live selectedCountry so toggles between
    // languages pick up the right declension forms.
    pdfState.country = selectedCountry;
    pdfState.countryNameEn = selectedCountry
      ? (countryNameEnMap[selectedCountry.value] || selectedCountry.displayLabel)
      : null;
    pdfState.countryGrammar = selectedCountry
      ? grammarFor(selectedCountry.displayLabelKa || selectedCountry.displayLabel)
      : null;
    pdfState.trade = snap.pdfState.trade || null;
    pdfState.tourism = snap.pdfState.tourism || null;
    pdfState.investments = snap.pdfState.investments || null;
    pdfState.investmentsSectors = snap.pdfState.investmentsSectors || null;
    pdfState.companies = snap.pdfState.companies || null;
    pdfState.appendix = snap.pdfState.appendix || null;

    // Re-instantiate the four charts from cached args / pdfState data.
    if (pdfState.trade && pdfState.trade.chartArgs) {
      try { renderCharts(...pdfState.trade.chartArgs); } catch (e) { console.warn('[stats] trade chart replay failed', e); }
    }
    if (pdfState.tourism && pdfState.tourism.chartArgs) {
      try { renderTourismChart(...pdfState.tourism.chartArgs, reportLocale === 'ka'); } catch (e) { console.warn('[stats] tourism chart replay failed', e); }
    }
    if (pdfState.investments && pdfState.investments.tableData) {
      try { renderFdiChart(pdfState.investments.tableData, reportLocale === 'ka'); } catch (e) { console.warn('[stats] fdi chart replay failed', e); }
    }
  }

  // Unified generate — wipes state, shows a single top-level spinner,
  // runs all five section generators in parallel, and reveals the
  // sections only after every one has settled. Called from the
  // Generate button and from the report-language toggle. Cached
  // (country, locale) snapshots are replayed without refetching when
  // the user toggles back to a language they've already generated.
  async function runFullGenerate() {
    if (!selectedCountry) return;

    // Cache hit? Replay the snapshot, no fetch.
    const cacheEntry = reportCache.get(selectedCountry.value);
    const cached = cacheEntry && cacheEntry[reportLocale];
    if (cached) {
      statSections.classList.remove('hidden');
      restoreReportSnapshot(cached);
      return;
    }

    statSections.classList.remove('hidden');
    statSections.classList.add('is-loading');
    if (globalReportLoading) globalReportLoading.classList.remove('hidden');

    // Reset PDF state and wipe all stale UI so a following render
    // can't flash old content at the user.
    pdfState.country = selectedCountry;
    pdfState.trade = null;
    pdfState.tourism = null;
    pdfState.investments = null;
    pdfState.companies = null;
    pdfState.appendix = null;
    renderAppendix(null, reportLocale === 'ka');

    const latest = classData ? detectLatestPeriod(classData) : null;
    const tasks = [
      generateReport(),
      generateTourism(),
      generateInvestments(),
      generateCompanies(),
    ];
    if (latest) tasks.push(generateAppendix(latest.year, latest.month));

    try {
      await Promise.allSettled(tasks);
      // Cache the rendered snapshot so a back-and-forth language swap
      // is instant. Only cache if the trade section produced data —
      // otherwise the snapshot is mostly empty error/loading states.
      if (selectedCountry && pdfState.trade) {
        const entry = reportCache.get(selectedCountry.value) || {};
        entry[reportLocale] = captureReportSnapshot();
        reportCache.set(selectedCountry.value, entry);
      }
    } finally {
      statSections.classList.remove('is-loading');
      if (globalReportLoading) globalReportLoading.classList.add('hidden');
    }
  }

  generateBtn.addEventListener('click', () => {
    // Explicit Generate forces a fresh fetch — drop any cached
    // snapshots for the selected country so the user always sees
    // freshly-fetched data when they click the button.
    if (selectedCountry) reportCache.delete(selectedCountry.value);
    runFullGenerate();
  });

  async function generateReport() {
    if (!selectedCountry || !classData) return;

    reportLoading.classList.remove('hidden');

    // Clear all sections and hide product cards
    const allHeaders = [
      overviewHeader, exportHeader, exportIncreaseHeader, exportDropHeader,
      importHeader, importIncreaseHeader, importDropHeader,
      turnoverChartHeader, dynamicsChartHeader,
    ];
    const allTables = [
      overviewTable, exportTable, exportIncreaseTable, exportDropTable,
      importTable, importIncreaseTable, importDropTable,
    ];
    for (const el of allHeaders) el.innerHTML = '';
    for (const el of allTables) el.innerHTML = '';

    // Hide all product/change cards (they get shown when they have data)
    const hiddenCards = [
      exportHeader, exportIncreaseHeader, exportDropHeader,
      importHeader, importIncreaseHeader, importDropHeader,
    ];
    for (const el of hiddenCards) hideCard(el);

    try { if (turnoverChartInstance) turnoverChartInstance.destroy(); } catch (_) {}
    turnoverChartInstance = null;
    try { if (dynamicsChartInstance) dynamicsChartInstance.destroy(); } catch (_) {}
    dynamicsChartInstance = null;
    try { const ec1 = Chart.getChart(turnoverChartCanvas); if (ec1) ec1.destroy(); } catch (_) {}
    try { const ec2 = Chart.getChart(dynamicsChartCanvas); if (ec2) ec2.destroy(); } catch (_) {}

    try {
      const { year: latestYear, month: latestMonth } = detectLatestPeriod(classData);

      const monthsYTD = [];
      for (let m = 1; m <= latestMonth; m++) monthsYTD.push(m);

      const monthNames = classData.month || [];
      const firstMonthName = monthNames.find(m => m.value === 1)?.label || 'Jan';
      const lastMonthName = monthNames.find(m => m.value === latestMonth)?.label || `Month ${latestMonth}`;
      const periodLabel = monthsYTD.length === 1
        ? firstMonthName.slice(0, 3)
        : `${firstMonthName.slice(0, 3)}-${lastMonthName.slice(0, 3)}`;

      const prevYear = latestYear - 1;
      const prevPrevYear = latestYear - 2;
      const allMonths = [1,2,3,4,5,6,7,8,9,10,11,12];
      const countryId = selectedCountry.value;

      // Chart years: 5 previous full years
      const chartYears = [];
      for (let y = prevYear - 4; y <= prevYear; y++) chartYears.push(y);

      // Build all fetch promises
      const fetchPromises = [
        // Overview totals
        fetchTradeTotal(10, [prevYear], allMonths, countryId),
        fetchTradeTotal(10, [prevPrevYear], allMonths, countryId),
        fetchTradeTotal(10, [latestYear], monthsYTD, countryId),
        fetchTradeTotal(10, [prevYear], monthsYTD, countryId),
        fetchTradeTotal(11, [prevYear], allMonths, countryId),
        fetchTradeTotal(11, [prevPrevYear], allMonths, countryId),
        fetchTradeTotal(11, [latestYear], monthsYTD, countryId),
        fetchTradeTotal(11, [prevYear], monthsYTD, countryId),
        // Product tables
        fetchAllTradeData(10, [latestYear], monthsYTD, countryId),
        fetchAllTradeData(10, [prevYear], monthsYTD, countryId),
        fetchAllTradeData(13, [latestYear], monthsYTD, countryId),
        fetchAllTradeData(11, [latestYear], monthsYTD, countryId),
        fetchAllTradeData(11, [prevYear], monthsYTD, countryId),
      ];

      // Chart data: export & import for each of 5 years (full year)
      for (const y of chartYears) {
        fetchPromises.push(fetchTradeTotal(10, [y], allMonths, countryId)); // export
        fetchPromises.push(fetchTradeTotal(11, [y], allMonths, countryId)); // import
      }
      // Chart data: export & import for each month of current year
      for (const m of monthsYTD) {
        fetchPromises.push(fetchTradeTotal(10, [latestYear], [m], countryId));
        fetchPromises.push(fetchTradeTotal(11, [latestYear], [m], countryId));
      }

      const results = await Promise.all(fetchPromises);

      // Unpack overview & product table results (first 13)
      const [
        expFullCurr, expFullPrev, expMonthCurr, expMonthPrev,
        impFullCurr, impFullPrev, impMonthCurr, impMonthPrev,
        expHsCurrent, expHsPrev, reexHsCurrent,
        impHsCurrent, impHsPrev,
      ] = results;

      // Unpack chart year results (next chartYears.length * 2)
      let idx = 13;
      const chartYearExports = [];
      const chartYearImports = [];
      for (let i = 0; i < chartYears.length; i++) {
        chartYearExports.push(results[idx++] / 1000); // Thsd → Mln
        chartYearImports.push(results[idx++] / 1000);
      }

      // Unpack chart month results (next monthsYTD.length * 2)
      const chartMonthExports = [];
      const chartMonthImports = [];
      for (let i = 0; i < monthsYTD.length; i++) {
        chartMonthExports.push(results[idx++] / 1000);
        chartMonthImports.push(results[idx++] / 1000);
      }

      // ── 1. Trade overview table ──────────────────────────────────────
      const overview = buildOverviewData(
        { expFull: expFullCurr, expFullPrev: expFullPrev, impFull: impFullCurr, impFullPrev: impFullPrev },
        { expMonth: expMonthCurr, expMonthPrev: expMonthPrev, impMonth: impMonthCurr, impMonthPrev: impMonthPrev },
      );
      renderOverview(overview, prevYear, prevPrevYear, latestYear, latestMonth, periodLabel, monthNames);

      // ── 2. Charts ──────────────────────────────────────────────────────
      // Only render the turnover + dynamics charts if there's any trade
      // at all across the 5 lookback years, the YTD months, or the full-
      // year / YTD overviews. For countries with zero trade everywhere
      // (e.g. Cabo Verde) the charts would be all-zero columns — hide
      // the whole row instead.
      const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
      const hasAnyTrade =
        sum(chartYearExports) > 0 || sum(chartYearImports) > 0 ||
        sum(chartMonthExports) > 0 || sum(chartMonthImports) > 0 ||
        overview.fullYear.export > 0 || overview.fullYear.import > 0 ||
        overview.latestPeriod.export > 0 || overview.latestPeriod.import > 0;

      if (tradeChartsRowEl) tradeChartsRowEl.classList.toggle('hidden', !hasAnyTrade);

      // Stash for cache replay — language toggle re-runs renderCharts
      // from these without refetching.
      const tradeChartArgs = hasAnyTrade ? [
        chartYears, chartYearExports, chartYearImports,
        monthsYTD, chartMonthExports, chartMonthImports,
        latestYear, monthNames,
      ] : null;
      if (tradeChartArgs) renderCharts(...tradeChartArgs);

      // Check if there was any export/import in the latest period
      const hasExport = overview.latestPeriod.export > 0;
      const hasImport = overview.latestPeriod.import > 0;

      // Determine if export/import is increasing or declining in YTD
      const exportGrowing = overview.latestPeriod.export >= overview.latestPeriod.exportPrev;
      const importGrowing = overview.latestPeriod.import >= overview.latestPeriod.importPrev;

      // ── 3. Export products tables (only if export > 0) ─────────────
      if (hasExport) {
        const exportProducts = buildProductList(expHsCurrent, expHsPrev, reexHsCurrent);
        renderSectionHeader(exportHeader, 'export', periodLabel, latestYear);
        renderProductTable(exportTable, exportProducts, periodLabel, latestYear, true);
        showCard(exportHeader);

        const { increase, drop } = buildChangeLists(expHsCurrent, expHsPrev);
        if (exportGrowing) {
          if (increase.length > 0) {
            renderSectionHeader(exportIncreaseHeader, 'exportIncrease', periodLabel, latestYear);
            renderChangeTable(exportIncreaseTable, increase, periodLabel, latestYear);
            showCard(exportIncreaseHeader);
          }
          if (drop.length > 0) {
            renderSectionHeader(exportDropHeader, 'exportDrop', periodLabel, latestYear);
            renderChangeTable(exportDropTable, drop, periodLabel, latestYear);
            showCard(exportDropHeader);
          }
        } else {
          if (drop.length > 0) {
            renderSectionHeader(exportIncreaseHeader, 'exportDrop', periodLabel, latestYear);
            renderChangeTable(exportIncreaseTable, drop, periodLabel, latestYear);
            showCard(exportIncreaseHeader);
          }
          if (increase.length > 0) {
            renderSectionHeader(exportDropHeader, 'exportIncrease', periodLabel, latestYear);
            renderChangeTable(exportDropTable, increase, periodLabel, latestYear);
            showCard(exportDropHeader);
          }
        }
      }

      // ── 4. Import products tables (only if import > 0) ─────────────
      if (hasImport) {
        const importProducts = buildProductList(impHsCurrent, impHsPrev, null);
        renderSectionHeader(importHeader, 'import', periodLabel, latestYear);
        renderProductTable(importTable, importProducts, periodLabel, latestYear, false);
        showCard(importHeader);

        const { increase: impIncrease, drop: impDrop } = buildChangeLists(impHsCurrent, impHsPrev);
        if (importGrowing) {
          if (impIncrease.length > 0) {
            renderSectionHeader(importIncreaseHeader, 'importIncrease', periodLabel, latestYear);
            renderChangeTable(importIncreaseTable, impIncrease, periodLabel, latestYear);
            showCard(importIncreaseHeader);
          }
          if (impDrop.length > 0) {
            renderSectionHeader(importDropHeader, 'importDrop', periodLabel, latestYear);
            renderChangeTable(importDropTable, impDrop, periodLabel, latestYear);
            showCard(importDropHeader);
          }
        } else {
          if (impDrop.length > 0) {
            renderSectionHeader(importIncreaseHeader, 'importDrop', periodLabel, latestYear);
            renderChangeTable(importIncreaseTable, impDrop, periodLabel, latestYear);
            showCard(importIncreaseHeader);
          }
          if (impIncrease.length > 0) {
            renderSectionHeader(importDropHeader, 'importIncrease', periodLabel, latestYear);
            renderChangeTable(importDropTable, impIncrease, periodLabel, latestYear);
            showCard(importDropHeader);
          }
        }
      }

      // Fetch ranking + share for the PDF trade-summary paragraph. If it
      // fails, store null and let the PDF builder render without those
      // sentences rather than blocking the whole generation.
      let ranking = null;
      const ctrl = new AbortController();
      const rankTimer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        console.log('[ranking] fetching...', { year: latestYear, months: monthsYTD, countryId: selectedCountry.value });
        const rankRes = await fetch(`${PROXY_API}/country-ranking`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year: latestYear, months: monthsYTD, countryId: selectedCountry.value }),
          signal: ctrl.signal,
        });
        console.log('[ranking] response status:', rankRes.status);
        const j = await rankRes.json().catch((e) => { console.warn('[ranking] json parse failed:', e.message); return null; });
        console.log('[ranking] body:', JSON.stringify(j));
        if (rankRes.ok && j && j.success && j.country) {
          const hasTurnover = !!(j.country.turnover);
          const hasExport = !!(j.country.export);
          const hasImport = !!(j.country.import);
          console.log('[ranking] ✓ has data — turnover:', hasTurnover, 'export:', hasExport, 'import:', hasImport);
          ranking = { country: j.country, totals: j.totals };
        } else {
          console.warn('[ranking] ✗ no usable data in response');
        }
      } catch (err) {
        console.warn('[ranking] fetch failed:', err.message);
      } finally {
        clearTimeout(rankTimer);
      }

      // ── Capture PDF state ────────────────────────────────────────────
      pdfState.country = selectedCountry;
      pdfState.countryNameEn = countryNameEnMap[selectedCountry.value] || selectedCountry.displayLabel;
      // Georgian declined forms (nom / withCase / inCase / from / of)
      // — PDF builder uses `.from` for "from X" sentences.
      pdfState.countryGrammar = grammarFor(selectedCountry.displayLabelKa || selectedCountry.displayLabel);
      pdfState.trade = {
        overview,
        prevYear, prevPrevYear, latestYear, latestMonth,
        periodLabel, monthNames,
        hasExport, hasImport, exportGrowing, importGrowing,
        exportProducts: hasExport ? buildProductList(expHsCurrent, expHsPrev, reexHsCurrent) : null,
        importProducts: hasImport ? buildProductList(impHsCurrent, impHsPrev, null) : null,
        exportChange: hasExport ? buildChangeLists(expHsCurrent, expHsPrev) : null,
        importChange: hasImport ? buildChangeLists(impHsCurrent, impHsPrev) : null,
        ranking,
        // For countries with zero trade across the whole lookback window,
        // the summary widens the "no trade" sentence from the latest
        // period alone ("2026 Jan-Feb") to the full range ("2021-2026
        // Jan-Feb"). Both flags are picked up by renderTradeSummary (web)
        // and buildTradeSummary (PDF).
        hasAnyTrade,
        fiveYearStart: chartYears.length ? chartYears[0] : latestYear,
        // Cached args for renderCharts so a language-toggle replay can
        // rebuild the trade charts without re-fetching.
        chartArgs: tradeChartArgs,
      };

      renderTradeSummary(pdfState.trade, ranking, selectedCountry.displayLabel);

    } catch (err) {
      console.error('Report generation error:', err);
      overviewTable.innerHTML = `<div class="msg msg-error">${escapeHtml(I18n.tr('statistics.reportFailed'))} ${escapeHtml(err.message)}</div>`;
    } finally {
      reportLoading.classList.add('hidden');
      exportPdfBtn.disabled = false;
      if (exportWordBtn) exportWordBtn.disabled = false;
    }
  }

  // ── Fetch trade total (single value, no HS breakdown) ──────────────────

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

    // Use the isGroupSummary row (it's already the total), skip individual rows
    if (Array.isArray(json.data)) {
      for (const row of json.data) {
        if (row.isGroupSummary) return extractValue(row);
      }
      // If no summary row, use first row only
      if (json.data.length > 0) return extractValue(json.data[0]);
    }
    return 0;
  }

  // ── Fetch all trade data with HS breakdown (paginated) ─────────────────

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

  // ── Build overview data ────────────────────────────────────────────────

  function buildOverviewData(full, month) {
    const expFullMln = full.expFull / 1000;
    const expFullPrevMln = full.expFullPrev / 1000;
    const impFullMln = full.impFull / 1000;
    const impFullPrevMln = full.impFullPrev / 1000;

    const expMonthMln = month.expMonth / 1000;
    const expMonthPrevMln = month.expMonthPrev / 1000;
    const impMonthMln = month.impMonth / 1000;
    const impMonthPrevMln = month.impMonthPrev / 1000;

    return {
      fullYear: {
        turnover: expFullMln + impFullMln,
        turnoverPrev: expFullPrevMln + impFullPrevMln,
        export: expFullMln,
        exportPrev: expFullPrevMln,
        import: impFullMln,
        importPrev: impFullPrevMln,
        balance: expFullMln - impFullMln,
      },
      latestPeriod: {
        turnover: expMonthMln + impMonthMln,
        turnoverPrev: expMonthPrevMln + impMonthPrevMln,
        export: expMonthMln,
        exportPrev: expMonthPrevMln,
        import: impMonthMln,
        importPrev: impMonthPrevMln,
        balance: expMonthMln - impMonthMln,
      },
    };
  }

  // ── Render trade summary (above overview table) ─────────────────────────

  function renderTradeSummary(trade, ranking, countryName) {
    if (!tradeSummaryEl || !trade) return;
    const isKa = reportLocale === 'ka';
    const year = trade.latestYear;
    const lm = trade.latestMonth;
    const mn = trade.monthNames || [];
    const rank = ranking && ranking.country ? ranking.country : null;
    // Trade ranks below the top 20 aren't useful in the prose ("47th
    // among partners" tells the reader the partner isn't material).
    // Hide that sentence when rank > 20; the table still shows the
    // actual rank — only the prose is suppressed.
    const TOP_RANK_LIMIT = 20;
    const inTop = (r) => r && r.rank <= TOP_RANK_LIMIT;
    const ov = trade.overview;

    const periodGen = isKa
      ? (lm === 12 ? `${year} წლის` : lm === 1 ? `${year} წლის ${KA_MONTH_GEN[1]}` : `${year} წლის ${KA_MONTH_STEM[1]}-${KA_MONTH_GEN[lm]}`)
      : (lm === 12 ? `${year}` : lm === 1 ? `${(mn.find(m => m.value === 1)?.label || 'Jan').slice(0, 3)} ${year}` : `${(mn.find(m => m.value === 1)?.label || 'Jan').slice(0, 3)}-${(mn.find(m => m.value === lm)?.label || '').slice(0, 3)} ${year}`);
    const periodLoc = isKa
      ? (lm === 12 ? `${year} წელს` : lm === 1 ? `${year} წლის ${KA_MONTH_LOC[1]}` : `${year} წლის ${KA_MONTH_STEM[1]}-${KA_MONTH_LOC[lm]}`)
      : periodGen;

    // Expanded "no trade" period label: 5-year lookback + latest period
    // month range, e.g. "2021-2026 წლის იანვარ-თებერვლის".
    const startYear = trade.fiveYearStart || year;
    const periodGenRange = isKa
      ? (lm === 12 ? `${startYear}-${year} წლების` : lm === 1 ? `${startYear}-${year} წლის ${KA_MONTH_GEN[1]}` : `${startYear}-${year} წლის ${KA_MONTH_STEM[1]}-${KA_MONTH_GEN[lm]}`)
      : (lm === 12 ? `${startYear}-${year}` : lm === 1 ? `${(mn.find(m => m.value === 1)?.label || 'Jan').slice(0, 3)} ${startYear}-${year}` : `${(mn.find(m => m.value === 1)?.label || 'Jan').slice(0, 3)}-${(mn.find(m => m.value === lm)?.label || '').slice(0, 3)} ${startYear}-${year}`);

    function b(s) { return `<strong>${escapeHtml(s)}</strong>`; }
    function i(s) { return `<em>${escapeHtml(s)}</em>`; }
    function fmln(v) { return formatMln2(Math.abs(v)); }
    function pctI(x) { return Math.round(Math.abs(x)); }
    function pctO(x) { return (Math.round(x * 10) / 10).toFixed(1); }
    function chg(cur, prev) {
      const c = cur && prev ? ((cur - prev) / Math.abs(prev)) * 100 : (cur > 0 ? 100 : 0);
      const abs = pctI(c);
      if (isKa) return b(`${c >= 0 ? 'გაიზარდა' : 'შემცირდა'} ${abs}%-ით`);
      return b(`${c >= 0 ? 'increased' : 'decreased'} by ${abs}%`);
    }
    function geP(r) {
      if (r === 1) return 'პირველ';
      if (r >= 2 && r <= 20) return `მე-${r}`;
      if (r % 10 === 0) return `მე-${r}`;
      if (r % 100 === 0) return `მე-${r}`;
      return `${r}-ე`;
    }
    function enO(r) {
      const n = Math.abs(r); const m = n % 100;
      if (m >= 11 && m <= 13) return `${n}th`;
      switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th`; }
    }

    function productListHtml(products) {
      if (!products || !products.length) return '';
      return products.slice(0, 10).map(p => {
        const name = isKa ? p.name : (p.nameEn || p.name);
        const sign = p.change > 0 ? '+' : '';
        const unit = isKa ? 'მლნ. $' : 'mln $';
        return `${escapeHtml(name)} <em>(${fmln(p.valueMln)} ${unit}, ${sign}${formatChangePct(p.change)})</em>`;
      }).join(', ') + '.';
    }

    const lines = [];
    const curTurn = ov.latestPeriod.turnover, prevTurn = ov.latestPeriod.turnoverPrev;
    const curExp = ov.latestPeriod.export, prevExp = ov.latestPeriod.exportPrev;
    const curImp = ov.latestPeriod.import, prevImp = ov.latestPeriod.importPrev;

    // Turnover
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover'}</h4>`);
    if (curTurn < 0.01) {
      // Zero trade in the latest period alone → single-period label.
      // Zero trade across the whole 5-year + latest window → widened
      // label that spans the full lookback.
      const noTradeLabel = trade.hasAnyTrade === false ? periodGenRange : periodGen;
      lines.push(`<p>${isKa ? `${noTradeLabel} მონაცემებით, ვაჭრობა არ განხორციელდა.` : `For ${escapeHtml(noTradeLabel)}, no trade was conducted.`}</p>`);
      tradeSummaryEl.innerHTML = lines.join('');
      tradeSummaryEl.classList.remove('hidden');
      return;
    }
    if (isKa) {
      lines.push(`<p>${periodGen} მონაცემებით, სავაჭრო ბრუნვა, წინა წლის ანალოგიურ პერიოდთან შედარებით, ${chg(curTurn, prevTurn)} და ${b(`${fmln(curTurn)} მლნ. აშშ დოლარი`)} შეადგინა.</p>`);
      if (inTop(rank && rank.turnover)) {
        lines.push(`<p>${escapeHtml(countryName)} აღნიშნულ პერიოდში სავაჭრო ბრუნვის მოცულობის მიხედვით არის ${b(`${geP(rank.turnover.rank)} ადგილზე`)}, წილი ${b(`${pctO(rank.turnover.sharePct)}%`)}.</p>`);
      }
    } else {
      lines.push(`<p>For ${escapeHtml(periodGen)}, trade turnover ${chg(curTurn, prevTurn)} compared to the same period last year, amounting to ${b(`${fmln(curTurn)} mln USD`)}.</p>`);
      if (inTop(rank && rank.turnover)) {
        lines.push(`<p>${escapeHtml(countryName)} ranks ${b(enO(rank.turnover.rank))} by trade turnover with a ${b(`${pctO(rank.turnover.sharePct)}%`)} share.</p>`);
      }
    }

    // Export
    lines.push(`<hr class="stat-summary__divider">`);
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'ექსპორტი' : 'Export'}</h4>`);
    if (trade.hasExport && curExp >= 0.01) {
      if (isKa) {
        let exp = `<p>ექსპორტი ${periodLoc} ${chg(curExp, prevExp)} და ${b(`${fmln(curExp)} მლნ. აშშ დოლარი`)} შეადგინა.`;
        if (inTop(rank && rank.export)) exp += ` საქართველოსთვის ექსპორტის მიხედვით ${escapeHtml(countryName)} არის ${b(`${geP(rank.export.rank)} ადგილზე`)} საქართველოს სავაჭრო პარტნიორებს შორის, წილი ${b(`${pctO(rank.export.sharePct)}%`)}.`;
        exp += '</p>';
        lines.push(exp);
      } else {
        let exp = `<p>Exports in ${escapeHtml(periodGen)} ${chg(curExp, prevExp)}, amounting to ${b(`${fmln(curExp)} mln USD`)}.`;
        if (inTop(rank && rank.export)) exp += ` ${escapeHtml(countryName)} ranks ${b(enO(rank.export.rank))} by export volume with a ${b(`${pctO(rank.export.sharePct)}%`)} share.`;
        exp += '</p>';
        lines.push(exp);
      }

      if (rank && rank.domesticExport && curExp > 0) {
        const domVal = rank.domesticExport.valueMln;
        const domPct = (100 * domVal / curExp).toFixed(0);
        const reVal = rank.reExport ? rank.reExport.valueMln : (curExp - domVal);
        const rePct = (100 * reVal / curExp).toFixed(0);
        // Volumes stay regardless; only the rank sentence drops when > 20.
        const geRankSent = inTop(rank.domesticExport)
          ? ` ადგილობრივი ექსპორტით ${escapeHtml(countryName)} იკავებს ${b(`${geP(rank.domesticExport.rank)} ადგილს`)} საქართველოს სავაჭრო პარტნიორებს შორის.`
          : '';
        const enRankSent = inTop(rank.domesticExport)
          ? ` By domestic exports, ${escapeHtml(countryName)} ranks ${b(enO(rank.domesticExport.rank))} among Georgia's trading partners.`
          : '';
        if (isKa) {
          lines.push(`<p>${periodGen} პერიოდში განხორციელდა ${b(`${fmln(domVal)} მლნ. აშშ დოლარის`)} ${b('ადგილობრივი ექსპორტი')}, რაც შეადგენს ${b(`${domPct}%-ს`)} სრული ექსპორტის.${geRankSent} რე-ექსპორტმა იმავე პერიოდში შეადგინა ${b(`${fmln(reVal)} მლნ. აშშ დოლარი`)} <em>(წილი ${rePct}%)</em>.</p>`);
        } else {
          lines.push(`<p>In the given period, domestic exports amounted to ${b(`${fmln(domVal)} mln USD`)}, comprising ${b(`${domPct}%`)} of total exports.${enRankSent} Re-exports in the same period amounted to ${b(`${fmln(reVal)} mln USD`)} <em>(${rePct}% share)</em>.</p>`);
        }
      }

      const pl = productListHtml(trade.exportProducts);
      if (pl) lines.push(`<p>${b(isKa ? 'ძირითადი საექსპორტო პროდუქცია:' : 'Main export products:')} ${pl}</p>`);
    } else {
      lines.push(`<p>${isKa ? 'ექსპორტი არ განხორციელდა.' : 'No exports were conducted.'}</p>`);
    }

    // Import
    lines.push(`<hr class="stat-summary__divider">`);
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'იმპორტი' : 'Import'}</h4>`);
    if (trade.hasImport && curImp >= 0.01) {
      if (isKa) {
        let imp = `<p>იმპორტი ${periodLoc} ${chg(curImp, prevImp)} და ${b(`${fmln(curImp)} მლნ. აშშ დოლარი`)} შეადგინა.`;
        if (inTop(rank && rank.import)) imp += ` იმპორტის მიხედვით ${escapeHtml(countryName)} არის ${b(`${geP(rank.import.rank)} ადგილზე`)} საქართველოს სავაჭრო პარტნიორებს შორის, წილი ${b(`${pctO(rank.import.sharePct)}%`)}.`;
        imp += '</p>';
        lines.push(imp);
      } else {
        let imp = `<p>Imports in ${escapeHtml(periodGen)} ${chg(curImp, prevImp)}, amounting to ${b(`${fmln(curImp)} mln USD`)}.`;
        if (inTop(rank && rank.import)) imp += ` ${escapeHtml(countryName)} ranks ${b(enO(rank.import.rank))} by import volume with a ${b(`${pctO(rank.import.sharePct)}%`)} share.`;
        imp += '</p>';
        lines.push(imp);
      }

      const pl = productListHtml(trade.importProducts);
      if (pl) lines.push(`<p>${b(isKa ? 'ძირითადი საიმპორტო პროდუქცია:' : 'Main import products:')} ${pl}</p>`);
    } else {
      lines.push(`<p>${isKa ? 'იმპორტი არ განხორციელდა.' : 'No imports were conducted.'}</p>`);
    }

    tradeSummaryEl.innerHTML = lines.join('');
    tradeSummaryEl.classList.remove('hidden');
  }

  // Georgian month forms for the on-page summary
  const KA_MONTH_STEM = { 1:'იანვარ', 2:'თებერვალ', 3:'მარტ', 4:'აპრილ', 5:'მაის', 6:'ივნის', 7:'ივლის', 8:'აგვისტო', 9:'სექტემბერ', 10:'ოქტომბერ', 11:'ნოემბერ', 12:'დეკემბერ' };
  const KA_MONTH_GEN = { 1:'იანვრის', 2:'თებერვლის', 3:'მარტის', 4:'აპრილის', 5:'მაისის', 6:'ივნისის', 7:'ივლისის', 8:'აგვისტოს', 9:'სექტემბრის', 10:'ოქტომბრის', 11:'ნოემბრის', 12:'დეკემბრის' };
  const KA_MONTH_LOC = { 1:'იანვარში', 2:'თებერვალში', 3:'მარტში', 4:'აპრილში', 5:'მაისში', 6:'ივნისში', 7:'ივლისში', 8:'აგვისტოში', 9:'სექტემბერში', 10:'ოქტომბერში', 11:'ნოემბერში', 12:'დეკემბერში' };

  // ── Render trade overview ──────────────────────────────────────────────

  function renderOverview(data, prevYear, prevPrevYear, latestYear, latestMonth, periodLabel, monthNames) {
    const isKa = reportLocale === 'ka';

    const monthLabel = monthNames.find(m => m.value === latestMonth)?.label || `${latestMonth}`;
    const colFull = `${prevYear}`;
    const colMonth = `${latestYear} .${String(latestMonth).padStart(2, '0')}`;

    overviewHeader.innerHTML = `<h3 class="stat-report__title">${escapeHtml(selectedCountry.displayLabel)} - ${isKa ? 'სავაჭრო მიმოხილვა' : 'Trade Overview'}</h3>`;

    const rows = [
      { key: 'turnover', label: isKa ? 'ბრუნვა' : 'Trade Turnover' },
      { key: 'export', label: isKa ? 'ექსპორტი' : 'Export' },
      { key: 'import', label: isKa ? 'იმპორტი' : 'Import' },
      { key: 'balance', label: isKa ? 'ბალანსი' : 'Balance' },
    ];

    const mln = isKa ? 'მლნ. აშშ დოლარი' : 'mln USD';
    const increaseWord = isKa ? 'ზრდა' : 'increase';
    const decreaseWord = isKa ? 'კლება' : 'decrease';
    const negativeWord = isKa ? 'ნეგატიური' : 'negative';
    const positiveWord = isKa ? 'პოზიტიური' : 'positive';
    const zeroMessages = {
      turnover: isKa ? 'ვაჭრობა არ განხორციელდა' : 'No trade conducted',
      export: isKa ? 'ექსპორტი არ განხორციელდა' : 'No exports conducted',
      import: isKa ? 'იმპორტი არ განხორციელდა' : 'No imports conducted',
    };

    function formatCell(value, prevValue, isBalance, key, periodData) {
      // If turnover is 0, balance shows "-"
      if (isBalance && periodData.turnover === 0) return '-';
      // Zero value messages
      if (value === 0 && !isBalance && zeroMessages[key]) return zeroMessages[key];
      if (isBalance) {
        const sign = value < 0 ? negativeWord : positiveWord;
        return `${sign} ${formatMln2(value)} ${mln}`;
      }
      const pct = calcChange(value, prevValue);
      const dir = pct >= 0 ? increaseWord : decreaseWord;
      return `${formatMln2(Math.abs(value))} ${mln}, ${dir} ${formatChangePct(pct)}`;
    }

    let html = `<table class="stat-table stat-overview-table">
      <thead>
        <tr>
          <th></th>
          <th class="stat-col-overview">${colFull}</th>
          <th class="stat-col-overview">${colMonth}</th>
        </tr>
      </thead>
      <tbody>`;

    for (const r of rows) {
      const isBalance = r.key === 'balance';
      const fullVal = data.fullYear[r.key];
      const fullPrev = data.fullYear[r.key + 'Prev'];
      const monthVal = data.latestPeriod[r.key];
      const monthPrev = data.latestPeriod[r.key + 'Prev'];

      html += `
        <tr>
          <td class="stat-overview-label">${escapeHtml(r.label)}</td>
          <td class="stat-col-overview">${formatCell(fullVal, fullPrev, isBalance, r.key, data.fullYear)}</td>
          <td class="stat-col-overview">${formatCell(monthVal, monthPrev, isBalance, r.key, data.latestPeriod)}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    overviewTable.innerHTML = html;
  }

  // ── Change % calculation ───────────────────────────────────────────────

  function calcChange(current, previous) {
    if (!previous || previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / Math.abs(previous)) * 100;
  }

  // ── Format change % — full integers, decimals only between -1 and +1 ──

  function formatChangePct(pct) {
    const rounded = Math.round(pct);
    // If it rounds to 0 but isn't actually 0, use one decimal
    if (rounded === 0 && pct !== 0) {
      return pct.toFixed(1) + '%';
    }
    return rounded + '%';
  }

  // ── Format millions (for overview: 2 decimal places with comma thousands)

  function formatMln2(val) {
    return val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ── Build product list ─────────────────────────────────────────────────

  // ── Render charts ─────────────────────────────────────────────────────────

  function renderCharts(
    chartYears, yearExports, yearImports,
    monthsYTD, monthExports, monthImports,
    latestYear, monthNames,
  ) {
    const isKa = reportLocale === 'ka';

    // Build labels: "2021", "2022", ... "2025", "Jan-Feb'26"
    const labels = chartYears.map(String);
    const shortYear = String(latestYear).slice(2);

    // Sum months into a single YTD bar
    const ytdExport = monthExports.reduce((s, v) => s + v, 0);
    const ytdImport = monthImports.reduce((s, v) => s + v, 0);

    if (monthsYTD.length === 1) {
      const mName = monthNames.find(mn => mn.value === monthsYTD[0])?.label || `M${monthsYTD[0]}`;
      labels.push(`${mName.slice(0, 3)}'${shortYear}`);
    } else {
      const first = monthNames.find(mn => mn.value === monthsYTD[0])?.label || '';
      const last = monthNames.find(mn => mn.value === monthsYTD[monthsYTD.length - 1])?.label || '';
      labels.push(`${first.slice(0, 3)}-${last.slice(0, 3)}'${shortYear}`);
    }

    // Turnover data = export + import
    const turnoverData = [
      ...yearExports.map((e, i) => e + yearImports[i]),
      ytdExport + ytdImport,
    ];

    // Common chart options
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: true,
      layout: { padding: { top: 24 } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true },
        datalabels: {
          anchor: 'end',
          align: 'end',
          font: { size: 11, weight: '600' },
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
    };

    // ── Turnover chart ─────────────────────────────────────────────
    turnoverChartHeader.innerHTML = `<h3 class="stat-report__title">${isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover'}</h3>`;

    turnoverChartInstance = new Chart(turnoverChartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: turnoverData,
          backgroundColor: turnoverData.map((_, i) => i < chartYears.length ? '#3b82f6' : '#60a5fa'),
          borderRadius: 3,
        }],
      },
      options: {
        ...commonOptions,
        plugins: {
          ...commonOptions.plugins,
          datalabels: {
            ...commonOptions.plugins.datalabels,
            color: '#374151',
          },
        },
      },
      plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
    });

    // ── Export–Import dynamics chart ────────────────────────────────
    const expLabel = isKa ? 'ექსპორტი' : 'Export';
    const impLabel = isKa ? 'იმპორტი' : 'Import';
    dynamicsChartHeader.innerHTML = `
      <div class="stat-chart-title-row">
        <h3 class="stat-report__title">${isKa ? 'ექსპორტ-იმპორტის დინამიკა' : 'Export–Import Dynamics'}</h3>
        <div class="stat-chart-legend">
          <div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:#16a34a"></span>${escapeHtml(expLabel)}</div>
          <div class="stat-chart-legend__item"><span class="stat-chart-legend__color" style="background:#dc2626"></span>${escapeHtml(impLabel)}</div>
        </div>
      </div>`;

    const expData = [...yearExports, ytdExport];
    const impData = [...yearImports, ytdImport];

    dynamicsChartInstance = new Chart(dynamicsChartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: isKa ? 'ექსპორტი' : 'Export',
            data: expData,
            backgroundColor: expData.map((_, i) => i < chartYears.length ? '#16a34a' : '#4ade80'),
            borderRadius: 3,
          },
          {
            label: isKa ? 'იმპორტი' : 'Import',
            data: impData,
            backgroundColor: impData.map((_, i) => i < chartYears.length ? '#dc2626' : '#f87171'),
            borderRadius: 3,
          },
        ],
      },
      options: {
        ...commonOptions,
        plugins: {
          ...commonOptions.plugins,
          legend: { display: false },
          datalabels: {
            ...commonOptions.plugins.datalabels,
            color: '#374151',
            font: { size: 10, weight: '600' },
          },
        },
      },
      plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
    });
  }

  // ── Chart data label formatter ───────────────────────────────────────────

  function chartLabel(val) {
    return val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ── Build product list ─────────────────────────────────────────────────

  // ── Build export increase / drop lists ──────────────────────────────────
  // Sorted by absolute USD difference (not percentage)

  function buildChangeLists(currentData, prevData) {
    // Build current map: hs4 → { name, valueThdUsd }
    const currentMap = {};
    for (const row of currentData) {
      if (row.isGroupSummary || !row.hs4) continue;
      const val = extractValue(row);
      if (!currentMap[row.hs4]) {
        currentMap[row.hs4] = { hs4: row.hs4, name: cleanHs4Name(row.hs4_name || `HS ${row.hs4}`, row.hs4), nameEn: cleanHs4NameEn(row.hs4_name || `HS ${row.hs4}`, row.hs4), valueThdUsd: 0 };
      }
      currentMap[row.hs4].valueThdUsd += val;
    }

    // Build prev map: hs4 → { valueThdUsd, name }
    const prevMap = {};
    for (const row of prevData) {
      if (row.isGroupSummary || !row.hs4) continue;
      const val = extractValue(row);
      if (!prevMap[row.hs4]) {
        prevMap[row.hs4] = { valueThdUsd: 0, name: cleanHs4Name(row.hs4_name || `HS ${row.hs4}`, row.hs4), nameEn: cleanHs4NameEn(row.hs4_name || `HS ${row.hs4}`, row.hs4) };
      }
      prevMap[row.hs4].valueThdUsd += val;
    }

    // Merge all HS4 codes from both periods
    const allHs4 = new Set([...Object.keys(currentMap), ...Object.keys(prevMap)]);
    const products = [];
    for (const hs4 of allHs4) {
      const curr = currentMap[hs4]?.valueThdUsd || 0;
      const prev = prevMap[hs4]?.valueThdUsd || 0;
      const diffThd = curr - prev;
      const diffMln = diffThd / 1000;
      const currMln = curr / 1000;
      const prevMln = prev / 1000;
      const name = currentMap[hs4]?.name || prevMap[hs4]?.name || `HS ${hs4}`;
      const nameEn = currentMap[hs4]?.nameEn || prevMap[hs4]?.nameEn || `HS ${hs4}`;
      const changePct = prevMln > 0
        ? ((currMln - prevMln) / prevMln * 100)
        : (currMln > 0 ? 100 : 0);
      products.push({ name, nameEn, valueMln: currMln, changePct, diffMln });
    }

    // Increase: positive diff, sorted by diff descending, max 15, min 0.01 mln diff
    const increased = products
      .filter(p => p.diffMln > 0)
      .sort((a, b) => b.diffMln - a.diffMln)
      .filter(p => p.diffMln >= 0.01)
      .slice(0, 10);

    // Drop: negative diff, sorted by diff ascending (most negative first), max 10
    const dropped = products
      .filter(p => p.diffMln < 0)
      .sort((a, b) => a.diffMln - b.diffMln)
      .filter(p => p.diffMln <= -0.01)
      .slice(0, 10);

    return { increase: increased, drop: dropped };
  }

  // ── Render change table (increase / drop) ────────────────────────────────

  function renderChangeTable(el, products, periodLabel, year) {
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>${reportLocale === 'ka' ? 'მონაცემები ვერ მოიძებნა' : 'No data found'}</p></div>`;
      return;
    }

    const isKa = reportLocale === 'ka';
    const hProduct = isKa ? 'პროდუქცია (HS 4-ნიშნა)' : 'Product (HS 4-digit)';
    const hValue = isKa ? `${periodLabel} ${year}<br>მლნ. $` : `${periodLabel} ${year}<br>mln $`;
    const hChange = isKa ? 'ცვლილება<br>%' : 'Change<br>%';
    const hDiff = isKa ? 'სხვაობა<br>მლნ. $' : 'Difference<br>mln $';

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th class="stat-col-product">${hProduct}</th>
          <th class="stat-col-value">${hValue}</th>
          <th class="stat-col-change">${hChange}</th>
          <th class="stat-col-diff">${hDiff}</th>
        </tr>
      </thead>
      <tbody>`;

    for (const p of products) {
      const changeClass = p.changePct > 0 ? 'stat-positive' : (p.changePct < 0 ? 'stat-negative' : '');
      const changeSign = p.changePct > 0 ? '+' : '';
      const diffSign = p.diffMln > 0 ? '+' : '';
      const diffClass = p.diffMln > 0 ? 'stat-positive' : 'stat-negative';
      // No trade happened for this product in the current period → show
      // "-" rather than "0.00" so the absence reads clearly.
      const valueCell = p.valueMln > 0 ? formatMln(p.valueMln) : '-';
      html += `
        <tr>
          <td class="stat-col-product">${escapeHtml(reportLocale !== 'ka' && p.nameEn ? p.nameEn : p.name)}</td>
          <td class="stat-col-value">${valueCell}</td>
          <td class="stat-col-change ${changeClass}">${changeSign}${formatChangePct(p.changePct)}</td>
          <td class="stat-col-diff ${diffClass}">${diffSign}${formatMln(Math.abs(p.diffMln))}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    el.innerHTML = html;
  }

  // ── Build product list ─────────────────────────────────────────────────

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

  // ── Extract numeric value from a data row ────────────────────────────────

  function extractValue(row) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('usd1000_')) {
        const v = parseFloat(row[key]);
        if (!isNaN(v)) return v;
      }
    }
    return 0;
  }

  // ── Clean HS4 name ───────────────────────────────────────────────────────

  // ── Show / hide parent card ───────────────────────────────────────────────

  function showCard(el) {
    const card = el.closest('.card');
    if (card) card.style.display = '';
  }

  function hideCard(el) {
    const card = el.closest('.card');
    if (card) card.style.display = 'none';
  }

  function cleanHs4Name(name, hs4Code) {
    if (hs4Code && hs4NameMap[hs4Code]) return hs4NameMap[hs4Code];
    return name.replace(/^\d{2,6}\s+/, '');
  }

  function cleanHs4NameEn(name, hs4Code) {
    if (hs4Code && hs4NameMapEn[hs4Code]) return hs4NameMapEn[hs4Code];
    // Don't fall back to Georgian name — use HS code instead
    return `HS ${hs4Code || '????'}`;
  }

  // ── Render section header ────────────────────────────────────────────────

  function renderSectionHeader(el, type, periodLabel, year) {
    const isKa = reportLocale === 'ka';
    const labels = {
      export: isKa ? 'ძირითადი საექსპორტო პროდუქცია' : 'Main Export Products',
      import: isKa ? 'ძირითადი საიმპორტო პროდუქცია' : 'Main Import Products',
      exportIncrease: isKa ? 'ექსპორტში ყველაზე მეტად გაზრდილი პროდუქცია' : 'Most Increased Export Products',
      exportDrop: isKa ? 'ექსპორტში ყველაზე მეტად შემცირებული პროდუქცია' : 'Most Decreased Export Products',
      importIncrease: isKa ? 'იმპორტში ყველაზე მეტად გაზრდილი პროდუქცია' : 'Most Increased Import Products',
      importDrop: isKa ? 'იმპორტში ყველაზე მეტად შემცირებული პროდუქცია' : 'Most Decreased Import Products',
    };
    const t = `${selectedCountry.displayLabel} - ${labels[type]}, ${periodLabel} ${year}`;
    el.innerHTML = `<h3 class="stat-report__title">${escapeHtml(t)}</h3>`;
  }

  // ── Render product table ─────────────────────────────────────────────────

  function renderProductTable(el, products, periodLabel, year, showReexport) {
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>${reportLocale === 'ka' ? 'მონაცემები ვერ მოიძებნა' : 'No data found'}</p></div>`;
      return;
    }

    const isKa = reportLocale === 'ka';
    const hProduct = isKa ? 'პროდუქცია (HS 4-ნიშნა)' : 'Product (HS 4-digit)';
    const hValue = isKa ? `${periodLabel} ${year}<br>მლნ. $` : `${periodLabel} ${year}<br>mln $`;
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
      const hiddenStyle = (hasMore && i >= INITIAL_COUNT) ? ' style="display:none" data-expandable' : '';
      html += `
        <tr${hiddenStyle}>
          <td class="stat-col-product">${escapeHtml(reportLocale !== 'ka' && p.nameEn ? p.nameEn : p.name)}</td>
          <td class="stat-col-value">${formatMln(p.valueMln)}</td>
          <td class="stat-col-change ${changeClass}">${changeSign}${formatChangePct(p.change)}</td>
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

    // Wire up expand/collapse
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

  // ── Format millions (for product tables) ─────────────────────────────────

  function formatMln(val) {
    let str;
    if (val >= 100) str = val.toFixed(1);
    else if (val >= 10) str = val.toFixed(2);
    else if (val >= 0.01) str = val.toFixed(2);
    else if (val > 0) str = val.toFixed(3);
    else str = '0.00';
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── TOURISM TAB ────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  // Resolve the selected country to GNTA country name.
  // The country has two labels: displayLabel (canonical, for dropdown) and
  // rawLabel (original trade name). GNTA might use either form, so try both
  // plus any variant that maps to the same canonical.
  function resolveGntaName(country, gntaCountries) {
    const canonical = country.displayLabel;
    const raw = country.rawLabel || canonical;
    // Direct match on canonical or raw
    if (gntaCountries[canonical]) return canonical;
    if (gntaCountries[raw]) return raw;
    // Look up the mapping — e.g. "Lithuania" → "ლიეტუვა"
    const mapped = countryNameMap[canonical];
    if (mapped && gntaCountries[mapped]) return mapped;
    const mappedRaw = countryNameMap[raw];
    if (mappedRaw && gntaCountries[mappedRaw]) return mappedRaw;
    // Try any variant that maps to the same Georgian canonical
    const target = mapped || canonical;
    for (const [variant, canon] of Object.entries(countryNameMap)) {
      if (canon === target && gntaCountries[variant]) return variant;
    }
    // Fuzzy substring match against the Georgian target
    for (const gntaName of Object.keys(gntaCountries)) {
      if (gntaName.includes(target) || target.includes(gntaName)) return gntaName;
    }
    return null;
  }

  async function generateTourism() {
    if (!selectedCountry) return;

    tourismLoading.classList.remove('hidden');
    // Hide stale content so the spinner is the only thing visible while
    // the new country's data is being fetched (matches the Trade tab).
    if (tourismSummaryEl) tourismSummaryEl.classList.add('hidden');
    if (tourismRowEl) tourismRowEl.classList.remove('hidden');
    tourismTableEl.innerHTML = '';
    tourismChartHeader.innerHTML = '';
    try { if (tourismChartInstance) { tourismChartInstance.destroy(); } } catch (_) {}
    tourismChartInstance = null;
    try { const ec = Chart.getChart(tourismChartCanvas); if (ec) ec.destroy(); } catch (_) {}

    try {
      const res = await fetch(`${API_BASE}/api/statistics/tourism`);
      const json = await res.json();
      if (!json.success) throw new Error('Tourism data fetch failed');

      const gntaName = resolveGntaName(selectedCountry, json.countries);
      const countryData = gntaName ? json.countries[gntaName] : null;

      if (!countryData) {
        // Match the Companies / FDI no-data style: a single paragraph in
        // the summary card with the table + chart row hidden entirely.
        const msg = reportLocale === 'ka'
          ? 'აღნიშნული ქვეყნიდან ვიზიტორები საქართველოში არ ფიქსირდება.'
          : 'No visitor records from this country to Georgia.';
        if (tourismSummaryEl) {
          tourismSummaryEl.innerHTML = `<p>${escapeHtml(msg)}</p>`;
          tourismSummaryEl.classList.remove('hidden');
        }
        tourismTableEl.innerHTML = '';
        tourismChartHeader.innerHTML = '';
        if (tourismRowEl) tourismRowEl.classList.add('hidden');
        pdfState.tourism = { hasData: false };
        tourismLoading.classList.add('hidden');
        return;
      }

      // New data shape: countryData = { annual: {year: N}, current: N|null, compare: N|null }
      const annual = countryData.annual || {};
      const allYears = json.years || [];
      const latestYear = allYears[allYears.length - 1];

      // Build the set of valid GNTA country names (excludes regions)
      const validGntaNames = new Set();
      for (const c of countries) {
        const resolved = resolveGntaName(c, json.countries);
        if (resolved) validGntaNames.add(resolved);
      }

      // Compute {rank, share%} for the selected country.
      // rank = position among real countries sorted by pickVal descending.
      // share = own value / GRAND TOTAL from the "საერთაშორისო" row in the
      // source file (not the sum of country values — those don't include
      // every visitor because some are in other categories).
      function rankAndShare(pickVal, totalVal) {
        // Rank: position among real countries with positive visitors
        const entries = [];
        for (const [name, d] of Object.entries(json.countries)) {
          if (!validGntaNames.has(name)) continue;
          const val = pickVal(d) || 0;
          if (val > 0) entries.push({ name, val });
        }
        entries.sort((a, b) => b.val - a.val);
        const idx = entries.findIndex(e => e.name === gntaName);
        const rank = idx >= 0 ? idx + 1 : null;
        // Share: country's own visitor count divided by the grand total from
        // the file's "საერთაშორისო" row. No summing, no aggregation.
        const ownVal = pickVal(countryData) || 0;
        const share = totalVal && totalVal > 0 ? (ownVal / totalVal) * 100 : null;
        return { rank, share };
      }
      const annualTotals = (json.totals && json.totals.annual) || {};
      const currentTotal = json.totals ? json.totals.current : null;
      const compareTotal = json.totals ? json.totals.compare : null;
      const rankForYear = (year) => rankAndShare(d => (d.annual && d.annual[year]) || 0, annualTotals[year]);
      const rankForCurrent = () => rankAndShare(d => d.current || 0, currentTotal);
      const rankForCompare = () => rankAndShare(d => d.compare || 0, compareTotal);

      // Build annual rows: last 5 years
      const annualRows = [];
      for (let y = latestYear - 4; y <= latestYear; y++) {
        if (allYears.includes(y)) {
          const val = annual[y] || 0;
          const prev = annual[y - 1] || 0;
          const pct = prev > 0
            ? ((val - prev) / prev * 100)
            : (val > 0 ? 100 : 0);
          const { rank, share } = val > 0 ? rankForYear(y) : { rank: null, share: null };
          annualRows.push({
            label: String(y),
            year: y,
            visitors: val,
            changePct: pct,
            isCurrent: false,
            rank,
            share,
          });
        }
      }

      // Prepend quarterly rows if currentPeriod exists
      const quarterlyRows = [];
      if (json.currentPeriod && countryData.current !== null) {
        const cur = countryData.current || 0;
        const cmp = countryData.compare || 0;
        const pct = cmp > 0 ? ((cur - cmp) / cmp * 100) : (cur > 0 ? 100 : 0);
        const curStats = cur > 0 ? rankForCurrent() : { rank: null, share: null };
        const cmpStats = cmp > 0 ? rankForCompare() : { rank: null, share: null };
        quarterlyRows.push({
          label: json.currentPeriod.label,
          visitors: cur,
          changePct: pct,
          isCurrent: true,
          rank: curStats.rank,
          share: curStats.share,
        });
        quarterlyRows.push({
          label: json.currentPeriod.compareLabel,
          visitors: cmp,
          changePct: null,
          isCurrent: false,
          rank: cmpStats.rank,
          share: cmpStats.share,
        });
      }

      const isKa = reportLocale === 'ka';
      // Section heading handles the title; skip inner header to avoid duplication.

      // ── Summary data: 5-year sum + latest-period rank ──────────────
      const fiveYearStart = latestYear - 4;
      const fiveYearEnd = latestYear;
      let fiveYearSum = 0;
      for (let y = fiveYearStart; y <= fiveYearEnd; y++) {
        fiveYearSum += annual[y] || 0;
      }
      // Use the current-period rank from the quarterly row (already computed)
      const currentRank = quarterlyRows.length > 0 ? quarterlyRows[0].rank : null;

      renderTourismTable(quarterlyRows, annualRows, isKa);
      const tourismCurrentPeriod = json.currentPeriod && countryData.current !== null ? {
        label: json.currentPeriod.label,
        visitors: countryData.current || 0,
      } : null;
      renderTourismChart(annualRows, tourismCurrentPeriod, isKa);

      pdfState.tourism = {
        hasData: true,
        quarterlyRows,
        annualRows,
        fiveYearStart,
        fiveYearEnd,
        fiveYearSum,
        currentRank,
        currentPeriodLabel: json.currentPeriod ? json.currentPeriod.label : null,
        // Cached args for renderTourismChart on cache replay (locale is
        // applied at replay time, so it's not stored here).
        chartArgs: [annualRows, tourismCurrentPeriod],
      };

      renderTourismSummary(pdfState.tourism, selectedCountry, isKa);

    } catch (err) {
      console.error('Tourism error:', err);
      tourismTableEl.innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      pdfState.tourism = { hasData: false };
    } finally {
      tourismLoading.classList.add('hidden');
      exportPdfBtn.disabled = false;
      if (exportWordBtn) exportWordBtn.disabled = false;
    }
  }

  // Georgian ablative ("from country"): word ending in "ი" → replace with "იდან"
  // (e.g. თურქეთი → თურქეთიდან). Otherwise append "-დან".
  function kaCountryFrom(name) {
    return name + 'დან';
  }

  // Convert a GNTA period label like "2026 I კვ" to Georgian genitive
  // "2026 წლის I კვარტლის" or English "Q1 2026".
  function formatCurrentPeriodKa(label) {
    const m = /^(\d{4})\s+([IVX]+)\s+კვ$/.exec(label || '');
    if (!m) return label || '';
    return `${m[1]} წლის ${m[2]} კვარტლის`;
  }
  function formatCurrentPeriodEn(label) {
    const m = /^(\d{4})\s+([IVX]+)\s+კვ$/.exec(label || '');
    if (!m) return label || '';
    const romanToInt = { I: 1, II: 2, III: 3, IV: 4 };
    const q = romanToInt[m[2]] || m[2];
    return `Q${q} ${m[1]}`;
  }

  function renderTourismSummary(tourism, selectedCountry, isKa) {
    if (!tourismSummaryEl || !tourism || !tourism.hasData) {
      if (tourismSummaryEl) tourismSummaryEl.classList.add('hidden');
      return;
    }
    const b = (s) => `<strong>${escapeHtml(String(s))}</strong>`;
    const fmt = (n) => Number(n).toLocaleString();
    const countryKa = selectedCountry.displayLabelKa || selectedCountry.displayLabel;
    const countryEn = countryNameEnMap[selectedCountry.value] || selectedCountry.displayLabel;
    const grammar = grammarFor(countryKa);
    const lines = [];

    if (tourism.fiveYearSum > 0) {
      if (isKa) {
        lines.push(`<p>${b(tourism.fiveYearStart + ' - ' + tourism.fiveYearEnd)} წლებში ${escapeHtml(grammar.from)} საქართველოში შემოვიდა ${b(fmt(tourism.fiveYearSum))} ვიზიტორი.</p>`);
      } else {
        lines.push(`<p>Between ${b(tourism.fiveYearStart + '-' + tourism.fiveYearEnd)}, ${b(fmt(tourism.fiveYearSum))} visitors came to Georgia from ${escapeHtml(countryEn)}.</p>`);
      }
    }
    if (tourism.currentRank && tourism.currentPeriodLabel) {
      const geP = (r) => {
        if (r === 1) return 'პირველ';
        if (r >= 2 && r <= 20) return `მე-${r}`;
        if (r % 10 === 0 || r % 100 === 0) return `მე-${r}`;
        return `${r}-ე`;
      };
      const enO = (r) => {
        const n = Math.abs(r), m = n % 100;
        if (m >= 11 && m <= 13) return `${n}th`;
        switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th`; }
      };
      if (isKa) {
        lines.push(`<p>${b(formatCurrentPeriodKa(tourism.currentPeriodLabel))} მონაცემებით ვიზიტორების რაოდენობის მიხედვით ${escapeHtml(countryKa)} არის ${b(geP(tourism.currentRank) + ' ადგილზე')}.</p>`);
      } else {
        lines.push(`<p>By visitor count in ${b(formatCurrentPeriodEn(tourism.currentPeriodLabel))}, ${escapeHtml(countryEn)} ranks ${b(enO(tourism.currentRank))}.</p>`);
      }
    }

    tourismSummaryEl.innerHTML = lines.join('');
    tourismSummaryEl.classList.remove('hidden');
  }

  function renderTourismTable(quarterlyRows, annualRows, isKa) {
    // Table order: newest first. quarterly rows on top, then annual reversed (latest year first).
    const rows = [...quarterlyRows, ...[...annualRows].reverse()];

    const hPeriod = isKa ? 'პერიოდი' : 'Period';
    const hValue = isKa ? 'ვიზიტორები' : 'Visitors';
    const hChange = isKa ? 'ცვლილება, %' : 'Change, %';
    const hRank = isKa ? 'ადგილი' : 'Rank';
    const hShare = isKa ? 'წილი, %' : 'Share, %';

    // Drop the rank column entirely when no row reaches the top 20 —
    // a column of all "-" or all "47" / "53" etc. isn't useful.
    const TOP_RANK_LIMIT = 20;
    const showRank = rows.some(r => r.rank && r.rank <= TOP_RANK_LIMIT);

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th>${hPeriod}</th>
          ${showRank ? `<th class="stat-col-change">${hRank}</th>` : ''}
          <th class="stat-col-value">${hValue}</th>
          <th class="stat-col-change">${hChange}</th>
          <th class="stat-col-change">${hShare}</th>
        </tr>
      </thead>
      <tbody>`;

    for (const r of rows) {
      let changeCell = '';
      if (r.changePct === null || r.changePct === undefined) {
        changeCell = '<td class="stat-col-change">-</td>';
      } else {
        const changeClass = r.changePct > 0 ? 'stat-positive' : (r.changePct < 0 ? 'stat-negative' : '');
        const sign = r.changePct > 0 ? '+' : '';
        changeCell = `<td class="stat-col-change ${changeClass}">${sign}${formatChangePct(r.changePct)}</td>`;
      }
      const rankCell = showRank
        ? (r.rank ? `<td class="stat-col-change">${r.rank}</td>` : '<td class="stat-col-change">-</td>')
        : '';
      const shareCell = (r.share != null)
        ? `<td class="stat-col-change">${(Math.round(r.share * 10) / 10).toFixed(1)}%</td>`
        : '<td class="stat-col-change">-</td>';
      html += `
        <tr>
          <td>${escapeHtml(r.label)}</td>
          ${rankCell}
          <td class="stat-col-value">${r.visitors.toLocaleString()}</td>
          ${changeCell}
          ${shareCell}
        </tr>`;
    }

    html += '</tbody></table>';
    tourismTableEl.innerHTML = html;
  }

  function renderTourismChart(annualRows, currentPeriod, isKa) {
    tourismChartHeader.innerHTML = `<h3 class="stat-report__title">${isKa ? 'საერთაშორისო ვიზიტორები' : 'International Visitors'}</h3>`;

    // Chart order: annual years ascending, then current period as last bar.
    const labels = annualRows.map(r => r.label);
    const values = annualRows.map(r => r.visitors);
    const colors = annualRows.map(() => '#3b82f6');

    if (currentPeriod) {
      labels.push(currentPeriod.label);
      values.push(currentPeriod.visitors);
      colors.push('#60a5fa'); // lighter blue for partial period
    }

    tourismChartInstance = new Chart(tourismChartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        layout: { padding: { top: 24 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          datalabels: {
            anchor: 'end',
            align: 'end',
            font: { size: 11, weight: '600' },
            color: '#374151',
            formatter: (v) => v.toLocaleString(),
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

  // ════════════════════════════════════════════════════════════════════════
  // ── INVESTMENTS TAB ──────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  async function generateInvestments() {
    if (!selectedCountry) return;

    investmentsLoading.classList.remove('hidden');
    // Hide stale content so the spinner is the only thing visible while
    // the new country's data is being fetched (matches the Trade tab).
    if (investmentsSummaryEl) investmentsSummaryEl.classList.add('hidden');
    if (fdiSectorsCardEl) fdiSectorsCardEl.classList.add('hidden');
    if (fdiRowEl) fdiRowEl.classList.remove('hidden');
    fdiTable.innerHTML = '';
    fdiChartHeader.innerHTML = '';
    try { if (fdiChartInstance) { fdiChartInstance.destroy(); } } catch (_) {}
    fdiChartInstance = null;
    try { const ec = Chart.getChart(fdiChartCanvas); if (ec) ec.destroy(); } catch (_) {}

    try {
      const res = await fetch(`${API_BASE}/api/statistics/fdi`);
      const json = await res.json();
      if (!json.success) throw new Error('FDI data fetch failed');

      const countryCode = selectedCountry.value;
      const countryData = json.countries[countryCode];
      const allYears = json.years; // e.g. [1996, 1997, ..., 2025]

      if (!countryData) {
        // Match the Companies tab's style: a single paragraph inside the
        // summary card, with the table + chart area hidden entirely so the
        // card renders as a compact "no data" note instead of a large
        // centred empty-state block.
        const msg = reportLocale === 'ka'
          ? 'აღნიშნული ქვეყნიდან საქართველოში პირდაპირი უცხოური ინვესტიცია არ ფიქსირდება.'
          : 'No foreign direct investment records from this country to Georgia.';
        if (investmentsSummaryEl) {
          investmentsSummaryEl.innerHTML = `<p>${escapeHtml(msg)}</p>`;
          investmentsSummaryEl.classList.remove('hidden');
        }
        fdiTable.innerHTML = '';
        fdiChartHeader.innerHTML = '';
        if (fdiRowEl) fdiRowEl.classList.add('hidden');
        pdfState.investments = { hasData: false };
        pdfState.investmentsSectors = null;
        if (fdiSectorsCardEl) fdiSectorsCardEl.classList.add('hidden');
        investmentsLoading.classList.add('hidden');
        return;
      }

      // Find the latest year that has data
      const latestYear = allYears[allYears.length - 1];

      // Display last 5 years (or from latestYear-4 to latestYear)
      const displayYears = [];
      for (let y = latestYear - 4; y <= latestYear; y++) {
        if (allYears.includes(y)) displayYears.push(y);
      }

      // Per-year rank + share for the FDI table rows.
      // Rank = position among countries with positive FDI that year.
      // Share = country_value / grand_total_from_"სულ"_row × 100.
      const fdiTotalsThd = json.totals || {};
      function fdiRankAndShare(year) {
        const entries = [];
        for (const [code, data] of Object.entries(json.countries)) {
          const v = (data[year] || 0) / 1000;
          if (v > 0) entries.push({ code, v });
        }
        entries.sort((a, b) => b.v - a.v);
        const idx = entries.findIndex(e => e.code === String(countryCode));
        const rank = idx >= 0 ? idx + 1 : null;
        const ownVal = idx >= 0 ? entries[idx].v : 0;
        const totalMln = (fdiTotalsThd[year] || 0) / 1000;
        const share = totalMln > 0 ? (ownVal / totalMln) * 100 : null;
        return { rank, share };
      }

      // Build table data: year, value (mln USD), change %, rank, share
      const tableData = displayYears.map(y => {
        const val = (countryData[y] || 0) / 1000;
        const prev = (countryData[y - 1] || 0) / 1000;
        const rs = val > 0 ? fdiRankAndShare(y) : { rank: null, share: null };
        return { year: y, valueMln: val, prevMln: prev, rank: rs.rank, share: rs.share };
      });

      // Quarter rows: Geostat publishes quarters of the year following the
      // last full annual year (e.g. "2026 Q1*" while the annual series ends
      // at 2025). The server accumulates them year-to-date (Q1, then Q1+Q2),
      // and the change % compares with the same quarters a year earlier;
      // rank and share are computed within the same year-to-date window.
      const ROMAN_Q = ['', 'I', 'II', 'III', 'IV'];
      for (const q of (json.quarters || [])) {
        const star = q.preliminary ? '*' : '';
        const qs = q.quarters || [q.quarter];
        const range = qs.length > 1 ? `${qs[0]}-Q${qs[qs.length - 1]}` : `${qs[0]}`;
        const romanRange = qs.length > 1
          ? `${ROMAN_Q[qs[0]]}-${ROMAN_Q[qs[qs.length - 1]]}`
          : ROMAN_Q[qs[0]];
        const label = reportLocale === 'ka'
          ? `${q.year} ${romanRange} კვ${star}`
          : `${q.year} Q${range}${star}`;
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
        tableData.push({ year: label, valueMln: val, prevMln: prev, rank, share });
      }

      // ── Summary data ──────────────────────────────────────────────
      // First year country had positive investment
      let firstYear = null;
      for (const y of allYears) {
        if ((countryData[y] || 0) > 0) { firstYear = y; break; }
      }
      // Total sum (all years, in mln USD)
      let totalSum = 0;
      for (const y of allYears) totalSum += (countryData[y] || 0) / 1000;
      // Rank by total sum across all countries
      const totalByCountry = [];
      for (const [code, data] of Object.entries(json.countries)) {
        let s = 0;
        for (const y of allYears) s += (data[y] || 0) / 1000;
        if (s > 0) totalByCountry.push({ code, sum: s });
      }
      totalByCountry.sort((a, b) => b.sum - a.sum);
      const totalRankIdx = totalByCountry.findIndex(c => c.code === String(countryCode));
      const totalRank = totalRankIdx >= 0 ? totalRankIdx + 1 : null;
      // Last 5 complete years (latestYear-4 through latestYear)
      const fiveYearStart = latestYear - 4;
      const fiveYearEnd = latestYear;
      let fiveYearSum = 0;
      for (let y = fiveYearStart; y <= fiveYearEnd; y++) {
        fiveYearSum += (countryData[y] || 0) / 1000;
      }
      // Per-year value + rank for latestYear and previous year (for summary)
      const latestYearValue = (countryData[latestYear] || 0) / 1000;
      const latestYearRank = latestYearValue > 0 ? fdiRankAndShare(latestYear).rank : null;
      const prevYear = latestYear - 1;
      const prevYearValue = (countryData[prevYear] || 0) / 1000;
      const prevYearRank = prevYearValue > 0 ? fdiRankAndShare(prevYear).rank : null;

      const isKa = reportLocale === 'ka';
      // Section heading handles the title; skip inner header to avoid duplication.

      renderFdiTable(tableData, isKa);
      renderFdiChart(tableData, isKa);

      pdfState.investments = {
        hasData: true,
        tableData,
        firstYear,
        totalSum,
        totalRank,
        fiveYearStart, fiveYearEnd, fiveYearSum,
        latestYear, latestYearValue, latestYearRank,
        prevYear, prevYearValue, prevYearRank,
      };

      renderInvestmentsSummary(pdfState.investments, selectedCountry, isKa);

      // ── Sectors breakdown (admin-uploaded file; may be absent) ──────
      let sectorsData = null;
      try {
        const sRes = await fetch(`${API_BASE}/api/statistics/fdi-sectors`);
        const sJson = await sRes.json();
        if (sJson && sJson.success && !sJson.empty) {
          const c = sJson.countries && sJson.countries[String(countryCode)];
          if (c) sectorsData = { years: sJson.years, sectors: sJson.sectors, sectorNameMap: sJson.sectorNameMap || {}, data: c };
        }
      } catch (_) { /* silently hide sectors card */ }
      pdfState.investmentsSectors = sectorsData;
      renderFdiSectorsTable(sectorsData, selectedCountry, isKa);

    } catch (err) {
      console.error('Investments error:', err);
      fdiTable.innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      pdfState.investments = { hasData: false };
      if (fdiSectorsCardEl) fdiSectorsCardEl.classList.add('hidden');
    } finally {
      investmentsLoading.classList.add('hidden');
      exportPdfBtn.disabled = false;
      if (exportWordBtn) exportWordBtn.disabled = false;
    }
  }

  function renderFdiSectorsTable(sectorsState, selectedCountry, isKa) {
    if (!fdiSectorsCardEl || !fdiSectorsHeaderEl || !fdiSectorsTableEl) return;
    if (!sectorsState || !sectorsState.data) {
      fdiSectorsCardEl.classList.add('hidden');
      return;
    }
    const { years, data, sectorNameMap } = sectorsState;
    const country = isKa ? selectedCountry.displayLabel : (countryNameEnMap[selectedCountry.value] || selectedCountry.displayLabel);
    const yrRange = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : `${years[0]}`;
    const title = isKa
      ? `${country} - პირდაპირი უცხოური ინვესტიციები სექტორების მიხედვით, ${yrRange}`
      : `${country} - Foreign Direct Investment by Sector, ${yrRange}`;
    fdiSectorsHeaderEl.innerHTML = `<h3 class="stat-report__title">${escapeHtml(title)}</h3><div style="font-size:0.85rem;color:var(--text-secondary);">${isKa ? 'მლნ. აშშ დოლარი' : 'mln USD'}</div>`;

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

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th>${sectorHeader}</th>
          ${years.map(y => `<th class="stat-col-value">${y}</th>`).join('')}
        </tr>
      </thead>
      <tbody>`;

    // Totals row first (bold).
    html += `<tr><td style="font-weight:700;">${totalLabel}</td>`;
    for (const y of years) {
      const v = data.totals ? data.totals[y] : null;
      html += `<td class="stat-col-value ${cellCls(v)}" style="font-weight:700;">${fmt(v)}</td>`;
    }
    html += `</tr>`;

    // Sector rows — sort by most-recent-period value, highest to lowest.
    // Null/zero values sort to the bottom.
    const sectorNames = Object.keys(data.sectors || {});
    const sortYear = years[years.length - 1];
    sectorNames.sort((a, b) => {
      const va = (data.sectors[a] && data.sectors[a][sortYear]) || 0;
      const vb = (data.sectors[b] && data.sectors[b][sortYear]) || 0;
      return vb - va;
    });
    const nameMap = sectorNameMap || {};
    for (const sector of sectorNames) {
      const vals = data.sectors[sector] || {};
      const displayName = isKa ? sector : (nameMap[sector] || sector);
      html += `<tr><td>${escapeHtml(displayName)}</td>`;
      for (const y of years) {
        const v = vals[y];
        html += `<td class="stat-col-value ${cellCls(v)}">${fmt(v)}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    fdiSectorsTableEl.innerHTML = html;
    fdiSectorsCardEl.classList.remove('hidden');
  }

  function renderInvestmentsSummary(inv, selectedCountry, isKa) {
    if (!investmentsSummaryEl) return;
    if (!inv || !inv.hasData) { investmentsSummaryEl.classList.add('hidden'); return; }
    const b = (s) => `<strong>${escapeHtml(String(s))}</strong>`;
    const fmt = (n) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const countryKa = selectedCountry.displayLabelKa || selectedCountry.displayLabel;
    const countryEn = countryNameEnMap[selectedCountry.value] || selectedCountry.displayLabel;
    const countryKaFrom = grammarFor(countryKa).from;
    const lines = [];

    function geP(r) {
      if (r === 1) return 'პირველ';
      if (r >= 2 && r <= 20) return `მე-${r}`;
      if (r % 10 === 0 || r % 100 === 0) return `მე-${r}`;
      return `${r}-ე`;
    }
    function enO(r) {
      const n = Math.abs(r), m = n % 100;
      if (m >= 11 && m <= 13) return `${n}th`;
      switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th`; }
    }

    // Sentence 1: first year + total + total rank
    if (inv.firstYear && inv.totalSum > 0) {
      if (isKa) {
        let s = `<p>${escapeHtml(countryKaFrom)} საქართველოში პირდაპირი უცხოური ინვესტიცია პირველად ${b(inv.firstYear)} წელს განხორციელდა. ჯამური განხორციელებული პირდაპირი უცხოური ინვესტიცია შეადგენს ${b(`${fmt(inv.totalSum)} მლნ. აშშ დოლარს`)}.`;
        if (inv.totalRank) s += ` ${escapeHtml(countryKa)} იკავებს ${b(`${geP(inv.totalRank)} ადგილს`)} ჯამური განხორციელებული ინვესტიციის მოცულობით საქართველოში.`;
        s += '</p>';
        lines.push(s);
      } else {
        let s = `<p>Foreign direct investment from ${escapeHtml(countryEn)} to Georgia was first made in ${b(inv.firstYear)}. Total conducted FDI amounts to ${b(`${fmt(inv.totalSum)} mln USD`)}.`;
        if (inv.totalRank) s += ` ${escapeHtml(countryEn)} ranks ${b(enO(inv.totalRank))} by total FDI volume in Georgia.`;
        s += '</p>';
        lines.push(s);
      }
    }

    // Sentence 2: last 5 years sum
    if (inv.fiveYearSum > 0) {
      if (isKa) {
        lines.push(`<p>${b(`${inv.fiveYearStart} - ${inv.fiveYearEnd}`)} წლებში ${escapeHtml(countryKaFrom)} საქართველოში შემოსული ინვესტიციების მოცულობამ შეადგინა ${b(`${fmt(inv.fiveYearSum)} მლნ. აშშ დოლარი`)}.</p>`);
      } else {
        lines.push(`<p>Between ${b(`${inv.fiveYearStart}-${inv.fiveYearEnd}`)}, investments from ${escapeHtml(countryEn)} to Georgia amounted to ${b(`${fmt(inv.fiveYearSum)} mln USD`)}.</p>`);
      }
    }

    // Sentence 3: latest full year + rank
    // Sentence 3: latest full year + rank (show "no investment" if value ≤ 0)
    if (inv.latestYear) {
      if (inv.latestYearValue > 0) {
        if (isKa) {
          let s = `<p>${b(`${inv.latestYear} წელს`)} ${escapeHtml(countryKaFrom)} საქართველოში განხორციელდა ${b(`${fmt(inv.latestYearValue)} მლნ. აშშ დოლარის`)} პირდაპირი უცხოური ინვესტიცია.`;
          if (inv.latestYearRank) s += ` ${escapeHtml(countryKa)} განხორციელებული პირდაპირი უცხოური ინვესტიციის მოცულობით ${inv.latestYear} წელს ${b(`${geP(inv.latestYearRank)} ადგილს`)} იკავებს.`;
          s += '</p>';
          lines.push(s);
        } else {
          let s = `<p>In ${b(inv.latestYear)}, ${b(`${fmt(inv.latestYearValue)} mln USD`)} of foreign direct investment came to Georgia from ${escapeHtml(countryEn)}.`;
          if (inv.latestYearRank) s += ` ${escapeHtml(countryEn)} ranked ${b(enO(inv.latestYearRank))} by FDI volume in ${inv.latestYear}.`;
          s += '</p>';
          lines.push(s);
        }
      } else {
        lines.push(`<p>${isKa ? `${b(`${inv.latestYear} წელს`)} ${escapeHtml(countryKaFrom)} ინვესტიცია არ განხორციელდა.` : `In ${b(inv.latestYear)}, no investment was conducted from ${escapeHtml(countryEn)}.`}</p>`);
      }
    }

    // Sentence 4: previous full year + rank (show "no investment" if value ≤ 0)
    if (inv.prevYear) {
      if (inv.prevYearValue > 0) {
        if (isKa) {
          let s = `<p>${b(`${inv.prevYear} წელს`)} ${escapeHtml(countryKaFrom)} საქართველოში განხორციელდა ${b(`${fmt(inv.prevYearValue)} მლნ. აშშ დოლარის`)} პირდაპირი უცხოური ინვესტიცია.`;
          if (inv.prevYearRank) s += ` ${escapeHtml(countryKa)} განხორციელებული პირდაპირი უცხოური ინვესტიციის მოცულობით ${inv.prevYear} წელს ${b(`${geP(inv.prevYearRank)} ადგილს`)} იკავებს.`;
          s += '</p>';
          lines.push(s);
        } else {
          let s = `<p>In ${b(inv.prevYear)}, ${b(`${fmt(inv.prevYearValue)} mln USD`)} of foreign direct investment came to Georgia from ${escapeHtml(countryEn)}.`;
          if (inv.prevYearRank) s += ` ${escapeHtml(countryEn)} ranked ${b(enO(inv.prevYearRank))} by FDI volume in ${inv.prevYear}.`;
          s += '</p>';
          lines.push(s);
        }
      } else {
        lines.push(`<p>${isKa ? `${b(`${inv.prevYear} წელს`)} ${escapeHtml(countryKaFrom)} ინვესტიცია არ განხორციელდა.` : `In ${b(inv.prevYear)}, no investment was conducted from ${escapeHtml(countryEn)}.`}</p>`);
      }
    }

    investmentsSummaryEl.innerHTML = lines.join('');
    investmentsSummaryEl.classList.remove('hidden');
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── COMPANIES TAB ──────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  async function generateCompanies() {
    if (!selectedCountry) return;
    if (!companiesSummaryEl) return;
    if (companiesLoading) companiesLoading.classList.remove('hidden');
    companiesSummaryEl.classList.add('hidden');

    try {
      const res = await fetch(`${API_BASE}/api/statistics/companies`);
      const json = await res.json();
      if (!json.success || json.empty) {
        pdfState.companies = { hasData: false };
        return;
      }
      const isKa = reportLocale === 'ka';
      const countryKa = selectedCountry.displayLabel;
      const countryEn = countryNameEnMap[selectedCountry.value] || countryKa;
      // The file uses Georgian country names in column V. Look up by the
      // canonical Georgian name from the Geostat classificatory (mirrors
      // the tourism matching pattern).
      const georgianName = countryNameKaMap[selectedCountry.value] || countryKa;
      const canonical = countryNameMap[georgianName] || georgianName;
      // Try both the canonical and the raw Georgian name
      let data = json.countries[canonical] || json.countries[georgianName] || null;
      // Last resort: if the file uses an English-ish name and the selected
      // country's English name is in the map
      if (!data) data = json.countries[countryEn] || null;

      // Special case: the source spreadsheet has a legacy "Serbia and
      // Montenegro" row (the state-union entity) alongside the modern
      // Serbia and Montenegro rows. When the user picks either of the
      // modern countries, surface the combined-row count as an extra
      // sentence below the per-country total, and suppress the bullet
      // breakdown for both countries entirely. Applies only here.
      const COMBINED_KEY = 'სერბია და მონტენეგრო';
      const isSerbOrMonte = (georgianName === 'სერბეთი' || georgianName === 'მონტენეგრო');
      let combined = null;
      if (isSerbOrMonte) {
        const cd = json.countries[COMBINED_KEY];
        if (cd && cd.total > 0) {
          combined = {
            total: cd.total,
            labelKa: 'სერბია-მონტენეგრო',
            labelKaOf: 'სერბია-მონტენეგროს',
            labelEn: 'Serbia and Montenegro',
          };
        }
      }

      pdfState.companies = (data || combined)
        ? { hasData: !!data, uploadedAt: json.uploadedAt, counts: data || null, countryKa, countryEn, combined, suppressBreakdown: isSerbOrMonte }
        : { hasData: false };

      renderCompaniesSummary(pdfState.companies, isKa);
    } catch (err) {
      console.error('Companies error:', err);
      pdfState.companies = { hasData: false };
      companiesSummaryEl.classList.add('hidden');
    } finally {
      if (companiesLoading) companiesLoading.classList.add('hidden');
    }
  }

  function renderCompaniesSummary(state, isKa) {
    if (!companiesSummaryEl) return;
    const hasOwn = !!(state && state.hasData && state.counts);
    const combined = state && state.combined;
    if (!hasOwn && !combined) {
      companiesSummaryEl.innerHTML = `<p>${isKa ? 'აღნიშნული ქვეყნის კაპიტალით დარეგისტრირებული მოქმედი კომპანია ვერ მოიძებნა.' : 'No active companies with capital from this country found.'}</p>`;
      companiesSummaryEl.classList.remove('hidden');
      return;
    }
    const c = state.counts || {};
    const country = isKa ? state.countryKa : state.countryEn;
    // Georgian genitive ("of <country>") — proper inflection from the
    // grammar sheet ("თურქეთის"), with the suffix-fallback for any
    // country missing from the sheet. Used wherever the prose previously
    // stuck "-ის" onto the bare nominative.
    const countryOf = isKa
      ? (grammarFor(state.countryKa || country).of || (country + 'ის'))
      : country;
    const b = (s) => `<strong>${escapeHtml(String(s))}</strong>`;
    const fmt = (n) => Number(n || 0).toLocaleString();
    const lines = [];
    lines.push(`<h4 class="stat-summary__heading">${isKa ? 'კომპანიები' : 'Companies'}</h4>`);
    if (hasOwn) {
      if (isKa) {
        lines.push(`<p>${escapeHtml(countryOf)} კაპიტალის მონაწილეობით დარეგისტრირებული მოქმედი კომპანიები:</p>`);
        lines.push(`<p>${b(fmt(c.total))} მოქმედი კომპანია ${escapeHtml(countryOf)} კაპიტალის მონაწილეობით.</p>`);
      } else {
        lines.push(`<p>Active companies with capital originating from ${escapeHtml(country)}:</p>`);
        lines.push(`<p>${b(fmt(c.total))} active companies with capital originating from ${escapeHtml(country)}.</p>`);
      }
      // Breakdown bullets — suppressed for Serbia / Montenegro per the
      // legacy-union special case (their detail rows don't sum to the
      // user-facing total once the union row is shown alongside).
      if (!state.suppressBreakdown) {
        if (isKa) {
          lines.push(`<ul style="margin:0;padding-left:1.2em;">`);
          lines.push(`<li>${b(fmt(c.solo))} კომპანია - ${escapeHtml(countryOf)} კაპიტალით შექმნილი;</li>`);
          lines.push(`<li>${b(fmt(c.withGeorgia))} კომპანია - ${escapeHtml(country)} - საქართველოს წილობრივი კაპიტალით შექმნილი;</li>`);
          lines.push(`<li>${b(fmt(c.withGeorgiaAndThird))} კომპანია - ${escapeHtml(country)}, საქართველოსა და მესამე ქვეყნის კაპიტალით შექმნილი;</li>`);
          lines.push(`<li>${b(fmt(c.withThirdOnly))} კომპანია - ${escapeHtml(countryOf)} და მესამე ქვეყნების წილობრივი კაპიტალით შექმნილი.</li>`);
          lines.push(`</ul>`);
        } else {
          lines.push(`<ul style="margin:0;padding-left:1.2em;">`);
          lines.push(`<li>${b(fmt(c.solo))} companies - established with capital from only ${escapeHtml(country)};</li>`);
          lines.push(`<li>${b(fmt(c.withGeorgia))} companies - established with joint capital from ${escapeHtml(country)} and Georgia;</li>`);
          lines.push(`<li>${b(fmt(c.withGeorgiaAndThird))} companies - established with joint capital from ${escapeHtml(country)}, Georgia and the third country;</li>`);
          lines.push(`<li>${b(fmt(c.withThirdOnly))} companies - established with joint capital from ${escapeHtml(country)} and third countries.</li>`);
          lines.push(`</ul>`);
        }
      }
    }
    if (combined) {
      // Single sentence for the legacy Serbia-Montenegro union — no
      // breakdown bullets, just the headcount.
      const cbOf = isKa ? combined.labelKaOf : combined.labelEn;
      const cbNom = isKa ? combined.labelKa : combined.labelEn;
      if (isKa) {
        lines.push(`<p>${b(fmt(combined.total))} მოქმედი კომპანია ${escapeHtml(cbOf)} კაპიტალის მონაწილეობით.</p>`);
      } else {
        lines.push(`<p>${b(fmt(combined.total))} active companies with capital originating from ${escapeHtml(cbNom)}.</p>`);
      }
    }
    companiesSummaryEl.innerHTML = lines.join('');
    companiesSummaryEl.classList.remove('hidden');
  }

  function renderFdiTable(data, isKa) {
    data = [...data].reverse();
    const hYear = isKa ? 'წელი' : 'Year';
    const hRank = isKa ? 'ადგილი' : 'Rank';
    const hValue = isKa ? 'მოცულობა, მლნ. $' : 'Volume, mln $';
    const hChange = isKa ? 'ცვლილება, %' : 'Change, %';
    const hShare = isKa ? 'წილი, %' : 'Share, %';

    // Drop the rank column entirely when no year reaches the top 20.
    const TOP_RANK_LIMIT = 20;
    const showRank = data.some(r => r.valueMln > 0 && r.rank && r.rank <= TOP_RANK_LIMIT);

    let html = `<table class="stat-table">
      <thead>
        <tr>
          <th>${hYear}</th>
          ${showRank ? `<th class="stat-col-change">${hRank}</th>` : ''}
          <th class="stat-col-value">${hValue}</th>
          <th class="stat-col-change">${hChange}</th>
          <th class="stat-col-change">${hShare}</th>
        </tr>
      </thead>
      <tbody>`;

    for (const r of data) {
      const isCurNeg = !(r.valueMln > 0);
      const isPrevNeg = !(r.prevMln > 0);
      const valueCell = isCurNeg ? '-' : formatMln(r.valueMln);
      let changeCell = '-';
      let changeClass = '';
      if (!isCurNeg && !isPrevNeg) {
        const pct = ((r.valueMln - r.prevMln) / r.prevMln) * 100;
        changeClass = pct > 0 ? 'stat-positive' : (pct < 0 ? 'stat-negative' : '');
        const sign = pct > 0 ? '+' : '';
        changeCell = `${sign}${formatChangePct(pct)}`;
      }
      const rankCellInner = (!isCurNeg && r.rank) ? String(r.rank) : '-';
      const shareCell = (!isCurNeg && r.share != null) ? `${(Math.round(r.share * 10) / 10).toFixed(1)}%` : '-';
      html += `
        <tr>
          <td>${r.year}</td>
          ${showRank ? `<td class="stat-col-change">${rankCellInner}</td>` : ''}
          <td class="stat-col-value">${valueCell}</td>
          <td class="stat-col-change ${changeClass}">${changeCell}</td>
          <td class="stat-col-change">${shareCell}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    fdiTable.innerHTML = html;
  }

  function renderFdiChart(data, isKa) {
    fdiChartHeader.innerHTML = `<h3 class="stat-report__title">${isKa ? 'პირდაპირი უცხოური ინვესტიციები, მლნ. $' : 'FDI, mln $'}</h3>`;

    const labels = data.map(d => String(d.year));
    const values = data.map(d => d.valueMln);

    fdiChartInstance = new Chart(fdiChartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: '#3b82f6',
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        layout: { padding: { top: 24 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          datalabels: {
            anchor: 'end',
            align: 'end',
            font: { size: 11, weight: '600' },
            color: '#374151',
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

  // ════════════════════════════════════════════════════════════════════════
  // ── PDF EXPORT ─────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  // Clicking PDF exports directly in whichever language the report toggle
  // is currently set to. The former dropdown (English / ქართული) was
  // removed since the toggle already carries that intent.
  exportPdfBtn.addEventListener('click', () => {
    if (exportPdfBtn.disabled) return;
    exportPdf(reportLocale);
  });

  if (exportWordBtn) {
    exportWordBtn.addEventListener('click', () => {
      if (exportWordBtn.disabled) return;
      exportWord(reportLocale);
    });
  }

  // Lazy-load the docx library only when the user actually clicks
  // "Word" — keeps the initial page weight down (the library is
  // ~600 KB and most visitors never export). The load promise is
  // memoised so subsequent clicks reuse the same script tag.
  let _docxLoadPromise = null;
  function ensureDocxLib() {
    if (typeof window.docx !== 'undefined') return Promise.resolve();
    if (_docxLoadPromise) return _docxLoadPromise;
    // docx 8.5.0's font obfuscator + the bundled JSZip both call Node's
    // Buffer API directly (Buffer.concat / Buffer.isBuffer / Buffer.from /
    // Buffer.alloc), which the browser doesn't have. Provide a polyfill
    // that satisfies each method using Uint8Array; JSZip accepts Uint8Array
    // wherever it accepts a Buffer. We deliberately leave `typeof Buffer`
    // as 'object' (not 'function') so JSZip's "are we in Node?" guards
    // (`typeof Buffer === 'function'`) still fail and use Uint8Array paths
    // for everything else.
    if (typeof window.Buffer === 'undefined') {
      window.Buffer = {
        concat(arrays) {
          let total = 0;
          for (const arr of arrays) total += arr.length;
          const out = new Uint8Array(total);
          let offset = 0;
          for (const arr of arrays) { out.set(arr, offset); offset += arr.length; }
          return out;
        },
        isBuffer() { return false; },
        from(data, encoding) {
          if (typeof data === 'string') {
            // Limited string support; the obfuscate path only needs binary.
            return new TextEncoder().encode(data);
          }
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (Array.isArray(data)) return new Uint8Array(data);
          return new Uint8Array(data || 0);
        },
        alloc(size) { return new Uint8Array(size); },
      };
    }
    _docxLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js';
      s.onload = () => resolve();
      s.onerror = () => {
        _docxLoadPromise = null;
        reject(new Error('Failed to load docx library'));
      };
      document.head.appendChild(s);
    });
    return _docxLoadPromise;
  }

  // Capture a Chart.js canvas as a PNG data URL at an explicit size.
  //
  // Trick: we render the chart at its FINAL display size (matching the PDF
  // embed width/height in points) but with a high devicePixelRatio so the
  // underlying PNG is oversampled for crisp print quality. Because Chart.js
  // sizes fonts relative to the display size, font sizes set in "display px"
  // end up at the same number in "pt" once pdfmake embeds the PNG at the
  // matching pt width.
  //
  // We also have to temporarily:
  //   - disable responsive + maintainAspectRatio (otherwise the aspect lock
  //     and ResizeObserver silently override our requested dimensions)
  //   - override tick + datalabel font sizes so chart text sits at the same
  //     ~9pt as the surrounding PDF table content
  function snapshotChart(chartInstance, displayWidth = 500, displayHeight = 153, pixelRatio = 4, fontSize = 9) {
    if (!chartInstance || !chartInstance.canvas) return null;

    // Render a clone of the chart into an off-screen canvas at the PDF's
    // target dimensions. The on-screen chart is never touched — so the
    // user doesn't see a shrink-and-snap-back during export, and the
    // visible chart keeps its responsive, good-looking aspect ratio.
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:-99999px;top:0;width:${displayWidth}px;height:${displayHeight}px;`;
    const tmpCanvas = document.createElement('canvas');
    host.appendChild(tmpCanvas);
    document.body.appendChild(host);

    let tmpChart = null;
    try {
      const src = chartInstance.config;

      // Shallow clone the nested option paths we need to override so we
      // don't mutate the live chart's config. Other keys (callbacks,
      // colour functions, etc.) are shared by reference — fine for a
      // one-shot read-only render.
      const srcOptions = src.options || {};
      const srcScales  = srcOptions.scales  || {};
      const srcPlugins = srcOptions.plugins || {};

      const clonedScales = {};
      for (const axisKey of Object.keys(srcScales)) {
        const ax = srcScales[axisKey] || {};
        const ticks = ax.ticks || {};
        const ticksFont = ticks.font || {};
        clonedScales[axisKey] = {
          ...ax,
          ticks: { ...ticks, font: { ...ticksFont, size: fontSize } },
        };
      }

      const clonedPlugins = { ...srcPlugins };
      if (srcPlugins.datalabels) {
        clonedPlugins.datalabels = {
          ...srcPlugins.datalabels,
          font: { ...(srcPlugins.datalabels.font || {}), size: fontSize },
        };
      }

      tmpChart = new Chart(tmpCanvas, {
        type: src.type,
        data: src.data,
        plugins: src.plugins || [],
        options: {
          ...srcOptions,
          responsive: false,
          maintainAspectRatio: false,
          aspectRatio: undefined,
          animation: false,
          devicePixelRatio: pixelRatio,
          scales: clonedScales,
          plugins: clonedPlugins,
        },
      });
      tmpChart.resize(displayWidth, displayHeight);
      tmpChart.update('none');
      return tmpChart.toBase64Image('image/png', 1.0);
    } catch (err) {
      console.warn('Chart snapshot failed:', err);
      return null;
    } finally {
      if (tmpChart) { try { tmpChart.destroy(); } catch (_) {} }
      host.remove();
    }
  }

  async function exportPdf(pdfLang) {
    if (typeof pdfMake === 'undefined' || typeof StatisticsPdf === 'undefined') {
      alert(I18n.tr('statistics.pdfLibMissing'));
      return;
    }
    if (!pdfState.trade || !pdfState.country) {
      alert(reportLocale === 'ka' ? 'ჯერ დააგენერირეთ მონაცემები' : 'Please generate data first.');
      return;
    }

    const origBtnText = exportPdfBtn.textContent;
    exportPdfBtn.disabled = true;
    exportPdfBtn.textContent = '...';

    // Temporarily make all three tabs laid-out off-screen so Chart.js
    // resizes them to real dimensions before we snapshot.
    document.body.classList.add('stat-exporting');
    // Wait two animation frames so layout/resize settle.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      // Force all known charts to resize and snapshot to PNG.
      // Charts render at their final 500×153pt display size (70% taller
      // than the previous 90pt). DPR=4 gives a crisp 2000×612 pixel buffer.
      // Font size 9 matches the surrounding table content (tdText/tdNum).
      const charts = {
        turnover: snapshotChart(turnoverChartInstance),
        dynamics: snapshotChart(dynamicsChartInstance),
        tourism: snapshotChart(tourismChartInstance),
        fdi: snapshotChart(fdiChartInstance),
      };

      await StatisticsPdf.build(pdfState, {
        lang: pdfLang || 'en',
        country: pdfState.country.displayLabel,
        countryNameEn: pdfState.countryNameEn,
        charts,
      });
    } catch (err) {
      console.error('PDF export error:', err);
      alert(I18n.tr('statistics.pdfExportFailed') + ' ' + (err.message || err));
    } finally {
      document.body.classList.remove('stat-exporting');
      // Restore chart sizes to fit their actual visible containers
      [turnoverChartInstance, dynamicsChartInstance, tourismChartInstance, fdiChartInstance]
        .forEach(c => { if (c) { try { c.resize(); } catch (_) {} } });
      exportPdfBtn.disabled = false;
      exportPdfBtn.textContent = origBtnText;
    }
  }

  // Mirror of exportPdf for Word output. Lazy-loads the docx library
  // on first click, snapshots the same chart PNGs that the PDF path
  // uses, and hands the same `pdfState` to StatisticsWord.build.
  async function exportWord(wordLang) {
    if (!exportWordBtn) return;
    if (!pdfState.trade || !pdfState.country) {
      alert(reportLocale === 'ka' ? 'ჯერ დააგენერირეთ მონაცემები' : 'Please generate data first.');
      return;
    }

    const origBtnText = exportWordBtn.textContent;
    exportWordBtn.disabled = true;
    exportWordBtn.textContent = '...';

    document.body.classList.add('stat-exporting');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      await ensureDocxLib();
      if (typeof StatisticsWord === 'undefined') {
        throw new Error('Word builder not loaded');
      }

      const charts = {
        turnover: snapshotChart(turnoverChartInstance),
        dynamics: snapshotChart(dynamicsChartInstance),
        tourism:  snapshotChart(tourismChartInstance),
        fdi:      snapshotChart(fdiChartInstance),
      };

      await StatisticsWord.build(pdfState, {
        lang: wordLang || 'en',
        country: pdfState.country.displayLabel,
        countryNameEn: pdfState.countryNameEn,
        charts,
      });
    } catch (err) {
      console.error('Word export error:', err);
      alert(I18n.tr('statistics.wordExportFailed') + ' ' + (err.message || err));
    } finally {
      document.body.classList.remove('stat-exporting');
      [turnoverChartInstance, dynamicsChartInstance, tourismChartInstance, fdiChartInstance]
        .forEach(c => { if (c) { try { c.resize(); } catch (_) {} } });
      exportWordBtn.disabled = false;
      exportWordBtn.textContent = origBtnText;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── APPENDIX TAB ───────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  // Multi-year trade matrix: 6 full years + 2 YTD columns (prior-year YTD
  // and current-year YTD). Rows: Georgia total / country value / YoY change
  // / share, for each of Turnover/Export/Import, plus a single Balance row.
  // Data source: POST /api/statistics/country-appendix (single call;
  // backend fans out two Geostat calls per flow with the no-sum / multi-
  // year shape that proves reliable).

  async function buildAppendix(latestYear, latestMonth, countryId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`${PROXY_API}/country-appendix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latestYear, latestMonth, countryId }),
        signal: ctrl.signal,
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.success) return null;
      // Server returns columns + per-column { totals, country | null } in
      // exactly the shape renderAppendix consumes. No client reshaping.
      const anyData = (j.data || []).some((d) => d && d.totals);
      if (!anyData) return null;
      return {
        latestYear: j.latestYear,
        latestMonth: j.latestMonth,
        ytdMode: !!j.ytdMode,
        columns: j.columns || [],
        data: j.data || [],
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function fmtAppendixNum(v) {
    if (v == null || !isFinite(v)) return '-';
    if (v === 0) return '0.00';
    return formatMln2(v);
  }

  function fmtAppendixPct(v, signed) {
    if (v == null || !isFinite(v)) return '-';
    const sign = signed && v > 0 ? '+' : '';
    return `${sign}${formatChangePct(v)}`;
  }

  function renderAppendix(state, isKa) {
    if (!appendixTableEl) return;
    if (!state || !state.columns || state.columns.length === 0) {
      if (appendixHeaderEl) appendixHeaderEl.innerHTML = '';
      appendixTableEl.innerHTML = '';
      return;
    }

    const countryKa = selectedCountry ? selectedCountry.displayLabel : '';
    const countryEn = (selectedCountry && countryNameEnMap[selectedCountry.value]) || countryKa;
    const countryLabel = isKa ? countryKa : countryEn;
    const countryAbbr = (countryLabel || '').slice(0, 3);

    const title = isKa
      ? `${countryKa} - დანართი`
      : `${countryEn} - Appendix`;
    if (appendixHeaderEl) {
      appendixHeaderEl.innerHTML = `<h3 class="stat-report__title">${escapeHtml(title)}</h3>`;
    }

    const L = {
      turnover: isKa ? 'ბრუნვა' : 'Turnover',
      export:   isKa ? 'ექსპორტი' : 'Export',
      import:   isKa ? 'იმპორტი' : 'Import',
      balance:  isKa ? 'სალდო' : 'Balance',
      change:   isKa ? 'ცვლილება %' : 'Change %',
      share:    isKa ? 'წილი %' : 'Share %',
    };

    const cols = state.columns;
    const N = cols.length;

    function canCompareChange(i) {
      if (i === 0) return false;
      const a = cols[i - 1], b = cols[i];
      if (a.kind !== b.kind) return false;
      if (b.year - a.year !== 1) return false;
      if (b.kind === 'ytd' && a.months.length !== b.months.length) return false;
      return true;
    }

    const getCountry = (i, flow) => {
      const d = state.data[i];
      return d && d.country ? d.country[flow] : null;
    };
    const getTotal = (i, flow) => {
      const d = state.data[i];
      return d && d.totals ? d.totals[flow] : null;
    };

    const headerCells = [`<th>&nbsp;</th>`]
      .concat(cols.map((c) => `<th>${escapeHtml(c.label)}</th>`))
      .join('');

    function totalsRow(label, flow) {
      const cells = cols
        .map((_, i) => `<td>${fmtAppendixNum(getTotal(i, flow))}</td>`)
        .join('');
      return `<tr class="stat-appendix__group"><td>${escapeHtml(label)}</td>${cells}</tr>`;
    }

    function valueRow(label, flow) {
      const cells = cols
        .map((_, i) => `<td>${fmtAppendixNum(getCountry(i, flow))}</td>`)
        .join('');
      return `<tr><td>${escapeHtml(label)}</td>${cells}</tr>`;
    }

    function changeRow(label, flow) {
      const cells = cols.map((_, i) => {
        if (!canCompareChange(i)) return `<td>-</td>`;
        const cur = getCountry(i, flow);
        const prev = getCountry(i - 1, flow);
        if (cur == null || prev == null || prev === 0) return `<td>-</td>`;
        const pct = ((cur - prev) / prev) * 100;
        const cls = pct > 0 ? 'stat-positive' : (pct < 0 ? 'stat-negative' : '');
        return `<td class="${cls}">${fmtAppendixPct(pct, true)}</td>`;
      }).join('');
      return `<tr><td>${escapeHtml(label)}</td>${cells}</tr>`;
    }

    function shareRow(label, flow) {
      const cells = cols.map((_, i) => {
        const cur = getCountry(i, flow);
        const tot = getTotal(i, flow);
        if (cur == null || !tot) return `<td class="stat-appendix__share">-</td>`;
        return `<td class="stat-appendix__share">${fmtAppendixPct((cur / tot) * 100, false)}</td>`;
      }).join('');
      return `<tr><td>${escapeHtml(label)}</td>${cells}</tr>`;
    }

    function flowBlock(groupLabel, flow) {
      return [
        totalsRow(groupLabel, flow),
        valueRow(`${groupLabel}-${countryAbbr}`, flow),
        changeRow(L.change, flow),
        shareRow(L.share, flow),
      ].join('');
    }

    const balanceCells = cols.map((_, i) => {
      const c = state.data[i] && state.data[i].country;
      // null on either side means that flow's Geostat fetch was empty —
      // we don't know the value, so balance is undefined, render '-'.
      if (!c || c.export == null || c.import == null) return `<td>-</td>`;
      const bal = c.export - c.import;
      const cls = bal > 0 ? 'stat-positive' : (bal < 0 ? 'stat-negative' : '');
      const sign = bal < 0 ? '-' : '';
      return `<td class="${cls}">${sign}${fmtAppendixNum(Math.abs(bal))}</td>`;
    }).join('');

    const html = `
      <table class="stat-appendix">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>
          ${flowBlock(L.turnover, 'turnover')}
          ${flowBlock(L.export, 'export')}
          ${flowBlock(L.import, 'import')}
          <tr class="stat-appendix__group"><td>${escapeHtml(L.balance)}</td>${balanceCells}</tr>
        </tbody>
      </table>`;
    appendixTableEl.innerHTML = html;
  }

  async function generateAppendix(latestYear, latestMonth) {
    if (!selectedCountry) return;
    if (appendixLoadingEl) appendixLoadingEl.classList.remove('hidden');
    // Clear stale content so the spinner is the only thing visible while
    // the new country's data is being fetched (matches the Trade tab).
    if (appendixTableEl) appendixTableEl.innerHTML = '';
    if (appendixHeaderEl) appendixHeaderEl.innerHTML = '';
    try {
      const appendix = await buildAppendix(latestYear, latestMonth, selectedCountry.value);
      pdfState.appendix = appendix;
      renderAppendix(appendix, reportLocale === 'ka');
    } catch (err) {
      console.error('Appendix error:', err);
      pdfState.appendix = null;
      if (appendixTableEl) appendixTableEl.innerHTML = '';
      if (appendixHeaderEl) appendixHeaderEl.innerHTML = '';
    } finally {
      if (appendixLoadingEl) appendixLoadingEl.classList.add('hidden');
    }
  }
})();
