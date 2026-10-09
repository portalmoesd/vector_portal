/**
 * Export Potential page (admin preview).
 *
 * Pick a partner country; see every Georgian product rated High, Moderate
 * or Low for that market, with the four block scores and, on expanding a
 * row, each indicator in plain language. A separate "Markets to watch"
 * table lists products the partner has imported for only one or two years.
 * Everything comes precomputed from /api/export-potential; the page does
 * no scoring of its own. The methodology panel is rendered from the same
 * configuration file the pipeline scores with, so the numbers it shows
 * are the numbers in force.
 */
(async function () {
  await App.init();
  const user = Api.getUser();
  if (!user || user.role !== 'ADMIN') return;

  const API = `${API_BASE}/api/export-potential`;
  const t = (key, params) => I18n.tr(key, params);
  const isKa = () => I18n.getLocale() === 'ka';

  // ── DOM ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const countrySearch = $('epCountrySearch');
  const countryDropdown = $('epCountryDropdown');
  const ratingFilter = $('epRatingFilter');
  const productSearch = $('epProductSearch');
  const methodBtn = $('epMethodBtn');
  const loadingEl = $('epLoading');
  const emptyEl = $('epEmpty');
  const errorEl = $('epError');
  const resultEl = $('epResult');
  const bannerEl = $('epSampleBanner');
  const metaEl = $('epMeta');
  const tilesEl = $('epTiles');
  const tableBody = $('epTableBody');
  const noRowsEl = $('epNoRows');
  const productsCount = $('epProductsCount');
  const watchBody = $('epWatchBody');
  const watchCount = $('epWatchCount');
  const noWatchEl = $('epNoWatch');
  const methodEl = $('epMethod');
  const methodBody = $('epMethodBody');
  const footerEl = $('epFooter');

  // ── State ────────────────────────────────────────────────────────────
  let countries = [];
  let config = null;
  let result = null;
  let ratingMode = 'all';
  let productQuery = '';
  const expanded = new Set();

  // ── Formatting ───────────────────────────────────────────────────────
  function fmtUsd(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    let num; let unitEn; let unitKa;
    if (abs >= 1e9) { num = abs / 1e9; unitEn = 'B'; unitKa = 'მლრდ'; }
    else if (abs >= 1e6) { num = abs / 1e6; unitEn = 'M'; unitKa = 'მლნ'; }
    else if (abs >= 1e3) { num = abs / 1e3; unitEn = 'K'; unitKa = 'ათ.'; }
    else { num = abs; unitEn = ''; unitKa = ''; }
    const digits = num >= 100 ? 0 : num >= 10 ? 1 : 2;
    const s = num.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return isKa() ? `${sign}${s} ${unitKa} $`.replace(/\s+\$/, ' $') : `${sign}$${s}${unitEn}`;
  }

  function fmtPct(fraction, { sign = false, digits = 1 } = {}) {
    if (fraction == null || !Number.isFinite(Number(fraction))) return '—';
    const v = Number(fraction) * 100;
    const s = v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${sign && v > 0 ? '+' : ''}${s}%`;
  }

  function fmtNum(v, digits = 2) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtKm(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Math.round(Number(v)).toLocaleString('en-US');
  }

  function fmtTariff(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return `${fmtNum(v, 1)}%`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : formatDate(iso);
  }

  const countryName = (c) => (isKa() ? (c.nameKa || c.nameEn) : c.nameEn);
  const productName = (p) => (isKa() ? (p.name && (p.name.ka || p.name.en)) : (p.name && p.name.en)) || `HS ${p.hs4}`;
  const ratingLabel = (r) => t(`exportPotential.ratings.${r}`);
  const RATING_PILL = { High: 'pill-green', Moderate: 'pill-yellow', Low: 'pill-gray' };

  // ── Loading helpers ──────────────────────────────────────────────────
  function showLoading(on) {
    loadingEl.classList.toggle('hidden', !on);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.toggle('hidden', !msg);
  }

  // ── Country selector (same dropdown pattern as the statistics pages) ──
  function renderCountryDropdown(filter) {
    const q = (filter || '').trim().toLowerCase();
    const list = q
      ? countries.filter((c) => countryName(c).toLowerCase().includes(q) || c.nameEn.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
      : countries;
    if (!list.length) {
      countryDropdown.innerHTML = `<div class="stat-dropdown__empty">${escapeHtml(countries.length ? t('statistics.noResults') : t('exportPotential.noCountries'))}</div>`;
    } else {
      countryDropdown.innerHTML = list.map((c) => {
        const flag = c.iso2 && typeof flagUrl === 'function' ? flagUrl(c.iso2) : '';
        const selected = result && result.partner.iso3 === c.code ? ' selected' : '';
        const tag = c.sample ? ` <span class="pill pill-yellow">${escapeHtml(t('exportPotential.sampleTag'))}</span>` : '';
        return `<div class="stat-dropdown__item${selected}" data-code="${escapeHtml(c.code)}">${flag ? `<img src="${flag}" alt="" width="18" height="18" style="vertical-align:-4px;margin-right:6px;border-radius:50%" />` : ''}${escapeHtml(countryName(c))}${tag} <small style="color:var(--text-secondary)">· ${c.dataYear}</small></div>`;
      }).join('');
    }
    countryDropdown.classList.remove('hidden');
  }

  countrySearch.addEventListener('focus', () => renderCountryDropdown(countrySearch.value));
  countrySearch.addEventListener('input', () => renderCountryDropdown(countrySearch.value));
  countryDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.stat-dropdown__item');
    if (!item) return;
    countryDropdown.classList.add('hidden');
    selectCountry(item.dataset.code);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stat-search-wrap')) countryDropdown.classList.add('hidden');
  });

  async function selectCountry(code) {
    const c = countries.find((x) => x.code === code);
    if (!c) return;
    countrySearch.value = countryName(c);
    showError('');
    showLoading(true);
    resultEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    try {
      result = await Api.get(`${API.replace(API_BASE, '')}/countries/${encodeURIComponent(code)}`);
      expanded.clear();
      try { localStorage.setItem('exportPotentialCountry', code); } catch (_) { /* ignore */ }
      renderResult();
    } catch (err) {
      result = null;
      showError(`${t('exportPotential.loadFailed')} ${err.message}`);
      emptyEl.classList.remove('hidden');
    } finally {
      showLoading(false);
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────
  ratingFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.ep-filter__btn');
    if (!btn) return;
    setRatingMode(btn.dataset.rating);
  });

  function setRatingMode(mode) {
    ratingMode = mode;
    ratingFilter.querySelectorAll('.ep-filter__btn').forEach((b) => b.classList.toggle('active', b.dataset.rating === mode));
    tilesEl.querySelectorAll('.ep-tile').forEach((b) => b.classList.toggle('active', b.dataset.rating === mode));
    renderTable();
  }

  productSearch.addEventListener('input', () => {
    productQuery = productSearch.value.trim().toLowerCase();
    renderTable();
  });

  // ── Result rendering ─────────────────────────────────────────────────
  function renderResult() {
    if (!result) return;
    bannerEl.classList.toggle('hidden', !result.sample);
    renderMeta();
    renderTiles();
    renderTable();
    renderWatch();
    renderFooter();
    resultEl.classList.remove('hidden');
  }

  // Flags carried by every product (e.g. "tariff data missing" in version 1)
  // are said once above the table instead of on every row.
  function commonFlagCodes() {
    const products = (result && result.products) || [];
    if (products.length < 2) return new Set();
    let common = null;
    for (const p of products) {
      const codes = new Set((p.flags || []).map((f) => f.code));
      common = common ? new Set([...common].filter((c) => codes.has(c))) : codes;
      if (!common.size) break;
    }
    return common || new Set();
  }

  function renderMeta() {
    const w = result.window || {};
    const items = [
      [t('exportPotential.meta.dataYear'), String(result.dataYear)],
      [t('exportPotential.meta.window'), w.start && w.end ? `${w.start}–${w.end}` : '—'],
      [t('exportPotential.meta.tradeSource'), result.tradeSource ? `${result.tradeSource.label}${result.tradeSource.edition ? ` (${result.tradeSource.edition})` : ''}` : '—'],
      [t('exportPotential.meta.georgiaSource'), result.georgiaSource ? result.georgiaSource.label : '—'],
      [t('exportPotential.meta.runDate'), result.pipeline && result.pipeline.runDate ? fmtDate(result.pipeline.runDate) : '—'],
    ];
    let html = items.map(([k, v]) => `<span class="ep-meta__item">${escapeHtml(k)}: <b>${escapeHtml(v)}</b></span>`).join('');
    const common = commonFlagCodes();
    if (common.size) {
      const labels = [...common].map((code) => flagLabel({ code }));
      html += `<span class="ep-meta__item ep-meta__flags">${escapeHtml(t('exportPotential.commonFlags'))} <span class="ep-flag ep-flag--missing">${labels.map(escapeHtml).join('</span> <span class="ep-flag ep-flag--missing">')}</span></span>`;
    }
    metaEl.innerHTML = html;
  }

  function renderTiles() {
    const s = result.summary || { High: 0, Moderate: 0, Low: 0, watch: 0 };
    const tiles = [
      ['High', 'high', s.High, t('exportPotential.tiles.high')],
      ['Moderate', 'moderate', s.Moderate, t('exportPotential.tiles.moderate')],
      ['Low', 'low', s.Low, t('exportPotential.tiles.low')],
      ['watch', 'watch', s.watch, t('exportPotential.tiles.watch')],
    ];
    tilesEl.innerHTML = tiles.map(([mode, cls, value, label]) =>
      `<button type="button" class="ep-tile ep-tile--${cls}${ratingMode === mode ? ' active' : ''}" data-rating="${mode}"><div class="ep-tile__value">${value}</div><div class="ep-tile__label">${escapeHtml(label)}</div></button>`
    ).join('');
    tilesEl.querySelectorAll('.ep-tile').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.rating === 'watch') {
        document.getElementById('epWatchCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      setRatingMode(ratingMode === b.dataset.rating ? 'all' : b.dataset.rating);
    }));
  }

  function filteredProducts() {
    const all = result.products || [];
    return all.filter((p) => {
      if (ratingMode !== 'all' && p.rating !== ratingMode) return false;
      if (!productQuery) return true;
      const digits = /^\d+$/.test(productQuery);
      if (digits) return p.hs4.startsWith(productQuery.padStart(productQuery.length, '0')) || p.hs4.replace(/^0+/, '').startsWith(productQuery);
      const en = (p.name && p.name.en || '').toLowerCase();
      const ka = (p.name && p.name.ka || '').toLowerCase();
      return en.includes(productQuery) || ka.includes(productQuery);
    });
  }

  function blockMax(key) {
    if (!config) return null;
    const map = {
      demandSize: config.demandSize.maxPoints,
      demandGrowth: config.demandGrowth.maxPoints,
      competitionAccess: config.competitionAccess.maxPoints,
      georgiaPosition: config.georgiaPosition.maxPoints,
    };
    return map[key];
  }

  function flagLabel(f) {
    const key = `exportPotential.flags.${f.code}`;
    const label = t(key, { years: f.years, from: f.from ? ratingLabel(f.from) : '', to: f.to ? ratingLabel(f.to) : '' });
    return label === key ? f.code : label;
  }

  function flagClass(f) {
    if (f.code === 'new_market') return 'ep-flag--new';
    if (f.code.startsWith('cap_')) return 'ep-flag--cap';
    return 'ep-flag--missing';
  }

  function renderTable() {
    if (!result) return;
    const rows = filteredProducts();
    const total = (result.products || []).length;
    productsCount.textContent = t('exportPotential.table.shown', { shown: rows.length, total });
    noRowsEl.classList.toggle('hidden', rows.length > 0);
    const common = commonFlagCodes();
    tableBody.innerHTML = rows.map((p) => {
      const open = expanded.has(p.hs4);
      const flags = (p.flags || []).filter((f) => !common.has(f.code)).map((f) => `<span class="ep-flag ${flagClass(f)}">${escapeHtml(flagLabel(f))}</span>`).join('');
      const block = (key) => {
        const max = blockMax(key);
        return `<td class="ep-block-cell">${p.blocks[key]}${max != null ? `<small> / ${max}</small>` : ''}</td>`;
      };
      return `
        <tr class="ep-row${open ? ' is-open' : ''}" data-hs4="${p.hs4}" aria-expanded="${open ? 'true' : 'false'}">
          <td class="ep-code">${escapeHtml(p.hs4)}</td>
          <td><div class="ep-name">${escapeHtml(productName(p))}</div>${flags ? `<div class="ep-flags">${flags}</div>` : ''}</td>
          <td><span class="pill ${RATING_PILL[p.rating] || 'pill-gray'}">${escapeHtml(ratingLabel(p.rating))}</span></td>
          <td class="ep-score"><span class="ep-score__value">${p.score}</span><div class="ep-bar ep-bar--${p.rating}"><i style="width:${Math.max(0, Math.min(100, p.score))}%"></i></div></td>
          ${block('demandSize')}${block('demandGrowth')}${block('competitionAccess')}${block('georgiaPosition')}
          <td class="ep-chevron">▾</td>
        </tr>
        ${open ? `<tr class="ep-details"><td colspan="9">${renderDetails(p)}</td></tr>` : ''}`;
    }).join('');
  }

  tableBody.addEventListener('click', (e) => {
    const row = e.target.closest('.ep-row');
    if (!row) return;
    const code = row.dataset.hs4;
    if (expanded.has(code)) expanded.delete(code); else expanded.add(code);
    renderTable();
  });

  // ── Expanded row: the four blocks in plain language ──────────────────
  function indLine(text, sub, points, max) {
    const cls = points >= max && max > 0 ? ' is-full' : points === 0 ? ' is-zero' : '';
    return `<div class="ep-ind"><div class="ep-ind__text">${text}${sub ? `<small>${sub}</small>` : ''}</div><div class="ep-ind__pts${cls}">${escapeHtml(t('exportPotential.points', { points, max }))}</div></div>`;
  }

  function renderDetails(p) {
    const ind = p.indicators || {};
    const c = config || {};
    const ca = c.competitionAccess || {};
    const gp = c.georgiaPosition || {};
    const T = p.window ? p.window.end : result.dataYear;
    const win = p.window ? `${p.window.start}–${p.window.end}` : '';
    const e = escapeHtml;

    // Demand size
    const ds = ind.demandSize || {};
    const demandSize = indLine(
      e(t('exportPotential.ind.demandSize', { value: fmtUsd(ds.value), window: win })),
      '', ds.points || 0, c.demandSize ? c.demandSize.maxPoints : 30);

    // Demand growth
    const dg = ind.demandGrowth || {};
    const growthMain = e(t('exportPotential.ind.growth', { partner: fmtPct(dg.partnerGrowth, { sign: true }), world: fmtPct(dg.worldGrowth, { sign: true }) }));
    const groupTxt = e(t(dg.group === 'A' ? 'exportPotential.ind.growthGroupA' : 'exportPotential.ind.growthGroupB'));
    let netTxt = e(t('exportPotential.ind.netChange', { net: fmtPct(dg.netChange2y, { sign: true }) }));
    if (dg.group === 'B' && dg.netChange2y > 0) {
      netTxt += ' ' + e(t(dg.rule === 'b_positive_above_average' ? 'exportPotential.ind.netChangeAboveAvg' : 'exportPotential.ind.netChangeBelowAvg', { year: T }));
    }
    const demandGrowth = indLine(growthMain, `${groupTxt} ${netTxt}`, dg.points || 0, c.demandGrowth ? c.demandGrowth.maxPoints : 25);

    // Competition and access
    const dl = ind.deficitLevel || {};
    const deficitLevel = indLine(
      e(t('exportPotential.ind.deficitLevel', { m: fmtUsd(dl.avgImports), x: fmtUsd(dl.avgExports) })),
      e(t(`exportPotential.ind.deficitLevel_${dl.level || 'balanced'}`)),
      dl.points || 0, ca.deficitLevel ? ca.deficitLevel.importsAtLeastRatioOfExports : 4);
    const tc = ind.deficitTrendCurrent || {};
    const trendCur = indLine(
      e(t(tc.held ? 'exportPotential.ind.trendHeld' : 'exportPotential.ind.trendFell', { year: T, share: fmtPct(tc.shareT), prevYear: T - 1, prevShare: fmtPct(tc.shareT1) })),
      '', tc.points || 0, ca.deficitTrend ? ca.deficitTrend.currentYear : 1);
    const tp = ind.deficitTrendPrevious || {};
    const trendPrev = indLine(
      e(t(tp.held ? 'exportPotential.ind.trendHeld' : 'exportPotential.ind.trendFell', { year: T - 1, share: fmtPct(tp.shareT1), prevYear: T - 2, prevShare: fmtPct(tp.shareT2) })),
      '', tp.points || 0, ca.deficitTrend ? ca.deficitTrend.previousYear : 1);
    const sc = ind.supplierConcentration || {};
    const hhi = indLine(
      e(t('exportPotential.ind.hhi', { value: fmtNum(sc.value), level: t(`exportPotential.ind.hhi_${sc.level || 'missing'}`) })),
      '', sc.points || 0, ca.supplierConcentration ? ca.supplierConcentration.low : 6);
    const tf = ind.tariff || {};
    const tariff = indLine(
      tf.missing
        ? e(t('exportPotential.ind.tariffMissing'))
        : e(t('exportPotential.ind.tariff', { georgia: fmtTariff(tf.georgiaRate), competitors: fmtTariff(tf.competitorsRate), position: t(`exportPotential.ind.tariff_${tf.position}`) })),
      '', tf.points || 0, ca.tariff ? ca.tariff.lower : 6);
    const di = ind.distance || {};
    const distance = indLine(
      di.missing
        ? e(t('exportPotential.ind.distanceMissing'))
        : e(t('exportPotential.ind.distance', { georgia: fmtKm(di.georgiaKm), avg: fmtKm(di.avgSupplierKm) })),
      di.missing ? '' : e(t(di.fit ? 'exportPotential.ind.distanceFit' : 'exportPotential.ind.distanceNoFit')),
      di.points || 0, ca.distance ? ca.distance.fit : 2);

    // Georgia's position
    const rc = ind.rca || {};
    const rca = indLine(
      rc.value == null ? e(t('exportPotential.ind.rcaMissing')) : e(t('exportPotential.ind.rca', { value: fmtNum(rc.value) })),
      '', rc.points || 0, gp.rca ? gp.rca.full : 10);
    const tr = ind.trackRecord || {};
    const track = indLine(
      e(t('exportPotential.ind.trackRecord', { n: tr.yearsWithExports ?? '—', k: tr.lookbackYears ?? (gp.trackRecord ? gp.trackRecord.lookbackYears : 5) })),
      '', tr.points || 0, gp.trackRecord ? gp.trackRecord.points : 8);
    const hr = ind.headroom || {};
    const headroom = indLine(
      hr.hasHeadroom == null
        ? e(t('exportPotential.ind.headroomMissing'))
        : e(t('exportPotential.ind.headroom', { sp: fmtPct(hr.sharePartnerImports, { digits: 2 }), sw: fmtPct(hr.shareWorldExports, { digits: 2 }) })),
      hr.hasHeadroom == null ? '' : e(t(hr.hasHeadroom ? 'exportPotential.ind.headroomYes' : 'exportPotential.ind.headroomNo')),
      hr.points || 0, gp.headroom ? gp.headroom.points : 7);

    const block = (key, body) => `
      <div class="ep-detail-block">
        <div class="ep-detail-block__head"><span>${e(t(`exportPotential.blocks.${key}`))}</span><span class="ep-detail-block__pts">${e(t('exportPotential.points', { points: p.blocks[key], max: blockMax(key) ?? '' }))}</span></div>
        ${body}
      </div>`;

    const capNote = p.cap
      ? `<div class="ep-detail-note">${e(t('exportPotential.capNote', { from: ratingLabel(p.ratingBeforeCap), to: ratingLabel(p.rating), cap: t(`exportPotential.caps.${p.cap}`) }))}</div>`
      : '';
    const newNote = p.gate2 && p.gate2.status === 'new'
      ? `<div class="ep-detail-note" style="color:var(--accent-blue)">${e(t('exportPotential.newMarketNote', { years: p.gate2.consecutiveYears, window: win }))}</div>`
      : '';

    return `<div class="ep-detail-grid">
      ${block('demandSize', demandSize)}
      ${block('demandGrowth', demandGrowth)}
      ${block('competitionAccess', deficitLevel + trendCur + trendPrev + hhi + tariff + distance)}
      ${block('georgiaPosition', rca + track + headroom)}
    </div>${newNote}${capNote}`;
  }

  // ── Markets to watch ─────────────────────────────────────────────────
  function renderWatch() {
    const list = result.watch || [];
    watchCount.textContent = String(list.length);
    noWatchEl.classList.toggle('hidden', list.length > 0);
    watchBody.innerHTML = list.map((w) => {
      const years = (w.yearsWithImports || []).join(', ');
      const imports = (w.yearsWithImports || []).map((y) => `${y}: ${fmtUsd(w.imports && w.imports[y])}`).join(' · ');
      return `<tr><td class="ep-code">${escapeHtml(w.hs4)}</td><td class="ep-name">${escapeHtml(productName(w))}</td><td>${escapeHtml(years)}</td><td>${escapeHtml(imports)}</td></tr>`;
    }).join('');
  }

  // ── Footer attribution ───────────────────────────────────────────────
  function renderFooter() {
    const year = result ? result.dataYear : '';
    const products = (result && result.products) || [];
    const usesTariff = products.some((p) => p.indicators && p.indicators.tariff && !p.indicators.tariff.missing);
    const usesDistance = products.some((p) => p.indicators && p.indicators.distance && !p.indicators.distance.missing);
    const src = result && result.tradeSource ? result.tradeSource.id : 'comtrade';
    const links = [];
    if (src === 'baci') links.push(['CEPII BACI', 'https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37']);
    else links.push(['UN Comtrade', 'https://comtradeplus.un.org']);
    links.push(['Geostat', 'https://ex-trade.geostat.ge/en']);
    if (usesTariff) links.push(['WITS / UNCTAD TRAINS', 'https://wits.worldbank.org']);
    if (usesDistance) links.push(['CEPII GeoDist', 'https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=6']);
    const anchors = links.map(([name, href]) => `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`).join(' · ');
    footerEl.innerHTML = `${escapeHtml(t('exportPotential.footer.sources'))}: ${anchors} — ${escapeHtml(t('exportPotential.footer.dataYear', { year }))}. ${escapeHtml(t('exportPotential.footer.note'))}`;
  }

  // ── Methodology panel, rendered from the configuration ───────────────
  methodBtn.addEventListener('click', () => {
    const open = methodEl.classList.toggle('hidden') === false;
    methodBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    methodBtn.textContent = t(open ? 'exportPotential.hideMethodology' : 'exportPotential.methodology');
    if (open) {
      renderMethod();
      methodEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  function renderMethod() {
    if (!config) { methodBody.innerHTML = `<p>${escapeHtml(t('common.loading'))}</p>`; return; }
    const c = config;
    const e = escapeHtml;
    const m = (k, p) => e(t(`exportPotential.method.${k}`, p));
    const pts = (n) => e(t('exportPotential.pts', { points: n }));
    const row = (text, points) => `<tr><td>${text}</td><td class="ep-pts">${pts(points)}</td></tr>`;
    const table = (rows) => `<table><tbody>${rows.join('')}</tbody></table>`;

    const tiers = [...c.demandSize.tiers];
    const tierRows = tiers.map((tier, i) => {
      let label;
      if (i === 0) label = m('tierOver', { v: fmtUsd(tier.minUsd) });
      else if (i === tiers.length - 1) label = m('tierUnder', { v: fmtUsd(tiers[i - 1].minUsd) });
      else label = m('tierBetween', { a: fmtUsd(tier.minUsd), b: fmtUsd(tiers[i - 1].minUsd) });
      return row(label, tier.points);
    });

    const ga = c.demandGrowth.groupA; const gb = c.demandGrowth.groupB;
    const growthRows = [
      row(m('growthA_nonneg'), ga.netChangeNonNegative),
      row(m('growthA_small', { v: fmtPct(Math.abs(ga.declineThreshold), { digits: 0 }) }), ga.declineLessThanThreshold),
      row(m('growthA_steep', { v: fmtPct(Math.abs(ga.declineThreshold), { digits: 0 }) }), ga.declineAtOrBeyondThreshold),
      row(m('growthB_above'), gb.positiveAboveAverage),
      row(m('growthB_below'), gb.positiveAtOrBelowAverage),
      row(m('growthB_nonpos'), gb.nonPositive),
    ];

    const ca = c.competitionAccess;
    const compRows = [
      row(m('deficit_deficit', { r: ca.deficitLevel.ratio }), ca.deficitLevel.importsAtLeastRatioOfExports),
      row(m('deficit_neither'), ca.deficitLevel.neither),
      row(m('deficit_surplus', { r: ca.deficitLevel.ratio }), ca.deficitLevel.exportsAtLeastRatioOfImports),
      row(m('trendCurrent'), ca.deficitTrend.currentYear),
      row(m('trendPrevious'), ca.deficitTrend.previousYear),
      row(m('hhi_low', { v: fmtNum(ca.supplierConcentration.lowMax, 1) }), ca.supplierConcentration.low),
      row(m('hhi_mid', { a: fmtNum(ca.supplierConcentration.lowMax, 1), b: fmtNum(ca.supplierConcentration.midMax, 1) }), ca.supplierConcentration.mid),
      row(m('hhi_high', { v: fmtNum(ca.supplierConcentration.midMax, 1) }), ca.supplierConcentration.high),
      row(m('tariff_lower'), ca.tariff.lower),
      row(m('tariff_equal', { v: fmtNum(ca.tariff.equalBandPercentagePoints, 1) }), ca.tariff.equal),
      row(m('tariff_higher'), ca.tariff.higher),
      row(m('distance_fit'), ca.distance.fit),
    ];

    const gp = c.georgiaPosition;
    const posRows = [
      row(m('rca_full', { v: fmtNum(gp.rca.fullMin, 1) }), gp.rca.full),
      row(m('rca_partial', { a: fmtNum(gp.rca.partialMin, 1), b: fmtNum(gp.rca.fullMin, 1) }), gp.rca.partial),
      row(m('rca_none', { v: fmtNum(gp.rca.partialMin, 1) }), gp.rca.none),
      row(m('track', { n: gp.trackRecord.minYearsWithExports, k: gp.trackRecord.lookbackYears }), gp.trackRecord.points),
      row(m('headroom'), gp.headroom.points),
    ];

    const limits = ['limitCif', 'limitTariff', 'limitSources', 'limitRaw', 'limitScreening'].map((k) => `<li>${m(k)}</li>`).join('');

    methodBody.innerHTML = `
      <p class="ep-method__lead">${m('screening')}</p>
      <h4>${m('gate1Title')}</h4>
      <p>${m('gate1', { min: fmtUsd(c.gate1.minAverageUsd), years: c.gate1.years })}</p>
      <h4>${m('gate2Title')}</h4>
      <ul>
        <li>${m('gate2Established', { n: c.gate2.establishedMinYears, w: c.windowYears })}</li>
        <li>${m('gate2New', { a: c.gate2.newMarketMinYears, b: c.gate2.establishedMinYears - 1 })}</li>
        <li>${m('gate2Watch', { a: c.gate2.watchMinYears, b: c.gate2.newMarketMinYears - 1 })}</li>
        <li>${m('gate2None')}</li>
      </ul>
      <h4>${m('scoringTitle')}</h4>
      <p>${m('scoringIntro')}</p>
      <h4>${m('demandSizeTitle', { max: c.demandSize.maxPoints })}</h4>
      ${table(tierRows)}
      <h4>${m('growthTitle', { max: c.demandGrowth.maxPoints })}</h4>
      <p>${m('growthText')}</p>
      ${table(growthRows)}
      <h4>${m('competitionTitle', { max: ca.maxPoints })}</h4>
      <p>${m('competitionText')}</p>
      ${table(compRows)}
      <h4>${m('positionTitle', { max: gp.maxPoints })}</h4>
      <p>${m('positionText', { years: gp.rca.years })}</p>
      ${table(posRows)}
      <h4>${m('ratingTitle')}</h4>
      <ul>
        <li>${m('ratingHigh', { n: c.rating.highMin })}</li>
        <li>${m('ratingModerate', { a: c.rating.moderateMin, b: c.rating.highMin - 1 })}</li>
        <li>${m('ratingLow', { n: c.rating.moderateMin })}</li>
      </ul>
      <h4>${m('capsTitle')}</h4>
      <ul>
        <li>${m('capSmall', { v: fmtUsd(c.caps.smallMarket.averageImportsUnderUsd), r: ratingLabel(c.caps.smallMarket.maxRating) })}</li>
        <li>${m('capSteep', { v: fmtPct(c.caps.steepDecline.netChangeAtOrBelow, { digits: 0 }) })}</li>
      </ul>
      <h4>${m('limitsTitle')}</h4>
      <ul>${limits}</ul>`;
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  showLoading(true);
  try {
    const [list, cfg] = await Promise.all([
      Api.get('/api/export-potential/countries'),
      Api.get('/api/export-potential/config'),
    ]);
    countries = Array.isArray(list) ? list : [];
    config = cfg;
  } catch (err) {
    showError(`${t('exportPotential.loadFailed')} ${err.message}`);
  } finally {
    showLoading(false);
  }
  renderFooter();

  let remembered = null;
  try { remembered = localStorage.getItem('exportPotentialCountry'); } catch (_) { /* ignore */ }
  const initial = countries.find((c) => c.code === remembered) || countries.find((c) => !c.sample) || countries[0];
  if (initial) selectCountry(initial.code);
})();
