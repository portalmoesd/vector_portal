/**
 * Country profile page (admin preview).
 *
 * Renders one economy from /api/country-profiles/countries/:slug: header,
 * key-figure tiles, the Overview / People / Economy / Trade sections (only
 * those with data) with a sticky "On this page" nav, and a GDP + population
 * line chart when Chart.js is present. Every figure shows its data year and
 * links to its source; a missing value is shown as "No data", never filled.
 */
(async function () {
  await App.init();
  const user = Api.getUser();
  if (!user || user.role !== 'ADMIN') return;

  const t = (key, params) => I18n.tr(key, params);
  const isKa = () => I18n.getLocale() === 'ka';
  const $ = (id) => document.getElementById(id);
  const loadingEl = $('cpLoading');
  const errorEl = $('cpError');
  const profileEl = $('cpProfile');

  const slug = new URLSearchParams(window.location.search).get('country') || '';

  // Short labels for tiles and rows; the source's own indicator name is
  // shown underneath each figure so the wording of the source is preserved.
  const LABEL = {
    'SP.POP.TOTL': 'population',
    'AG.SRF.TOTL.K2': 'surfaceArea',
    'NY.GDP.MKTP.CD': 'gdp',
    'NY.GDP.PCAP.CD': 'gdpPerCapita',
    'NY.GDP.MKTP.KD.ZG': 'gdpGrowth',
    'FP.CPI.TOTL.ZG': 'inflation',
    'SL.UEM.TOTL.ZS': 'unemployment',
    'NE.EXP.GNFS.CD': 'exports',
    'NE.IMP.GNFS.CD': 'imports',
    'SP.DYN.LE00.IN': 'lifeExpectancy',
    'SP.URB.TOTL.IN.ZS': 'urbanPopulation',
  };
  const TILE_CODES = ['SP.POP.TOTL', 'AG.SRF.TOTL.K2', 'NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS'];
  const SECTIONS = ['overview', 'people', 'economy', 'trade'];

  // ── Formatting ───────────────────────────────────────────────────────
  const numLocale = () => 'en-US';
  function fmtInt(v) { return Math.round(v).toLocaleString(numLocale()); }
  function fmtDec(v, d = 1) { return Number(v).toLocaleString(numLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtUsdCompact(v) {
    const abs = Math.abs(v); const sign = v < 0 ? '-' : '';
    let num; let unitEn; let unitKa;
    if (abs >= 1e12) { num = abs / 1e12; unitEn = 'T'; unitKa = 'ტრლნ'; }
    else if (abs >= 1e9) { num = abs / 1e9; unitEn = 'B'; unitKa = 'მლრდ'; }
    else if (abs >= 1e6) { num = abs / 1e6; unitEn = 'M'; unitKa = 'მლნ'; }
    else if (abs >= 1e3) { num = abs / 1e3; unitEn = 'K'; unitKa = 'ათ.'; }
    else { num = abs; unitEn = ''; unitKa = ''; }
    const digits = num >= 100 ? 0 : num >= 10 ? 1 : 2;
    const s = num.toLocaleString(numLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return isKa() ? `${sign}${s} ${unitKa} $`.replace(/\s+\$/, ' $') : `${sign}$${s}${unitEn}`;
  }
  // Axis ticks: compact number without the currency sign (the axis title
  // carries the unit), so long Georgian unit words fit on narrow screens.
  function fmtTick(v) {
    return fmtUsdCompact(v).replace(/\s*\$/g, '');
  }

  function fmtValue(ind, { compact = true } = {}) {
    if (ind.value == null) return null;
    const v = ind.value;
    switch (ind.unit) {
      case 'usd': return compact ? fmtUsdCompact(v) : `$${fmtInt(v)}`;
      case 'pct': return `${fmtDec(v, 1)}%`;
      case 'sqkm': return `${fmtInt(v)} km²`;
      case 'years': return `${fmtDec(v, 1)} ${t('countryProfiles.units.years')}`;
      default: return fmtInt(v);
    }
  }
  const label = (code) => t(`countryProfiles.indicators.${LABEL[code] || code}`);

  // Attribution line: "2024 · World Bank, WDI · retrieved 12/10/2026"
  function sourceLine(ind) {
    if (ind.value == null) return `<span class="cp-src cp-src--none">${escapeHtml(t('countryProfiles.noDataSource'))}</span>`;
    const retrieved = ind.retrievedAt ? formatDate(ind.retrievedAt) : '';
    return `<span class="cp-src"><span class="cp-src__year">${ind.year}</span> · <a href="${escapeHtml(ind.sourceUrl)}" target="_blank" rel="noopener" title="${escapeHtml(ind.name)}">${escapeHtml(ind.sourceName)}</a>${retrieved ? ` · ${escapeHtml(t('countryProfiles.retrieved'))} ${escapeHtml(retrieved)}` : ''}</span>`;
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function renderBreadcrumb(c) {
    const name = isKa() && c.nameKa ? c.nameKa : c.name;
    const items = [
      { href: dashboardUrl(user.role), text: t('countryProfiles.breadcrumb.home') },
      { href: '/pages/country-profiles.html', text: t('countryProfiles.breadcrumb.countries') },
      { href: `/pages/country-profiles.html?region=${encodeURIComponent(c.region.id || '')}`, text: c.region.name || '' },
      { text: name, current: true },
    ];
    $('cpBreadcrumb').innerHTML = `<ol class="cp-breadcrumb__list">${items.map((it) => it.current
      ? `<li aria-current="page">${escapeHtml(it.text)}</li>`
      : `<li><a href="${it.href}">${escapeHtml(it.text)}</a></li>`).join('')}</ol>`;
    document.title = `Vector Portal — ${name}`;
  }

  function renderHeader(c) {
    const name = isKa() && c.nameKa ? c.nameKa : c.name;
    const flag = c.iso2 ? flagUrl(c.iso2) : '';
    const img = flag
      ? `<img class="cp-header__flag" src="${flag}" alt="${escapeHtml(t('countryProfiles.flagAlt', { name: c.name }))}" width="72" height="72" />`
      : '<span class="cp-header__flag cp-header__flag--none" aria-hidden="true"></span>';
    const facts = [
      [t('countryProfiles.region'), c.region.name],
      [t('countryProfiles.capital'), c.capital],
      [t('countryProfiles.incomeLevel'), c.incomeLevel.name],
    ];
    $('cpHeader').innerHTML = `${img}
      <div class="cp-header__text">
        <h1 class="cp-header__name">${escapeHtml(name)}</h1>
        ${isKa() && c.nameKa ? `<div class="cp-header__alt">${escapeHtml(c.name)}</div>` : ''}
        <dl class="cp-header__facts">${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v ? escapeHtml(v) : `<span class="cp-nodata">${escapeHtml(t('countryProfiles.noData'))}</span>`}</dd></div>`).join('')}</dl>
        <div class="cp-header__src">${escapeHtml(t('countryProfiles.source'))}: <a href="${escapeHtml(c.sourceUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(t('countryProfiles.countryListSource'))}</a>${c.retrievedAt ? ` · ${escapeHtml(t('countryProfiles.retrieved'))} ${escapeHtml(formatDate(c.retrievedAt))}` : ''}</div>
      </div>`;
  }

  function tile(ind) {
    const v = fmtValue(ind);
    return `<div class="cp-tile" data-code="${escapeHtml(ind.code)}">
      <div class="cp-tile__label">${escapeHtml(label(ind.code))}</div>
      <div class="cp-tile__value${v == null ? ' cp-tile__value--none' : ''}">${v == null ? escapeHtml(t('countryProfiles.noData')) : escapeHtml(v)}</div>
      <div class="cp-tile__src">${sourceLine(ind)}</div>
    </div>`;
  }

  function renderTiles(indicators) {
    const byCode = new Map(indicators.map((i) => [i.code, i]));
    $('cpTiles').innerHTML = TILE_CODES.filter((c) => byCode.has(c)).map((c) => tile(byCode.get(c))).join('');
  }

  function row(ind) {
    const v = fmtValue(ind, { compact: false });
    return `<div class="cp-row" data-code="${escapeHtml(ind.code)}">
      <div class="cp-row__label">${escapeHtml(label(ind.code))}<small>${escapeHtml(ind.name)}</small></div>
      <div class="cp-row__value${v == null ? ' cp-nodata' : ''}">${v == null ? escapeHtml(t('countryProfiles.noData')) : escapeHtml(v)}</div>
      <div class="cp-row__src">${sourceLine(ind)}</div>
    </div>`;
  }

  function factRow(labelText, value) {
    return `<div class="cp-row"><div class="cp-row__label">${escapeHtml(labelText)}</div>
      <div class="cp-row__value${value ? '' : ' cp-nodata'}">${value ? escapeHtml(value) : escapeHtml(t('countryProfiles.noData'))}</div><div class="cp-row__src"></div></div>`;
  }

  function renderSections(data) {
    const { country: c, indicators, series } = data;
    const bySection = {};
    for (const s of SECTIONS) bySection[s] = indicators.filter((i) => i.section === s);
    const hasData = (list) => list.some((i) => i.value != null);
    const parts = [];
    const toc = [];

    const section = (id, inner) => {
      toc.push(id);
      parts.push(`<section class="card cp-section" id="section-${id}" aria-labelledby="h-${id}">
        <h2 class="cp-section__title" id="h-${id}">${escapeHtml(t(`countryProfiles.sections.${id}`))}</h2>${inner}</section>`);
    };

    // Overview: header facts plus surface area; always has region/income.
    section('overview', `<div class="cp-rows">
      ${factRow(t('countryProfiles.region'), c.region.name)}
      ${factRow(t('countryProfiles.incomeLevel'), c.incomeLevel.name)}
      ${factRow(t('countryProfiles.capital'), c.capital)}
      ${bySection.overview.map(row).join('')}
    </div>`);

    for (const id of ['people', 'economy', 'trade']) {
      if (!hasData(bySection[id])) continue;
      let extra = '';
      if (id === 'economy' && window.Chart && chartHasData(series)) {
        extra = `<div class="cp-chart"><h3 class="cp-chart__title">${escapeHtml(t('countryProfiles.chart.title'))}</h3><div class="cp-chart__canvas"><canvas id="cpChart" role="img" aria-label="${escapeHtml(t('countryProfiles.chart.title'))}"></canvas></div><div class="cp-chart__src">${chartSourceLine(indicators)}</div></div>`;
      }
      section(id, `<div class="cp-rows">${bySection[id].map(row).join('')}</div>${extra}`);
    }

    $('cpSections').innerHTML = parts.join('');
    $('cpTocList').innerHTML = toc.map((id) => `<li><a href="#section-${id}" data-target="section-${id}">${escapeHtml(t(`countryProfiles.sections.${id}`))}</a></li>`).join('');
    if (window.Chart && document.getElementById('cpChart')) drawChart(series);
    observeSections();
  }

  function chartHasData(series) {
    return series && ((series['NY.GDP.MKTP.CD'] || []).length >= 2 || (series['SP.POP.TOTL'] || []).length >= 2);
  }

  function chartSourceLine(indicators) {
    const gdp = indicators.find((i) => i.code === 'NY.GDP.MKTP.CD');
    const pop = indicators.find((i) => i.code === 'SP.POP.TOTL');
    const src = gdp || pop;
    if (!src) return '';
    return `${escapeHtml(t('countryProfiles.source'))}: <a href="${escapeHtml(src.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(src.sourceName)}</a>`;
  }

  let chart = null;
  function drawChart(series) {
    const gdp = series['NY.GDP.MKTP.CD'] || [];
    const pop = series['SP.POP.TOTL'] || [];
    const years = [...new Set([...gdp, ...pop].map((p) => p.year))].sort((a, b) => a - b);
    const byYear = (arr) => { const m = new Map(arr.map((p) => [p.year, p.value])); return years.map((y) => (m.has(y) ? m.get(y) : null)); };
    const css = getComputedStyle(document.documentElement);
    const blue = css.getPropertyValue('--accent-blue').trim() || '#3b82f6';
    const green = css.getPropertyValue('--accent-green').trim() || '#16a34a';
    const text = css.getPropertyValue('--text-secondary').trim() || '#64748b';
    const font = css.getPropertyValue('--font-primary').trim();
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('cpChart'), {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          { label: t('countryProfiles.chart.gdp'), data: byYear(gdp), yAxisID: 'yGdp', borderColor: blue, backgroundColor: blue, tension: 0.25, pointRadius: 2, spanGaps: false },
          { label: t('countryProfiles.chart.population'), data: byYear(pop), yAxisID: 'yPop', borderColor: green, backgroundColor: green, tension: 0.25, pointRadius: 2, spanGaps: false },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: text, font: { family: font } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.dataset.yAxisID === 'yGdp' ? fmtUsdCompact(ctx.parsed.y) : fmtInt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: text, font: { family: font } }, grid: { display: false } },
          yGdp: { position: 'left', ticks: { color: text, font: { family: font }, maxTicksLimit: 6, callback: (v) => fmtTick(v) }, title: { display: true, text: t('countryProfiles.chart.gdp'), color: text } },
          yPop: { position: 'right', ticks: { color: text, font: { family: font }, maxTicksLimit: 6, callback: (v) => fmtTick(v) }, grid: { drawOnChartArea: false }, title: { display: true, text: t('countryProfiles.chart.population'), color: text } },
        },
      },
    });
  }

  // Highlight the section in view in the sticky nav.
  function observeSections() {
    const links = [...document.querySelectorAll('#cpTocList a')];
    if (!links.length || !('IntersectionObserver' in window)) return;
    const setActive = (id) => links.forEach((a) => a.classList.toggle('is-active', a.dataset.target === id));
    setActive(links[0].dataset.target);
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActive(visible[0].target.id);
    }, { rootMargin: '-120px 0px -60% 0px', threshold: 0 });
    document.querySelectorAll('.cp-section').forEach((s) => obs.observe(s));
  }

  function renderFooter(data) {
    const sync = data.lastSync && data.lastSync.finishedAt ? formatDateTime(data.lastSync.finishedAt) : '—';
    $('cpFooter').innerHTML = `${escapeHtml(t('countryProfiles.source'))}: <a href="${escapeHtml(data.source.url)}" target="_blank" rel="noopener">${escapeHtml(data.source.name)}</a> · ${escapeHtml(t('countryProfiles.lastSync'))}: ${escapeHtml(sync)} · ${escapeHtml(t('countryProfiles.latestYearNote'))}`;
  }

  // ── Load ─────────────────────────────────────────────────────────────
  try {
    if (!slug) throw Object.assign(new Error(t('countryProfiles.notFound')), { status: 404 });
    const data = await Api.get(`/api/country-profiles/countries/${encodeURIComponent(slug)}`);
    renderBreadcrumb(data.country);
    renderHeader(data.country);
    renderTiles(data.indicators);
    renderSections(data);
    renderFooter(data);
    profileEl.classList.remove('hidden');
  } catch (err) {
    const msg = err.status === 404 ? t('countryProfiles.notFound') : `${t('countryProfiles.loadFailed')} ${err.message}`;
    errorEl.innerHTML = `<p>${escapeHtml(msg)}</p><a class="btn btn-outline" href="/pages/country-profiles.html">${escapeHtml(t('countryProfiles.breadcrumb.countries'))}</a>`;
    errorEl.classList.remove('hidden');
    $('cpBreadcrumb').innerHTML = `<ol class="cp-breadcrumb__list"><li><a href="${dashboardUrl(user.role)}">${escapeHtml(t('countryProfiles.breadcrumb.home'))}</a></li><li><a href="/pages/country-profiles.html">${escapeHtml(t('countryProfiles.breadcrumb.countries'))}</a></li></ol>`;
  } finally {
    loadingEl.classList.add('hidden');
  }
})();
