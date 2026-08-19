/**
 * Shared utility functions.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Country records carry the English name + ISO code, and (since the name_ka
// column) a server-stored Georgian name. When the site is in Georgian, prefer
// the server name, then Intl.DisplayNames on the code (for stale caches or
// unnamed rows), then English.
let _regionDisplayNamesKa;
function localizedCountryName(country) {
  if (!country) return '';
  const en = country.name_en || country.nameEn || country.name || '';
  const code = (country.code || '').toUpperCase();
  try {
    const locale = (typeof I18n !== 'undefined' && I18n.getLocale) ? I18n.getLocale() : 'en';
    if (locale === 'ka') {
      const ka = country.name_ka || country.nameKa || country.countryNameKa || '';
      if (ka && String(ka).trim()) return String(ka).trim();
      if (code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
        if (!_regionDisplayNamesKa) _regionDisplayNamesKa = new Intl.DisplayNames(['ka'], { type: 'region' });
        const icuKa = _regionDisplayNamesKa.of(code);
        if (icuKa && icuKa !== code) return icuKa;
      }
    }
  } catch (_) { /* fall back to English */ }
  return en;
}

// Sort a copy of a country list alphabetically by the label the user actually
// sees (Georgian collation in the ka locale, English otherwise). The
// "No country" pseudo-entry (code XX) is pinned to the top instead of being
// buried at its alphabetical position.
function sortedByLocalizedCountryName(list) {
  const locale = (typeof I18n !== 'undefined' && I18n.getLocale && I18n.getLocale() === 'ka') ? 'ka' : 'en';
  return [...(list || [])].sort((a, b) => {
    const aNone = (a.code || '').toUpperCase() === 'XX';
    const bNone = (b.code || '').toUpperCase() === 'XX';
    if (aNone !== bNone) return aNone ? -1 : 1;
    return localizedCountryName(a).localeCompare(localizedCountryName(b), locale);
  });
}

// Users have a Latin name (full_name / fullName) and an optional Georgian-
// script name (full_name_ka / fullNameKa). Show the Georgian spelling when the
// UI is in Georgian and one exists; otherwise fall back to the Latin name so
// legacy/external users without a Georgian name still render.
//
// Accepts either a user-like object ({ fullName, fullNameKa } or snake_case
// { full_name, full_name_ka }) or the two name strings directly:
//   localizedName(user)            localizedName(user.fullName, user.fullNameKa)
function localizedName(latinOrUser, ka) {
  let latin = latinOrUser;
  if (latinOrUser && typeof latinOrUser === 'object') {
    latin = latinOrUser.fullName ?? latinOrUser.full_name ?? '';
    ka = latinOrUser.fullNameKa ?? latinOrUser.full_name_ka ?? '';
  }
  try {
    const locale = (typeof I18n !== 'undefined' && I18n.getLocale) ? I18n.getLocale() : 'en';
    if (locale === 'ka' && ka && String(ka).trim()) return ka;
  } catch (_) { /* fall back to Latin */ }
  return latin || ka || '';
}

