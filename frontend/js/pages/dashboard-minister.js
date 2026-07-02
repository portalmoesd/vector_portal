/**
 * Minister Dashboard.
 *
 * A read-only consumer view with two modes, switched by a centered toggle:
 *   - Completed (default): the Minister's finished documents (GET /api/library,
 *     already scoped to events where they are the Document Submitter).
 *   - Upcoming: events currently being prepared for the Minister (GET /api/events,
 *     isActive) — info only.
 *
 * Layout: a calendar on the left and an expanded detail panel on its right;
 * the unchosen events are listed below. Selecting a card (or a marked calendar
 * day) "chooses" that event — it expands into the right panel (for a completed
 * event, the document is previewed inline with PDF/Word/Files actions) and is
 * removed from the list below. A search box filters the active list.
 *
 * Reuses the calendar + card styles from dashboard-pipeline.css and the
 * shared document helpers in LibraryDoc (/js/core/library-doc.js).
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  // This dashboard serves several roles. Owner roles (Minister/Deputy/Supervisor)
  // get a meeting-centric view; everyone else gets the worker view. Only the
  // read-only Minister can't act on documents.
  const canEdit = user.role !== 'MINISTER';
  const OWNER_ROLES = ['MINISTER', 'DEPUTY', 'SUPERVISOR'];
  const isOwner = OWNER_ROLES.includes(user.role);
  const isMinister = user.role === 'MINISTER';
  // Roles that may create events from the dashboard (the collapsible create panel).
  const CAN_CREATE_EVENT = ['DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
  const canCreateEvent = CAN_CREATE_EVENT.includes(user.role);

  const listEl = document.getElementById('cardList');
  const miniCalendarEl = document.getElementById('miniCalendar');
  const keywordEl = document.getElementById('filterKeyword');
  const toggleBtns = Array.from(document.querySelectorAll('.mn-toggle__btn'));

  // ── Accessibility wiring for the static markup shared by all role pages ──────
  // Reflect the active locale on <html> so screen readers pronounce the runtime
  // Georgian/English content correctly (the pages ship as lang="en-GB").
  if (typeof I18n !== 'undefined' && I18n.getLocale) {
    document.documentElement.lang = I18n.getLocale() === 'ka' ? 'ka' : 'en';
  }
  // The segmented control is a toggle, not an ARIA tablist (there's no tabpanel
  // wiring); expose it as a labelled group of pressed-state buttons instead.
  const toggleWrap = document.querySelector('.mn-toggle');
  if (toggleWrap) {
    toggleWrap.setAttribute('role', 'group');
    toggleWrap.setAttribute('aria-label', I18n.tr('nav.dashboard') || 'Dashboard');
  }
  // Label the search field (placeholder alone is not an accessible name) and hide
  // its decorative magnifier icon from assistive tech.
  if (keywordEl) keywordEl.setAttribute('aria-label', I18n.tr('dashboard.searchLabel'));
  document.querySelector('.mn-search__icon')?.setAttribute('aria-hidden', 'true');
  const toggleThumb = document.getElementById('mnToggleThumb');

  // Mode set per role:
  //  - owner roles: 'meetings' (events they own, keyed by meeting date/time, with
  //    a readiness chip) and 'tasks' (events they only contribute to);
  //  - worker roles: 'completed' | 'upcoming' (unchanged).
  // Worker roles land on the In-Progress view first; owners default to meetings.
  let mode = isOwner ? 'meetings' : 'upcoming';

  // Relabel the segmented toggle for owner roles; the Minister has only meetings.
  if (isOwner) {
    const tc = document.getElementById('toggleCompleted');
    const tu = document.getElementById('toggleUpcoming');
    if (tc) { tc.dataset.mode = 'meetings'; tc.setAttribute('data-i18n', 'dashboard.tabMeetings'); tc.textContent = I18n.tr('dashboard.tabMeetings'); }
    if (tu) { tu.dataset.mode = 'tasks'; tu.setAttribute('data-i18n', 'dashboard.tabTasks'); tu.textContent = I18n.tr('dashboard.tabTasks'); }
    if (isMinister) {
      const wrap = document.querySelector('.mn-toggle');
      if (wrap) wrap.style.display = 'none'; // meetings only — no toggle
    }
  } else {
    // Put "In Progress" first and make it the active default tab.
    const tc = document.getElementById('toggleCompleted');
    const tu = document.getElementById('toggleUpcoming');
    if (tc && tu && tu.parentElement) {
      tu.parentElement.insertBefore(tu, tc); // In Progress before Completed
      tc.classList.remove('is-active');
      tu.classList.add('is-active');
    }
  }
  let calendarDate = new Date();
  let selectedId = null;  // currently expanded event id (within the active mode)
  // Attention dots (iOS-style), derived from notifications. Split by urgency:
  //   actEvents   → it's the user's turn to act (your_turn / returned) → RED
  //   newEventIds → a new event was added (event_created)              → ORANGE
  // When an event is both, RED wins. The new-event (orange) subset clears when the card is
  // opened; the act dot persists until the user acts.
  let actEvents = new Set();
  let newEventIds = new Set();
  // Events where a section currently awaits THIS user's action (live workflow state,
  // from GET /api/workflow/my-turn). This — not just unread notifications — is the
  // authoritative "your turn" (red) signal for the cards and tabs.
  let myTurnEvents = new Set();
  // Completed documents the user hasn't opened yet → green "ready" badge.
  let readyEvents = new Set();

  // An in-progress event needs the user to act (RED) when it's their turn per live
  // workflow status, or (belt-and-suspenders) an unread your_turn/returned notification.
  function isActEvent(id) {
    const s = String(id);
    return myTurnEvents.has(s) || actEvents.has(s);
  }

  // ── Georgian date names ─────────────────────────────────────────────────────
  // Browser Intl 'ka' data is inconsistent across environments, so localize
  // month / weekday names ourselves to guarantee Georgian output.
  const KA_MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
    'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
  const KA_WEEK_SHORT = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვ']; // Mon..Sun
  const KA_WEEK_LONG = ['ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი', 'კვირა'];
  function isKa() { return typeof I18n !== 'undefined' && I18n.getLocale && I18n.getLocale() === 'ka'; }
  function monIndex(jsDay) { return (jsDay + 6) % 7; } // JS Sun=0 → Mon-first index

  // Long "weekday, D Month YYYY" date for the hero.
  function longDate(date) {
    if (isKa()) {
      return `${KA_WEEK_LONG[monIndex(date.getDay())]}, ${date.getDate()} ${KA_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    }
    const loc = (typeof _dateLocale === 'function') ? _dateLocale() : 'en-GB';
    return date.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ── Load data ────────────────────────────────────────────────────────────
  // Use allSettled so one failing endpoint can't blank the whole dashboard
  // (the calendar must still render even if a list fails to load).
  let completed = [];
  let upcoming = [];
  const [libRes, evRes] = await Promise.allSettled([
    Api.get('/api/library'),
    Api.get('/api/events'),
  ]);
  // Tag each item with readiness so cards/detail can render per-item (the
  // meeting list mixes ready + in-preparation events).
  if (libRes.status === 'fulfilled') completed = (libRes.value || []).map(d => ({ ...d, _ready: true }));
  // Events still being prepared (not yet completed/archived).
  if (evRes.status === 'fulfilled') upcoming = (evRes.value || []).filter(e => e.isActive).map(d => ({ ...d, _ready: false }));
  if (libRes.status === 'rejected' && evRes.status === 'rejected') {
    listEl.innerHTML = `<div class="msg msg-error">${escapeHtml(libRes.reason?.message || 'Failed to load')}</div>`;
  }

  // ── Hero: greeting + date + live Tbilisi clock ──────────────────────────────
  // Tbilisi (UTC+4, no DST) date/time parts.
  function tbilisiParts() {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tbilisi',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    return p;
  }
  function partOfDay(hour) {
    if (hour >= 5 && hour <= 11) return 'morning';
    if (hour >= 12 && hour <= 16) return 'afternoon';
    if (hour >= 17 && hour <= 20) return 'evening';
    return 'night';
  }
  // Time-of-day icons drawn as asset files (drop your SVGs in /frontend/assets/).
  const HERO_ICONS = {
    morning: '/assets/morning-icon.svg',
    afternoon: '/assets/afternoon-icon.svg',
    evening: '/assets/evening-icon.svg',
    night: '/assets/night-icon.svg',
  };
  // Inline fallback shown until the asset files exist (uses currentColor).
  const FALLBACK_ICONS = {
    morning: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a5 5 0 0 1 10 0z" stroke="none"/><g fill="none"><line x1="2.8" y1="15" x2="4.6" y2="15"/><line x1="19.4" y1="15" x2="21.2" y2="15"/><line x1="5" y1="9.2" x2="6.3" y2="10.5"/><line x1="19" y1="9.2" x2="17.7" y2="10.5"/><line x1="2.8" y1="18.8" x2="21.2" y2="18.8"/><polyline points="9.5 6 12 3.5 14.5 6"/></g></svg>',
    afternoon: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.4" stroke="none"/><g fill="none"><line x1="12" y1="1.6" x2="12" y2="3.8"/><line x1="12" y1="20.2" x2="12" y2="22.4"/><line x1="1.6" y1="12" x2="3.8" y2="12"/><line x1="20.2" y1="12" x2="22.4" y2="12"/><line x1="4.4" y1="4.4" x2="6" y2="6"/><line x1="18" y1="18" x2="19.6" y2="19.6"/><line x1="4.4" y1="19.6" x2="6" y2="18"/><line x1="18" y1="6" x2="19.6" y2="4.4"/></g></svg>',
    evening: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a5 5 0 0 1 10 0z" stroke="none"/><g fill="none"><line x1="2.8" y1="15" x2="4.6" y2="15"/><line x1="19.4" y1="15" x2="21.2" y2="15"/><line x1="5" y1="9.2" x2="6.3" y2="10.5"/><line x1="19" y1="9.2" x2="17.7" y2="10.5"/><line x1="2.8" y1="18.8" x2="21.2" y2="18.8"/><polyline points="9.5 3.5 12 6 14.5 3.5"/></g></svg>',
    night: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-linejoin="round"><path d="M13.5 2.5 A 9.5 9.5 0 0 0 13.5 21.5 A 13 13 0 0 1 13.5 2.5 Z" stroke-width="0.6"/><path d="M18.3 4 L19.18 5.79 L21.15 6.07 L19.73 7.46 L20.06 9.43 L18.3 8.5 L16.54 9.43 L16.87 7.46 L15.45 6.07 L17.42 5.79 Z" stroke-width="1"/><path d="M16.5 11.7 L17.62 13.96 L20.11 14.33 L18.31 16.09 L18.73 18.57 L16.5 17.4 L14.27 18.57 L14.69 16.09 L12.89 14.33 L15.38 13.96 Z" stroke-width="1.1"/></svg>',
  };

  // Prefer the Georgian name when the UI is Georgian (defensive across key names).
  function ministerName() {
    if (isKa()) {
      const ka = user.fullNameKa || user.fullNameGe || user.fullNameGeo || user.nameKa || user.full_name_ka;
      if (ka) return ka;
    }
    return user.fullName || user.username || '';
  }

  // Greeting uses the first name only.
  function ministerFirstName() {
    return ministerName().trim().split(/\s+/)[0] || '';
  }

  const heroIconEl = document.getElementById('mnHeroIcon');
  const clockEl = document.getElementById('mnClock');

  function paintHero() {
    const t = tbilisiParts();
    const hourNum = parseInt(t.hour, 10) % 24;
    const pod = partOfDay(hourNum);
    const greeting = I18n.tr('dashboard.greeting' + pod.charAt(0).toUpperCase() + pod.slice(1));
    const name = ministerFirstName();
    const gEl = document.getElementById('mnGreeting');
    if (gEl) gEl.textContent = name ? `${greeting}, ${name}` : greeting;
    const dEl = document.getElementById('mnDate');
    if (dEl) dEl.textContent = longDate(new Date(parseInt(t.year, 10), parseInt(t.month, 10) - 1, parseInt(t.day, 10)));
    if (heroIconEl) {
      heroIconEl.className = 'mn-hero__icon mn-hero__icon--' + pod;
      heroIconEl.innerHTML = `<img src="${HERO_ICONS[pod]}" alt="" />`;
      const img = heroIconEl.querySelector('img');
      // Fall back to the inline glyph if the asset file isn't there yet.
      img.addEventListener('error', () => { heroIconEl.innerHTML = FALLBACK_ICONS[pod]; });
    }
    if (clockEl) clockEl.innerHTML = `${String(hourNum).padStart(2, '0')}<span class="mn-hero__colon">:</span>${t.minute}`;
  }
  paintHero();
  setInterval(paintHero, 30000);

  // Slide the segmented-toggle thumb under the active option.
  function positionThumb() {
    // Keep the toggle's pressed state in sync for assistive tech (this runs on
    // init, mode switch, and badge updates — the single place is-active changes).
    toggleBtns.forEach(b => b.setAttribute('aria-pressed', b.classList.contains('is-active') ? 'true' : 'false'));
    if (!toggleThumb) return;
    const active = toggleBtns.find(b => b.classList.contains('is-active'));
    if (!active) return;
    toggleThumb.style.left = active.offsetLeft + 'px';
    toggleThumb.style.width = active.offsetWidth + 'px';
    // When the active tab needs attention, the thumb carries its colour.
    const dot = active.getAttribute('data-dot');
    if (dot) toggleThumb.setAttribute('data-dot', dot);
    else toggleThumb.removeAttribute('data-dot');
  }
  window.addEventListener('resize', positionThumb);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isOwned(item) { return item.documentSubmitterId === user.id; }

  function itemsForMode(m) {
    switch (m) {
      case 'completed': return completed;
      case 'upcoming': return upcoming;
      // Meetings = events they own (ready + in-preparation), unified.
      case 'meetings': return completed.filter(isOwned).concat(upcoming.filter(isOwned));
      // Tasks ("Other Events") = events they contribute to but don't own —
      // in-progress ones plus finished ones (shown once ready).
      case 'tasks': return upcoming.filter(i => !isOwned(i)).concat(completed.filter(i => !isOwned(i)));
      default: return [];
    }
  }
  function activeItems() { return itemsForMode(mode); }

  // A tab shows a count badge before its label when its list holds badged cards.
  // Precedence: red (your turn to act) → orange (new event) → green (ready, unopened
  // document). The count is how many cards of the shown category the tab holds.
  function tabBadge(m) {
    const items = itemsForMode(m);
    const act = items.filter(d => !d._ready && isActEvent(d.id)).length;
    if (act > 0) return { color: 'red', count: act };
    const isNew = items.filter(d => !d._ready && newEventIds.has(String(d.id)) && !isActEvent(d.id)).length;
    if (isNew > 0) return { color: 'orange', count: isNew };
    // Green = finished documents. Owner roles show every finished doc (a persistent
    // "done" status); workers keep the unopened-only (readyEvents) attention cue.
    const green = items.filter(d => d._ready && (isOwner || readyEvents.has(String(d.id)))).length;
    if (green > 0) return { color: 'green', count: green };
    return null;
  }
  function updateTabDots() {
    // Driven via data-* + a ::before pseudo so the badge survives the label's
    // textContent/i18n relabels.
    toggleBtns.forEach(btn => {
      const b = tabBadge(btn.dataset.mode);
      if (b) {
        btn.dataset.dot = b.color;
        btn.dataset.count = b.count > 9 ? '9+' : String(b.count);
      } else {
        btn.removeAttribute('data-dot');
        btn.removeAttribute('data-count');
      }
    });
    positionThumb(); // badge widths change the button size — realign the thumb
  }

  // The date a calendar marker / grouping keys off, per mode.
  function itemDate(item) {
    if (mode === 'meetings') return item.eventDateTime;
    if (mode === 'completed') return item.endedAt;
    return item.deadlineDate; // upcoming | tasks
  }

  // Deputy/Supervisor get a hybrid calendar: their meetings AND the events they
  // contribute to, shown together regardless of the active list tab. (Minister has
  // no 'tasks'; worker roles use completed/upcoming — both keep the tab-scoped calendar.)
  const HYBRID_CAL = isOwner && !isMinister;

  // Items whose day-markers the calendar shows for the current view.
  function calendarItems() {
    return HYBRID_CAL ? itemsForMode('meetings').concat(itemsForMode('tasks')) : activeItems();
  }

  // Marker day for an item, independent of the active tab in the hybrid case:
  // owned events key off the meeting time, others off their deadline.
  function calItemDate(item) {
    if (HYBRID_CAL) return isOwned(item) ? item.eventDateTime : item.deadlineDate;
    return itemDate(item);
  }

  function itemById(id) {
    return activeItems().find(d => String(d.id) === String(id)) || null;
  }

  function getFiltered() {
    const kw = (keywordEl.value || '').toLowerCase().trim();
    if (!kw) return activeItems();
    return activeItems().filter(d =>
      (d.title || '').toLowerCase().includes(kw) ||
      (d.countryName || '').toLowerCase().includes(kw)
    );
  }

  function select(id) {
    selectedId = id == null ? null : String(id);
    // Opening a card clears its "new event" (red) or "ready" (green) dot — both
    // clear on open. (The your-turn red dot persists until the action is done.)
    const clearType = selectedId && newEventIds.has(selectedId) ? 'event_created'
      : (selectedId && readyEvents.has(selectedId) ? 'completed' : null);
    if (clearType) {
      Api.post('/api/notifications/read', { eventId: parseInt(selectedId, 10), type: clearType })
        .then(loadNotifications).catch(() => {});
    }
    renderList();
  }

  // ── List cards (below the calendar): clickable ──────────────────────────────
  function excerptText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || '').trim();
  }

  // Urgency-aware deadline label for in-progress events.
  // Localized "Month day" (EN) / "day Month" (KA), e.g. "July 5" / "5 ივლისი".
  function fmtDueDate(d) {
    const day = d.getDate();
    const month = gMonth(d.getMonth(), 'long');
    return isKa() ? `${day} ${month}` : `${month} ${day}`;
  }
  function dueInfo(deadline) {
    if (!deadline) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(deadline); d.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return { text: I18n.tr('dashboard.overdue'), cls: 'is-overdue' };
    if (days === 0) return { text: I18n.tr('dashboard.dueToday'), cls: 'is-overdue' };
    // Explicit date instead of "Due in N days"; near deadlines stay highlighted.
    return {
      text: I18n.tr('dashboard.dueDate').replace('{date}', fmtDueDate(d)),
      cls: days <= 7 ? 'is-soon' : '',
    };
  }

  const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
  // Rounded checkmark for the green "finished" card dot.
  const ICON_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

  function listCardHtml(d) {
    const country = localizedCountryName({ code: d.countryCode, name_en: d.countryName });
    const code = (d.countryCode || '').toLowerCase();
    const flag = code
      ? `<img src="/assets/flags/${code}.svg" alt="${escapeHtml(country)}" loading="lazy" onerror="this.closest('.mn-card__flag').style.display='none'">`
      : '';
    const ready = d._ready;
    const isMeetings = mode === 'meetings';
    let statusClass = ready ? 'mn-card--completed' : 'mn-card--inprogress';
    // Not-ready items whose key date (meeting time / deadline) has passed get a
    // light-yellow "overdue" card.
    const keyDate = isMeetings ? d.eventDateTime : d.deadlineDate;
    if (!ready && keyDate && startOfDay(new Date(keyDate)) < startOfDay(new Date())) {
      statusClass += ' mn-card--overdue';
    }
    const lang = languageLabel(d.language || 'EN');
    const langMeta = `${escapeHtml(I18n.tr('library.meta.language'))} ${escapeHtml(lang)}`;
    // In meetings the owner is the viewer themselves, so the owner chip is noise.
    const ownerName = localizedName(d.documentSubmitterName, d.documentSubmitterNameKa);
    const ownerInline = (!isMeetings && ownerName)
      ? `<span class="mn-card__owner" title="${escapeHtml(I18n.tr('dashboard.owner'))}: ${escapeHtml(ownerName)}">${ICON_PERSON}<span>${escapeHtml(ownerName)}</span></span>`
      : '';
    // My Calendar puts the event date/time on the prominent line (the flag already
    // conveys the country); other modes show country + owner.
    const sub = isMeetings
      ? `<div class="mn-card__sub">
          <span class="mn-card__country">${escapeHtml(country)}</span>
          <span class="mn-card__when">${ICON_CAL}<span>${escapeHtml(fmtEventWhen(d.eventDateTime))}</span></span>
        </div>`
      : `<div class="mn-card__sub">
          <span class="mn-card__country">${escapeHtml(country)}</span>
          ${ownerInline}
        </div>`;

    // Readiness chip (meetings only).
    const chip = isMeetings
      ? (ready
          ? `<span class="mn-chip mn-chip--ready">${escapeHtml(I18n.tr('dashboard.ready'))}</span>`
          : `<span class="mn-chip mn-chip--prep">${escapeHtml(I18n.tr('dashboard.inPreparation'))}</span>`)
      : '';

    // Meta line: Ready → completed date; in preparation → deadline info. (Same for
    // meetings and worker modes — only the sub line differs by mode.)
    let excerpt = '';
    let meta;
    if (ready) {
      meta = `${d.endedAt ? formatDate(d.endedAt) + ' · ' : ''}${langMeta}`;
    } else {
      const ex = excerptText(d.occasion);
      if (ex) excerpt = `<p class="mn-card__excerpt">${escapeHtml(ex)}</p>`;
      const due = dueInfo(d.deadlineDate);
      const dueHtml = due ? `<span class="${due.cls}">${escapeHtml(due.text)}</span> · ` : '';
      meta = `${dueHtml}${langMeta}`;
    }

    // Card dot: green = the document is finished; red = an in-progress event
    // needing the user's action (their turn); orange = a new in-progress event.
    // Finished documents are never in the in-progress sets, so these are exclusive.
    let attn = '';
    if (d._ready) {
      attn = `<span class="mn-card__attn mn-card__attn--ready" role="img" aria-label="${escapeHtml(I18n.tr('dashboard.badgeReady'))}">${ICON_TICK}</span>`; // green: finished (tick)
    } else if (isActEvent(d.id)) {
      attn = `<span class="mn-card__attn" role="img" aria-label="${escapeHtml(I18n.tr('dashboard.badgeAttention'))}">!</span>`; // red: your turn (!)
    } else if (newEventIds.has(String(d.id))) {
      attn = `<span class="mn-card__attn mn-card__attn--new" role="img" aria-label="${escapeHtml(I18n.tr('dashboard.badgeNew'))}">${escapeHtml(I18n.tr('dashboard.badgeNewShort'))}</span>`; // orange: new event (NEW)
    }
    return `
      <div class="dp-upcoming-event mn-card ${statusClass}" data-event-id="${d.id}" role="button" tabindex="0" aria-expanded="false">
        ${attn}
        <div class="mn-card__head">
          <span class="mn-card__flag" title="${escapeHtml(country)}">${flag}</span>
          <h4 class="mn-card__title">${escapeHtml(d.title)}</h4>
          ${chip}
        </div>
        ${sub}
        ${excerpt}
        <div class="mn-card__foot">
          <span class="mn-card__meta">${meta}</span>
          <span class="mn-card__cta">${escapeHtml(I18n.tr('dashboard.cardView'))} <span class="mn-card__arrow" aria-hidden="true">&rarr;</span></span>
        </div>
      </div>
    `;
  }

  // ── Date-relative grouping for the card list ────────────────────────────────
  const DAY_MS = 86400000;
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // Monday
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function gMonth(idx, style) {
    if (isKa()) return KA_MONTHS[idx];
    return new Date(2021, idx, 1).toLocaleDateString('en-GB', { month: style });
  }
  function fmtDay(d) { return `${d.getDate()} ${gMonth(d.getMonth(), 'short')}`; }
  // Event date/time as "DD Month, HH:MM" in Tbilisi time (localized month name).
  function fmtEventWhen(iso) {
    if (!iso) return I18n.tr('dashboard.notScheduled');
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tbilisi',
      day: '2-digit', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
    const hh = String(parseInt(p.hour, 10) % 24).padStart(2, '0');
    return `${parseInt(p.day, 10)} ${gMonth(parseInt(p.month, 10) - 1, 'long')}, ${hh}:${p.minute}`;
  }
  function fmtMonthYear(d) { return `${gMonth(d.getMonth(), 'long')} ${d.getFullYear()}`; }
  function fmtWeekRange(ws) {
    const we = addDays(ws, 6);
    return ws.getMonth() === we.getMonth()
      ? `${ws.getDate()}–${we.getDate()} ${gMonth(ws.getMonth(), 'short')}`
      : `${ws.getDate()} ${gMonth(ws.getMonth(), 'short')} – ${we.getDate()} ${gMonth(we.getMonth(), 'short')}`;
  }
  const grp = (k) => I18n.tr('dashboard.' + k);

  // Completed: newest first → Today, Yesterday, This week, Last week, 3 prior
  // weeks (by range), then by month.
  function bucketCompleted(date, now) {
    if (!date) return { order: 9999, key: 'undated', label: '—' };
    const t0 = startOfDay(now), d0 = startOfDay(date);
    const diff = Math.round((t0 - d0) / DAY_MS);
    if (diff === 0) return { order: 0, key: 'today', label: `${grp('grpToday')} · ${fmtDay(d0)}` };
    if (diff === 1) return { order: 1, key: 'yesterday', label: `${grp('grpYesterday')} · ${fmtDay(d0)}` };
    const tws = startOfWeek(now), iws = startOfWeek(date);
    const weeksAgo = Math.round((tws - iws) / (7 * DAY_MS));
    if (weeksAgo === 0) return { order: 2, key: 'thisweek', label: grp('grpThisWeek') };
    if (weeksAgo === 1) return { order: 3, key: 'lastweek', label: `${grp('grpLastWeek')} · ${fmtWeekRange(iws)}` };
    if (weeksAgo >= 2 && weeksAgo <= 4) return { order: 3 + weeksAgo, key: 'w' + iws.getTime(), label: fmtWeekRange(iws) };
    const my = new Date(date.getFullYear(), date.getMonth(), 1);
    const monthsAgo = (now.getFullYear() - my.getFullYear()) * 12 + (now.getMonth() - my.getMonth());
    return { order: 100 + monthsAgo, key: 'm' + my.getFullYear() + '-' + my.getMonth(), label: fmtMonthYear(my) };
  }

  // In progress: soonest first → Overdue, Today, Tomorrow, This week, This
  // month, Next month, Later, No deadline.
  function bucketInProgress(date, now) {
    if (!date) return { order: 999, key: 'nodue', label: grp('grpNoDeadline') };
    const t0 = startOfDay(now), d0 = startOfDay(date);
    const diff = Math.round((d0 - t0) / DAY_MS);
    if (diff < 0) return { order: -1, key: 'overdue', label: I18n.tr('dashboard.overdue') };
    if (diff === 0) return { order: 0, key: 'today', label: `${grp('grpToday')} · ${fmtDay(d0)}` };
    if (diff === 1) return { order: 1, key: 'tomorrow', label: `${grp('grpTomorrow')} · ${fmtDay(d0)}` };
    if (startOfWeek(date).getTime() === startOfWeek(now).getTime()) return { order: 2, key: 'thisweek', label: grp('grpThisWeek') };
    if (startOfWeek(date).getTime() === addDays(startOfWeek(now), 7).getTime()) return { order: 3, key: 'nextweek', label: grp('grpNextWeek') };
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return { order: 4, key: 'thismonth', label: grp('grpThisMonth') };
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    if (date.getFullYear() === nm.getFullYear() && date.getMonth() === nm.getMonth()) return { order: 5, key: 'nextmonth', label: grp('grpNextMonth') };
    return { order: 6, key: 'later', label: grp('grpLater') };
  }

  // Meetings: soonest first → Today, Tomorrow, This week, This month, Next month,
  // Later, then Past, then Not scheduled.
  function bucketMeetings(date, now) {
    if (!date) return { order: 9000, key: 'unscheduled', label: I18n.tr('dashboard.notScheduled') };
    const t0 = startOfDay(now), d0 = startOfDay(date);
    const diff = Math.round((d0 - t0) / DAY_MS);
    if (diff < 0) return { order: 8000, key: 'past', label: grp('grpPast') };
    if (diff === 0) return { order: 0, key: 'today', label: `${grp('grpToday')} · ${fmtDay(d0)}` };
    if (diff === 1) return { order: 1, key: 'tomorrow', label: `${grp('grpTomorrow')} · ${fmtDay(d0)}` };
    if (startOfWeek(date).getTime() === startOfWeek(now).getTime()) return { order: 2, key: 'thisweek', label: grp('grpThisWeek') };
    if (startOfWeek(date).getTime() === addDays(startOfWeek(now), 7).getTime()) return { order: 3, key: 'nextweek', label: grp('grpNextWeek') };
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return { order: 4, key: 'thismonth', label: grp('grpThisMonth') };
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    if (date.getFullYear() === nm.getFullYear() && date.getMonth() === nm.getMonth()) return { order: 5, key: 'nextmonth', label: grp('grpNextMonth') };
    return { order: 6, key: 'later', label: grp('grpLater') };
  }

  function groupItems(items) {
    const now = new Date();
    const map = new Map();
    for (const it of items) {
      const ds = itemDate(it);
      const date = ds ? new Date(ds) : null;
      // Finished contributed docs surface in the Tasks tab — group them together
      // under "Completed" (after the in-progress buckets) rather than "No deadline".
      const b = (mode === 'tasks' && it._ready)
        ? { order: 9500, key: 'ready', label: I18n.tr('dashboard.toggleCompleted') }
        : mode === 'completed' ? bucketCompleted(date, now)
        : mode === 'meetings' ? bucketMeetings(date, now)
        : bucketInProgress(date, now); // upcoming | tasks
      if (!map.has(b.key)) map.set(b.key, { order: b.order, label: b.label, items: [] });
      map.get(b.key).items.push(it);
    }
    const groups = [...map.values()].sort((a, b) => a.order - b.order);
    const far = 8640000000000000;
    for (const g of groups) {
      g.items.sort((a, b) => {
        if (mode === 'completed' || (mode === 'tasks' && g.key === 'ready')) {
          return new Date(b.endedAt || 0) - new Date(a.endedAt || 0);
        }
        if (mode === 'meetings') {
          // Past meetings most-recent-first; everything else soonest-first.
          const av = a.eventDateTime ? new Date(a.eventDateTime).getTime() : far;
          const bv = b.eventDateTime ? new Date(b.eventDateTime).getTime() : far;
          return g.key === 'past' ? bv - av : av - bv;
        }
        return new Date(a.deadlineDate || far) - new Date(b.deadlineDate || far);
      });
    }
    return groups;
  }

  function renderList() {
    updateTabDots();
    const items = getFiltered();
    if (items.length === 0) {
      const emptyKey = { completed: 'dashboard.noCompleted', upcoming: 'dashboard.noUpcoming',
        meetings: 'dashboard.noMeetings', tasks: 'dashboard.noTasks' }[mode] || 'dashboard.noUpcoming';
      listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr(emptyKey))}</p></div>`;
      return;
    }
    listEl.innerHTML = groupItems(items).map(g => `
      <div class="mn-group"><span class="mn-group__label">${escapeHtml(g.label)}</span></div>
      ${g.items.map(listCardHtml).join('')}
    `).join('');

    // Clicking a card toggles its inline-expanded detail (accordion). Clicks
    // inside an already-expanded card's detail don't collapse it.
    listEl.querySelectorAll('.mn-card[data-event-id]').forEach(card => {
      const toggle = (e) => {
        if (e.target.closest('.mn-card__detail') || e.target.closest('.mn-card__close')) return;
        const id = card.dataset.eventId;
        select(String(id) === selectedId ? null : id);
      };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (e) => {
        // Only act on the card itself, not on controls inside an expanded card.
        if (e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      });
    });

    // Expand the selected card in place: mark it, add a close button (top-right)
    // and a detail host, then fill it.
    if (selectedId) {
      const card = listEl.querySelector(`.mn-card[data-event-id="${selectedId}"]`);
      const item = itemById(selectedId);
      if (card && item) {
        card.classList.add('is-expanded');
        // Expanded, the card is a container holding real buttons — drop the
        // button role/tabindex (an interactive element must not nest buttons)
        // and let the close button + inner controls carry the interaction.
        card.setAttribute('aria-expanded', 'true');
        card.removeAttribute('role');
        card.removeAttribute('tabindex');
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'mn-card__close';
        closeBtn.setAttribute('aria-label', I18n.tr('common.close') || 'Close');
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); select(null); });
        card.appendChild(closeBtn);
        const host = document.createElement('div');
        host.className = 'mn-card__detail';
        card.appendChild(host);
        fillCardDetail(item, host);
      }
    }
  }

  // ── Detail panel (right of the calendar): the expanded chosen event ─────────
  const ICON_CLIP = '<svg class="mn-file__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49"/></svg>';
  const ICON_DL = '<svg class="mn-file__dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
  const ICON_CHEVRON = '<svg class="mn-prog__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';


  // Load + render attachments inline: creation-time event files plus any
  // section files. Event files download via /api/events/:id/files/:fid;
  // section files via the workflow files endpoint (downloadFileAuth).
  async function loadAttachments(eventId, container) {
    const [evRes, secRes] = await Promise.allSettled([
      Api.get(`/api/events/${eventId}/files`),
      Api.get(`/api/library/${eventId}/files`),
    ]);
    if (!container.isConnected || String(selectedId) !== String(eventId)) return;
    const files = [];
    // Event files are added by the event creator (or admin/protocol).
    if (evRes.status === 'fulfilled') (evRes.value || []).forEach(f =>
      files.push({ kind: 'event', id: f.id, name: f.original_name, size: f.size,
        source: I18n.tr('dashboard.addedByCreator') }));
    // Section files are added during the workflow — credit the uploader's department.
    if (secRes.status === 'fulfilled') (secRes.value || []).forEach(f => {
      const dept = localizedName(f.uploader_dept_en, f.uploader_dept);
      files.push({ kind: 'section', id: f.id, name: f.original_name, size: f.size,
        source: dept || f.uploaded_by_name || '' });
    });
    if (files.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <h4 class="mn-files__title">${escapeHtml(I18n.tr('dashboard.attachments'))}</h4>
      <ul class="mn-files">
        ${files.map((f, i) => `
          <li class="mn-file" data-i="${i}" role="button" tabindex="0" aria-label="${escapeHtml(f.name)}">
            ${ICON_CLIP}
            <span class="mn-file__info">
              <span class="mn-file__name">${escapeHtml(f.name)}</span>
              ${f.source ? `<span class="mn-file__src">${escapeHtml(f.source)}</span>` : ''}
            </span>
            <span class="mn-file__size">${f.size ? (f.size / 1024).toFixed(1) + ' KB' : ''}</span>
            ${ICON_DL}
          </li>`).join('')}
      </ul>
    `;
    container.querySelectorAll('.mn-file').forEach((li, i) => {
      const f = files[i];
      const download = () => {
        if (f.kind === 'event') downloadEventFileAuth(eventId, f.id, f.name);
        else downloadFileAuth(f.id, f.name);
      };
      li.addEventListener('click', download);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); download(); }
      });
    });
  }

  // Fill an expanded card's inline detail host with the chosen event's body
  // (meta, actions, progress/brief, attachments). No title/flag header — the
  // card summary above it already shows those; the card itself collapses on click.
  function fillCardDetail(item, detailEl) {
    if (!item || !detailEl) return;

    if (item._ready) {
      detailEl.innerHTML = `
        <div class="mn-detail__panel">
          <h4 class="mn-files__title">${escapeHtml(I18n.tr('dashboard.mainDocument'))}</h4>
          <div class="mn-card-actions">
            <button class="mn-pillbtn" data-act="preview">${ICON_EYE}<span>${escapeHtml(I18n.tr('library.btn.preview'))}</span></button>
            <button class="mn-pillbtn" data-act="pdf">${ICON_DOWNLOAD}<span>${escapeHtml(I18n.tr('library.btn.pdf'))}</span></button>
            <button class="mn-pillbtn" data-act="word">${ICON_DOWNLOAD}<span>${escapeHtml(I18n.tr('library.btn.word'))}</span></button>
          </div>
          <div class="mn-files-wrap" id="mnFiles"></div>
        </div>
        <div class="mn-hist-wrap" id="mnHistory"></div>
      `;
      detailEl.querySelector('[data-act="preview"]').addEventListener('click', () => LibraryDoc.preview(item.id));
      detailEl.querySelector('[data-act="pdf"]').addEventListener('click', () => LibraryDoc.exportPdf(item.id));
      detailEl.querySelector('[data-act="word"]').addEventListener('click', () => LibraryDoc.exportWord(item.id));
      loadAttachments(item.id, detailEl.querySelector('#mnFiles'));
      loadReadyHistory(item.id, detailEl.querySelector('#mnHistory'));
      return;
    }

    // In progress: a top row with the document progress bar (left) + actions
    // (right) on one line, then the sections list and attachments below.
    detailEl.innerHTML = `
      <div class="mn-detail__panel">
        <div class="mn-detail__topbar">
          <div class="mn-detail__progslot" id="mnProgBar"></div>
          <div class="mn-card-actions">
            <button class="mn-pillbtn mn-detail__preview" data-act="preview">${ICON_EYE}<span>${escapeHtml(I18n.tr('library.btn.preview'))}</span></button>
            ${canEdit ? `<button class="mn-pillbtn" data-act="editor">${ICON_EDIT}<span>${escapeHtml(I18n.tr('dashboard.openInEditor'))}</span></button>` : ''}
          </div>
        </div>
        <div class="mn-prog__summary" id="mnProgSummary"></div>
        <div class="mn-progress" id="mnProgress"></div>
        <div class="mn-files-wrap" id="mnFiles"></div>
      </div>
    `;
    detailEl.querySelector('[data-act="preview"]').addEventListener('click', () => previewInProgress(item));
    if (canEdit) detailEl.querySelector('[data-act="editor"]').addEventListener('click', () => {
      window.location.href = `editor-all.html?event_id=${item.id}`;
    });
    loadProgress(item.id, detailEl.querySelector('#mnProgress'));
    loadAttachments(item.id, detailEl.querySelector('#mnFiles'));
  }

  // Limit an event's sections to the ones this user is involved in — mirrors the
  // previous dashboard (dashboard-pipeline.js): the document owner / responsible
  // deputy see all; everyone else sees only sections their department is assigned
  // to, their RECEIVING_* chain step, or sections they curate. The Minister is
  // always the document submitter on their events, so they see the whole document.
  // Section visibility is shared with the ready-document preview — the single
  // source of truth lives in section-history-view.js (SectionVisibility). These
  // thin wrappers bind it to this page's `user` so all call sites stay unchanged.
  function isOwnSection(s) { return SectionVisibility.isOwnSection(user, s); }
  function seesAllSections(grid) { return SectionVisibility.seesAllSections(user, grid); }
  function visibleSectionsFor(grid) { return SectionVisibility.visibleSectionsFor(user, grid); }

  // Build the all-sections preview for an in-progress event from live workflow
  // content (the library /document endpoint only serves published events).
  async function previewInProgress(item) {
    try {
      const grid = await Api.get(`/api/workflow/status-grid?event_id=${item.id}`);
      const secs = visibleSectionsFor(grid);
      const sections = await Promise.all(secs.map(s =>
        Api.get(`/api/workflow/section-content?event_id=${item.id}&section_id=${s.sectionId}`)
          .then(c => ({ title: s.sectionLabel, html: c.htmlContent }))
          .catch(() => ({ title: s.sectionLabel, html: '' }))
      ));
      const country = localizedCountryName({ code: item.countryCode, name_en: item.countryName });
      openPreviewOverlay(item.title, country, sections);
    } catch (e) {
      toast.error(I18n.tr('library.preview.failLoad') + ' ' + e.message);
    }
  }

  // Render a full-screen all-sections preview overlay (accepted/clean view),
  // mirroring LibraryDoc.preview's markup so it looks identical.
  function openPreviewOverlay(title, subtitle, sections) {
    const overlay = document.createElement('div');
    overlay.className = 'preview-overlay';
    overlay.innerHTML = `
      <div class="preview-card">
        <div class="preview-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="preview-close">&times;</button>
        </div>
        ${subtitle ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">${escapeHtml(subtitle)}</div>` : ''}
        ${sections.map(s => `
          <div class="section-block">
            <h3>${escapeHtml(s.title)}</h3>
            <div class="section-content-preview">${LibraryDoc.stripTrackChanges(s.html || '<em>No content</em>')}</div>
          </div>`).join('')}
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.preview-close').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    // Accepted view: hide deletions, neutralize insertions.
    overlay.querySelectorAll('.section-content-preview del').forEach(el => el.style.display = 'none');
    overlay.querySelectorAll('.section-content-preview ins').forEach(el => {
      el.style.textDecoration = 'none'; el.style.backgroundColor = 'transparent'; el.style.color = 'inherit';
    });
  }

  // Ready-card "who acted" history: one collapsible per section the viewer may
  // see (same visibility rule as everywhere else — collaborators get their own
  // sections, deputies/owner/linked-supervisors get all). Each section's timeline
  // lazy-loads the first time its dropdown is opened.
  async function loadReadyHistory(eventId, host) {
    if (!host) return;
    let grid;
    try {
      grid = await Api.get(`/api/workflow/status-grid?event_id=${eventId}`);
    } catch (_) { return; } // best-effort — no history panel if the grid can't load
    const sections = visibleSectionsFor(grid);
    if (!sections.length) return;
    host.innerHTML = `
      <div class="mn-detail__panel">
        <h4 class="mn-files__title">${escapeHtml(I18n.tr('library.history.title'))}</h4>
        ${sections.map(s => `
          <details class="mn-shist" data-section-id="${s.sectionId}">
            <summary>${escapeHtml(s.sectionLabel)}</summary>
            <div class="mn-shist__body"></div>
          </details>`).join('')}
      </div>
    `;
    const emptyHtml = `<p style="color: var(--text-muted); font-size: 13px;">${escapeHtml(I18n.tr('editor.history.empty'))}</p>`;
    host.querySelectorAll('details.mn-shist').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = '1';
        const body = det.querySelector('.mn-shist__body');
        try {
          const res = await Api.get(`/api/workflow/section-history?event_id=${eventId}&section_id=${det.dataset.sectionId}`);
          const history = res.history || res;
          body.innerHTML = (history && history.length) ? SectionHistory.renderTimeline(history) : emptyHtml;
        } catch (e) {
          det.dataset.loaded = ''; // allow a retry on next open
          body.innerHTML = emptyHtml;
        }
      });
    });
  }

  // Show how far the document has moved through the approval chain. Per section,
  // currentHolderRole === null means fully approved; otherwise its index in the
  // section's chain is how many stages have been passed.
  async function loadProgress(eventId, container) {
    let grid;
    try {
      grid = await Api.get(`/api/workflow/status-grid?event_id=${eventId}`);
    } catch (e) {
      if (container.isConnected && String(selectedId) === String(eventId)) container.innerHTML = '';
      return;
    }
    if (!container.isConnected || String(selectedId) !== String(eventId)) return;
    const sections = visibleSectionsFor(grid);
    if (!sections.length) { container.innerHTML = ''; return; }

    const rows = sections.map(s => {
      const chain = Array.isArray(s.chain) ? s.chain : [];
      const total = chain.length || 1;
      const holder = s.currentHolderRole;
      const done = !holder;
      const idx = done ? total : chain.indexOf(holder);
      const passed = Math.min(Math.max(idx, 0), total);
      return {
        sectionId: s.sectionId,
        title: s.sectionLabel || '',
        chain, passed, total, done,
        pct: Math.round((passed / total) * 100),
        label: done ? I18n.tr('dashboard.stageApproved') : stageWithLabel(holder),
        raw: s,
      };
    });
    const overall = Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length);
    const approved = rows.filter(r => r.done).length;
    const summary = I18n.tr('dashboard.sectionsApproved')
      .replace('{done}', approved).replace('{total}', rows.length);

    const progRowHtml = (r) => {
      const actionsHtml = canEdit ? renderSectionActions(r.raw, eventId) : '';
      const steps = Array.isArray(r.raw.steps) ? r.raw.steps : [];
      const dots = r.chain.map((role, i) => {
        // A stage behind the holder that nobody acted on was skipped (bypassed
        // via a push) → faded; otherwise passed (green) / current (blue) / pending.
        const st = i < r.passed
          ? ((steps[i] && steps[i].acted) ? 'is-passed' : 'is-skipped')
          : (i === r.passed && !r.done ? 'is-current' : 'is-pending');
        return `<button type="button" class="mn-prog__step ${st}" data-stage-role="${escapeHtml(role)}" data-stage-idx="${i}" title="${escapeHtml(roleLabel(role))}" aria-label="${escapeHtml(roleLabel(role))}"><span class="mn-prog__dot ${st}"><span class="mn-prog__num">${i + 1}</span></span><span class="mn-prog__steplabel">${escapeHtml(roleLabel(role))}</span></button>`;
      }).join('');
      return `
        <li class="mn-prog__item ${r.done ? 'is-done' : ''}" data-section-id="${r.sectionId}">
          <div class="mn-prog__row">
            <div class="mn-prog__rowmain">
              <div class="mn-prog__titlerow">
                ${sectionIsMyTurn(r.raw) ? `<span class="mn-prog__attn" role="img" aria-label="${escapeHtml(I18n.tr('dashboard.yourTurn'))}"></span>` : ''}
                <span class="mn-prog__title">${escapeHtml(r.title)}</span>
              </div>
              ${actionsHtml ? `<div class="mn-prog__actionrow">${actionsHtml}</div>` : ''}
            </div>
            <div class="mn-prog__status">
              <span class="mn-prog__now ${r.done ? 'is-done' : 'is-active'}">${escapeHtml(r.label)}</span>
              <div class="mn-prog__steps">
                ${dots}
                <span class="mn-prog__expand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
              </div>
            </div>
          </div>
          <div class="mn-stage-detail" hidden></div>
        </li>`;
    };

    // Sections the user is responsible for show directly; the rest stay behind
    // the dropdown.
    const ownRows = rows.filter(r => isOwnSection(r.raw));
    const otherRows = rows.filter(r => !isOwnSection(r.raw));
    const otherLabel = ownRows.length ? 'dashboard.otherSections' : 'dashboard.sections';

    // The total document progress only makes sense to viewers who see every
    // section; for users limited to their own sections it would report a
    // misleading partial total, so hide it for them.
    const seesAll = seesAllSections(grid);
    // Likewise, "Open in editor" opens the whole-document editor — only offer it
    // to viewers who see all sections (others use the per-section edit links).
    const panel = container.closest('.mn-detail__panel');
    if (!seesAll) {
      const editBtn = panel?.querySelector('[data-act="editor"]');
      if (editBtn) editBtn.remove();
    }
    // The total document progress bar sits in the top row (beside the action
    // buttons); the sections list goes in this container below it.
    const barSlot = panel?.querySelector('#mnProgBar');
    if (barSlot) {
      barSlot.innerHTML = seesAll ? `
        <div class="mn-prog__barwrap">
          <span class="mn-prog__label">${escapeHtml(I18n.tr('dashboard.progress'))}</span>
          <div class="mn-prog__bar"><span style="width:${overall}%"></span></div>
          <span class="mn-prog__pct">${overall}%</span>
        </div>` : '';
    }
    const summarySlot = panel?.querySelector('#mnProgSummary');
    if (summarySlot) summarySlot.textContent = seesAll ? summary : '';
    container.innerHTML = `
      <div class="mn-prog">
        ${ownRows.length ? `
          ${otherRows.length ? `<div class="mn-prog__grouplabel">${escapeHtml(I18n.tr('dashboard.yourSections'))}</div>` : ''}
          <ul class="mn-prog__list mn-prog__list--own">${ownRows.map(progRowHtml).join('')}</ul>
        ` : ''}
        ${otherRows.length ? `
          <button type="button" class="mn-prog__toggle" id="mnProgToggle" aria-expanded="false">
            <span>${escapeHtml(I18n.tr(otherLabel))} (${otherRows.length})</span>
            ${ICON_CHEVRON}
          </button>
          <ul class="mn-prog__list" id="mnProgList" hidden>${otherRows.map(progRowHtml).join('')}</ul>
        ` : ''}
      </div>
    `;
    const toggle = container.querySelector('#mnProgToggle');
    const list = container.querySelector('#mnProgList');
    if (toggle && list) {
      toggle.addEventListener('click', () => {
        const open = list.hasAttribute('hidden');
        if (open) list.removeAttribute('hidden'); else list.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }
    if (canEdit) bindSectionActions(container, eventId);
    bindStageDots(container, eventId, new Map(rows.map(r => [String(r.sectionId), r])));
  }

  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // Clicking a chain step expands a card showing the stepper (moved inside) plus
  // that stage's role + who's responsible (and who acted). A × button collapses.
  function bindStageDots(container, eventId, rowsBySection) {
    container.querySelectorAll('.mn-prog__item').forEach(item => {
      const sectionId = item.dataset.sectionId;
      const detail = item.querySelector('.mn-stage-detail');
      const statusBox = item.querySelector('.mn-prog__status');  // label + dots container
      const steps = item.querySelector('.mn-prog__steps');
      const row = rowsBySection.get(String(sectionId));

      const collapse = () => {
        item.classList.remove('is-expanded');
        item.querySelectorAll('.mn-prog__step.is-open').forEach(d => d.classList.remove('is-open'));
        if (steps.parentElement !== statusBox) statusBox.appendChild(steps); // dots back into the pill
        detail.hidden = true; detail.innerHTML = '';
      };

      const openStep = async (stepBtn) => {
        item.querySelectorAll('.mn-prog__step.is-open').forEach(d => d.classList.remove('is-open'));
        stepBtn.classList.add('is-open');
        if (!item.classList.contains('is-expanded')) {
          item.classList.add('is-expanded');
          detail.hidden = false;
          detail.innerHTML = `
            <div class="mn-stage">
              <button type="button" class="mn-stage__close" aria-label="${escapeHtml(I18n.tr('common.close'))}">${ICON_X}</button>
              <div class="mn-stage__stepper"></div>
              <div class="mn-stage__body"></div>
            </div>`;
          const stepperEl = detail.querySelector('.mn-stage__stepper');
          stepperEl.appendChild(steps); // move the numbered steps into the card
          // Progress bar: one segment per stage, coloured to match the dot above it
          // (green = passed, orange = current, faded = skipped, grey = pending).
          const trackChain = row && Array.isArray(row.chain) ? row.chain : [];
          const trackSteps = row && Array.isArray(row.raw.steps) ? row.raw.steps : [];
          const segs = trackChain.map((role, i) => {
            const cls = i < row.passed
              ? ((trackSteps[i] && trackSteps[i].acted) ? 'is-passed' : 'is-skipped')
              : (i === row.passed && !row.done ? 'is-current' : 'is-pending');
            return `<span class="mn-prog__seg ${cls}"></span>`;
          }).join('');
          const track = document.createElement('div');
          track.className = 'mn-prog__track';
          track.innerHTML = segs;
          stepperEl.appendChild(track);
          detail.querySelector('.mn-stage__close').addEventListener('click', (e) => {
            // Stop the click reaching the event-card toggle: collapse() clears this
            // detail node, detaching the ×, which would otherwise defeat the card's
            // .mn-card__detail guard and collapse the whole card.
            e.stopPropagation();
            collapse();
          });
        }
        const role = stepBtn.dataset.stageRole;
        const idx = parseInt(stepBtn.dataset.stageIdx, 10);
        const step = row && Array.isArray(row.raw.steps) ? row.raw.steps[idx] : null;
        const state = row
          ? (idx < row.passed ? 'passed' : (idx === row.passed && !row.done ? 'current' : 'pending'))
          : 'pending';
        const body = detail.querySelector('.mn-stage__body');
        body.innerHTML = `<div class="mn-stage__loading">${escapeHtml(I18n.tr('dashboard.loading'))}</div>`;
        try {
          const data = await stageUsers(eventId, sectionId, role);
          if (stepBtn.classList.contains('is-open')) body.innerHTML = renderStageBody(role, data, step, state);
        } catch (err) {
          body.innerHTML = `<div class="mn-stage__empty">${escapeHtml(err.message)}</div>`;
        }
      };

      item.querySelectorAll('.mn-prog__step').forEach(stepBtn => {
        stepBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (stepBtn.classList.contains('is-open')) collapse();
          else openStep(stepBtn);
        });
      });

      // Clicking the collapsed pill (label / empty area / chevron, but not a
      // specific dot) opens the current stage — the whole container is one control.
      statusBox.addEventListener('click', (e) => {
        if (e.target.closest('.mn-prog__step')) return;   // a dot handles itself
        if (item.classList.contains('is-expanded')) return;
        const all = [...steps.querySelectorAll('.mn-prog__step')];
        const cur = all.find(s => s.querySelector('.mn-prog__dot.is-current'))
          || [...all].reverse().find(s => s.querySelector('.mn-prog__dot.is-passed'))
          || all[0];
        if (cur) openStep(cur);
      });
    });
  }

  // Eligible users for (event, section, role) — cached; role membership is static.
  const _stageUsersCache = new Map();
  async function stageUsers(eventId, sectionId, role) {
    const key = `${eventId}:${sectionId}:${role}`;
    if (!_stageUsersCache.has(key)) {
      _stageUsersCache.set(key, Api.get(
        `/api/workflow/stage-users?event_id=${eventId}&section_id=${sectionId}&role=${encodeURIComponent(role)}`
      ).catch(err => { _stageUsersCache.delete(key); throw err; }));
    }
    return _stageUsersCache.get(key);
  }

  // Initials for an avatar (first letters of up to two name parts).
  function initials(name) {
    return (name || '').trim().split(/\s+/).slice(0, 2)
      .map(s => (s[0] || '').toUpperCase()).join('') || '•';
  }
  // Stable, joyful per-name colour for the avatar.
  function avatarStyle(name) {
    let h = 0;
    for (const ch of (name || '')) h = (h + ch.charCodeAt(0) * 7) % 360;
    return `background:hsl(${h},62%,90%);color:hsl(${h},48%,34%);`;
  }

  // Inner content of the expanded card's body (the card shell + stepper live in
  // bindStageDots). Returns the status header + the stage's people.
  function renderStageBody(role, data, step, state) {
    const users = (data && data.users) || [];
    const actedId = step && step.acted ? step.actorId : null;
    const statusKey = state === 'passed' ? 'dashboard.stageApproved'
      : state === 'current' ? 'dashboard.stageAwaiting' : 'dashboard.stagePending';
    // Header: stage role title (left) + a colour-coded status pill (right).
    const head = `
      <div class="mn-stage__head">
        <span class="mn-stage__role">${escapeHtml(roleLabel(role))}</span>
        <span class="mn-stage__status is-${state}"><span class="mn-stage__statusdot"></span>${escapeHtml(I18n.tr(statusKey))}</span>
      </div>`;
    const personRow = (name, dept, acted) => `
      <div class="mn-stage__person ${acted ? 'is-acted' : ''}">
        <span class="mn-stage__avatar" style="${avatarStyle(name)}">${escapeHtml(initials(name))}</span>
        <span class="mn-stage__pinfo">
          <span class="mn-stage__name">${escapeHtml(name)}</span>
          ${dept ? `<span class="mn-stage__dept">${escapeHtml(dept)}</span>` : ''}
        </span>
        ${acted ? `<span class="mn-stage__acted">✓ ${escapeHtml(I18n.tr('dashboard.acted'))}</span>` : ''}
      </div>`;

    let people;
    if (!users.length) {
      people = (step && step.acted && step.actorName)
        ? `<div class="mn-stage__people">${personRow(localizedName(step.actorName, step.actorNameKa), step.departmentName, true)}</div>`
        : `<div class="mn-stage__empty">${escapeHtml(I18n.tr('dashboard.noEligibleUsers'))}</div>`;
    } else {
      // Only show a count when there are multiple (a curator stage is always one).
      const subhead = `<div class="mn-stage__subhead">${escapeHtml(I18n.tr('dashboard.responsible'))}${users.length > 1 ? ` · ${users.length}` : ''}</div>`;
      people = `<div class="mn-stage__people">${subhead}${users.map(u =>
        personRow(localizedName(u.fullName, u.fullNameKa), u.departmentName, actedId === u.id)).join('')}</div>`;
    }
    return head + people;
  }

  // ── Quick section actions (ported from dashboard-pipeline.js) ───────────────
  const ACT_ICONS = {
    submit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    approve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    return: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    push: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
    pull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
  };
  function actBtn(action, labelKey, icon, cls) {
    return `<button type="button" class="mn-actbtn ${cls}" data-action="${action}">${icon}<span>${escapeHtml(I18n.tr(labelKey))}</span></button>`;
  }

  // It's the user's turn on a section when they hold it with a pending action
  // (Submit a draft/returned section, or Approve one submitted to them) — the same
  // condition that surfaces the Submit/Approve buttons. Drives the section red dot.
  function sectionIsMyTurn(s) {
    if (!canEdit || !s) return false;
    const effRole = s.userEffectiveRole || user.role;
    if (effRole !== s.currentHolderRole) return false;
    const status = s.status || 'draft';
    return status === 'draft' || status.startsWith('returned_') || status === `submitted_to_${effRole.toLowerCase()}`;
  }

  // Which quick buttons a section offers the current user — same per-status logic
  // as the old pipeline dashboard. The server re-enforces every action.
  function renderSectionActions(s, eventId) {
    const effRole = s.userEffectiveRole || user.role;
    const holder = s.currentHolderRole;
    const isHolder = effRole === holder;
    const status = s.status || 'draft';
    // A linked supervisor can view other departments' sections (seesAllSections) but must
    // not act on them — preview only, same as deputies. A supervisor's real holdings are
    // always their own section (department match or a RECEIVING_ step); effectiveRole
    // otherwise falls back to SUPERVISOR for a cross-dept section and would falsely make
    // them look like the holder, offering Approve/Return/Open. So: no buttons off-section.
    if (user.role === 'SUPERVISOR' && !isOwnSection(s)) return '';
    const btns = [];
    // Open — navigates to the single-section editor. Deputies can view every section
    // (seesAllSections) but must not edit ones that aren't theirs, so they only get Open
    // on their own/curated sections or one that's currently their turn; they preview the
    // rest. Other roles keep the always-on Open.
    if (user.role !== 'DEPUTY' || isOwnSection(s) || isHolder) {
      btns.push(`<a class="mn-actbtn is-open" href="editor.html?event_id=${eventId}&section_id=${s.sectionId}">${ICON_EDIT}<span>${escapeHtml(I18n.tr('dashboard.actionOpen'))}</span></a>`);
    }
    if (isHolder) {
      if (status === 'draft' || status.startsWith('returned_')) {
        btns.push(actBtn('submit', 'dashboard.actionSubmit', ACT_ICONS.submit, 'is-submit'));
      }
      if (status === `submitted_to_${effRole.toLowerCase()}`) {
        btns.push(actBtn('approve', 'dashboard.actionApprove', ACT_ICONS.approve, 'is-approve'));
        if (status !== 'submitted_to_amending_ds') {
          btns.push(actBtn('return', 'dashboard.actionReturn', ACT_ICONS.return, 'is-return'));
        }
      }
    } else if (status !== 'draft' && status) {
      const chain = s.chain || [];
      const userIdx = chain.indexOf(effRole);
      const holderIdx = chain.indexOf(holder);
      if (userIdx !== -1 && holderIdx !== -1) {
        if (holderIdx > userIdx) {
          // Behind the holder → ask the holder to return it.
          btns.push(actBtn('ask-to-return', 'dashboard.actionAskReturn', ACT_ICONS.return, 'is-ask'));
        } else if (userIdx > holderIdx && holderIdx >= 1
                   && status === `submitted_to_${(holder || '').toLowerCase()}`) {
          // Ahead of the holder → return the section down to the collaborator.
          btns.push(actBtn('return', 'dashboard.actionReturn', ACT_ICONS.return, 'is-return'));
        }
      }
    }
    if (s.canPush) {
      // Super-Collaborator push hands to the curator; Supervisor push completes.
      const pushKey = effRole === 'SUPERVISOR' ? 'dashboard.pushToCompletion' : 'dashboard.pushToCurator';
      btns.push(actBtn('push-section', pushKey, ACT_ICONS.push, 'is-push'));
    }
    if (s.canPull) btns.push(actBtn('pull-section', 'editor.pullSection', ACT_ICONS.pull, 'is-pull'));
    if (!btns.length) return '';
    return `<div class="mn-prog__actions" data-section="${s.sectionId}" data-event="${eventId}">${btns.join('')}</div>`;
  }

  function bindSectionActions(container, eventId) {
    container.querySelectorAll('.mn-prog__actions [data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const wrap = btn.closest('.mn-prog__actions');
        const sectionId = parseInt(wrap.dataset.section, 10);
        const evId = parseInt(wrap.dataset.event, 10);
        const action = btn.dataset.action;
        try {
          if (action === 'submit') {
            if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmSubmit'), { confirmLabel: I18n.tr('common.submit'), confirmColor: '#3b82f6' })) return;
            await Api.post('/api/workflow/submit', { eventId: evId, sectionId });
          } else if (action === 'approve') {
            if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmApprove'), { confirmLabel: I18n.tr('common.approve'), confirmColor: '#16a34a' })) return;
            await Api.post('/api/workflow/approve', { eventId: evId, sectionId });
          } else if (action === 'return') {
            const comment = await GCP.ActionDialog.popoverPrompt(btn, I18n.tr('editor.returnTitle'), { placeholder: I18n.tr('editor.returnPlaceholderOptional'), confirmLabel: I18n.tr('common.return'), confirmColor: '#6d28d9' });
            if (comment === null) return;
            await Api.post('/api/workflow/return', { eventId: evId, sectionId, comment: comment || undefined });
          } else if (action === 'ask-to-return') {
            const note = await GCP.ActionDialog.popoverPrompt(btn, I18n.tr('editor.askReturnTitle'), { placeholder: I18n.tr('editor.askReturnPlaceholder'), confirmLabel: I18n.tr('editor.sendRequest'), confirmColor: '#a16207' });
            if (note === null) return;
            await Api.post('/api/workflow/ask-to-return', { eventId: evId, sectionId, note: note || undefined });
          } else if (action === 'push-section') {
            if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPush'), { confirmLabel: I18n.tr('editor.pushSection'), confirmColor: '#6d28d9' })) return;
            await Api.post('/api/workflow/push-section', { eventId: evId, sectionId });
          } else if (action === 'pull-section') {
            if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPull'), { confirmLabel: I18n.tr('editor.pullSection'), confirmColor: '#7c3aed' })) return;
            await Api.post('/api/workflow/pull-section', { eventId: evId, sectionId });
          }
          // Approve / push / pull change document-wide state (and can complete the
          // document) — a full reload guarantees the whole dashboard reflects the new
          // state (this also covers "refresh when the document is ready").
          if (action === 'approve' || action === 'push-section' || action === 'pull-section') {
            // Remember the open card so it re-expands after the reload.
            try { sessionStorage.setItem('mnReopenEvent', String(evId)); } catch (_) {}
            location.reload();
            return;
          }
          // Other actions (submit / return / ask-to-return): refresh the progress block
          // in place (the section list expands again).
          const list = container.querySelector('#mnProgList');
          const wasOpen = list && !list.hasAttribute('hidden');
          await loadProgress(evId, container);
          if (wasOpen) {
            const newList = container.querySelector('#mnProgList');
            const newToggle = container.querySelector('#mnProgToggle');
            if (newList) newList.removeAttribute('hidden');
            if (newToggle) newToggle.setAttribute('aria-expanded', 'true');
          }
          // Acting changed the turn state — refresh the card dot (re-renders the list
          // only if the my-turn / attention set actually changed).
          loadNotifications();
          loadMyTurn();
        } catch (err) {
          toast.error(err.message);
        }
      });
    });
  }

  // Georgian "with <role>" needs the adessive (-თან) form, not a hyphen suffix.
  function stageWithLabel(role) {
    if (isKa()) {
      const map = {
        COLLABORATOR: 'კოლაბორატორთან',
        SUPER_COLLABORATOR: 'სუპერ-კოლაბორატორთან',
        RECEIVING_SUPER_COLLABORATOR: 'სუპერ-კოლაბორატორთან',
        SUPERVISOR: 'ზედამხედველთან',
        RECEIVING_SUPERVISOR: 'ზედამხედველთან',
        CURATOR: 'კურატორთან',
        DEPUTY: 'მოადგილესთან',
        MINISTER: 'მინისტრთან',
      };
      if (map[role]) return map[role];
      const lbl = roleLabel(role);
      return (lbl.endsWith('ი') ? lbl.slice(0, -1) : lbl) + 'თან';
    }
    return I18n.tr('dashboard.stageWith').replace('{role}', roleLabel(role));
  }

  // Year/Month/Day of an instant in Tbilisi time — the same zone the event cards
  // display (fmtEventWhen). Keying the calendar off this (not the browser-local
  // date) keeps a marker on the same day its card shows for viewers outside
  // UTC+4; for Tbilisi browsers it is identical to the local date.
  function tbYmd(iso) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month, d: +p.day, key: `${p.year}-${p.month}-${p.day}` };
  }

  // ── Calendar (adapted from dashboard-pipeline.js renderMiniCalendar) ─────────
  function renderCalendar(date) {
    calendarDate = date;
    const year = date.getFullYear();
    const month = date.getMonth();
    const todayT = tbilisiParts(); // today's date in Tbilisi (for the "today" cue)

    // Owned event days: light blue while in preparation, GREEN once the document is
    // finished (owner roles). Every other (contributed) day is orange. The calendar
    // carries NO red — "your turn to act" shows on the cards/tabs, not here.
    const ownedPrep = new Set();  // owned, in-progress  → blue
    const ownedReady = new Set(); // owned, finished doc → green
    const otherLevel = new Map(); // day -> 'other'
    calendarItems().forEach(item => {
      const ds = calItemDate(item);
      if (!ds) return;
      const t = tbYmd(ds);
      if (t.y !== year || t.m !== month + 1) return;
      if (isOwned(item)) (item._ready ? ownedReady : ownedPrep).add(t.d);
      else otherLevel.set(t.d, 'other');
    });

    let monthLabel, dayNames;
    if (isKa()) {
      monthLabel = `${KA_MONTHS[month]} ${year}`;
      dayNames = KA_WEEK_SHORT.slice();
    } else {
      const calLocale = (typeof _dateLocale === 'function') ? _dateLocale() : 'en-GB';
      monthLabel = new Date(year, month, 1).toLocaleDateString(calLocale, { month: 'long', year: 'numeric' });
      const weekdayFmt = new Intl.DateTimeFormat(calLocale, { weekday: 'short' });
      dayNames = [];
      for (let i = 0; i < 7; i++) {
        dayNames.push(weekdayFmt.format(new Date(2024, 0, 1 + i)).toUpperCase());
      }
    }

    const firstDay = new Date(year, month, 1);
    let startDay = firstDay.getDay() - 1;
    if (startDay < 0) startDay = 6;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let daysHtml = dayNames.map(d => `<span class="dp-cal-grid__day-name">${d}</span>`).join('');
    for (let i = 0; i < startDay; i++) {
      daysHtml += '<span class="dp-cal-grid__day dp-cal-grid__day--empty"></span>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = +todayT.year === year && +todayT.month === month + 1 && +todayT.day === d;
      const owned = ownedPrep.has(d) || ownedReady.has(d);
      // Green only when the owned event(s) that day are all finished; an in-progress owned
      // meeting keeps the day blue (blue precedence).
      const ownedGreen = ownedReady.has(d) && !ownedPrep.has(d);
      const lvl = otherLevel.get(d);      // 'other' | undefined
      const other = !!lvl;
      const hasEvent = owned || other;
      let cls = 'dp-cal-grid__day';
      if (isToday) cls += ' dp-cal-grid__day--today';
      if (hasEvent) cls += ' dp-cal-grid__day--has-event';
      if (ownedGreen) cls += ' dp-cal-grid__day--owned-ready';
      // Hybrid calendar (Deputy/Supervisor): a day with both an owned meeting and an
      // other-event → two dots. Gated to hybrid roles so worker calendars, where a day
      // can also mix owned + non-owned upcoming items, keep their existing blue marker.
      let otherMarker = '';
      if (HYBRID_CAL && owned && other) otherMarker = 'has-event-both';
      // A day with only non-owned events (user isn't the document owner).
      else if (!owned && other) otherMarker = 'has-event-other';
      if (otherMarker) {
        // Non-owned days are orange (no red on the calendar).
        cls += ' dp-cal-grid__day--' + otherMarker + ' dp-cal-grid__day--lvl-' + lvl;
      }
      // Marked days are interactive (select the event): expose them as buttons so
      // keyboard/screen-reader users can reach them, with the full date as the name.
      let dayAttrs = '';
      if (hasEvent) {
        const label = longDate(new Date(year, month, d));
        dayAttrs = ` data-cal-date="${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}"`
          + ` role="button" tabindex="0" aria-label="${escapeHtml(label)}"`;
      }
      daysHtml += `<span class="${cls}"${dayAttrs}>${d}</span>`;
    }

    miniCalendarEl.innerHTML = `
      <div class="dp-cal-header">
        <button class="dp-cal-nav" id="calPrev" aria-label="${escapeHtml(I18n.tr('dashboard.prevMonth'))}"><span aria-hidden="true">&lsaquo;</span></button>
        <span class="dp-cal-header__title">${escapeHtml(monthLabel)}</span>
        <button class="dp-cal-nav" id="calNext" aria-label="${escapeHtml(I18n.tr('dashboard.nextMonth'))}"><span aria-hidden="true">&rsaquo;</span></button>
      </div>
      <div class="dp-cal-grid">${daysHtml}</div>
    `;

    document.getElementById('calPrev')?.addEventListener('click', () => renderCalendar(new Date(year, month - 1, 1)));
    document.getElementById('calNext')?.addEventListener('click', () => renderCalendar(new Date(year, month + 1, 1)));

    // Click (or Enter/Space) a marked date → select (expand) the first matching event.
    const selectByCalDate = (clicked) => {
      const match = calendarItems().find(item => {
        const ds = calItemDate(item);
        return ds && tbYmd(ds).key === clicked; // Tbilisi day, matching how days are marked
      });
      if (!match) return;
      if (HYBRID_CAL) {
        // The event may live on the other tab — revealEvent switches to it, opens the
        // card and scrolls to it. Keep the calendar on the month the user is viewing
        // (setMode otherwise resets it to the current month).
        const viewed = calendarDate;
        Promise.resolve(revealEvent(match.id)).then(() => renderCalendar(viewed));
      } else {
        select(match.id);
      }
    };
    miniCalendarEl.querySelectorAll('[data-cal-date]').forEach(day => {
      day.addEventListener('click', () => selectByCalDate(day.dataset.calDate));
      day.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectByCalDate(day.dataset.calDate); }
      });
    });
  }

  function renderAll() {
    // Render the calendar first so it always appears, even if a list render
    // hits an unexpected snag.
    renderCalendar(calendarDate);
    renderList();
  }

  // ── Wire controls ────────────────────────────────────────────────────────────
  function setMode(next) {
    if (!next || next === mode) return;
    mode = next;
    selectedId = null;
    toggleBtns.forEach(b => b.classList.toggle('is-active', b.dataset.mode === next));
    positionThumb();
    calendarDate = new Date(); // reset to current month on switch
    renderAll();
  }
  toggleBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  // Switch to the tab that holds the given event and expand it. Used by the
  // notifications panel so clicking a notification lands on the right event.
  // Re-fetch the completed (library) + active (events) lists. Called when a
  // notification points at an event that wasn't in the lists loaded at page open
  // (e.g. an older, already-read notification whose event has since changed).
  async function reloadData() {
    const [lib, ev] = await Promise.allSettled([Api.get('/api/library'), Api.get('/api/events')]);
    if (lib.status === 'fulfilled') completed = (lib.value || []).map(d => ({ ...d, _ready: true }));
    if (ev.status === 'fulfilled') upcoming = (ev.value || []).filter(e => e.isActive).map(d => ({ ...d, _ready: false }));
  }

  async function revealEvent(eventId) {
    const idStr = String(eventId);
    const find = () => {
      const inCompleted = completed.find(d => String(d.id) === idStr);
      return { inCompleted, item: inCompleted || upcoming.find(d => String(d.id) === idStr) };
    };
    let { inCompleted, item } = find();
    // Older (often already-read) notifications can reference events that aren't in
    // the lists loaded at page open — refresh once and retry before giving up.
    if (!item) {
      await reloadData();
      ({ inCompleted, item } = find());
    }
    if (!item) return false;
    let targetMode;
    if (isOwner) {
      if (isOwned(item)) targetMode = 'meetings';          // owned (ready or in prep)
      else if (!inCompleted) targetMode = 'tasks';         // active, contributing
      else {
        // A completed event they only contributed to isn't on the owner dashboard
        // lists — open its published document instead of doing nothing.
        if (typeof LibraryDoc !== 'undefined' && LibraryDoc.preview) LibraryDoc.preview(eventId);
        return true;
      }
    } else {
      targetMode = inCompleted ? 'completed' : 'upcoming';
    }
    setMode(targetMode);
    select(eventId);
    const card = listEl.querySelector('.mn-card.is-expanded');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  keywordEl.addEventListener('input', () => {
    selectedId = null;
    renderList();
  });

  renderAll();
  positionThumb();
  // After a section action (approve / push / pull) triggers a full reload, re-open the
  // card that was expanded so the user lands back where they were.
  try {
    const reopenId = sessionStorage.getItem('mnReopenEvent');
    if (reopenId) {
      sessionStorage.removeItem('mnReopenEvent');
      revealEvent(parseInt(reopenId, 10));
    }
  } catch (_) { /* ignore */ }
  // Re-position once fonts/layout settle (button widths depend on the label text).
  requestAnimationFrame(positionThumb);
  // rAF fires before the async Georgian web font finishes downloading, which changes the
  // button widths — re-measure when fonts are ready, and whenever a button resizes
  // (font load, i18n relabel, badge width) so the thumb always covers the active tab.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionThumb);
  if (window.ResizeObserver) {
    const thumbRO = new ResizeObserver(() => positionThumb());
    toggleBtns.forEach(b => thumbRO.observe(b));
  }

  // ── Notifications panel (injected below the hero) ───────────────────────────
  const NOTIF_ICON = {
    event_created: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    your_turn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    returned: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    completed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  };

  function notifMessage(n) {
    const m = n.meta || {};
    if (n.type === 'event_created') return I18n.tr('notif.eventCreated').replace('{event}', m.eventTitle || '');
    if (n.type === 'completed') return I18n.tr('notif.completed').replace('{event}', m.eventTitle || '');
    if (n.type === 'returned') return I18n.tr('notif.returned').replace('{section}', m.sectionTitle || '').replace('{event}', m.eventTitle || '');
    return I18n.tr('notif.yourTurn').replace('{section}', m.sectionTitle || '').replace('{event}', m.eventTitle || '');
  }
  function notifTimeAgo(iso) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return I18n.tr('notif.now');
    const mi = Math.floor(s / 60); if (mi < 60) return `${mi}m`;
    const h = Math.floor(mi / 60); if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  // The create button and the notification center live in the overview side
  // column (#mnSide), to the right of the calendar.
  const NOTIF_INLINE_LIMIT = 5;
  let notifPanel, notifListEl, notifBadgeEl, notifShowAllEl;
  let notifAll = [];
  function buildNotifPanel() {
    const side = document.getElementById('mnSide');
    if (!side) return;
    notifPanel = document.createElement('div');
    notifPanel.className = 'mn-notifs';
    notifPanel.hidden = true;
    notifPanel.innerHTML = `
      <div class="mn-notifs__head">
        <span class="mn-notifs__title">${escapeHtml(I18n.tr('notif.title'))}<span class="mn-notifs__badge" hidden></span></span>
        <button type="button" class="mn-notifs__showall" hidden></button>
      </div>
      <ul class="mn-notifs__list"></ul>`;
    side.appendChild(notifPanel);
    notifListEl = notifPanel.querySelector('.mn-notifs__list');
    notifBadgeEl = notifPanel.querySelector('.mn-notifs__badge');
    notifShowAllEl = notifPanel.querySelector('.mn-notifs__showall');
    notifShowAllEl.addEventListener('click', openNotifModal);
  }

  // Render notification rows into a <ul>, wiring the click behaviour (mark read →
  // reveal the event → refresh). `onAfterClick` lets the modal close itself.
  function renderNotifRows(ulEl, list, onAfterClick) {
    ulEl.innerHTML = list.map(n => `
      <li class="mn-notif ${n.isRead ? '' : 'is-unread'}" data-id="${n.id}" data-type="${n.type}" data-event="${n.eventId || ''}" data-section="${n.sectionId || ''}" role="button" tabindex="0">
        <span class="mn-notif__icon" aria-hidden="true">${NOTIF_ICON[n.type] || NOTIF_ICON.your_turn}</span>
        <span class="mn-notif__msg">${escapeHtml(notifMessage(n))}</span>
        <span class="mn-notif__time">${escapeHtml(notifTimeAgo(n.createdAt))}</span>
      </li>`).join('');
    ulEl.querySelectorAll('.mn-notif').forEach(li => {
      const open = async () => {
        try { await Api.post('/api/notifications/read', { id: parseInt(li.dataset.id, 10) }); } catch (_) { /* ignore */ }
        if (onAfterClick) onAfterClick();
        // Switch to the tab holding the event and select it (no jump to editor).
        // Works for read and unread alike; revealEvent refreshes + retries so an
        // older read notification still opens its event.
        if (li.dataset.event) await revealEvent(parseInt(li.dataset.event, 10));
        loadNotifications();
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  function renderNotifications(data) {
    if (!notifPanel) return;
    const list = (data && data.notifications) || [];
    notifAll = list;
    // Recompute the card attention dots (event needs the user's attention).
    // Only re-render the card list when the set actually changes, so the ~45s
    // poll doesn't disrupt an expanded card.
    const unreadList = list.filter(n => !n.isRead && n.eventId);
    const nextAct = new Set(unreadList.filter(n => n.type === 'your_turn' || n.type === 'returned').map(n => String(n.eventId)));
    const nextNew = new Set(unreadList.filter(n => n.type === 'event_created').map(n => String(n.eventId)));
    const nextReady = new Set(unreadList.filter(n => n.type === 'completed').map(n => String(n.eventId)));
    const setKey = (s) => [...s].sort().join(',');
    // Re-render when any category changes (a new→act transition keeps the union but flips
    // colours), so the tab/card/calendar signals stay in sync.
    const changed = setKey(nextAct) !== setKey(actEvents)
      || setKey(nextNew) !== setKey(newEventIds)
      || setKey(nextReady) !== setKey(readyEvents);
    actEvents = nextAct;
    newEventIds = nextNew;
    readyEvents = nextReady;
    // The calendar now colours other-event days by attention, so re-render it too (not just
    // the list). Calendar re-render doesn't disturb an expanded card (that lives in the list).
    if (changed) renderAll();
    if (!list.length) { notifPanel.hidden = true; return; }
    notifPanel.hidden = false;
    const unread = (data && data.unreadCount) || 0;
    notifBadgeEl.textContent = unread ? String(unread) : '';
    notifBadgeEl.hidden = !unread;
    // Colour the count by the most urgent pending category: red (act) → orange (new) →
    // green (ready) → base blue.
    notifBadgeEl.classList.remove('is-alert', 'is-new', 'is-ready');
    if (myTurnEvents.size || actEvents.size) notifBadgeEl.classList.add('is-alert');
    else if (newEventIds.size) notifBadgeEl.classList.add('is-new');
    else if (readyEvents.size) notifBadgeEl.classList.add('is-ready');
    renderNotifRows(notifListEl, list.slice(0, NOTIF_INLINE_LIMIT));
    // "Show all" opens the full list in a modal — always offer it while any
    // notifications exist (the panel itself is hidden when the list is empty).
    notifShowAllEl.hidden = false;
    notifShowAllEl.textContent = I18n.tr('notif.showAll').replace('{n}', String(list.length));
    // Keep an open modal in sync with the freshly polled list.
    if (notifModal && notifModal.style.display !== 'none') {
      renderNotifRows(notifModal.querySelector('.mn-notifs__list'), notifAll, hideNotifModal);
    }
  }

  // ── "Show all" popup listing every notification ─────────────────────────────
  let notifModal = null;
  function getNotifModal() {
    if (notifModal) return notifModal;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="modal-card mn-dash" style="max-width:520px;max-height:80vh;display:flex;flex-direction:column;">
        <div class="mn-notifs__head" style="margin-bottom:12px;">
          <h3 style="margin:0;">${escapeHtml(I18n.tr('notif.title'))}</h3>
        </div>
        <ul class="mn-notifs__list" style="flex:1;"></ul>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;">
          <button class="btn btn-outline" data-i18n="common.close">${escapeHtml(I18n.tr('common.close'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.btn-outline').addEventListener('click', hideNotifModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideNotifModal(); });
    notifModal = overlay;
    return overlay;
  }
  function hideNotifModal() { if (notifModal) notifModal.style.display = 'none'; }
  function openNotifModal() {
    const overlay = getNotifModal();
    renderNotifRows(overlay.querySelector('.mn-notifs__list'), notifAll, hideNotifModal);
    overlay.style.display = 'flex';
  }

  async function loadNotifications() {
    try { renderNotifications(await Api.get('/api/notifications')); } catch (_) { /* keep silent */ }
  }

  // Live "your turn" set — the authoritative red signal for cards/tabs. Re-render only
  // when it actually changes so the poll doesn't disturb an expanded card.
  async function loadMyTurn() {
    try {
      const data = await Api.get('/api/workflow/my-turn');
      const next = new Set((data && data.eventIds || []).map(String));
      const key = (s) => [...s].sort().join(',');
      if (key(next) !== key(myTurnEvents)) { myTurnEvents = next; renderAll(); }
    } catch (_) { /* keep silent */ }
  }

  // ── Create-event button (top of the side column) → opens the create popup ───
  function buildCreateButton() {
    if (!canCreateEvent || !window.EventCreate) return;
    const side = document.getElementById('mnSide');
    if (!side) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mn-createbtn';
    btn.innerHTML = `<span class="mn-createbtn__plus">＋</span><span>${escapeHtml(I18n.tr('dashboard.createEvent'))}</span>`;
    side.insertBefore(btn, side.firstChild);
    btn.addEventListener('click', () => {
      window.EventCreate.open({
        onCreated: async () => {
          // Refresh the in-preparation list and re-render.
          try {
            const ev = await Api.get('/api/events');
            upcoming = (ev || []).filter(e => e.isActive).map(d => ({ ...d, _ready: false }));
          } catch (_) { /* keep old list */ }
          renderAll();
        },
      });
    });
  }

  buildCreateButton();
  buildNotifPanel();
  loadNotifications();
  loadMyTurn();
  setInterval(() => { loadNotifications(); loadMyTurn(); }, 45000);
})();
