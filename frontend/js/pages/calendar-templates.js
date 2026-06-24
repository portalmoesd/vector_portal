/**
 * Calendar Templates — manage section templates.
 * Any user who can create events can also create their own templates.
 * The Default Template is shown but cannot be deleted.
 */
(async function () {
  const user = Api.getUser();
  if (!user) return;

  const CAN_CREATE = ['ADMIN', 'PROTOCOL', 'DEPUTY', 'SUPERVISOR', 'SUPER_COLLABORATOR'];
  if (!CAN_CREATE.includes(user.role)) return;

  const card = document.getElementById('templatesCard');
  const container = document.getElementById('templatesContainer');
  const createBtn = document.getElementById('createTemplateBtn');
  const modal = document.getElementById('templateModal');
  const modalTitle = document.getElementById('templateModalTitle');
  const modalBody = document.getElementById('templateModalBody');
  const modalCancel = document.getElementById('templateModalCancel');
  const modalSave = document.getElementById('templateModalSave');
  if (!card || !container) return;

  card.style.display = '';

  let departments = [];
  let templates = [];
  let groupedData = null;
  let onModalSave = null;

  try {
    [departments, templates, groupedData] = await Promise.all([
      Api.get('/api/departments'),
      Api.get('/api/templates'),
      Api.get('/api/departments/grouped'),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    return;
  }

  const deptById = {};
  departments.forEach(d => { deptById[d.id] = d; });

  // Build set of department IDs assigned to deputies
  const assignedDeptIds = new Set();
  if (groupedData && groupedData.deputies) {
    for (const deputy of groupedData.deputies) {
      for (const id of deputy.departmentIds) assignedDeptIds.add(id);
    }
  }

  const internalDepts = departments.filter(d => !d.isExternal && assignedDeptIds.has(d.id));
  const externalDepts = departments.filter(d => d.isExternal && assignedDeptIds.has(d.id));

  /* ── Custom Department Picker ─────────────────────────────────────────── */

  function createDeptPicker(row, onAdd, getSelected) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tpl-dept-picker-wrap';
    wrapper.style.cssText = 'position:relative;flex:1;min-width:200px;';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'form-input tpl-dept-picker-trigger';
    trigger.style.cssText = 'width:100%;text-align:left;cursor:pointer;font-size:13px;color:#666;display:flex;align-items:center;justify-content:space-between;padding:6px 10px;';
    trigger.innerHTML = '+ Add department... <span style="font-size:10px;opacity:.5;">\u25BC</span>';

    const panel = document.createElement('div');
    panel.className = 'tpl-dept-picker-panel';
    panel.style.cssText = 'display:none;position:fixed;background:var(--bg-card,#fff);border:1px solid var(--border-color,#ddd);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:9999;max-height:420px;overflow:hidden;flex-direction:column;';

    // Search input
    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'padding:8px 10px;border-bottom:1px solid var(--border-color,#eee);';
    const searchInput = document.createElement('input');
    searchInput.className = 'form-input';
    searchInput.placeholder = 'Search departments...';
    searchInput.style.cssText = 'width:100%;font-size:13px;padding:6px 8px;';
    searchWrap.appendChild(searchInput);

    // Items container
    const itemsWrap = document.createElement('div');
    itemsWrap.style.cssText = 'overflow-y:auto;flex:1;padding:6px 0;';

    panel.appendChild(searchWrap);
    panel.appendChild(itemsWrap);
    wrapper.appendChild(trigger);
    // Append panel to document.body so it isn't clipped by modal overflow
    // or offset by ancestor transforms/backdrop-filters
    document.body.appendChild(panel);

    let isOpen = false;

    function buildItems(filter) {
      const selected = getSelected();
      const q = (filter || '').toLowerCase();
      let html = '';

      // Deputies groups
      if (groupedData && groupedData.deputies) {
        for (const deputy of groupedData.deputies) {
          const deptItems = deputy.departmentIds
            .map(id => deptById[id])
            .filter(Boolean)
            .filter(d => !q || (d.nameEn || d.name).toLowerCase().includes(q));
          if (deptItems.length === 0) continue;

          html += `<div class="tpl-pick-group" style="padding:4px 0;">
            <div style="padding:4px 14px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;">
              ${escapeHtml(localizedName(deputy.deputyName, deputy.deputyNameKa))}
            </div>`;
          for (const d of deptItems) {
            const isSel = selected.has(d.id);
            const pillClass = d.isExternal ? 'pill-yellow' : 'pill-blue';
            html += `<div class="tpl-pick-item ${isSel ? 'tpl-pick-disabled' : ''}" data-dept-id="${d.id}" style="padding:5px 14px 5px 24px;font-size:13px;cursor:${isSel ? 'default' : 'pointer'};color:${isSel ? '#aaa' : 'inherit'};display:flex;align-items:center;gap:6px;${!isSel ? '' : 'text-decoration:line-through;opacity:.5;'}">
              ${d.isExternal ? '<span class="pill ' + pillClass + '" style="font-size:10px;padding:1px 6px;">Agency</span>' : ''}
              ${escapeHtml(d.nameEn || d.name)}
            </div>`;
          }
          html += '</div>';
        }
      }

      if (!html) {
        html = '<div style="padding:12px 14px;font-size:13px;color:#999;text-align:center;">No departments found</div>';
      }

      itemsWrap.innerHTML = html;

      // Attach click handlers
      itemsWrap.querySelectorAll('.tpl-pick-item:not(.tpl-pick-disabled)').forEach(el => {
        el.addEventListener('click', () => {
          const id = parseInt(el.dataset.deptId);
          onAdd(id);
          buildItems(searchInput.value);
        });
        el.addEventListener('mouseenter', () => { el.style.background = 'rgba(10,132,255,.08)'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
      });
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      // Position fixed panel below the trigger button
      const rect = trigger.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = (rect.bottom + 4) + 'px';
      panel.style.width = rect.width + 'px';
      panel.style.display = 'flex';
      searchInput.value = '';
      buildItems('');
      searchInput.focus();
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.style.display = 'none';
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen) close(); else open();
    });

    searchInput.addEventListener('input', () => buildItems(searchInput.value));
    searchInput.addEventListener('click', (e) => e.stopPropagation());

    panel.addEventListener('click', (e) => e.stopPropagation());

    // Close when clicking outside
    document.addEventListener('click', () => close());

    function destroy() {
      close();
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }

    return { wrapper, refresh: () => { if (isOpen) buildItems(searchInput.value); }, destroy };
  }

  /* ── Section Row Logic ────────────────────────────────────────────────── */

  function initSectionRow(row) {
    const pillsContainer = row.querySelector('.tpl-dept-pills');
    let picker = null;

    function getSelectedIds() {
      return new Set(
        Array.from(row.querySelectorAll('.tpl-dept-pill'))
          .map(p => parseInt(p.dataset.deptId))
      );
    }

    function addDeptPill(deptId) {
      const d = deptById[deptId];
      if (!d) return;
      if (row.querySelector(`.tpl-dept-pill[data-dept-id="${deptId}"]`)) return;
      const pill = document.createElement('span');
      pill.className = d.isExternal ? 'pill pill-yellow tpl-dept-pill' : 'pill pill-blue tpl-dept-pill';
      pill.dataset.deptId = deptId;
      pill.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:3px 10px;margin:2px;';
      pill.title = 'Click to remove';
      pill.innerHTML = `${escapeHtml(d.nameEn || d.name)} <span style="font-size:14px;line-height:1;opacity:0.6;">\u00d7</span>`;
      pill.addEventListener('click', () => {
        pill.remove();
        updateCount();
        if (picker) picker.refresh();
      });
      pillsContainer.appendChild(pill);
    }

    function updateCount() {
      const count = row.querySelectorAll('.tpl-dept-pill').length;
      row.querySelector('.tpl-dept-count').textContent = count + ' dept(s)';
    }

    // Create custom picker
    const pickerContainer = row.querySelector('.tpl-dept-picker-slot');
    picker = createDeptPicker(row, (deptId) => {
      addDeptPill(deptId);
      updateCount();
    }, getSelectedIds);
    pickerContainer.appendChild(picker.wrapper);

    // Quick-add buttons
    row.querySelector('.tpl-add-all-depts').addEventListener('click', () => {
      internalDepts.forEach(d => addDeptPill(d.id));
      updateCount();
      if (picker) picker.refresh();
    });
    row.querySelector('.tpl-add-all-agencies').addEventListener('click', () => {
      externalDepts.forEach(d => addDeptPill(d.id));
      updateCount();
      if (picker) picker.refresh();
    });

    return { addDeptPill, updateCount };
  }

  /* ── Render Templates List ────────────────────────────────────────────── */

  function renderTemplates() {
    if (templates.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No templates yet. Create one to preset sections for your events.</p></div>';
      return;
    }

    container.innerHTML = templates.map(t => {
      const totalDepts = t.sections.reduce((sum, s) => sum + (s.departmentIds || []).length, 0);

      const sectionsList = t.sections.map(s => {
        const deptNames = (s.departmentIds || [])
          .map(id => {
            const d = deptById[id];
            return d ? escapeHtml(d.nameEn || d.name) : '';
          })
          .filter(Boolean)
          .join(', ');
        return `<li style="margin-bottom:6px;">
          <strong>${escapeHtml(s.title)}</strong>
          ${deptNames ? `<span style="color:#666;font-size:12px;"> \u2014 ${deptNames}</span>` : ''}
        </li>`;
      }).join('');

      const badge = t.isDefault
        ? '<span class="pill pill-green" style="margin-left:8px;font-size:11px;">Default</span>'
        : '';

      const actionBtns = t.isDefault
        ? ''
        : `<button class="btn btn-outline" style="font-size:12px;padding:5px 14px;" onclick="event.stopPropagation();editTemplate(${t.id})">${escapeHtml(I18n.tr('common.edit'))}</button>
           <button class="btn btn-danger" style="font-size:12px;padding:5px 14px;" onclick="event.stopPropagation();deleteTemplate(${t.id})">${escapeHtml(I18n.tr('common.delete'))}</button>`;

      return `
        <div class="tpl-expand-card" style="border:1px solid var(--border,rgba(0,0,0,.10));border-radius:16px;margin-bottom:10px;background:rgba(255,255,255,.62);backdrop-filter:blur(12px);box-shadow:0 2px 8px rgba(0,0,0,.04);transition:box-shadow .2s,border-color .2s;overflow:hidden;">
          <div class="tpl-expand-header" style="display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;user-select:none;">
            <span class="tpl-expand-arrow" style="font-size:11px;color:#888;transition:transform .2s;flex-shrink:0;">\u25b6</span>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-weight:700;font-size:15px;">${escapeHtml(t.name)}</span>
                ${badge}
              </div>
              <div style="font-size:12px;color:var(--muted,#666);margin-top:2px;">
                ${t.sections.length} section(s) &middot; ${totalDepts} department(s)${t.createdByName ? ' &middot; By: ' + escapeHtml(localizedName(t.createdByName, t.createdByNameKa)) : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;" onclick="event.stopPropagation()">${actionBtns}</div>
          </div>
          <div class="tpl-expand-body" style="display:none;padding:0 18px 16px 42px;border-top:1px solid var(--border,rgba(0,0,0,.06));">
            <ol style="margin:12px 0 0 18px;font-size:13px;line-height:1.5;">${sectionsList || '<li>No sections</li>'}</ol>
          </div>
        </div>
      `;
    }).join('');

    // Attach expand/collapse handlers
    container.querySelectorAll('.tpl-expand-card').forEach(card => {
      const header = card.querySelector('.tpl-expand-header');
      const body = card.querySelector('.tpl-expand-body');
      const arrow = card.querySelector('.tpl-expand-arrow');
      header.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        arrow.style.transform = open ? '' : 'rotate(90deg)';
        card.style.boxShadow = open ? '0 2px 8px rgba(0,0,0,.04)' : '0 4px 16px rgba(0,0,0,.08)';
        card.style.borderColor = open ? '' : 'rgba(10,132,255,.18)';
      });
      // Hover effect
      header.addEventListener('mouseenter', () => { card.style.boxShadow = '0 4px 14px rgba(0,0,0,.07)'; });
      header.addEventListener('mouseleave', () => {
        const open = body.style.display !== 'none';
        card.style.boxShadow = open ? '0 4px 16px rgba(0,0,0,.08)' : '0 2px 8px rgba(0,0,0,.04)';
      });
    });
  }

  window.deleteTemplate = async function(id) {
    if (!confirm(I18n.tr('calendar.templates.confirmDelete'))) return;
    try {
      await Api.delete(`/api/templates/${id}`);
      templates = templates.filter(t => t.id !== id);
      renderTemplates();
    } catch (e) { toast.error(e.message); }
  };

  /* ── Modal Helpers ────────────────────────────────────────────────────── */

  function showTemplateModal(title, bodyHtml, saveLabel, saveFn) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    modalSave.textContent = saveLabel || I18n.tr('common.save');
    if (typeof I18n !== 'undefined' && I18n.translateRoot) I18n.translateRoot(modal);
    onModalSave = saveFn;
    modal.style.display = 'flex';
  }

  function hideTemplateModal() { modal.style.display = 'none'; onModalSave = null; }

  modalCancel.addEventListener('click', hideTemplateModal);
  modalSave.addEventListener('click', () => { if (onModalSave) onModalSave(); });

  /* ── Create / Edit Template ───────────────────────────────────────────── */

  // Opens the template modal. Pass an existing template to edit it, or
  // omit it (null) to create a new one.
  function openTemplateEditor(existing) {
    const isEdit = !!existing;

    showTemplateModal(
      isEdit ? I18n.tr('calendar.templates.modalEdit') : I18n.tr('calendar.templates.modalCreate'),
      `
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('calendar.templates.nameLabel'))}</label>
        <input class="form-input" id="tplName" placeholder="${escapeHtml(I18n.tr('calendar.templates.namePlaceholder'))}" />
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:700;">${escapeHtml(I18n.tr('calendar.form.sections'))}</label>
        <div id="tplSectionRows"></div>
        <button class="btn btn-outline" type="button" id="tplAddSection" style="margin-top:8px;">${escapeHtml(I18n.tr('calendar.form.addSection'))}</button>
      </div>
    `,
      isEdit ? I18n.tr('common.save') : I18n.tr('common.create'),
      async () => {
        const name = document.getElementById('tplName').value.trim();
        if (!name) { toast.warn(I18n.tr('calendar.templates.warnName')); return; }

        const sections = [];
        document.querySelectorAll('#tplSectionRows .tpl-section-row').forEach((row, i) => {
          const title = row.querySelector('.tpl-sec-title').value.trim();
          const deptIds = Array.from(row.querySelectorAll('.tpl-dept-pill'))
            .map(pill => parseInt(pill.dataset.deptId));
          if (title) sections.push({ title, sortOrder: i, departmentIds: deptIds });
        });

        if (sections.length === 0) { toast.warn(I18n.tr('calendar.warn.missingSection')); return; }

        try {
          if (isEdit) {
            await Api.put(`/api/templates/${existing.id}`, { name, sections });
          } else {
            await Api.post('/api/templates', { name, sections });
          }
          hideTemplateModal();
          templates = await Api.get('/api/templates');
          renderTemplates();
        } catch (err) { toast.error(err.message); }
      }
    );

    const rowsContainer = document.getElementById('tplSectionRows');
    const addBtn = document.getElementById('tplAddSection');

    function addSectionRow(section) {
      const row = document.createElement('div');
      row.className = 'tpl-section-row';
      row.style.cssText = 'border:1px solid var(--border-color,#ddd);border-radius:12px;margin-bottom:10px;';
      row.innerHTML = `
        <div class="tpl-sec-header" style="display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none;">
          <span class="tpl-sec-toggle" style="font-size:11px;color:#888;transition:transform .2s;">\u25b6</span>
          <input class="form-input tpl-sec-title" placeholder="Section title" style="flex:1;font-weight:600;border:none;padding:0;background:transparent;" onclick="event.stopPropagation()" />
          <span class="tpl-dept-count" style="font-size:12px;color:#666;white-space:nowrap;">0 dept(s)</span>
          <button class="btn btn-outline" type="button" style="padding:2px 8px;font-size:11px;color:#dc2626;" onclick="event.stopPropagation();this.closest('.tpl-section-row').remove()">\u00d7</button>
        </div>
        <div class="tpl-sec-body" style="display:none;padding:8px 14px 14px 14px;border-top:1px solid var(--border-color,#eee);">
          <div class="tpl-dept-pills" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;min-height:8px;"></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div class="tpl-dept-picker-slot" style="flex:1;min-width:200px;"></div>
            <button type="button" class="btn btn-outline tpl-add-all-depts" style="padding:3px 10px;font-size:11px;white-space:nowrap;">All Depts</button>
            <button type="button" class="btn btn-outline tpl-add-all-agencies" style="padding:3px 10px;font-size:11px;white-space:nowrap;">All Agencies</button>
          </div>
        </div>
      `;
      rowsContainer.appendChild(row);

      // Expand/collapse
      const header = row.querySelector('.tpl-sec-header');
      const body = row.querySelector('.tpl-sec-body');
      const toggle = row.querySelector('.tpl-sec-toggle');
      header.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        toggle.style.transform = open ? '' : 'rotate(90deg)';
      });

      const ctrl = initSectionRow(row);

      // Prefill when editing an existing section
      if (section) {
        row.querySelector('.tpl-sec-title').value = section.title || '';
        (section.departmentIds || []).forEach(id => ctrl.addDeptPill(id));
        ctrl.updateCount();
      }

      // Auto-expand new rows
      body.style.display = '';
      toggle.style.transform = 'rotate(90deg)';
    }

    addBtn.addEventListener('click', () => addSectionRow());

    document.getElementById('tplName').value = isEdit ? (existing.name || '') : '';
    if (isEdit && existing.sections && existing.sections.length > 0) {
      existing.sections.forEach(s => addSectionRow(s));
    } else {
      addSectionRow();
    }
  }

  createBtn.addEventListener('click', () => openTemplateEditor(null));

  window.editTemplate = function(id) {
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    openTemplateEditor(tpl);
  };

  renderTemplates();
})();