// Pick the locale tag for Intl.DateTimeFormat based on the user's
// current i18n locale. Falls back to en-GB when I18n hasn't loaded
// (e.g. the login page renders dates before init has finished).
function _dateLocale() {
  try {
    const l = (typeof I18n !== 'undefined' && I18n.getLocale) ? I18n.getLocale() : null;
    return l === 'ka' ? 'ka-GE' : 'en-GB';
  } catch (_) {
    return 'en-GB';
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  // Numeric dates use day-first DD/MM/YYYY in both languages. The 'ka-GE'
  // numeric ordering is unreliable across browsers (renders MM/DD/YYYY), and a
  // bare numeric date looks identical in any language, so format it as en-GB.
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Format a stored instant as Tbilisi (UTC+4, no DST) wall-clock — used for the
// event date/time, which the creator enters in Tbilisi time.
function formatTbilisiDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Tbilisi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Look up an i18n key, returning a fallback when the key is missing
// or I18n isn't initialised yet (e.g. early in the login flow before
// I18n.init() has resolved).
function _i18n(key, fallback) {
  try {
    if (typeof I18n !== 'undefined' && I18n.t) {
      const v = I18n.t(key);
      if (v && v !== key) return v;
    }
  } catch (_) {}
  return fallback;
}

function statusLabel(status) {
  if (!status) return _i18n('status.draft', 'Awaiting action');
  const fallback = {
    draft: 'Awaiting action',
    submitted_to_super_collaborator: 'At Senior Editor',
    returned_by_super_collaborator: 'Returned by Senior Editor',
    approved_by_super_collaborator: 'Approved (Senior Editor)',
    submitted_to_curator: 'At Curator',
    returned_by_curator: 'Returned by Curator',
    approved_by_curator: 'Approved (Curator)',
    submitted_to_supervisor: 'At Supervisor',
    returned_by_supervisor: 'Returned by Supervisor',
    approved_by_supervisor: 'Approved (Supervisor)',
    submitted_to_deputy: 'At Deputy',
    returned_by_deputy: 'Returned by Deputy',
    approved_by_deputy: 'Approved (Deputy)',
    submitted_to_receiving_super_collaborator: 'At Senior Editor (Review)',
    returned_by_receiving_super_collaborator: 'Returned by Senior Editor (Review)',
    approved_by_receiving_super_collaborator: 'Approved (Senior Editor Review)',
    submitted_to_receiving_supervisor: 'At Supervisor (Review)',
    returned_by_receiving_supervisor: 'Returned by Supervisor (Review)',
    approved_by_receiving_supervisor: 'Approved (Supervisor Review)',
    submitted_to_amending_ds: 'Amendment in progress (DS)',
    approved_by_ds_amendment: 'Amended (DS)',
  }[status];
  return _i18n(`status.${status}`, fallback || status);
}

function statusClass(status) {
  if (!status || status === 'draft') return 'status-draft';
  if (status.startsWith('submitted_')) return 'status-submitted';
  if (status.startsWith('returned_')) return 'status-returned';
  if (status.startsWith('approved_')) return 'status-approved';
  return '';
}

function languageLabel(code) {
  const fallback = {
    EN: 'English', RU: 'Русский', KA: 'ქართული',
  }[code];
  return _i18n(`lang.${code || ''}`, fallback || code);
}

/**
 * Toast notification — replaces browser alert().
 * Usage:  toast('Something happened')           — info (default)
 *         toast.success('Saved!')               — green
 *         toast.error('Upload failed: …')       — red
 *         toast.warn('Select at least one …')   — amber
 */
const toast = (() => {
  let container;
  function getContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'toast-container';
    Object.assign(container.style, {
      position: 'fixed', top: '24px', right: '24px', zIndex: '99999',
      display: 'flex', flexDirection: 'column', gap: '10px',
      pointerEvents: 'none',
    });
    document.body.appendChild(container);
    return container;
  }

  const ICONS = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    error:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warn:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  const COLORS = {
    success: { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', icon: '#16a34a' },
    error:   { bg: '#fef2f2', border: '#fecaca', text: '#b91c1c', icon: '#dc2626' },
    warn:    { bg: '#fffbeb', border: '#fde68a', text: '#92400e', icon: '#d97706' },
    info:    { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: '#3b82f6' },
  };

  function show(message, type) {
    type = type || 'info';
    const c = COLORS[type] || COLORS.info;
    const el = document.createElement('div');
    Object.assign(el.style, {
      display: 'flex', alignItems: 'flex-start', gap: '10px',
      padding: '14px 18px', minWidth: '280px', maxWidth: '440px',
      background: c.bg, border: '1px solid ' + c.border,
      borderRadius: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.06)',
      fontFamily: 'var(--font-primary, sans-serif)', fontSize: '13.5px', lineHeight: '1.45',
      color: c.text, pointerEvents: 'auto',
      transform: 'translateX(120%)', opacity: '0',
      transition: 'transform .3s cubic-bezier(.22,1,.36,1), opacity .3s ease',
    });

    const iconSpan = document.createElement('span');
    Object.assign(iconSpan.style, { flexShrink: '0', color: c.icon, marginTop: '1px' });
    iconSpan.innerHTML = ICONS[type] || ICONS.info;

    const textSpan = document.createElement('span');
    textSpan.style.flex = '1';
    textSpan.textContent = message;

    const closeBtn = document.createElement('button');
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', cursor: 'pointer', padding: '0',
      color: c.text, opacity: '.5', fontSize: '18px', lineHeight: '1', flexShrink: '0',
    });
    closeBtn.innerHTML = '&times;';
    closeBtn.onmouseenter = () => closeBtn.style.opacity = '1';
    closeBtn.onmouseleave = () => closeBtn.style.opacity = '.5';
    closeBtn.onclick = () => dismiss(el);

    el.appendChild(iconSpan);
    el.appendChild(textSpan);
    el.appendChild(closeBtn);
    getContainer().appendChild(el);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transform = 'translateX(0)';
      el.style.opacity = '1';
    }));

    const timer = setTimeout(() => dismiss(el), type === 'error' ? 6000 : 4000);
    el._timer = timer;
  }

  function dismiss(el) {
    if (el._dismissed) return;
    el._dismissed = true;
    clearTimeout(el._timer);
    el.style.transform = 'translateX(120%)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }

  function toastFn(msg) { show(msg, 'info'); }
  toastFn.success = (msg) => show(msg, 'success');
  toastFn.error   = (msg) => show(msg, 'error');
  toastFn.warn    = (msg) => show(msg, 'warn');
  toastFn.info    = (msg) => show(msg, 'info');
  return toastFn;
})();

