/**
 * Section Editor — uses GCP.RichEditor for content editing.
 * Workflow actions: Save, Submit, Approve, Return, Ask to Return
 * Comments and history panels below.
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  const params = new URLSearchParams(window.location.search);
  const eventId = parseInt(params.get('event_id'));
  const sectionId = parseInt(params.get('section_id'));

  if (!eventId || !sectionId) {
    document.getElementById('richEditorContainer').innerHTML =
      `<div class="msg msg-error" style="margin:24px;">${escapeHtml(I18n.tr('editor.errMissingIds'))}</div>`;
    return;
  }

  const actionToolbar = document.getElementById('actionToolbar');
  const sectionMeta = document.getElementById('sectionMeta');
  const editorTitle = document.getElementById('editorTitle');

  // Load section data
  let grid, sectionInfo, content;
  try {
    [grid, content] = await Promise.all([
      Api.get(`/api/workflow/status-grid?event_id=${eventId}`),
      Api.get(`/api/workflow/section-content?event_id=${eventId}&section_id=${sectionId}`),
    ]);
  } catch (e) {
    document.getElementById('richEditorContainer').innerHTML =
      `<div class="msg msg-error" style="margin:24px;">${escapeHtml(e.message)}</div>`;
    return;
  }

  sectionInfo = grid.sections.find(s => s.sectionId === sectionId);
  if (!sectionInfo) {
    document.getElementById('richEditorContainer').innerHTML =
      `<div class="msg msg-error" style="margin:24px;">${escapeHtml(I18n.tr('editor.errSectionNotFound'))}</div>`;
    return;
  }

  // Set title and meta
  editorTitle.textContent = sectionInfo.sectionLabel;
  const status = sectionInfo.status || 'draft';

  // Determine effective role (per-section from API)
  const effectiveRole = sectionInfo.userEffectiveRole || user.role;
  const isHolder = sectionInfo.currentHolderRole === effectiveRole;

  sectionMeta.innerHTML = `
    <span class="status-pill ${statusClass(status)}">${escapeHtml(I18n.tr('editor.statusLabel'))} ${statusLabel(status)}</span>
    ${content.lastEditedBy ? `<span>${escapeHtml(I18n.tr('editor.lastEditedBy'))} ${escapeHtml(localizedName(content.lastEditedBy, content.lastEditedByKa))}</span>` : ''}
  `;

  // Enable editing if the user is the current holder of the section
  const canEdit = isHolder;

  // ── Initialize GCP.RichEditor ──────────────────────────────────────────────

  const richEditor = GCP.RichEditor({
    container: document.getElementById('richEditorContainer'),
    initialHtml: content.htmlContent || '',
    authorName: localizedName(user.fullName, user.fullNameKa) || user.username,
    sectionTitle: sectionInfo.sectionLabel,
    readOnly: !canEdit,
    async onCommentsClick(anchorId) {
      // anchorId is set when user selects text and adds a comment via context menu
      if (anchorId) {
        const anchorSpan = document.querySelector(`.gcp-cmt-anchor[data-cmt-anchor-id="${anchorId}"]`);
        const popAnchor = anchorSpan || document.getElementById('addCmtBtn') || document.body;
        const text = await GCP.ActionDialog.popoverPrompt(popAnchor, I18n.tr('editor.comment.addTitle'), { placeholder: I18n.tr('editor.comment.placeholder'), required: true, confirmLabel: I18n.tr('common.add'), confirmColor: '#3b82f6', fixed: true });
        if (text && text.trim()) {
          Api.post('/api/workflow/comments', {
            eventId, sectionId, content: text.trim(), anchorId,
            htmlContent: richEditor.getHtml(),
          }).then(() => loadComments()).catch(e => toast.error(I18n.tr('editor.comment.failed') + ' ' + e.message));
        } else {
          // Cancel — remove the anchor
          richEditor.removeCommentAnchor(anchorId);
        }
      }
    },
    async onDeleteComment(commentId, anchorId) {
      try {
        await Api.post('/api/workflow/comments/delete', { commentId });
        if (anchorId) {
          richEditor.removeCommentAnchor(anchorId);
          // Persist the HTML without the anchor so the highlight doesn't return on reload
          Api.post('/api/workflow/save', {
            eventId, sectionId,
            htmlContent: richEditor.getHtml(),
          }).catch(e => console.error('Auto-save after anchor removal failed:', e));
        }
        loadComments();
      } catch (e) { console.error('Delete comment failed:', e); }
    },
    async onReplyComment(parentId, text) {
      try {
        await Api.post('/api/workflow/comments', {
          eventId, sectionId, content: text, parentId,
        });
        loadComments();
      } catch (e) { toast.error(I18n.tr('editor.comment.replyFailed') + ' ' + e.message); }
    },
  });

  // Build action toolbar
  buildToolbar(status, effectiveRole, isHolder, canEdit);

  // Load comments (for editor margin balloons) and history
  loadComments();
  loadHistory();

  function buildToolbar(status, role, isHolder, canEdit) {
    const leftBtns = [];
    const rightBtns = [];

    // Left side: Back to Dashboard
    leftBtns.push(`<button id="btnBack" class="tb-outline">${escapeHtml(I18n.tr('editor.backToDashboard'))}</button>`);

    // Right side: action buttons

    // File upload button
    rightBtns.push(`<button id="btnUpload" class="tb-outline">
      <span class="icon" style="--icon-url: url(/assets/upload-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
      ${escapeHtml(I18n.tr('editor.files.title'))}
    </button>`);

    // Save (if can edit)
    if (canEdit) {
      rightBtns.push(`<button id="btnSave" class="tb-outline tb-outline--blue">
        <span class="icon" style="--icon-url: url(/assets/save-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
        ${escapeHtml(I18n.tr('common.save'))}
      </button>`);
    }

    if (isHolder) {
      // Submit (from draft or returned)
      if (status === 'draft' || status.startsWith('returned_')) {
        rightBtns.push(`<button id="btnSubmit" class="tb-outline tb-outline--blue">
          <span class="icon" style="--icon-url: url(/assets/submit-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
          ${escapeHtml(I18n.tr('common.submit'))}
        </button>`);
      }

      // Approve + Return (when submitted to this role)
      if (status === `submitted_to_${role.toLowerCase()}`) {
        rightBtns.push(`<button id="btnApprove" class="tb-outline tb-outline--green">
          <span class="icon" style="--icon-url: url(/assets/approve-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
          ${escapeHtml(I18n.tr('common.approve'))}
        </button>`);
        // Skip Return for amendments — no chain step to return to.
        if (status !== 'submitted_to_amending_ds') {
          rightBtns.push(`<button id="btnReturn" class="tb-outline tb-outline--red">
            <span class="icon" style="--icon-url: url(/assets/return-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
            ${escapeHtml(I18n.tr('common.return'))}
          </button>`);
        }
      }
    }

    // Ask to Return (only if user is in the chain and section has passed their step)
    if (!isHolder && status !== 'draft') {
      const chain = sectionInfo.chain || [];
      const userIdx = chain.indexOf(role);
      const holderIdx = chain.indexOf(sectionInfo.currentHolderRole);
      if (userIdx !== -1 && holderIdx > userIdx) {
        rightBtns.push(`<button id="btnAskReturn" class="tb-outline tb-outline--orange">
          <span class="icon" style="--icon-url: url(/assets/ask_to_return_icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:14px;height:14px;display:inline-block;background:currentColor;"></span>
          ${escapeHtml(I18n.tr('editor.askReturn'))}
        </button>`);
      }
    }

    // Push Section — shown for both holders and non-holders when canPush is true
    if (sectionInfo.canPush) {
      rightBtns.push(`<button id="btnPushSection" class="tb-outline tb-outline--orange">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        ${escapeHtml(I18n.tr('editor.pushSection'))}
      </button>`);
    }

    // Pull Section — pull from a user earlier in the chain
    if (sectionInfo.canPull) {
      rightBtns.push(`<button id="btnPullSection" class="tb-outline tb-outline--purple">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        ${escapeHtml(I18n.tr('editor.pullSection'))}
      </button>`);
    }

    actionToolbar.innerHTML = leftBtns.join('') + '<span class="tb-spacer"></span>' + rightBtns.join('');

    // Bind events
    const btnSave = document.getElementById('btnSave');
    const btnSubmit = document.getElementById('btnSubmit');
    const btnApprove = document.getElementById('btnApprove');
    const btnReturn = document.getElementById('btnReturn');
    const btnAskReturn = document.getElementById('btnAskReturn');
    const btnPushSection = document.getElementById('btnPushSection');
    const btnPullSection = document.getElementById('btnPullSection');
    const btnBack = document.getElementById('btnBack');

    if (btnSave) btnSave.addEventListener('click', handleSave);
    if (btnSubmit) btnSubmit.addEventListener('click', handleSubmit);
    if (btnApprove) btnApprove.addEventListener('click', handleApprove);
    if (btnReturn) btnReturn.addEventListener('click', handleReturn);
    if (btnAskReturn) btnAskReturn.addEventListener('click', handleAskReturn);
    if (btnPushSection) btnPushSection.addEventListener('click', handlePushSection);
    if (btnPullSection) btnPullSection.addEventListener('click', handlePullSection);
    const btnUpload = document.getElementById('btnUpload');
    if (btnUpload) btnUpload.addEventListener('click', handleFiles);
    if (btnBack) btnBack.addEventListener('click', () => {
      window.location.href = dashboardUrl(user.role);
    });
  }

  // ── Workflow actions (use richEditor.getHtml() instead of contentEditable) ──

  // Delete comments whose anchor text was removed from the document. Runs only
  // on explicit save/submit — never automatically — so undo can still bring an
  // anchor (and its comments) back before the user commits the change.
  async function reconcileOrphanedComments() {
    const orphanIds = richEditor.getOrphanedCommentIds();
    if (!orphanIds.length) return;
    await Promise.all(orphanIds.map(id =>
      Api.post('/api/workflow/comments/delete', { commentId: id })
        .catch(e => console.error('Orphaned comment cleanup failed:', e))
    ));
    loadComments();
  }

  async function handleSave() {
    try {
      await Api.post('/api/workflow/save', {
        eventId, sectionId,
        htmlContent: richEditor.getHtml(),
      });
      await reconcileOrphanedComments();
      showNotification(I18n.tr('editor.saved'));
    } catch (e) {
      toast.error(I18n.tr('editor.saveFailed') + ' ' + e.message);
    }
  }

  async function handleSubmit() {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmSubmit'), { confirmLabel: I18n.tr('common.submit'), confirmColor: '#3b82f6' })) return;
    try {
      await Api.post('/api/workflow/save', {
        eventId, sectionId,
        htmlContent: richEditor.getHtml(),
      });
      await reconcileOrphanedComments();
      await Api.post('/api/workflow/submit', { eventId, sectionId });
      showNotification(I18n.tr('editor.submitted'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.submitFailed') + ' ' + e.message);
    }
  }

  async function handleApprove() {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmApprove'), { confirmLabel: I18n.tr('common.approve'), confirmColor: '#16a34a' })) return;
    try {
      await Api.post('/api/workflow/approve', { eventId, sectionId });
      showNotification(I18n.tr('editor.approved'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.approveFailed') + ' ' + e.message);
    }
  }

  async function handleReturn() {
    const btn = document.getElementById('btnReturn');
    const comment = await GCP.ActionDialog.popoverPrompt(btn, I18n.tr('editor.returnTitle'), { placeholder: I18n.tr('editor.returnPlaceholder'), required: true, confirmLabel: I18n.tr('common.return'), confirmColor: '#6d28d9' });
    if (!comment) return;
    try {
      await Api.post('/api/workflow/return', { eventId, sectionId, comment });
      showNotification(I18n.tr('editor.returned'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.returnFailed') + ' ' + e.message);
    }
  }

  async function handleAskReturn() {
    const btn = document.getElementById('btnAskReturn');
    const note = await GCP.ActionDialog.popoverPrompt(btn, I18n.tr('editor.askReturnTitle'), { placeholder: I18n.tr('editor.askReturnPlaceholder'), required: true, confirmLabel: I18n.tr('editor.sendRequest'), confirmColor: '#a16207' });
    if (!note) return;
    try {
      await Api.post('/api/workflow/ask-to-return', { eventId, sectionId, note });
      showNotification(I18n.tr('editor.requestSent'));
    } catch (e) {
      toast.error(I18n.tr('editor.requestFailed') + ' ' + e.message);
    }
  }

  async function handlePushSection() {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPush'), { confirmLabel: I18n.tr('editor.pushSection'), confirmColor: '#6d28d9' })) return;
    try {
      await Api.post('/api/workflow/push-section', { eventId, sectionId });
      showNotification(I18n.tr('editor.pushed'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.pushFailed') + ' ' + e.message);
    }
  }

  async function handlePullSection() {
    if (!await GCP.ActionDialog.confirm(I18n.tr('editor.confirmPull'), { confirmLabel: I18n.tr('editor.pullSection'), confirmColor: '#7c3aed' })) return;
    try {
      await Api.post('/api/workflow/pull-section', { eventId, sectionId });
      showNotification(I18n.tr('editor.pulled'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(I18n.tr('editor.pullFailed') + ' ' + e.message);
    }
  }

  function showNotification(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg-success';
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;padding:12px 20px;border-radius:6px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  // ─── Files ──────────────────────────────────────────────────────────────────

  const FILE_ICONS = {
    pdf:  { color: '#dc2626', label: 'PDF' },
    doc:  { color: '#2563eb', label: 'DOC' },
    docx: { color: '#2563eb', label: 'DOC' },
    xls:  { color: '#16a34a', label: 'XLS' },
    xlsx: { color: '#16a34a', label: 'XLS' },
    ppt:  { color: '#ea580c', label: 'PPT' },
    pptx: { color: '#ea580c', label: 'PPT' },
    jpg:  { color: '#7c3aed', label: 'IMG' },
    jpeg: { color: '#7c3aed', label: 'IMG' },
    png:  { color: '#7c3aed', label: 'IMG' },
    gif:  { color: '#7c3aed', label: 'IMG' },
    svg:  { color: '#7c3aed', label: 'SVG' },
    zip:  { color: '#64748b', label: 'ZIP' },
    rar:  { color: '#64748b', label: 'RAR' },
    txt:  { color: '#475569', label: 'TXT' },
    csv:  { color: '#16a34a', label: 'CSV' },
  };

  function fileIcon(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const info = FILE_ICONS[ext] || { color: '#94a3b8', label: ext.toUpperCase().slice(0, 3) || 'FILE' };
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:6px;background:${info.color}11;color:${info.color};font-size:10px;font-weight:800;letter-spacing:.03em;flex-shrink:0;border:1px solid ${info.color}22;">${info.label}</span>`;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function handleFiles() {
    const filesPanel = document.getElementById('filesPanel');
    if (filesPanel.style.display === 'none') {
      filesPanel.style.display = '';
      filesPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      loadFiles();
    } else {
      filesPanel.style.display = 'none';
    }
  }

  async function loadFiles() {
    const list = document.getElementById('filesList');
    const countEl = document.getElementById('filesCount');
    try {
      const files = await Api.get(`/api/workflow/files/list?eventId=${eventId}&sectionId=${sectionId}`);
      if (countEl) {
        countEl.textContent = files && files.length
          ? `${files.length} ${I18n.tr(files.length === 1 ? 'editor.files.countOne' : 'editor.files.countMany')}`
          : '';
      }
      if (!files || files.length === 0) {
        list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">${escapeHtml(I18n.tr('editor.files.empty'))}</p>`;
        return;
      }
      const dateLocale = (typeof I18n !== 'undefined' && I18n.getLocale && I18n.getLocale() === 'ka') ? 'ka-GE' : 'en-GB';
      list.innerHTML = files.map(f => {
        const name = escapeHtml(f.original_name);
        const size = formatFileSize(f.size || 0);
        const by = escapeHtml(f.uploaded_by_name || '');
        const date = f.created_at ? new Date(f.created_at).toLocaleDateString(dateLocale, { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const canDelete = f.uploaded_by_id === user.id || user.role === 'ADMIN';
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-color);">
          ${fileIcon(f.original_name)}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${name}">${name}</div>
            <div style="font-size:11px;color:var(--text-muted);">${size}${by ? ' · ' + by : ''}${date ? ' · ' + date : ''}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <a href="#" onclick="downloadFileAuth(${f.id}, '${escapeHtml(f.original_name).replace(/'/g, "\\\\'")}'); return false;" style="padding:4px 10px;font-size:12px;border:1px solid var(--border-color);border-radius:6px;color:var(--text-muted);text-decoration:none;cursor:pointer;" title="${escapeHtml(I18n.tr('editor.files.download'))}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
            ${canDelete ? `<button onclick="deleteFile(${f.id})" style="padding:4px 8px;font-size:12px;border:1px solid #fecaca;border-radius:6px;background:none;color:#dc2626;cursor:pointer;" title="${escapeHtml(I18n.tr('common.delete'))}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">${escapeHtml(I18n.tr('editor.files.loadFailed'))}</p>`;
    }
  }

  // Upload files (shared by file input and drag-and-drop)
  async function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    const formData = new FormData();
    formData.append('eventId', eventId);
    formData.append('sectionId', sectionId);
    for (const file of fileList) {
      formData.append('files', file);
    }

    try {
      const token = Api.getToken();
      const res = await fetch(`${API_BASE}/api/workflow/files/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || I18n.tr('editor.files.uploadFailed'));
      }
      showNotification(I18n.tr('editor.files.uploaded'));
      loadFiles();
    } catch (err) {
      toast.error(I18n.tr('editor.files.uploadFailed') + ' ' + err.message);
    }
  }

  // Delete file
  window.deleteFile = async function(id) {
    if (!confirm(I18n.tr('editor.files.confirmDelete'))) return;
    try {
      await Api.post('/api/workflow/files/delete', { id });
      showNotification(I18n.tr('editor.files.deleted'));
      loadFiles();
    } catch (e) {
      toast.error(I18n.tr('editor.files.deleteFailed') + ' ' + e.message);
    }
  };

  // File input change handler
  document.getElementById('fileUploadInput').addEventListener('change', async (e) => {
    await uploadFiles(e.target.files);
    e.target.value = '';
  });

  // Drop zone — click to browse
  const dropZone = document.getElementById('fileDropZone');
  dropZone.addEventListener('click', () => document.getElementById('fileUploadInput').click());

  // Drop zone — drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--accent-blue)';
    dropZone.style.background = 'rgba(59,130,246,.04)';
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'var(--border-color)';
    dropZone.style.background = '';
  });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border-color)';
    dropZone.style.background = '';
    await uploadFiles(e.dataTransfer.files);
  });

  // ─── Comments ────────────────────────────────────────────────────────────────

  async function loadComments() {
    try {
      const comments = await Api.get(`/api/workflow/comments?event_id=${eventId}&section_id=${sectionId}`);

      // Feed comments into the editor's margin balloons
      const editorComments = (comments || []).map(c => ({
        id: c.id,
        anchor_id: c.anchorId || null,
        parent_id: c.parentId || null,
        author_name: localizedName(c.userName, c.userNameKa) || 'User',
        comment_text: c.content || '',
        created_at: c.createdAt || new Date().toISOString(),
        can_delete: c.userId === user.id || user.role === 'admin',
      }));
      richEditor.setComments(editorComments);
    } catch (e) {
      console.error('Load comments error:', e);
    }
  }

  // ─── History ─────────────────────────────────────────────────────────────────

  async function loadHistory() {
    try {
      const result = await Api.get(`/api/workflow/section-history?event_id=${eventId}&section_id=${sectionId}`);
      const history = result.history || result;
      const list = document.getElementById('historyList');
      if (!history || history.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 13px;">${escapeHtml(I18n.tr('editor.history.empty'))}</p>`;
        return;
      }
      // Shared role-grouped timeline (section-history-view.js) — also used by the
      // ready-document preview so both stay identical.
      list.innerHTML = SectionHistory.renderTimeline(history);
    } catch (e) {
      console.error('Load history error:', e);
    }
  }
})();
