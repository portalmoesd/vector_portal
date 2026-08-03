/**
 * GCP Word Export — converts editor HTML (with track-change markup) to .docx
 * with native Word revision marks (accept/reject in Word).
 *
 * Depends on: docx (UMD bundle → window.docx)
 * Exposes: window.GCP.exportDocx(title, sections) → Promise<void> (triggers download)
 *
 * Track-change mapping:
 * <ins data-tc-id data-tc-author data-tc-time> → InsertedTextRun
 * <del data-tc-id data-tc-author data-tc-time> → DeletedTextRun
 * <span data-tc-fmt-id ...> → TextRun (visual only — Word
 * format revisions are not fully supported by the docx lib, so we render the
 * current formatted text as a normal run with the formatting applied)
 */

(function () {
  'use strict';

  if (!window.docx) {
    console.warn('[docx-export] docx library not loaded');
    return;
  }

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    InsertedTextRun, DeletedTextRun,
    AlignmentType, UnderlineType, VerticalAlign,
    convertInchesToTwip,
    Table, TableRow, TableCell, WidthType,
    CommentRangeStart, CommentRangeEnd, CommentReference,
    BorderStyle, ImageRun,
  } = window.docx;

  // Word comment support requires docx >= 8 (CommentRangeStart et al.)
  const COMMENTS_SUPPORTED = !!(CommentRangeStart && CommentRangeEnd && CommentReference);

  // anchorId → numeric Word comment id, rebuilt per export
  let _commentAnchorMap = {};

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Parse a CSS rgb()/hex colour to a 6-char hex string (no #). */
  function toHex6(raw) {
    if (!raw) return undefined;
    raw = raw.trim();
    if (raw.startsWith('#')) {
      const h = raw.slice(1);
      if (h.length === 3) return h.split('').map(c => c + c).join('');
      if (h.length >= 6) return h.slice(0, 6);
    }
    const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      return [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
    }
    return undefined;
  }

  /** Convert pt string → half-points (Word internal unit). */
  function ptToHalfPt(pt) { return Math.round(Number(pt) * 2); }

  // ── Inline formatting extractor ────────────────────────────────────────────

  /** Walk up the DOM from `node` gathering inline style. */
  function getInlineFormat(node) {
    const fmt = {};
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && !el.classList?.contains('gcp-re-body') && el.tagName !== 'BODY') {
      const tag = el.tagName;
      if (tag === 'B' || tag === 'STRONG') fmt.bold = true;
      if (tag === 'I' || tag === 'EM') fmt.italics = true;
      if (tag === 'U') fmt.underline = { type: UnderlineType.SINGLE };
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') fmt.strike = true;
      if (tag === 'SUP') fmt.superScript = true;
      if (tag === 'SUB') fmt.subScript = true;

      const style = el.style;
      if (style) {
        if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 700) fmt.bold = true;
        if (style.fontStyle === 'italic') fmt.italics = true;
        if (style.textDecoration && style.textDecoration.includes('underline'))
          fmt.underline = { type: UnderlineType.SINGLE };
        if (style.textDecoration && style.textDecoration.includes('line-through'))
          fmt.strike = true;
        // Inline font-family from pasted content is deliberately ignored —
        // the whole exported document renders in Calibri (see the document
        // default styles in buildDocx).
        if (style.fontSize) {
          const ptMatch = style.fontSize.match(/(\d+\.?\d*)pt/);
          if (ptMatch) fmt.size = ptToHalfPt(ptMatch[1]);
          const pxMatch = style.fontSize.match(/(\d+\.?\d*)px/);
          if (pxMatch) fmt.size = ptToHalfPt(Number(pxMatch[1]) * 0.75);
        }
        const clr = style.color;
        if (clr) { const h = toHex6(clr); if (h) fmt.color = h; }
      }
      el = el.parentElement;
    }
    return fmt;
  }

  // ── Node walker ────────────────────────────────────────────────────────────

  /** Recursively collect docx TextRun / InsertedTextRun / DeletedTextRun from a DOM subtree. */
  function walkInline(node, runs) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!text) return;
      const fmt = getInlineFormat(node);

      // Check if inside a tracked insertion
      const insEl = closestTag(node, 'INS');
      if (insEl && insEl.hasAttribute('data-tc-id')) {
        runs.push(new InsertedTextRun({
          text,
          ...fmt,
          id: revisionId(insEl),
          author: insEl.getAttribute('data-tc-author') || 'Unknown',
          date: insEl.getAttribute('data-tc-time') || new Date().toISOString(),
        }));
        return;
      }

      // Check if inside a tracked deletion
      const delEl = closestTag(node, 'DEL');
      if (delEl && delEl.hasAttribute('data-tc-id')) {
        runs.push(new DeletedTextRun({
          text,
          ...fmt,
          id: revisionId(delEl),
          author: delEl.getAttribute('data-tc-author') || 'Unknown',
          date: delEl.getAttribute('data-tc-time') || new Date().toISOString(),
        }));
        return;
      }

      // Normal text
      runs.push(new TextRun({ text, ...fmt }));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;

    // Skip hidden del elements that have no tc-id (shouldn't happen, but safe)
    if (tag === 'DEL' && !node.hasAttribute('data-tc-id')) return;

    // Comment anchors → Word comment range + reference mark
    if (tag === 'SPAN' && node.classList && node.classList.contains('gcp-cmt-anchor')) {
      const cid = _commentAnchorMap[node.getAttribute('data-cmt-anchor-id')];
      if (cid !== undefined && COMMENTS_SUPPORTED) {
        runs.push(new CommentRangeStart(cid));
        for (const child of node.childNodes) walkInline(child, runs);
        runs.push(new CommentRangeEnd(cid));
        runs.push(new TextRun({ children: [new CommentReference(cid)] }));
        return;
      }
    }

    // For ins/del with tc-id, we still walk children (the text nodes inside)
    // For all other elements, just recurse
    for (const child of node.childNodes) {
      walkInline(child, runs);
    }
  }

  function closestTag(node, tagName) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      if (el.tagName === tagName) return el;
      if (el.classList?.contains('gcp-re-body') || el.tagName === 'BODY') return null;
      el = el.parentElement;
    }
    return null;
  }

  // Keep a monotonic revision counter so each tc gets a unique numeric id.
  let _revCounter = 0;
  const _revMap = {};
  function revisionId(el) {
    const tcId = el.getAttribute('data-tc-id') || el.getAttribute('data-tc-fmt-id') || '';
    if (_revMap[tcId] !== undefined) return _revMap[tcId];
    _revMap[tcId] = _revCounter++;
    return _revMap[tcId];
  }

  // ── Block-level parser ─────────────────────────────────────────────────────

  /** Detect alignment from a block element. */
  function getAlignment(el) {
    const ta = el.style?.textAlign;
    if (ta === 'center') return AlignmentType.CENTER;
    if (ta === 'right') return AlignmentType.RIGHT;
    if (ta === 'justify') return AlignmentType.BOTH;
    return undefined;
  }

  /** Convert an element and its children into an array of docx Paragraph objects. */
  function parseBlock(el, listLevel) {
    const paragraphs = [];
    const tag = el.tagName;

    // Headings
    if (tag === 'H1') {
      const runs = []; walkInline(el, runs);
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs, alignment: getAlignment(el) }));
      return paragraphs;
    }
    if (tag === 'H2') {
      const runs = []; walkInline(el, runs);
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs, alignment: getAlignment(el) }));
      return paragraphs;
    }
    if (tag === 'H3') {
      const runs = []; walkInline(el, runs);
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs, alignment: getAlignment(el) }));
      return paragraphs;
    }
    if (tag === 'H4') {
      const runs = []; walkInline(el, runs);
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_4, children: runs, alignment: getAlignment(el) }));
      return paragraphs;
    }

    // Lists
    if (tag === 'UL' || tag === 'OL') {
      const isOrdered = tag === 'OL';
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        // Collect inline runs from LI (excluding nested lists)
        const runs = [];
        for (const child of li.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
          walkInline(child, runs);
        }
        if (runs.length) {
          const bulletOpts = isOrdered
            ? { numbering: { reference: 'default-numbering', level: listLevel || 0 } }
            : { bullet: { level: listLevel || 0 } };
          paragraphs.push(new Paragraph({ children: runs, ...bulletOpts, alignment: getAlignment(li) }));
        }
        // Recurse into nested lists
        for (const child of li.children) {
          if (child.tagName === 'UL' || child.tagName === 'OL') {
            paragraphs.push(...parseBlock(child, (listLevel || 0) + 1));
          }
        }
      }
      return paragraphs;
    }

    // Table → native Word table (fallback: flatten to tab-separated paragraphs
    // if the bundled docx build has no Table support)
    if (tag === 'TABLE') {
      if (Table && TableRow && TableCell) {
        const rows = [];
        for (const row of el.querySelectorAll('tr')) {
          const cells = [];
          for (const cell of row.querySelectorAll('td, th')) {
            const cellParas = [];
            const hasBlockChildren = Array.from(cell.children).some(c =>
              /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE)$/.test(c.tagName));
            if (hasBlockChildren) {
              for (const child of cell.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                  const text = child.textContent.trim();
                  if (text) cellParas.push(new Paragraph({ children: [new TextRun({ text })] }));
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                  cellParas.push(...parseBlock(child, listLevel));
                }
              }
            } else {
              const runs = [];
              walkInline(cell, runs);
              cellParas.push(new Paragraph({ children: runs }));
            }
            cells.push(new TableCell({
              children: cellParas.length ? cellParas : [new Paragraph({ children: [] })],
              columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
              rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
            }));
          }
          if (cells.length) rows.push(new TableRow({ children: cells }));
        }
        if (rows.length) {
          paragraphs.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
        return paragraphs;
      }
      for (const row of el.querySelectorAll('tr')) {
        const runs = [];
        const cells = row.querySelectorAll('td, th');
        cells.forEach((cell, i) => {
          if (i > 0) runs.push(new TextRun({ text: '\t' }));
          walkInline(cell, runs);
        });
        if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
      }
      return paragraphs;
    }

    // BR
    if (tag === 'BR') {
      paragraphs.push(new Paragraph({ children: [] }));
      return paragraphs;
    }

    // Generic block: P, DIV, BLOCKQUOTE, etc.
    if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE' || tag === 'SECTION' || tag === 'ARTICLE') {
      // If it only contains inline content, make one paragraph
      const hasBlockChildren = Array.from(el.children).some(c =>
        /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|SECTION|ARTICLE)$/.test(c.tagName)
      );
      if (!hasBlockChildren) {
        const runs = []; walkInline(el, runs);
        if (runs.length) paragraphs.push(new Paragraph({ children: runs, alignment: getAlignment(el) }));
        return paragraphs;
      }
      // Mixed block + inline: walk children individually
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent.trim();
          if (text) paragraphs.push(new Paragraph({ children: [new TextRun({ text })] }));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          paragraphs.push(...parseBlock(child, listLevel));
        }
      }
      return paragraphs;
    }

    // Fallback: treat as inline content in a paragraph
    const runs = []; walkInline(el, runs);
    if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
    return paragraphs;
  }

  // ── HTML string → docx Paragraphs ─────────────────────────────────────────

  function htmlToParagraphs(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';
    const paras = [];
    for (const child of wrapper.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.trim();
        if (text) paras.push(new Paragraph({ children: [new TextRun({ text })] }));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        paras.push(...parseBlock(child, 0));
      }
    }
    return paras;
  }

  // ── Main export function ───────────────────────────────────────────────────

  /**
   * Build the docx Document without triggering a download.
   *
   * @param {string} title Document title
   * @param {Array<{sectionLabel:string, htmlContent:string, comments?:Array}>} sections
   *   Optional per-section `comments`: [{ id, anchorId, parentId, authorName,
   *   text, createdAt }] — anchored root comments become native Word comments
   *   (replies are appended inside the parent comment's body).
   * @param {object} [meta] Optional metadata: { countryName, endedAt }
   */
  function buildDocx(title, sections, meta) {
    // Reset revision counter and comment registry for each export
    _revCounter = 0;
    for (const k in _revMap) delete _revMap[k];
    _commentAnchorMap = {};

    // Register anchored root comments so walkInline can mark their ranges
    const docComments = [];
    if (COMMENTS_SUPPORTED) {
      for (const sec of sections) {
        const list = sec.comments || [];
        for (const c of list) {
          if (c.parentId || !c.anchorId) continue;
          const cid = docComments.length;
          _commentAnchorMap[c.anchorId] = cid;
          const body = [new Paragraph({ children: [new TextRun({ text: c.text || '' })] })];
          for (const r of list) {
            if (r.parentId !== c.id) continue;
            body.push(new Paragraph({
              children: [new TextRun({ text: `↩ ${r.authorName || 'Unknown'}: ${r.text || ''}`, italics: true })],
            }));
          }
          docComments.push({
            id: cid,
            author: c.authorName || 'Unknown',
            date: c.createdAt ? new Date(c.createdAt) : new Date(),
            children: body,
          });
        }
      }
    }

    const children = [];

    // ── Header: [flag] title + country · date, underlined by an accent rule ──
    const metaParts = [];
    if (meta && meta.countryName) metaParts.push(meta.countryName);
    if (meta && meta.endedAt) {
      const d = new Date(meta.endedAt);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      metaParts.push(dd + '.' + mm + '.' + yyyy);
    }

    const titlePara = new Paragraph({
      children: [new TextRun({ text: title || 'Document', bold: true, size: ptToHalfPt(16) })],
      spacing: { after: metaParts.length ? 60 : 0 },
    });
    const metaPara = metaParts.length
      ? new Paragraph({
          children: [new TextRun({ text: metaParts.join(' · '), size: ptToHalfPt(9.5), color: '666666' })],
        })
      : null;

    // The country flag (event-card artwork, rasterized client-side) sits in a
    // borderless two-cell table beside the title — Word's closest match to
    // the portal's card header layout.
    const flagBytes = meta && meta.flagPng;
    if (flagBytes && ImageRun) {
      const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
      const cellBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
          insideHorizontal: noBorder, insideVertical: noBorder,
        },
        rows: [new TableRow({
          children: [
            new TableCell({
              borders: cellBorders,
              width: { size: 700, type: WidthType.DXA },
              verticalAlign: VerticalAlign ? VerticalAlign.CENTER : undefined,
              children: [new Paragraph({
                children: [new ImageRun({ data: flagBytes, transformation: { width: 40, height: 40 } })],
              })],
            }),
            new TableCell({
              borders: cellBorders,
              verticalAlign: VerticalAlign ? VerticalAlign.CENTER : undefined,
              children: [titlePara, ...(metaPara ? [metaPara] : [])],
            }),
          ],
        })],
      }));
    } else {
      children.push(titlePara);
      if (metaPara) children.push(metaPara);
    }

    // Accent rule closing the header block.
    children.push(new Paragraph({
      spacing: { before: 120, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '0A84FF' } },
    }));

    // Sections
    sections.forEach((sec, idx) => {
      // Light grey divider between sections.
      if (idx > 0) {
        children.push(new Paragraph({
          spacing: { before: 240, after: 240 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' } },
        }));
      }

      // Section heading — 12pt (1pt larger than 11pt body text)
      children.push(new Paragraph({
        children: [new TextRun({ text: sec.sectionLabel || 'Section', bold: true, size: ptToHalfPt(12) })],
        spacing: { before: idx > 0 ? 0 : 200, after: 200 },
      }));

      // Section content
      const paras = htmlToParagraphs(sec.htmlContent);
      children.push(...paras);
    });

    const doc = new Document({
      ...(docComments.length ? { comments: { children: docComments } } : {}),
      // Everything renders in Calibri, 11pt body default; explicit run sizes
      // (title, headings, meta) still apply on top.
      styles: {
        default: {
          document: { run: { font: 'Calibri', size: ptToHalfPt(11) } },
        },
      },
      numbering: {
        config: [{
          reference: 'default-numbering',
          levels: Array.from({ length: 9 }, (_, i) => ({
            level: i,
            format: 'decimal',
            text: `%${i + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: convertInchesToTwip(0.5 * (i + 1)), hanging: convertInchesToTwip(0.25) } } },
          })),
        }],
      },
      sections: [{
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        children,
      }],
    });

    return doc;
  }

  async function exportDocx(title, sections, meta) {
    const doc = buildDocx(title, sections, meta);
    const blob = await Packer.toBlob(doc);

    // Trigger download
    const filename = (title || 'document')
      .trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 80) + '.docx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  // Expose
  window.GCP = window.GCP || {};
  window.GCP.exportDocx = exportDocx;
  window.GCP.buildDocx = buildDocx;

})();
