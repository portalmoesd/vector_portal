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
  const toggleThumb = document.getElementById('mnToggleThumb');

  // Mode set per role:
  //  - owner roles: 'meetings' (events they own, keyed by meeting date/time, with
  //    a readiness chip) and 'tasks' (events they only contribute to);
  //  - worker roles: 'completed' | 'upcoming' (unchanged).
  let mode = isOwner ? 'meetings' : 'completed';

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
  }
  let calendarDate = new Date();
  let selectedId = null;  // currently expanded event id (within the active mode)

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
    if (!toggleThumb) return;
    const active = toggleBtns.find(b => b.classList.contains('is-active'));
    if (!active) return;
    toggleThumb.style.left = active.offsetLeft + 'px';
    toggleThumb.style.width = active.offsetWidth + 'px';
  }
  window.addEventListener('resize', positionThumb);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isOwned(item) { return item.documentSubmitterId === user.id; }

  function activeItems() {
    switch (mode) {
      case 'completed': return completed;
      case 'upcoming': return upcoming;
      // Meetings = events they own (ready + in-preparation), unified.
      case 'meetings': return completed.filter(isOwned).concat(upcoming.filter(isOwned));
      // Tasks = in-progress events they contribute to but don't own.
      case 'tasks': return upcoming.filter(i => !isOwned(i));
      default: return [];
    }
  }

  // The date a calendar marker / grouping keys off, per mode.
  function itemDate(item) {
    if (mode === 'meetings') return item.eventDateTime;
    if (mode === 'completed') return item.endedAt;
    return item.deadlineDate; // upcoming | tasks
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
      meta = `${d.endedAt ? formatDate(d.endedAt) + ' · ' : ''}${escapeHtml(lang)}`;
    } else {
      const ex = excerptText(d.occasion);
      if (ex) excerpt = `<p class="mn-card__excerpt">${escapeHtml(ex)}</p>`;
      const due = dueInfo(d.deadlineDate);
      const dueHtml = due ? `<span class="${due.cls}">${escapeHtml(due.text)}</span> · ` : '';
      meta = `${dueHtml}${escapeHtml(lang)}`;
    }

    return `
      <div class="dp-upcoming-event mn-card ${statusClass}" data-event-id="${d.id}">
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
      const b = mode === 'completed' ? bucketCompleted(date, now)
        : mode === 'meetings' ? bucketMeetings(date, now)
        : bucketInProgress(date, now); // upcoming | tasks
      if (!map.has(b.key)) map.set(b.key, { order: b.order, label: b.label, items: [] });
      map.get(b.key).items.push(it);
    }
    const groups = [...map.values()].sort((a, b) => a.order - b.order);
    const far = 8640000000000000;
    for (const g of groups) {
      g.items.sort((a, b) => {
        if (mode === 'completed') return new Date(b.endedAt || 0) - new Date(a.endedAt || 0);
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
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mn-card__detail') || e.target.closest('.mn-card__close')) return;
        const id = card.dataset.eventId;
        select(String(id) === selectedId ? null : id);
      });
    });

    // Expand the selected card in place: mark it, add a close button (top-right)
    // and a detail host, then fill it.
    if (selectedId) {
      const card = listEl.querySelector(`.mn-card[data-event-id="${selectedId}"]`);
      const item = itemById(selectedId);
      if (card && item) {
        card.classList.add('is-expanded');
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
          <li class="mn-file" data-i="${i}">
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
      li.addEventListener('click', () => {
        if (f.kind === 'event') downloadEventFileAuth(eventId, f.id, f.name);
        else downloadFileAuth(f.id, f.name);
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
      `;
      detailEl.querySelector('[data-act="preview"]').addEventListener('click', () => LibraryDoc.preview(item.id));
      detailEl.querySelector('[data-act="pdf"]').addEventListener('click', () => LibraryDoc.exportPdf(item.id));
      detailEl.querySelector('[data-act="word"]').addEventListener('click', () => LibraryDoc.exportWord(item.id));
      loadAttachments(item.id, detailEl.querySelector('#mnFiles'));
      return;
    }

    // In progress: progress + brief + attachments (no published document yet).
    detailEl.innerHTML = `
      <div class="mn-detail__panel">
        <div class="mn-card-actions">
          <button class="mn-pillbtn mn-detail__preview" data-act="preview">${ICON_EYE}<span>${escapeHtml(I18n.tr('library.btn.preview'))}</span></button>
          ${canEdit ? `<button class="mn-pillbtn" data-act="editor">${ICON_EDIT}<span>${escapeHtml(I18n.tr('dashboard.openInEditor'))}</span></button>` : ''}
        </div>
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
  // A section the user is directly responsible for: their department is on it, a
  // RECEIVING_* step they hold, or they curate it.
  function isOwnSection(s) {
    if (!s) return false;
    if (s.departmentIds && s.departmentIds.includes(user.departmentId)) return true;
    if (s.userEffectiveRole && s.userEffectiveRole.startsWith('RECEIVING_')
        && s.chain && s.chain.includes(s.userEffectiveRole)) return true;
    if (s.userEffectiveRole === 'CURATOR') return true;
    return false;
  }

  // True when the viewer can see the whole document (every section): the document
  // submitter/owner (incl. Minister, always DS on their events), the responsible
  // deputy, or a supervisor linked to the owner deputy who also participates here.
  function seesAllSections(grid) {
    if (!grid) return false;
    if (grid.documentSubmitterId === user.id) return true;
    if (grid.deputyId && grid.deputyId === user.id) return true;
    const own = (grid.sections || []).filter(isOwnSection);
    return !!(grid.viewerLinkedToOwnerDeputy && own.length > 0);
  }

  function visibleSectionsFor(grid) {
    const all = (grid && grid.sections) || [];
    return seesAllSections(grid) ? all : all.filter(isOwnSection);
  }

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
      const dots = r.chain.map((role, i) => {
        const st = i < r.passed ? 'is-passed' : (i === r.passed && !r.done ? 'is-current' : 'is-pending');
        return `<button type="button" class="mn-prog__step ${st}" data-stage-role="${escapeHtml(role)}" data-stage-idx="${i}" title="${escapeHtml(roleLabel(role))}" aria-label="${escapeHtml(roleLabel(role))}"><span class="mn-prog__dot ${st}"><span class="mn-prog__num">${i + 1}</span></span><span class="mn-prog__steplabel">${escapeHtml(roleLabel(role))}</span></button>`;
      }).join('');
      return `
        <li class="mn-prog__item ${r.done ? 'is-done' : ''}" data-section-id="${r.sectionId}">
          <div class="mn-prog__row">
            <div class="mn-prog__rowmain">
              ${canEdit
                ? `<a class="mn-prog__title mn-prog__title--link" href="editor.html?event_id=${eventId}&section_id=${r.sectionId}">${escapeHtml(r.title)}</a>`
                : `<span class="mn-prog__title">${escapeHtml(r.title)}</span>`}
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
    if (!seesAll) {
      const editBtn = container.closest('.mn-detail__panel')?.querySelector('[data-act="editor"]');
      if (editBtn) editBtn.remove();
    }
    container.innerHTML = `
      <div class="mn-prog">
        ${seesAll ? `
          <div class="mn-prog__top">
            <span class="mn-prog__label">${escapeHtml(I18n.tr('dashboard.progress'))}</span>
            <span class="mn-prog__pct">${overall}%</span>
          </div>
          <div class="mn-prog__bar"><span style="width:${overall}%"></span></div>
          <div class="mn-prog__summary">${escapeHtml(summary)}</div>
        ` : ''}
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
          // A progress bar under the steps, filled up to (and including) the
          // section's current stage — mirrors the reference stepper design.
          const total = row ? row.total : 0;
          const fill = row && row.done ? 100
            : (total > 0 ? Math.min(100, Math.round(((row.passed + 1) / total) * 100)) : 0);
          const track = document.createElement('div');
          track.className = 'mn-prog__track';
          track.innerHTML = `<span style="width:${fill}%"></span>`;
          stepperEl.appendChild(track);
          detail.querySelector('.mn-stage__close').addEventListener('click', collapse);
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
    const head = `
      <div class="mn-stage__head">
        <span class="mn-stage__status is-${state}">${escapeHtml(I18n.tr(statusKey))}</span>
        <span class="mn-stage__role">${escapeHtml(roleLabel(role))}</span>
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

    let body;
    if (!users.length) {
      body = (step && step.acted && step.actorName)
        ? personRow(localizedName(step.actorName, step.actorNameKa), step.departmentName, true)
        : `<div class="mn-stage__empty">${escapeHtml(I18n.tr('dashboard.noEligibleUsers'))}</div>`;
    } else {
      const label = `<div class="mn-stage__subhead">${escapeHtml(I18n.tr('dashboard.responsible'))}</div>`;
      body = label + users.map(u =>
        personRow(localizedName(u.fullName, u.fullNameKa), u.departmentName, actedId === u.id)).join('');
    }
    return head + body;
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

  // Which quick buttons a section offers the current user — same per-status logic
  // as the old pipeline dashboard. The server re-enforces every action.
  function renderSectionActions(s, eventId) {
    const effRole = s.userEffectiveRole || user.role;
    const holder = s.currentHolderRole;
    const isHolder = effRole === holder;
    const status = s.status || 'draft';
    const btns = [];
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
          // Refresh the progress block in place (the section list expands again).
          const list = container.querySelector('#mnProgList');
          const wasOpen = list && !list.hasAttribute('hidden');
          await loadProgress(evId, container);
          if (wasOpen) {
            const newList = container.querySelector('#mnProgList');
            const newToggle = container.querySelector('#mnProgToggle');
            if (newList) newList.removeAttribute('hidden');
            if (newToggle) newToggle.setAttribute('aria-expanded', 'true');
          }
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

  // ── Calendar (adapted from dashboard-pipeline.js renderMiniCalendar) ─────────
  function renderCalendar(date) {
    calendarDate = date;
    const year = date.getFullYear();
    const month = date.getMonth();
    const today = new Date();

    const eventDates = new Set();
    activeItems().forEach(item => {
      const ds = itemDate(item);
      if (!ds) return;
      const d = new Date(ds);
      if (d.getFullYear() === year && d.getMonth() === month) eventDates.add(d.getDate());
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
      const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
      const hasEvent = eventDates.has(d);
      let cls = 'dp-cal-grid__day';
      if (isToday) cls += ' dp-cal-grid__day--today';
      if (hasEvent) cls += ' dp-cal-grid__day--has-event';
      const dateAttr = hasEvent ? ` data-cal-date="${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}"` : '';
      daysHtml += `<span class="${cls}"${dateAttr}>${d}</span>`;
    }

    miniCalendarEl.innerHTML = `
      <div class="dp-cal-header">
        <button class="dp-cal-nav" id="calPrev">&lsaquo;</button>
        <span class="dp-cal-header__title">${escapeHtml(monthLabel)}</span>
        <button class="dp-cal-nav" id="calNext">&rsaquo;</button>
      </div>
      <div class="dp-cal-grid">${daysHtml}</div>
    `;

    document.getElementById('calPrev')?.addEventListener('click', () => renderCalendar(new Date(year, month - 1, 1)));
    document.getElementById('calNext')?.addEventListener('click', () => renderCalendar(new Date(year, month + 1, 1)));

    // Click a marked date → select (expand) the first matching event.
    miniCalendarEl.querySelectorAll('[data-cal-date]').forEach(day => {
      day.addEventListener('click', () => {
        const clicked = day.dataset.calDate; // YYYY-MM-DD
        const match = activeItems().find(item => {
          const ds = itemDate(item);
          if (!ds) return false;
          const d = new Date(ds);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return key === clicked;
        });
        if (match) select(match.id);
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
  // Re-position once fonts/layout settle (button widths depend on the label text).
  requestAnimationFrame(positionThumb);

  // ── Notifications panel (injected below the hero) ───────────────────────────
  const NOTIF_ICON = {
    event_created: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    your_turn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    returned: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  };

  function notifMessage(n) {
    const m = n.meta || {};
    if (n.type === 'event_created') return I18n.tr('notif.eventCreated').replace('{event}', m.eventTitle || '');
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
  let notifPanel, notifListEl, notifBadgeEl;
  function buildNotifPanel() {
    const side = document.getElementById('mnSide');
    if (!side) return;
    notifPanel = document.createElement('div');
    notifPanel.className = 'mn-notifs';
    notifPanel.hidden = true;
    notifPanel.innerHTML = `
      <div class="mn-notifs__head">
        <span class="mn-notifs__title">${escapeHtml(I18n.tr('notif.title'))}<span class="mn-notifs__badge" hidden></span></span>
      </div>
      <ul class="mn-notifs__list"></ul>`;
    side.appendChild(notifPanel);
    notifListEl = notifPanel.querySelector('.mn-notifs__list');
    notifBadgeEl = notifPanel.querySelector('.mn-notifs__badge');
  }

  function renderNotifications(data) {
    if (!notifPanel) return;
    const list = (data && data.notifications) || [];
    if (!list.length) { notifPanel.hidden = true; return; }
    notifPanel.hidden = false;
    const unread = (data && data.unreadCount) || 0;
    notifBadgeEl.textContent = unread ? String(unread) : '';
    notifBadgeEl.hidden = !unread;
    notifListEl.innerHTML = list.map(n => `
      <li class="mn-notif ${n.isRead ? '' : 'is-unread'}" data-id="${n.id}" data-type="${n.type}" data-event="${n.eventId || ''}" data-section="${n.sectionId || ''}">
        <span class="mn-notif__icon">${NOTIF_ICON[n.type] || NOTIF_ICON.your_turn}</span>
        <span class="mn-notif__msg">${escapeHtml(notifMessage(n))}</span>
        <span class="mn-notif__time">${escapeHtml(notifTimeAgo(n.createdAt))}</span>
      </li>`).join('');
    notifListEl.querySelectorAll('.mn-notif').forEach(li => {
      li.addEventListener('click', async () => {
        try { await Api.post('/api/notifications/read', { id: parseInt(li.dataset.id, 10) }); } catch (_) { /* ignore */ }
        // Switch to the tab holding the event and select it (no jump to editor).
        // Works for read and unread alike; revealEvent refreshes + retries so an
        // older read notification still opens its event.
        if (li.dataset.event) await revealEvent(parseInt(li.dataset.event, 10));
        loadNotifications();
      });
    });
  }

  async function loadNotifications() {
    try { renderNotifications(await Api.get('/api/notifications')); } catch (_) { /* keep silent */ }
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
  setInterval(loadNotifications, 45000);
})();
