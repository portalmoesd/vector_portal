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

  filterCountry.innerHTML = '<option value="">All countries</option>' +
    countries.map(c => `<option value="${c.id}">${escapeHtml(localizedCountryName(c))}</option>`).join('');

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
        const match = (e.title || '').toLowerCase().includes(kw) ||
                      (e.occasion || '').toLowerCase().includes(kw) ||
                      (e.countryName || '').toLowerCase().includes(kw);
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
              <span>${escapeHtml(localizedCountryName({ code: e.countryCode, name_en: e.countryName }))}</span>
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
    // mailto: links can't carry attachments, so when the event has files we
    // add a portal link recipients can open (after logging in) to download them.
    if (draft.files && draft.files.length > 0 && draft.event && draft.event.id) {
      const link = `${window.location.origin}/pages/calendar.html?event=${draft.event.id}`;
      body += `\n\n${I18n.tr('calendar.email.attachmentLine')} ${link}`;
    }
    // One-click "add to calendar" link (the .ics is also downloaded locally).
    if (draft.calendar && draft.calendar.addUrl) {
      body += `\n\n${I18n.tr('calendar.email.calendarLine')} ${draft.calendar.addUrl}`;
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
          <p><strong>Country:</strong> ${escapeHtml(localizedCountryName({ code: e.countryCode, name_en: e.countryName }))}</p>
          <p><strong>Language:</strong> ${languageLabel(e.language)}</p>
          <p><strong>Document Submitter:</strong> ${escapeHtml(localizedName(e.documentSubmitterName, e.documentSubmitterNameKa))} (${roleLabel(e.documentSubmitterRole)})</p>
          ${e.deputyName ? `<p><strong>Deputy:</strong> ${escapeHtml(localizedName(e.deputyName, e.deputyNameKa))}</p>` : ''}
          ${e.supervisorName ? `<p><strong>Responsible Supervisor:</strong> ${escapeHtml(localizedName(e.supervisorName, e.supervisorNameKa))}</p>` : ''}
          <p><strong>Curator Required:</strong> ${e.curatorRequired ? 'Yes' : 'No'}</p>
          ${e.occasion ? `<div><strong>Task:</strong> ${e.occasion}</div>` : ''}
          ${e.deadlineDate ? `<p><strong>Deadline:</strong> ${formatDate(e.deadlineDate)}</p>` : ''}
          ${e.eventDateTime ? `<p><strong>${escapeHtml(I18n.tr('calendar.form.eventDateTime'))}:</strong> ${formatDateTime(e.eventDateTime)}</p>` : ''}
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

  const isUnrestricted = user.role === 'ADMIN' || user.role === 'PROTOCOL';
  // Protocol gets a simplified flow: the document submitter is always a
  // Deputy (or the Minister, who is modelled as a Deputy), so we hide the
  // Document Submitter Role selector and just let them pick the person.
  const isProtocol = user.role === 'PROTOCOL';

  createBtn.addEventListener('click', async () => {
    // The Minister (if any) can be named as the Document Submitter; an assigned
    // deputy then drives the document as curator. Only ADMIN/PROTOCOL may do this.
    let minister = null;
    try {
      [deputies, templates] = await Promise.all([
        Api.get(isUnrestricted ? '/api/admin/deputies' : '/api/admin/linked-deputies'),
        Api.get('/api/templates'),
      ]);
      if (isUnrestricted) minister = await Api.get('/api/admin/minister');
    } catch (e) { deputies = []; templates = []; }

    const countryOpts = countries.map(c =>
      `<option value="${c.id}">${escapeHtml(localizedCountryName(c))}</option>`
    ).join('');

    const deputyOpts = deputies.map(d =>
      `<option value="${d.id}">${escapeHtml(localizedName(d.fullName, d.fullNameKa))}</option>`
    ).join('');

    showModal(I18n.tr('calendar.modal.createTitle'), `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 20px;">
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.title">Title *</label>
          <input class="form-input" id="newTitle" required />
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.country">Country *</label>
          <select class="form-select" id="newCountry">
            <option value="" data-i18n="calendar.form.selectPlaceholder">— Select —</option>
            ${countryOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.workflow">Workflow *</label>
          <select class="form-select" id="newWorkflowType">
            <option value="simple" selected data-i18n="calendar.form.workflowSimple">Simple</option>
            <option value="advanced" data-i18n="calendar.form.workflowAdvanced">Advanced</option>
          </select>
        </div>
        <div class="form-group" id="dsRoleGroup">
          <label class="form-label" data-i18n="calendar.form.dsRole">Document Submitter Role *</label>
          <select class="form-select" id="newDSRole">
            <option value="DEPUTY" data-i18n="roles.DEPUTY">Deputy</option>
            <option value="SUPERVISOR" data-i18n="roles.SUPERVISOR">Supervisor</option>
            <option value="SUPER_COLLABORATOR" data-i18n="roles.SUPER_COLLABORATOR">Super-Collaborator</option>
            ${isUnrestricted ? '<option value="MINISTER" data-i18n="roles.MINISTER">Minister</option>' : ''}
          </select>
        </div>
        <div class="form-group" id="deputyGroup">
          <label class="form-label" data-i18n="calendar.form.deputy">Deputy *</label>
          <select class="form-select" id="newDeputy">
            <option value="" data-i18n="calendar.form.selectDeputy">— Select Deputy —</option>
            ${deputyOpts}
          </select>
        </div>
        <div class="form-group" id="supervisorGroup">
          <label class="form-label" data-i18n="calendar.form.responsibleSupervisor">Responsible Supervisor *</label>
          <select class="form-select" id="newSupervisor">
            <option value="" data-i18n="calendar.form.selectSupervisor">— Select Supervisor —</option>
          </select>
        </div>
        <div class="form-group" id="dsSupervisorGroup" style="display:none;">
          <label class="form-label" data-i18n="calendar.form.supervisor">Supervisor *</label>
          <select class="form-select" id="newDSSupervisor">
            <option value="" data-i18n="calendar.form.selectSupervisor">— Select Supervisor —</option>
          </select>
        </div>
        <div class="form-group" id="dsSCGroup" style="display:none;">
          <label class="form-label" data-i18n="calendar.form.superCollaborator">Super-Collaborator *</label>
          <select class="form-select" id="newDSSC">
            <option value="" data-i18n="calendar.form.selectSuperCollaborator">— Select Super-Collaborator —</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.language">Language</label>
          <select class="form-select" id="newLanguage">
            <option value="EN">English</option>
            <option value="KA">ქართული</option>
            <option value="RU">Русский</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.deadline">Deadline</label>
          <input class="form-input" type="text" id="newDeadline" placeholder="dd/mm/yyyy" />
        </div>
        <div class="form-group" id="eventDateTimeGroup" style="display:none;">
          <label class="form-label" data-i18n="calendar.form.eventDateTime">Event date &amp; time</label>
          <input class="form-input" type="text" id="newEventDateTime" placeholder="dd/mm/yyyy, hh:mm" />
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="calendar.form.curatorRequired">Curator Required</label>
          <select class="form-select" id="newCurator">
            <option value="yes" selected data-i18n="common.yes">Yes</option>
            <option value="no" data-i18n="common.no">No</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label" data-i18n="calendar.form.task">Task</label>
          <div id="newOccasionWrap"></div>
        </div>
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label" data-i18n="calendar.form.attachment">Attachment</label>
          <input class="form-input" type="file" id="newAttachment" multiple />
        </div>
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label" data-i18n="calendar.form.template">Template</label>
          <select class="form-select" id="newTemplate">
            <option value="" data-i18n="calendar.form.selectTemplate">— Select Template —</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1;">
          <label class="form-label" style="font-weight:700;" data-i18n="calendar.form.sections">Sections</label>
          <div id="sectionRows"></div>
          <button class="btn btn-outline" type="button" id="addSectionRow" style="margin-top:8px;">${I18n.tr('calendar.form.addSection')}</button>
        </div>
      </div>
    `, I18n.tr('common.create'), async () => {
      const title = document.getElementById('newTitle').value.trim();
      const countryId = parseInt(document.getElementById('newCountry').value);
      const dsRole = document.getElementById('newDSRole').value;
      const workflowType = document.getElementById('newWorkflowType').value || 'advanced';
      const deputyId = document.getElementById('newDeputy').value ? parseInt(document.getElementById('newDeputy').value) : null;
      let supervisorId = document.getElementById('newSupervisor').value ? parseInt(document.getElementById('newSupervisor').value) : null;
      const language = document.getElementById('newLanguage').value;
      const deadlineDate = document.getElementById('newDeadline').value || null;
      const eventDateTimeRaw = document.getElementById('newEventDateTime').value || null;
      const occasion = newOccasionEditor.getHtml() || null;
      const curatorRequired = document.getElementById('newCurator').value === 'yes';

      if (!title || !countryId || !dsRole) {
        toast.warn(I18n.tr('calendar.warn.missingRequired'));
        return;
      }

      // Owner/Submitter validation. In simple workflow the chosen role is the
      // Document Owner; in advanced it's the Document Submitter. A Minister owner
      // needs no deputy (curators come from the org chart); a Deputy owner/DS
      // must be picked.
      const isMinisterDS = dsRole === 'MINISTER';
      if (isMinisterDS) {
        if (!minister) { toast.warn(I18n.tr('calendar.warn.noMinister')); return; }
      } else if (dsRole === 'DEPUTY' && !deputyId) {
        toast.warn(I18n.tr('calendar.warn.missingDeputy'));
        return;
      }

      const sections = getSectionsFromRows();
      if (sections.length === 0) {
        toast.warn(I18n.tr('calendar.warn.missingSection'));
        return;
      }

      let documentSubmitterId;
      if (isMinisterDS) {
        documentSubmitterId = minister.id;
      } else if (dsRole === 'DEPUTY') {
        documentSubmitterId = deputyId || user.id;
      } else if (dsRole === 'SUPERVISOR') {
        documentSubmitterId = document.getElementById('newDSSupervisor').value ? parseInt(document.getElementById('newDSSupervisor').value) : user.id;
      } else if (dsRole === 'SUPER_COLLABORATOR') {
        documentSubmitterId = document.getElementById('newDSSC').value ? parseInt(document.getElementById('newDSSC').value) : user.id;
      } else {
        documentSubmitterId = user.id;
      }

      // A Minister forces simple workflow. Curator is mandatory for Minister and
      // Deputy owners in simple mode (the server enforces the same rules).
      const effWorkflowType = isMinisterDS ? 'simple' : workflowType;
      const effCuratorRequired = (effWorkflowType === 'simple' && (dsRole === 'MINISTER' || dsRole === 'DEPUTY'))
        ? true
        : curatorRequired;
      // The deputy is only an event-level field for a Deputy owner/DS; for other
      // owners it's resolved per-section (curators) and left null.
      const effDeputyId = dsRole === 'DEPUTY' ? deputyId : null;

      // DS=SUPERVISOR: responsible supervisor is the same person as the DS
      if (dsRole === 'SUPERVISOR') {
        supervisorId = documentSubmitterId;
      }

      try {
        const created = await Api.post('/api/events', {
          title, countryId,
          documentSubmitterRole: dsRole,
          documentSubmitterId,
          deputyId: effDeputyId,
          supervisorId,
          curatorRequired: effCuratorRequired,
          workflowType: effWorkflowType,
          language, deadlineDate, occasion,
          // Optional — only relevant for Minister / Deputy owners.
          eventDateTime: (dsRole === 'MINISTER' || dsRole === 'DEPUTY') ? eventDateTimeRaw : null,
          sections,
        });
        // Upload the attachment(s) (if any) before preparing the email draft
        // so the draft can reference them and we can auto-download them.
        const fileInput = document.getElementById('newAttachment');
        const attachedFiles = fileInput && fileInput.files ? Array.from(fileInput.files) : [];
        if (attachedFiles.length > 0) {
          try {
            await uploadEventAttachments(created.id, attachedFiles);
          } catch (e) {
            toast.warn(I18n.tr('calendar.warn.attachmentFailed') + ' ' + e.message);
          }
        }
        hideModal();
        await openCreatedEventNotificationDraft(created.id);
        events = await Api.get('/api/events');
        render();
      } catch (err) { toast.error(err.message); }
    });

    const newOccasionEditor = window.GCP.createSimpleEditor(document.getElementById('newOccasionWrap'), { placeholder: 'Enter task description...' });

    flatpickr('#newDeadline', { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', locale: { firstDayOfWeek: 1 } });
    flatpickr('#newEventDateTime', { enableTime: true, time_24hr: true, dateFormat: 'Y-m-d H:i', altInput: true, altFormat: 'd/m/Y H:i', locale: { firstDayOfWeek: 1 } });

    const sectionRowsContainer = document.getElementById('sectionRows');
    const addSectionRowBtn = document.getElementById('addSectionRow');
    const templateSelect = document.getElementById('newTemplate');

    addSectionRowBtn.addEventListener('click', () => createSectionRow(sectionRowsContainer));

    // Populate template dropdown
    templateSelect.innerHTML = '<option value="">— Select Template —</option>' +
      templates.map(t => {
        const label = t.isDefault ? t.name : t.name;
        const badge = t.isDefault ? ' (Default)' : '';
        return `<option value="${t.id}">${escapeHtml(label)}${badge} — ${t.sections.length} section(s)</option>`;
      }).join('');

    // When template is selected → auto-fill sections
    templateSelect.addEventListener('change', () => {
      const tplId = templateSelect.value ? parseInt(templateSelect.value) : null;

      // User picked "Select template" (the empty option). Clear the
      // previously-seeded section rows so the form goes back to a
      // blank slate instead of keeping stale rows from the prior
      // template selection.
      if (!tplId) {
        sectionRowsContainer.innerHTML = '';
        return;
      }

      const tpl = templates.find(t => t.id === tplId);
      if (!tpl || !tpl.sections || tpl.sections.length === 0) {
        // Selected template has no sections — still clear what was
        // there, so the user starts fresh.
        sectionRowsContainer.innerHTML = '';
        return;
      }

      sectionRowsContainer.innerHTML = '';
      for (const sec of tpl.sections) {
        createSectionRow(sectionRowsContainer, sec.title, sec.departmentIds);
      }

      // Templates only seed sections — they don't override the user's
      // explicit Curator Required choice. Earlier the line below was
      // `document.getElementById('newCurator').value = tpl.curatorRequired ? 'yes' : 'no';`
      // which silently flipped a deliberately-chosen Yes back to No
      // whenever a template was picked after the user changed the
      // dropdown. Curator stays whatever the user set on the form.
    });

    // Load supervisors for selected deputy
    async function loadSupervisors(deputyId) {
      const supervisorSelect = document.getElementById('newSupervisor');
      if (!deputyId) {
        supervisorSelect.innerHTML = '<option value="">— Select Supervisor —</option>';
        return;
      }
      try {
        const supervisors = await Api.get(`/api/admin/supervisors?deputy_id=${deputyId}`);
        supervisorSelect.innerHTML = '<option value="">— Select Supervisor —</option>' +
          supervisors.map(s => `<option value="${s.id}">${escapeHtml(localizedName(s.fullName, s.fullNameKa))}${s.departmentName ? ' — ' + escapeHtml(s.departmentName) : ''}</option>`).join('');
      } catch (e) {
        supervisorSelect.innerHTML = '<option value="">— No supervisors found —</option>';
      }
    }

    // When deputy changes, reload supervisors
    document.getElementById('newDeputy').addEventListener('change', () => {
      const deputyId = document.getElementById('newDeputy').value;
      loadSupervisors(deputyId);
    });

    const roleSel = document.getElementById('newDSRole');
    const wfSel = document.getElementById('newWorkflowType');

    // Which roles can be the Document Owner (simple) / Document Submitter
    // (advanced), by creator + workflow. The Minister is a simple-only owner and
    // only ADMIN/PROTOCOL may name one; Protocol is limited to Minister/Deputy.
    function availableRoles() {
      const simple = wfSel.value === 'simple';
      if (isProtocol) return simple ? ['MINISTER', 'DEPUTY'] : ['DEPUTY'];
      if (user.role === 'ADMIN') {
        const base = ['DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
        return simple ? ['MINISTER', ...base] : base;
      }
      // Pipeline creators (Deputy / Supervisor / Super-Collaborator).
      return ['DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
    }

    function populateRoleOptions() {
      const roles = availableRoles();
      const prev = roleSel.value;
      roleSel.innerHTML = roles
        .map(r => `<option value="${r}">${escapeHtml(I18n.tr('roles.' + r))}</option>`)
        .join('');
      roleSel.value = roles.includes(prev) ? prev : roles[0];
    }

    // Simple workflow has a "Document Owner"; advanced has a "Document Submitter".
    function applyRoleGroupLabel() {
      const lbl = document.querySelector('#dsRoleGroup .form-label');
      if (lbl) lbl.textContent = I18n.tr(wfSel.value === 'simple' ? 'calendar.form.ownerRole' : 'calendar.form.dsRole');
    }

    // Curator is mandatory for Minister and Deputy owners in simple workflow
    // (Minister relies on org-chart curators; a Deputy owner curates their own
    // sections). Otherwise the curator toggle is free.
    function applyCuratorRule() {
      const force = wfSel.value === 'simple' && (roleSel.value === 'MINISTER' || roleSel.value === 'DEPUTY');
      const curEl = document.getElementById('newCurator');
      if (!curEl) return;
      if (force) { curEl.value = 'yes'; curEl.disabled = true; } else { curEl.disabled = false; }
    }

    // Responsible-supervisor field only applies to an advanced Deputy DS (the
    // Department A vs B distinction). Hidden in simple mode and for other roles.
    function applyWorkflowTypeVisibility() {
      const supGroup = document.getElementById('supervisorGroup');
      if (supGroup) {
        supGroup.style.display = (wfSel.value !== 'simple' && roleSel.value === 'DEPUTY') ? '' : 'none';
      }
    }

    // Show the person-picker for the chosen role: Deputy → deputy picker,
    // Supervisor → supervisor picker, Super-Collaborator → SC picker, Minister →
    // none (curators come from the org chart).
    async function applyRoleVisibility() {
      const dsRole = roleSel.value;
      document.getElementById('deputyGroup').style.display = dsRole === 'DEPUTY' ? '' : 'none';
      document.getElementById('dsSupervisorGroup').style.display = dsRole === 'SUPERVISOR' ? '' : 'none';
      document.getElementById('dsSCGroup').style.display = dsRole === 'SUPER_COLLABORATOR' ? '' : 'none';
      // Optional event date/time only applies to Minister / Deputy owners.
      document.getElementById('eventDateTimeGroup').style.display = (dsRole === 'MINISTER' || dsRole === 'DEPUTY') ? '' : 'none';
      applyWorkflowTypeVisibility();
      applyCuratorRule();

      if (dsRole !== 'DEPUTY') {
        document.getElementById('newSupervisor').innerHTML = '<option value="">— Select Supervisor —</option>';
      }
      if (dsRole === 'SUPERVISOR') {
        try {
          const list = await Api.get(isUnrestricted ? '/api/admin/all-supervisors' : '/api/admin/linked-supervisors');
          document.getElementById('newDSSupervisor').innerHTML = '<option value="">— Select Supervisor —</option>' +
            list.map(s => `<option value="${s.id}">${escapeHtml(localizedName(s.fullName, s.fullNameKa))}${s.departmentName ? ' — ' + escapeHtml(s.departmentName) : ''}</option>`).join('');
        } catch (e) {
          document.getElementById('newDSSupervisor').innerHTML = '<option value="">— No supervisors found —</option>';
        }
      }
      if (dsRole === 'SUPER_COLLABORATOR') {
        try {
          const list = await Api.get(isUnrestricted ? '/api/admin/all-super-collaborators' : '/api/admin/linked-super-collaborators');
          document.getElementById('newDSSC').innerHTML = '<option value="">— Select Super-Collaborator —</option>' +
            list.map(s => `<option value="${s.id}">${escapeHtml(localizedName(s.fullName, s.fullNameKa))}${s.departmentName ? ' — ' + escapeHtml(s.departmentName) : ''}</option>`).join('');
        } catch (e) {
          document.getElementById('newDSSC').innerHTML = '<option value="">— No super-collaborators found —</option>';
        }
      }
    }

    // Switching workflow rebuilds the role options (e.g. Minister disappears in
    // advanced) and relabels Owner ⇄ Submitter.
    wfSel.addEventListener('change', () => {
      populateRoleOptions();
      applyRoleGroupLabel();
      applyRoleVisibility();
    });
    roleSel.addEventListener('change', applyRoleVisibility);

    // Initial paint.
    populateRoleOptions();
    applyRoleGroupLabel();
    applyRoleVisibility();
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
