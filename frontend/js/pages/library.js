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

  // Admin-only: permanently erase the whole library (COMPLETED + ARCHIVED
  // events). This removes those events everywhere, not just the library view.
  const clearBtn = document.getElementById('clearLibraryBtn');
  if (clearBtn && user.role === 'ADMIN') {
    clearBtn.style.display = '';
    clearBtn.addEventListener('click', async () => {
      let count = documents.length;
      try {
        const preview = await Api.get('/api/library/clear/preview');
        count = preview.count;
      } catch (_) { /* fall back to the loaded list length */ }

      if (!confirm(I18n.tr('library.clear.confirm', { count }))) return;

      try {
        const res = await Api.delete('/api/library/clear');
        toast.success(I18n.tr('library.clear.done', { count: res.deleted }));
        documents = await Api.get('/api/library');
        render();
      } catch (e) { toast.error(e.message); }
    });
  }

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
            <span>${escapeHtml(localizedCountryName({ code: d.countryCode, name_en: d.countryName }))}</span>
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

  // Preview / export / files are shared with the Minister dashboard via the
  // LibraryDoc module (/js/core/library-doc.js). The card markup binds to these
  // global handlers, so expose the shared implementations under the same names.
  window.previewDoc = LibraryDoc.preview;
  window.exportPdf = LibraryDoc.exportPdf;
  window.exportWord = LibraryDoc.exportWord;
  window.viewFiles = LibraryDoc.viewFiles;

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
