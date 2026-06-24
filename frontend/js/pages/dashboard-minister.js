/**
 * Minister Dashboard.
 *
 * A read-only consumer view with two modes, switched by a toggle:
 *   - Completed (default): the Minister's finished documents (GET /api/library,
 *     already scoped to events where they are the Document Submitter), shown as
 *     dashboard-style cards with the Library actions (Preview / PDF / Word /
 *     Files) via the shared LibraryDoc module.
 *   - Upcoming: events currently being prepared for the Minister (GET /api/events,
 *     isActive), shown as info-only cards (no document content).
 *
 * An interactive calendar beside the list marks completion dates (Completed) or
 * deadlines (Upcoming); clicking a marked day highlights the matching cards. A
 * search box filters the active list by title / country.
 *
 * Reuses the calendar + card styles from dashboard-pipeline.css and the
 * mini-calendar logic pattern from dashboard-pipeline.js.
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  const listEl = document.getElementById('cardList');
  const miniCalendarEl = document.getElementById('miniCalendar');
  const keywordEl = document.getElementById('filterKeyword');
  const toggleBtns = Array.from(document.querySelectorAll('.mn-toggle__btn'));

  let mode = 'completed'; // 'completed' | 'upcoming'
  let calendarDate = new Date();

  // ── Load data ────────────────────────────────────────────────────────────
  let completed = [];
  let upcoming = [];
  try {
    const [library, events] = await Promise.all([
      Api.get('/api/library'),
      Api.get('/api/events'),
    ]);
    completed = library || [];
    // Events still being prepared (not yet completed/archived).
    upcoming = (events || []).filter(e => e.isActive);
  } catch (e) {
    listEl.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    return;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function activeItems() {
    return mode === 'completed' ? completed : upcoming;
  }

  // The date a calendar marker / highlight keys off, per mode.
  function itemDate(item) {
    return mode === 'completed' ? item.endedAt : item.deadlineDate;
  }

  function getFiltered() {
    const kw = (keywordEl.value || '').toLowerCase().trim();
    if (!kw) return activeItems();
    return activeItems().filter(d =>
      (d.title || '').toLowerCase().includes(kw) ||
      (d.countryName || '').toLowerCase().includes(kw)
    );
  }

  // ── Card rendering ──────────────────────────────────────────────────────────
  function completedCardHtml(d) {
    const country = localizedCountryName({ code: d.countryCode, name_en: d.countryName });
    const lblCompleted = escapeHtml(I18n.tr('library.meta.completed'));
    return `
      <div class="dp-upcoming-event" data-event-id="${d.id}">
        <h4 class="dp-upcoming-event__title">${escapeHtml(d.title)}</h4>
        <div class="dp-upcoming-event__pills">
          <span class="dp-upcoming-event__pill">${escapeHtml(country)}</span>
          <span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(d.language || 'EN')}</span>
          ${d.endedAt ? `<span class="dp-upcoming-event__pill">${lblCompleted} ${formatDate(d.endedAt)}</span>` : ''}
        </div>
        <div class="mn-card-actions">
          <button class="btn btn-outline" data-act="preview" data-id="${d.id}">${escapeHtml(I18n.tr('library.btn.preview'))}</button>
          <button class="btn btn-outline" data-act="pdf" data-id="${d.id}">${escapeHtml(I18n.tr('library.btn.pdf'))}</button>
          <button class="btn btn-outline" data-act="word" data-id="${d.id}">${escapeHtml(I18n.tr('library.btn.word'))}</button>
          <button class="btn btn-outline" data-act="files" data-id="${d.id}">${escapeHtml(I18n.tr('library.btn.files'))}</button>
        </div>
      </div>
    `;
  }

  function upcomingCardHtml(e) {
    const country = localizedCountryName({ code: e.countryCode, name_en: e.countryName });
    return `
      <div class="dp-upcoming-event" data-event-id="${e.id}">
        <h4 class="dp-upcoming-event__title">${escapeHtml(e.title)}</h4>
        <div class="dp-upcoming-event__pills">
          <span class="dp-upcoming-event__pill">${escapeHtml(country)}</span>
          ${e.deadlineDate ? `<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('dashboard.deadline'))}: ${formatDate(e.deadlineDate)}</span>` : ''}
          <span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(e.language || 'EN')}</span>
          ${e.workflowType === 'simple' ? `<span class="dp-upcoming-event__pill" title="${escapeHtml(I18n.tr('dashboard.workflowSimpleTooltip'))}">${escapeHtml(I18n.tr('dashboard.workflowSimple'))}</span>` : ''}
        </div>
        ${e.occasion ? `<div class="dp-upcoming-event__desc">${e.occasion}</div>` : ''}
      </div>
    `;
  }

  function renderList() {
    const items = getFiltered();
    if (items.length === 0) {
      const emptyKey = mode === 'completed' ? 'dashboard.noCompleted' : 'dashboard.noUpcoming';
      listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr(emptyKey))}</p></div>`;
      return;
    }
    listEl.innerHTML = items
      .map(d => (mode === 'completed' ? completedCardHtml(d) : upcomingCardHtml(d)))
      .join('');

    if (mode === 'completed') {
      listEl.querySelectorAll('.mn-card-actions [data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          const act = btn.dataset.act;
          if (act === 'preview') LibraryDoc.preview(id);
          else if (act === 'pdf') LibraryDoc.exportPdf(id);
          else if (act === 'word') LibraryDoc.exportWord(id);
          else if (act === 'files') LibraryDoc.viewFiles(id);
        });
      });
    }
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

    const calLocale = (typeof _dateLocale === 'function') ? _dateLocale() : 'en-GB';
    const monthLabel = new Date(year, month, 1).toLocaleDateString(calLocale, { month: 'long', year: 'numeric' });
    const weekdayFmt = new Intl.DateTimeFormat(calLocale, { weekday: 'short' });
    const dayNames = [];
    for (let i = 0; i < 7; i++) {
      dayNames.push(weekdayFmt.format(new Date(2024, 0, 1 + i)).toUpperCase());
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

    // Click a marked date → highlight matching cards in the list.
    miniCalendarEl.querySelectorAll('[data-cal-date]').forEach(day => {
      day.addEventListener('click', () => {
        const clicked = day.dataset.calDate; // YYYY-MM-DD
        const matchingIds = activeItems()
          .filter(item => {
            const ds = itemDate(item);
            if (!ds) return false;
            const d = new Date(ds);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return key === clicked;
          })
          .map(item => String(item.id));
        if (!matchingIds.length) return;
        listEl.querySelectorAll('.dp-upcoming-event[data-event-id]').forEach(card => {
          if (matchingIds.includes(card.dataset.eventId)) {
            card.classList.add('dp-upcoming-event--highlight');
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => card.classList.remove('dp-upcoming-event--highlight'), 1000);
          }
        });
      });
    });
  }

  function renderAll() {
    renderList();
    renderCalendar(calendarDate);
  }

  // ── Wire controls ────────────────────────────────────────────────────────────
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode;
      if (next === mode) return;
      mode = next;
      toggleBtns.forEach(b => b.classList.toggle('is-active', b === btn));
      calendarDate = new Date(); // reset to current month on switch
      renderAll();
    });
  });

  keywordEl.addEventListener('input', renderList);

  renderAll();
})();
