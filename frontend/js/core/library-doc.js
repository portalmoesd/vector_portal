/**
 * Shared library document helpers — preview, PDF/Word export, file list.
 *
 * Extracted from the Library page so multiple pages (the Library and the
 * Minister dashboard) can render the same read-only document actions without
 * duplicating logic. Depends only on globals that the core scripts already
 * provide: Api, I18n, toast, escapeHtml, formatDate, html2pdf,
 * GCP.exportDocx and downloadFileAuth (api.js).
 *
 * Backed by the /api/library/:eventId/{document,files} endpoints.
 */
(function () {
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
    return sanitizeContent(div).innerHTML;
  }

  // Neutralize script-execution vectors before section HTML (authored by
  // collaborators, and reachable via the API) is injected into a live page for
  // preview/export. Legitimate formatting — bold, colour, tables, inline styles —
  // is preserved; only executable content is removed. Mutates and returns `root`.
  function sanitizeContent(root) {
    root.querySelectorAll('script,style,link,meta,iframe,object,embed,base').forEach(el => el.remove());
    root.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = (attr.value || '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
        // Drop inline event handlers (onerror/onclick/…) and javascript: URLs.
        if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href') && val.startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return root;
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
  async function preview(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);

      // Per-section history visibility mirrors the dashboard section rule:
      // collaborators/SC see the History dropdown only on their own sections;
      // deputies, the owner (DS), and linked supervisors see it on all. Best-effort
      // — if the status-grid can't load, no history dropdowns show (bodies still do).
      let grid = null;
      try { grid = await Api.get(`/api/workflow/status-grid?event_id=${eventId}`); } catch (_) { grid = null; }
      const viewer = (Api && typeof Api.getUser === 'function') ? Api.getUser() : null;
      const bySectionId = new Map(((grid && grid.sections) || []).map(g => [g.sectionId, g]));
      const seesAll = grid ? SectionVisibility.seesAllSections(viewer, grid) : false;
      const canSeeHistory = (s) => !!grid && (seesAll || SectionVisibility.isOwnSection(viewer, bySectionId.get(s.id)));

      const overlay = document.createElement('div');
      overlay.className = 'preview-overlay';
      overlay.innerHTML = `
        <div class="preview-card">
          <div class="preview-header">
            <h2>${escapeHtml(doc.title)}</h2>
            <button class="preview-close" onclick="this.closest('.preview-overlay').remove()">&times;</button>
          </div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
            ${escapeHtml(localizedCountryName({ code: doc.countryCode, name_en: doc.countryName, name_ka: doc.countryNameKa }))}${doc.endedAt ? ' | ' + new Date(doc.endedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.') : ''}
          </div>
          ${doc.sections.map(s => `
            <div class="section-block">
              <h3>${escapeHtml(s.title)}</h3>
              <div class="section-content-preview">${stripTrackChanges(s.htmlContent || '<em>No content</em>')}</div>
              ${canSeeHistory(s) ? `
                <details class="lib-history" data-section-id="${s.id}">
                  <summary>${escapeHtml(I18n.tr('library.history.title'))}</summary>
                  <div class="lib-history__body"></div>
                </details>` : ''}
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

      // Lazy-load each section's history the first time its dropdown is opened.
      overlay.querySelectorAll('details.lib-history').forEach(det => {
        det.addEventListener('toggle', async () => {
          if (!det.open || det.dataset.loaded) return;
          det.dataset.loaded = '1';
          const body = det.querySelector('.lib-history__body');
          const emptyHtml = `<p style="color: var(--text-muted); font-size: 13px;">${escapeHtml(I18n.tr('editor.history.empty'))}</p>`;
          try {
            const res = await Api.get(`/api/workflow/section-history?event_id=${eventId}&section_id=${det.dataset.sectionId}`);
            const history = res.history || res;
            body.innerHTML = (history && history.length) ? SectionHistory.renderTimeline(history) : emptyHtml;
          } catch (e) {
            det.dataset.loaded = '';   // allow a retry on next open
            body.innerHTML = emptyHtml;
          }
        });
      });
    } catch (e) {
      toast.error(I18n.tr('library.preview.failLoad') + ' ' + e.message);
    }
  }

  // ── Export PDF ─────────────────────────────────────────────────────────────
  async function exportPdf(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.pdfTitle'), (sections) => {
        const datePart = doc.endedAt ? ' | ' + new Date(doc.endedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.') : '';
        const html = `
          <div style="font-family: Arial, sans-serif; font-size: 11pt; padding: 20px;">
            <p style="font-size: 13pt; font-weight: bold; margin-bottom: 4px;">${escapeHtml(doc.title)}</p>
            <p style="color: #666; font-size: 9pt; margin-bottom: 24px;">${escapeHtml(localizedCountryName({ code: doc.countryCode, name_en: doc.countryName, name_ka: doc.countryNameKa }))}${datePart}</p>
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
  }

  // ── Export Word ────────────────────────────────────────────────────────────
  async function exportWord(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.wordTitle'), async (sections) => {
        try {
          // Include section comments so anchored ones export as native Word comments
          const mapped = await Promise.all(sections.map(async s => {
            let comments = [];
            try {
              const raw = await Api.get(`/api/workflow/comments?event_id=${eventId}&section_id=${s.id}`);
              comments = (raw || []).map(c => ({
                id: c.id,
                anchorId: c.anchorId || null,
                parentId: c.parentId || null,
                authorName: (typeof localizedName === 'function' && localizedName(c.userName, c.userNameKa)) || c.userName || 'Unknown',
                text: c.content || '',
                createdAt: c.createdAt,
              }));
            } catch (_) { /* comments are optional in the export */ }
            return { sectionLabel: s.title, htmlContent: s.htmlContent, comments };
          }));
          await window.GCP.exportDocx(doc.title, mapped, {
            countryName: localizedCountryName({ code: doc.countryCode, name_en: doc.countryName, name_ka: doc.countryNameKa }),
            endedAt: doc.endedAt,
          });
        } catch (err) {
          toast.error(I18n.tr('library.export.wordFail') + ' ' + err.message);
        }
      });
    } catch (e) {
      toast.error(I18n.tr('library.export.fail') + ' ' + e.message);
    }
  }

  // ── View Files ──────────────────────────────────────────────────────────────
  async function viewFiles(eventId) {
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
  }

  window.LibraryDoc = { preview, exportPdf, exportWord, viewFiles, stripTrackChanges, showSectionSelectModal };
})();
