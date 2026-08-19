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

  // ── Keeping content inside the PDF page ─────────────────────────────────────
  // html2pdf builds its own container at exactly the printable width
  // (210mm - 2*12.7mm = 184.6mm, about 698 CSS px) and html2canvas crops at that
  // element's bounding box — anything laid out wider is rasterised off the edge
  // and silently disappears.
  //
  // The trap is that the editor's own protections are scoped to `.gcp-re-body`
  // (see editor-core.js) and do not travel with the content: `overflow-wrap`,
  // `table { width: 100% }` and its narrower cell padding are all lost. What the
  // export inherits instead is the app's *global* table styling from
  // components.css, which is wider — fatter cell padding plus uppercased,
  // letter-spaced headers. So a table that fits on screen can overflow here.
  //
  // These rules restore the lost protections, as inline styles rather than an
  // injected <style> block: html2pdf clones the container into the live page, so
  // a stylesheet would leak into the app while the export runs.

  const PDF_TEXT_BLOCKS = 'p, div, li, blockquote, td, th';

  /** Constrain section HTML so nothing can exceed the PDF's capture width. */
  function constrainForPdf(html) {
    if (!html) return html || '';
    const root = document.createElement('div');
    root.innerHTML = html;

    // Long unbreakable tokens (URLs, file paths) would otherwise run off the edge.
    root.querySelectorAll(PDF_TEXT_BLOCKS).forEach(el => {
      el.style.overflowWrap = 'break-word';
      el.style.wordBreak = 'break-word';
    });

    // The sanitizer preserves width/height attributes on images, so a pasted
    // screenshot keeps its natural size and hangs off the page.
    root.querySelectorAll('img').forEach(el => {
      el.style.maxWidth = '100%';
      el.style.height = 'auto';
    });

    // insertTable() emits no widths at all; `fixed` makes the columns share the
    // available measure instead of growing to fit their content.
    root.querySelectorAll('table').forEach(el => {
      el.style.width = '100%';
      el.style.maxWidth = '100%';
      el.style.tableLayout = 'fixed';
    });

    // Match the editor's cell padding rather than the app's roomier global rule,
    // and undo the global uppercasing, which widens header cells.
    root.querySelectorAll('td, th').forEach(el => {
      el.style.padding = '6px 10px';
    });
    root.querySelectorAll('th').forEach(el => {
      el.style.textTransform = 'none';
      el.style.letterSpacing = 'normal';
    });

    return root.innerHTML;
  }

  // ── Page breaks ────────────────────────────────────────────────────────────
  // html2pdf renders the whole document into one tall canvas and then slices it
  // into fixed-height bands, a purely geometric cut that knows nothing about
  // where the text sits: any line crossing a boundary is guillotined.
  //
  // Its `pagebreak` plugin is meant to prevent that, and it does not work well
  // enough here. It measures elements in the *live* DOM and inserts spacers to
  // push straddling ones down, but html2canvas rasterises a re-laid-out clone,
  // not the live DOM, and the two disagree. Measured on a four-page export, the
  // clone's lines sat between 1.5 px above and 10 px below where the live layout
  // put them, drifting further down the document; the plugin also aligns to
  // `floor(inner.height in px)` = 1026 css px while the slicer cuts every
  // `floor(canvasWidth * ratio) / scale` = 1026.5 css px, so its "perfectly
  // aligned" elements start half a pixel before each cut anyway. Paragraphs it
  // had already moved were still sliced through the middle of the glyphs.
  //
  // So pagination is done on the canvas instead, which is the thing that is
  // actually cut. Before handing it to the slicer we look at each upcoming
  // boundary, walk up to the nearest near-blank row and pad the page out to full
  // height from there. Every band boundary then falls in whitespace by
  // construction, whatever the clone's layout turned out to be.

  // A row counts as a cut point when at most this fraction of it is inked. Not
  // zero: a break between two table rows still crosses the vertical borders, and
  // those few columns should not veto an otherwise clean cut.
  const CUT_INK_RATIO = 0.02;
  // How far up from a boundary to look. Beyond this the element is too tall to
  // move (a full-page image, a long table) and it is cut where it falls, which
  // is what html2pdf would have done anyway.
  const CUT_SEARCH_RATIO = 0.3;

  /** Non-white pixel count for each row of [y, y + h) of `ctx`. */
  function rowInk(ctx, width, y, h) {
    const d = ctx.getImageData(0, y, width, h).data;
    const out = new Array(h);
    for (let r = 0; r < h; r++) {
      let n = 0;
      const base = r * width * 4;
      for (let x = 0; x < width; x++) {
        const i = base + x * 4;
        // Anti-aliasing leaves near-white pixels around glyphs; 245 keeps those
        // from reading as ink while still catching the faintest real rule.
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) { n++; }
      }
      out[r] = n;
    }
    return out;
  }

  /**
   * Re-pad a rendered canvas so that every `band`-high slice starts on blank
   * pixels, and return the new canvas.
   *
   * Returns the canvas untouched if it fits on one page, or if reading its
   * pixels is not allowed — a cross-origin image taints the canvas and
   * getImageData throws, in which case the old geometric slicing still applies
   * rather than the export failing.
   */
  function alignCanvasToPages(canvas, band) {
    if (!canvas || !band || canvas.height <= band) return canvas;

    let ctx;
    try {
      ctx = canvas.getContext('2d');
      ctx.getImageData(0, 0, 1, 1);
    } catch (e) {
      console.warn('PDF page alignment skipped (canvas is tainted):', e.message);
      return canvas;
    }

    const inkLimit = Math.max(2, Math.round(canvas.width * CUT_INK_RATIO));
    const reach = Math.max(1, Math.round(band * CUT_SEARCH_RATIO));

    // Source rows at which each page ends. The search window never starts above
    // `hard - reach`, so every page advances by at least (1 - CUT_SEARCH_RATIO)
    // of a band and the loop always terminates.
    const cuts = [];
    let start = 0;
    while (start + band < canvas.height) {
      const hard = start + band;
      const from = Math.max(start + 1, hard - reach);
      const ink = rowInk(ctx, canvas.width, from, hard - from + 1);
      let cut = hard;
      for (let r = ink.length - 1; r >= 0; r--) {
        if (ink[r] <= inkLimit) { cut = from + r; break; }
      }
      cuts.push(cut);
      start = cut;
    }
    cuts.push(canvas.height);

    const out = document.createElement('canvas');
    out.width = canvas.width;
    // The final page keeps only the height it needs; html2pdf trims the last
    // page to `height % band`, which is how the PDF stays A4 rather than
    // stretching a short page to fill the sheet.
    out.height = (cuts.length - 1) * band + (cuts[cuts.length - 1] - (cuts[cuts.length - 2] || 0));
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);

    let src = 0;
    cuts.forEach((cut, i) => {
      const h = Math.min(cut - src, band);
      octx.drawImage(canvas, 0, src, canvas.width, h, 0, i * band, canvas.width, h);
      src = cut;
    });
    return out;
  }

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
            return parent && parent.checked ? Object.assign({}, sec, { selectedPointCount: 0 }) : null;
          }
          const chosen = boxes.filter(cb => cb.checked)
            .map(cb => pointsBySection[i][parseInt(cb.dataset.point)]);
          if (!chosen.length) return null;
          return Object.assign({}, sec, {
            htmlContent: GCP.DiscussionPoints.toExportHtml(chosen, doc.language),
            selectedPointCount: chosen.length,
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
  async function exportPdf(eventId) {
    try {
      const doc = await Api.get(`/api/library/${eventId}/document`);
      showSectionSelectModal(doc, I18n.tr('library.export.pdfTitle'), async (sections) => {
        const flag = await flagPng(doc.countryCode, 128);
        const dateLabel = docDateLabel(doc);
        const metaLine = [docCountryLabel(doc), dateLabel].filter(Boolean).join(' · ');
        // No container padding — the pdf page margin alone positions the
        // content, so the text starts at the top of the printable area.
        // padding-right keeps justified lines off the capture boundary. Measured:
        // ragged text ends ~6px inside html2canvas's crop edge, but justified text
        // ends flush at the measure, leaving only ~0.5px — inside the rounding and
        // glyph-overhang zone, which shaves the last character. 3px restores the
        // clearance ragged text always had, and is invisible at print size.
        const html = `
          <div style="font-family: Arial, sans-serif; font-size: 11pt; padding-right: 3px;">
            <div style="display:flex; align-items:center; gap:14px; padding-bottom:12px; border-bottom:2px solid #0a84ff; margin-bottom:22px;">
              ${flag ? `<img src="${flag.dataUrl}" style="width:42px;height:42px;border-radius:50%;flex:0 0 auto;">` : ''}
              <div>
                <div style="font-size:15pt; font-weight:bold; line-height:1.25; margin:0;">${escapeHtml(doc.title)}</div>
                ${metaLine ? `<div style="color:#666; font-size:9.5pt; margin-top:3px;">${escapeHtml(metaLine)}</div>` : ''}
              </div>
            </div>
            ${sections.map(s => `
              <p style="font-size: 12pt; font-weight: bold; border-bottom: 1px solid #ccc; padding-bottom: 4px;">${escapeHtml(s.title)}</p>
              <div>${constrainForPdf(justifyBodyHtml(stripTrackChanges(s.htmlContent || '')))}</div>
            `).join('<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;">')}
          </div>
        `;

        if (typeof html2pdf !== 'undefined') {
          const container = document.createElement('div');
          container.innerHTML = html;
          const slug = doc.title.replace(/[^a-zA-Z0-9]+/g, '-').substring(0, 80);
          html2pdf().from(container).set({
            margin: [12.7, 12.7, 12.7, 12.7],
            filename: `${slug}.pdf`,
            // scrollX/scrollY pinned to 0 — html2canvas otherwise offsets the
            // capture by the page's scroll position, so exporting from a
            // scrolled library list pushed the content down (or off) the page.
            html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
            jsPDF: { format: 'a4', orientation: 'portrait' },
            image: { type: 'jpeg', quality: 0.98 },
            // The DOM-side pagebreak plugin is left on its defaults on purpose —
            // see alignCanvasToPages above for why it cannot be trusted to keep
            // a line off a page boundary, and what replaces it.
          })
            .toCanvas()
            .then(function alignPages() {
              // toPdf slices at exactly this height, so align to the same grid.
              const band = Math.floor(this.prop.canvas.width * this.prop.pageSize.inner.ratio);
              this.prop.canvas = alignCanvasToPages(this.prop.canvas, band);
            })
            .save();
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
    isDiscussionPoints, sectionPoints, renderDiscussionPoints, sectionPreviewHtml,
    commentsAnchoredIn, justifyBodyHtml, constrainForPdf, alignCanvasToPages,
  };
})();
