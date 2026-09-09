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
    { el: '.mn-createbtn', key: 'tour.dash.create', side: 'bottom', noInteract: true, subtour: 'create' },
    { el: '.mn-tplbtn', key: 'tour.dash.templates', side: 'bottom', noInteract: true },
    { el: '.mn-notifs', key: 'tour.dash.notifications', side: 'bottom', align: 'end', noInteract: true },
    { el: '.mn-toggle', key: 'tour.dash.toggle', side: 'bottom' },
    { el: '.mn-search', key: 'tour.dash.search', side: 'bottom' },
    { el: '#cardList', key: 'tour.dash.cards', side: 'top' },
    { el: '.gp-nav__link[href="/pages/statistics.html"]', key: 'tour.dash.gotoStats', side: 'right', sidebar: true, handoff: '/pages/statistics.html' },
  ];

  // The `generate` step's Next actually generates a demo report (China) and
  // the tour then continues into the report's sections; report-section anchors
  // are hidden until then, so a tour started before any report simply won't
  // include them — the resume after generation rebuilds the step list.
  const STATS_STEPS = [
    { el: null, key: 'tour.stats.welcome' },
    { el: '#statModeSwitch', key: 'tour.stats.mode', side: 'bottom' },
    { el: '#countrySearch', key: 'tour.stats.country', side: 'bottom', align: 'start' },
    { el: '#reportLangToggle', key: 'tour.stats.reportLang', side: 'bottom' },
    { el: '#generateBtn', key: 'tour.stats.generate', side: 'bottom', noInteract: true, statsGenerate: true },
    { el: '.stat-tabs', key: 'tour.stats.tabs', side: 'bottom' },
    { el: '.stat-controls__buttons', key: 'tour.stats.export', side: 'bottom', align: 'end', noInteract: true },
    { el: '#tradeSummary', key: 'tour.stats.trade', side: 'bottom' },
    { el: '#tradeChartsRow', key: 'tour.stats.tradeCharts', side: 'top' },
    { el: '#tourismRow', key: 'tour.stats.tourism', side: 'top' },
    { el: '#fdiRow', key: 'tour.stats.investments', side: 'top' },
    { el: '#companiesSummary', key: 'tour.stats.companies', side: 'top' },
    { el: '#appendixTable', key: 'tour.stats.appendix', side: 'top' },
    { el: null, key: 'tour.stats.finish' },
  ];

  // Walkthrough of the shared create-event form (EventCreate's #ecModal).
  // Entered from the dashboard tour's `create` step (Next opens the form), or
  // directly by clicking Help while the form is already open. Conditionally
  // visible fields (role selects, meeting time) are covered by the same
  // visibility filter as everywhere else.
  const CREATE_STEPS = [
    { el: null, key: 'tour.create.welcome' },
    { el: '#titleGroup', key: 'tour.create.title', side: 'bottom' },
    { el: '#countryGroup', key: 'tour.create.country', side: 'bottom' },
    { el: '#docTypeGroup', key: 'tour.create.docType', side: 'bottom' },
    { el: '#workflowGroup', key: 'tour.create.workflow', side: 'bottom' },
    { el: '#dsRoleGroup', key: 'tour.create.dsRole', side: 'bottom' },
    { el: '#languageGroup', key: 'tour.create.language', side: 'bottom' },
    { el: '#deadlineGroup', key: 'tour.create.deadline', side: 'bottom' },
    { el: '#eventDateTimeGroup', key: 'tour.create.meetingTime', side: 'bottom' },
    { el: '#curatorGroup', key: 'tour.create.curator', side: 'bottom' },
    { el: '#taskGroup', key: 'tour.create.task', side: 'top' },
    { el: '#attachmentGroup', key: 'tour.create.attachment', side: 'top' },
    { el: '#templateGroup', key: 'tour.create.template', side: 'top' },
    { el: '#sectionsGroup', key: 'tour.create.sections', side: 'top' },
    { el: '#ecSave', key: 'tour.create.save', side: 'top', align: 'end', noInteract: true },
    { el: null, key: 'tour.create.finish', createFinish: true },
  ];
  const CREATE_TOUR = { steps: CREATE_STEPS, sentinel: '#newTitle' };

  const TOURS = [
    { match: p => /\/pages\/dashboard-[a-z-]+\.html$/.test(p), steps: DASHBOARD_STEPS, sentinel: '#cardList' },
    { match: p => p.endsWith('/pages/statistics.html'), steps: STATS_STEPS, sentinel: '#generateBtn' },
  ];

  function isCreateModalOpen() {
    const m = document.getElementById('ecModal');
    return !!m && m.style.display !== 'none';
  }

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0 && !el.closest('.hidden');
  }

  function clearBodyClasses() {
    document.body.classList.remove('gp-sidebar-expanded', 'vp-tour-sidebar');
  }

  // driver.js auto-scrolls only when the anchor is outside the *window*
  // viewport. An anchor clipped inside a scrollable container — the create
  // form's #ecModalBody — passes that check, so driver skips its scroll and
  // highlights a hidden spot; and the viewer can't scroll manually because
  // driver locks pointer events during a tour. Center such anchors in their
  // scroll container ourselves, before driver measures them.
  function scrollWithinScrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (!/(auto|scroll)/.test(window.getComputedStyle(p).overflowY)) continue;
      const pr = p.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.top < pr.top || er.bottom > pr.bottom) {
        p.scrollTop += (er.top + er.bottom) / 2 - (pr.top + pr.bottom) / 2;
      }
      return;
    }
  }

  function writeHandoff(page) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, tourId: 'grand', page, step: 0, ts: Date.now() }));
    } catch (_) { /* storage unavailable — hand-off page starts fresh via Help */ }
  }

  function clearHandoff() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // Callback run when the create-form walkthrough finishes via its final
  // step's button — set only when it was entered from the dashboard tour, so a
  // directly-started form tour (Help while the form is open) just ends there.
  // Escape clears it: abandoning the sub-tour abandons the whole tour.
  let _afterCreate = null;

  // Bumped on every tour start; pending async continuations (report
  // generation, form polling) capture the value and bail out if a new tour
  // was started in the meantime, so an impatient Help click can't stack a
  // second driver instance on top of a delayed resume.
  let _tourGen = 0;

  // The stats `generate` step's Next runs the demo generation itself: type
  // China into the country search, pick it from the dropdown, click Generate,
  // wait for the report to finish loading, then resume the tour right after
  // the generate step — now with the report-section steps available. Every
  // wait has a deadline: if the country list or the report never arrives, the
  // tour resumes anyway and the visibility filter drops the section steps.
  function runStatsGenerate(d) {
    const gen = ++_tourGen;
    d.destroy();
    clearBodyClasses();
    const resume = () => {
      if (gen !== _tourGen) return;
      const tour = TOURS.find(tr => tr.match(window.location.pathname));
      if (tour) startTour(tour, { afterKey: 'tour.stats.generate' });
    };
    const input = document.getElementById('countrySearch');
    if (!input) { resume(); return; }
    // Dropdown labels follow the *report* language (statReportLocale), not
    // the site language; if the first query never matches — wrong guess, or
    // labels differ — the second one is tried after a few seconds.
    const reportLoc = localStorage.getItem('statReportLocale') || I18n.getLocale() || 'ka';
    const queries = reportLoc === 'en' ? ['China', 'ჩინეთი'] : ['ჩინეთი', 'China'];
    const altAt = Date.now() + 8000;
    const pickBy = Date.now() + 20000;
    (function pick() {
      if (gen !== _tourGen) return;
      // Re-fire the search every attempt: the country list loads from
      // Geostat and renderDropdown only reacts to input events, so a single
      // dispatch before the list arrives would leave "no results" up forever.
      const q = Date.now() < altAt ? queries[0] : queries[1];
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const items = Array.from(document.querySelectorAll('#countryDropdown .stat-dropdown__item'));
      const item = items.find(i => i.textContent.trim().toLowerCase() === q.toLowerCase()) || items[0];
      if (item) {
        item.click();
        const btn = document.getElementById('generateBtn');
        if (btn && !btn.disabled) {
          btn.click();
          waitForReport();
          return;
        }
      }
      if (Date.now() < pickBy) setTimeout(pick, 300);
      else resume();
    })();
    function waitForReport() {
      const by = Date.now() + 60000;
      (function poll() {
        if (gen !== _tourGen) return;
        const s = document.getElementById('statSections');
        const ready = s && !s.classList.contains('hidden') && !s.classList.contains('is-loading');
        if (ready || Date.now() >= by) resume();
        else setTimeout(poll, 400);
      })();
    }
  }

  // Close the dashboard tour, open the create-event form through its real
  // button, and walk it; afterwards close the form and resume the dashboard
  // tour at the step following `create`.
  function enterCreateSubtour(d) {
    d.destroy();
    clearBodyClasses();
    _afterCreate = () => {
      const cancel = document.getElementById('ecCancel');
      if (cancel) cancel.click();
      const tour = TOURS.find(tr => tr.match(window.location.pathname));
      if (tour) startTour(tour, { afterKey: 'tour.dash.create' });
    };
    const btn = document.querySelector('.mn-createbtn');
    if (btn) btn.click();
    else if (window.EventCreate) window.EventCreate.open({});
    const gen = ++_tourGen;
    const deadline = Date.now() + 8000;
    (function poll() {
      if (gen !== _tourGen) return;
      if (isVisible(document.querySelector(CREATE_TOUR.sentinel))) startTour(CREATE_TOUR, 0);
      else if (Date.now() < deadline) setTimeout(poll, 250);
      else _afterCreate = null;
    })();
  }

  function finishCreateTour(d) {
    const done = _afterCreate;
    _afterCreate = null;
    d.destroy();
    clearBodyClasses();
    if (done) done();
  }

  function startTour(tour, startAt) {
    const driver = window.driver && window.driver.js && window.driver.js.driver;
    if (!driver) return;
    _tourGen++;

    // Turn the declarative defs into driver.js steps, dropping unusable
    // anchors. Built here so step callbacks can close over the instance `d`.
    let d = null;
    const steps = [];
    tour.steps.forEach(def => {
      if (def.el && !isVisible(document.querySelector(def.el))) return;
      const step = {
        vpKey: def.key,
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
      } else if (def.subtour === 'create') {
        step.popover.onNextClick = () => enterCreateSubtour(d);
      } else if (def.createFinish) {
        step.popover.onNextClick = () => finishCreateTour(d);
      } else if (def.statsGenerate) {
        step.popover.onNextClick = () => runStatsGenerate(d);
      }
      steps.push(step);
    });
    if (!steps.length) return;

    let index = 0;
    if (typeof startAt === 'number') {
      index = Math.min(startAt, steps.length - 1);
    } else if (startAt && startAt.afterKey) {
      const i = steps.findIndex(s => s.vpKey === startAt.afterKey);
      index = i >= 0 ? Math.min(i + 1, steps.length - 1) : 0;
    }
    d = driver({
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
        if (el) scrollWithinScrollParent(el);
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
        _afterCreate = null;
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
    d.drive(index);
  }

  function currentTour() {
    // Help while the create-event form is open tours the form itself.
    if (isCreateModalOpen()) return CREATE_TOUR;
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
