/**
 * Country Profiles index (admin preview).
 *
 * A searchable, region-filterable grid of every economy the sync stored.
 * Search text and region live in the URL query string (?q=&region=) so a
 * filtered view can be shared; the list itself comes from
 * /api/country-profiles/countries, never from an external API.
 */
(async function () {
  await App.init();
  const user = Api.getUser();
  if (!user || user.role !== 'ADMIN') return;

  const t = (key, params) => I18n.tr(key, params);
  const isKa = () => I18n.getLocale() === 'ka';
  const { filterCountries } = window.CountryProfilesFilter;

  const $ = (id) => document.getElementById(id);
  const searchEl = $('cpSearch');
  const regionEl = $('cpRegion');
  const countEl = $('cpCount');
  const gridEl = $('cpGrid');
  const emptyEl = $('cpEmpty');
  const emptyText = $('cpEmptyText');
  const clearBtn = $('cpClear');
  const loadingEl = $('cpLoading');
  const errorEl = $('cpError');
  const footerEl = $('cpFooter');

  let data = { countries: [], regions: [], source: null, lastSync: null };

  const displayName = (c) => (isKa() && c.nameKa ? c.nameKa : c.name);

  // ── URL state ────────────────────────────────────────────────────────
  function readState() {
    const p = new URLSearchParams(window.location.search);
    return { q: p.get('q') || '', region: p.get('region') || '' };
  }

  function writeState({ q, region }) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (region) p.set('region', region);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`) history.replaceState(null, '', url);
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function card(c) {
    const flag = c.iso2 ? flagUrl(c.iso2) : '';
    const href = `/pages/country-profile.html?country=${encodeURIComponent(c.slug)}`;
    const alt = t('countryProfiles.flagAlt', { name: c.name });
    const img = flag
      ? `<img class="cp-card__flag" src="${flag}" alt="${escapeHtml(alt)}" width="40" height="40" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cp-card__flag cp-card__flag--none',ariaHidden:'true'}))" />`
      : '<span class="cp-card__flag cp-card__flag--none" aria-hidden="true"></span>';
    return `<li class="cp-card-item">
      <a class="cp-card" href="${href}">
        ${img}
        <span class="cp-card__text">
          <span class="cp-card__name">${escapeHtml(displayName(c))}</span>
          <span class="cp-card__region">${escapeHtml(c.region.name || '')}</span>
        </span>
      </a>
    </li>`;
  }

  function render() {
    const state = { q: searchEl.value.trim(), region: regionEl.value };
    writeState(state);
    const list = filterCountries(data.countries, state);
    const sorted = [...list].sort((a, b) => displayName(a).localeCompare(displayName(b), isKa() ? 'ka' : 'en'));
    countEl.textContent = t('countryProfiles.showing', { n: sorted.length.toLocaleString(isKa() ? 'ka-GE' : 'en-US') });
    gridEl.innerHTML = sorted.map(card).join('');
    const nothingStored = data.countries.length === 0;
    emptyText.textContent = nothingStored ? t('countryProfiles.noDataYet') : t('countryProfiles.noMatch');
    clearBtn.classList.toggle('hidden', nothingStored);
    emptyEl.classList.toggle('hidden', sorted.length > 0);
    gridEl.classList.toggle('hidden', sorted.length === 0);
  }

  function renderRegions() {
    const current = regionEl.value;
    const opts = [`<option value="">${escapeHtml(t('countryProfiles.allRegions'))}</option>`];
    for (const r of data.regions) opts.push(`<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`);
    regionEl.innerHTML = opts.join('');
    regionEl.value = data.regions.some((r) => r.id === current) ? current : '';
  }

  function renderFooter() {
    if (!data.source) { footerEl.textContent = ''; return; }
    const sync = data.lastSync && data.lastSync.finishedAt ? formatDateTime(data.lastSync.finishedAt) : '—';
    footerEl.textContent = `${t('countryProfiles.source')}: ${data.source.name} · ${t('countryProfiles.lastSync')}: ${sync}`;
  }

  // ── Events ───────────────────────────────────────────────────────────
  searchEl.addEventListener('input', render);
  regionEl.addEventListener('change', render);
  clearBtn.addEventListener('click', () => {
    searchEl.value = '';
    regionEl.value = '';
    render();
    searchEl.focus();
  });
  window.addEventListener('popstate', () => {
    const s = readState();
    searchEl.value = s.q;
    regionEl.value = s.region;
    render();
  });

  // ── Load ─────────────────────────────────────────────────────────────
  try {
    data = await Api.get('/api/country-profiles/countries');
    const s = readState();
    searchEl.value = s.q;
    renderRegions();
    regionEl.value = data.regions.some((r) => r.id === s.region) ? s.region : '';
    renderFooter();
    render();
  } catch (err) {
    errorEl.textContent = `${t('countryProfiles.loadFailed')} ${err.message}`;
    errorEl.classList.remove('hidden');
  } finally {
    loadingEl.classList.add('hidden');
  }
})();
