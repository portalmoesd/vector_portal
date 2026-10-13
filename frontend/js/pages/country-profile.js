/**
 * Country profile page (admin preview).
 *
 * Renders one economy from /api/country-profiles/countries/:slug:
 *   - hero: flag, name, official names, region / income pills, quick facts
 *   - key figures: seven World Bank indicators, each with its data year
 *   - sections with a sticky "On this page" nav: Introduction, Overview,
 *     People, Government, Economy (with a 20-year GDP / population chart
 *     when Chart.js is present) and Trade — only those with data
 * Every figure shows its data year and links to its source; a missing
 * value is shown as "No data", never filled. Factbook text is sanitized
 * server-side at import time and rendered as HTML.
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

  // Short labels for indicators; the source's own indicator name is kept as
  // a tooltip / sub-label so the source wording is never lost.
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
  const KEY_FIGURES = ['SP.POP.TOTL', 'AG.SRF.TOTL.K2', 'NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS'];
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
  const noData = () => `<span class="cp-nodata">${escapeHtml(t('countryProfiles.noData'))}</span>`;

  // Data-year + source tag shown next to every World Bank figure. The full
  // source name and retrieval date sit in the tooltip; the section footer
  // repeats them in full. References are plain text: the source URLs are
  // machine-readable API responses, not pages for a reader.
  function sourceTag(ind) {
    if (ind.value == null) return `<span class="cp-tag cp-tag--none">${escapeHtml(t('countryProfiles.noDataSource'))}</span>`;
    const retrieved = ind.retrievedAt ? `${t('countryProfiles.retrieved')} ${formatDate(ind.retrievedAt)}` : '';
    const title = `${ind.name} · ${ind.sourceName}${retrieved ? ` · ${retrieved}` : ''}`;
    return `<span class="cp-tag" title="${escapeHtml(title)}"><span class="cp-tag__year">${ind.year}</span><span class="cp-tag__src">${escapeHtml(t('countryProfiles.sourceShort'))}</span></span>`;
  }

  function wbAttribution(indicators) {
    const withData = indicators.filter((i) => i.value != null);
    const src = withData[0];
    if (!src) return '';
    const retrieved = src.retrievedAt ? ` · ${t('countryProfiles.retrieved')} ${formatDate(src.retrievedAt)}` : '';
    return `<div class="cp-attrib"><span class="cp-attrib__label">${escapeHtml(t('countryProfiles.source'))}</span> ${escapeHtml(src.sourceName)}${escapeHtml(retrieved)} · ${escapeHtml(t('countryProfiles.latestYearNote'))}</div>`;
  }

  function fbAttribution(src) {
    if (!src) return '';
    const when = src.dataDate ? t('countryProfiles.factbook.snapshot', { date: src.dataDate }) : '';
    const ended = src.discontinued ? t('countryProfiles.factbook.discontinued', { date: formatDate(src.discontinued) }) : '';
    return `<div class="cp-attrib"><span class="cp-attrib__label">${escapeHtml(t('countryProfiles.source'))}</span> ${escapeHtml(src.name)}${when ? ` · ${escapeHtml(when)}` : ''}${ended ? ` · ${escapeHtml(ended)}` : ''}</div>`;
  }

  // ── Table rows (one visual language for every section) ──────────────
  // A row is { attrs, label, sub, body, meta } where body is HTML.
  function tr({ attrs = '', label: lbl, sub = '', body, meta = '', edited = false }) {
    return `<div class="cp-tr" ${attrs}>
      <div class="cp-tr__label">${escapeHtml(lbl)}${edited ? ` <span class="pill pill-blue">${escapeHtml(t('countryProfiles.factbook.edited'))}</span>` : ''}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>
      <div class="cp-tr__value">${body}</div>
      <div class="cp-tr__meta">${meta}</div>
    </div>`;
  }

  function indicatorRow(ind) {
    const v = fmtValue(ind, { compact: false });
    return tr({
      attrs: `data-code="${escapeHtml(ind.code)}"`,
      label: label(ind.code), sub: ind.name,
      body: v == null ? noData() : `<span class="cp-num">${escapeHtml(v)}</span>`,
      meta: sourceTag(ind),
    });
  }

  function factRow(labelText, value, attrs = '') {
    return tr({ attrs, label: labelText, body: value ? escapeHtml(value) : noData() });
  }

  function itemsHtml(items) {
    return `<dl class="cp-items">${items.map((it) => `<div class="cp-items__row"><dt>${escapeHtml(it.label)}</dt><dd>${it.text}</dd></div>`).join('')}</dl>`;
  }

  function textRow(row) {
    const c = row.content || {};
    const parts = [];
    if (c.text) parts.push(`<div class="cp-prose cp-prose--cell">${c.text}</div>`);
    if (c.items && c.items.length) parts.push(itemsHtml(c.items));
    return tr({ attrs: `data-field="${escapeHtml(row.field)}"`, label: row.label || row.field, body: parts.join(''), edited: !!row.edited });
  }

  function groupCaption(text) {
    return `<div class="cp-table__group">${escapeHtml(text)}</div>`;
  }

  function table(inner) {
    return `<div class="cp-table">${inner}</div>`;
  }

  // ── Hero ─────────────────────────────────────────────────────────────
  const fbItem = (rows, field, itemLabel) => {
    const r = (rows || []).find((x) => x.field === field);
    if (!r) return null;
    if (itemLabel == null) return r.content && r.content.text;
    const it = (r.content.items || []).find((i) => i.label === itemLabel);
    return it ? it.text : null;
  };
  const plain = (html) => (html || '').replace(/<[^>]+>/g, '').trim();

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

  function renderHero(data) {
    const c = data.country;
    const gov = (data.texts && data.texts.sections && data.texts.sections.government) || [];
    const name = isKa() && c.nameKa ? c.nameKa : c.name;
    const flag = c.iso2 ? flagUrl(c.iso2) : '';
    const img = flag
      ? `<img class="cp-hero__flag" src="${flag}" alt="${escapeHtml(t('countryProfiles.flagAlt', { name: c.name }))}" width="88" height="88" />`
      : '<span class="cp-hero__flag cp-hero__flag--none" aria-hidden="true"></span>';

    // One subtitle only: the official long-form name from the Factbook
    // ("Kingdom of Belgium"); "none" means the source has no long form, in
    // which case the local long form is used. Local-language variants are
    // left to the Government section.
    const longForm = plain(fbItem(gov, 'Country name', 'conventional long form'));
    const localLong = plain(fbItem(gov, 'Country name', 'local long form'));
    const official = longForm && longForm !== 'none' ? longForm : (localLong && localLong !== 'none' ? localLong : '');
    const subtitle = [isKa() && c.nameKa ? c.name : '', official && official !== c.name ? official : ''].filter(Boolean).join(' · ');

    const pills = [
      c.region.name ? `<a class="pill pill-blue cp-pill" href="/pages/country-profiles.html?region=${encodeURIComponent(c.region.id || '')}">${escapeHtml(c.region.name)}</a>` : '',
      c.incomeLevel.name ? `<span class="pill pill-green cp-pill">${escapeHtml(c.incomeLevel.name)}</span>` : '',
    ].filter(Boolean).join('');

    $('cpHeader').innerHTML = `
      ${img}
      <div class="cp-hero__title">
        <h1 class="cp-hero__name">${escapeHtml(name)}</h1>
        ${subtitle ? `<div class="cp-hero__official">${escapeHtml(subtitle)}</div>` : ''}
        <div class="cp-hero__meta">
          <div class="cp-hero__pills">${pills}</div>
          <dl class="cp-hero__facts"><div class="cp-hero__fact" data-fact="capital"><dt>${escapeHtml(t('countryProfiles.capital'))}</dt><dd>${c.capital ? escapeHtml(c.capital) : noData()}</dd></div></dl>
        </div>
      </div>
      <div class="cp-hero__src">${escapeHtml(t('countryProfiles.source'))}: ${escapeHtml(t('countryProfiles.countryListSource'))}${c.retrievedAt ? ` · ${escapeHtml(t('countryProfiles.retrieved'))} ${escapeHtml(formatDate(c.retrievedAt))}` : ''}</div>`;
  }

  // ── Key figures ──────────────────────────────────────────────────────
  function kfItem(ind) {
    const v = fmtValue(ind);
    return `<div class="cp-kf__item" data-code="${escapeHtml(ind.code)}">
      <div class="cp-kf__label" title="${escapeHtml(ind.name)}">${escapeHtml(label(ind.code))}</div>
      <div class="cp-kf__value${v == null ? ' cp-kf__value--none' : ''}">${v == null ? escapeHtml(t('countryProfiles.noData')) : escapeHtml(v)}</div>
      <div class="cp-kf__meta">${sourceTag(ind)}</div>
    </div>`;
  }

  function renderKeyFigures(indicators) {
    const byCode = new Map(indicators.map((i) => [i.code, i]));
    const list = KEY_FIGURES.filter((c) => byCode.has(c)).map((c) => byCode.get(c));
    $('cpTiles').innerHTML = `<section class="card cp-kf" aria-labelledby="cpKfTitle">
      <div class="cp-section__head"><h2 class="cp-section__title" id="cpKfTitle">${escapeHtml(t('countryProfiles.keyFigures'))}</h2></div>
      <div class="cp-kf__grid">${list.map(kfItem).join('')}</div>
      ${wbAttribution(list)}
    </section>`;
  }

  // ── Sections ─────────────────────────────────────────────────────────
  function renderSections(data) {
    const { country: c, indicators, series } = data;
    const texts = (data.texts && data.texts.sections) || {};
    const fbSrc = data.texts && data.texts.source;
    const txt = (id) => texts[id] || [];
    const bySection = {};
    for (const s of SECTIONS) bySection[s] = indicators.filter((i) => i.section === s);
    const hasData = (list) => list.some((i) => i.value != null);
    const parts = [];
    const toc = [];

    const section = (id, inner, { lead = null } = {}) => {
      toc.push(id);
      parts.push(`<section class="card cp-section" id="section-${id}" aria-labelledby="h-${id}">
        <div class="cp-section__head"><h2 class="cp-section__title" id="h-${id}">${escapeHtml(t(`countryProfiles.sections.${id}`))}</h2>${lead ? `<p class="cp-section__lead">${escapeHtml(lead)}</p>` : ''}</div>${inner}</section>`);
    };

    // Introduction: the Factbook background, as prose.
    if (txt('introduction').length) {
      const bg = txt('introduction').map((r) => `<div class="cp-prose" data-field="${escapeHtml(r.field)}">${r.edited ? `<span class="pill pill-blue">${escapeHtml(t('countryProfiles.factbook.edited'))}</span>` : ''}${(r.content && r.content.text) || ''}${r.content && r.content.items && r.content.items.length ? itemsHtml(r.content.items) : ''}</div>`).join('');
      section('introduction', `${bg}${fbAttribution(fbSrc)}`);
    }

    // Overview: identity facts (World Bank list), surface area, then the
    // geography fields from the Factbook.
    const listSrc = { value: 1, year: null, sourceName: t('countryProfiles.countryListSource'), sourceUrl: c.sourceUrl, retrievedAt: c.retrievedAt, name: '' };
    const listTag = `<span class="cp-tag" title="${escapeHtml(`${listSrc.sourceName}${c.retrievedAt ? ` · ${t('countryProfiles.retrieved')} ${formatDate(c.retrievedAt)}` : ''}`)}"><span class="cp-tag__src">${escapeHtml(t('countryProfiles.sourceShort'))}</span></span>`;
    const overviewRows = [
      tr({ attrs: 'data-fact="region"', label: t('countryProfiles.region'), body: c.region.name ? escapeHtml(c.region.name) : noData(), meta: listTag }),
      tr({ attrs: 'data-fact="income"', label: t('countryProfiles.incomeLevel'), body: c.incomeLevel.name ? escapeHtml(c.incomeLevel.name) : noData(), meta: listTag }),
      tr({ attrs: 'data-fact="capital"', label: t('countryProfiles.capital'), body: c.capital ? escapeHtml(c.capital) : noData(), meta: listTag }),
      ...bySection.overview.map(indicatorRow),
    ].join('');
    const geoRows = txt('overview').map(textRow).join('');
    section('overview', `${table(overviewRows + (geoRows ? groupCaption(t('countryProfiles.factbook.fromFactbook')) + geoRows : ''))}${geoRows ? fbAttribution(fbSrc) : ''}`);

    // People: indicators, then Languages / Religions.
    if (hasData(bySection.people) || txt('people').length) {
      const wb = hasData(bySection.people) ? bySection.people.map(indicatorRow).join('') : '';
      const fb = txt('people').map(textRow).join('');
      section('people', `${table(wb + (fb ? (wb ? groupCaption(t('countryProfiles.factbook.fromFactbook')) : '') + fb : ''))}${wb ? wbAttribution(bySection.people) : ''}${fb ? fbAttribution(fbSrc) : ''}`);
    }

    if (txt('government').length) {
      section('government', `${table(txt('government').map(textRow).join(''))}${fbAttribution(fbSrc)}`);
    }

    if (hasData(bySection.economy)) {
      let chart = '';
      if (window.Chart && chartHasData(series)) {
        chart = `<div class="cp-chart"><h3 class="cp-chart__title">${escapeHtml(t('countryProfiles.chart.title'))}</h3><div class="cp-chart__canvas"><canvas id="cpChart" role="img" aria-label="${escapeHtml(t('countryProfiles.chart.title'))}"></canvas></div></div>`;
      }
      section('economy', `${table(bySection.economy.map(indicatorRow).join(''))}${chart}${wbAttribution(bySection.economy)}`);
    }

    if (hasData(bySection.trade)) {
      section('trade', `<div class="cp-kf__grid cp-kf__grid--pair">${bySection.trade.map(kfItem).join('')}</div>${wbAttribution(bySection.trade)}`);
    }

    $('cpSections').innerHTML = parts.join('');
    $('cpTocList').innerHTML = toc.map((id) => `<li><a href="#section-${id}" data-target="section-${id}">${escapeHtml(t(`countryProfiles.sections.${id}`))}</a></li>`).join('');
    if (window.Chart && document.getElementById('cpChart')) drawChart(series);
    observeSections();
  }

  function chartHasData(series) {
    return series && ((series['NY.GDP.MKTP.CD'] || []).length >= 2 || (series['SP.POP.TOTL'] || []).length >= 2);
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
    const grid = css.getPropertyValue('--border-color').trim() || '#e2e8f0';
    const font = css.getPropertyValue('--font-primary').trim();
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('cpChart'), {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          { label: t('countryProfiles.chart.gdp'), data: byYear(gdp), yAxisID: 'yGdp', borderColor: blue, backgroundColor: blue, borderWidth: 2, tension: 0.3, pointRadius: 0, pointHitRadius: 8, spanGaps: false },
          { label: t('countryProfiles.chart.population'), data: byYear(pop), yAxisID: 'yPop', borderColor: green, backgroundColor: green, borderWidth: 2, borderDash: [5, 4], tension: 0.3, pointRadius: 0, pointHitRadius: 8, spanGaps: false },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: text, font: { family: font }, usePointStyle: true, boxWidth: 8 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.dataset.yAxisID === 'yGdp' ? fmtUsdCompact(ctx.parsed.y) : fmtInt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: text, font: { family: font }, maxTicksLimit: 10 }, grid: { display: false } },
          yGdp: { position: 'left', ticks: { color: text, font: { family: font }, maxTicksLimit: 6, callback: (v) => fmtTick(v) }, grid: { color: grid }, title: { display: true, text: t('countryProfiles.chart.gdp'), color: text } },
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
    $('cpFooter').textContent = `${t('countryProfiles.source')}: ${data.source.name} · ${t('countryProfiles.lastSync')}: ${sync} · ${t('countryProfiles.latestYearNote')}`;
  }

  // ── Load ─────────────────────────────────────────────────────────────
  try {
    if (!slug) throw Object.assign(new Error(t('countryProfiles.notFound')), { status: 404 });
    const data = await Api.get(`/api/country-profiles/countries/${encodeURIComponent(slug)}`);
    renderBreadcrumb(data.country);
    renderHero(data);
    renderKeyFigures(data.indicators);
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