function roleLabel(role) {
  const fallback = {
    ADMIN: 'Admin',
    PROTOCOL: 'Protocol',
    DEPUTY: 'Deputy',
    SUPERVISOR: 'Supervisor',
    SUPER_COLLABORATOR: 'Senior Editor',
    COLLABORATOR: 'Editor',
    ANALYST: 'Analyst',
    MINISTER: 'Minister',
    CURATOR: 'Curator',
    // Receiving chain roles display the same label — the department name
    // shown underneath distinguishes them from the section dept's roles
    RECEIVING_SUPER_COLLABORATOR: 'Senior Editor',
    RECEIVING_SUPERVISOR: 'Supervisor',
  }[role];
  return _i18n(`roles.${role || ''}`, fallback || role);
}

/** Get the dashboard URL for a given role */
function dashboardUrl(role) {
  const map = {
    COLLABORATOR: '/pages/dashboard-collab.html',
    SUPER_COLLABORATOR: '/pages/dashboard-super-collab.html',
    SUPERVISOR: '/pages/dashboard-supervisor.html',
    DEPUTY: '/pages/dashboard-deputy.html',
    ADMIN: '/pages/admin.html',
    // PROTOCOL manages the Minister's page → same dashboard as the Minister.
    PROTOCOL: '/pages/dashboard-minister.html',
    ANALYST: '/pages/statistics.html',
    MINISTER: '/pages/dashboard-minister.html',
  };
  return map[role] || '/pages/dashboard-collab.html';
}

// ── Chart data-label placement ───────────────────────────────────────────
// The two-series line charts (country comparison, products) label every
// point of both lines with a value and, on a second text line, the change
// vs the prior period. Fixing the side per dataset — series 1 above its
// points, series 2 below — collides wherever the lines run close or cross:
// both labels then land in the same narrow gap between the two lines. The
// helpers below place each label on the side facing away from the other
// series, and thin a label down before the datalabels plugin has to hide
// it outright.

/**
 * Scriptable `align` for one series of a paired line chart. The higher of
 * the two points takes the space above, the lower one the space below, so
 * a pair always opens away from itself. Falls back to 'top' for a lone
 * series, a gap in either series, or a point sitting too close to the
 * chart floor for a label to fit underneath.
 *
 * @param {Array<number|null>} ownSeries      this dataset's values
 * @param {Array<number|null>|null} otherSeries  the paired dataset's values
 * @param {boolean} isFirstSeries  decides ties, so equal values still split
 * @param {number} minRoomPx  room a below-point label needs: two 11px text
 *                            lines + the plugin's default offset + padding
 */
function pairedLabelAlign(ownSeries, otherSeries, isFirstSeries, minRoomPx = 34) {
  return (ctx) => {
    if (!otherSeries) return 'top';
    const own = ownSeries[ctx.dataIndex];
    const other = otherSeries[ctx.dataIndex];
    if (own == null || other == null) return 'top';
    const below = own === other ? !isFirstSeries : own < other;
    if (!below) return 'top';
    // Scriptable options are evaluated before the first layout too, when
    // the scales and chart area are not measured yet — stay on top then.
    const scale = ctx.chart.scales && ctx.chart.scales.y;
    const area = ctx.chart.chartArea;
    if (!scale || !area) return 'top';
    return area.bottom - scale.getPixelForValue(own) >= minRoomPx ? 'bottom' : 'top';
  };
}

