/**
 * App shell — sidebar, language toggle, auth guard.
 */
const App = {
  async init() {
    // Auth guard
    const token = Api.getToken();
    const user = Api.getUser();
    if (!token || !user) {
      window.location.href = '/login.html';
      return;
    }

    // Check must_change_password — force redirect
    if (user.mustChangePassword && !window.location.pathname.includes('change-password')) {
      window.location.href = '/pages/change-password.html';
      return;
    }

    // ANALYST is read-only and may only view the Statistics page (plus
    // change-password). Any other path bounces them back to Statistics.
    if (user.role === 'ANALYST') {
      const path = window.location.pathname;
      const allow = ['/pages/statistics.html', '/pages/change-password.html'];
      if (!allow.some(p => path.endsWith(p))) {
        window.location.href = '/pages/statistics.html';
        return;
      }
    }

    await I18n.init();
    this.renderSidebar(user);
  },

  renderSidebar(user) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    document.body.classList.add('gp-shell-ready');
    sidebar.classList.add('gp-sidebar');

    const currentPath = window.location.pathname;
    const dashUrl = dashboardUrl(user.role);
    const displayName = user.fullName || user.username || 'User';
    const initials = displayName.trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() || '').join('') || 'U';

    const ICO = {
      menu: '<svg viewBox="0 0 24 24"><path d="M4 7a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5A1 1 0 0 1 4 7Zm0 5a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm1 4a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"/></svg>',
      close: '<svg viewBox="0 0 24 24"><path d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 0 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3Z"/></svg>',
      dashboard: '<svg viewBox="0 0 350 350"><path d="M251.9,25c8,0,16,0,23.9,0c6,0,11.7,1,17.3,2.9c10.6,3.6,18.4,10.6,24.3,19.9c4.9,7.8,6.9,16.4,7,25.5c0.1,16.5,0.1,33,0,49.5c-0.1,13.1-4.5,24.5-13.7,34c-5,5.1-11,8.7-17.7,11.2c-5.8,2.1-11.7,2.9-17.8,2.9c-15.7,0.1-31.4,0.1-47.1,0c-7.1,0-14-1.1-20.6-4c-7.8-3.4-14.1-8.5-19.2-15.3c-3.1-4.1-5.3-8.6-7-13.4c-1.6-4.9-2.3-10.1-2.3-15.3c0-16.7,0-33.5,0-50.2c0-6.8,1.2-13.4,4-19.6c3.6-7.9,9-14.3,16-19.4c5-3.6,10.5-5.9,16.4-7.3c4.7-1.1,9.4-1.4,14.2-1.4C237.2,25,244.5,25,251.9,25z"/><path d="M251.7,179.1c8.3,0,16.5,0,24.8,0c5.7,0,11.2,1,16.6,2.9c11.6,4,19.9,11.7,25.8,22.2c2.9,5.2,4.7,10.8,5.1,16.8c0.3,3.8,0.5,7.5,0.5,11.3c0.1,14.4,0,28.7,0,43.1c0,5.8-0.6,11.5-2.4,17c-2.7,8.1-7.3,15-13.7,20.7c-4.5,4-9.6,6.8-15.2,8.9c-6,2.3-12.2,2.9-18.5,3c-15.7,0.1-31.3,0.1-47,0c-6.9,0-13.7-1.1-20.2-4c-9.1-4-16.1-10.2-21.4-18.6c-4.9-7.7-7-16.3-7-25.3c-0.1-16.8,0-33.6,0-50.3c0-6.7,1.2-13.2,3.9-19.3c4-8.9,10.2-16,18.6-21.3c8-5,16.8-7,26.2-7.1C235.8,179.1,243.7,179.1,251.7,179.1z"/><path d="M98.1,25c7.8,0,15.7,0.1,23.5,0c6.2-0.1,12.1,1,17.9,2.9c8.8,2.9,15.7,8.5,21.4,15.6c3.3,4.2,5.8,9,7.5,14.1c1.6,5.1,2.4,10.4,2.4,15.7c0.1,16.4,0.1,32.9,0,49.3c0,5.2-0.7,10.4-2.3,15.4c-3.2,9.5-8.8,17.3-16.8,23.3c-5.7,4.3-12.2,7.1-19.1,8.5c-3.3,0.7-6.8,0.9-10.2,1c-16.1,0.1-32.3,0.1-48.4,0c-13.2-0.1-24.8-4.2-34.3-13.6c-5-5-8.8-10.8-11.2-17.5c-2.2-6-2.9-12.2-2.9-18.5c0-15.9,0-31.7,0-47.6c0-5.5,0.6-10.9,2.3-16.1c2.5-7.4,6.5-13.9,12.3-19.3c4.2-4,8.8-7.4,14.2-9.5c6.1-2.4,12.4-3.8,18.9-3.8C81.5,25,89.8,25,98.1,25z"/><path d="M25.4,251.1c0-8,0-16.1,0-24.1c0-6.9,1.2-13.5,4-19.7c3.6-7.9,9-14.4,16-19.5c5-3.6,10.5-5.9,16.5-7.3c4.4-1,8.9-1.4,13.4-1.4c15.8,0,31.6,0,47.4,0c5.8,0,11.3,1,16.8,2.9c11.2,3.9,19.3,11.3,25.3,21.4c4.3,7.4,6,15.5,6.1,24c0.1,16.5,0.1,33.1,0,49.6c0,5.2-0.7,10.3-2.3,15.3c-3.2,9.5-8.8,17.4-16.9,23.4c-6.9,5-14.6,8.3-23.2,8.8c-3.7,0.2-7.3,0.5-11,0.5c-14.5,0.1-29,0.1-43.5,0c-6.9-0.1-13.6-1.2-20-4c-9-4-16.1-10.2-21.3-18.5c-5-7.9-7-16.5-7.1-25.7C25.3,268.2,25.4,259.6,25.4,251.1z"/></svg>',
      calendar: '<svg viewBox="0 0 350 350"><path d="M175.1,140.4c49.2,0,98.4,0,147.5,0c2.1,0,2.1,0,2.1,2.1c0,36,0,72,0,108c0,5.5-0.4,10.9-1.6,16.3c-1.3,6.1-3.3,11.9-6.1,17.5c-4.9,9.9-11.8,18.2-20.4,25.1c-6.3,5-13.3,8.7-20.9,11.4c-8.3,2.9-16.8,4.2-25.5,4.2c-50.1,0-100.3,0-150.4,0c-5.5,0-11-0.5-16.4-1.6c-6-1.2-11.8-3.3-17.4-6c-9.3-4.4-17-10.9-23.6-18.6c-4.4-5.1-7.8-10.8-10.6-16.9c-4.6-10.2-6.5-20.9-6.5-32.1c0.1-35.8,0-71.6,0-107.4c0-2,0-2,2-2C76.6,140.4,125.8,140.4,175.1,140.4z"/><path d="M323.7,117.2c-99.2,0-198.2,0-297.7,0c1.2-4.3,2.3-8.3,3.6-12.3c1.7-5.4,4.3-10.3,7.3-15c5.8-9.1,13.3-16.5,22.4-22.3c4.9-3.1,10.1-5.9,15.7-7.7c3-1,6.2-1.7,9.3-2.4c2.2-0.5,2.4-0.5,2.4-2.8c0-5.6,0-11.3,0-16.9c0-3.1,0.7-6,2.7-8.4c5.5-6.5,14.6-5.5,18.9,1.5c1.3,2.1,1.5,4.3,1.5,6.6c0,5.5,0,10.9,0,16.4c0,1.9,0.1,2,2,2c42.1,0,84.3,0,126.4,0c2,0,2.1-0.1,2.1-2.1c0-5.6,0-11.3,0-16.9c0-4.8,2.2-8.3,6.3-10.5c4.2-2.2,8.2-1.7,11.9,1c3.4,2.5,4.8,5.9,4.8,10c0,5.8,0,11.6,0,17.5c0,2.1,0.1,2.2,2.2,2.5c5.2,0.8,10.2,2.4,15,4.6c8,3.6,15.2,8.4,21.6,14.5c6.9,6.6,12.2,14.2,16.2,22.9C320.9,105,322.7,110.9,323.7,117.2z"/></svg>',
      library: '<svg viewBox="0 0 350 350"><path d="M296.8,325H53.2c-15.4,0-27.8-12.5-27.8-27.8V172.6c0-15.4,12.5-27.8,27.8-27.8h243.6c15.4,0,27.8,12.5,27.8,27.8v124.5C324.6,312.5,312.1,325,296.8,325z"/><path d="M272,115.1H76.2c-7.9,0-14.3-6.4-14.3-14.3v-1.6c0-7.9,6.4-14.3,14.3-14.3H272c7.9,0,14.3,6.4,14.3,14.3v1.6C286.3,108.7,279.9,115.1,272,115.1z"/><path d="M234.5,55.2h-119c-7.9,0-14.3-6.4-14.3-14.3v-1.6c0-7.9,6.4-14.3,14.3-14.3h119.1c7.9,0,14.3,6.4,14.3,14.3v1.6C248.8,48.8,242.4,55.2,234.5,55.2z"/></svg>',
      admin: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
      statistics: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18v-2H5V3H3zm4 12h2V9H7v6zm4 0h2V5h-2v10zm4 0h2V7h-2v8z"/></svg>',
      logout: '<svg viewBox="0 0 24 24"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>',
    };

    function navIcon(label) {
      const l = (label || '').toLowerCase();
      if (l.includes('calendar')) return ICO.calendar;
      if (l.includes('library')) return ICO.library;
      if (l.includes('statistic')) return ICO.statistics;
      if (l.includes('admin')) return ICO.admin;
      return ICO.dashboard;
    }

    let navItems;
    if (user.role === 'ANALYST') {
      // ANALYST sees only Statistics — no dashboard/calendar/library/admin.
      navItems = [
        { href: '/pages/statistics.html', label: 'Statistics', i18n: 'nav.statistics', match: 'statistics' },
      ];
    } else {
      navItems = [
        { href: dashUrl, label: 'Dashboard', i18n: 'nav.dashboard', match: 'dashboard' },
        { href: '/pages/calendar.html', label: 'Calendar', i18n: 'nav.calendar', match: 'calendar' },
        { href: '/pages/library.html', label: 'Library', i18n: 'nav.library', match: 'library' },
        { href: '/pages/statistics.html', label: 'Statistics', i18n: 'nav.statistics', match: 'statistics' },
      ];
      if (user.role === 'ADMIN') {
        navItems.push({ href: '/pages/admin.html', label: 'Admin Panel', i18n: 'nav.admin', match: 'admin' });
      }
    }

    const navHtml = navItems.map(it => {
      const active = currentPath.includes(it.match) ? ' active' : '';
      return `<a href="${it.href}" class="gp-nav__link${active}"><span class="gp-nav__icon">${navIcon(it.label)}</span><span class="gp-nav__label" data-i18n="${it.i18n}">${escapeHtml(it.label)}</span></a>`;
    }).join('');

    sidebar.innerHTML = `
      <button class="gp-mobile-toggle" type="button" aria-label="Open menu">
        <span class="gp-mobile-toggle__icon">${ICO.menu}</span>
      </button>
      <div class="gp-sidebar__scrim"></div>
      <div class="gp-sidebar__panel">
        <div class="gp-sidebar__top">
          <div class="gp-brand">
            <div class="gp-brand__mark gp-brand__mark--logo">
              <img src="/assets/portal-logo-new.svg" alt="Vector" class="gp-brand__logo-img" />
            </div>
            <div class="gp-brand__text">
              <div class="gp-brand__title"><span class="gp-brand__title-main">Vector</span><span class="gp-brand__title-sub">by MOESD</span></div>
            </div>
          </div>
          <button class="gp-mobile-close" type="button" aria-label="Close menu">${ICO.close}</button>
        </div>

        <div class="gp-profile gp-profile--top">
          <div class="gp-profile__avatar">${escapeHtml(initials)}</div>
          <div class="gp-profile__text">
            <div class="gp-profile__name">${escapeHtml(displayName)}</div>
            <div class="gp-profile__role">${escapeHtml(roleLabel(user.role))}</div>
          </div>
        </div>

        <nav class="gp-nav">${navHtml}</nav>

        <div class="gp-sidebar__spacer"></div>

        <div class="gp-sidebar__footer">
          <div class="gp-lang-switch" role="radiogroup" aria-label="Language">
            <button type="button" class="gp-lang-switch__opt" data-lang="en">EN</button>
            <button type="button" class="gp-lang-switch__opt" data-lang="ka">ქარ</button>
          </div>
          <button class="gp-logout" id="logoutBtn" type="button">
            <span class="gp-nav__icon">${ICO.logout}</span>
            <span class="gp-nav__label" data-i18n="nav.logout">Logout</span>
          </button>
        </div>
      </div>
    `;

    // ── Expand / collapse (desktop hover) ──────────────────────────────────
    const body = document.body;
    const isDesktop = () => window.innerWidth > 980;
    const expand = () => body.classList.add('gp-sidebar-expanded');
    const collapse = () => body.classList.remove('gp-sidebar-expanded');
    const openMenu = () => body.classList.add('gp-menu-open');
    const closeMenu = () => body.classList.remove('gp-menu-open');

    sidebar.addEventListener('mouseenter', () => { if (isDesktop()) expand(); });
    sidebar.addEventListener('mouseleave', () => { if (isDesktop()) collapse(); });
    sidebar.addEventListener('focusin', () => { if (isDesktop()) expand(); });
    sidebar.addEventListener('focusout', (e) => { if (isDesktop() && !sidebar.contains(e.relatedTarget)) collapse(); });

    // ── Mobile toggle ──────────────────────────────────────────────────────
    sidebar.querySelector('.gp-mobile-toggle')?.addEventListener('click', () => { collapse(); openMenu(); });
    sidebar.querySelector('.gp-mobile-close')?.addEventListener('click', closeMenu);
    sidebar.querySelector('.gp-sidebar__scrim')?.addEventListener('click', closeMenu);
    sidebar.querySelectorAll('.gp-nav__link').forEach(link => link.addEventListener('click', () => { if (!isDesktop()) closeMenu(); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', () => { if (isDesktop()) closeMenu(); else collapse(); });

    // ── Language switch & logout ─────────────────────────────────────────
    // The sidebar is injected after I18n.init() translated the document, so
    // translate its [data-i18n] labels (nav, logout) into the active locale.
    I18n.translateRoot(sidebar);
    this._refreshLangSwitch();
    sidebar.querySelectorAll('.gp-lang-switch__opt').forEach(btn => {
      btn.addEventListener('click', () => this.setLang(btn.dataset.lang));
    });
    document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
  },

  _refreshLangSwitch() {
    const cur = I18n.getLocale();
    document.querySelectorAll('.gp-lang-switch__opt').forEach(btn => {
      const active = btn.dataset.lang === cur;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
  },

  async setLang(lang) {
    if (!lang || lang === I18n.getLocale()) return;
    await I18n.setLocale(lang);
    this._refreshLangSwitch();
  },

  logout() {
    Api.clearToken();
    window.location.href = '/login.html';
  },
};
