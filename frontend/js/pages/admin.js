/**
 * Admin Panel — Departments, Users, Deputy–Supervisor Links
 * Features: CRUD, country assignment with region-based checkboxes, user editing
 */
(async function () {
  await App.init();

  // ── Region definitions (UI-only groupings per §3.4) ─────────────────────────
  const REGIONS = {
    'Neighbors': ['BY','UA','MD','RU','AZ','AM','KZ','TJ','KG','UZ','TM'],
    'EU': ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'],
    'Other Europe': ['AL','AD','BA','CH','IS','LI','MC','ME','MK','NO','RS','SM','TR','GB','VA','GE','XK'],
    'North America': ['US','CA','MX','GL','BM'],
    'Central America & Caribbean': ['BZ','CR','SV','GT','HN','NI','PA','AG','BS','BB','CU','DM','DO','GD','HT','JM','KN','LC','VC','TT','PR'],
    'South America': ['AR','BO','BR','CL','CO','EC','GY','PY','PE','SR','UY','VE','FK','GF'],
    'Africa': ['DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RW','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'],
    'Asia': ['AF','BH','BD','BT','BN','KH','CN','IN','ID','IR','IQ','IL','JP','JO','KW','LA','LB','MY','MV','MN','MM','NP','KP','OM','PK','PH','QA','SA','SG','KR','LK','SY','TW','TH','TL','AE','VN','YE'],
    'Oceania': ['AU','NZ','FJ','FM','KI','MH','NR','PW','PG','WS','SB','TO','TV','VU'],
  };

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).style.display = '';
    });
  });

  // ── Modal helpers ──────────────────────────────────────────────────────────
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalCancel = document.getElementById('modalCancel');
  const modalSave = document.getElementById('modalSave');
  let onSave = null;

  function showModal(title, bodyHtml, saveFn) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    if (typeof I18n !== 'undefined' && I18n.translateRoot) I18n.translateRoot(modal);
    onSave = saveFn;
    modal.style.display = 'flex';
  }

  function hideModal() {
    modal.style.display = 'none';
    onSave = null;
  }

  modalCancel.addEventListener('click', hideModal);
  modalSave.addEventListener('click', () => { if (onSave) onSave(); });

  // ── Shared data ─────────────────────────────────────────────────────────────
  let departments = [];
  let allCountries = [];

  // Load countries once
  try { allCountries = await Api.get('/api/countries'); } catch(e) { console.error(e); }

  // ── Country picker HTML generation ──────────────────────────────────────────

  function buildCountryPickerHtml(selectedIds) {
    const selected = new Set(selectedIds || []);
    let html = '<div class="country-picker" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:8px;">';

    for (const [region, codes] of Object.entries(REGIONS)) {
      const countriesInRegion = allCountries.filter(c => codes.includes(c.code));
      if (countriesInRegion.length === 0) continue;

      const allChecked = countriesInRegion.every(c => selected.has(c.id));
      const someChecked = countriesInRegion.some(c => selected.has(c.id));

      html += `<div class="region-group" style="margin-bottom:8px;">
        <label style="font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 0;">
          <input type="checkbox" class="region-toggle" data-region="${region}"
            ${allChecked ? 'checked' : ''} ${someChecked && !allChecked ? 'indeterminate' : ''} />
          ${escapeHtml(region)} (${countriesInRegion.length})
        </label>
        <div class="region-countries" style="display:none;padding-left:20px;columns:2;column-gap:12px;">
          ${countriesInRegion.map(c => `
            <label style="display:flex;align-items:center;gap:4px;padding:1px 0;font-size:13px;break-inside:avoid;cursor:pointer;">
              <input type="checkbox" class="country-cb" data-country-id="${c.id}" data-region="${region}"
                ${selected.has(c.id) ? 'checked' : ''} />
              ${escapeHtml(c.name_en || c.nameEn || c.name)}
            </label>
          `).join('')}
        </div>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  function initCountryPicker(container) {
    // Toggle region expand
    container.querySelectorAll('.region-group > label').forEach(label => {
      label.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const countries = label.nextElementSibling;
        countries.style.display = countries.style.display === 'none' ? '' : 'none';
      });
    });

    // Region toggle all
    container.querySelectorAll('.region-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const region = toggle.dataset.region;
        container.querySelectorAll(`.country-cb[data-region="${region}"]`).forEach(cb => {
          cb.checked = toggle.checked;
        });
      });
    });

    // Country checkbox updates region state
    container.querySelectorAll('.country-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const region = cb.dataset.region;
        const cbs = container.querySelectorAll(`.country-cb[data-region="${region}"]`);
        const toggle = container.querySelector(`.region-toggle[data-region="${region}"]`);
        const checkedCount = Array.from(cbs).filter(c => c.checked).length;
        toggle.checked = checkedCount === cbs.length;
        toggle.indeterminate = checkedCount > 0 && checkedCount < cbs.length;
      });
    });
  }

  function getSelectedCountryIds(container) {
    return Array.from(container.querySelectorAll('.country-cb:checked'))
      .map(cb => parseInt(cb.dataset.countryId));
  }

  // ── Departments ────────────────────────────────────────────────────────────
  async function loadDepartments() {
    try {
      const depts = await Api.get('/api/departments');
      if (depts.length === 0) {
        document.getElementById('deptList').innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('admin.dept.empty'))}</p></div>`;
        return depts;
      }
      document.getElementById('deptList').innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>${escapeHtml(I18n.tr('admin.dept.col.nameKa'))}</th><th>${escapeHtml(I18n.tr('admin.dept.col.nameEn'))}</th><th>${escapeHtml(I18n.tr('admin.dept.col.type'))}</th></tr></thead>
          <tbody>${depts.map((d, i) => `
            <tr><td>${i + 1}</td><td>${escapeHtml(d.name)}</td><td>${d.nameEn ? escapeHtml(d.nameEn) : '—'}</td><td><span class="pill ${d.isExternal ? 'pill-yellow' : 'pill-blue'}">${escapeHtml(I18n.tr(d.isExternal ? 'admin.dept.type.agency' : 'admin.dept.type.department'))}</span></td></tr>
          `).join('')}</tbody>
        </table></div>`;
      return depts;
    } catch (e) {
      document.getElementById('deptList').innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
      return [];
    }
  }

  document.getElementById('addDeptBtn').addEventListener('click', () => {
    showModal(I18n.tr('admin.dept.modal.add'), `
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.dept.form.name'))}</label>
        <input class="form-input" id="deptName" required />
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="deptExternal" /> ${escapeHtml(I18n.tr('admin.dept.form.external'))}</label>
      </div>
    `, async () => {
      const name = document.getElementById('deptName').value.trim();
      if (!name) return;
      try {
        await Api.post('/api/departments', { name, isExternal: document.getElementById('deptExternal').checked });
        hideModal();
        departments = await loadDepartments();
      } catch (e) { toast.error(e.message); }
    });
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const users = await Api.get('/api/users');
      if (users.length === 0) {
        document.getElementById('userList').innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('admin.user.empty'))}</p></div>`;
        return;
      }
      document.getElementById('userList').innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>${escapeHtml(I18n.tr('admin.user.col.name'))}</th><th>${escapeHtml(I18n.tr('admin.user.col.username'))}</th><th>${escapeHtml(I18n.tr('admin.user.col.role'))}</th><th>${escapeHtml(I18n.tr('admin.user.col.dept'))}</th><th>${escapeHtml(I18n.tr('admin.user.col.external'))}</th><th>${escapeHtml(I18n.tr('admin.user.col.actions'))}</th></tr></thead>
          <tbody>${users.map(u => `
            <tr>
              <td>${escapeHtml(u.fullName)}</td>
              <td>${escapeHtml(u.username)}</td>
              <td><span class="pill pill-blue">${roleLabel(u.role)}</span></td>
              <td>${u.isExternal ? (u.entityName ? escapeHtml(u.entityName) : '—') : (u.departmentName ? escapeHtml(u.departmentName) : '—')}</td>
              <td>${escapeHtml(I18n.tr(u.isExternal ? 'common.yes' : 'common.no'))}</td>
              <td>
                <button class="btn btn-outline" style="padding:4px 10px;font-size:12px;" onclick="editUser(${u.id})">${escapeHtml(I18n.tr('common.edit'))}</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table></div>`;
    } catch (e) {
      document.getElementById('userList').innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    }
  }

  function userFormHtml(deptOptions, user) {
    const isEdit = !!user;
    const needsCountries = !user || user.role === 'COLLABORATOR' || user.role === 'SUPER_COLLABORATOR';
    // External users are tied to an outside entity (embassy, NGO, partner
    // ministry…) instead of an internal department. Department and entity
    // are mutually exclusive — the form toggles between them based on the
    // External checkbox.
    const isExt = !!(isEdit && user.isExternal);

    return `
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.fullName'))}</label>
        <input class="form-input" id="userFullName" value="${isEdit ? escapeHtml(user.fullName) : ''}" required />
      </div>
      ${!isEdit ? `<div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.username'))}</label>
        <input class="form-input" id="userUsername" required />
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.email'))}</label>
        <input class="form-input" type="email" id="userEmail" value="${isEdit ? escapeHtml(user.email) : ''}" required />
      </div>
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr(isEdit ? 'admin.user.form.passwordEdit' : 'admin.user.form.password'))}</label>
        <input class="form-input" type="password" id="userPassword" ${!isEdit ? 'required' : ''} />
      </div>
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.role'))}</label>
        <select class="form-select" id="userRole">
          ${['COLLABORATOR','SUPER_COLLABORATOR','SUPERVISOR','DEPUTY','PROTOCOL','ADMIN','ANALYST'].map(r =>
            `<option value="${r}" ${isEdit && user.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group" id="deptGroup" style="${isExt ? 'display:none;' : ''}">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.dept'))}</label>
        <select class="form-select" id="userDept">
          <option value="">${escapeHtml(I18n.tr('admin.user.form.deptNone'))}</option>
          ${deptOptions}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label"><input type="checkbox" id="userExternal" ${isExt ? 'checked' : ''} /> ${escapeHtml(I18n.tr('admin.user.form.external'))}</label>
      </div>
      <div class="form-group" id="entityGroup" style="${isExt ? '' : 'display:none;'}">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.entity'))}</label>
        <input class="form-input" id="userEntity" value="${isEdit && user.entityName ? escapeHtml(user.entityName) : ''}" />
      </div>
      <div class="form-group" id="countryAssignmentGroup" style="${needsCountries ? '' : 'display:none;'}">
        <label class="form-label">${escapeHtml(I18n.tr('admin.user.form.countries'))}</label>
        <div id="countryPickerContainer"></div>
      </div>
    `;
  }

  document.getElementById('addUserBtn').addEventListener('click', () => {
    const deptOptions = departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
    showModal(I18n.tr('admin.user.modal.add'), userFormHtml(deptOptions, null), async () => {
      const fullName = document.getElementById('userFullName').value.trim();
      const username = document.getElementById('userUsername').value.trim();
      const email = document.getElementById('userEmail').value.trim();
      const password = document.getElementById('userPassword').value;
      const role = document.getElementById('userRole').value;
      const isExternal = document.getElementById('userExternal').checked;
      // Department and entity are mutually exclusive. Send only the one
      // matching the External checkbox; the route also normalises this
      // server-side so the DB never holds both.
      const departmentId = isExternal ? null : (document.getElementById('userDept').value || null);
      const entityName = isExternal ? (document.getElementById('userEntity').value.trim() || null) : null;
      const countryIds = getSelectedCountryIds(document.getElementById('countryPickerContainer'));
      if (!fullName || !username || !email || !password) return;
      try {
        await Api.post('/api/users', { fullName, username, email, password, role, departmentId, isExternal, entityName, countryIds });
        hideModal();
        loadUsers();
      } catch (e) { toast.error(e.message); }
    });

    // Render country picker
    const container = document.getElementById('countryPickerContainer');
    container.innerHTML = buildCountryPickerHtml([]);
    initCountryPicker(container);

    // Show/hide country picker based on role.
    document.getElementById('userRole').addEventListener('change', () => {
      const role = document.getElementById('userRole').value;
      const showCountries = role === 'COLLABORATOR' || role === 'SUPER_COLLABORATOR';
      document.getElementById('countryAssignmentGroup').style.display = showCountries ? '' : 'none';
    });

    // Toggle department vs. entity based on External checkbox.
    document.getElementById('userExternal').addEventListener('change', (e) => {
      const ext = e.target.checked;
      document.getElementById('deptGroup').style.display = ext ? 'none' : '';
      document.getElementById('entityGroup').style.display = ext ? '' : 'none';
    });
  });

  // Edit user
  window.editUser = async function(userId) {
    const users = await Api.get('/api/users');
    const user = users.find(u => u.id === userId);
    if (!user) return;

    // Load user's country assignments
    let userCountries = [];
    try { userCountries = await Api.get(`/api/users/${userId}/countries`); } catch(e) { /* ok */ }
    const selectedCountryIds = userCountries.map(c => c.id);

    const deptOptions = departments.map(d =>
      `<option value="${d.id}" ${user.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
    ).join('');

    showModal(I18n.tr('admin.user.modal.edit') + ' ' + user.fullName, userFormHtml(deptOptions, user), async () => {
      const fullName = document.getElementById('userFullName').value.trim();
      const email = document.getElementById('userEmail').value.trim();
      const password = document.getElementById('userPassword').value;
      const role = document.getElementById('userRole').value;
      const isExternal = document.getElementById('userExternal').checked;
      const departmentId = isExternal ? null : (document.getElementById('userDept').value || null);
      const entityName = isExternal ? (document.getElementById('userEntity').value.trim() || null) : null;
      const countryIds = getSelectedCountryIds(document.getElementById('countryPickerContainer'));
      if (!fullName || !email) return;

      const body = { fullName, email, role, departmentId, isExternal, entityName, countryIds };
      if (password) body.password = password;

      try {
        await Api.patch(`/api/users/${userId}`, body);
        hideModal();
        loadUsers();
      } catch (e) { toast.error(e.message); }
    });

    // Set department select value
    const deptSelect = document.getElementById('userDept');
    if (deptSelect && user.departmentId) deptSelect.value = user.departmentId;

    // Render country picker with existing assignments
    const container = document.getElementById('countryPickerContainer');
    container.innerHTML = buildCountryPickerHtml(selectedCountryIds);
    initCountryPicker(container);

    // Show/hide country picker based on role.
    const roleSelect = document.getElementById('userRole');
    roleSelect.addEventListener('change', () => {
      const role = roleSelect.value;
      const showCountries = role === 'COLLABORATOR' || role === 'SUPER_COLLABORATOR';
      document.getElementById('countryAssignmentGroup').style.display = showCountries ? '' : 'none';
    });

    // Toggle department vs. entity based on External checkbox.
    document.getElementById('userExternal').addEventListener('change', (e) => {
      const ext = e.target.checked;
      document.getElementById('deptGroup').style.display = ext ? 'none' : '';
      document.getElementById('entityGroup').style.display = ext ? '' : 'none';
    });
  };

  // ── Deputy–Supervisor Links ────────────────────────────────────────────────
  let allUsers = [];

  async function loadLinks() {
    try {
      const links = await Api.get('/api/admin/deputy-supervisor-links');
      if (links.length === 0) {
        document.getElementById('linksList').innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('admin.link.empty'))}</p></div>`;
        return;
      }
      document.getElementById('linksList').innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>${escapeHtml(I18n.tr('admin.link.col.deputy'))}</th><th>${escapeHtml(I18n.tr('admin.link.col.supervisor'))}</th><th>${escapeHtml(I18n.tr('admin.link.col.dept'))}</th><th>${escapeHtml(I18n.tr('admin.link.col.actions'))}</th></tr></thead>
          <tbody>${links.map((l, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${escapeHtml(l.deputyName)}</td>
              <td>${escapeHtml(l.supervisorName)}</td>
              <td>${l.supervisorDepartment ? escapeHtml(l.supervisorDepartment) : '—'}</td>
              <td>
                <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" onclick="deleteLink(${l.id})">${escapeHtml(I18n.tr('common.delete'))}</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table></div>`;
    } catch (e) {
      document.getElementById('linksList').innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    }
  }

  // Expose deleteLink globally
  window.deleteLink = async function(id) {
    if (!confirm(I18n.tr('admin.link.confirmDelete'))) return;
    try {
      await Api.delete(`/api/admin/deputy-supervisor-links/${id}`);
      loadLinks();
    } catch (e) { toast.error(e.message); }
  };

  document.getElementById('addLinkBtn').addEventListener('click', async () => {
    // Fetch users for dropdowns
    if (allUsers.length === 0) {
      try { allUsers = await Api.get('/api/users'); } catch(e) { toast.error(e.message); return; }
    }
    const deputies = allUsers.filter(u => u.role === 'DEPUTY');
    const supervisors = allUsers.filter(u => u.role === 'SUPERVISOR');

    const deputyOptions = deputies.map(d => `<option value="${d.id}">${escapeHtml(d.fullName)}</option>`).join('');
    const supervisorOptions = supervisors.map(s => `<option value="${s.id}">${escapeHtml(s.fullName)} (${s.departmentName || '—'})</option>`).join('');

    showModal(I18n.tr('admin.link.modal.add'), `
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.link.form.deputy'))}</label>
        <select class="form-select" id="linkDeputy">
          <option value="">${escapeHtml(I18n.tr('admin.link.form.selectDeputy'))}</option>
          ${deputyOptions}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${escapeHtml(I18n.tr('admin.link.form.supervisor'))}</label>
        <select class="form-select" id="linkSupervisor">
          <option value="">${escapeHtml(I18n.tr('admin.link.form.selectSupervisor'))}</option>
          ${supervisorOptions}
        </select>
      </div>
    `, async () => {
      const deputyId = parseInt(document.getElementById('linkDeputy').value);
      const supervisorId = parseInt(document.getElementById('linkSupervisor').value);
      if (!deputyId || !supervisorId) return;
      try {
        await Api.post('/api/admin/deputy-supervisor-links', { deputyId, supervisorId });
        hideModal();
        loadLinks();
      } catch (e) { toast.error(e.message); }
    });
  });

  // ── Department Hierarchy ──────────────────────────────────────────────────
  async function loadHierarchy() {
    try {
      const data = await Api.get('/api/admin/department-hierarchy');
      if (data.length === 0) {
        document.getElementById('hierarchyList').innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('admin.hier.empty'))}</p></div>`;
        return;
      }
      const lblDeputy = escapeHtml(I18n.tr('admin.hier.deputy'));
      const lblNoDeputy = escapeHtml(I18n.tr('admin.hier.noDeputy'));
      const lblSupervisors = escapeHtml(I18n.tr('admin.hier.supervisors'));
      const lblSuperCollabs = escapeHtml(I18n.tr('admin.hier.superCollabs'));
      const lblCollabs = escapeHtml(I18n.tr('admin.hier.collaborators'));
      const lblNone = escapeHtml(I18n.tr('admin.hier.none'));
      const lblAgency = escapeHtml(I18n.tr('admin.dept.type.agency'));

      document.getElementById('hierarchyList').innerHTML = data.map(dept => {
        const deputyBadges = dept.deputies.length > 0
          ? dept.deputies.map(d => `<span class="pill pill-purple" style="font-size:11px;">${escapeHtml(d)}</span>`).join(' ')
          : `<span style="color:var(--text-muted);font-size:12px;">${lblNoDeputy}</span>`;

        const renderUsers = (users, pillClass) => users.length > 0
          ? users.map(u => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
              <span class="pill ${pillClass}" style="font-size:11px;">${escapeHtml(u.fullName)}</span>
              <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(u.email)}</span>
            </div>`).join('')
          : `<span style="color:var(--text-muted);font-size:12px;padding-left:4px;">${lblNone}</span>`;

        return `<div class="dept-hierarchy-card" style="border:1px solid var(--border-color);border-radius:12px;padding:18px 20px;margin-bottom:14px;background:var(--bg-card);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h4 style="margin:0;font-size:0.95rem;">${escapeHtml(dept.departmentNameEn || dept.departmentName)}</h4>
            ${dept.isExternal ? `<span class="pill pill-yellow" style="font-size:11px;">${lblAgency}</span>` : ''}
          </div>
          <div style="margin-bottom:10px;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${lblDeputy}</div>
            <div style="padding-left:4px;">${deputyBadges}</div>
          </div>
          <div style="margin-bottom:10px;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${lblSupervisors}</div>
            ${renderUsers(dept.supervisors, 'pill-blue')}
          </div>
          <div style="margin-bottom:10px;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${lblSuperCollabs}</div>
            ${renderUsers(dept.superCollaborators, 'pill-green')}
          </div>
          <div>
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${lblCollabs}</div>
            ${renderUsers(dept.collaborators, 'pill-blue')}
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      document.getElementById('hierarchyList').innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  departments = await loadDepartments();
  loadUsers();
  loadLinks();
  loadHierarchy();

  // ── Country-name canonicalisation ────────────────────────────────────
  // The companies registry uses raw Georgian country names that don't
  // always match the Geostat classificatory (e.g. "ლიტვა" → "ლიეტუვა").
  // Load the shared variant→canonical mapping used by tourism + FDI so
  // the companies aggregation keys the buckets by the same canonical
  // names the statistics page looks up at read time.
  const countryNameMap = {};
  try {
    const csvRes = await fetch('/data/country-name-mapping.csv');
    const csvText = await csvRes.text();
    for (const line of csvText.split('\n').slice(1)) {
      const match = line.match(/"([^"]*)","([^"]*)"/);
      if (match) countryNameMap[match[1].trim()] = match[2].trim();
    }
  } catch (err) {
    console.warn('Country name mapping load failed:', err);
  }

  // ── Data Uploads tab ──────────────────────────────────────────────────
  // Generic upload-panel initialiser.
  // - Server-side mode (default): POST multipart to `${endpoint}/upload`.
  // - Client-side mode (clientParse): parse the file in the browser and
  //   POST the aggregated JSON to `${endpoint}${clientPostPath}`. Used for
  //   files too large for the server to parse within the proxy timeout.
  function initUploadPanel({ panelId, endpoint, labels, clientParse, clientPostPath }) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const statusEl = panel.querySelector('.upload-status');
    const form = panel.querySelector('.upload-form');
    const feedback = panel.querySelector('.upload-feedback');

    function renderStatus(j) {
      if (j && j.success && !j.empty) {
        const date = j.uploadedAt ? new Date(j.uploadedAt).toLocaleString() : '-';
        const years = Array.isArray(j.yearsCovered) ? `${j.yearsCovered[0]}–${j.yearsCovered[j.yearsCovered.length - 1]}` : '';
        statusEl.textContent = `${labels.current}: ${date} · ${j.countryCount || 0} ${labels.countries}${years ? ' · ' + years : ''}`;
      } else {
        statusEl.textContent = labels.noFile;
      }
    }

    async function refresh() {
      try {
        const res = await fetch(`${API_BASE}${endpoint}`);
        renderStatus(await res.json());
      } catch (err) {
        statusEl.textContent = labels.noFile;
      }
    }

    async function submitServerSide() {
      const fd = new FormData(form);
      const token = Api.getToken();
      const res = await fetch(`${API_BASE}${endpoint}/upload`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: fd,
      });
      return { res, body: await res.json() };
    }

    async function submitClientSide() {
      const fileInput = form.querySelector('input[type="file"]');
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) throw new Error(I18n.tr('admin.upload.errChooseFile'));
      if (typeof XLSX === 'undefined') {
        throw new Error(I18n.tr('admin.upload.errParser'));
      }
      feedback.textContent = labels.parsing || I18n.tr('admin.upload.parsing');
      // Yield to the browser so the "Parsing…" label actually renders
      // before the synchronous XLSX.read blocks the main thread.
      await new Promise((r) => setTimeout(r, 30));
      const buffer = await file.arrayBuffer();
      const payload = clientParse(buffer);
      feedback.textContent = labels.uploading;
      const token = Api.getToken();
      const res = await fetch(`${API_BASE}${endpoint}${clientPostPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      return { res, body: await res.json() };
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      feedback.textContent = labels.uploading;
      feedback.style.color = 'var(--text-secondary)';
      try {
        const { res, body: j } = clientParse ? await submitClientSide() : await submitServerSide();
        if (res.ok && j.success) {
          let msg = `${labels.success} · ${j.countryCount || 0} ${labels.countries}`;
          let color = 'green';
          // fdi-sectors uploads also refresh the annual FDI table; surface
          // that outcome so a failed refresh doesn't go unnoticed.
          if (j.fdiAnnual) {
            if (j.fdiAnnual.refreshed) {
              msg += ` · ${I18n.tr('admin.upload.fdiAnnualOk', { period: j.fdiAnnual.latestYear })}`;
            } else {
              msg += ` · ${I18n.tr('admin.upload.fdiAnnualFail', { error: j.fdiAnnual.error || '' })}`;
              color = 'darkorange';
            }
          }
          feedback.textContent = msg;
          feedback.style.color = color;
          form.reset();
          refresh();
        } else {
          feedback.textContent = (j && j.error) || labels.failure;
          feedback.style.color = 'crimson';
        }
      } catch (err) {
        feedback.textContent = err.message || labels.failure;
        feedback.style.color = 'crimson';
      }
    });

    refresh();
  }

  // Aggregate the active-companies registry in the browser. Matches the
  // column layout described in the admin UI: S (active flag), V (capital-
  // origin countries separated by "/"). Bucket rules:
  //   solo                 — only the partner country
  //   withGeorgia          — partner + Georgia, no one else
  //   withGeorgiaAndThird  — partner + Georgia + ≥1 third country
  //   withThirdOnly        — partner + ≥1 third country, no Georgia
  function parseCompaniesFile(buffer) {
    const wb = XLSX.read(buffer, {
      type: 'array',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetStubs: false,
    });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error(I18n.tr('admin.upload.errNoSheet'));
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
    const FIRST_DATA_ROW = 4; // matches the server parser: skip title+header rows
    const COL_S = 18;
    const COL_V = 21;
    const GEORGIA = 'საქართველო';

    const counts = {};
    function bucket(name) {
      if (!counts[name]) counts[name] = { total: 0, solo: 0, withGeorgia: 0, withGeorgiaAndThird: 0, withThirdOnly: 0 };
      return counts[name];
    }
    function cellVal(r, c) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      return cell && cell.v != null ? cell.v : null;
    }
    // Map registry variants to the canonical Georgian name used by the
    // Geostat classificatory. Georgia is kept unmapped — it's identified
    // by literal string match for the "joint capital" bucketing below.
    const canon = (name) => countryNameMap[name] || name;

    let activeCount = 0;
    for (let r = FIRST_DATA_ROW; r <= range.e.r; r++) {
      const active = String(cellVal(r, COL_S) || '').trim();
      if (active !== 'აქტიური') continue;
      activeCount++;

      const raw = String(cellVal(r, COL_V) || '').trim();
      if (!raw) continue;
      const list = raw.split('/').map((s) => canon(s.trim())).filter(Boolean);
      if (!list.length) continue;

      const hasGeorgia = list.indexOf(GEORGIA) !== -1;
      const foreign = list.filter((c) => c !== GEORGIA);

      for (const country of foreign) {
        const b = bucket(country);
        b.total++;
        const othersCount = foreign.length - 1;
        if (othersCount === 0 && !hasGeorgia) b.solo++;
        else if (othersCount === 0 && hasGeorgia) b.withGeorgia++;
        else if (othersCount > 0 && hasGeorgia) b.withGeorgiaAndThird++;
        else if (othersCount > 0 && !hasGeorgia) b.withThirdOnly++;
      }
    }

    if (!Object.keys(counts).length) {
      throw new Error(I18n.tr('admin.upload.errNoActive'));
    }
    return { activeCount, countries: counts };
  }

  initUploadPanel({
    panelId: 'panel-fdi-sectors',
    endpoint: '/api/statistics/fdi-sectors',
    labels: {
      current: I18n.tr('admin.upload.current'),
      countries: I18n.tr('admin.upload.countries'),
      noFile: I18n.tr('admin.upload.noFile'),
      uploading: I18n.tr('admin.upload.uploading'),
      success: I18n.tr('admin.upload.success'),
      failure: I18n.tr('admin.upload.failure'),
    },
  });

  initUploadPanel({
    panelId: 'panel-companies',
    endpoint: '/api/statistics/companies',
    clientParse: parseCompaniesFile,
    clientPostPath: '/data',
    labels: {
      current: I18n.tr('admin.upload.current'),
      countries: I18n.tr('admin.upload.countries'),
      noFile: I18n.tr('admin.upload.noFile'),
      parsing: I18n.tr('admin.upload.parsing'),
      uploading: I18n.tr('admin.upload.uploadingSummary'),
      success: I18n.tr('admin.upload.success'),
      failure: I18n.tr('admin.upload.failure'),
    },
  });
})();
