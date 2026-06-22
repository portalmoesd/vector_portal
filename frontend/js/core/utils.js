/**
 * Shared utility functions.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Country records only store the English name + ISO code. When the site is in
// Georgian, translate the code via Intl.DisplayNames; fall back to English if
// the locale isn't Georgian, the code is missing, or no translation exists.
let _regionDisplayNamesKa;
function localizedCountryName(country) {
  if (!country) return '';
  const en = country.name_en || country.nameEn || country.name || '';
  const code = (country.code || '').toUpperCase();
  try {
    const locale = (typeof I18n !== 'undefined' && I18n.getLocale) ? I18n.getLocale() : 'en';
    if (locale === 'ka' && code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
      if (!_regionDisplayNamesKa) _regionDisplayNamesKa = new Intl.DisplayNames(['ka'], { type: 'region' });
      const ka = _regionDisplayNamesKa.of(code);
      if (ka && ka !== code) return ka;
    }
  } catch (_) { /* fall back to English */ }
  return en;
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
  return d.toLocaleDateString(_dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString(_dateLocale(), {
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
    submitted_to_super_collaborator: 'At Super-Collaborator',
    returned_by_super_collaborator: 'Returned by Super-Collaborator',
    approved_by_super_collaborator: 'Approved (Super-Collaborator)',
    submitted_to_curator: 'At Curator',
    returned_by_curator: 'Returned by Curator',
    approved_by_curator: 'Approved (Curator)',
    submitted_to_supervisor: 'At Supervisor',
    returned_by_supervisor: 'Returned by Supervisor',
    approved_by_supervisor: 'Approved (Supervisor)',
    submitted_to_deputy: 'At Deputy',
    returned_by_deputy: 'Returned by Deputy',
    approved_by_deputy: 'Approved (Deputy)',
    submitted_to_receiving_super_collaborator: 'At Super-Collaborator (Review)',
    returned_by_receiving_super_collaborator: 'Returned by Super-Collaborator (Review)',
    approved_by_receiving_super_collaborator: 'Approved (Super-Collaborator Review)',
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
    SUPER_COLLABORATOR: 'Super-Collaborator',
    COLLABORATOR: 'Collaborator',
    ANALYST: 'Analyst',
    CURATOR: 'Curator',
    // Receiving chain roles display the same label — the department name
    // shown underneath distinguishes them from the section dept's roles
    RECEIVING_SUPER_COLLABORATOR: 'Super-Collaborator',
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
    PROTOCOL: '/pages/calendar.html',
    ANALYST: '/pages/statistics.html',
  };
  return map[role] || '/pages/dashboard-collab.html';
}
