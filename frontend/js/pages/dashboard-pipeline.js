/**
 * Shared pipeline dashboard for Super-Collaborator, Supervisor, and Deputy roles.
 * Shows assigned events, sections with visual progress pipeline,
 * and micro-action links based on the user's role capabilities.
 * Includes: mini calendar, upcoming events, section history.
 */
(async function () {
  await App.init();

  let activePopover = null;
  const user = Api.getUser();
  if (!user) return;

  const eventSelect = document.getElementById('eventSelect');
  const eventDetailsEl = document.getElementById('eventDetails');
  const sectionsCardEl = document.getElementById('sectionsCard');
  const previewBtn = document.getElementById('previewBtn');
  const miniCalendarEl = document.getElementById('miniCalendar');
  const upcomingListEl = document.getElementById('upcomingList');

  // Fallback for old HTML layout (sectionsContainer)
  const legacyContainer = document.getElementById('sectionsContainer');

  // Load events
  let events = [];
  try {
    events = await Api.get('/api/events');
  } catch (e) {
    const target = sectionsCardEl || legacyContainer;
    if (target) target.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    return;
  }

  const activeEvents = events.filter(e => e.isActive);

  if (activeEvents.length === 0) {
    eventSelect.innerHTML = `<option value="">${escapeHtml(I18n.tr('dashboard.noEvents'))}</option>`;
  } else {
    eventSelect.innerHTML = `<option value="">${escapeHtml(I18n.tr('dashboard.selectEventPlaceholder'))}</option>` +
      activeEvents.map(e => {
        const deadline = e.deadlineDate ? formatDate(e.deadlineDate) : '';
        const label = `${e.title} (${e.countryName}${deadline ? ', ' + deadline : ''})`;
        return `<option value="${e.id}">${escapeHtml(label)}</option>`;
      }).join('');
  }

  // Preview button
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      const eventId = eventSelect.value;
      if (eventId) {
        window.location.href = `/pages/editor-all.html?event_id=${eventId}`;
      }
    });
  }

  // ── Render upcoming events + calendar ────────────────────────────────────
  if (upcomingListEl) renderUpcomingEvents();
  if (miniCalendarEl) renderMiniCalendar(new Date());

  function renderUpcomingEvents() {
    const upcoming = activeEvents.filter(e => e.deadlineDate);
    upcoming.sort((a, b) => new Date(a.deadlineDate) - new Date(b.deadlineDate));

    if (upcoming.length === 0) {
      upcomingListEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('dashboard.noUpcoming'))}</p></div>`;
      return;
    }

    upcomingListEl.innerHTML = upcoming.slice(0, 5).map(e => `
      <div class="dp-upcoming-event" data-event-id="${e.id}" style="cursor:pointer;">
        <h4 class="dp-upcoming-event__title">${escapeHtml(e.title)}</h4>
        <div class="dp-upcoming-event__pills">
          <span class="dp-upcoming-event__pill">${escapeHtml(e.countryName)}</span>
          ${e.deadlineDate ? `<span class="dp-upcoming-event__pill">${escapeHtml(I18n.tr('dashboard.deadline'))}: ${formatDate(e.deadlineDate)}</span>` : ''}
          <span class="dp-upcoming-event__pill dp-upcoming-event__pill--lang">${languageLabel(e.language || 'EN')}</span>
          ${e.workflowType === 'simple' ? `<span class="dp-upcoming-event__pill" title="${escapeHtml(I18n.tr('dashboard.workflowSimpleTooltip'))}">${escapeHtml(I18n.tr('dashboard.workflowSimple'))}</span>` : ''}
        </div>
        ${e.occasion ? `<div class="dp-upcoming-event__desc">${e.occasion}</div>` : ''}
      </div>
    `).join('');

    upcomingListEl.querySelectorAll('[data-event-id]').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.eventId;
        eventSelect.value = id;
        loadSections(id);
      });
    });
  }

  function renderMiniCalendar(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const today = new Date();

    const eventDates = new Set();
    activeEvents.forEach(e => {
      if (e.deadlineDate) {
        const d = new Date(e.deadlineDate);
        if (d.getFullYear() === year && d.getMonth() === month) {
          eventDates.add(d.getDate());
        }
      }
    });

    // Localised month + weekday names — follow the same locale tag the
    // rest of the app uses for dates.
    const calLocale = (typeof _dateLocale === 'function') ? _dateLocale() : 'en-GB';
    const monthLabel = new Date(year, month, 1).toLocaleDateString(calLocale, { month: 'long', year: 'numeric' });
    const weekdayFmt = new Intl.DateTimeFormat(calLocale, { weekday: 'short' });
    // 2024-01-01 is a Monday — build Mon..Sun labels from it.
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

    document.getElementById('calPrev')?.addEventListener('click', () => {
      renderMiniCalendar(new Date(year, month - 1, 1));
    });
    document.getElementById('calNext')?.addEventListener('click', () => {
      renderMiniCalendar(new Date(year, month + 1, 1));
    });

    // Click a date with events → highlight matching upcoming event cards
    miniCalendarEl.querySelectorAll('[data-cal-date]').forEach(day => {
      day.addEventListener('click', () => {
        const clickedDate = day.dataset.calDate;
        const matchingIds = activeEvents
          .filter(e => e.deadlineDate && e.deadlineDate.startsWith(clickedDate))
          .map(e => String(e.id));
        if (!matchingIds.length) return;
        document.querySelectorAll('.dp-upcoming-event[data-event-id]').forEach(card => {
          if (matchingIds.includes(card.dataset.eventId)) {
            card.classList.add('dp-upcoming-event--highlight');
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => card.classList.remove('dp-upcoming-event--highlight'), 1000);
          }
        });
      });
    });
  }

  // ── Load sections for selected event ─────────────────────────────────────

  async function loadSections(eventId) {
    closeStagePopover();
    if (!eventId) {
      if (eventDetailsEl) eventDetailsEl.style.display = 'none';
      if (sectionsCardEl) sectionsCardEl.style.display = 'none';
      if (previewBtn) previewBtn.style.display = 'none';
      return;
    }

    if (previewBtn) previewBtn.style.display = '';

    const ev = activeEvents.find(e => String(e.id) === String(eventId));

    try {
      const grid = await Api.get(`/api/workflow/status-grid?event_id=${eventId}`);

      // Show event details
      if (eventDetailsEl && ev) {
        eventDetailsEl.style.display = '';
        eventDetailsEl.innerHTML = `
            ${ev.occasion ? `<div class="dp-event-details__body">${ev.occasion}</div>` : ''}
            <div class="dp-event-details__meta">
              <span class="dp-event-details__meta-item">${escapeHtml(I18n.tr('dashboard.country'))} <strong>${escapeHtml(ev.countryName)}</strong></span>
              <span class="dp-event-details__meta-item">${escapeHtml(I18n.tr('dashboard.language'))} <span class="dp-lang-pill">${languageLabel(ev.language || 'EN')}</span></span>
              ${ev.deadlineDate ? `<span class="dp-event-details__meta-item">${escapeHtml(I18n.tr('dashboard.deadline'))} <strong>${formatDate(ev.deadlineDate)}</strong></span>` : ''}
              ${ev.workflowType === 'simple' ? `<span class="dp-event-details__meta-item">${escapeHtml(I18n.tr('dashboard.workflow'))} <span class="dp-lang-pill" title="${escapeHtml(I18n.tr('dashboard.workflowSimpleTooltip'))}">${escapeHtml(I18n.tr('dashboard.workflowSimple'))}</span></span>` : ''}
            </div>
        `;
      }

      // Show sections
      const container = sectionsCardEl || legacyContainer;

      const isDS = grid.documentSubmitterId === user.id;
      // The event's responsible Deputy (advanced mode) sees every
      // section. Other Deputies — i.e. curator-deputies who oversee
      // only specific departments — should see only the sections they
      // actually curate, not the whole document.
      const isResponsibleDeputy = grid.deputyId && grid.deputyId === user.id;

      // Filter sections:
      //  - DS or responsible Deputy: every section.
      //  - Section department member: sections their department is on.
      //  - RECEIVING_* chain step: sections whose chain includes their
      //    receiving role.
      //  - Curator deputy: sections where their effective role is
      //    CURATOR (server resolves this per-section from
      //    deputy_department_links + section_departments).
      const visibleSections = (isDS || isResponsibleDeputy)
        ? (grid.sections || [])
        : (grid.sections || []).filter(s => {
            if (s.departmentIds && s.departmentIds.includes(user.departmentId)) return true;
            if (s.userEffectiveRole && s.userEffectiveRole.startsWith('RECEIVING_') && s.chain && s.chain.includes(s.userEffectiveRole)) return true;
            if (s.userEffectiveRole === 'CURATOR') return true;
            return false;
          });

      if (visibleSections.length === 0) {
        if (container) {
          container.style.display = '';
          container.innerHTML = `<div class="card"><div class="empty-state"><p>${escapeHtml(I18n.tr('dashboard.noSections'))}</p></div></div>`;
        }
        return;
      }

      const allApproved = visibleSections.every(s => s.status && s.status.startsWith('approved_by_'));

      const sectionsToApprove = visibleSections.filter(s => {
        const uer = s.userEffectiveRole || user.role;
        const expectedStatus = 'submitted_to_' + uer.toLowerCase();
        return s.status === expectedStatus && s.currentHolderRole === uer;
      });

      let headerActions = '';
      const isDeptA = grid.homeDepartmentId && user.departmentId === grid.homeDepartmentId;
      if (isDS || isDeptA) {
        headerActions += `<button class="btn btn-outline" onclick="window.location.href='/pages/editor-all.html?event_id=${eventId}'">${escapeHtml(I18n.tr('dashboard.openAllSections'))}</button>`;
      }
      if (sectionsToApprove.length > 1) {
        headerActions += `<button class="btn dp-approve-all-btn" id="approveAllBtn">${escapeHtml(I18n.tr('dashboard.approveAllSections'))}</button>`;
      }
      // In simple mode the event auto-completes once every section is
      // approved, so the manual "Send to Library" button is redundant
      // (and the event row has typically vanished from the dashboard
      // already because it's now COMPLETED).
      if (isDS && allApproved && grid.workflowType !== 'simple') {
        headerActions += `<button class="btn btn-primary" id="sendToLibraryBtn">${escapeHtml(I18n.tr('dashboard.sendToLibrary'))}</button>`;
      }

      const sectionsHtml = visibleSections.map((s, i) => renderSectionRow(s, i, eventId, grid)).join('');

      if (container) {
        container.style.display = '';
        container.innerHTML = `
          <div class="card">
            <div class="dp-sections-card__header">
              <div>
                <h3 class="dp-sections-card__title">${escapeHtml(I18n.tr('dashboard.sections'))}</h3>
                <p class="dp-sections-card__subtitle">${escapeHtml(I18n.tr('dashboard.sectionsSubtitle'))}</p>
              </div>
              <div class="dp-sections-card__actions">${headerActions}</div>
            </div>
            <div class="dp-sections-table-header">
              <span>${escapeHtml(I18n.tr('dashboard.colSection'))}</span>
              <span>${escapeHtml(I18n.tr('dashboard.colProgress'))}</span>
              <span style="text-align:right;">${escapeHtml(I18n.tr('dashboard.colActions'))}</span>
            </div>
            ${sectionsHtml}
          </div>
        `;
      }

      bindActions(eventId, grid);
      bindStagePopover();
      bindApproveAll(eventId, sectionsToApprove);
      bindSendToLibrary(eventId);
      bindHistoryToggles();

    } catch (e) {
      const container = sectionsCardEl || legacyContainer;
      if (container) {
        container.style.display = '';
        container.innerHTML = `<div class="card"><div class="msg msg-error">${escapeHtml(e.message)}</div></div>`;
      }
    }
  }

  function renderSectionRow(section, index, eventId, grid) {
    const returnReq = section.returnRequest;
    const returnInfo = section.returnInfo;
    const lastUpdated = section.lastUpdatedAt ? formatDateTime(section.lastUpdatedAt) : '';
    const lastUpdatedBy = section.lastUpdatedBy ? escapeHtml(localizedName(section.lastUpdatedBy, section.lastUpdatedByKa)) : '';

    const deptInfo = (section.departmentNames && section.departmentNames.length > 0)
      ? section.departmentNames.map(n => escapeHtml(n)).join('<br>')
      : '';

    // Build notification banners
    let noticeBanners = '';
    if (returnInfo) {
      noticeBanners += `<div class="dp-return-notice dp-return-notice--returned">${escapeHtml(I18n.tr('dashboard.returnedBy', { who: returnInfo.from || returnInfo.fromRole || '' }))}${returnInfo.note ? ': ' + escapeHtml(returnInfo.note) : ''}</div>`;
    }
    if (returnReq) {
      noticeBanners += `<div class="dp-return-notice">${escapeHtml(I18n.tr('dashboard.returnRequestedBy', { who: returnReq.from || '' }))}${returnReq.note ? ': ' + escapeHtml(returnReq.note) : ''}</div>`;
    }

    return `
      <div class="dp-section-row">
        <div class="dp-section-row__header">
          <div class="dp-section-row__info">
            <h4 class="dp-section-row__title">${escapeHtml(section.sectionLabel)}</h4>
            ${deptInfo ? '<div class="dp-section-row__depts">' + deptInfo + '</div>' : ''}
            <div class="dp-section-row__meta">${lastUpdated}${lastUpdatedBy ? ' &middot; ' + lastUpdatedBy : ''}</div>
            ${noticeBanners}
          </div>
          <div class="dp-section-row__actions">
            ${renderActionLinks(section, eventId, grid)}
          </div>
        </div>
        ${renderPipeline(section, grid, eventId)}
        <button class="dp-history-toggle" data-section-id="${section.sectionId}" data-event-id="${eventId}">${escapeHtml(I18n.tr('dashboard.historyToggle'))} &#9660;</button>
        <div class="dp-history-panel" id="historyPanel_${section.sectionId}" style="display:none;"></div>
      </div>
    `;
  }

  function renderPipeline(section, grid, eventId) {
    const steps = section.steps || [];
    if (steps.length === 0) return '';
    const currentStatus = section.status || 'draft';

    let doneCount = 0;
    const stepStates = steps.map((step) => {
      const state = getStepState(step.role, currentStatus, section);
      if (state === 'done') doneCount++;
      return state;
    });

    let activeIdx = stepStates.indexOf('active');
    if (activeIdx === -1) activeIdx = doneCount - 1;
    const fillPct = steps.length > 1
      ? Math.max(0, Math.min(100, ((activeIdx >= 0 ? activeIdx : 0) / (steps.length - 1)) * 100))
      : 0;

    const stepsHtml = steps.map((step, i) => {
      const state = stepStates[i];
      const skipped = state === 'done' && !step.acted;
      const name = localizedName(step.actorName, step.actorNameKa) || roleLabel(step.role);
      const subtitle = step.departmentName || (step.role === 'CURATOR' || step.role === 'DEPUTY' ? roleLabel(step.role) : '');
      return `
        <div class="dp-pipeline__step dp-pipeline__step--${state}${skipped ? ' dp-pipeline__step--skipped' : ''}">
          <span class="dp-pipeline__dot" data-stage-action="show-users" data-stage-event="${eventId}" data-stage-section="${section.sectionId}" data-stage-role="${step.role}">${i + 1}</span>
          <span class="dp-pipeline__name" title="${escapeHtml(name)}${subtitle ? ' (' + escapeHtml(subtitle) + ')' : ''}">${escapeHtml(name)}</span>
          ${subtitle ? `<span class="dp-pipeline__dept">${escapeHtml(subtitle)}</span>` : ''}
        </div>
      `;
    }).join('');

    // While the section is in amendment, surface a separate banner so
    // the chain bar (showing the original approval history) doesn't get
    // hijacked into showing the DS as a chain role.
    const amendmentBanner = currentStatus === 'submitted_to_amending_ds'
      ? `<div class="dp-amendment-banner" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:6px;padding:6px 10px;margin:0 0 8px;font-size:12px;">
           <strong>${escapeHtml(I18n.tr('dashboard.amendmentInProgress'))}</strong>
           ${escapeHtml(I18n.tr('dashboard.amendmentNote'))}
         </div>`
      : '';

    return `
      ${amendmentBanner}
      <div class="dp-pipeline" style="position:relative;">
        <div class="dp-pipeline__bar">
          <div class="dp-pipeline__bar-fill" style="width:${fillPct}%"></div>
        </div>
        ${stepsHtml}
      </div>
    `;
  }

  function renderActionLinks(section, eventId, grid) {
    const effRole = section.userEffectiveRole || user.role;
    const holder = section.currentHolderRole;
    const isHolder = effRole === holder;
    const status = section.status || 'draft';
    const links = [];

    // Open (always)
    links.push(`<button class="dp-action-link dp-action-link--open" onclick="window.location.href='/pages/editor.html?event_id=${eventId}&section_id=${section.sectionId}'">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      ${escapeHtml(I18n.tr('dashboard.actionOpen'))}
    </button>`);

    if (isHolder) {
      if (status === 'draft' || status.startsWith('returned_')) {
        links.push(`<button class="dp-action-link dp-action-link--submit" data-action="submit" data-event="${eventId}" data-section="${section.sectionId}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          ${escapeHtml(I18n.tr('dashboard.actionSubmit'))}
        </button>`);
      }
      if (status === `submitted_to_${effRole.toLowerCase()}`) {
        links.push(`<button class="dp-action-link dp-action-link--approve" data-action="approve" data-event="${eventId}" data-section="${section.sectionId}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
          ${escapeHtml(I18n.tr('dashboard.actionApprove'))}
        </button>`);
        // Return doesn't apply to a DS amendment — the section was
        // already approved before the reopen, so there's nowhere to
        // return it to. DS either approves their changes or leaves
        // the amendment open.
        if (status !== 'submitted_to_amending_ds') {
          links.push(`<button class="dp-action-link dp-action-link--return" data-action="return" data-event="${eventId}" data-section="${section.sectionId}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            ${escapeHtml(I18n.tr('dashboard.actionReturn'))}
          </button>`);
        }
      }
    } else if (!isHolder && status !== 'draft' && status) {
      // Only show Ask Return if the user is in the chain and the section
      // has already passed their step
      const chain = section.chain || [];
      const userIdx = chain.indexOf(effRole);
      const holderIdx = chain.indexOf(holder);
      if (userIdx !== -1 && holderIdx > userIdx) {
        links.push(`<button class="dp-action-link dp-action-link--ask-return" data-action="ask-to-return" data-event="${eventId}" data-section="${section.sectionId}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          ${escapeHtml(I18n.tr('dashboard.actionAskReturn'))}
        </button>`);
      }
    }

    // Push Section — shown for both holders and non-holders when canPush is true
    if (section.canPush) {
      links.push(`<button class="dp-action-link dp-action-link--push" data-action="push-section" data-event="${eventId}" data-section="${section.sectionId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        ${escapeHtml(I18n.tr('editor.pushSection'))}
      </button>`);
    }

    // Pull Section — pull from a user earlier in the chain
    if (section.canPull) {
      links.push(`<button class="dp-action-link dp-action-link--pull" data-action="pull-section" data-event="${eventId}" data-section="${section.sectionId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        ${escapeHtml(I18n.tr('editor.pullSection'))}
      </button>`);
    }

    return links.join('');
  }

  // ── Stage Users Popover ──────────────────────────────────────────────────

  function closeStagePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function createStagePopover(anchorEl, initialHtml) {
    const popover = document.createElement('div');
    popover.className = 'dp-stage-popover';
    popover.innerHTML = `
      <div class="dp-popover__header">
        <span class="dp-popover__title">${escapeHtml(I18n.tr('dashboard.eligibleUsers'))}</span>
        <button class="dp-popover__close">&times;</button>
      </div>
      <div class="dp-popover__body">${initialHtml}</div>
    `;
    document.body.appendChild(popover);
    activePopover = popover;

    // Position below the anchor dot
    const rect = anchorEl.getBoundingClientRect();
    const popW = popover.offsetWidth;
    let top = rect.bottom + 8;
    let left = rect.left + rect.width / 2 - popW / 2;
    if (left < 8) left = 8;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';

    popover.querySelector('.dp-popover__close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeStagePopover();
    });
    popover.addEventListener('click', (e) => e.stopPropagation());

    return popover;
  }

  function renderStageUsers(data) {
    if (!data.users || data.users.length === 0) {
      return `<div class="dp-popover__empty">${escapeHtml(I18n.tr('dashboard.noEligibleUsers'))}</div>`;
    }
    const label = roleLabel(data.role);
    const rows = data.users.map(u => `
      <div class="dp-popover__user">
        <span class="dp-popover__user-name">${escapeHtml(localizedName(u.fullName, u.fullNameKa))}</span>
        ${u.departmentName ? `<span class="dp-popover__user-dept">${escapeHtml(u.departmentName)}</span>` : ''}
      </div>
    `).join('');
    return `<div class="dp-popover__role-title">${escapeHtml(label)}</div>${rows}`;
  }

  function bindStagePopover() {
    document.querySelectorAll('[data-stage-action="show-users"]').forEach(dot => {
      dot.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeStagePopover();
        const eventId = dot.dataset.stageEvent;
        const sectionId = dot.dataset.stageSection;
        const role = dot.dataset.stageRole;
        const popover = createStagePopover(dot, `<div class="dp-popover__loading">${escapeHtml(I18n.tr('dashboard.loading'))}</div>`);
        try {
          const data = await Api.get(`/api/workflow/stage-users?event_id=${eventId}&section_id=${sectionId}&role=${encodeURIComponent(role)}`);
          popover.querySelector('.dp-popover__body').innerHTML = renderStageUsers(data);
        } catch (err) {
          popover.querySelector('.dp-popover__body').innerHTML = `<div class="dp-popover__empty">${escapeHtml(err.message)}</div>`;
        }
      });
    });
    document.addEventListener('click', closeStagePopover);
  }

  function getStepState(role, status, section) {
    const chain = section.chain || [];
    const roleIdx = chain.indexOf(role);
    if (roleIdx === -1) return 'todo';

    // The DS amendment lives outside the chain. While it's in
    // progress (submitted_to_amending_ds) and once the DS has
    // approved it (approved_by_ds_amendment), every chain step
    // shows as already done — which is the truth before the reopen
    // and after the amendment finalises. The DS doesn't appear in
    // any chain slot at all.
    if (status === 'submitted_to_amending_ds' || status === 'approved_by_ds_amendment') {
      return 'done';
    }

    if (status === 'draft') {
      return roleIdx === 0 ? 'active' : 'todo';
    }
    if (status.startsWith('submitted_to_')) {
      const target = status.replace('submitted_to_', '').toUpperCase();
      const targetIdx = chain.indexOf(target);
      if (roleIdx < targetIdx) return 'done';
      if (roleIdx === targetIdx) return 'active';
      return 'todo';
    }
    if (status.startsWith('approved_by_')) {
      const approver = status.replace('approved_by_', '').toUpperCase();
      const approverIdx = chain.indexOf(approver);
      if (roleIdx <= approverIdx) return 'done';
      if (roleIdx === approverIdx + 1) return 'active';
      return 'todo';
    }
    if (status.startsWith('returned_')) {
      return roleIdx === 0 ? 'active' : 'todo';
    }
    return 'todo';
  }

  function bindActions(eventId, grid) {
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        const sectionId = parseInt(btn.dataset.section);
        const evId = parseInt(btn.dataset.event);

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
          loadSections(evId);
        } catch (err) {
          toast.error(err.message);
        }
      });
    });
  }

  function bindApproveAll(eventId, sectionsToApprove) {
    const btn = document.getElementById('approveAllBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!await GCP.ActionDialog.confirm(I18n.tr('dashboard.confirmApproveAll').replace('{n}', sectionsToApprove.length), { confirmLabel: I18n.tr('dashboard.approveAll'), confirmColor: '#16a34a' })) return;
      try {
        for (const s of sectionsToApprove) {
          await Api.post('/api/workflow/approve', { eventId: parseInt(eventId), sectionId: s.sectionId });
        }
        loadSections(eventId);
      } catch (err) {
        toast.error(err.message);
        loadSections(eventId);
      }
    });
  }

  // ── History Panel ──────────────────────────────────────────────────────────

  const HISTORY_STAGE_ROLES = [
    'COLLABORATOR', 'HEAD_COLLABORATOR', 'SUPER_COLLABORATOR', 'CURATOR',
    'SUPERVISOR', 'DEPUTY', 'RECEIVING_SUPER_COLLABORATOR', 'RECEIVING_SUPERVISOR',
  ];

  function historyStageLabel(role) {
    if (role === 'RECEIVING_SUPER_COLLABORATOR') return I18n.tr('editor.history.stage.scReview');
    if (role === 'RECEIVING_SUPERVISOR') return I18n.tr('editor.history.stage.svReview');
    return roleLabel(role);
  }

  // bg/color stay literal (colours don't localise); the label is an
  // i18n key under editor.history.action.* with an English fallback.
  const ACTION_COLORS = {
    saved:           { bg: '#ede9fe', color: '#5b21b6', key: 'saved',        en: 'Edited' },
    submitted:       { bg: '#dbeafe', color: '#1d4ed8', key: 'submitted',    en: 'Submitted' },
    approved:        { bg: '#dcfce7', color: '#15803d', key: 'approved',     en: 'Approved' },
    returned:        { bg: '#fee2e2', color: '#b91c1c', key: 'returned',     en: 'Returned' },
    asked_to_return: { bg: '#fef3c7', color: '#92400e', key: 'askedToReturn', en: 'Asked to Return' },
    pushed:          { bg: '#e0e7ff', color: '#4338ca', key: 'pushed',       en: 'Pushed' },
    pulled:          { bg: '#e0e7ff', color: '#4338ca', key: 'pulled',       en: 'Pulled' },
  };

  function actionLabel(action) {
    const ac = ACTION_COLORS[action];
    if (!ac) return action;
    return _i18n(`editor.history.action.${ac.key}`, ac.en);
  }

  function formatHistoryDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleString((typeof _dateLocale === 'function') ? _dateLocale() : 'en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function renderHistoryTimeline(history) {
    if (!history || history.length === 0) {
      return `<p style="color: var(--text-muted); font-size: 13px;">${escapeHtml(I18n.tr('dashboard.noHistory'))}</p>`;
    }

    // Group by role
    const byRole = {};
    for (const h of history) {
      const r = h.userRole || 'UNKNOWN';
      if (!byRole[r]) byRole[r] = [];
      byRole[r].push(h);
    }

    // Collapse consecutive saves by same user
    function collapseEntries(entries) {
      const collapsed = [];
      for (const ev of entries) {
        const last = collapsed[collapsed.length - 1];
        if (last && last.action === 'saved' && ev.action === 'saved' && last.userName === ev.userName) {
          last.actedAt = ev.actedAt;
          last._count = (last._count || 1) + 1;
        } else {
          collapsed.push({ ...ev });
        }
      }
      return collapsed;
    }

    const orderedRoles = [];
    for (const role of HISTORY_STAGE_ROLES) {
      if (byRole[role]) orderedRoles.push(role);
    }
    for (const role of Object.keys(byRole)) {
      if (!HISTORY_STAGE_ROLES.includes(role)) orderedRoles.push(role);
    }

    return '<div class="sh-timeline">' + orderedRoles.map(role => {
      const entries = collapseEntries(byRole[role]);
      const eventsHtml = entries.map(h => {
        const ac = ACTION_COLORS[h.action] || { bg: '#f1f5f9', color: '#475569' };
        const actor = escapeHtml(h.userName || I18n.tr('editor.history.unknownUser'));
        const date = formatHistoryDate(h.actedAt);
        const baseLabel = actionLabel(h.action);
        const label = h.action === 'saved' && h._count > 1
          ? `${baseLabel} (\u00d7${h._count})` : baseLabel;

        if (h.action === 'returned' || h.action === 'asked_to_return') {
          const noteHtml = h.note
            ? escapeHtml(h.note)
            : `<span class="sh-return-note__empty">${escapeHtml(I18n.tr('editor.history.noComment'))}</span>`;
          return `<div class="sh-event">
            <span class="sh-actor">${actor}</span>
            <details class="sh-return-details${h.action === 'asked_to_return' ? ' sh-return-details--ask' : ''}">
              <summary>${escapeHtml(label)}</summary>
              <div class="sh-return-note">${noteHtml}</div>
            </details>
            <span class="sh-date">${date}</span>
          </div>`;
        }

        return `<div class="sh-event">
          <span class="sh-actor">${actor}</span>
          <span class="sh-action-tag" style="background:${ac.bg};color:${ac.color}">${escapeHtml(label)}</span>
          <span class="sh-date">${date}</span>
        </div>`;
      }).join('');

      return `<div class="sh-stage">
        <div class="sh-dot"></div>
        <div class="sh-body">
          <div class="sh-stage-label">${escapeHtml(historyStageLabel(role).toUpperCase())}</div>
          <div class="sh-events">${eventsHtml}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  function bindHistoryToggles() {
    document.querySelectorAll('.dp-history-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sectionId = btn.dataset.sectionId;
        const eventId = btn.dataset.eventId;
        const panel = document.getElementById('historyPanel_' + sectionId);
        if (!panel) return;

        if (panel.style.display !== 'none') {
          panel.style.display = 'none';
          btn.innerHTML = `${escapeHtml(I18n.tr('dashboard.historyToggle'))} &#9660;`;
          return;
        }

        panel.style.display = 'block';
        btn.innerHTML = `${escapeHtml(I18n.tr('dashboard.historyToggle'))} &#9650;`;
        panel.innerHTML = `<p style="color: var(--text-muted); font-size: 13px;">${escapeHtml(I18n.tr('dashboard.loading'))}</p>`;

        try {
          const result = await Api.get(`/api/workflow/section-history?event_id=${eventId}&section_id=${sectionId}`);
          const history = result.history || result;
          panel.innerHTML = renderHistoryTimeline(history);
        } catch (err) {
          panel.innerHTML = `<p style="color: var(--accent-red); font-size: 13px;">${escapeHtml(err.message)}</p>`;
        }
      });
    });
  }

  function bindSendToLibrary(eventId) {
    const btn = document.getElementById('sendToLibraryBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!await GCP.ActionDialog.confirm(I18n.tr('dashboard.sendToLibrary'), { confirmLabel: I18n.tr('dashboard.sendToLibrary'), confirmColor: '#3b82f6' })) return;
      try {
        await Api.post('/api/workflow/send-to-library', { eventId: parseInt(eventId) });
        toast.success(I18n.tr('dashboard.sentToLibrary'));
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        toast.error(err.message);
      }
    });
  }

  eventSelect.addEventListener('change', () => loadSections(eventSelect.value));
  if (eventSelect.value) loadSections(eventSelect.value);
})();
