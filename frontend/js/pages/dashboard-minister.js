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

  const listEl = document.getElementById('cardList');
  const detailEl = document.getElementById('eventDetail');
  const miniCalendarEl = document.getElementById('miniCalendar');
  const keywordEl = document.getElementById('filterKeyword');
  const toggleBtns = Array.from(document.querySelectorAll('.mn-toggle__btn'));
  const toggleThumb = document.getElementById('mnToggleThumb');

  let mode = 'completed'; // 'completed' | 'upcoming'
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
  if (libRes.status === 'fulfilled') completed = libRes.value || [];
  // Events still being prepared (not yet completed/archived).
  if (evRes.status === 'fulfilled') upcoming = (evRes.value || []).filter(e => e.isActive);
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
  const HERO_ICONS = {
    morning: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a5 5 0 0 1 10 0z" stroke="none"/><g fill="none"><line x1="2.8" y1="15" x2="4.6" y2="15"/><line x1="19.4" y1="15" x2="21.2" y2="15"/><line x1="5" y1="9.2" x2="6.3" y2="10.5"/><line x1="19" y1="9.2" x2="17.7" y2="10.5"/><line x1="2.8" y1="18.8" x2="21.2" y2="18.8"/><polyline points="9.5 6 12 3.5 14.5 6"/></g></svg>',
    afternoon: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.4" stroke="none"/><g fill="none"><line x1="12" y1="1.6" x2="12" y2="3.8"/><line x1="12" y1="20.2" x2="12" y2="22.4"/><line x1="1.6" y1="12" x2="3.8" y2="12"/><line x1="20.2" y1="12" x2="22.4" y2="12"/><line x1="4.4" y1="4.4" x2="6" y2="6"/><line x1="18" y1="18" x2="19.6" y2="19.6"/><line x1="4.4" y1="19.6" x2="6" y2="18"/><line x1="18" y1="6" x2="19.6" y2="4.4"/></g></svg>',
    evening: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a5 5 0 0 1 10 0z" stroke="none"/><g fill="none"><line x1="2.8" y1="15" x2="4.6" y2="15"/><line x1="19.4" y1="15" x2="21.2" y2="15"/><line x1="5" y1="9.2" x2="6.3" y2="10.5"/><line x1="19" y1="9.2" x2="17.7" y2="10.5"/><line x1="2.8" y1="18.8" x2="21.2" y2="18.8"/><polyline points="9.5 3.5 12 6 14.5 3.5"/></g></svg>',
    night: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.8A8 8 0 1 1 9.2 4 6.3 6.3 0 0 0 20 14.8z"/><g transform="translate(15.4 1) scale(0.3)"><path d="M12 17.27l5.18 3.12-1.37-5.9 4.58-3.96-6.04-.52L12 4.27 9.65 9.99l-6.04.52 4.58 3.96-1.37 5.9z"/></g></svg>',
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
      heroIconEl.innerHTML = HERO_ICONS[pod];
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
  function activeItems() {
    return mode === 'completed' ? completed : upcoming;
  }

  // The date a calendar marker keys off, per mode.
  function itemDate(item) {
    return mode === 'completed' ? item.endedAt : item.deadlineDate;
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
    renderDetail();
  }

  // ── List cards (below the calendar): clickable ──────────────────────────────
  function excerptText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || '').trim();
  }

  // Urgency-aware deadline label for in-progress events.
  function dueInfo(deadline) {
    if (!deadline) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(deadline); d.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return { text: I18n.tr('dashboard.overdue'), cls: 'is-overdue' };
    if (days === 0) return { text: I18n.tr('dashboard.dueToday'), cls: 'is-overdue' };
    if (days <= 7) return { text: I18n.tr('dashboard.dueInDays').replace('{n}', days), cls: 'is-soon' };
    return { text: `${I18n.tr('dashboard.deadline')}: ${formatDate(deadline)}`, cls: '' };
  }

  const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

  function listCardHtml(d) {
    const country = localizedCountryName({ code: d.countryCode, name_en: d.countryName });
    const code = (d.countryCode || '').toLowerCase();
    const flag = code
      ? `<img src="/assets/flags/${code}.svg" alt="${escapeHtml(country)}" loading="lazy" onerror="this.closest('.mn-card__flag').style.display='none'">`
      : '';
    let statusClass = mode === 'completed' ? 'mn-card--completed' : 'mn-card--inprogress';
    // In-progress events whose deadline has already passed get a light-yellow card.
    if (mode !== 'completed' && d.deadlineDate
        && startOfDay(new Date(d.deadlineDate)) < startOfDay(new Date())) {
      statusClass += ' mn-card--overdue';
    }
    const lang = languageLabel(d.language || 'EN');
    const ownerName = localizedName(d.documentSubmitterName, d.documentSubmitterNameKa);
    const owner = ownerName
      ? `<div class="mn-card__owner" title="${escapeHtml(I18n.tr('dashboard.owner'))}: ${escapeHtml(ownerName)}">${ICON_PERSON}<span>${escapeHtml(ownerName)}</span></div>`
      : '';

    let excerpt = '';
    let meta;
    if (mode === 'completed') {
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
        </div>
        ${owner}
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
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return { order: 3, key: 'thismonth', label: grp('grpThisMonth') };
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    if (date.getFullYear() === nm.getFullYear() && date.getMonth() === nm.getMonth()) return { order: 4, key: 'nextmonth', label: grp('grpNextMonth') };
    return { order: 5, key: 'later', label: grp('grpLater') };
  }

  function groupItems(items) {
    const now = new Date();
    const map = new Map();
    for (const it of items) {
      const date = mode === 'completed'
        ? (it.endedAt ? new Date(it.endedAt) : null)
        : (it.deadlineDate ? new Date(it.deadlineDate) : null);
      const b = mode === 'completed' ? bucketCompleted(date, now) : bucketInProgress(date, now);
      if (!map.has(b.key)) map.set(b.key, { order: b.order, label: b.label, items: [] });
      map.get(b.key).items.push(it);
    }
    const groups = [...map.values()].sort((a, b) => a.order - b.order);
    const far = 8640000000000000;
    for (const g of groups) {
      g.items.sort((a, b) => {
        if (mode === 'completed') return new Date(b.endedAt || 0) - new Date(a.endedAt || 0);
        return new Date(a.deadlineDate || far) - new Date(b.deadlineDate || far);
      });
    }
    return groups;
  }

  function renderList() {
    const items = getFiltered().filter(d => String(d.id) !== selectedId);
    if (items.length === 0) {
      const emptyKey = mode === 'completed' ? 'dashboard.noCompleted' : 'dashboard.noUpcoming';
      listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr(emptyKey))}</p></div>`;
      return;
    }
    listEl.innerHTML = groupItems(items).map(g => `
      <div class="mn-group"><span class="mn-group__label">${escapeHtml(g.label)}</span></div>
      ${g.items.map(listCardHtml).join('')}
    `).join('');
    listEl.querySelectorAll('.dp-upcoming-event[data-event-id]').forEach(card => {
      card.addEventListener('click', () => select(card.dataset.eventId));
    });
  }

  // ── Detail panel (right of the calendar): the expanded chosen event ─────────
  const ICON_CLIP = '<svg class="mn-file__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49"/></svg>';
  const ICON_DL = '<svg class="mn-file__dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';

  function detailHeaderHtml(item, country) {
    const code = (item.countryCode || '').toLowerCase();
    const flag = code
      ? `<span class="mn-detail__flag" title="${escapeHtml(country)}"><img src="/assets/flags/${code}.svg" alt="${escapeHtml(country)}" onerror="this.closest('.mn-detail__flag').style.display='none'"></span>`
      : '';
    return `
      <div class="mn-detail__head">
        ${flag}
        <h3 class="mn-detail__title">${escapeHtml(item.title)}</h3>
        <button class="mn-detail__close" id="mnDetailClose" aria-label="Close">&times;</button>
      </div>
    `;
  }

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
    if (evRes.status === 'fulfilled') (evRes.value || []).forEach(f =>
      files.push({ kind: 'event', id: f.id, name: f.original_name, size: f.size }));
    if (secRes.status === 'fulfilled') (secRes.value || []).forEach(f =>
      files.push({ kind: 'section', id: f.id, name: f.original_name, size: f.size }));
    if (files.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <h4 class="mn-files__title">${escapeHtml(I18n.tr('dashboard.attachments'))}</h4>
      <ul class="mn-files">
        ${files.map((f, i) => `
          <li class="mn-file" data-i="${i}">
            ${ICON_CLIP}
            <span class="mn-file__name">${escapeHtml(f.name)}</span>
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

  function renderDetail() {
    const item = selectedId ? itemById(selectedId) : null;
    if (!item) {
      detailEl.innerHTML = `<div class="mn-detail__placeholder">${escapeHtml(I18n.tr('dashboard.selectEventHint'))}</div>`;
      return;
    }

    const country = localizedCountryName({ code: item.countryCode, name_en: item.countryName });
    const ownerChipName = localizedName(item.documentSubmitterName, item.documentSubmitterNameKa);
    const ownerChip = ownerChipName
      ? `<span class="is-owner" title="${escapeHtml(I18n.tr('dashboard.owner'))}">${ICON_PERSON}${escapeHtml(ownerChipName)}</span>`
      : '';

    if (mode === 'completed') {
      detailEl.innerHTML = `
        <div class="mn-detail__panel">
          ${detailHeaderHtml(item, country)}
          <div class="mn-detail__meta">
            ${ownerChip}
            <span>${escapeHtml(country)}</span>
            <span>${escapeHtml(languageLabel(item.language || 'EN'))}</span>
            ${item.endedAt ? `<span>${escapeHtml(I18n.tr('library.meta.completed'))} ${formatDate(item.endedAt)}</span>` : ''}
          </div>
          <div class="mn-card-actions">
            <button class="btn btn-outline" data-act="pdf">${escapeHtml(I18n.tr('library.btn.pdf'))}</button>
            <button class="btn btn-outline" data-act="word">${escapeHtml(I18n.tr('library.btn.word'))}</button>
          </div>
          <div class="mn-paper" id="mnDetailBody">
            <div class="empty-state"><p>${escapeHtml(I18n.tr('dashboard.loading'))}</p></div>
          </div>
          <div class="mn-files-wrap" id="mnFiles"></div>
        </div>
      `;
      detailEl.querySelector('#mnDetailClose').addEventListener('click', () => select(null));
      detailEl.querySelector('[data-act="pdf"]').addEventListener('click', () => LibraryDoc.exportPdf(item.id));
      detailEl.querySelector('[data-act="word"]').addEventListener('click', () => LibraryDoc.exportWord(item.id));

      // Load and render the document content inline (accepted view).
      const bodyEl = detailEl.querySelector('#mnDetailBody');
      Api.get(`/api/library/${item.id}/document`).then(doc => {
        // Guard against a newer selection finishing first.
        if (String(selectedId) !== String(item.id)) return;
        bodyEl.innerHTML = (doc.sections || []).map(s => `
          <div class="section-block">
            <h3>${escapeHtml(s.title)}</h3>
            <div class="section-content-preview">${LibraryDoc.stripTrackChanges(s.htmlContent || '<em>No content</em>')}</div>
          </div>
        `).join('') || `<div class="empty-state"><p>${escapeHtml(I18n.tr('dashboard.noSections'))}</p></div>`;
      }).catch(err => {
        if (String(selectedId) !== String(item.id)) return;
        bodyEl.innerHTML = `<div class="msg msg-error">${escapeHtml(I18n.tr('library.preview.failLoad'))} ${escapeHtml(err.message)}</div>`;
      });
      loadAttachments(item.id, detailEl.querySelector('#mnFiles'));
      return;
    }

    // In progress: brief + attachments (no published document yet).
    const due = dueInfo(item.deadlineDate);
    detailEl.innerHTML = `
      <div class="mn-detail__panel">
        ${detailHeaderHtml(item, country)}
        <div class="mn-detail__meta">
          ${ownerChip}
          <span>${escapeHtml(country)}</span>
          <span>${escapeHtml(languageLabel(item.language || 'EN'))}</span>
          ${due ? `<span class="${due.cls}">${escapeHtml(due.text)}</span>` : ''}
        </div>
        ${item.occasion ? `<div class="mn-brief">${item.occasion}</div>` : ''}
        <div class="mn-files-wrap" id="mnFiles"></div>
      </div>
    `;
    detailEl.querySelector('#mnDetailClose').addEventListener('click', () => select(null));
    loadAttachments(item.id, detailEl.querySelector('#mnFiles'));
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
    renderDetail();
  }

  // ── Wire controls ────────────────────────────────────────────────────────────
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode;
      if (next === mode) return;
      mode = next;
      selectedId = null;
      toggleBtns.forEach(b => b.classList.toggle('is-active', b === btn));
      positionThumb();
      calendarDate = new Date(); // reset to current month on switch
      renderAll();
    });
  });

  keywordEl.addEventListener('input', () => {
    selectedId = null;
    renderList();
    renderDetail();
  });

  renderAll();
  positionThumb();
  // Re-position once fonts/layout settle (button widths depend on the label text).
  requestAnimationFrame(positionThumb);
})();