// Change colours for chart labels, mirroring --accent-green / --accent-red
// (the two chart pages already carry their palette as literals).
const CHANGE_UP_COLOR = '#16a34a';
const CHANGE_DOWN_COLOR = '#dc2626';

// Stacking distance between the two labels of a point. It has to clear one
// label box — the 11px label font at Chart.js's 1.2 line height (13.2px)
// plus the charts' `padding: 1` top and bottom — or the pair overlaps and
// the collision pass hides the change. Revisit if either changes.
const POINT_LABEL_LINE = 16;
const POINT_LABEL_OFFSET = 4;

/**
 * The `labels` block for one dataset of those charts — two stacked labels
 * per point, because a datalabel is drawn in a single colour and the value
 * and its change need different ones:
 *
 *   1,240.80 №2   the value, in the series colour, rank alongside
 *   +12%          the change, green when positive and red when negative
 *
 * The second line is thinned as the points crowd together, and the rank
 * falls back onto the freed line rather than widening the value line on a
 * narrow chart:
 *
 *   roomy (>= 64px per point)   "1,240.80 №2" / "+12%"
 *   tight (>= 44px)             "1,240.80"    / "№2"
 *   tightest                    "1,240.80"
 *
 * @param {(v:number)=>string} formatValue  per-chart value formatter
 * @param {Array<{change?: string|null, rank?: number|null}|null>|null} meta
 *        per-point context for this dataset. Entries are read at draw time,
 *        so a caller that fills a rank in later only needs chart.update().
 * @param {string} seriesColor  this dataset's colour, also used for a
 *        neutral (zero) change and for the rank on its own line
 * @param {(ctx:object)=>string} alignFor  the dataset's scriptable `align`
 *        (pairedLabelAlign), so the two labels stack on the side the pair
 *        was placed on
 * @param {number} minPxPerPoint  width per point needed for the change
 * @param {number} rankPxPerPoint  width per point needed for the rank alone
 */
function pointLabelParts(formatValue, meta, seriesColor, alignFor, minPxPerPoint = 64, rankPxPerPoint = 44) {
  const at = (ctx) => (meta && meta[ctx.dataIndex]) || null;
  const perPoint = (ctx) => {
    const area = ctx.chart.chartArea;
    if (!area) return Infinity;
    return area.width / Math.max(1, ctx.chart.data.labels.length - 1);
  };
  // The change owns the second line wherever there is room for it, and the
  // rank rides beside the value; when there is not, the rank takes the line
  // back. The decision is by chart width, not per point, so the rank sits in
  // the same place on every point of a chart even where a change is missing.
  const roomy = (ctx) => perPoint(ctx) >= minPxPerPoint;
  const rankText = (ctx) => {
    const m = at(ctx);
    return m && m.rank != null ? `№${m.rank}` : null;
  };
  // Stacked by offset: whichever label sits nearer the point takes the base
  // offset, the outer one clears a line. `align` is the same function for
  // both, so the pair always moves together.
  const outer = POINT_LABEL_OFFSET + POINT_LABEL_LINE;
  return {
    // Declared first so the collision sort — which ties on data index and
    // dataset index here — leaves the value as the survivor.
    detail: {
      offset: (ctx) => (alignFor(ctx) === 'top' ? POINT_LABEL_OFFSET : outer),
      color: (ctx) => {
        const m = at(ctx);
        if (!roomy(ctx) || !m || !m.change) return seriesColor;
        if (m.change.startsWith('+')) return CHANGE_UP_COLOR;
        if (m.change.startsWith('-')) return CHANGE_DOWN_COLOR;
        return seriesColor;   // a flat 0%, like an unclassed table cell
      },
      formatter: (v, ctx) => {
        if (roomy(ctx)) return (at(ctx) || {}).change || null;
        return perPoint(ctx) >= rankPxPerPoint ? rankText(ctx) : null;
      },
    },
    value: {
      offset: (ctx) => (alignFor(ctx) === 'top' ? outer : POINT_LABEL_OFFSET),
      formatter: (v, ctx) => {
        const rank = roomy(ctx) ? rankText(ctx) : null;
        return rank ? `${formatValue(v)} ${rank}` : formatValue(v);
      },
    },
  };
}
