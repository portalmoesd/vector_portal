/**
 * Library Page
 * - Lists completed/archived documents the user participated in
 * - Client-side filtering (keyword, country, date range)
 * - Preview modal with full document content
 * - Export to PDF (html2pdf.js) with section selection
 * - Export to Word (docx) with track changes as native Word revisions
 * - View files modal
 */
(async function () {
  await App.init();

  const user = Api.getUser();
  if (!user) return;

  const libraryList = document.getElementById('libraryList');
  const filterKeyword = document.getElementById('filterKeyword');
  const filterCountry = document.getElementById('filterCountry');
  const filterDateFrom = document.getElementById('filterDateFrom');
  const filterDateTo = document.getElementById('filterDateTo');

  let documents = [];
  let countries = [];

  // Load data
  try {
    [documents, countries] = await Promise.all([
      Api.get('/api/library'),
      Api.get('/api/countries'),
    ]);
  } catch (e) {
    libraryList.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
    return;
  }

  // Populate country filter
  filterCountry.innerHTML = `<option value="">${escapeHtml(I18n.tr('common.all'))}</option>` +
    countries.map(c => `<option value="${escapeHtml(c.name_en || c.nameEn || c.name)}">${escapeHtml(localizedCountryName(c))}</option>`).join('');

  // Filters
  [filterKeyword, filterCountry, filterDateFrom, filterDateTo].forEach(el => {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });

  function getFiltered() {
    const kw = filterKeyword.value.toLowerCase().trim();
    const country = filterCountry.value;
    const dateFrom = filterDateFrom.value ? new Date(filterDateFrom.value) : null;
    const dateTo = filterDateTo.value ? new Date(filterDateTo.value) : null;

    return documents.filter(d => {
      if (kw && !(d.title || '').toLowerCase().includes(kw) &&
                !(d.countryName || '').toLowerCase().includes(kw)) return false;
      if (country && d.countryName !== country) return false;
      if (d.endedAt) {
        const ended = new Date(d.endedAt);
        if (dateFrom && ended < dateFrom) return false;
        if (dateTo && ended > new Date(dateTo.getTime() + 86400000)) return false;
      }
      return true;
    });
  }

  function render() {
    const filtered = getFiltered();

    if (filtered.length === 0) {
      libraryList.innerHTML = `<div class="empty-state"><p>${escapeHtml(I18n.tr('library.empty'))}</p></div>`;
      return;
    }

    const lblLanguage = escapeHtml(I18n.tr('library.meta.language'));
    const lblDs = escapeHtml(I18n.tr('library.meta.ds'));
    const lblCompleted = escapeHtml(I18n.tr('library.meta.completed'));
    const lblPreview = escapeHtml(I18n.tr('library.btn.preview'));
    const lblPdf = escapeHtml(I18n.tr('library.btn.pdf'));
    const lblWord = escapeHtml(I18n.tr('library.btn.word'));
    const lblFiles = escapeHtml(I18n.tr('library.btn.files'));
    const lblEdit = escapeHtml(I18n.tr('library.btn.edit'));
    const editTooltip = I18n.tr('library.editTooltip');

    libraryList.innerHTML = filtered.map(d => `
      <div class="doc-card">
        <div class="doc-card-info">
          <h4>${escapeHtml(d.title)}</h4>
          <div class="doc-card-meta">
            <span>${escapeHtml(d.countryName)}</span>
            <span>${lblLanguage} ${languageLabel(d.language)}</span>
            <span>${lblDs} ${escapeHtml(d.documentSubmitterName)}</span>
            ${d.endedAt ? `<span>${lblCompleted} ${formatDate(d.endedAt)}</span>` : ''}
          </div>
        </div>
        <div class="doc-card-actions">
          <button class="btn btn-outline" onclick="previewDoc(${d.id})">
            <span class="icon" style="--icon-url: url(/assets/view-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
            ${lblPreview}
          </button>
          <button class="btn btn-outline" onclick="exportPdf(${d.id})">
            <span class="icon" style="--icon-url: url(/assets/export-pdf-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
            ${lblPdf}
          </button>
          <button class="btn btn-outline" onclick="exportWord(${d.id})">
            <span class="icon" style="--icon-url: url(/assets/export-word-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
            ${lblWord}
          </button>
          <button class="btn btn-outline" onclick="viewFiles(${d.id})">
            <span class="icon" style="--icon-url: url(/assets/files-icon.svg); mask-image: var(--icon-url); -webkit-mask-image: var(--icon-url); width:16px;height:16px;display:inline-block;background:currentColor;"></span>
            ${lblFiles}
          </button>
          ${d.documentSubmitterId === user.id ? `
            <button class="btn btn-outline" onclick="reopenDoc(${d.id})" title="${escapeHtml(editTooltip)}">
              ${lblEdit}
            </button>` : ''}
        </div>
      </div>
    `).join('');
  }

  // ── Section selection modal helper ──────────────────────────────────────────
  function showSectionSelectModal(doc, title, onExport) {
    const overlay = document.createElement('div');
    overlay.className = 'preview-overlay';
    overlay.innerHTML = `
      <div class="preview-card" style="max-width:500px;">
        <div class="preview-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="preview-close" onclick="this.closest('.preview-overlay').remove()">&times;</button>
        </div>
        <div style="margin-bottom:16px;">
          <label style="cursor:pointer;font-weight:600;">
            <input type="checkbox" id="selectAllSections" checked /> ${escapeHtml(I18n.tr('library.sectionSelect.selectAll'))}
          </label>
        </div>
        <div id="sectionChecklist">
          ${doc.sections.map((s, i) => `
            <label style="display:block;padding:4px 0;cursor:pointer;">
              <input type="checkbox" class="section-check" data-idx="${i}" checked />
              ${escapeHtml(s.title)}
            </label>
          `).join('')}
        </div>
        <div style="margin-top:16px;text-align:right;">
          <button class="btn btn-outline" onclick="this.closest('.preview-overlay').remove()">${escapeHtml(I18n.tr('common.cancel'))}</button>
          <button class="btn btn-primary" id="exportConfirmBtn" style="margin-left:8px;">${escapeHtml(title)}</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    // Select all toggle
    overlay.querySelector('#selectAllSections').addEventListener('change', (e) => {
      overlay.querySelectorAll('.section-check').forEach(cb => cb.checked = e.target.checked);
    });

    // Export button
    overlay.querySelector('#exportConfirmBtn').addEventListener('click', () => {
      const selectedIdxs = Array.from(overlay.querySelectorAll('.section-check:checked'))
        .map(cb => parseInt(cb.dataset.idx));
      const selectedSections = selectedIdxs.map(i => doc.sections[i]);
      if (selectedSections.length === 0) { toast.warn(I18n.tr('library.sectionSelect.warnEmpty')); return; }
      overlay.remove();
      onExport(selectedSections);
    });
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  window.previewDoc = async function(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);

      const overlay = document.createElement('div');
      overlay.className = 'preview-overlay';
      overlay.innerHTML = `
        <div class="preview-card">
          <div class="preview-header">
            <h2>${escapeHtml(doc.title)}</h2>
            <button class="preview-close" onclick="this.closest('.preview-overlay').remove()">&times;</button>
          </div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
            ${escapeHtml(doc.countryName)}${doc.endedAt ? ' | ' + new Date(doc.endedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.') : ''}
          </div>
          ${doc.sections.map(s => `
            <div class="section-block">
              <h3>${escapeHtml(s.title)}</h3>
              <div class="section-content-preview">${stripTrackChanges(s.htmlContent || '<em>No content</em>')}</div>
            </div>
          `).join('')}
        </div>
      `;

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      document.body.appendChild(overlay);

      // Hide track changes in preview (show accepted view)
      overlay.querySelectorAll('.section-content-preview del').forEach(el => el.style.display = 'none');
      overlay.querySelectorAll('.section-content-preview ins').forEach(el => {
        el.style.textDecoration = 'none';
        el.style.backgroundColor = 'transparent';
        el.style.color = 'inherit';
      });
    } catch (e) {
      toast.error(I18n.tr('library.preview.failLoad') + ' ' + e.message);
    }
  };

  function stripTrackChanges(html) {
    // Remove del elements, unwrap ins elements for clean preview
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('del').forEach(el => el.remove());
    div.querySelectorAll('ins').forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    return div.innerHTML;
  }

  // ── Export PDF ─────────────────────────────────────────────────────────────
  window.exportPdf = async function(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.pdfTitle'), (sections) => {
        const datePart = doc.endedAt ? ' | ' + new Date(doc.endedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.') : '';
        const html = `
          <div style="font-family: Arial, sans-serif; font-size: 11pt; padding: 20px;">
            <p style="font-size: 13pt; font-weight: bold; margin-bottom: 4px;">${escapeHtml(doc.title)}</p>
            <p style="color: #666; font-size: 9pt; margin-bottom: 24px;">${escapeHtml(doc.countryName)}${datePart}</p>
            ${sections.map(s => `
              <p style="font-size: 12pt; font-weight: bold; border-bottom: 1px solid #ccc; padding-bottom: 4px;">${escapeHtml(s.title)}</p>
              <div>${stripTrackChanges(s.htmlContent || '')}</div>
            `).join('<hr style="margin: 20px 0;">')}
          </div>
        `;

        if (typeof html2pdf !== 'undefined') {
          const container = document.createElement('div');
          container.innerHTML = html;
          const slug = doc.title.replace(/[^a-zA-Z0-9]+/g, '-').substring(0, 80);
          html2pdf().from(container).set({
            margin: [12.7, 12.7, 12.7, 12.7],
            filename: `${slug}.pdf`,
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { format: 'a4', orientation: 'portrait' },
            image: { type: 'jpeg', quality: 0.98 },
          }).save();
        } else {
          // Fallback: open print dialog
          const w = window.open('', '_blank');
          w.document.write(`<html><head><title>${escapeHtml(doc.title)}</title></head><body>${html}</body></html>`);
          w.document.close();
          w.print();
        }
      });
    } catch (e) {
      toast.error(I18n.tr('library.export.fail') + ' ' + e.message);
    }
  };

  // ── Export Word ────────────────────────────────────────────────────────────
  window.exportWord = async function(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.wordTitle'), async (sections) => {
        try {
          const mapped = sections.map(s => ({ sectionLabel: s.title, htmlContent: s.htmlContent }));
          await window.GCP.exportDocx(doc.title, mapped, { countryName: doc.countryName, endedAt: doc.endedAt });
        } catch (err) {
          toast.error(I18n.tr('library.export.wordFail') + ' ' + err.message);
        }
      });
    } catch (e) {
      toast.error(I18n.tr('library.export.fail') + ' ' + e.message);
    }
  };

  // ── View Files ────────────────────────────────────────────────────────────
  window.viewFiles = async function(eventId) {
    try {
      const files = await Api.get(`/api/library/${eventId}/files`);

      const overlay = document.createElement('div');
      overlay.className = 'preview-overlay';
      overlay.innerHTML = `
        <div class="preview-card" style="max-width:700px;">
          <div class="preview-header">
            <h2>${escapeHtml(I18n.tr('library.files.title'))}</h2>
            <button class="preview-close" onclick="this.closest('.preview-overlay').remove()">&times;</button>
          </div>
          ${files.length === 0 ? `<p>${escapeHtml(I18n.tr('library.files.empty'))}</p>` : `
            <div class="table-wrap"><table>
              <thead><tr><th>${escapeHtml(I18n.tr('library.files.col.file'))}</th><th>${escapeHtml(I18n.tr('library.files.col.section'))}</th><th>${escapeHtml(I18n.tr('library.files.col.uploaded'))}</th><th>${escapeHtml(I18n.tr('library.files.col.by'))}</th><th>${escapeHtml(I18n.tr('library.files.col.size'))}</th></tr></thead>
              <tbody>${files.map(f => `
                <tr>
                  <td><a href="#" onclick="downloadFileAuth(${f.id}, '${escapeHtml(f.original_name).replace(/'/g, "\\'")}'); return false;">${escapeHtml(f.original_name)}</a></td>
                  <td>${escapeHtml(f.section_title || '—')}</td>
                  <td>${formatDate(f.created_at)}</td>
                  <td>${escapeHtml(f.uploaded_by_name || '—')}</td>
                  <td>${f.size ? (f.size / 1024).toFixed(1) + ' KB' : '—'}</td>
                </tr>
              `).join('')}</tbody>
            </table></div>
          `}
        </div>
      `;

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      document.body.appendChild(overlay);
    } catch (e) {
      toast.error(I18n.tr('library.files.failLoad') + ' ' + e.message);
    }
  };

  // Reopen a published event for editing. DS-only — the Edit button is
  // already DS-gated in the card render, but the server enforces it
  // again on the endpoint.
  window.reopenDoc = async function(eventId) {
    const ok = window.confirm(I18n.tr('library.reopen.confirm'));
    if (!ok) return;
    try {
      await Api.post(`/api/library/${eventId}/reopen`, {});
      // Send the DS straight to their role-appropriate dashboard so
      // the reopened event is right there in their active list.
      // dashboardUrl() lives in /js/core/utils.js and maps the
      // user's role → /pages/dashboard-<role>.html.
      window.location.href = `${dashboardUrl(user.role)}?event_id=${eventId}`;
    } catch (e) {
      toast.error(I18n.tr('library.reopen.fail') + ' ' + (e.message || I18n.tr('library.reopen.unknownError')));
    }
  };

  render();
})();
