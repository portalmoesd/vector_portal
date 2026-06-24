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

  let mode = 'completed'; // 'completed' | 'upcoming'
  let calendarDate = new Date();
  let selectedId = null;  // currently expanded event id (within the active mode)

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

  // ── List cards (below the calendar): clickable, info only ───────────────────
  function listCardHtml(d) {
    const country = localizedCountryName({ code: d.countryCode, name_en: d.countryName });
    const pills = [`<span class="dp-upcoming-event__pill">${escapeHtml(country)}</span>`];
    if (mode === 'completed') {
      pills.push(`<span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(d.language || 'EN')}</span>`);
      if (d.endedAt) pills.push(`<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('library.meta.completed'))} ${formatDate(d.endedAt)}</span>`);
    } else {
      if (d.deadlineDate) pills.push(`<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('dashboard.deadline'))}: ${formatDate(d.deadlineDate)}</span>`);
      pills.push(`<span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(d.language || 'EN')}</span>`);
      if (d.workflowType === 'simple') pills.push(`<span class="dp-upcoming-event__pill" title="${escapeHtml(I18n.tr('dashboard.workflowSimpleTooltip'))}">${escapeHtml(I18n.tr('dashboard.workflowSimple'))}</span>`);
    }
    return `
      <div class="dp-upcoming-event" data-event-id="${d.id}" style="cursor:pointer;">
        <h4 class="dp-upcoming-event__title">${escapeHtml(d.title)}</h4>
        <div class="dp-upcoming-event__pills">${pills.join('')}</div>
      </div>
    `;
  }

  function renderList() {
    const items = getFiltered().filter(d => String(d.id) !== selectedId);
    if (items.length === 0) {
      const emptyKey = mode === 'completed' ? 'dashboard.noCompleted' : 'dashboard.noUpcoming';
      listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr(emptyKey))}</p></div>`;
      return;
    }
    listEl.innerHTML = items.map(listCardHtml).join('');
    listEl.querySelectorAll('.dp-upcoming-event[data-event-id]').forEach(card => {
      card.addEventListener('click', () => select(card.dataset.eventId));
    });
  }

  // ── Detail panel (right of the calendar): the expanded chosen event ─────────
  function detailHeaderHtml(title) {
    return `
      <div class="mn-detail__head">
        <h3 class="mn-detail__title">${escapeHtml(title)}</h3>
        <button class="mn-detail__close" id="mnDetailClose" aria-label="Close">&times;</button>
      </div>
    `;
  }

  function renderDetail() {
    const item = selectedId ? itemById(selectedId) : null;
    if (!item) {
      detailEl.innerHTML = `<div class="mn-detail__placeholder">${escapeHtml(I18n.tr('dashboard.selectEventHint'))}</div>`;
      return;
    }

    const country = localizedCountryName({ code: item.countryCode, name_en: item.countryName });

    if (mode === 'completed') {
      detailEl.innerHTML = `
        ${detailHeaderHtml(item.title)}
        <div class="mn-detail__meta">
          <span>${escapeHtml(country)}</span>
          <span>${escapeHtml(I18n.tr('library.meta.language'))} ${languageLabel(item.language || 'EN')}</span>
          ${item.endedAt ? `<span>${escapeHtml(I18n.tr('library.meta.completed'))} ${formatDate(item.endedAt)}</span>` : ''}
        </div>
        <div class="mn-card-actions">
          <button class="btn btn-outline" data-act="pdf">${escapeHtml(I18n.tr('library.btn.pdf'))}</button>
          <button class="btn btn-outline" data-act="word">${escapeHtml(I18n.tr('library.btn.word'))}</button>
          <button class="btn btn-outline" data-act="files">${escapeHtml(I18n.tr('library.btn.files'))}</button>
        </div>
        <div class="mn-detail__body" id="mnDetailBody">
          <div class="empty-state"><p>${escapeHtml(I18n.tr('dashboard.loading'))}</p></div>
        </div>
      `;
      detailEl.querySelector('#mnDetailClose').addEventListener('click', () => select(null));
      detailEl.querySelector('[data-act="pdf"]').addEventListener('click', () => LibraryDoc.exportPdf(item.id));
      detailEl.querySelector('[data-act="word"]').addEventListener('click', () => LibraryDoc.exportWord(item.id));
      detailEl.querySelector('[data-act="files"]').addEventListener('click', () => LibraryDoc.viewFiles(item.id));

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
      return;
    }

    // Upcoming: event info only.
    const pills = [`<span class="dp-upcoming-event__pill">${escapeHtml(country)}</span>`];
    if (item.deadlineDate) pills.push(`<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('dashboard.deadline'))}: ${formatDate(item.deadlineDate)}</span>`);
    pills.push(`<span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(item.language || 'EN')}</span>`);
    if (item.workflowType === 'simple') pills.push(`<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('dashboard.workflowSimple'))}</span>`);
    detailEl.innerHTML = `
      ${detailHeaderHtml(item.title)}
      <div class="dp-upcoming-event__pills" style="margin-bottom:12px;">${pills.join('')}</div>
      ${item.occasion ? `<div class="mn-detail__body">${item.occasion}</div>` : ''}
    `;
    detailEl.querySelector('#mnDetailClose').addEventListener('click', () => select(null));
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
})();
