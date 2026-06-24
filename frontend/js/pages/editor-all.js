/**
 * Editor-All — Continuous-document editing page.
 * Stacks all sections vertically with subtle dividers.
 * Each section keeps its own RichEditor, track changes, comments, and workflow.
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  const params = new URLSearchParams(window.location.search);
  const eventId = parseInt(params.get('event_id'));

  if (!eventId) {
    document.getElementById('docFlow').innerHTML =
      '<div class="msg msg-error" style="margin:24px;">Missing event_id parameter</div>';
    return;
  }

  document.getElementById('btnBack').addEventListener('click', () => {
    window.location.href = dashboardUrl(user.role);
  });

  // ── Load data ────────────────────────────────────────────────────────────

  let grid, event;
  try {
    [grid, event] = await Promise.all([
      Api.get(`/api/workflow/status-grid?event_id=${eventId}`),
      Api.get(`/api/events/${eventId}`),
    ]);
  } catch (e) {
    document.getElementById('docFlow').innerHTML =
      `<div class="msg msg-error" style="margin:24px;">${escapeHtml(e.message)}</div>`;
    return;
  }

  // Access control
  const isDS = grid.documentSubmitterId === user.id;
  const canViewAll = isDS || user.role === 'DEPUTY' || user.role === 'SUPERVISOR' || user.role === 'SUPER_COLLABORATOR';
  if (!canViewAll) {
    document.getElementById('docFlow').innerHTML =
      '<div class="msg msg-error" style="margin:24px;">Access denied — you do not have permission to view all sections.</div>';
    return;
  }

  document.getElementById('pageTitle').textContent = `${event.title} — All Sections`;

  // ── Build section navigation ─────────────────────────────────────────────

  const nav = document.getElementById('sectionNav');
  const navLinks = {};
  nav.innerHTML = grid.sections.map((s, i) => {
    const id = `nav-link-${s.sectionId}`;
    return `<a href="#section-${s.sectionId}" id="${id}">${i + 1}. ${escapeHtml(s.sectionLabel)}</a>`;
  }).join('');
  grid.sections.forEach(s => {
    navLinks[s.sectionId] = document.getElementById(`nav-link-${s.sectionId}`);
  });

  // Smooth scroll on nav click
  nav.addEventListener('click', e => {
    const link = e.target.closest('a');
    if (!link) return;
    e.preventDefault();
    const target = document.querySelector(link.getAttribute('href'));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ── Load all section contents ────────────────────────────────────────────

  const contentPromises = grid.sections.map(s =>
    Api.get(`/api/workflow/section-content?event_id=${eventId}&section_id=${s.sectionId}`)
      .catch(() => ({ htmlContent: '', status: 'draft' }))
  );
  const contents = await Promise.all(contentPromises);

  // ── Render sections ──────────────────────────────────────────────────────

  const docFlow = document.getElementById('docFlow');
  const sections = {}; // sectionId → { editor, sectionInfo, canEdit, dividerEl, sectionEl }
  let focusedSectionId = null;
  let activeDropdown = null;

  function closeDropdown() {
    if (activeDropdown) { activeDropdown.remove(); activeDropdown = null; }
  }
  document.addEventListener('mousedown', e => {
    if (activeDropdown && !activeDropdown.contains(e.target) && !e.target.closest('.section-action-trigger')) {
      closeDropdown();
    }
  }, true);

  grid.sections.forEach((s, i) => {
    const content = contents[i];
    const effectiveRole = s.userEffectiveRole || user.role;
    const isHolder = s.currentHolderRole === effectiveRole;
    const canEdit = isHolder;
    const status = s.status || 'draft';

    // ── Section wrapper ──
    const sectionEl = document.createElement('div');
    sectionEl.className = 'doc-section' + (canEdit ? '' : ' doc-section--readonly');
    sectionEl.id = `section-${s.sectionId}`;

    // ── Divider ──
    const divider = document.createElement('div');
    divider.className = 'doc-section-divider';
    divider.innerHTML = `
      <h3>${i + 1}. ${escapeHtml(s.sectionLabel)}</h3>
      <span class="section-actions" style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <span class="${statusClass(status)}" style="font-size:12px;">${statusLabel(status)}</span>
        ${!canEdit ? '<span class="readonly-badge"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a4 4 0 0 0-4 4v3H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4zm-2 4a2 2 0 1 1 4 0v3H6V5z"/></svg> Read-only</span>' : ''}
        <button class="section-action-trigger" data-section-id="${s.sectionId}" title="Section actions">&#8942;</button>
      </span>
    `;
    sectionEl.appendChild(divider);

    // Store last-updated info for dropdown display
    s._updatedAt = content.updatedAt;
    s._updatedByName = content.updatedByName;

    // ── Editor container ──
    const editorContainer = document.createElement('div');
    editorContainer.className = 'section-editor-container';
    sectionEl.appendChild(editorContainer);

    docFlow.appendChild(sectionEl);

    // ── Create RichEditor ──
    const editor = GCP.RichEditor({
      container: editorContainer,
      initialHtml: content.htmlContent || '',
      authorName: localizedName(user.fullName, user.fullNameKa) || user.username,
      sectionTitle: s.sectionLabel,
      readOnly: !canEdit,
      async onCommentsClick(anchorId) {
        if (!anchorId) return;
        const anchorSpan = editorContainer.querySelector(`.gcp-cmt-anchor[data-cmt-anchor-id="${anchorId}"]`);
        const text = await GCP.ActionDialog.popoverPrompt(
          anchorSpan || editorContainer,
          I18n.tr('editor.comment.addTitle'),
          { placeholder: I18n.tr('editor.comment.placeholder'), required: true, confirmLabel: I18n.tr('common.add'), confirmColor: '#3b82f6', fixed: true }
        );
        if (text && text.trim()) {
          Api.post('/api/workflow/comments', {
            eventId, sectionId: s.sectionId, content: text.trim(), anchorId,
            htmlContent: editor.getHtml(),
          }).then(() => loadCommentsForSection(s.sectionId)).catch(e => toast.error(I18n.tr('editor.comment.failed') + ' ' + e.message));
        } else {
          editor.removeCommentAnchor(anchorId);
        }
      },
      async onDeleteComment(commentId, anchorId) {
        try {
          await Api.post('/api/workflow/comments/delete', { commentId });
          if (anchorId) {
            editor.removeCommentAnchor(anchorId);
            Api.post('/api/workflow/save', {
              eventId, sectionId: s.sectionId,
              htmlContent: editor.getHtml(),
            }).catch(e => console.error('Auto-save after anchor removal failed:', e));
          }
          loadCommentsForSection(s.sectionId);
        } catch (e) { console.error('Delete comment failed:', e); }
      },
      async onReplyComment(parentId, text) {
        try {
          await Api.post('/api/workflow/comments', {
            eventId, sectionId: s.sectionId, content: text, parentId,
          });
          loadCommentsForSection(s.sectionId);
        } catch (e) { toast.error(I18n.tr('editor.comment.replyFailed') + ' ' + e.message); }
      },
    });

    sections[s.sectionId] = { editor, sectionInfo: s, canEdit, dividerEl: divider, sectionEl, effectiveRole };

    // ── Focus tracking ──
    if (editor.el) {
      editor.el.addEventListener('focusin', () => setFocusedSection(s.sectionId));
    }

    // Load comments
    loadCommentsForSection(s.sectionId);
  });

  // ── Focus management — sticky toolbar dock ──────────────────────────────

  const toolbarDock = document.getElementById('toolbarDock');

  function setFocusedSection(sectionId) {
    if (focusedSectionId === sectionId) return;

    // Return previous toolbar to its editor wrap
    if (focusedSectionId && sections[focusedSectionId]) {
      const prev = sections[focusedSectionId];
      prev.sectionEl.classList.remove('focused');
      if (prev.canEdit && prev.editor.toolbarEl && prev.editor.wrapEl) {
        prev.editor.wrapEl.insertBefore(prev.editor.toolbarEl, prev.editor.wrapEl.firstChild);
      }
    }

    focusedSectionId = sectionId;
    const sec = sections[sectionId];
    if (sec) {
      sec.sectionEl.classList.add('focused');
      // Move editable section's toolbar into the sticky dock
      if (sec.canEdit && sec.editor.toolbarEl) {
        toolbarDock.innerHTML = '';
        toolbarDock.appendChild(sec.editor.toolbarEl);
        groupToolbarButtons(sec.editor.toolbarEl);
      } else {
        toolbarDock.innerHTML = '';
      }
    }

    // Update nav
    Object.entries(navLinks).forEach(([id, link]) => {
      link.classList.toggle('active', parseInt(id) === sectionId);
    });

    updateStatusBar();
  }

  // ── Toolbar grouping (Word ribbon style) ──────────────────────────────

  function groupToolbarButtons(toolbarEl) {
    // Skip if already grouped
    if (toolbarEl.querySelector('.tb-group')) return;
    const groupNames = [
      I18n.tr('editor.toolbar.group.font'),
      I18n.tr('editor.toolbar.group.format'),
      I18n.tr('editor.toolbar.group.paragraph'),
      I18n.tr('editor.toolbar.group.insert'),
      I18n.tr('editor.toolbar.group.review'),
    ];
    const groups = [];
    let currentGroup = [];
    for (const child of [...toolbarEl.children]) {
      if (child.classList.contains('gcp-re-sep')) {
        if (currentGroup.length) groups.push(currentGroup);
        currentGroup = [];
        child.remove();
      } else {
        currentGroup.push(child);
      }
    }
    if (currentGroup.length) groups.push(currentGroup);
    groups.forEach((btns, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'tb-group';
      btns.forEach(b => wrapper.appendChild(b));
      const label = document.createElement('div');
      label.className = 'tb-group-label';
      label.textContent = groupNames[i] || '';
      wrapper.appendChild(label);
      toolbarEl.appendChild(wrapper);
    });
  }

  // ── Status bar ────────────────────────────────────────────────────────

  function updateStatusBar() {
    const idx = grid.sections.findIndex(s => s.sectionId === focusedSectionId);
    const secEl = document.getElementById('statusSection');
    const wordsEl = document.getElementById('statusWords');
    if (idx >= 0) {
      secEl.textContent = I18n.tr('editor.status.sectionOf').replace('{n}', idx + 1).replace('{total}', grid.sections.length);
    } else {
      secEl.textContent = I18n.tr('editor.status.sectionsCount').replace('{total}', grid.sections.length);
    }
    const sec = focusedSectionId ? sections[focusedSectionId] : null;
    if (sec && sec.editor.el) {
      const text = sec.editor.el.textContent || '';
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      wordsEl.textContent = I18n.tr('editor.status.words').replace('{n}', words);
    }
  }

  // Update word count on typing
  Object.values(sections).forEach(sec => {
    if (sec.editor.el) {
      sec.editor.el.addEventListener('input', () => {
        if (sec.sectionInfo.sectionId === focusedSectionId) updateStatusBar();
      });
    }
  });

  // Initial status bar
  updateStatusBar();

  // Clear toolbar dock when clicking outside any editor
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('.doc-section') && !e.target.closest('#toolbarDock')) {
      if (focusedSectionId && sections[focusedSectionId]) {
        const prev = sections[focusedSectionId];
        prev.sectionEl.classList.remove('focused');
        if (prev.canEdit && prev.editor.toolbarEl && prev.editor.wrapEl) {
          prev.editor.wrapEl.insertBefore(prev.editor.toolbarEl, prev.editor.wrapEl.firstChild);
        }
      }
      focusedSectionId = null;
      toolbarDock.innerHTML = '';
    }
  });

  // ── IntersectionObserver for scroll-based nav sync ───────────────────────

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = parseInt(entry.target.id.replace('section-', ''));
        Object.values(navLinks).forEach(l => l.classList.remove('active'));
        if (navLinks[id]) navLinks[id].classList.add('active');
      }
    });
  }, { rootMargin: '-60px 0px -70% 0px', threshold: 0 });

  Object.values(sections).forEach(s => observer.observe(s.sectionEl));

  // ── Action dropdown ──────────────────────────────────────────────────────

  docFlow.addEventListener('click', e => {
    const trigger = e.target.closest('.section-action-trigger');
    if (!trigger) return;
    e.stopPropagation();
    const sid = parseInt(trigger.dataset.sectionId);
    const sec = sections[sid];
    if (!sec) return;

    // Toggle if already open
    if (activeDropdown && activeDropdown.dataset.sectionId === String(sid)) {
      closeDropdown(); return;
    }
    closeDropdown();

    const dropdown = buildActionDropdown(sec);
    dropdown.dataset.sectionId = String(sid);
    sec.dividerEl.appendChild(dropdown);
    activeDropdown = dropdown;
  });

  function buildActionDropdown(sec) {
    const { sectionInfo: s, canEdit, effectiveRole, editor } = sec;
    const status = s.status || 'draft';
    const isHolder = s.currentHolderRole === effectiveRole;
    const drop = document.createElement('div');
    drop.className = 'section-action-dropdown';

    function addItem(label, colorClass, handler) {
      const item = document.createElement('div');
      item.className = 'section-action-item' + (colorClass ? ' section-action-item--' + colorClass : '');
      item.textContent = label;
      item.addEventListener('click', () => { closeDropdown(); handler(); });
      drop.appendChild(item);
    }

    // Last updated info (non-clickable)
    if (s._updatedAt) {
      const dateLocale = (typeof I18n !== 'undefined' && I18n.getLocale && I18n.getLocale() === 'ka') ? 'ka-GE' : 'en-GB';
      const ts = new Date(s._updatedAt).toLocaleString(dateLocale, { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const info = document.createElement('div');
      info.className = 'section-action-item section-action-item--muted';
      const byPart = s._updatedByName ? ' ' + I18n.tr('editor.action.by') + ' ' + s._updatedByName : '';
      info.textContent = I18n.tr('editor.action.updated') + ' ' + ts + byPart;
      drop.appendChild(info);
    }

    // Open in Editor
    addItem(I18n.tr('editor.action.openInEditor'), '', () => {
      window.location.href = `/pages/editor.html?event_id=${eventId}&section_id=${s.sectionId}`;
    });

    // Save
    if (canEdit) {
      addItem(I18n.tr('common.save'), 'blue', () => handleSaveSection(s.sectionId));
    }

    if (isHolder) {
      // Submit
      if (status === 'draft' || status.startsWith('returned_')) {
        addItem(I18n.tr('common.submit'), 'blue', () => handleSubmitSection(s.sectionId));
      }
      // Approve + Return
      if (status === `submitted_to_${effectiveRole.toLowerCase()}`) {
        addItem(I18n.tr('common.approve'), 'green', () => handleApproveSection(s.sectionId));
        addItem(I18n.tr('common.return'), 'red', () => handleReturnSection(s.sectionId));
      }
    }

    // Ask to Return
    if (!isHolder && status !== 'draft') {
      const chain = s.chain || [];
      const userIdx = chain.indexOf(effectiveRole);
      const holderIdx = chain.indexOf(s.currentHolderRole);
      if (userIdx !== -1 && holderIdx > userIdx) {
        addItem(I18n.tr('editor.askReturn'), 'orange', () => handleAskReturnSection(s.sectionId));
      }
    }

    // Push / Pull
    if (s.canPush) {
      addItem(I18n.tr('editor.pushSection'), 'orange', () => handlePushSection(s.sectionId));
    }
    if (s.canPull) {
      addItem(I18n.tr('editor.pullSection'), 'purple', () => handlePullSection(s.sectionId));
    }

    return drop;
  }

  // ── Workflow handlers ────────────────────────────────────────────────────

  async function handleSaveSection(sectionId) {
    const sec = sections[sectionId];
    if (!sec) return;
    try {
      await Api.post('/api/workflow/save', {
        eventId, sectionId,
        htmlContent: sec.editor.getHtml(),
      });
      showNotification(I18n.tr('editor.saved'));
      document.getElementById('statusSaved').textContent = I18n.tr('editor.status.saved');
    } catch (e) {
      toast.error(I18n.tr('editor.saveFailed') + ' ' + e.message);
    }
  }

  async function handleSubmitSection(sectionId) {
    const sec = sections[sectionId];
    if (!sec) return;
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmSubmit'), { confirmLabel: I18n.tr('common.submit'), confirmColor: '#3b82f6' })) return;
    try {
      await Api.post('/api/workflow/save', { eventId, sectionId, htmlContent: sec.editor.getHtml() });
      await Api.post('/api/workflow/submit', { eventId, sectionId });
      showNotification(I18n.tr('editor.submitted'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.submitFailed') + ' ' + e.message);
    }
  }

  async function handleApproveSection(sectionId) {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmApprove'), { confirmLabel: I18n.tr('common.approve'), confirmColor: '#16a34a' })) return;
    try {
      await Api.post('/api/workflow/approve', { eventId, sectionId });
      showNotification(I18n.tr('editor.approved'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.approveFailed') + ' ' + e.message);
    }
  }

  async function handleReturnSection(sectionId) {
    const sec = sections[sectionId];
    if (!sec) return;
    const comment = await GCP.ActionDialog.popoverPrompt(
      sec.dividerEl.querySelector('.section-action-trigger'),
      I18n.tr('editor.returnTitle'),
      { placeholder: I18n.tr('editor.returnPlaceholder'), required: true, confirmLabel: I18n.tr('common.return'), confirmColor: '#6d28d9', fixed: true }
    );
    if (!comment) return;
    try {
      await Api.post('/api/workflow/return', { eventId, sectionId, comment });
      showNotification(I18n.tr('editor.returned'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.returnFailed') + ' ' + e.message);
    }
  }

  async function handleAskReturnSection(sectionId) {
    const sec = sections[sectionId];
    if (!sec) return;
    const note = await GCP.ActionDialog.popoverPrompt(
      sec.dividerEl.querySelector('.section-action-trigger'),
      I18n.tr('editor.askReturnTitle'),
      { placeholder: I18n.tr('editor.askReturnPlaceholder'), required: true, confirmLabel: I18n.tr('editor.sendRequest'), confirmColor: '#a16207', fixed: true }
    );
    if (!note) return;
    try {
      await Api.post('/api/workflow/ask-return', { eventId, sectionId, comment: note });
      showNotification(I18n.tr('editor.requestSent'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.requestFailed') + ' ' + e.message);
    }
  }

  async function handlePushSection(sectionId) {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPush'), { confirmLabel: I18n.tr('editor.pushSection'), confirmColor: '#6d28d9' })) return;
    try {
      await Api.post('/api/workflow/push-section', { eventId, sectionId });
      showNotification(I18n.tr('editor.pushed'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.pushFailed') + ' ' + e.message);
    }
  }

  async function handlePullSection(sectionId) {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPull'), { confirmLabel: I18n.tr('editor.pullSection'), confirmColor: '#7c3aed' })) return;
    try {
      await Api.post('/api/workflow/pull-section', { eventId, sectionId });
      showNotification(I18n.tr('editor.pulled'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.pullFailed') + ' ' + e.message);
    }
  }

  // ── Save All ─────────────────────────────────────────────────────────────

  document.getElementById('btnSaveAll').addEventListener('click', async () => {
    const editable = Object.entries(sections).filter(([, s]) => s.canEdit);
    if (editable.length === 0) {
      showNotification(I18n.tr('editor.saveAll.noneEditable'));
      return;
    }
    const btn = document.getElementById('btnSaveAll');
    btn.disabled = true; btn.textContent = I18n.tr('editor.saveAll.inProgress');
    try {
      await Promise.all(editable.map(([sid, s]) =>
        Api.post('/api/workflow/save', {
          eventId, sectionId: parseInt(sid),
          htmlContent: s.editor.getHtml(),
        })
      ));
      showNotification(I18n.tr('editor.saveAll.allSaved'));
      document.getElementById('statusSaved').textContent = I18n.tr('editor.status.saved');
    } catch (e) {
      toast.error(I18n.tr('editor.saveFailed') + ' ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = I18n.tr('editor.saveAll');
    }
  });

  // ── Comments ─────────────────────────────────────────────────────────────

  async function loadCommentsForSection(sectionId) {
    const sec = sections[sectionId];
    if (!sec) return;
    try {
      const comments = await Api.get(`/api/workflow/comments?event_id=${eventId}&section_id=${sectionId}`);
      const editorComments = (comments || []).map(c => ({
        id: c.id,
        anchor_id: c.anchorId || null,
        parent_id: c.parentId || null,
        author_name: localizedName(c.userName, c.userNameKa) || 'User',
        comment_text: c.content || '',
        created_at: c.createdAt || new Date().toISOString(),
        can_delete: c.userId === user.id || user.role === 'admin',
      }));
      sec.editor.setComments(editorComments);
    } catch (e) {
      console.error('Load comments error for section', sectionId, e);
    }
  }

  // ── Notifications ────────────────────────────────────────────────────────

  function showNotification(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg-success';
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;padding:12px 20px;border-radius:6px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
})();
