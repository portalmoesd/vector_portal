/**
 * Shared Create-Event form (window.EventCreate)
 *
 * Extracted from calendar.js so the same create form can be opened as a modal
 * (calendar page, `EventCreate.open`) or rendered inline (dashboard collapsible
 * panel, `EventCreate.mount`). Self-contained: owns its own modal markup and
 * lazily fetches its own reference data.
 *
 * Depends only on app-wide globals: Api, I18n, toast, escapeHtml, localizedName,
 * localizedCountryName, downloadEventFileAuth, window.GCP.createSimpleEditor,
 * flatpickr.
 */
(function () {
  'use strict';

  // ── Reference data (countries / departments) — fetched once, cached ─────────
  let _countries = null;
  let _departments = null;
  let _deptById = null;

  async function ensureRefData() {
    if (_countries && _departments) return;
    const [c, d] = await Promise.all([
      Api.get('/api/countries'),
      Api.get('/api/departments'),
    ]);
    _countries = c || [];
    _departments = d || [];
    _deptById = {};
    _departments.forEach(x => { _deptById[x.id] = x; });
  }

  // ── Section row — collapsible dropdown for departments ─────────────────────
  function createSectionRow(container, title, selectedDeptIds) {
    const row = document.createElement('div');
    row.className = 'section-row';
    row.style.cssText = 'border:1px solid var(--border-color,#ddd);border-radius:8px;margin-bottom:8px;background:var(--bg-card,#fff);overflow:hidden;';
    const selected = new Set(selectedDeptIds || []);
    const deptCount = selectedDeptIds ? selectedDeptIds.length : 0;

    const deptCheckboxes = selectedDeptIds && selectedDeptIds.length > 0
      ? selectedDeptIds.map(dId => {
          const d = _deptById[dId];
          if (!d) return '';
          return `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;cursor:pointer;">
            <input type="checkbox" class="sec-dept-cb" data-dept-id="${d.id}" checked />
            ${escapeHtml(d.nameEn || d.name)}
          </label>`;
        }).join('')
      : '';

    row.innerHTML = `
      <div class="sec-header" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;">
        <span class="sec-toggle" style="font-size:11px;color:#888;transition:transform .2s;">▶</span>
        <input class="form-input sec-title" placeholder="${I18n.tr('calendar.form.sectionTitlePlaceholder')}" style="flex:1;font-weight:600;border:none;padding:0;background:transparent;" value="${title ? escapeHtml(title) : ''}" onclick="event.stopPropagation()" />
        <span class="sec-dept-count" style="font-size:12px;color:#666;white-space:nowrap;">${deptCount} dept(s)</span>
        <button class="btn btn-outline" type="button" style="padding:2px 8px;font-size:11px;color:#dc2626;" onclick="event.stopPropagation();this.closest('.section-row').remove()">✕</button>
      </div>
      <div class="sec-body" style="display:none;padding:0 12px 12px 30px;border-top:1px solid var(--border-color,#eee);">
        <div class="sec-depts-container" style="padding:8px 0;">
          ${deptCheckboxes}
        </div>
        <select class="form-select sec-add-dept" style="font-size:12px;padding:4px 8px;margin-top:4px;">
          <option value="">+ Add department...</option>
          ${_departments.map(d =>
            `<option value="${d.id}" ${selected.has(d.id) ? 'disabled' : ''}>${escapeHtml(d.nameEn || d.name)}</option>`
          ).join('')}
        </select>
      </div>
    `;

    container.appendChild(row);

    const header = row.querySelector('.sec-header');
    const body = row.querySelector('.sec-body');
    const toggle = row.querySelector('.sec-toggle');
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      toggle.style.transform = open ? '' : 'rotate(90deg)';
    });

    function updateCount() {
      const count = row.querySelectorAll('.sec-dept-cb:checked').length;
      row.querySelector('.sec-dept-count').textContent = count + ' dept(s)';
    }
    row.addEventListener('change', (e) => {
      if (e.target.classList.contains('sec-dept-cb')) updateCount();
    });

    const addDeptSelect = row.querySelector('.sec-add-dept');
    addDeptSelect.addEventListener('change', () => {
      const deptId = parseInt(addDeptSelect.value);
      if (!deptId) return;
      const d = _deptById[deptId];
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

  function getSectionsFromRows(root) {
    const sections = [];
    root.querySelectorAll('.section-row').forEach(row => {
      const sTitle = row.querySelector('.sec-title').value.trim();
      const deptIds = Array.from(row.querySelectorAll('.sec-dept-cb:checked'))
        .map(cb => parseInt(cb.dataset.deptId));
      if (sTitle) sections.push({ title: sTitle, departmentIds: deptIds });
    });
    return sections;
  }

  // ── Attachment upload (Api only speaks JSON) ───────────────────────────────
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

  // ── Event email draft (mailto:) ────────────────────────────────────────────
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

  function buildMailtoUrl(draft) {
    const to = draft.recipients.map((r) => r.email).join('; ');
    let body = draft.body || '';
    const eventId = draft.event && draft.event.id;
    if (draft.files && draft.files.length > 0 && eventId) {
      const link = `${window.location.origin}/pages/calendar.html?event=${eventId}`;
      body += `\n\n${I18n.tr('calendar.email.attachmentLine')} ${link}`;
    }
    if (eventId) {
      body += `\n\n${I18n.tr('calendar.email.eventLinkLine')} ${window.location.origin}/pages/calendar.html?event=${eventId}`;
    }
    if (draft.calendar && eventId) {
      // Short portal link that redirects to the Outlook add-event deeplink —
      // the full deeplink is far too long to put in a mailto body.
      body += `\n\n${I18n.tr('calendar.email.calendarLine')} ${window.location.origin}/cal/${eventId}`;
    }
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(draft.subject || 'ახალი ღონისძიება')}&body=${encodeURIComponent(body)}`;
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

      const mailtoUrl = buildMailtoUrl(draft);
      const link = document.createElement('a');
      link.href = mailtoUrl;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();

      if (mailtoUrl.length > (draft.mailtoUrlLimit || 1800)) {
        toast.warn(
          'The recipient list is long; if your mail app opened with missing recipients, add them manually.'
        );
      }
      warnAboutMissingEmails(draft.missingEmails);

      if (draft.files && draft.files.length > 0) {
        for (const f of draft.files) {
          downloadEventFileAuth(eventId, f.id, f.originalName);
        }
        toast.info(I18n.tr('calendar.email.attachmentDownloaded'));
      }

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

  // ── Core form renderer ─────────────────────────────────────────────────────
  // Renders the create form into `bodyEl` and returns { submit } — the caller
  // wires it to its own action button (modal footer / inline button).
  async function renderForm(bodyEl, opts) {
    opts = opts || {};
    const onCreated = opts.onCreated;
    const onClose = opts.onClose;

    const user = Api.getUser();
    const isUnrestricted = user.role === 'ADMIN' || user.role === 'PROTOCOL';
    const isProtocol = user.role === 'PROTOCOL';

    await ensureRefData();

    // The Minister (if any) can be named as the Document Submitter; an assigned
    // deputy then drives the document as curator. Only ADMIN/PROTOCOL may do this.
    let deputies = [], templates = [], minister = null;
    try {
      [deputies, templates] = await Promise.all([
        Api.get(isUnrestricted ? '/api/admin/deputies' : '/api/admin/linked-deputies'),
        Api.get('/api/templates'),
      ]);
      if (isUnrestricted) minister = await Api.get('/api/admin/minister');
    } catch (e) { deputies = []; templates = []; }

    const countryOpts = sortedByLocalizedCountryName(_countries).map(c =>
      `<option value="${c.id}">${escapeHtml(localizedCountryName(c))}</option>`
    ).join('');
    const deputyOpts = deputies.map(d =>
      `<option value="${d.id}">${escapeHtml(localizedName(d.fullName, d.fullNameKa))}</option>`
    ).join('');

    bodyEl.innerHTML = `
      <div class="ec-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:0 20px;">
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
          <label class="form-label" data-i18n="calendar.form.documentType">Document Type *</label>
          <select class="form-select" id="newDocumentType">
            <option value="OTHER" selected data-i18n="calendar.docType.OTHER">Other</option>
            <option value="DISCUSSION_POINTS" data-i18n="calendar.docType.DISCUSSION_POINTS">Discussion Points</option>
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
            <option value="SUPER_COLLABORATOR" data-i18n="roles.SUPER_COLLABORATOR">Senior Editor</option>
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
          <label class="form-label" data-i18n="calendar.form.superCollaborator">Senior Editor *</label>
          <select class="form-select" id="newDSSC">
            <option value="" data-i18n="calendar.form.selectSuperCollaborator">— Select Senior Editor —</option>
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
          <label class="form-label" id="eventDateTimeLabel" data-i18n="calendar.form.eventDateTime">Event date &amp; time</label>
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
      </div>`;

    I18n.translateRoot(bodyEl);

    const occasionEditor = window.GCP.createSimpleEditor(bodyEl.querySelector('#newOccasionWrap'), { placeholder: 'Enter task description...' });

    flatpickr(bodyEl.querySelector('#newDeadline'), { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', locale: { firstDayOfWeek: 1 } });
    flatpickr(bodyEl.querySelector('#newEventDateTime'), { enableTime: true, time_24hr: true, dateFormat: 'Y-m-d H:i', altInput: true, altFormat: 'd/m/Y H:i', locale: { firstDayOfWeek: 1 } });

    const sectionRowsContainer = bodyEl.querySelector('#sectionRows');
    const addSectionRowBtn = bodyEl.querySelector('#addSectionRow');
    const templateSelect = bodyEl.querySelector('#newTemplate');

    addSectionRowBtn.addEventListener('click', () => createSectionRow(sectionRowsContainer));

    templateSelect.innerHTML = '<option value="">— Select Template —</option>' +
      templates.map(t => {
        const badge = t.isDefault ? ' (Default)' : '';
        return `<option value="${t.id}">${escapeHtml(t.name)}${badge} — ${t.sections.length} section(s)</option>`;
      }).join('');

    templateSelect.addEventListener('change', () => {
      const tplId = templateSelect.value ? parseInt(templateSelect.value) : null;
      if (!tplId) { sectionRowsContainer.innerHTML = ''; return; }
      const tpl = templates.find(t => t.id === tplId);
      if (!tpl || !tpl.sections || tpl.sections.length === 0) {
        sectionRowsContainer.innerHTML = '';
        return;
      }
      sectionRowsContainer.innerHTML = '';
      for (const sec of tpl.sections) {
        createSectionRow(sectionRowsContainer, sec.title, sec.departmentIds);
      }
    });

    async function loadSupervisors(deputyId) {
      const supervisorSelect = bodyEl.querySelector('#newSupervisor');
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

    bodyEl.querySelector('#newDeputy').addEventListener('change', () => {
      loadSupervisors(bodyEl.querySelector('#newDeputy').value);
    });

    const roleSel = bodyEl.querySelector('#newDSRole');
    const wfSel = bodyEl.querySelector('#newWorkflowType');

    function availableRoles() {
      const simple = wfSel.value === 'simple';
      if (isProtocol) return simple ? ['MINISTER', 'DEPUTY'] : ['DEPUTY'];
      if (user.role === 'ADMIN') {
        const base = ['DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
        return simple ? ['MINISTER', ...base] : base;
      }
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

    function applyRoleGroupLabel() {
      const lbl = bodyEl.querySelector('#dsRoleGroup .form-label');
      if (lbl) lbl.textContent = I18n.tr(wfSel.value === 'simple' ? 'calendar.form.ownerRole' : 'calendar.form.dsRole');
    }

    function applyCuratorRule() {
      const force = wfSel.value === 'simple' && (roleSel.value === 'MINISTER' || roleSel.value === 'DEPUTY');
      const curEl = bodyEl.querySelector('#newCurator');
      if (!curEl) return;
      if (force) { curEl.value = 'yes'; curEl.disabled = true; } else { curEl.disabled = false; }
    }

    function applyWorkflowTypeVisibility() {
      const supGroup = bodyEl.querySelector('#supervisorGroup');
      if (supGroup) {
        supGroup.style.display = (wfSel.value !== 'simple' && roleSel.value === 'DEPUTY') ? '' : 'none';
      }
    }

    // The meeting date/time is optional for most documents and only offered to
    // owner roles that run meetings. A Discussion Points document always leads
    // to a meeting, so there it is shown and required whoever the Document
    // Submitter is.
    // This is about *entering* the time only — canSeeEventDateTime still
    // decides who may see it afterwards, and is deliberately unchanged.
    function isDiscussionPointsSelected() {
      const sel = bodyEl.querySelector('#newDocumentType');
      return !!sel && sel.value === 'DISCUSSION_POINTS';
    }

    function applyDateTimeVisibility() {
      const dsRole = roleSel.value;
      const dp = isDiscussionPointsSelected();
      const show = dp || dsRole === 'MINISTER' || dsRole === 'DEPUTY' || dsRole === 'SUPERVISOR';
      bodyEl.querySelector('#eventDateTimeGroup').style.display = show ? '' : 'none';
      const label = bodyEl.querySelector('#eventDateTimeLabel');
      if (label) {
        label.setAttribute('data-i18n', dp ? 'calendar.form.eventDateTimeRequired' : 'calendar.form.eventDateTime');
        label.textContent = I18n.tr(dp ? 'calendar.form.eventDateTimeRequired' : 'calendar.form.eventDateTime');
      }
    }

    async function applyRoleVisibility() {
      const dsRole = roleSel.value;
      bodyEl.querySelector('#deputyGroup').style.display = dsRole === 'DEPUTY' ? '' : 'none';
      bodyEl.querySelector('#dsSupervisorGroup').style.display = dsRole === 'SUPERVISOR' ? '' : 'none';
      bodyEl.querySelector('#dsSCGroup').style.display = dsRole === 'SUPER_COLLABORATOR' ? '' : 'none';
      applyDateTimeVisibility();
      applyWorkflowTypeVisibility();
      applyCuratorRule();

      if (dsRole !== 'DEPUTY') {
        bodyEl.querySelector('#newSupervisor').innerHTML = '<option value="">— Select Supervisor —</option>';
      }
      if (dsRole === 'SUPERVISOR') {
        try {
          const list = await Api.get(isUnrestricted ? '/api/admin/all-supervisors' : '/api/admin/linked-supervisors');
          bodyEl.querySelector('#newDSSupervisor').innerHTML = '<option value="">— Select Supervisor —</option>' +
            list.map(s => `<option value="${s.id}">${escapeHtml(localizedName(s.fullName, s.fullNameKa))}${s.departmentName ? ' — ' + escapeHtml(s.departmentName) : ''}</option>`).join('');
        } catch (e) {
          bodyEl.querySelector('#newDSSupervisor').innerHTML = '<option value="">— No supervisors found —</option>';
        }
      }
      if (dsRole === 'SUPER_COLLABORATOR') {
        try {
          const list = await Api.get(isUnrestricted ? '/api/admin/all-super-collaborators' : '/api/admin/linked-super-collaborators');
          bodyEl.querySelector('#newDSSC').innerHTML = `<option value="">${escapeHtml(I18n.tr('calendar.form.selectSuperCollaborator'))}</option>` +
            list.map(s => `<option value="${s.id}">${escapeHtml(localizedName(s.fullName, s.fullNameKa))}${s.departmentName ? ' — ' + escapeHtml(s.departmentName) : ''}</option>`).join('');
        } catch (e) {
          bodyEl.querySelector('#newDSSC').innerHTML = `<option value="">${escapeHtml(I18n.tr('calendar.form.noSuperCollaborators'))}</option>`;
        }
      }
    }

    wfSel.addEventListener('change', () => {
      populateRoleOptions();
      applyRoleGroupLabel();
      applyRoleVisibility();
    });

    // Discussion-point documents are normally run through the simple chain, so
    // picking that type pre-selects it — but the creator can still switch back
    // to advanced, so the two fields stay independent.
    const docTypeSel = bodyEl.querySelector('#newDocumentType');
    docTypeSel.addEventListener('change', () => {
      // Runs before the early return below: the meeting-time field has to
      // follow the document type even when the workflow needs no change.
      applyDateTimeVisibility();
      if (docTypeSel.value !== 'DISCUSSION_POINTS' || wfSel.value === 'simple') return;
      wfSel.value = 'simple';
      populateRoleOptions();
      applyRoleGroupLabel();
      applyRoleVisibility();
    });
    roleSel.addEventListener('change', applyRoleVisibility);

    populateRoleOptions();
    applyRoleGroupLabel();
    applyRoleVisibility();

    // ── Submit ────────────────────────────────────────────────────────────────
    let submitting = false;
    async function submit() {
      if (submitting) return;
      const title = bodyEl.querySelector('#newTitle').value.trim();
      const countryId = parseInt(bodyEl.querySelector('#newCountry').value);
      const dsRole = bodyEl.querySelector('#newDSRole').value;
      const workflowType = bodyEl.querySelector('#newWorkflowType').value || 'advanced';
      const documentType = bodyEl.querySelector('#newDocumentType').value || 'OTHER';
      const deputyId = bodyEl.querySelector('#newDeputy').value ? parseInt(bodyEl.querySelector('#newDeputy').value) : null;
      let supervisorId = bodyEl.querySelector('#newSupervisor').value ? parseInt(bodyEl.querySelector('#newSupervisor').value) : null;
      const language = bodyEl.querySelector('#newLanguage').value;
      const deadlineDate = bodyEl.querySelector('#newDeadline').value || null;
      const eventDateTimeRaw = bodyEl.querySelector('#newEventDateTime').value || null;
      const occasion = occasionEditor.getHtml() || null;
      const curatorRequired = bodyEl.querySelector('#newCurator').value === 'yes';

      if (!title || !countryId || !dsRole) {
        toast.warn(I18n.tr('calendar.warn.missingRequired'));
        return;
      }

      // A Discussion Points document cannot be created without a meeting time.
      // Validated in JS rather than with the `required` attribute:
      // #newEventDateTime is a
      // flatpickr altInput field, so the real input is hidden and native
      // validation would never surface. The server enforces this too.
      if (documentType === 'DISCUSSION_POINTS' && !eventDateTimeRaw) {
        toast.warn(I18n.tr('calendar.warn.eventDateTimeRequired'));
        return;
      }

      const isMinisterDS = dsRole === 'MINISTER';
      if (isMinisterDS) {
        if (!minister) { toast.warn(I18n.tr('calendar.warn.noMinister')); return; }
      } else if (dsRole === 'DEPUTY' && !deputyId) {
        toast.warn(I18n.tr('calendar.warn.missingDeputy'));
        return;
      }

      const sections = getSectionsFromRows(bodyEl);
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
        documentSubmitterId = bodyEl.querySelector('#newDSSupervisor').value ? parseInt(bodyEl.querySelector('#newDSSupervisor').value) : user.id;
      } else if (dsRole === 'SUPER_COLLABORATOR') {
        documentSubmitterId = bodyEl.querySelector('#newDSSC').value ? parseInt(bodyEl.querySelector('#newDSSC').value) : user.id;
      } else {
        documentSubmitterId = user.id;
      }

      const effWorkflowType = isMinisterDS ? 'simple' : workflowType;
      const effCuratorRequired = (effWorkflowType === 'simple' && (dsRole === 'MINISTER' || dsRole === 'DEPUTY'))
        ? true
        : curatorRequired;
      const effDeputyId = dsRole === 'DEPUTY' ? deputyId : null;

      if (dsRole === 'SUPERVISOR') {
        supervisorId = documentSubmitterId;
      }

      submitting = true;
      try {
        const created = await Api.post('/api/events', {
          title, countryId,
          documentSubmitterRole: dsRole,
          documentSubmitterId,
          deputyId: effDeputyId,
          supervisorId,
          curatorRequired: effCuratorRequired,
          workflowType: effWorkflowType,
          documentType,
          language, deadlineDate, occasion,
          eventDateTime: (documentType === 'DISCUSSION_POINTS'
            || dsRole === 'MINISTER' || dsRole === 'DEPUTY' || dsRole === 'SUPERVISOR') && eventDateTimeRaw
            ? eventDateTimeRaw.trim().replace(' ', 'T') + ':00+04:00'
            : null,
          sections,
        });
        const fileInput = bodyEl.querySelector('#newAttachment');
        const attachedFiles = fileInput && fileInput.files ? Array.from(fileInput.files) : [];
        if (attachedFiles.length > 0) {
          try {
            await uploadEventAttachments(created.id, attachedFiles);
          } catch (e) {
            toast.warn(I18n.tr('calendar.warn.attachmentFailed') + ' ' + e.message);
          }
        }
        if (onClose) onClose();
        await openCreatedEventNotificationDraft(created.id);
        if (onCreated) await onCreated(created);
      } catch (err) {
        toast.error(err.message);
      } finally {
        submitting = false;
      }
    }

    return { submit };
  }

  // ── Modal markup (calendar page) ───────────────────────────────────────────
  let _modal = null;
  function getModal() {
    if (_modal) return _modal;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'ecModal';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:900px;max-height:90vh;display:flex;flex-direction:column;">
        <h3 id="ecModalTitle" style="margin:0 0 16px;"></h3>
        <div id="ecModalBody" style="overflow-y:auto;flex:1;padding-right:4px;"></div>
        <div class="modal-footer" style="margin-top:16px;display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn btn-outline" id="ecCancel" data-i18n="common.cancel">Cancel</button>
          <button class="btn btn-primary" id="ecSave" data-i18n="common.create">Create</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#ecCancel').addEventListener('click', () => { overlay.style.display = 'none'; });
    _modal = overlay;
    return overlay;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  // open(): modal form (calendar page).
  async function open(opts) {
    opts = opts || {};
    const overlay = getModal();
    const titleEl = overlay.querySelector('#ecModalTitle');
    const bodyEl = overlay.querySelector('#ecModalBody');
    const saveBtn = overlay.querySelector('#ecSave');
    titleEl.textContent = I18n.tr('calendar.modal.createTitle');
    I18n.translateRoot(overlay);
    bodyEl.innerHTML = `<div class="ec-loading" style="padding:20px;text-align:center;color:var(--text-muted);">${escapeHtml(I18n.tr('dashboard.loading') || 'Loading…')}</div>`;
    overlay.style.display = 'flex';

    const hide = () => { overlay.style.display = 'none'; };
    const { submit } = await renderForm(bodyEl, {
      onCreated: opts.onCreated,
      onClose: hide,
    });
    // Re-bind the footer Create button (clone to drop any prior listener).
    const fresh = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(fresh, saveBtn);
    fresh.addEventListener('click', () => submit());
  }

  // mount(): inline form into a container (dashboard collapsible panel).
  async function mount(container, opts) {
    opts = opts || {};
    container.innerHTML = `<div class="ec-loading" style="padding:16px;text-align:center;color:var(--text-muted);">${escapeHtml(I18n.tr('dashboard.loading') || 'Loading…')}</div>`;
    const bodyEl = document.createElement('div');
    const actions = document.createElement('div');
    actions.className = 'ec-actions';
    actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:12px;';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.type = 'button';
    btn.textContent = I18n.tr('common.create') || 'Create';
    actions.appendChild(btn);

    const { submit } = await renderForm(bodyEl, {
      onCreated: opts.onCreated,
      onClose: opts.onClose,
    });
    container.innerHTML = '';
    container.appendChild(bodyEl);
    container.appendChild(actions);
    btn.addEventListener('click', () => submit());
  }

  window.EventCreate = { open, mount };
})();
