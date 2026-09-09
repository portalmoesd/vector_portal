/**
 * VectorTour — guided site tour built on driver.js v1 (vendored at /vendor/driver/).
 *
 * driver.js exposes its factory as window.driver.js.driver (IIFE build).
 * Exposed as window.VectorTour so app.js can feature-detect it when deciding
 * whether to render the sidebar Help button (a top-level `const` in a classic
 * script does not become a window property).
 *
 * Multi-page hand-off: the last dashboard step writes a sessionStorage record
 * and navigates to the statistics page, where maybeResume() picks it up once
 * the page has rendered.
 */
window.VectorTour = (() => {
  const STORAGE_KEY = 'vp.tour';
  const RESUME_TTL_MS = 120000;

  // Steps whose element is missing or hidden at start time are skipped, so the
  // same dashboard tour works for every role (e.g. no .mn-createbtn → no step).
  const DASHBOARD_STEPS = [
    { el: null, key: 'tour.dash.welcome' },
    { el: '.gp-nav', key: 'tour.dash.nav', side: 'right', sidebar: true },
    { el: '#mnHero', key: 'tour.dash.hero', side: 'bottom' },
    { el: '#miniCalendar', key: 'tour.dash.calendar', side: 'right', align: 'start' },
    { el: '#mnSide', key: 'tour.dash.upcoming', side: 'left' },
    { el: '.mn-createbtn', key: 'tour.dash.create', side: 'bottom', noInteract: true },
    { el: '.mn-tplbtn', key: 'tour.dash.templates', side: 'bottom', noInteract: true },
    { el: '.mn-notifs', key: 'tour.dash.notifications', side: 'bottom', align: 'end', noInteract: true },
    { el: '.mn-toggle', key: 'tour.dash.toggle', side: 'bottom' },
    { el: '.mn-search', key: 'tour.dash.search', side: 'bottom' },
    { el: '#cardList', key: 'tour.dash.cards', side: 'top' },
    { el: '.gp-nav__link[href="/pages/statistics.html"]', key: 'tour.dash.gotoStats', side: 'right', sidebar: true, handoff: '/pages/statistics.html' },
  ];

  const STATS_STEPS = [
    { el: null, key: 'tour.stats.welcome' },
    { el: '#statModeSwitch', key: 'tour.stats.mode', side: 'bottom' },
    { el: '#countrySearch', key: 'tour.stats.country', side: 'bottom', align: 'start' },
    { el: '#reportLangToggle', key: 'tour.stats.reportLang', side: 'bottom' },
    { el: '#generateBtn', key: 'tour.stats.generate', side: 'bottom', noInteract: true },
    { el: '.stat-tabs', key: 'tour.stats.tabs', side: 'bottom' },
    { el: '.stat-controls__buttons', key: 'tour.stats.export', side: 'bottom', align: 'end', noInteract: true },
    { el: '#statSections', key: 'tour.stats.sections', side: 'top' },
    { el: null, key: 'tour.stats.finish' },
  ];

  const TOURS = [
    { match: p => /\/pages\/dashboard-[a-z-]+\.html$/.test(p), steps: DASHBOARD_STEPS, sentinel: '#cardList' },
    { match: p => p.endsWith('/pages/statistics.html'), steps: STATS_STEPS, sentinel: '#generateBtn' },
  ];

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0 && !el.closest('.hidden');
  }

  function clearBodyClasses() {
    document.body.classList.remove('gp-sidebar-expanded', 'vp-tour-sidebar');
  }

  function writeHandoff(page) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, tourId: 'grand', page, step: 0, ts: Date.now() }));
    } catch (_) { /* storage unavailable — hand-off page starts fresh via Help */ }
  }

  function clearHandoff() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // Turn the declarative defs into driver.js steps, dropping unusable anchors.
  function buildSteps(defs) {
    const steps = [];
    defs.forEach(def => {
      if (def.el && !isVisible(document.querySelector(def.el))) return;
      const step = {
        popover: {
          title: t(def.key + '.title'),
          description: t(def.key + '.desc'),
        },
      };
      if (def.el) step.element = def.el;
      if (def.side) step.popover.side = def.side;
      if (def.align) step.popover.align = def.align;
      if (def.noInteract) step.disableActiveInteraction = true;
      if (def.sidebar) step.vpSidebar = true;
      if (def.handoff) {
        step.popover.onNextClick = () => {
          writeHandoff(def.handoff);
          window.location.href = def.handoff;
        };
      }
      steps.push(step);
    });
    return steps;
  }

  function startTour(tour, startIndex) {
    const driver = window.driver && window.driver.js && window.driver.js.driver;
    if (!driver) return;
    const steps = buildSteps(tour.steps);
    if (!steps.length) return;
    const d = driver({
      popoverClass: 'vp-tour',
      animate: true,
      overlayOpacity: 0.55,
      stagePadding: 8,
      stageRadius: 14,
      allowClose: true,
      showProgress: true,
      progressText: t('tour.ui.progress'),
      nextBtnText: t('tour.ui.next'),
      prevBtnText: t('tour.ui.back'),
      doneBtnText: t('tour.ui.done'),
      onHighlightStarted: (el, step) => {
        if (step && step.vpSidebar) {
          document.body.classList.add('gp-sidebar-expanded', 'vp-tour-sidebar');
        } else {
          clearBodyClasses();
        }
      },
      // onDestroyed is skipped by driver.js when destroy happens mid-highlight
      // transition (no committed active step), so cleanup lives in
      // onDestroyStarted, which fires on every destroy attempt and expects us
      // to complete the teardown ourselves.
      onDestroyStarted: () => {
        clearBodyClasses();
        clearHandoff();
        d.destroy();
      },
      onDestroyed: () => {
        clearBodyClasses();
        clearHandoff();
      },
      steps,
    });
    d.drive(Math.min(startIndex || 0, steps.length - 1));
  }

  function currentTour() {
    return TOURS.find(tr => tr.match(window.location.pathname)) || null;
  }

  function start() {
    const tour = currentTour();
    if (tour) startTour(tour, 0);
  }

  function isAvailable() {
    return !!currentTour();
  }

  // Resume a cross-page hand-off: valid, fresh record for this page → wait for
  // the page script (which awaits App.init() and renders async) to produce the
  // sentinel element, then continue the tour.
  function maybeResume() {
    let record = null;
    try { record = JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch (_) {}
    if (!record) return;
    if (record.v !== 1 || record.page !== window.location.pathname || (Date.now() - record.ts) > RESUME_TTL_MS) {
      clearHandoff();
      return;
    }
    const tour = currentTour();
    if (!tour) { clearHandoff(); return; }
    // gp-shell-ready is added by App.renderSidebar() after I18n has loaded its
    // strings — starting before that would render raw i18n keys.
    const deadline = Date.now() + 6000;
    (function poll() {
      if (document.body.classList.contains('gp-shell-ready') && isVisible(document.querySelector(tour.sentinel))) {
        clearHandoff();
        startTour(tour, record.step);
      } else if (Date.now() < deadline) {
        setTimeout(poll, 250);
      } else {
        clearHandoff();
      }
    })();
  }

  maybeResume();

  return { start, isAvailable };
})();
