/**
 * Calendar / Event List Page
 * - Upcoming and Past event tabs
 * - Client-side filtering (keyword, country, date range)
 * - Pagination (5 per page)
 * - Create / View / Edit / End event modals
 * - When Deputy is selected, sections auto-fill from their template
 * - Departments inside each section shown as checkboxes (can untick)
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  const PER_PAGE = 5;
  let events = [];
  let countries = [];
  let departments = [];
  let deputies = [];
  let templates = [];
  let currentTab = 'upcoming';
  let currentPage = 1;

  const createBtn = document.getElementById('createEventBtn');
  const eventsList = document.getElementById('eventsList');
  const paginationEl = document.getElementById('pagination');
  const modal = document.getElementById('eventModal');
  const modalTitle = document.getElementById('eventModalTitle');
  const modalBody = document.getElementById('eventModalBody');
  const modalCancel = document.getElementById('eventModalCancel');
  const modalSave = document.getElementById('eventModalSave');
  let onModalSave = null;

  const CAN_CREATE = ['ADMIN', 'PROTOCOL', 'DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
  const CAN_END = ['ADMIN', 'PROTOCOL', 'DEPUTY', 'SUPERVISOR'];

  if (CAN_CREATE.includes(user.role)) {
    createBtn.style.display = '';
  }

  // ── Tab switching ──────────────────────────────────────────────────────────

  document.querySelectorAll('.event-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.event-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      currentPage = 1;
      render();
    });
  });

  // ── Filters ────────────────────────────────────────────────────────────────

  const filterKeyword = document.getElementById('filterKeyword');
  const filterCountry = document.getElementById('filterCountry');
  const filterDateFrom = document.getElementById('filterDateFrom');
  const filterDateTo = document.getElementById('filterDateTo');

  const fpOpts = { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', locale: { firstDayOfWeek: 1 }, onChange: () => { currentPage = 1; render(); } };
  flatpickr(filterDateFrom, fpOpts);
  flatpickr(filterDateTo, fpOpts);

  [filterKeyword, filterCountry].forEach(el => {
    el.addEventListener('input', () => { currentPage = 1; render(); });
    el.addEventListener('change', () => { currentPage = 1; render(); });
  });

  // ── Load data ────────────────────────────────────────────────────────────

  try {
    [events, countries, departments] = await Promise.all([
      Api.get('/api/events'),
      Api.get('/api/countries'),
      Api.get('/api/departments'),
    ]);
  } catch (e) {
    eventsList.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    return;
  }

  // Build department lookup
  const deptById = {};
  departments.forEach(d => { deptById[d.id] = d; });

  filterCountry.innerHTML = `<option value="">${escapeHtml(I18n.tr('calendar.filter.allCountries'))}</option>` +
    sortedByLocalizedCountryName(countries).map(c => `<option value="${c.id}">${escapeHtml(localizedCountryName(c))}</option>`).join('');

  // ── Render ───────────────────────────────────────────────────────────────

  function getFiltered() {
    const kw = filterKeyword.value.toLowerCase().trim();
    const countryId = filterCountry.value ? parseInt(filterCountry.value) : null;
    const dateFrom = filterDateFrom.value ? new Date(filterDateFrom.value) : null;
    const dateTo = filterDateTo.value ? new Date(filterDateTo.value) : null;

    return events.filter(e => {
      if (currentTab === 'upcoming' && !e.isActive) return false;
      if (currentTab === 'completed' && (e.isActive || e.status !== 'COMPLETED')) return false;
      if (currentTab === 'archived' && (e.isActive || e.status === 'COMPLETED')) return false;

      if (kw) {
        const localCountry = localizedCountryName({ code: e.countryCode, name_en: e.countryName, name_ka: e.countryNameKa });
        const match = (e.title || '').toLowerCase().includes(kw) ||
                      (e.occasion || '').toLowerCase().includes(kw) ||
                      (e.countryName || '').toLowerCase().includes(kw) ||
                      localCountry.toLowerCase().includes(kw);
        if (!match) return false;
      }
      if (countryId && e.countryId !== countryId) return false;
      const created = new Date(e.createdAt);
      if (dateFrom && created < dateFrom) return false;
      if (dateTo && created > new Date(dateTo.getTime() + 86400000)) return false;
      return true;
    });
  }

  function render() {
    const filtered = getFiltered();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PER_PAGE;
    const page = filtered.slice(start, start + PER_PAGE);

    if (page.length === 0) {
      eventsList.innerHTML = '<div class="empty-state"><p>No events found</p></div>';
      paginationEl.innerHTML = '';
      return;
    }

    eventsList.innerHTML = page.map(e => {
      const statusPill = e.isActive
        ? `<span class="pill pill-green">${e.status || 'Active'}</span>`
        : e.status === 'COMPLETED'
          ? `<span class="pill pill-blue">Completed</span>`
          : `<span class="pill pill-gray">${e.status || 'Archived'}</span>`;

      return `
        <div class="event-card">
          <div class="event-card-info">
            <h4>${escapeHtml(e.title)} ${statusPill}</h4>
            <div class="event-card-meta">
              <span>${escapeHtml(localizedCountryName({ code: e.countryCode, name_en: e.countryName, name_ka: e.countryNameKa }))}</span>
              <span>Language: ${languageLabel(e.language)}</span>
              <span>DS: ${escapeHtml(localizedName(e.documentSubmitterName, e.documentSubmitterNameKa))}</span>
              ${e.deadlineDate ? `<span>Deadline: ${formatDate(e.deadlineDate)}</span>` : ''}
              <span>Created: ${formatDate(e.createdAt)}</span>
            </div>
          </div>
          <div class="event-card-actions">
            <button class="btn btn-outline" onclick="viewEvent(${e.id})">
              <span class="icon" style="--icon-url: url(/assets/view-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
              ${I18n.tr('calendar.action.view')}
            </button>
            ${e.isActive && CAN_CREATE.includes(user.role) ? `<button class="btn btn-outline" onclick="editEvent(${e.id})">
              <span class="icon" style="--icon-url: url(/assets/edit-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
              ${I18n.tr('common.edit')}
            </button>` : ''}
            ${e.isActive && CAN_END.includes(user.role) ? `<button class="btn btn-danger" onclick="endEvent(${e.id})">
              <span class="icon" style="--icon-url: url(/assets/end-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
              ${I18n.tr('calendar.action.end')}
            </button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    if (totalPages > 1) {
      let btns = [];
      btns.push(`<button ${currentPage === 1 ? 'disabled' : ''} onclick="goPage(${currentPage - 1})">${I18n.tr('common.prev')}</button>`);
      for (let i = 1; i <= totalPages; i++) {
        btns.push(`<button class="${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`);
      }
      btns.push(`<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goPage(${currentPage + 1})">${I18n.tr('common.next')}</button>`);
      paginationEl.innerHTML = btns.join('');
    } else {
      paginationEl.innerHTML = '';
    }
  }

  window.goPage = function(p) { currentPage = p; render(); };

  // ── Modal helpers ────────────────────────────────────────────────────────

  function showModal(title, bodyHtml, saveLabel, saveFn) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    document.getElementById('eventModalSave').textContent = saveLabel || I18n.tr('common.save');
    onModalSave = saveFn;
    document.getElementById('eventModalSave').style.display = saveFn ? '' : 'none';
    modal.style.display = 'flex';
    // Translate any data-i18n attributes inside the freshly-rendered
    // modal body so labels / placeholders in the form pick up the
    // current locale.
    I18n.translateRoot(modal);
  }

  function hideModal() { modal.style.display = 'none'; onModalSave = null; }

  modalCancel.addEventListener('click', hideModal);
  modalSave.addEventListener('click', () => { if (onModalSave) onModalSave(); });

  // ── Event email draft ──────────────────────────────────────────────────────
  // After an event is created the server resolves the workflow participants and
  // returns a subject/body/recipient list. We open the user's default mail app
  // with a mailto: link; the portal never sends email itself.

  function buildMailtoUrl(draft) {
    const to = draft.recipients.map((r) => r.email).join('; ');
    let body = draft.body || '';
    const eventId = draft.event && draft.event.id;
    // mailto: links can't carry attachments, so when the event has files we
    // add a portal link recipients can open (after logging in) to download them.
    if (draft.files && draft.files.length > 0 && eventId) {
      const link = `${window.location.origin}/pages/calendar.html?event=${eventId}`;
      body += `\n\n${I18n.tr('calendar.email.attachmentLine')} ${link}`;
    }
    if (eventId) {
      body += `\n\n${I18n.tr('calendar.email.eventLinkLine')} ${window.location.origin}/pages/calendar.html?event=${eventId}`;
    }
    // One-click "add to calendar" link (the .ics is also downloaded locally).
    if (draft.calendar && eventId) {
      // Short portal link that redirects to the Outlook add-event deeplink —
      // the full deeplink is far too long to put in a mailto body.
      body += `\n\n${I18n.tr('calendar.email.calendarLine')} ${window.location.origin}/cal/${eventId}`;
    }
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(draft.subject || 'ახალი ღონისძიება')}&body=${encodeURIComponent(body)}`;
  }

  // Upload event attachment(s) using the stored JWT (Api only speaks JSON).
  async function uploadEventAttachments(eventId, files) {
    const fd = new FormData();
    for (const file of files) fd.append('files', file);
    const res = await fetch(`/api/events/${eventId}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Api.getToken()}` },
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data.files || [];
  }

  function warnAboutMissingEmails(missingEmails) {
    if (!missingEmails || missingEmails.length === 0) return;
    const names = missingEmails
      .slice(0, 5)
      .map((u) => localizedName(u.fullName, u.fullNameKa))
      .join(', ');
    const suffix = missingEmails.length > 5 ? ` and ${missingEmails.length - 5} more` : '';
    toast.warn(
      `Email draft created, but ${missingEmails.length} participant(s) have no email address: ${names}${suffix}.`
    );
  }

  async function openCreatedEventNotificationDraft(eventId) {
    if (!eventId) return;

    try {
      const draft = await Api.get(`/api/events/${eventId}/notification-draft`);
      if (!draft.recipients || draft.recipients.length === 0) {
        toast.warn('Event created, but no participants with email addresses were found.');
        warnAboutMissingEmails(draft.missingEmails);
        return;
      }

      // Always hand the draft off to the device's default mail app via mailto:.
      const mailtoUrl = buildMailtoUrl(draft);
      const link = document.createElement('a');
      link.href = mailtoUrl;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Some mail clients truncate very long mailto: URLs. Surface a
      // non-blocking warning rather than interrupting with a modal.
      if (mailtoUrl.length > (draft.mailtoUrlLimit || 1800)) {
        toast.warn(
          'The recipient list is long; if your mail app opened with missing recipients, add them manually.'
        );
      }
      warnAboutMissingEmails(draft.missingEmails);

      // mailto: can't attach files, so download them locally — the user can
      // then drag them into the draft as real attachments.
      if (draft.files && draft.files.length > 0) {
        for (const f of draft.files) {
          downloadEventFileAuth(eventId, f.id, f.originalName);
        }
        toast.info(I18n.tr('calendar.email.attachmentDownloaded'));
      }

      // Download the .ics calendar entry so the user can attach it too; opening
      // it adds the event (all-day, on the deadline) to a recipient's calendar.
      if (draft.calendar && draft.calendar.ics) {
        const blob = new Blob([draft.calendar.ics], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = draft.calendar.filename || 'event.ics';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.info(I18n.tr('calendar.email.calendarDownloaded'));
      }
    } catch (err) {
      toast.warn(`Event created, but the email draft could not be prepared: ${err.message}`);
    }
  }

  // ── View Event ───────────────────────────────────────────────────────────

  // Filenames for attachments shown in the details modal, keyed by file id,
  // so the inline download handler only carries integers.
  const viewedFileNames = {};
  window.downloadViewedEventFile = function(eventId, fileId) {
    downloadEventFileAuth(eventId, fileId, viewedFileNames[fileId] || 'attachment');
  };

  window.viewEvent = async function(id) {
    try {
      const e = await Api.get(`/api/events/${id}`);
      let files = [];
      try { files = await Api.get(`/api/events/${id}/files`); } catch (_) { /* non-fatal */ }
      // Remember names so the download handler only needs integer ids in the
      // inline onclick (filenames may contain quotes that break the markup).
      files.forEach(f => { viewedFileNames[f.id] = f.original_name; });
      const sectionsHtml = e.sections.map(s => `<li>${escapeHtml(s.title)}</li>`).join('');
      const filesHtml = files.length
        ? `<p><strong>${escapeHtml(I18n.tr('calendar.form.attachment'))}:</strong></p>
           <ul style="margin:0 0 0 20px;list-style:none;padding:0;">${files.map(f =>
             `<li style="margin-bottom:4px;"><a href="#" onclick="event.preventDefault();downloadViewedEventFile(${id},${f.id})">📎 ${escapeHtml(f.original_name)}</a></li>`
           ).join('')}</ul>`
        : '';
      showModal(I18n.tr('calendar.modal.detailsTitle'), `
        <div style="font-size:14px;line-height:1.8;">
          <p><strong>Title:</strong> ${escapeHtml(e.title)}</p>
          <p><strong>Country:</strong> ${escapeHtml(localizedCountryName({ code: e.countryCode, name_en: e.countryName, name_ka: e.countryNameKa }))}</p>
          <p><strong>Language:</strong> ${languageLabel(e.language)}</p>
          <p><strong>Document Submitter:</strong> ${escapeHtml(localizedName(e.documentSubmitterName, e.documentSubmitterNameKa))} (${roleLabel(e.documentSubmitterRole)})</p>
          ${e.deputyName ? `<p><strong>Deputy:</strong> ${escapeHtml(localizedName(e.deputyName, e.deputyNameKa))}</p>` : ''}
          ${e.supervisorName ? `<p><strong>Responsible Supervisor:</strong> ${escapeHtml(localizedName(e.supervisorName, e.supervisorNameKa))}</p>` : ''}
          <p><strong>Document Type:</strong> ${escapeHtml(I18n.tr('calendar.docType.' + (e.documentType || 'OTHER')))}</p>
          <p><strong>Curator Required:</strong> ${e.curatorRequired ? 'Yes' : 'No'}</p>
          ${e.occasion ? `<div><strong>Task:</strong> ${e.occasion}</div>` : ''}
          ${e.deadlineDate ? `<p><strong>Deadline:</strong> ${formatDate(e.deadlineDate)}</p>` : ''}
          ${e.eventDateTime ? `<p><strong>${escapeHtml(I18n.tr('calendar.form.eventDateTime'))}:</strong> ${formatTbilisiDateTime(e.eventDateTime)} (Tbilisi)</p>` : ''}
          <p><strong>Status:</strong> ${e.status}</p>
          <p><strong>Sections:</strong></p>
          <ol style="margin:0 0 0 20px;">${sectionsHtml || '<li>None</li>'}</ol>
          ${filesHtml}
        </div>
      `, null, null);
    } catch (e) { toast.error(e.message); }
  };

  // ── Edit Event ───────────────────────────────────────────────────────────

  window.editEvent = async function(id) {
    try {
      const e = await Api.get(`/api/events/${id}`);
      showModal(I18n.tr('calendar.modal.editTitle'), `
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.titleNoStar">Title</label>
          <input class="form-input" id="editTitle" value="${escapeHtml(e.title)}" />
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.language">Language</label>
          <select class="form-select" id="editLanguage">
            ${['EN','KA','RU'].map(l =>
              `<option value="${l}" ${l === e.language ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.deadline">Deadline</label>
          <input class="form-input" type="text" id="editDeadline" placeholder="dd/mm/yyyy" />
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.task">Task</label>
          <div id="editOccasionWrap"></div>
        </div>
      `, I18n.tr('common.save'), async () => {
        try {
          await Api.patch(`/api/events/${id}`, {
            title: document.getElementById('editTitle').value.trim(),
            language: document.getElementById('editLanguage').value,
            deadlineDate: document.getElementById('editDeadline').value || null,
            occasion: editOccasionEditor.getHtml() || null,
          });
          hideModal();
          events = await Api.get('/api/events');
          render();
        } catch (err) { toast.error(err.message); }
      });
      const editOccasionEditor = window.GCP.createSimpleEditor(document.getElementById('editOccasionWrap'), { placeholder: 'Enter task description...' });
      editOccasionEditor.setHtml(e.occasion || '');
      flatpickr('#editDeadline', { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', defaultDate: e.deadlineDate || null, locale: { firstDayOfWeek: 1 } });
    } catch (e) { toast.error(e.message); }
  };

  // ── End Event ────────────────────────────────────────────────────────────

  window.endEvent = async function(id) {
    if (!confirm(I18n.tr('calendar.confirmEnd'))) return;
    try {
      await Api.post(`/api/events/${id}/end`);
      events = await Api.get('/api/events');
      render();
    } catch (e) { toast.error(e.message); }
  };

  // ── Section row — collapsible dropdown for departments ─────────────────

  function createSectionRow(container, title, selectedDeptIds) {
    const row = document.createElement('div');
    row.className = 'section-row';
    row.style.cssText = 'border:1px solid var(--border-color,#ddd);border-radius:8px;margin-bottom:8px;background:var(--bg-card,#fff);overflow:hidden;';
    const selected = new Set(selectedDeptIds || []);
    const deptCount = selectedDeptIds ? selectedDeptIds.length : 0;

    const deptCheckboxes = selectedDeptIds && selectedDeptIds.length > 0
      ? selectedDeptIds.map(dId => {
          const d = deptById[dId];
          if (!d) return '';
          return `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;cursor:pointer;">
            <input type="checkbox" class="sec-dept-cb" data-dept-id="${d.id}" checked />
            ${escapeHtml(d.nameEn || d.name)}
          </label>`;
        }).join('')
      : '';

    row.innerHTML = `
      <div class="sec-header" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;">
        <span class="sec-toggle" style="font-size:11px;color:#888;transition:transform .2s;">\u25B6</span>
        <input class="form-input sec-title" placeholder="${I18n.tr('calendar.form.sectionTitlePlaceholder')}" style="flex:1;font-weight:600;border:none;padding:0;background:transparent;" value="${title ? escapeHtml(title) : ''}" onclick="event.stopPropagation()" />
        <span class="sec-dept-count" style="font-size:12px;color:#666;white-space:nowrap;">${deptCount} dept(s)</span>
        <button class="btn btn-outline" type="button" style="padding:2px 8px;font-size:11px;color:#dc2626;" onclick="event.stopPropagation();this.closest('.section-row').remove()">\u2715</button>
      </div>
      <div class="sec-body" style="display:none;padding:0 12px 12px 30px;border-top:1px solid var(--border-color,#eee);">
        <div class="sec-depts-container" style="padding:8px 0;">
          ${deptCheckboxes}
        </div>
        <select class="form-select sec-add-dept" style="font-size:12px;padding:4px 8px;margin-top:4px;">
          <option value="">+ Add department...</option>
          ${departments.map(d =>
            `<option value="${d.id}" ${selected.has(d.id) ? 'disabled' : ''}>${escapeHtml(d.nameEn || d.name)}</option>`
          ).join('')}
        </select>
      </div>
    `;

    container.appendChild(row);

    // Toggle expand/collapse
    const header = row.querySelector('.sec-header');
    const body = row.querySelector('.sec-body');
    const toggle = row.querySelector('.sec-toggle');
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      toggle.style.transform = open ? '' : 'rotate(90deg)';
    });

    // Update dept count when checkboxes change
    function updateCount() {
      const count = row.querySelectorAll('.sec-dept-cb:checked').length;
      row.querySelector('.sec-dept-count').textContent = count + ' dept(s)';
    }
    row.addEventListener('change', (e) => {
      if (e.target.classList.contains('sec-dept-cb')) updateCount();
    });

    // Add department on select
    const addDeptSelect = row.querySelector('.sec-add-dept');
    addDeptSelect.addEventListener('change', () => {
      const deptId = parseInt(addDeptSelect.value);
      if (!deptId) return;
      const d = deptById[deptId];
      if (!d) return;

      const existing = row.querySelector(`.sec-dept-cb[data-dept-id="${deptId}"]`);
      if (existing) { addDeptSelect.value = ''; return; }

      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;cursor:pointer;';
      label.innerHTML = `
        <input type="checkbox" class="sec-dept-cb" data-dept-id="${d.id}" checked />
        ${escapeHtml(d.nameEn || d.name)}
      `;
      row.querySelector('.sec-depts-container').appendChild(label);
      addDeptSelect.querySelector(`option[value="${deptId}"]`).disabled = true;
      addDeptSelect.value = '';
      updateCount();
    });
  }

  function getSectionsFromRows() {
    const sections = [];
    document.querySelectorAll('.section-row').forEach(row => {
      const sTitle = row.querySelector('.sec-title').value.trim();
      const deptIds = Array.from(row.querySelectorAll('.sec-dept-cb:checked'))
        .map(cb => parseInt(cb.dataset.deptId));
      if (sTitle) sections.push({ title: sTitle, departmentIds: deptIds });
    });
    return sections;
  }

  // ── Create Event ─────────────────────────────────────────────────────────
  // The full create form lives in the shared EventCreate module so it can be
  // reused on the dashboards; here we just open it as a modal.
  createBtn.addEventListener("click", () => {
    EventCreate.open({
      onCreated: async () => { events = await Api.get("/api/events"); render(); },
    });
  });

  // ── Initial render ───────────────────────────────────────────────────────
  render();

  // Deep link from the event notification email: ?event=<id> opens the event
  // details (where its attachment can be downloaded) once the user is logged in.
  const deepLinkEventId = parseInt(new URLSearchParams(window.location.search).get('event'), 10);
  if (Number.isInteger(deepLinkEventId) && deepLinkEventId > 0) {
    window.viewEvent(deepLinkEventId);
  }
})();
