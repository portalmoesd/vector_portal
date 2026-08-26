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

  // ── Justified body text ─────────────────────────────────────────────────────
  // Exported documents circulate as formal ministry papers, where body prose is
  // set flush to both margins. Rather than teaching each exporter about
  // alignment separately, the section HTML is normalised once here: the PDF path
  // renders these inline styles directly, and the Word path converts them via
  // getAlignment() in docx-export.js, which already maps `justify` to
  // AlignmentType.BOTH. So neither exporter needs to change.

  // Blocks that carry body prose. Headings are absent on purpose — a heading
  // keeps whatever alignment it was given.
  const BODY_BLOCKS = 'p, div, li, blockquote';

  /**
   * Set `text-align: justify` on the body blocks of a section's HTML.
   *
   * Any alignment the author chose in the editor is overwritten: the exported
   * document is uniform by design. Two things are deliberately left alone —
   * headings (see BODY_BLOCKS) and anything inside a table, because justifying
   * a narrow column opens ugly gaps between words.
   *
   * Only ever sets a style. Tracked-change markup (<ins>/<del>) and comment
   * anchors pass through untouched, which the Word export depends on to emit
   * native revisions and comments.
   */
  function justifyBodyHtml(html) {
    if (!html) return html || '';
    const root = document.createElement('div');
    root.innerHTML = html;

    // Loose text with no block around it would reach Word as an unaligned
    // paragraph (docx-export.js turns bare text nodes into plain Paragraphs),
    // so give it one. Content and order are preserved.
    Array.from(root.childNodes).forEach(node => {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return;
      const p = document.createElement('p');
      root.insertBefore(p, node);
      p.appendChild(node);
    });

    root.querySelectorAll(BODY_BLOCKS).forEach(el => {
      if (el.closest('table')) return;
      el.style.textAlign = 'justify';
    });
    return root.innerHTML;
  }

  // ── Fitting the export to the printable page ────────────────────────────────
  // html2pdf lays the document out in a box exactly as wide as the A4 printable
  // area and rasterizes that box, so anything sticking out of it is not on the
  // canvas at all — it is simply missing from the right of the page. Section HTML
  // arrives carrying whatever geometry its author gave it (the server sanitizer
  // allows inline width/height in absolute units, and a table or image pasted
  // from Word or a browser brings the width it had there), so absolute widths
  // are dropped here and EXPORT_CSS below bounds whatever is left.

  const PAGE_MARGIN_MM = 12.7;                        // 0.5in on all four sides
  const CONTENT_WIDTH_MM = 210 - 2 * PAGE_MARGIN_MM;  // A4 portrait minus margins
  const ABSOLUTE_LENGTH = /^-?\d+(\.\d+)?(px|pt|pc|cm|mm|in|q)$/i;

  /**
   * Drop the layout that cannot fit the printable width from a section's HTML.
   *
   * Absolute widths go; percentages stay, since those are relative to the
   * container and therefore already fit. An <img> also loses an absolute height,
   * so `height: auto` can keep its aspect ratio once the width is bounded.
   *
   * Only ever removes sizing. Tracked-change markup (<ins>/<del>), comment
   * anchors, colours and alignment pass through untouched, the same guarantee
   * justifyBodyHtml() makes.
   */
  function fitToPageHtml(html) {
    if (!html) return html || '';
    const root = document.createElement('div');
    root.innerHTML = html;
    root.querySelectorAll('*').forEach(el => {
      const isImg = el.tagName === 'IMG';
      const props = isImg ? ['width', 'min-width', 'height', 'min-height'] : ['width', 'min-width'];
      props.forEach(prop => {
        if (ABSOLUTE_LENGTH.test((el.style.getPropertyValue(prop) || '').trim())) {
          el.style.removeProperty(prop);
        }
      });
      // Legacy sizing attributes. The sanitizer only keeps these on <img>, but
      // the others cost nothing to clear and cover unsanitized input.
      if (isImg || ['TABLE', 'TD', 'TH'].indexOf(el.tagName) !== -1) {
        el.removeAttribute('width');
        el.removeAttribute('height');
      }
    });
    return root.innerHTML;
  }

  // Styles for the exported document. Everything is scoped to `.pdf-export`:
  // html2pdf attaches its render container to the live page, so an unscoped rule
  // would restyle the app underneath for as long as the export runs.
  //
  // This travels as a real <style> node inside the exported HTML rather than
  // being injected into html2canvas's clone — html2pdf's page-break plugin
  // measures the live container before the snapshot is taken, so styles that
  // existed only in the clone would not influence where the pages break.
  //
  // The table rules mirror the editing canvas (`.gcp-re-body` in
  // editor-core.js): the export carries no app stylesheet, so without them a
  // table renders borderless and as wide as its content wants to be.
  const EXPORT_CSS = `
    .pdf-export, .pdf-export * { box-sizing: border-box; }
    .pdf-export p, .pdf-export div, .pdf-export li, .pdf-export blockquote,
    .pdf-export h1, .pdf-export h2, .pdf-export h3,
    .pdf-export h4, .pdf-export h5, .pdf-export h6 { overflow-wrap: break-word; }
    .pdf-export table { width: 100% !important; border-collapse: collapse; margin: .5em 0; }
    .pdf-export th, .pdf-export td { border: 1px solid #d1d5db; padding: 6px 10px;
      vertical-align: top; overflow-wrap: anywhere; }
    .pdf-export th { background: #f1f5f9; font-weight: 700; text-align: left; }
    .pdf-export img { max-width: 100%; height: auto; }
    .pdf-export pre { white-space: pre-wrap; }
  `;
  // Cells get `anywhere` rather than `break-word` on purpose: only `anywhere`
  // lowers a cell's min-content width, and without that one long token keeps the
  // whole table wider than the page however much `width: 100%` asks otherwise.
  // Body prose keeps `break-word`, which never changes intrinsic sizing and so
  // leaves the justified line breaking alone.

  // ── Discussion-point documents ──────────────────────────────────────────────
  // Sections of a DISCUSSION_POINTS document hold an ordered list of points
  // (topic / context / additional information) rather than free-form prose, so
  // the export picker offers a Section -> Topic tree and the chosen points are
  // rendered to presentation HTML before they reach the exporters.

  function isDiscussionPoints(doc) {
    return !!doc && doc.documentType === 'DISCUSSION_POINTS'
      && typeof GCP !== 'undefined' && !!GCP.DiscussionPoints;
  }

  /** Points of one section, or [] when the section has none. */
  function sectionPoints(section) {
    try {
      return GCP.DiscussionPoints.parsePoints(section.htmlContent || '');
    } catch (e) {
      console.error('Discussion-point parse failed:', e);
      return [];
    }
  }

  /** Render a whole section's points — used by preview and by full exports. */
  function renderDiscussionPoints(section, lang) {
    return GCP.DiscussionPoints.toExportHtml(sectionPoints(section), lang);
  }

  /**
   * Keep only the comments still anchored in `html`.
   *
   * GCP.buildDocx registers every comment it is handed into the .docx package
   * but only emits a reference where it meets the anchor span, so exporting a
   * subset of points without pruning the comment list leaves entries in
   * word/comments.xml that nothing points at. Replies follow their root.
   */
  function commentsAnchoredIn(html, comments) {
    if (!comments || !comments.length) return [];
    const probe = document.createElement('div');
    probe.innerHTML = html || '';
    const present = new Set(
      Array.from(probe.querySelectorAll('[data-cmt-anchor-id]'))
        .map(el => el.getAttribute('data-cmt-anchor-id'))
    );
    const roots = comments.filter(c => !c.parentId && c.anchorId && present.has(c.anchorId));
    const rootIds = new Set(roots.map(c => c.id));
    return comments.filter(c => rootIds.has(c.id) || rootIds.has(c.parentId));
  }

  /**
   * Record the owner's extraction as the meeting agenda.
   *
   * Only the Document Owner's selection is the agenda of record — the export
   * buttons are visible to everyone who can read the document. Gated here to
   * save a pointless round-trip; the server re-checks ownership regardless.
   *
   * Fire-and-forget: recording must never block or fail an export, so a
   * rejected or failed call is logged and swallowed.
   */
  function recordMeetingAgenda(doc, sections) {
    if (!isDiscussionPoints(doc)) return;
    const viewer = (typeof Api !== 'undefined' && Api.getUser) ? Api.getUser() : null;
    if (!viewer || !doc.documentSubmitterId || doc.documentSubmitterId !== viewer.id) return;

    const points = [];
    sections.forEach((sec) => {
      (sec.selectedPoints || []).forEach((p) => {
        points.push({
          sectionId: sec.id,
          dpId: p.id,
          topic: p.topic || '',
          contextHtml: p.contextHtml || '',
          additionalHtml: p.additionalHtml || '',
        });
      });
    });
    if (!points.length) return;

    Api.post('/api/meeting-summaries/agenda', { eventId: doc.eventId, points })
      .catch((e) => console.error('Recording the meeting agenda failed:', e && e.message));
  }

  // ── Section selection modal helper ──────────────────────────────────────────
  function showSectionSelectModal(doc, title, onExport) {
    // Discussion-point documents get a second level: each section lists its
    // topics so the owner can extract any subset of points. Everything else
    // keeps the flat section list.
    const dp = isDiscussionPoints(doc);
    const pointsBySection = dp ? doc.sections.map(sectionPoints) : [];

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
            <label style="display:block;padding:4px 0;cursor:pointer;${dp ? 'font-weight:600;' : ''}">
              <input type="checkbox" class="section-check" data-idx="${i}" checked />
              ${escapeHtml(s.title)}
            </label>
            ${dp ? `<div style="margin:0 0 8px 22px;">${pointsBySection[i].map((p, j) => `
              <label style="display:block;padding:3px 0;cursor:pointer;font-size:13px;">
                <input type="checkbox" class="point-check" data-idx="${i}" data-point="${j}" checked />
                ${escapeHtml(GCP.DiscussionPoints.topicLabel(p, doc.language, j))}
              </label>
            `).join('')}</div>` : ''}
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

    const pointsOf = (idx) =>
      Array.from(overlay.querySelectorAll(`.point-check[data-idx="${idx}"]`));

    // A section checkbox reflects its own points: all / none / indeterminate.
    function syncSection(idx) {
      const section = overlay.querySelector(`.section-check[data-idx="${idx}"]`);
      const boxes = pointsOf(idx);
      if (!section || !boxes.length) return;
      const checked = boxes.filter(cb => cb.checked).length;
      section.checked = checked > 0;
      section.indeterminate = checked > 0 && checked < boxes.length;
    }

    // Select all toggle
    overlay.querySelector('#selectAllSections').addEventListener('change', (e) => {
      overlay.querySelectorAll('.section-check').forEach(cb => {
        cb.checked = e.target.checked;
        cb.indeterminate = false;
      });
      overlay.querySelectorAll('.point-check').forEach(cb => cb.checked = e.target.checked);
    });

    // A section drives its points; a point updates its section.
    overlay.querySelectorAll('.section-check').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.indeterminate = false;
        pointsOf(cb.dataset.idx).forEach(p => p.checked = cb.checked);
      });
    });
    overlay.querySelectorAll('.point-check').forEach(cb => {
      cb.addEventListener('change', () => syncSection(cb.dataset.idx));
    });

    // Export button
    overlay.querySelector('#exportConfirmBtn').addEventListener('click', () => {
      let selectedSections;

      if (dp) {
        // Drive the selection off the topic checkboxes, not the section ones:
        // a partially selected section is `checked` AND `indeterminate`, and
        // the :checked selector does not match an indeterminate checkbox, so
        // reading the parents would silently drop every partial section.
        // Filtering here also keeps exportPdf / exportWord reading plain
        // { title, htmlContent } objects with no branch of their own.
        selectedSections = doc.sections.map((sec, i) => {
          const boxes = pointsOf(i);
          if (!boxes.length) {
            // A section with no discussion points has only its own checkbox.
            const parent = overlay.querySelector(`.section-check[data-idx="${i}"]`);
            return parent && parent.checked
              ? Object.assign({}, sec, { selectedPointCount: 0, selectedPoints: [] })
              : null;
          }
          const chosen = boxes.filter(cb => cb.checked)
            .map(cb => pointsBySection[i][parseInt(cb.dataset.point)]);
          if (!chosen.length) return null;
          return Object.assign({}, sec, {
            htmlContent: GCP.DiscussionPoints.toExportHtml(chosen, doc.language),
            selectedPointCount: chosen.length,
            // The points themselves, so an owner export can record the meeting
            // agenda. Additive: everything else reads htmlContent as before.
            selectedPoints: chosen,
          });
        }).filter(Boolean);

        if (selectedSections.length === 0) {
          toast.warn(I18n.tr(overlay.querySelector('.point-check')
            ? 'library.sectionSelect.warnEmptyTopics'
            : 'library.sectionSelect.warnEmpty'));
          return;
        }
      } else {
        selectedSections = Array.from(overlay.querySelectorAll('.section-check:checked'))
          .map(cb => doc.sections[parseInt(cb.dataset.idx)]);
        if (selectedSections.length === 0) { toast.warn(I18n.tr('library.sectionSelect.warnEmpty')); return; }
      }

      overlay.remove();
      onExport(selectedSections);
    });
  }

  // Body of one section as the reader should see it: discussion-point sections
  // render as numbered topics with labelled Context / Additional Information,
  // matching the PDF and Word output; everything else renders as stored.
  function sectionPreviewHtml(doc, section) {
    // Justified here too, so the preview matches the file the exports produce.
    if (!isDiscussionPoints(doc)) return justifyBodyHtml(section.htmlContent || '');
    return justifyBodyHtml(renderDiscussionPoints(section, doc.language));
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
              <div class="section-content-preview">${stripTrackChanges(sectionPreviewHtml(doc, s) || '<em>No content</em>')}</div>
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

  // ── Flag rasterizer ─────────────────────────────────────────────────────────
  // The event-card flags (/assets/flags/xx.svg, 512×512 circular SVGs) are
  // reused in the export headers. html2canvas and docx both want raster data,
  // so render the SVG onto a canvas once and hand back a PNG data URL + bytes.
  async function flagPng(countryCode, sizePx) {
    try {
      const code = (countryCode || '').toLowerCase();
      if (!code) return null;
      const res = await fetch(`/assets/flags/${code}.svg`);
      if (!res.ok) return null;
      const svgBlob = new Blob([await res.text()], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = sizePx;
      canvas.height = sizePx;
      canvas.getContext('2d').drawImage(img, 0, 0, sizePx, sizePx);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/png');
      const binary = atob(dataUrl.split(',')[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { dataUrl, bytes };
    } catch (_) {
      return null; // header degrades gracefully without a flag
    }
  }

  // Shared header pieces for the exports.
  function docCountryLabel(doc) {
    return localizedCountryName({ code: doc.countryCode, name_en: doc.countryName, name_ka: doc.countryNameKa });
  }
  function docDateLabel(doc) {
    return doc.endedAt
      ? new Date(doc.endedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.')
      : '';
  }

  // ── Export PDF ─────────────────────────────────────────────────────────────

  /**
   * One section: its title glued to the first block of its body.
   *
   * `avoid-all` page-breaking moves any element that straddles a page boundary
   * down to the next page, but a title on its own never straddles anything — it
   * just gets stranded at the foot of a page. Wrapping the title together with
   * the block that follows it makes the pair one short element, so the pair
   * moves as a unit. Same idea as withTitle() in statistics-pdf.js.
   */
  function sectionExportHtml(section) {
    const body = document.createElement('div');
    body.innerHTML = fitToPageHtml(justifyBodyHtml(stripTrackChanges(section.htmlContent || '')));

    const keep = document.createElement('div');
    keep.className = 'pdf-keep';
    keep.innerHTML = `<p class="pdf-section-title" style="font-size: 12pt; font-weight: bold; border-bottom: 1px solid #ccc; padding-bottom: 4px;">${escapeHtml(section.title)}</p>`;
    if (body.firstElementChild) keep.appendChild(body.firstElementChild);

    // The section is emitted flat, with no wrapper of its own: a div around the
    // whole section would itself be a block shorter than a sheet, so `avoid-all`
    // would keep *it* whole and push a nearly-full section to the next page,
    // leaving most of one blank.
    const out = document.createElement('div');
    out.appendChild(keep);
    while (body.firstChild) out.appendChild(body.firstChild);
    return out.innerHTML;
  }

  /**
   * The whole exported document as one HTML string — header, then each section.
   *
   * Kept separate from exportPdf() so the layout can be rendered and measured on
   * its own, which is what the PDF layout tests do.
   */
  function buildExportHtml(doc, sections, flagDataUrl) {
    const metaLine = [docCountryLabel(doc), docDateLabel(doc)].filter(Boolean).join(' · ');
    // No container padding — the pdf page margin alone positions the
    // content, so the text starts at the top of the printable area.
    return `
      <div class="pdf-export" style="font-family: Arial, sans-serif; font-size: 11pt;">
        <style>${EXPORT_CSS}</style>
        <div class="pdf-keep" style="display:flex; align-items:center; gap:14px; padding-bottom:12px; border-bottom:2px solid #0a84ff; margin-bottom:22px;">
          ${flagDataUrl ? `<img src="${flagDataUrl}" style="width:42px;height:42px;border-radius:50%;flex:0 0 auto;">` : ''}
          <div>
            <div style="font-size:15pt; font-weight:bold; line-height:1.25; margin:0;">${escapeHtml(doc.title)}</div>
            ${metaLine ? `<div style="color:#666; font-size:9.5pt; margin-top:3px;">${escapeHtml(metaLine)}</div>` : ''}
          </div>
        </div>
        ${sections.map(sectionExportHtml).join('<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;">')}
      </div>
    `;
  }

  /** html2pdf settings. `scale` comes from fittingScale() below. */
  function pdfOptions(filename, scale) {
    return {
      margin: [PAGE_MARGIN_MM, PAGE_MARGIN_MM, PAGE_MARGIN_MM, PAGE_MARGIN_MM],
      filename,
      // scrollX/scrollY pinned to 0 — html2canvas otherwise offsets the
      // capture by the page's scroll position, so exporting from a
      // scrolled library list pushed the content down (or off) the page.
      html2canvas: { scale, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { format: 'a4', orientation: 'portrait' },
      image: { type: 'jpeg', quality: 0.98 },
      // 'avoid-all' pushes any element that would straddle a page boundary onto
      // the next page, so the raster is cut between blocks instead of through a
      // line of text. Without it html2pdf slices the canvas at fixed intervals
      // and paragraphs are cut in half at the bottom of the sheet. 'css' and
      // 'legacy' are html2pdf's own defaults, kept so explicit page-break
      // styling keeps working.
      pagebreak: { mode: ['css', 'legacy', 'avoid-all'] },
    };
  }

  // A canvas is capped by the browser — 268M pixels on Chrome, considerably less
  // on Safari — and past the cap html2canvas hands back a truncated bitmap, so
  // the tail of a long document goes missing from the PDF with no error. Stay
  // well inside the smallest of those caps.
  const MAX_CANVAS_AREA = 80e6;

  /**
   * Render `container` off-screen at the width html2pdf will use, and pick the
   * largest canvas scale (up to the usual 2x) that keeps the bitmap inside
   * MAX_CANVAS_AREA. Only documents dozens of pages long are scaled down.
   *
   * Also the natural place to notice content that still does not fit the page
   * width, which is a bug in fitToPageHtml()/EXPORT_CSS rather than in the file.
   */
  function fittingScale(container) {
    const host = document.createElement('div');
    host.style.cssText = `position:absolute; left:-10000px; top:0; visibility:hidden; width:${CONTENT_WIDTH_MM}mm;`;
    document.body.appendChild(host);
    host.appendChild(container);
    let scale = 2;
    try {
      const pageRight = host.getBoundingClientRect().right;
      const spill = Array.from(host.querySelectorAll('*'))
        .find(el => el.getBoundingClientRect().right > pageRight + 1);
      if (spill) console.warn('PDF export: content wider than the printable page', spill);
      const area = host.offsetWidth * host.offsetHeight;
      if (area > 0) scale = Math.max(1, Math.min(2, Math.sqrt(MAX_CANVAS_AREA / area)));
    } catch (_) { /* the measurement is an optimisation; 2x is the safe default */ }
    host.removeChild(container);
    host.remove();
    return scale;
  }

  /**
   * Render arbitrary sections of a document to PDF.
   *
   * Split out of exportPdf so another view — the Meeting Summary table — can
   * reuse the whole pipeline (page CSS, flag header, canvas fitting, the
   * html2pdf-less print fallback) instead of duplicating it. `doc` only needs
   * title / countryCode / endedAt; sections only need { title, htmlContent }.
   */
  async function exportHtmlAsPdf(doc, sections, filenameHint) {
    const flag = await flagPng(doc.countryCode, 128);
    const html = buildExportHtml(doc, sections, flag ? flag.dataUrl : null);
    const base = (filenameHint || doc.title || 'document');
    const slug = base.replace(/[^a-zA-Z0-9]+/g, '-').substring(0, 80);

    if (typeof html2pdf !== 'undefined') {
      const container = document.createElement('div');
      container.innerHTML = html;
      html2pdf().from(container).set(pdfOptions(`${slug}.pdf`, fittingScale(container))).save();
      return;
    }
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>${escapeHtml(doc.title)}</title><style>@page { size: A4; margin: ${PAGE_MARGIN_MM}mm; }</style></head><body>${html}</body></html>`);
    w.document.close();
    w.print();
  }

  /**
   * Render arbitrary sections of a document to .docx, same reasoning as above.
   * No comments are registered: only section bodies carry comment anchors.
   */
  async function exportSectionsAsDocx(doc, sections, filenameHint) {
    const mapped = sections.map(s => ({
      sectionLabel: s.sectionLabel || s.title,
      htmlContent: justifyBodyHtml(s.htmlContent),
      comments: [],
    }));
    const flag = await flagPng(doc.countryCode, 128);
    await window.GCP.exportDocx(filenameHint || doc.title, mapped, {
      countryName: docCountryLabel(doc),
      endedAt: doc.endedAt,
      flagPng: flag ? flag.bytes : null,
    });
  }

  async function exportPdf(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.pdfTitle'), async (sections) => {
        recordMeetingAgenda(doc, sections);
        await exportHtmlAsPdf(doc, sections);
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
        recordMeetingAgenda(doc, sections);
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
            // Only comments whose anchor survived into the exported HTML may be
            // registered — see commentsAnchoredIn(). A no-op for a full export.
            const htmlContent = justifyBodyHtml(s.htmlContent);
            return {
              sectionLabel: s.title,
              htmlContent,
              comments: commentsAnchoredIn(htmlContent, comments),
            };
          }));
          const flag = await flagPng(doc.countryCode, 128);
          await window.GCP.exportDocx(doc.title, mapped, {
            countryName: docCountryLabel(doc),
            endedAt: doc.endedAt,
            flagPng: flag ? flag.bytes : null,
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

  window.LibraryDoc = {
    preview, exportPdf, exportWord, viewFiles, stripTrackChanges, showSectionSelectModal,
    recordMeetingAgenda, exportHtmlAsPdf, exportSectionsAsDocx,
    isDiscussionPoints, sectionPoints, renderDiscussionPoints, sectionPreviewHtml,
    commentsAnchoredIn, justifyBodyHtml, fitToPageHtml,
    // Layout surface, exercised by the PDF layout tests.
    buildExportHtml, pdfOptions, EXPORT_CSS, PAGE_MARGIN_MM, CONTENT_WIDTH_MM,
  };
})();
