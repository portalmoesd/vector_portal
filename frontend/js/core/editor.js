/**
 * GCP Rich Editor — lightweight contenteditable editor (no external deps)
 * Exposes: window.GCP.RichEditor({ container, initialHtml, authorName, onCommentsClick })
 *
 * Requires editor-core.js (window.GCP.EditorCore) to be loaded first.
 *
 * Track Changes:
 *  - Always recording — no toggle needed to start.
 *  - "Changes" button = Show / Hide markup only.
 *  - Each author gets a unique Word-style colour (8-colour palette).
 *  - Author initials shown as inline chips on every change when visible.
 *  - Reviewing pane lists every change with author, excerpt, time,
 *    and per-change Accept / Reject buttons.
 *  - Self-corrections silently cancel: deleting your own insertion removes
 *    the <ins> without adding a <del>.
 *  - Table structure changes (row/column add/delete) tracked via data-tc-tbl.
 */
(function () {
  'use strict';

  if (!window.GCP || !window.GCP.EditorCore) {
    console.error('[editor] editor-core.js must be loaded before editor.js');
    return;
  }
  const {
    FONT_FAMILIES, FONT_SIZES, TOOLS, TC_PALETTE, COLOUR_PALETTE,
    authorColorIdx, getInitials, escHtml, fmtTime,
    sanitizeUntrustedHtml, trOr, injectStyle,
    execCmd, applyFontSizePt, handleHeading,
  } = window.GCP.EditorCore;

  // ── RichEditor factory ─────────────────────────────────────────────────────

  function RichEditor({ container, initialHtml, placeholder, authorName, sectionTitle, readOnly, onCommentsClick, onDeleteComment, onReplyComment }) {
    injectStyle();

    const wrap = document.createElement('div');
    wrap.className = 'gcp-re-wrap';

    const toolbar = document.createElement('div');
    toolbar.className = 'gcp-re-toolbar';
    toolbar.setAttribute('aria-label', 'Editor toolbar');

    const body = document.createElement('div');
    body.className = 'gcp-re-body';
    body.contentEditable = readOnly ? 'false' : 'true';
    body.setAttribute('role', 'textbox');
    body.setAttribute('aria-multiline', 'true');
    body.setAttribute('data-placeholder', placeholder || trOr('editor.placeholder', 'Start typing…'));
    try {
      if (typeof I18n !== 'undefined' && I18n.getLocale) body.lang = I18n.getLocale() === 'ka' ? 'ka' : 'en';
    } catch (_) {}
    if (initialHtml) body.innerHTML = sanitizeUntrustedHtml(initialHtml);

    // ── Track Changes state ──────────────────────────────────────────────────
    const tc = { visible: false, authorName: authorName || 'Unknown', counter: 0 };
    function newTcId() { return `tc${Date.now()}${++tc.counter}`; }

    // ── Undo / Redo ─────────────────────────────────────────────────────────
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 50;
    function getSelOffsets() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      function offset(node, off) {
        const tw = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
        let pos = 0;
        while (tw.nextNode()) {
          if (tw.currentNode === node) return pos + off;
          if (tw.currentNode.nodeType === Node.TEXT_NODE) pos += tw.currentNode.length;
          else pos += 0;
        }
        return pos;
      }
      return { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset) };
    }
    function restoreSelOffsets(offsets) {
      if (!offsets) return;
      const tw = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
      let pos = 0;
      let startNode = null, startOff = 0, endNode = null, endOff = 0;
      while (tw.nextNode()) {
        const node = tw.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
          if (!startNode && pos + node.length >= offsets.start) { startNode = node; startOff = offsets.start - pos; }
          if (!endNode && pos + node.length >= offsets.end) { endNode = node; endOff = offsets.end - pos; }
          pos += node.length;
        }
        if (startNode && endNode) break;
      }
      if (startNode) {
        try {
          const sel = window.getSelection();
          const r = document.createRange();
          r.setStart(startNode, Math.min(startOff, startNode.length));
          r.setEnd(endNode || startNode, Math.min(endOff, (endNode || startNode).length));
          sel.removeAllRanges(); sel.addRange(r);
        } catch (_) {}
      }
    }
    // Undo snapshots are full innerHTML copies, so two guards keep the cost
    // bounded: consecutive edits in the same group (burst typing, repeated
    // backspace) within COALESCE_MS collapse into ONE undo step — undo removes
    // the burst, not one character, and large documents aren't snapshotted per
    // keystroke — and the stack is capped by total bytes as well as entries.
    const MAX_UNDO_BYTES = 8 * 1024 * 1024;
    const COALESCE_MS = 1000;
    let lastPushGroup = null;
    let lastPushAt = 0;

    function pushUndo(group) {
      const now = Date.now();
      redoStack.length = 0;
      if (group && group === lastPushGroup && now - lastPushAt < COALESCE_MS) {
        lastPushAt = now;
        return;
      }
      lastPushGroup = group || null;
      lastPushAt = now;
      undoStack.push({ html: body.innerHTML, sel: getSelOffsets() });
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      let bytes = 0;
      for (const s of undoStack) bytes += s.html.length;
      while (bytes > MAX_UNDO_BYTES && undoStack.length > 1) {
        bytes -= undoStack.shift().html.length;
      }
    }
    function performUndo() {
      if (!undoStack.length) return;
      lastPushGroup = null;
      redoStack.push({ html: body.innerHTML, sel: getSelOffsets() });
      const state = undoStack.pop();
      body.innerHTML = state.html;
      restoreSelOffsets(state.sel);
      updateTcBar();
    }
    function performRedo() {
      if (!redoStack.length) return;
      lastPushGroup = null;
      undoStack.push({ html: body.innerHTML, sel: getSelOffsets() });
      const state = redoStack.pop();
      body.innerHTML = state.html;
      restoreSelOffsets(state.sel);
      updateTcBar();
    }

    const FMT_TOGGLE = new Set(['bold','italic','underline','strikeThrough','superscript','subscript']);
    const FMT_VALUE  = new Set(['fontName','fontSize','foreColor','backColor']);
    const FMT_BLOCK  = new Set([
      'h2','h3',
      'insertUnorderedList','insertOrderedList',
      'justifyLeft','justifyCenter','justifyRight','justifyFull',
      'removeFormat',
    ]);
    const FMT_CMD_LABELS = {
      bold:'Bold', italic:'Italic', underline:'Underline', strikeThrough:'Strikethrough',
      superscript:'Superscript', subscript:'Subscript',
      fontName:'Font', fontSize:'Font size', foreColor:'Colour', backColor:'Highlight',
      h2:'Heading 2', h3:'Heading 3',
      insertUnorderedList:'Bullet list', insertOrderedList:'Numbered list',
      justifyLeft:'Align left', justifyCenter:'Centre',
      justifyRight:'Align right', justifyFull:'Justify',
      removeFormat:'Clear formatting',
    };
    const fmtCmdLabel = cmd => trOr('editor.fmt.' + cmd, FMT_CMD_LABELS[cmd] || cmd);

    function trackFmtChange(cmd, value) {
      pushUndo();
      const sel = window.getSelection();
      const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
      if (!hasSelection || (!FMT_TOGGLE.has(cmd) && !FMT_VALUE.has(cmd))) {
        execCmd(cmd, value !== undefined ? value : null);
        return;
      }
      const oldVal = FMT_TOGGLE.has(cmd)
        ? String(document.queryCommandState(cmd))
        : (document.queryCommandValue(cmd) || '');
      if (cmd === 'fontSize') applyFontSizePt(value);
      else execCmd(cmd, value !== undefined ? value : null);
      // Word behaviour: formatting on already-inserted (tracked) text is part
      // of the insertion — no separate format-change marker.
      const _closestIns = (node) => {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        return el ? el.closest('ins[data-tc-id]') : null;
      };
      if (_closestIns(sel.anchorNode) && _closestIns(sel.focusNode)) {
        updateTcBar();
        return;
      }
      // After execCommand the browser maintains the selection over the newly
      // formatted nodes.  Use THIS (post-execCommand) range — not a stale
      // pre-execCommand clone whose nodes were restructured by the command.
      try {
        if (sel.rangeCount && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const id = newTcId();
          const [color] = TC_PALETTE[authorColorIdx(tc.authorName)];
          const mark = document.createElement('span');
          mark.setAttribute('data-tc-fmt-id',  id);
          mark.setAttribute('data-tc-fmt-cmd', cmd);
          mark.setAttribute('data-tc-fmt-old', oldVal);
          if (value !== undefined && value !== null) mark.setAttribute('data-tc-fmt-val', String(value));
          mark.setAttribute('data-tc-author',   tc.authorName);
          mark.setAttribute('data-tc-initials', getInitials(tc.authorName));
          mark.setAttribute('data-tc-time',     new Date().toISOString());
          mark.style.setProperty('--tc-color',  color);
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
          // Restore selection over the formatted content
          const nr = document.createRange();
          nr.selectNodeContents(mark);
          sel.removeAllRanges();
          sel.addRange(nr);
        }
      } catch (_) { /* DOM edge case — skip wrapping */ }
      updateTcBar();
    }

    const TC_BLOCK_TAGS = /^(P|H[1-6]|LI|DIV|BLOCKQUOTE|UL|OL|TR|TD|TH)$/i;
    function isBlockEl(el) { return el && el.nodeType === 1 && TC_BLOCK_TAGS.test(el.tagName); }

    function stripTcAttrs(el) {
      ['data-tc-fmt-id','data-tc-fmt-cmd','data-tc-fmt-old','data-tc-fmt-val',
       'data-tc-author','data-tc-initials','data-tc-time'].forEach(a => el.removeAttribute(a));
      el.style.removeProperty('--tc-color');
    }

    function getBlocksInRange(range) {
      const blocks = [];
      const seen = new Set();
      let node = range.startContainer;
      if (node.nodeType !== 1) node = node.parentElement;
      const end = range.endContainer;
      if (!node) return blocks;
      function addBlock(n) {
        let blk = n;
        while (blk && blk !== body) {
          if (isBlockEl(blk) && blk.parentElement === body) { if (!seen.has(blk)) { seen.add(blk); blocks.push(blk); } return; }
          if (isBlockEl(blk)) { if (!seen.has(blk)) { seen.add(blk); blocks.push(blk); } return; }
          blk = blk.parentElement;
        }
        if (!seen.has(body)) { seen.add(body); blocks.push(body); }
      }
      addBlock(node);
      if (end !== node) addBlock(end.nodeType === 1 ? end : end.parentElement);
      return blocks;
    }

    function trackBlockFmtChange(cmd) {
      pushUndo();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        if (cmd === 'h2' || cmd === 'h3') handleHeading(cmd);
        else execCmd(cmd);
        return;
      }
      const range = sel.getRangeAt(0);
      const blocksBefore = getBlocksInRange(range);
      const oldStates = blocksBefore.map(b => ({
        tag: b.tagName.toLowerCase(),
        align: b.style.textAlign || '',
      }));

      if (cmd === 'h2' || cmd === 'h3') handleHeading(cmd);
      else execCmd(cmd);

      // Re-query blocks after the command (tags may have changed)
      const selAfter = window.getSelection();
      const rangeAfter = selAfter && selAfter.rangeCount ? selAfter.getRangeAt(0) : range;
      const blocksAfter = getBlocksInRange(rangeAfter);

      const id = newTcId();
      const [color] = TC_PALETTE[authorColorIdx(tc.authorName)];
      blocksAfter.forEach((block, i) => {
        const old = oldStates[i] || oldStates[0] || { tag: 'p', align: '' };
        block.setAttribute('data-tc-fmt-id',  id);
        block.setAttribute('data-tc-fmt-cmd', cmd);
        block.setAttribute('data-tc-fmt-old', cmd.startsWith('justify') ? old.align : old.tag);
        block.setAttribute('data-tc-author',   tc.authorName);
        block.setAttribute('data-tc-initials', getInitials(tc.authorName));
        block.setAttribute('data-tc-time',     new Date().toISOString());
        block.style.setProperty('--tc-color',  color);
      });
      updateTcBar();
    }

    // ── TC bar ──────────────────────────────────────────────────────────────
    const tcBar = document.createElement('div');
    tcBar.className = 'gcp-re-tc-bar';
    tcBar.style.display = 'none';

    const tcBarLeft = document.createElement('div');
    tcBarLeft.className = 'gcp-re-tc-bar-left';
    const tcSummary = document.createElement('div');
    tcSummary.className = 'gcp-re-tc-summary';
    const tcAuthorsRow = document.createElement('div');
    tcAuthorsRow.className = 'gcp-re-tc-authors-row';
    tcBarLeft.appendChild(tcSummary);
    tcBarLeft.appendChild(tcAuthorsRow);

    const tcBarActions = document.createElement('div');
    tcBarActions.className = 'gcp-re-tc-bar-actions';
    const tcAcceptAll = document.createElement('button');
    tcAcceptAll.type = 'button'; tcAcceptAll.className = 'gcp-re-tc-action accept';
    tcAcceptAll.textContent = I18n.tr('editor.tc.acceptAll');
    const tcRejectAll = document.createElement('button');
    tcRejectAll.type = 'button'; tcRejectAll.className = 'gcp-re-tc-action reject';
    tcRejectAll.textContent = I18n.tr('editor.tc.rejectAll');
    tcBarActions.appendChild(tcAcceptAll);
    tcBarActions.appendChild(tcRejectAll);
    tcBar.appendChild(tcBarLeft);
    tcBar.appendChild(tcBarActions);

    const tcPane = document.createElement('div');
    tcPane.className = 'gcp-re-tc-pane';
    tcPane.style.display = 'none';

    // ── Stored comments ────────────────────────────────────────────────────
    let storedComments = [];
    let cmtPanelVisible = true;

    // ── Selection save/restore ─────────────────────────────────────────────
    let savedRange = null;
    function saveSelection() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
    }
    function restoreSelection() {
      if (!savedRange) return;
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(savedRange);
    }
    body.addEventListener('focusout', e => {
      if (e.relatedTarget && (toolbar.contains(e.relatedTarget) || wrap.contains(e.relatedTarget))) saveSelection();
    });

    // ── Font family ──────────────────────────────────────────────────────────
    const fontFamilySelect = document.createElement('select');
    fontFamilySelect.className = 'gcp-re-select';
    fontFamilySelect.title = 'Font family';
    fontFamilySelect.setAttribute('aria-label', 'Font family');
    FONT_FAMILIES.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.value; opt.textContent = f.label;
      fontFamilySelect.appendChild(opt);
    });
    fontFamilySelect.addEventListener('mousedown', saveSelection);
    fontFamilySelect.addEventListener('change', () => {
      if (fontFamilySelect.value) { restoreSelection(); trackFmtChange('fontName', fontFamilySelect.value); }
      fontFamilySelect.value = ''; body.focus();
    });
    toolbar.appendChild(fontFamilySelect);

    // ── Font size ────────────────────────────────────────────────────────────
    const fontSizeSelect = document.createElement('select');
    fontSizeSelect.className = 'gcp-re-select';
    fontSizeSelect.title = 'Font size';
    fontSizeSelect.setAttribute('aria-label', 'Font size');
    FONT_SIZES.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.value; opt.textContent = f.label;
      fontSizeSelect.appendChild(opt);
    });
    fontSizeSelect.addEventListener('mousedown', saveSelection);
    fontSizeSelect.addEventListener('change', () => {
      const pt = fontSizeSelect.value;
      if (pt) { restoreSelection(); trackFmtChange('fontSize', pt); }
      fontSizeSelect.value = ''; body.focus();
    });
    toolbar.appendChild(fontSizeSelect);

    let activePalette = null;
    function closePalette() { if (activePalette) { activePalette.remove(); activePalette = null; } }
    document.addEventListener('mousedown', e => {
      if (activePalette && !activePalette.contains(e.target)) closePalette();
    }, true);

    function makePalettePopup(anchorOrPos, applyColor) {
      closePalette();
      const pop = document.createElement('div');
      pop.className = 'gcp-re-palette';
      const grid = document.createElement('div');
      grid.className = 'gcp-re-palette-grid';
      COLOUR_PALETTE.forEach(hex => {
        const sw = document.createElement('button');
        sw.type = 'button'; sw.className = 'gcp-re-palette-swatch';
        sw.style.background = hex; sw.title = hex;
        sw.addEventListener('mousedown', e => e.preventDefault());
        sw.addEventListener('click', () => { closePalette(); applyColor(hex); });
        grid.appendChild(sw);
      });
      pop.appendChild(grid);
      const div = document.createElement('div'); div.className = 'gcp-re-palette-divider';
      pop.appendChild(div);
      const customRow = document.createElement('label');
      customRow.className = 'gcp-re-palette-custom';
      customRow.textContent = I18n.tr('editor.color.custom');
      const customInput = document.createElement('input');
      customInput.type = 'color'; customInput.value = '#000000';
      customInput.addEventListener('change', () => { closePalette(); applyColor(customInput.value); });
      customRow.appendChild(customInput);
      pop.appendChild(customRow);
      document.body.appendChild(pop);
      let baseTop, baseLeft;
      if (anchorOrPos && 'x' in anchorOrPos) {
        baseTop = anchorOrPos.y + 4; baseLeft = anchorOrPos.x;
      } else {
        const r = anchorOrPos.getBoundingClientRect();
        baseTop = r.bottom + 4; baseLeft = r.left;
      }
      let top = baseTop, left = baseLeft;
      if (left + pop.offsetWidth  > window.innerWidth  - 8) left = window.innerWidth  - pop.offsetWidth  - 8;
      if (top  + pop.offsetHeight > window.innerHeight - 8) top  = baseTop - pop.offsetHeight - 8;
      pop.style.top = top + 'px'; pop.style.left = left + 'px';
      activePalette = pop;
    }

    // ── Font colour button ────────────────────────────────────────────────────
    const colorWrap = document.createElement('span');
    colorWrap.className = 'gcp-re-color-wrap'; colorWrap.title = I18n.tr('editor.color.font');
    colorWrap.style.cursor = 'pointer';
    const colorLabel = document.createElement('span');
    colorLabel.className = 'gcp-re-color-label'; colorLabel.setAttribute('aria-hidden', 'true');
    const colorA = document.createElement('span');
    colorA.className = 'gcp-re-color-a'; colorA.textContent = 'A';
    const colorBar = document.createElement('span'); colorBar.className = 'gcp-re-color-bar';
    colorLabel.appendChild(colorA); colorLabel.appendChild(colorBar);
    colorWrap.appendChild(colorLabel);
    colorWrap.addEventListener('mousedown', e => { e.preventDefault(); saveSelection(); });
    colorWrap.addEventListener('click', () => {
      makePalettePopup(colorWrap, hex => {
        colorBar.style.background = hex;
        restoreSelection(); trackFmtChange('foreColor', hex); body.focus();
      });
    });
    toolbar.appendChild(colorWrap);

    // ── Background colour button ──────────────────────────────────────────────
    const bgColorWrap = document.createElement('span');
    bgColorWrap.className = 'gcp-re-color-wrap'; bgColorWrap.title = I18n.tr('editor.color.highlight');
    bgColorWrap.style.cursor = 'pointer';
    const bgColorLabel = document.createElement('span');
    bgColorLabel.className = 'gcp-re-color-label'; bgColorLabel.setAttribute('aria-hidden', 'true');
    const bgColorA = document.createElement('span');
    bgColorA.className = 'gcp-re-color-a'; bgColorA.style.cssText = 'display:flex;align-items:center;justify-content:center;';
    bgColorA.innerHTML = '<svg width="14" height="13" viewBox="0 0 14 13" fill="none" style="display:block"><path d="M4.5 4 C4.5 1.5 9.5 1.5 9.5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M3 4.5 L4 11 L10 11 L11 4.5 Z" fill="currentColor" opacity="0.85"/></svg>';
    const bgColorBar = document.createElement('span'); bgColorBar.className = 'gcp-re-color-bar';
    bgColorBar.style.background = '#ffff00';
    bgColorLabel.appendChild(bgColorA); bgColorLabel.appendChild(bgColorBar);
    bgColorWrap.appendChild(bgColorLabel);
    bgColorWrap.addEventListener('mousedown', e => { e.preventDefault(); saveSelection(); });
    bgColorWrap.addEventListener('click', () => {
      makePalettePopup(bgColorWrap, hex => {
        bgColorBar.style.background = hex;
        restoreSelection(); trackFmtChange('backColor', hex); body.focus();
      });
    });
    toolbar.appendChild(bgColorWrap);

    // Separator
    const firstSep = document.createElement('span');
    firstSep.className = 'gcp-re-sep'; firstSep.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(firstSep);

    // ── Format buttons ───────────────────────────────────────────────────────
    TOOLS.forEach(tool => {
      if (tool.sep) {
        const sep = document.createElement('span');
        sep.className = 'gcp-re-sep'; sep.setAttribute('aria-hidden', 'true');
        toolbar.appendChild(sep); return;
      }
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'gcp-re-btn';
      const localizedTitle = I18n.tr('editor.tool.' + tool.cmd);
      // I18n.tr falls back to the key when missing — keep the English title in that case.
      const title = (localizedTitle && localizedTitle !== 'editor.tool.' + tool.cmd) ? localizedTitle : tool.title;
      btn.innerHTML = tool.icon; btn.title = title;
      btn.setAttribute('aria-label', title); btn.dataset.cmd = tool.cmd;
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        if (FMT_BLOCK.has(tool.cmd)) trackBlockFmtChange(tool.cmd);
        else trackFmtChange(tool.cmd);
        body.focus(); updateActive();
      });
      toolbar.appendChild(btn);
    });

    // ── Insert Table button ───────────────────────────────────────────────────
    const tblSep = document.createElement('span');
    tblSep.className = 'gcp-re-sep'; tblSep.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(tblSep);

    const tblBtn = document.createElement('button');
    tblBtn.type = 'button'; tblBtn.className = 'gcp-re-btn';
    tblBtn.title = I18n.tr('editor.table.insert');
    tblBtn.setAttribute('aria-label', I18n.tr('editor.table.insert'));
    tblBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="1" y1="5.5" x2="15" y2="5.5" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="10" x2="15" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="5.5" y1="1" x2="5.5" y2="15" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="1" x2="10" y2="15" stroke="currentColor" stroke-width="1.2"/></svg>';
    toolbar.appendChild(tblBtn);

    let activeTblPicker = null;
    function closeTblPicker() { if (activeTblPicker) { activeTblPicker.remove(); activeTblPicker = null; } }
    document.addEventListener('mousedown', e => {
      if (activeTblPicker && !activeTblPicker.contains(e.target) && e.target !== tblBtn) closeTblPicker();
    }, true);

    tblBtn.addEventListener('mousedown', e => e.preventDefault());
    tblBtn.addEventListener('click', () => {
      if (activeTblPicker) { closeTblPicker(); return; }
      saveSelection();
      const ROWS = 8, COLS = 8;
      const picker = document.createElement('div');
      picker.className = 'gcp-re-tbl-picker';
      const grid = document.createElement('div');
      grid.className = 'gcp-re-tbl-grid';
      const label = document.createElement('div');
      label.className = 'gcp-re-tbl-label'; label.textContent = I18n.tr('editor.table.insert');
      let hoverR = 0, hoverC = 0;
      function updateGrid(r, c) {
        hoverR = r; hoverC = c;
        label.textContent = (r && c)
          ? I18n.tr('editor.table.size').replace('{r}', r).replace('{c}', c)
          : I18n.tr('editor.table.insert');
        grid.querySelectorAll('.gcp-re-tbl-cell').forEach(cell => {
          const cr = +cell.dataset.r, cc = +cell.dataset.c;
          cell.classList.toggle('hi', cr <= r && cc <= c);
        });
      }
      for (let r = 1; r <= ROWS; r++) {
        for (let c = 1; c <= COLS; c++) {
          const cell = document.createElement('div');
          cell.className = 'gcp-re-tbl-cell';
          cell.dataset.r = r; cell.dataset.c = c;
          cell.addEventListener('mousemove', () => updateGrid(r, c));
          cell.addEventListener('click', () => {
            closeTblPicker();
            restoreSelection();
            insertTable(r, c);
            body.focus();
          });
          grid.appendChild(cell);
        }
      }
      picker.addEventListener('mouseleave', () => updateGrid(0, 0));
      picker.appendChild(grid);
      picker.appendChild(label);
      document.body.appendChild(picker);
      const bRect = tblBtn.getBoundingClientRect();
      let top = bRect.bottom + 4, left = bRect.left;
      if (left + picker.offsetWidth > window.innerWidth - 8) left = window.innerWidth - picker.offsetWidth - 8;
      picker.style.top = top + 'px'; picker.style.left = left + 'px';
      activeTblPicker = picker;
    });

    function insertTable(rows, cols) {
      let html = '<table><tbody>';
      for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      document.execCommand('insertHTML', false, html);
    }

    // ── Spacer ────────────────────────────────────────────────────────────────
    const toolbarSpacer = document.createElement('span');
    toolbarSpacer.style.cssText = 'flex:1;';
    toolbar.appendChild(toolbarSpacer);

    // ── Track Changes toggle button ──────────────────────────────────────────
    const tcSepEl = document.createElement('span');
    tcSepEl.className = 'gcp-re-sep'; tcSepEl.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(tcSepEl);

    const tcBtn = document.createElement('button');
    tcBtn.type = 'button'; tcBtn.className = 'gcp-re-btn';
    tcBtn.title = I18n.tr('editor.tc.toggleTitle');
    tcBtn.setAttribute('aria-label', I18n.tr('editor.tc.toggleAria'));
    tcBtn.setAttribute('aria-pressed', 'false');

    const tcBtnLabel = document.createElement('span');
    tcBtnLabel.textContent = I18n.tr('editor.tc.label');
    const tcBadge = document.createElement('span');
    tcBadge.className = 'gcp-re-tc-badge'; tcBadge.style.display = 'none';
    tcBtn.appendChild(tcBtnLabel); tcBtn.appendChild(tcBadge);
    toolbar.appendChild(tcBtn);

    // ── Comments button ──────────────────────────────────────────────────────
    const cmtSep = document.createElement('span');
    cmtSep.className = 'gcp-re-sep'; cmtSep.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(cmtSep);

    const cmtBtn = document.createElement('button');
    cmtBtn.type = 'button'; cmtBtn.className = 'gcp-re-btn';
    cmtBtn.title = I18n.tr('editor.comments.toggleTitle');
    cmtBtn.setAttribute('aria-label', I18n.tr('editor.comments.toggleAria'));
    cmtBtn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><path d="M14 1H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5.586l2.707 2.707a1 1 0 0 0 1.414 0L14 12h0a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1z"/></svg>';
    const cmtBadge = document.createElement('span');
    cmtBadge.className = 'gcp-re-cmt-badge'; cmtBadge.style.display = 'none';
    cmtBtn.appendChild(cmtBadge);
    toolbar.appendChild(cmtBtn);

    const addCmtBtn = document.createElement('button');
    addCmtBtn.type = 'button'; addCmtBtn.className = 'gcp-re-btn gcp-re-btn--mobile-only';
    addCmtBtn.title = I18n.tr('editor.comment.addTitle');
    addCmtBtn.setAttribute('aria-label', I18n.tr('editor.comment.addTitle'));
    addCmtBtn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><path d="M14 1H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5.586l2.707 2.707a1 1 0 0 0 1.414 0L14 12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1z"/></svg><span style="font-size:11px;margin-left:2px;">+</span>';
    addCmtBtn.addEventListener('mousedown', e => e.preventDefault());
    if (readOnly) addCmtBtn.style.display = 'none';
    toolbar.appendChild(addCmtBtn);

    // ── Fullscreen button ────────────────────────────────────────────────────
    const fsSep = document.createElement('span');
    fsSep.className = 'gcp-re-sep'; fsSep.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(fsSep);

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button'; fsBtn.className = 'gcp-re-btn';
    fsBtn.setAttribute('aria-label', I18n.tr('editor.fullscreen.aria'));
    fsBtn.title = I18n.tr('editor.fullscreen.title');
    fsBtn.innerHTML = '<svg class="gcp-re-btn-fullscreen-icon-expand" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4"/></svg><svg class="gcp-re-btn-fullscreen-icon-compress" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 1v4H1M15 5h-4V1M11 15v-4h4M1 11h4v4"/></svg>';
    toolbar.appendChild(fsBtn);

    let fsActive = false;
    let fsOriginalParent = null;
    let fsOriginalNextSibling = null;
    function toggleFullscreen(force) {
      fsActive = force !== undefined ? force : !fsActive;
      if (fsActive) {
        fsOriginalParent = wrap.parentNode;
        fsOriginalNextSibling = wrap.nextSibling;
        document.body.appendChild(wrap);
      } else {
        if (fsOriginalParent) {
          fsOriginalParent.insertBefore(wrap, fsOriginalNextSibling || null);
        }
      }
      wrap.classList.toggle('gcp-fullscreen', fsActive);
      document.body.style.overflow = fsActive ? 'hidden' : '';
      fsBtn.setAttribute('aria-pressed', String(fsActive));
      positionBalloons();
    }
    fsBtn.addEventListener('click', () => toggleFullscreen());

    // ── DOM assembly ─────────────────────────────────────────────────────────
    const contentRow = document.createElement('div');
    contentRow.className = 'gcp-re-content-row';
    const marginEl = document.createElement('div');
    marginEl.className = 'gcp-re-margin';
    contentRow.appendChild(body);
    contentRow.appendChild(marginEl);
    // Balloon positions are content-relative (anchor and margin shift
    // together), so scrolling doesn't move them — a full rebuild per scroll
    // frame is wasted work. Refresh once after scrolling settles to catch
    // any layout edge cases.
    let _scrollSettleTimer = 0;
    contentRow.addEventListener('scroll', () => {
      clearTimeout(_scrollSettleTimer);
      _scrollSettleTimer = setTimeout(positionBalloons, 150);
    });

    const fsTitleBar = document.createElement('div');
    fsTitleBar.className = 'gcp-re-fs-titlebar';
    const fsTitleEl = document.createElement('span');
    fsTitleEl.className = 'gcp-re-fs-title';
    fsTitleEl.textContent = sectionTitle || '';
    fsTitleBar.appendChild(fsTitleEl);

    wrap.appendChild(toolbar);
    wrap.appendChild(tcBar);
    wrap.appendChild(fsTitleBar);
    wrap.appendChild(contentRow);
    container.innerHTML = '';
    container.appendChild(wrap);

    // ── TC helpers ───────────────────────────────────────────────────────────

    function getChangeEntries() {
      const seen = new Set();
      const entries = [];
      body.querySelectorAll('[data-tc-id], [data-tc-fmt-id]').forEach(el => {
        const isFmt = el.hasAttribute('data-tc-fmt-id');
        const id = isFmt ? el.getAttribute('data-tc-fmt-id') : el.getAttribute('data-tc-id');
        if (seen.has(id)) return;
        seen.add(id);
        entries.push({
          id,
          kind:    isFmt ? 'fmt' : el.tagName.toLowerCase(),
          isPara:  el.hasAttribute('data-tc-para'),
          fmtCmd:  isFmt ? (el.getAttribute('data-tc-fmt-cmd') || '') : '',
          author:  el.getAttribute('data-tc-author')   || 'Unknown',
          initials:el.getAttribute('data-tc-initials') || '?',
          time:    el.getAttribute('data-tc-time')     || '',
          color:   el.style.getPropertyValue('--tc-color') || '#1d4ed8',
          text:    el.textContent || '',
        });
      });
      return entries;
    }

    function countChanges() {
      const ids = new Set();
      body.querySelectorAll('[data-tc-id]').forEach(e => ids.add(e.getAttribute('data-tc-id')));
      body.querySelectorAll('[data-tc-fmt-id]').forEach(e => ids.add(e.getAttribute('data-tc-fmt-id')));
      return ids.size;
    }

    function getAuthors() {
      const map = new Map();
      body.querySelectorAll('[data-tc-id], [data-tc-fmt-id]').forEach(el => {
        const a = el.getAttribute('data-tc-author') || 'Unknown';
        map.set(a, (map.get(a) || 0) + 1);
      });
      return [...map.keys()];
    }

    function updateTcBar() {
      const n = countChanges();
      if (n > 0) { tcBadge.textContent = String(n); tcBadge.style.display = ''; }
      else tcBadge.style.display = 'none';
      wrap.classList.toggle('tc-visible', tc.visible);
      wrap.classList.toggle('has-comments', storedComments.length > 0 && cmtPanelVisible);
      tcBtn.classList.toggle('tc-active', tc.visible);
      tcBtn.setAttribute('aria-pressed', String(tc.visible));
      const hasCmts = storedComments.length > 0;
      const show = tc.visible && (n > 0 || hasCmts);
      tcBar.style.display = show ? '' : 'none';
      if (show) {
        const parts = [];
        if (n > 0) {
          parts.push((n === 1
            ? trOr('editor.tc.summaryOne', '1 tracked change')
            : trOr('editor.tc.summaryMany', '{n} tracked changes')).replace('{n}', n));
        }
        if (hasCmts) {
          const m = storedComments.length;
          parts.push((m === 1
            ? trOr('editor.comments.summaryOne', '1 comment')
            : trOr('editor.comments.summaryMany', '{n} comments')).replace('{n}', m));
        }
        tcSummary.textContent = parts.join(' · ');
        tcAuthorsRow.textContent = getAuthors().join(' · ');
      }
      updateChangeMarkers();
      positionBalloons();
    }

    function updateChangeMarkers() {
      body.querySelectorAll('.gcp-tc-changed').forEach(el => el.classList.remove('gcp-tc-changed'));
      if (!tc.visible) return;
      body.querySelectorAll('[data-tc-id], [data-tc-fmt-id]').forEach(el => {
        // If the element itself is a block with tracking attrs, mark it directly
        let block = isBlockEl(el) && el.hasAttribute('data-tc-fmt-id') ? el : el.parentElement;
        while (block && block !== body) {
          const tag = block.tagName.toLowerCase();
          if (['p','li','h1','h2','h3','h4','h5','h6','div','blockquote'].includes(tag)) {
            block.classList.add('gcp-tc-changed'); break;
          }
          block = block.parentElement;
        }
      });
    }

    function cmtAvatar(name) {
      const p = ['#1d4ed8','#b91c1c','#15803d','#7c3aed','#c2410c','#0f766e','#9d174d','#3730a3'];
      const ini = (name || 'Unknown').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0] && s[0].toUpperCase()).filter(Boolean).join('') || '?';
      let h = 0; for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      return { ini, color: p[h % p.length] };
    }

    const expandedGroups = new Set();

    function noOverlap(idealTop, slots, incomingH = 72) {
      let top = Math.max(0, idealTop);
      for (const s of slots) {
        if (top < s.top + s.h + 6 && top + incomingH > s.top) top = s.top + s.h + 6;
      }
      return top;
    }

    let _positionBalloonRafId = 0;
    function positionBalloons() {
      // Teardown happens inside the same frame as the rebuild so balloons
      // never visibly disappear between the two.
      cancelAnimationFrame(_positionBalloonRafId);
      _positionBalloonRafId = requestAnimationFrame(() => {
        marginEl.innerHTML = '';
        const oldSvg = contentRow.querySelector('.gcp-re-connectors');
        if (oldSvg) oldSvg.remove();
        const hasCmts = storedComments.length > 0 && cmtPanelVisible;
        if (!tc.visible && !hasCmts) { marginEl.style.minHeight = ''; return; }
        const crRect = contentRow.getBoundingClientRect();
        const mRect  = marginEl.getBoundingClientRect();
        const scrollTop  = contentRow.scrollTop;
        const scrollLeft = contentRow.scrollLeft;
        const slots = [];
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'gcp-re-connectors');
        svg.setAttribute('width',  String(contentRow.scrollWidth));
        svg.setAttribute('height', String(contentRow.scrollHeight));
        svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible;';
        contentRow.appendChild(svg);
        const mOffLeft = mRect.left - crRect.left + scrollLeft;
        const mOffTop  = mRect.top  - crRect.top  + scrollTop;
        const bodyRight = body.getBoundingClientRect().right - crRect.left + scrollLeft;
        const bodyPadRight = parseFloat(getComputedStyle(body).paddingRight) || 0;
        const contentRight = bodyRight - bodyPadRight;

        function drawConnector(anchorEl, balloonTop, balloonH, color) {
          if (!anchorEl) return;
          const aRect = anchorEl.getBoundingClientRect();
          const ay = aRect.top + aRect.height / 2 - crRect.top + scrollTop;
          const bx = mOffLeft + 2;
          const by = mOffTop + balloonTop + Math.min(balloonH, 26) / 2;
          // 3-point path: content edge → body edge (horizontal in padding) → balloon (diagonal)
          const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          poly.setAttribute('points', `${contentRight},${ay} ${bodyRight},${ay} ${bx},${by}`);
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', color);
          poly.setAttribute('stroke-width', '1');
          poly.setAttribute('stroke-dasharray', '3,3');
          poly.setAttribute('opacity', '0.7');
          svg.appendChild(poly);
        }

        // TC change balloons
        if (tc.visible) {
          const BLOCK_TAGS = new Set(['p','li','h1','h2','h3','h4','h5','h6','div','blockquote']);
          function entryBlock(entry) {
            const isFmt = entry.kind === 'fmt';
            const sel = isFmt ? `[data-tc-fmt-id="${CSS.escape(entry.id)}"]` : `[data-tc-id="${CSS.escape(entry.id)}"]`;
            const el = body.querySelector(sel);
            if (!el) return null;
            // If the element itself is a block (block-level format change), return it
            if (BLOCK_TAGS.has(el.tagName.toLowerCase())) return el;
            let blk = el.parentElement;
            while (blk && blk !== body) {
              if (BLOCK_TAGS.has(blk.tagName.toLowerCase())) return blk;
              blk = blk.parentElement;
            }
            return body;
          }

          const groups = [];
          getChangeEntries().forEach(entry => {
            const t = entry.time ? new Date(entry.time).getTime() : 0;
            const block = entryBlock(entry);
            const last = groups[groups.length - 1];
            // Group same-author entries within 60s.  For consecutive insertions,
            // relax the same-block requirement so a single paste spanning multiple
            // paragraphs collapses into one card (matching Word behaviour).
            const sameAuthorTime = last && last.author === entry.author && Math.abs(t - last.lastT) < 60000;
            const sameBlock = last && last.blockEl === block;
            const allInsertions = last && last.entries.every(e => e.kind === 'ins') && entry.kind === 'ins';
            // Don't group format changes with text changes — they are separate actions
            const lastIsFmt = last && last.entries[0].kind === 'fmt';
            const thisIsFmt = entry.kind === 'fmt';
            const actionTypeMatch = lastIsFmt === thisIsFmt;
            if (sameAuthorTime && actionTypeMatch && (sameBlock || allInsertions)) {
              last.ids.push(entry.id);
              last.entries.push(entry);
              last.lastT = t;
            } else {
              groups.push({ author: entry.author, initials: entry.initials, color: entry.color, time: entry.time, ids: [entry.id], entries: [entry], lastT: t, blockEl: block });
            }
          });

          groups.forEach(group => {
            const firstEntry = group.entries[0];
            const anchorAttr = firstEntry.kind === 'fmt' ? 'data-tc-fmt-id' : 'data-tc-id';
            const anchor = body.querySelector(`[${anchorAttr}="${CSS.escape(group.ids[0])}"]`);
            const ideal = anchor ? anchor.getBoundingClientRect().top - mRect.top : 0;
            const top = noOverlap(ideal, slots);
            const b = document.createElement('div');
            b.className = 'gcp-re-balloon gcp-re-balloon--tc-group';
            b.style.top = top + 'px';
            const n = group.ids.length;
            const fmtLabels = group.entries.filter(e => e.kind === 'fmt' && e.fmtCmd).map(e => fmtCmdLabel(e.fmtCmd)).filter((v, i, a) => a.indexOf(v) === i);
            const txtCount = group.entries.filter(e => e.kind !== 'fmt').length;
            let countLabel = (n === 1
              ? trOr('editor.balloon.changeOne', '1 change')
              : I18n.tr('editor.balloon.changesCount')).replace('{n}', n);
            if (fmtLabels.length > 0 && txtCount === 0) countLabel = `${I18n.tr('editor.balloon.formatted')} · ${fmtLabels.join(', ')}`;
            else if (fmtLabels.length > 0) countLabel = `${I18n.tr('editor.balloon.changesCount').replace('{n}', n)} · ${fmtLabels.join(', ')}`;
            const allTextEntries = group.entries.filter(e => e.kind === 'ins' || e.kind === 'del');
            const needsExpand = allTextEntries.length > 2 || allTextEntries.some(e => e.text.length > 38);
            const snippetLines = allTextEntries.slice(0, 2).map(e => {
              const sign = e.kind === 'ins' ? '+' : '−';
              const cls  = e.kind === 'ins' ? 'gcp-re-snippet-ins' : 'gcp-re-snippet-del';
              const txt  = e.isPara ? '¶' : (e.text.length > 38 ? e.text.slice(0, 38) + '…' : e.text);
              return `<div class="gcp-re-snippet ${cls}">${sign} ${escHtml(txt)}</div>`;
            }).join('');
            const snippetLinesExpanded = allTextEntries.map(e => {
              const sign = e.kind === 'ins' ? '+' : '−';
              const cls  = e.kind === 'ins' ? 'gcp-re-snippet-ins' : 'gcp-re-snippet-del';
              const txt = e.isPara ? '¶' : e.text;
              return `<div class="gcp-re-snippet gcp-re-snippet--wrap ${cls}">${sign} ${escHtml(txt)}</div>`;
            }).join('');
            b.innerHTML = `
              <div class="gcp-re-balloon-header">
                <span class="gcp-re-balloon-avatar" style="background:${escHtml(group.color)}">${escHtml(group.initials)}</span>
                <span class="gcp-re-balloon-author">${escHtml(group.author)}</span>
                <span class="gcp-re-balloon-time">${escHtml(fmtTime(group.time))}</span>
              </div>
              <div class="gcp-re-snippets-collapsed">${snippetLines || `<div class="gcp-re-balloon-change-count">${escHtml(countLabel)}</div>`}</div>
              ${needsExpand ? `<div class="gcp-re-snippets-expanded" style="display:none">${snippetLinesExpanded}</div>` : ''}
              ${needsExpand ? `<button class="gcp-re-balloon-expand" type="button">${escHtml(I18n.tr('editor.balloon.showMore'))}</button>` : ''}
              <div class="gcp-re-balloon-btns">
                <button class="gcp-re-balloon-acc" type="button">✓ ${escHtml(I18n.tr('editor.balloon.accept'))}</button>
                <button class="gcp-re-balloon-rej" type="button">✗ ${escHtml(I18n.tr('editor.balloon.reject'))}</button>
              </div>`;
            b.querySelector('.gcp-re-balloon-acc').addEventListener('click', () => { group.ids.forEach(id => acceptChange(id)); });
            // Reject in reverse DOM order: pasted block wrappers must be gone
            // before their ¶-mark reject can merge the split halves back.
            b.querySelector('.gcp-re-balloon-rej').addEventListener('click', () => { [...group.ids].reverse().forEach(id => rejectChange(id)); });
            if (needsExpand) {
              const groupKey = group.ids[0];
              const expandBtn = b.querySelector('.gcp-re-balloon-expand');
              const collapsedView = b.querySelector('.gcp-re-snippets-collapsed');
              const expandedView = b.querySelector('.gcp-re-snippets-expanded');
              // Restore persisted expand state
              if (expandedGroups.has(groupKey)) {
                collapsedView.style.display = 'none';
                expandedView.style.display  = '';
                expandBtn.textContent = I18n.tr('editor.balloon.showLess');
              }
              expandBtn.addEventListener('click', () => {
                const isExpanded = expandedView.style.display !== 'none';
                collapsedView.style.display = isExpanded ? '' : 'none';
                expandedView.style.display  = isExpanded ? 'none' : '';
                expandBtn.textContent = isExpanded ? I18n.tr('editor.balloon.showMore') : I18n.tr('editor.balloon.showLess');
                if (isExpanded) expandedGroups.delete(groupKey); else expandedGroups.add(groupKey);
                positionBalloons();
              });
            }
            marginEl.appendChild(b);
            const h = Math.max(b.offsetHeight, 72);
            slots.push({ top, h });
            drawConnector(anchor, top, h, '#b91c1c');
          });
        }

        // Comment balloons
        function cmtEntryHtml(c) {
          const { ini, color } = cmtAvatar(c.author_name || 'Unknown');
          return `<div class="gcp-re-balloon-header">
              <span class="gcp-re-balloon-avatar" style="background:${color}">${escHtml(ini)}</span>
              <span class="gcp-re-balloon-author">${escHtml(c.author_name || 'Unknown')}</span>
              <span class="gcp-re-balloon-time">${escHtml(fmtTime(c.created_at))}</span>
            </div>
            <div class="gcp-re-balloon-body">${escHtml(c.comment_text || '')}</div>`;
        }

        // Ensure margin is tall enough to show all balloons and SVG covers the full area
        function updateMarginHeight() {
          if (slots.length > 0) {
            const lastSlot = slots[slots.length - 1];
            const totalBottom = lastSlot.top + lastSlot.h + 20;
            marginEl.style.minHeight = totalBottom + 'px';
            svg.setAttribute('height', String(Math.max(contentRow.scrollHeight, totalBottom + mOffTop)));
          } else {
            marginEl.style.minHeight = '';
          }
        }

        if (!cmtPanelVisible) { updateMarginHeight(); return; }

        const repliesMap = {};
        storedComments.forEach(c => {
          if (c.parent_id) {
            if (!repliesMap[c.parent_id]) repliesMap[c.parent_id] = [];
            repliesMap[c.parent_id].push(c);
          }
        });
        const rootComments = storedComments.filter(c => !c.parent_id);

        rootComments.forEach(c => {
          let ideal = slots.length ? (slots[slots.length - 1].top + slots[slots.length - 1].h + 6) : 0;
          let anchor = null;
          if (c.anchor_id) {
            anchor = body.querySelector(`[data-cmt-anchor-id="${c.anchor_id}"]`);
            if (anchor) ideal = anchor.getBoundingClientRect().top - mRect.top;
          }
          const top = noOverlap(ideal, slots);
          const replies = repliesMap[c.id] || [];
          const b = document.createElement('div');
          b.className = 'gcp-re-balloon gcp-re-balloon--cmt';
          b.style.top = top + 'px';
          const tDelete = escHtml(trOr('editor.balloon.delete', 'Delete'));
          const rootDelHtml = c.can_delete ? `<button class="gcp-re-root-del gcp-re-balloon-del" type="button">✗ ${tDelete}</button>` : '';
          const repliesHtml = replies.map((r, ri) =>
            `<div class="gcp-re-cmt-reply" data-ri="${ri}">
              ${cmtEntryHtml(r)}
              ${r.can_delete ? `<div class="gcp-re-balloon-btns"><button class="gcp-re-reply-del gcp-re-balloon-del" type="button">✗ ${tDelete}</button></div>` : ''}
            </div>`
          ).join('');
          b.innerHTML = `
            ${cmtEntryHtml(c)}
            <div class="gcp-re-balloon-btns">
              ${rootDelHtml}
              <button class="gcp-re-balloon-reply" type="button">↩ ${escHtml(trOr('editor.balloon.reply', 'Reply'))}</button>
            </div>
            ${replies.length ? `<div class="gcp-re-cmt-replies">${repliesHtml}</div>` : ''}
            <div class="gcp-re-cmt-reply-form" style="display:none">
              <textarea class="gcp-re-cmt-reply-input" rows="2" placeholder="${escHtml(trOr('editor.balloon.replyPlaceholder', 'Write a reply…'))}"></textarea>
              <div class="gcp-re-balloon-btns" style="margin-top:4px">
                <button class="gcp-re-cmt-reply-send" type="button">${escHtml(trOr('editor.balloon.send', 'Send'))}</button>
                <button class="gcp-re-cmt-reply-cancel" type="button">${escHtml(trOr('editor.balloon.cancel', 'Cancel'))}</button>
              </div>
            </div>`;
          if (c.can_delete) {
            b.querySelector('.gcp-re-root-del').addEventListener('click', () => {
              if (onDeleteComment) onDeleteComment(c.id, c.anchor_id || null);
            });
          }
          b.querySelectorAll('.gcp-re-reply-del').forEach((btn, i) => {
            btn.addEventListener('click', () => {
              if (onDeleteComment) onDeleteComment(replies[i].id, null);
            });
          });
          const replyBtn   = b.querySelector('.gcp-re-balloon-reply');
          const replyForm  = b.querySelector('.gcp-re-cmt-reply-form');
          const replyInput = b.querySelector('.gcp-re-cmt-reply-input');
          const replySend  = b.querySelector('.gcp-re-cmt-reply-send');
          const replyCancel = b.querySelector('.gcp-re-cmt-reply-cancel');
          replyBtn.addEventListener('click', () => {
            replyForm.style.display = '';
            b.style.zIndex = '10';
            replyInput.focus();
          });
          replyCancel.addEventListener('click', () => {
            replyForm.style.display = 'none';
            b.style.zIndex = '';
            replyInput.value = '';
            positionBalloons();
          });
          replySend.addEventListener('click', async () => {
            const text = replyInput.value.trim();
            if (!text) return;
            replySend.disabled = true;
            b.style.zIndex = '';
            if (onReplyComment) onReplyComment(c.id, text);
          });
          replyInput.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); replySend.click(); }
            if (e.key === 'Escape') replyCancel.click();
          });
          marginEl.appendChild(b);
          const bh = Math.max(b.offsetHeight, 62);
          slots.push({ top, h: bh });
          drawConnector(anchor, top, bh, '#d97706');
        });

        updateMarginHeight();
      });
    }

    function _unwrapFmtReject(el) {
      const cmd    = el.getAttribute('data-tc-fmt-cmd') || '';
      const oldVal = el.getAttribute('data-tc-fmt-old') || '';
      // Block-level format rejection
      if (isBlockEl(el)) {
        if (cmd === 'h2' || cmd === 'h3') {
          const newEl = document.createElement(oldVal || 'p');
          while (el.firstChild) newEl.appendChild(el.firstChild);
          // Copy non-tc attributes
          for (const attr of [...el.attributes]) {
            if (!attr.name.startsWith('data-tc-') && attr.name !== 'style') newEl.setAttribute(attr.name, attr.value);
          }
          el.parentNode.replaceChild(newEl, el);
        } else if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
          execCmd(cmd); // toggles list off
          sel.removeAllRanges();
        } else if (cmd.startsWith('justify')) {
          el.style.textAlign = oldVal || '';
          stripTcAttrs(el);
        } else {
          // removeFormat or unknown — just strip tracking attrs
          stripTcAttrs(el);
        }
        return;
      }
      // Inline format rejection
      const range  = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      if (FMT_TOGGLE.has(cmd)) {
        if (String(document.queryCommandState(cmd)) !== oldVal) execCmd(cmd);
      } else if (FMT_VALUE.has(cmd)) {
        if (oldVal) execCmd(cmd, oldVal);
      }
      sel.removeAllRanges();
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }

    function acceptChange(id) {
      body.querySelectorAll(`del[data-tc-id="${CSS.escape(id)}"]`).forEach(el => el.remove());
      // Paragraph-mark insertions: just remove the marker (split is permanent)
      body.querySelectorAll(`ins[data-tc-id="${CSS.escape(id)}"][data-tc-para]`).forEach(el => el.remove());
      body.querySelectorAll(`ins[data-tc-id="${CSS.escape(id)}"]`).forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      body.querySelectorAll(`[data-tc-fmt-id="${CSS.escape(id)}"]`).forEach(el => {
        if (isBlockEl(el)) { stripTcAttrs(el); }
        else { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.remove(); }
      });
      body.querySelectorAll(`[data-tc-tbl][data-tc-id="${CSS.escape(id)}"]`).forEach(el => resolveTblChange(el, true));
      body.normalize(); updateTcBar();
    }

    function rejectChange(id) {
      // Handle paragraph-mark rejections: merge the next block back
      body.querySelectorAll(`ins[data-tc-id="${CSS.escape(id)}"][data-tc-para]`).forEach(el => {
        const block = el.parentElement;
        el.remove();
        if (block) {
          const next = block.nextElementSibling;
          if (next && /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/i.test(next.tagName)) {
            // Remove placeholder <br> if block ends with one and next has content
            const lastBr = block.lastElementChild;
            if (lastBr && lastBr.tagName === 'BR' && next.textContent.trim()) lastBr.remove();
            while (next.firstChild) block.appendChild(next.firstChild);
            next.remove();
          }
        }
      });
      body.querySelectorAll(`ins[data-tc-id="${CSS.escape(id)}"]`).forEach(el => el.remove());
      body.querySelectorAll(`del[data-tc-id="${CSS.escape(id)}"]`).forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      body.querySelectorAll(`[data-tc-fmt-id="${CSS.escape(id)}"]`).forEach(_unwrapFmtReject);
      body.querySelectorAll(`[data-tc-tbl][data-tc-id="${CSS.escape(id)}"]`).forEach(el => resolveTblChange(el, false));
      body.normalize(); updateTcBar();
    }

    function acceptAllChanges() {
      body.querySelectorAll('del[data-tc-id]').forEach(el => el.remove());
      body.querySelectorAll('ins[data-tc-id][data-tc-para]').forEach(el => el.remove());
      body.querySelectorAll('ins[data-tc-id]').forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      body.querySelectorAll('[data-tc-fmt-id]').forEach(el => {
        if (isBlockEl(el)) { stripTcAttrs(el); }
        else { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.remove(); }
      });
      body.querySelectorAll('[data-tc-tbl]').forEach(el => resolveTblChange(el, true));
      body.normalize(); tc.visible = false; updateTcBar();
    }

    function rejectAllChanges() {
      // Remove non-paragraph insertions first: a pasted block sequence sits
      // between a split paragraph's halves as a block-level <ins>, and the
      // ¶-mark merge below only works once that wrapper is gone.
      body.querySelectorAll('ins[data-tc-id]:not([data-tc-para])').forEach(el => el.remove());
      // Then reject paragraph marks (merge blocks back)
      body.querySelectorAll('ins[data-tc-id][data-tc-para]').forEach(el => {
        const block = el.parentElement;
        el.remove();
        if (block) {
          const next = block.nextElementSibling;
          if (next && /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/i.test(next.tagName)) {
            const lastBr = block.lastElementChild;
            if (lastBr && lastBr.tagName === 'BR' && next.textContent.trim()) lastBr.remove();
            while (next.firstChild) block.appendChild(next.firstChild);
            next.remove();
          }
        }
      });
      body.querySelectorAll('ins[data-tc-id]').forEach(el => el.remove());
      body.querySelectorAll('del[data-tc-id]').forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      [...body.querySelectorAll('[data-tc-fmt-id]')].forEach(_unwrapFmtReject);
      body.querySelectorAll('[data-tc-tbl]').forEach(el => resolveTblChange(el, false));
      body.normalize(); tc.visible = false; updateTcBar();
    }

    function hasTrackedChanges() {
      return !!(body.querySelector('[data-tc-id]') || body.querySelector('[data-tc-fmt-id]'));
    }

    function getCleanHtml() {
      const clone = body.cloneNode(true);
      clone.querySelectorAll('del[data-tc-id]').forEach(el => el.remove());
      clone.querySelectorAll('ins[data-tc-id][data-tc-para]').forEach(el => el.remove());
      clone.querySelectorAll('ins[data-tc-id]').forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      clone.querySelectorAll('[data-tc-fmt-id]').forEach(el => {
        if (isBlockEl(el)) { stripTcAttrs(el); }
        else { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.remove(); }
      });
      clone.querySelectorAll('[data-tc-tbl]').forEach(el => resolveTblChange(el, true));
      clone.querySelectorAll('.gcp-cmt-anchor').forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      return clone.innerHTML.replace(/(<br\s*\/?>|\s|&nbsp;)*$/, '').trim();
    }

    function removeCommentAnchor(anchorId) {
      const span = body.querySelector(`.gcp-cmt-anchor[data-cmt-anchor-id="${anchorId}"]`);
      if (!span) return;
      while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
      span.remove();
    }

    // ── Tracked table structure changes ─────────────────────────────────────
    // Rows/cells can't be wrapped in <ins>/<del> (table content model), so
    // structural table edits are tracked with data-tc-tbl on the <tr>/<td>
    // itself: row-add / row-del / col-add / col-del. Pending deletions stay in
    // the DOM (hidden unless markup is shown) until accepted.

    function trackTblInsert(els) {
      const id = newTcId();
      els.forEach(el => {
        el.setAttribute('data-tc-id', id);
        el.setAttribute('data-tc-tbl', el.tagName === 'TR' ? 'row-add' : 'col-add');
        applyAuthorAttrs(el);
      });
    }

    function trackTblDelete(els) {
      const id = newTcId();
      els.forEach(el => {
        const addKind = el.tagName === 'TR' ? 'row-add' : 'col-add';
        // Deleting your own pending insertion cancels it silently
        if (el.getAttribute('data-tc-tbl') === addKind &&
            el.getAttribute('data-tc-author') === tc.authorName) {
          el.remove();
          return;
        }
        el.setAttribute('data-tc-id', id);
        el.setAttribute('data-tc-tbl', el.tagName === 'TR' ? 'row-del' : 'col-del');
        applyAuthorAttrs(el);
      });
    }

    /** Apply accept (or reject) semantics to a tracked table row/cell. */
    function resolveTblChange(el, accept) {
      const isAdd = (el.getAttribute('data-tc-tbl') || '').endsWith('-add');
      if (accept ? isAdd : !isAdd) {
        stripTcAttrs(el);
        el.removeAttribute('data-tc-id');
        el.removeAttribute('data-tc-tbl');
      } else {
        el.remove();
      }
    }

    // ── TC mutation helpers ──────────────────────────────────────────────────

    function mergeAdjacentIns() {
      let merged = true;
      while (merged) {
        merged = false;
        body.querySelectorAll('ins[data-tc-id]').forEach(el => {
          let next = el.nextSibling;
          while (next && next.nodeType === Node.TEXT_NODE && !next.textContent) next = next.nextSibling;
          if (next && next.nodeType === Node.ELEMENT_NODE && next.tagName === 'INS' &&
              next.hasAttribute('data-tc-id') &&
              next.getAttribute('data-tc-author') === el.getAttribute('data-tc-author')) {
            while (next.firstChild) el.appendChild(next.firstChild);
            next.remove();
            merged = true;
          }
        });
      }
      body.normalize();
    }

    function applyAuthorAttrs(el) {
      const idx = authorColorIdx(tc.authorName);
      const [color, bg] = TC_PALETTE[idx];
      el.setAttribute('data-tc-author',   tc.authorName);
      el.setAttribute('data-tc-initials', getInitials(tc.authorName));
      el.setAttribute('data-tc-color',    String(idx));
      el.setAttribute('data-tc-time',     new Date().toISOString());
      el.style.setProperty('--tc-color', color);
      el.style.setProperty('--tc-bg', bg);
      el.title = `${tc.authorName}`;
    }

    function getSelfIns(node) {
      let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      while (el && el !== body) {
        if (el.tagName === 'INS' && el.getAttribute('data-tc-author') === tc.authorName) return el;
        el = el.parentElement;
      }
      return null;
    }

    // ── Block-level helpers (Word-like backspace / delete) ────────────────────

    const BLOCK_RE = /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/i;

    function getBlock(node) {
      let el = node.nodeType === 1 ? node : node.parentElement;
      while (el && el !== body) {
        if (el.nodeType === 1 && BLOCK_RE.test(el.tagName)) return el;
        el = el.parentElement;
      }
      return null;
    }

    function isAtBlockStart(range) {
      const block = getBlock(range.startContainer);
      if (!block) return false;
      const r = document.createRange();
      r.setStart(block, 0);
      r.setEnd(range.startContainer, range.startOffset);
      const frag = r.cloneContents();
      // Ignore hidden <del> elements (display:none when TC not visible)
      if (!tc.visible) frag.querySelectorAll('del[data-tc-id]').forEach(el => el.remove());
      return frag.textContent.length === 0;
    }

    function isAtBlockEnd(range) {
      const block = getBlock(range.startContainer);
      if (!block) return false;
      const r = document.createRange();
      r.setStart(range.startContainer, range.startOffset);
      r.setEnd(block, block.childNodes.length);
      const frag = r.cloneContents();
      if (!tc.visible) frag.querySelectorAll('del[data-tc-id]').forEach(el => el.remove());
      const text = frag.textContent;
      if (text.length > 0) return false;
      const els = frag.querySelectorAll('*');
      for (const el of els) {
        if (el.tagName !== 'BR' && !(el.tagName === 'DEL' && el.hasAttribute('data-tc-id'))) return false;
      }
      return true;
    }

    function getPrevBlock(block) {
      let el = block.previousElementSibling;
      while (el && el.tagName === 'DEL' && el.hasAttribute('data-tc-id') && !tc.visible) {
        el = el.previousElementSibling;
      }
      // Also walk up through <ins> wrapper if block is inside one
      if (!el && block.parentElement !== body) {
        const wrapper = block.parentElement;
        el = wrapper.previousElementSibling;
        while (el && el.tagName === 'DEL' && el.hasAttribute('data-tc-id') && !tc.visible) {
          el = el.previousElementSibling;
        }
        if (el && BLOCK_RE.test(el.tagName)) return el;
        // Check for block inside the previous <ins> wrapper
        if (el && el.tagName === 'INS') {
          const last = el.lastElementChild;
          if (last && BLOCK_RE.test(last.tagName)) return last;
        }
      }
      return el && BLOCK_RE.test(el.tagName) ? el : null;
    }

    function getNextBlock(block) {
      let el = block.nextElementSibling;
      while (el && el.tagName === 'DEL' && el.hasAttribute('data-tc-id') && !tc.visible) {
        el = el.nextElementSibling;
      }
      if (!el && block.parentElement !== body) {
        const wrapper = block.parentElement;
        el = wrapper.nextElementSibling;
        while (el && el.tagName === 'DEL' && el.hasAttribute('data-tc-id') && !tc.visible) {
          el = el.nextElementSibling;
        }
        if (el && BLOCK_RE.test(el.tagName)) return el;
        if (el && el.tagName === 'INS') {
          const first = el.firstElementChild;
          if (first && BLOCK_RE.test(first.tagName)) return first;
        }
      }
      return el && BLOCK_RE.test(el.tagName) ? el : null;
    }

    function mergeBlockIntoPrevious(block) {
      const prev = getPrevBlock(block);
      if (!prev) return false;
      const sel = window.getSelection();
      const r = document.createRange();
      // If prev is empty (no visible text content), remove it and keep current block
      const prevClone = prev.cloneNode(true);
      if (!tc.visible) prevClone.querySelectorAll('del[data-tc-id]').forEach(el => el.remove());
      const prevText = prevClone.textContent.trim();
      if (!prevText && !prevClone.querySelector('img,table,hr')) {
        prev.remove();
        r.setStart(block, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return true;
      }
      const lastBr = prev.lastElementChild;
      if (lastBr && lastBr.tagName === 'BR') lastBr.remove();
      // Save cursor at end of prev — walk to deepest text node
      let cursorNode = prev.lastChild;
      while (cursorNode && cursorNode.nodeType !== Node.TEXT_NODE && cursorNode.lastChild) {
        cursorNode = cursorNode.lastChild;
      }
      if (!cursorNode) cursorNode = prev;
      const cursorOff = cursorNode.nodeType === Node.TEXT_NODE ? cursorNode.length : prev.childNodes.length;
      // Move children from block → prev
      while (block.firstChild) {
        if (block.firstChild.tagName === 'BR' && !block.firstChild.nextSibling) break;
        prev.appendChild(block.firstChild);
      }
      block.remove();
      try {
        r.setStart(cursorNode, cursorOff); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      } catch (_) {}
      return true;
    }

    function mergeNextBlockIntoCurrent(block) {
      const next = getNextBlock(block);
      if (!next) return false;
      const sel = window.getSelection();
      const r = document.createRange();
      const lastBr = block.lastElementChild;
      if (lastBr && lastBr.tagName === 'BR') lastBr.remove();
      // Walk to deepest text node for accurate cursor placement
      let cursorNode = block.lastChild;
      while (cursorNode && cursorNode.nodeType !== Node.TEXT_NODE && cursorNode.lastChild) {
        cursorNode = cursorNode.lastChild;
      }
      if (!cursorNode) cursorNode = block;
      const cursorOff = cursorNode.nodeType === Node.TEXT_NODE ? cursorNode.length : block.childNodes.length;
      while (next.firstChild) {
        if (next.firstChild.tagName === 'BR' && !next.firstChild.nextSibling) break;
        block.appendChild(next.firstChild);
      }
      next.remove();
      try {
        r.setStart(cursorNode, cursorOff); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      } catch (_) {}
      return true;
    }

    function ensureBodyHasParagraph() {
      const hasBlock = body.querySelector('p,h1,h2,h3,h4,h5,h6,div,li,blockquote');
      if (!hasBlock) {
        body.innerHTML = '<p><br></p>';
        const r = document.createRange();
        r.setStart(body.firstChild, 0); r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      }
    }

    function staticToRange(sr) {
      const r = document.createRange();
      r.setStart(sr.startContainer, sr.startOffset);
      r.setEnd(sr.endContainer, sr.endOffset);
      return r;
    }

    function wrapRangeAsDeletion(range, placeCursorAfter) {
      if (range.collapsed) return null;
      const selfIns = getSelfIns(range.startContainer);
      if (selfIns && selfIns.contains(range.endContainer)) {
        try {
          range.deleteContents();
          if (selfIns.isConnected && !selfIns.textContent) selfIns.remove();
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
        } catch (_) {}
        updateTcBar();
        return null;
      }
      try {
        const id = newTcId();
        const frag = range.cloneContents();
        const del = document.createElement('del');
        del.setAttribute('data-tc-id', id);
        applyAuthorAttrs(del);
        del.appendChild(frag);
        range.deleteContents();
        range.insertNode(del);
        const sel = window.getSelection();
        sel.removeAllRanges();
        const r = document.createRange();
        placeCursorAfter ? r.setStartAfter(del) : r.setStartBefore(del);
        r.collapse(true); sel.addRange(r);
        return del;
      } catch (_) {
        try { range.deleteContents(); } catch (__) {}
        return null;
      }
    }

    function preserveSpaces(s) {
      return s.replace(/ {2}/g, ' \u00A0').replace(/^ /, '\u00A0').replace(/ $/, '\u00A0');
    }

    function insertTracked(text) {
      if (!text) return;
      const safe = preserveSpaces(text);
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const { startContainer, startOffset } = range;
      if (startContainer.nodeType === Node.TEXT_NODE) {
        const parent = startContainer.parentElement;
        if (parent && parent.tagName === 'INS' &&
            parent.getAttribute('data-tc-author') === tc.authorName) {
          const before = startContainer.textContent.slice(0, startOffset);
          const after  = startContainer.textContent.slice(startOffset);
          startContainer.textContent = before + safe + after;
          const r = document.createRange();
          r.setStart(startContainer, before.length + safe.length);
          r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
          return;
        }
      }
      const id = newTcId();
      const ins = document.createElement('ins');
      ins.setAttribute('data-tc-id', id);
      applyAuthorAttrs(ins);
      ins.textContent = safe;
      range.insertNode(ins);
      const r = document.createRange();
      const tn = ins.firstChild;
      r.setStart(tn, tn.length); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      mergeAdjacentIns();
    }

    function insertTrackedParagraph() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      // Find containing block
      let block = range.startContainer;
      while (block && block !== body && !(block.nodeType === 1 && /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/i.test(block.tagName))) {
        block = block.parentNode;
      }
      if (!block || block === body) {
        // No block container — wrap in <p>
        const newP = document.createElement('p');
        newP.innerHTML = '<br>';
        range.insertNode(newP);
        const r = document.createRange();
        r.setStart(newP, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      // Extract content after cursor into new block
      const afterRange = document.createRange();
      afterRange.setStart(range.startContainer, range.startOffset);
      afterRange.setEnd(block, block.childNodes.length);
      const afterFrag = afterRange.extractContents();
      // Reassign tc-id on split tracked nodes so each half has a unique ID
      afterFrag.querySelectorAll('[data-tc-id]').forEach(el => {
        const oldId = el.getAttribute('data-tc-id');
        if (block.querySelector(`[data-tc-id="${CSS.escape(oldId)}"]`)) {
          el.setAttribute('data-tc-id', newTcId());
        }
      });
      const newBlock = document.createElement(block.tagName.toLowerCase());
      // Copy alignment/style
      if (block.style.textAlign) newBlock.style.textAlign = block.style.textAlign;
      // Check for meaningful content (not just empty text nodes or whitespace)
      const hasContent = afterFrag.textContent.trim().length > 0 ||
        afterFrag.querySelector('img,table,br,hr');
      if (hasContent) {
        newBlock.appendChild(afterFrag);
      } else {
        newBlock.innerHTML = '<br>';
      }
      if (!block.textContent.trim() && !block.querySelector('br')) block.innerHTML = '<br>';
      // Track the paragraph break as an insertion (Word shows ¶ marks)
      const paraIns = document.createElement('ins');
      paraIns.setAttribute('data-tc-id', newTcId());
      paraIns.setAttribute('data-tc-para', 'true');
      applyAuthorAttrs(paraIns);
      paraIns.textContent = '\n';
      block.appendChild(paraIns);
      block.parentNode.insertBefore(newBlock, block.nextSibling);
      const r = document.createRange();
      r.setStart(newBlock, 0); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    }

    function insertTrackedLineBreak() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) wrapRangeAsDeletion(range, true);
      const br = document.createElement('br');
      const selfIns = getSelfIns(range.startContainer);
      if (selfIns) {
        // Inside own insertion — just insert the br
        range.insertNode(br);
      } else {
        const id = newTcId();
        const ins = document.createElement('ins');
        ins.setAttribute('data-tc-id', id);
        applyAuthorAttrs(ins);
        ins.appendChild(br);
        range.insertNode(ins);
      }
      const r = document.createRange();
      r.setStartAfter(br); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    }

    function wrapChildrenIn(el, tag) {
      const w = document.createElement(tag);
      while (el.firstChild) w.appendChild(el.firstChild);
      el.appendChild(w);
    }

    function sanitizeHtml(html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Remove dangerous elements
      tmp.querySelectorAll('script,style,link,meta,iframe,object,embed').forEach(el => el.remove());
      // Remove event handler attributes, dangerous hrefs, and unwanted formatting
      const all = tmp.querySelectorAll('*');
      for (const el of all) {
        for (const attr of [...el.attributes]) {
          if (attr.name.startsWith('on') || (attr.name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))) {
            el.removeAttribute(attr.name);
          }
        }
        el.removeAttribute('class');
        el.removeAttribute('id');

        // Extract allowed formatting from inline styles before stripping
        const s = el.style;
        const color = s.color || '';
        const isBold = s.fontWeight === 'bold' || parseInt(s.fontWeight) >= 700;
        const isItalic = s.fontStyle === 'italic';
        const isUnderline = (s.textDecoration || s.textDecorationLine || '').includes('underline');

        // Strip all inline styles
        el.removeAttribute('style');

        // Re-apply only color
        if (color) el.style.color = color;

        // Convert style-based bold/italic/underline to semantic tags
        // Check both ancestors (closest) and direct children to avoid nesting duplicates
        if (isBold && !el.closest('b,strong') && !/^(B|STRONG)$/i.test(el.tagName)
            && !el.querySelector(':scope > b, :scope > strong')) {
          wrapChildrenIn(el, 'b');
        }
        if (isItalic && !el.closest('i,em') && !/^(I|EM)$/i.test(el.tagName)
            && !el.querySelector(':scope > i, :scope > em')) {
          wrapChildrenIn(el, 'i');
        }
        if (isUnderline && !el.closest('u') && el.tagName !== 'U'
            && !el.querySelector(':scope > u')) {
          wrapChildrenIn(el, 'u');
        }
      }

      // Unwrap <span> elements with no remaining attributes (empty shells)
      tmp.querySelectorAll('span').forEach(span => {
        if (!span.attributes.length) {
          span.replaceWith(...span.childNodes);
        }
      });

      return tmp;
    }

    function insertTrackedHtml(html) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const clean = sanitizeHtml(html);

      // Inline-only content — wrap in a single <ins> at the caret
      if (!clean.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,table')) {
        const id = newTcId();
        const ins = document.createElement('ins');
        ins.setAttribute('data-tc-id', id);
        applyAuthorAttrs(ins);
        while (clean.firstChild) ins.appendChild(clean.firstChild);
        range.insertNode(ins);
        const r = document.createRange();
        r.setStartAfter(ins); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        mergeAdjacentIns();
        return;
      }

      // ── Block-aware paste (Word-style) ────────────────────────────────────
      // Partition the pasted top-level nodes into a leading inline run (which
      // merges into the current paragraph, as Word does with the first pasted
      // paragraph's content) and a sequence of blocks. Stray inline runs
      // between blocks are wrapped into <p>.
      const PASTE_BLOCK_RE = /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|TABLE|HR)$/;
      const leading = [];
      const blocks = [];
      let sawBlock = false;
      let inlineRun = [];
      const flushInlineRun = () => {
        if (!inlineRun.length) return;
        const hasContent = inlineRun.some(n =>
          (n.textContent || '').trim() || (n.nodeType === 1 && n.querySelector && n.querySelector('img,br')));
        if (hasContent) {
          const p = document.createElement('p');
          inlineRun.forEach(n => p.appendChild(n));
          blocks.push(p);
        }
        inlineRun = [];
      };
      [...clean.childNodes].forEach(n => {
        const isBlock = n.nodeType === 1 && PASTE_BLOCK_RE.test(n.tagName);
        if (!sawBlock && !isBlock) { leading.push(n); return; }
        if (isBlock) { flushInlineRun(); sawBlock = true; blocks.push(n); }
        else inlineRun.push(n);
      });
      flushInlineRun();

      // 1. Leading inline content becomes a normal tracked insertion at the caret
      if (leading.some(n => (n.textContent || '').trim())) {
        const ins = document.createElement('ins');
        ins.setAttribute('data-tc-id', newTcId());
        applyAuthorAttrs(ins);
        leading.forEach(n => ins.appendChild(n));
        range.insertNode(ins);
        const after = document.createRange();
        after.setStartAfter(ins); after.collapse(true);
        sel.removeAllRanges(); sel.addRange(after);
      }
      if (!blocks.length) { mergeAdjacentIns(); return; }

      // 2. Split the current block at the caret (tracked ¶); the caret lands
      //    at the start of the tail block.
      insertTrackedParagraph();

      // 3. Insert the pasted blocks between the two halves, wrapped in ONE
      //    block-level tracked <ins>. <ins> is transparent in the HTML content
      //    model, and getPrevBlock/getNextBlock already understand blocks
      //    inside <ins> wrappers. Accept unwraps the blocks in place; reject
      //    removes the whole pasted sequence.
      const sel2 = window.getSelection();
      let tail = sel2 && sel2.rangeCount ? sel2.getRangeAt(0).startContainer : null;
      if (tail && tail.nodeType !== 1) tail = tail.parentElement;
      while (tail && tail.parentElement && tail.parentElement !== body) tail = tail.parentElement;

      const wrapIns = document.createElement('ins');
      wrapIns.setAttribute('data-tc-id', newTcId());
      applyAuthorAttrs(wrapIns);
      blocks.forEach(b => wrapIns.appendChild(b));
      if (tail && tail.parentElement === body) body.insertBefore(wrapIns, tail);
      else body.appendChild(wrapIns);

      // Caret at the start of the tail block (i.e. end of pasted content)
      try {
        const r = document.createRange();
        r.setStart(tail || body, 0); r.collapse(true);
        sel2.removeAllRanges(); sel2.addRange(r);
      } catch (_) {}
      mergeAdjacentIns();
    }

    // ── Button event handlers ────────────────────────────────────────────────

    tcBtn.addEventListener('mousedown', e => e.preventDefault());
    tcBtn.addEventListener('click', () => { tc.visible = !tc.visible; updateTcBar(); });

    tcAcceptAll.addEventListener('mousedown', e => e.preventDefault());
    tcAcceptAll.addEventListener('click', () => { acceptAllChanges(); body.focus(); });
    tcRejectAll.addEventListener('mousedown', e => e.preventDefault());
    tcRejectAll.addEventListener('click', () => { rejectAllChanges(); body.focus(); });

    // ── Mobile tap-to-reveal sheet for tracked changes ──────────────────────
    const mobileSheetOverlay = document.createElement('div');
    mobileSheetOverlay.className = 'gcp-re-mobile-sheet-overlay';
    const mobileSheet = document.createElement('div');
    mobileSheet.className = 'gcp-re-mobile-sheet';
    mobileSheet.innerHTML = '<div class="gcp-re-mobile-sheet-handle"></div>';
    document.body.appendChild(mobileSheetOverlay);
    document.body.appendChild(mobileSheet);

    function closeMobileSheet() {
      mobileSheet.classList.remove('visible');
      mobileSheetOverlay.classList.remove('visible');
    }
    mobileSheetOverlay.addEventListener('click', closeMobileSheet);

    function openMobileSheet(el) {
      const isFmt = el.hasAttribute('data-tc-fmt-id');
      const id = isFmt ? el.getAttribute('data-tc-fmt-id') : el.getAttribute('data-tc-id');
      if (!id) return;
      const author = el.getAttribute('data-tc-author') || 'Unknown';
      const initials = el.getAttribute('data-tc-initials') || '?';
      const time = el.getAttribute('data-tc-time') || '';
      const color = el.style.getPropertyValue('--tc-color') || '#1d4ed8';
      const kind = isFmt ? 'fmt' : el.tagName.toLowerCase();
      const text = el.textContent || '';
      const fmtCmd = isFmt ? (el.getAttribute('data-tc-fmt-cmd') || '') : '';

      let snippetHtml = '';
      if (kind === 'ins') {
        snippetHtml = `<div class="gcp-re-snippet gcp-re-snippet-ins">+ ${escHtml(text)}</div>`;
      } else if (kind === 'del') {
        snippetHtml = `<div class="gcp-re-snippet gcp-re-snippet-del">− ${escHtml(text)}</div>`;
      } else if (kind === 'fmt') {
        const label = fmtCmdLabel(fmtCmd || '');
        snippetHtml = `<div class="gcp-re-snippet" style="color:#7c3aed;">${escHtml(I18n.tr('editor.balloon.formatted'))}: ${escHtml(label)}</div>`;
      }

      mobileSheet.innerHTML = `
        <div class="gcp-re-mobile-sheet-handle"></div>
        <div class="gcp-re-balloon-header">
          <span class="gcp-re-balloon-avatar" style="background:${escHtml(color)}">${escHtml(initials)}</span>
          <span class="gcp-re-balloon-author">${escHtml(author)}</span>
          <span class="gcp-re-balloon-time">${escHtml(fmtTime(time))}</span>
        </div>
        ${snippetHtml}
        <div class="gcp-re-mobile-sheet-btns">
          <button class="gcp-re-mobile-sheet-btn-accept" type="button">✓ ${escHtml(I18n.tr('editor.balloon.accept'))}</button>
          <button class="gcp-re-mobile-sheet-btn-reject" type="button">✗ ${escHtml(I18n.tr('editor.balloon.reject'))}</button>
        </div>`;
      mobileSheet.querySelector('.gcp-re-mobile-sheet-btn-accept').addEventListener('click', () => { acceptChange(id); closeMobileSheet(); updateTcBar(); });
      mobileSheet.querySelector('.gcp-re-mobile-sheet-btn-reject').addEventListener('click', () => { rejectChange(id); closeMobileSheet(); updateTcBar(); });
      mobileSheetOverlay.classList.add('visible');
      requestAnimationFrame(() => mobileSheet.classList.add('visible'));
    }

    function openMobileCommentSheet(anchorId) {
      const comment = storedComments.find(c => c.anchor_id === anchorId && !c.parent_id);
      if (!comment) return;
      const replies = storedComments.filter(c => c.parent_id === comment.id);
      const { ini, color } = cmtAvatar(comment.author_name || 'Unknown');

      // Highlighted anchor text
      const anchorEl = body.querySelector(`[data-cmt-anchor-id="${anchorId}"]`);
      const highlightHtml = anchorEl
        ? `<div class="gcp-re-mobile-sheet-highlighted">"${escHtml(anchorEl.textContent)}"</div>`
        : '';

      // Root comment
      let html = `<div class="gcp-re-mobile-sheet-handle"></div>
        ${highlightHtml}
        <div class="gcp-re-balloon-header">
          <span class="gcp-re-balloon-avatar" style="background:${color}">${escHtml(ini)}</span>
          <span class="gcp-re-balloon-author">${escHtml(comment.author_name || 'Unknown')}</span>
          <span class="gcp-re-balloon-time">${escHtml(fmtTime(comment.created_at))}</span>
        </div>
        <div class="gcp-re-mobile-sheet-cmt-body">${escHtml(comment.comment_text || '')}</div>
        <div class="gcp-re-mobile-sheet-btns">
          ${comment.can_delete ? `<button class="gcp-re-mobile-sheet-btn-delete" type="button">${escHtml(trOr('editor.balloon.delete', 'Delete'))}</button>` : ''}
          <button class="gcp-re-mobile-sheet-btn-reply" type="button">${escHtml(trOr('editor.balloon.reply', 'Reply'))}</button>
        </div>`;

      // Replies
      if (replies.length) {
        html += '<div class="gcp-re-mobile-sheet-cmt-thread">';
        replies.forEach((r, ri) => {
          const ra = cmtAvatar(r.author_name || 'Unknown');
          html += `<div class="gcp-re-mobile-sheet-cmt-reply" data-reply-idx="${ri}">
            <div class="gcp-re-balloon-header">
              <span class="gcp-re-balloon-avatar" style="background:${ra.color}">${escHtml(ra.ini)}</span>
              <span class="gcp-re-balloon-author">${escHtml(r.author_name || 'Unknown')}</span>
              <span class="gcp-re-balloon-time">${escHtml(fmtTime(r.created_at))}</span>
            </div>
            <div class="gcp-re-mobile-sheet-cmt-body">${escHtml(r.comment_text || '')}</div>
            ${r.can_delete ? `<button class="gcp-re-mobile-sheet-btn-delete gcp-re-reply-del-mobile" data-reply-idx="${ri}" type="button" style="font-size:12px;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;">${escHtml(trOr('editor.balloon.delete', 'Delete'))}</button>` : ''}
          </div>`;
        });
        html += '</div>';
      }

      // Reply form
      html += `<div class="gcp-re-mobile-sheet-reply-form" style="display:none">
        <textarea rows="2" placeholder="${escHtml(trOr('editor.balloon.replyPlaceholder', 'Write a reply\u2026'))}"></textarea>
        <div class="gcp-re-mobile-sheet-reply-actions">
          <button class="gcp-re-mobile-sheet-btn-send" type="button">${escHtml(trOr('editor.balloon.send', 'Send'))}</button>
          <button class="gcp-re-mobile-sheet-btn-cancel" type="button">${escHtml(trOr('editor.balloon.cancel', 'Cancel'))}</button>
        </div>
      </div>`;

      mobileSheet.innerHTML = html;

      // Wire up events
      const delBtn = mobileSheet.querySelector('.gcp-re-mobile-sheet-btns > .gcp-re-mobile-sheet-btn-delete');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (onDeleteComment) onDeleteComment(comment.id, comment.anchor_id || null);
          closeMobileSheet();
        });
      }
      mobileSheet.querySelectorAll('.gcp-re-reply-del-mobile').forEach(btn => {
        const ri = parseInt(btn.getAttribute('data-reply-idx'), 10);
        btn.addEventListener('click', () => {
          if (onDeleteComment) onDeleteComment(replies[ri].id, null);
          closeMobileSheet();
        });
      });

      const replyBtn = mobileSheet.querySelector('.gcp-re-mobile-sheet-btn-reply');
      const replyForm = mobileSheet.querySelector('.gcp-re-mobile-sheet-reply-form');
      const replyInput = replyForm.querySelector('textarea');
      const sendBtn = mobileSheet.querySelector('.gcp-re-mobile-sheet-btn-send');
      const cancelBtn = mobileSheet.querySelector('.gcp-re-mobile-sheet-btn-cancel');

      replyBtn.addEventListener('click', () => {
        replyForm.style.display = '';
        replyInput.focus();
      });
      cancelBtn.addEventListener('click', () => {
        replyForm.style.display = 'none';
        replyInput.value = '';
      });
      sendBtn.addEventListener('click', () => {
        const text = replyInput.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        if (onReplyComment) onReplyComment(comment.id, text);
        closeMobileSheet();
      });
      replyInput.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
        if (e.key === 'Escape') cancelBtn.click();
      });

      mobileSheetOverlay.classList.add('visible');
      requestAnimationFrame(() => mobileSheet.classList.add('visible'));
    }

    body.addEventListener('click', (e) => {
      if (window.innerWidth > 820) return;
      // Tracked changes
      if (tc.visible) {
        const tcEl = e.target.closest('[data-tc-id], [data-tc-fmt-id]');
        if (tcEl) { e.preventDefault(); openMobileSheet(tcEl); return; }
      }
      // Comment anchors
      const cmtEl = e.target.closest('.gcp-cmt-anchor[data-cmt-anchor-id]');
      if (cmtEl) {
        e.preventDefault();
        openMobileCommentSheet(cmtEl.getAttribute('data-cmt-anchor-id'));
      }
    });

    function createCommentAnchor() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return null;
      const anchorId = 'cmt-' + Math.random().toString(36).slice(2, 10);
      const span = document.createElement('span');
      span.className = 'gcp-cmt-anchor';
      span.setAttribute('data-cmt-anchor-id', anchorId);
      try {
        if (sel.isCollapsed) {
          // No selection — insert a zero-width marker at cursor position
          span.textContent = '\u200B';
          range.insertNode(span);
        } else {
          const frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
        }
        sel.removeAllRanges();
        return anchorId;
      } catch(_) { return null; }
    }

    cmtBtn.addEventListener('mousedown', e => e.preventDefault());
    cmtBtn.addEventListener('click', () => {
      cmtPanelVisible = !cmtPanelVisible;
      cmtBtn.classList.toggle('active', cmtPanelVisible && storedComments.length > 0);
      updateTcBar();
    });

    addCmtBtn.addEventListener('click', () => {
      const anchorId = createCommentAnchor();
      if (onCommentsClick) onCommentsClick(anchorId);
    });

    // ── Right-click context menu ──────────────────────────────────────────────
    let activeCtxMenu = null;
    function removeCtxMenu() {
      if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; }
    }
    body.addEventListener('contextmenu', e => {
      if (!body.isContentEditable) return;
      e.preventDefault();
      removeCtxMenu();

      const menu = document.createElement('div');
      menu.className = 'gcp-re-ctx';
      menu.style.left = e.clientX + 'px';
      menu.style.top  = e.clientY + 'px';

      const addCmt = document.createElement('div');
      addCmt.className = 'gcp-re-ctx-item';
      addCmt.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M14 1H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5.586l2.707 2.707a1 1 0 0 0 1.414 0L14 12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1z"/></svg> ' + escHtml(I18n.tr('editor.comment.addTitle'));
      addCmt.addEventListener('mousedown', ev => ev.preventDefault());
      addCmt.addEventListener('click', () => {
        removeCtxMenu();
        const anchorId = createCommentAnchor();
        if (onCommentsClick) onCommentsClick(anchorId);
      });
      menu.appendChild(addCmt);

      const tableCell = e.target.closest('td,th');
      if (tableCell) {
        const pos = { x: e.clientX, y: e.clientY };
        const table = tableCell.closest('table');
        const colIdx = [...tableCell.parentElement.children].indexOf(tableCell);
        const rowCells  = () => [...tableCell.closest('tr').querySelectorAll('td,th')];
        const colCells  = () => [...table.querySelectorAll('tr')].flatMap(r => r.children[colIdx] ? [r.children[colIdx]] : []);
        const allCells  = () => [...table.querySelectorAll('td,th')];

        const BORDERS = [
          { t: trOr('editor.table.borderNone', 'None'),     v: 'none' },
          { t: trOr('editor.table.borderThin', 'Thin'),     v: '1px solid #d1d5db' },
          { t: trOr('editor.table.borderMedium', 'Medium'), v: '1.5px solid #64748b' },
          { t: trOr('editor.table.borderThick', 'Thick'),   v: '2px solid #1e293b' },
          { t: trOr('editor.table.borderDashed', 'Dashed'), v: '1px dashed #94a3b8' },
        ];

        function makeRow(labelText, btns) {
          const row = document.createElement('div');
          row.className = 'gcp-re-ctx-tbl-row';
          const lbl = document.createElement('span');
          lbl.className = 'gcp-re-ctx-tbl-lbl'; lbl.textContent = labelText;
          row.appendChild(lbl);
          btns.forEach(({ text, title, action }) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'gcp-re-ctx-tbl-btn';
            b.textContent = text; if (title) b.title = title;
            b.addEventListener('mousedown', ev => ev.preventDefault());
            b.addEventListener('click', () => { removeCtxMenu(); action(); });
            row.appendChild(b);
          });
          return row;
        }

        const sep1 = document.createElement('div'); sep1.className = 'gcp-re-ctx-sep'; menu.appendChild(sep1);
        menu.appendChild(makeRow(trOr('editor.table.fill', 'Fill:'), [
          { text: trOr('editor.table.cell', 'Cell'),     action: () => makePalettePopup(pos, h => { pushUndo(); tableCell.style.backgroundColor = h; }) },
          { text: trOr('editor.table.row', 'Row'),       action: () => makePalettePopup(pos, h => { pushUndo(); rowCells().forEach(c => { c.style.backgroundColor = h; }); }) },
          { text: trOr('editor.table.column', 'Column'), action: () => makePalettePopup(pos, h => { pushUndo(); colCells().forEach(c => { c.style.backgroundColor = h; }); }) },
          { text: trOr('editor.table.all', 'All'),       action: () => makePalettePopup(pos, h => { pushUndo(); allCells().forEach(c => { c.style.backgroundColor = h; }); }) },
        ]));

        const sep2 = document.createElement('div'); sep2.className = 'gcp-re-ctx-sep'; menu.appendChild(sep2);
        [
          { label: trOr('editor.table.rowGrid', 'Row grid:'), getCells: rowCells },
          { label: trOr('editor.table.colGrid', 'Col grid:'), getCells: colCells },
          { label: trOr('editor.table.allGrid', 'All grid:'), getCells: allCells },
        ].forEach(({ label, getCells }) => {
          menu.appendChild(makeRow(label, [
            ...BORDERS.map(({ t, v }) => ({
              text: t, title: t,
              action: () => { pushUndo(); getCells().forEach(c => { c.style.border = v; }); },
            })),
            { text: '🎨', title: trOr('editor.table.gridColour', 'Grid colour'), action: () => makePalettePopup(pos, h => { pushUndo(); getCells().forEach(c => { c.style.borderColor = h; }); }) },
          ]));
        });

        // #11 — Table row/column add/delete (tracked as pending table changes)
        const sep3 = document.createElement('div'); sep3.className = 'gcp-re-ctx-sep'; menu.appendChild(sep3);
        const tableRow = tableCell.closest('tr');
        const cellIdx = [...tableRow.children].indexOf(tableCell);
        const tbody = tableRow.parentElement;

        function addCtxItem(label, action) {
          const item = document.createElement('div');
          item.className = 'gcp-re-ctx-item';
          item.textContent = label;
          item.addEventListener('click', () => { removeCtxMenu(); action(); });
          menu.appendChild(item);
        }

        function makeCleanRow() {
          const newRow = tableRow.cloneNode(true);
          newRow.removeAttribute('data-tc-id');
          newRow.removeAttribute('data-tc-tbl');
          stripTcAttrs(newRow);
          [...newRow.cells].forEach(c => {
            c.innerHTML = '&nbsp;';
            c.style.backgroundColor = '';
            c.removeAttribute('data-tc-id');
            c.removeAttribute('data-tc-tbl');
            stripTcAttrs(c);
          });
          return newRow;
        }

        addCtxItem(trOr('editor.table.insertRowAbove', 'Insert row above'), () => {
          pushUndo();
          const newRow = makeCleanRow();
          tbody.insertBefore(newRow, tableRow);
          trackTblInsert([newRow]);
          updateTcBar();
        });
        addCtxItem(trOr('editor.table.insertRowBelow', 'Insert row below'), () => {
          pushUndo();
          const newRow = makeCleanRow();
          tableRow.after(newRow);
          trackTblInsert([newRow]);
          updateTcBar();
        });
        addCtxItem(trOr('editor.table.insertColLeft', 'Insert column left'), () => {
          pushUndo();
          const added = [];
          [...tbody.rows].forEach(r => {
            const td = document.createElement('td');
            td.innerHTML = '&nbsp;';
            r.insertBefore(td, r.cells[cellIdx] || null);
            added.push(td);
          });
          trackTblInsert(added);
          updateTcBar();
        });
        addCtxItem(trOr('editor.table.insertColRight', 'Insert column right'), () => {
          pushUndo();
          const added = [];
          [...tbody.rows].forEach(r => {
            const td = document.createElement('td');
            td.innerHTML = '&nbsp;';
            r.insertBefore(td, r.cells[cellIdx + 1] || null);
            added.push(td);
          });
          trackTblInsert(added);
          updateTcBar();
        });
        if (tbody.rows.length > 1) {
          addCtxItem(trOr('editor.table.deleteRow', 'Delete row'), () => {
            pushUndo();
            trackTblDelete([tableRow]);
            updateTcBar();
          });
        }
        if (tableRow.cells.length > 1) {
          addCtxItem(trOr('editor.table.deleteColumn', 'Delete column'), () => {
            pushUndo();
            trackTblDelete([...tbody.rows].flatMap(r => r.cells[cellIdx] ? [r.cells[cellIdx]] : []));
            updateTcBar();
          });
        }
      }

      const tcEl = e.target.closest('[data-tc-id]');
      if (tcEl) {
        const sep = document.createElement('div'); sep.className = 'gcp-re-ctx-sep';
        menu.appendChild(sep);
        const tcId = tcEl.getAttribute('data-tc-id');
        const accItem = document.createElement('div');
        accItem.className = 'gcp-re-ctx-item';
        accItem.textContent = '✓ ' + trOr('editor.ctx.acceptChange', 'Accept Change');
        accItem.addEventListener('click', () => { removeCtxMenu(); acceptChange(tcId); });
        menu.appendChild(accItem);
        const rejItem = document.createElement('div');
        rejItem.className = 'gcp-re-ctx-item';
        rejItem.textContent = '✗ ' + trOr('editor.ctx.rejectChange', 'Reject Change');
        rejItem.addEventListener('click', () => { removeCtxMenu(); rejectChange(tcId); });
        menu.appendChild(rejItem);
      }

      document.body.appendChild(menu);
      activeCtxMenu = menu;
    });
    document.addEventListener('click', removeCtxMenu, { capture: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') removeCtxMenu(); });

    // ── Find & Replace panel (#13) ──────────────────────────────────────────
    let findPanel = null;
    let findMatches = [];
    let findIdx = -1;

    function clearFindHighlights() {
      body.querySelectorAll('.gcp-re-find-highlight,.gcp-re-find-highlight-current').forEach(el => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      body.normalize();
      findMatches = [];
      findIdx = -1;
    }

    function highlightFindMatches(query) {
      clearFindHighlights();
      if (!query) return 0;
      const lowerQ = query.toLowerCase();
      const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          // Skip nodes inside <del> (hidden tracked deletions)
          if (node.parentElement && node.parentElement.closest('del[data-tc-id]')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const textNodes = [];
      while (tw.nextNode()) textNodes.push(tw.currentNode);
      for (const tn of textNodes) {
        let idx = 0;
        const text = tn.textContent;
        const lower = text.toLowerCase();
        while ((idx = lower.indexOf(lowerQ, idx)) !== -1) {
          const range = document.createRange();
          range.setStart(tn, idx);
          range.setEnd(tn, idx + query.length);
          const mark = document.createElement('span');
          mark.className = 'gcp-re-find-highlight';
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
          findMatches.push(mark);
          idx = 0;
          break; // re-walk after DOM mutation; simplified — next call picks up remaining
        }
      }
      // Re-walk to catch all matches after DOM modification
      if (findMatches.length > 0) {
        const more = true;
        let safety = 500;
        while (more && --safety > 0) {
          const tw2 = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              if (node.parentElement && (node.parentElement.closest('.gcp-re-find-highlight') || node.parentElement.closest('del[data-tc-id]'))) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          let found = false;
          while (tw2.nextNode()) {
            const tn2 = tw2.currentNode;
            const lower2 = tn2.textContent.toLowerCase();
            const fi = lower2.indexOf(lowerQ);
            if (fi !== -1) {
              const range = document.createRange();
              range.setStart(tn2, fi);
              range.setEnd(tn2, fi + query.length);
              const mark = document.createElement('span');
              mark.className = 'gcp-re-find-highlight';
              mark.appendChild(range.extractContents());
              range.insertNode(mark);
              findMatches.push(mark);
              found = true;
              break;
            }
          }
          if (!found) break;
        }
      }
      return findMatches.length;
    }

    function goToMatch(idx) {
      findMatches.forEach((m, i) => {
        m.className = i === idx ? 'gcp-re-find-highlight-current' : 'gcp-re-find-highlight';
      });
      if (findMatches[idx]) {
        findMatches[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
        findIdx = idx;
      }
    }

    function openFindPanel(showReplace) {
      if (findPanel) { findPanel.querySelector('input').focus(); return; }
      findPanel = document.createElement('div');
      findPanel.className = 'gcp-re-find-panel';
      const findInput = document.createElement('input');
      findInput.type = 'text'; findInput.placeholder = I18n.tr('editor.find.findPlaceholder');
      const countLabel = document.createElement('span');
      countLabel.className = 'gcp-re-find-count';
      const prevBtn = document.createElement('button'); prevBtn.textContent = '▲'; prevBtn.title = I18n.tr('editor.find.prev');
      const nextBtn = document.createElement('button'); nextBtn.textContent = '▼'; nextBtn.title = I18n.tr('editor.find.next');
      const replaceInput = document.createElement('input');
      replaceInput.type = 'text'; replaceInput.placeholder = I18n.tr('editor.find.replacePlaceholder');
      if (!showReplace) replaceInput.style.display = 'none';
      const replaceBtn = document.createElement('button'); replaceBtn.textContent = I18n.tr('editor.find.replace');
      if (!showReplace) replaceBtn.style.display = 'none';
      const replaceAllBtn = document.createElement('button'); replaceAllBtn.textContent = I18n.tr('editor.find.replaceAll');
      if (!showReplace) replaceAllBtn.style.display = 'none';
      const closeBtn = document.createElement('span');
      closeBtn.className = 'gcp-re-find-close'; closeBtn.innerHTML = '&times;';

      function doSearch() {
        const n = highlightFindMatches(findInput.value);
        countLabel.textContent = n > 0 ? `1/${n}` : '0';
        if (n > 0) goToMatch(0);
      }

      findInput.addEventListener('input', doSearch);
      nextBtn.addEventListener('click', () => {
        if (!findMatches.length) return;
        findIdx = (findIdx + 1) % findMatches.length;
        goToMatch(findIdx);
        countLabel.textContent = `${findIdx + 1}/${findMatches.length}`;
      });
      prevBtn.addEventListener('click', () => {
        if (!findMatches.length) return;
        findIdx = (findIdx - 1 + findMatches.length) % findMatches.length;
        goToMatch(findIdx);
        countLabel.textContent = `${findIdx + 1}/${findMatches.length}`;
      });
      replaceBtn.addEventListener('click', () => {
        if (findIdx < 0 || !findMatches[findIdx]) return;
        pushUndo();
        const mark = findMatches[findIdx];
        const replacement = replaceInput.value;
        mark.textContent = replacement;
        while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
        mark.remove();
        findMatches.splice(findIdx, 1);
        if (findIdx >= findMatches.length) findIdx = 0;
        if (findMatches.length) goToMatch(findIdx);
        countLabel.textContent = findMatches.length > 0 ? `${findIdx + 1}/${findMatches.length}` : '0';
      });
      replaceAllBtn.addEventListener('click', () => {
        if (!findMatches.length) return;
        pushUndo();
        const replacement = replaceInput.value;
        findMatches.forEach(mark => {
          mark.textContent = replacement;
          while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
          mark.remove();
        });
        findMatches = []; findIdx = -1;
        countLabel.textContent = '0';
        body.normalize();
      });
      closeBtn.addEventListener('click', closeFindPanel);

      findPanel.appendChild(findInput);
      findPanel.appendChild(countLabel);
      findPanel.appendChild(prevBtn);
      findPanel.appendChild(nextBtn);
      findPanel.appendChild(replaceInput);
      findPanel.appendChild(replaceBtn);
      findPanel.appendChild(replaceAllBtn);
      findPanel.appendChild(closeBtn);
      wrap.style.position = 'relative';
      wrap.appendChild(findPanel);
      findInput.focus();
    }

    function closeFindPanel() {
      clearFindHighlights();
      if (findPanel) { findPanel.remove(); findPanel = null; }
    }

    // ── beforeinput: always intercept text mutations ─────────────────────────

    const TC_INPUT_TYPES = new Set([
      'insertText', 'insertReplacementText',
      'deleteContentBackward', 'deleteContentForward',
      'deleteWordBackward', 'deleteWordForward',
      'deleteHardLineBackward', 'deleteHardLineForward',
      'deleteSoftLineBackward', 'deleteSoftLineForward',
      'deleteByCut', 'deleteByDrag', 'insertFromPaste', 'insertFromDrop',
      'insertParagraph', 'insertLineBreak',
    ]);

    body.addEventListener('beforeinput', e => {
      if (!body.isContentEditable) return;
      // Native undo/redo (context menu, some IMEs) must go through our own
      // stack — the browser's history knows nothing about tracked markup.
      if (e.inputType === 'historyUndo') { e.preventDefault(); performUndo(); return; }
      if (e.inputType === 'historyRedo') { e.preventDefault(); performRedo(); return; }
      // During IME composition the events are non-cancelable and the browser
      // owns the DOM — let it work natively; compositionend wraps the result.
      if (e.isComposing || composing) return;
      if (!TC_INPUT_TYPES.has(e.inputType)) return;

      const type = e.inputType;
      const isDeleteOp = type.startsWith('delete');

      // ── Delete: detect block-boundary merges & let browser handle simple deletes ──
      if (isDeleteOp) {
        const sr = e.getTargetRanges ? e.getTargetRanges() : [];
        const dr = sr.length > 0 ? staticToRange(sr[0]) : null;

        // ── Helper: detect if the caret sits inside an <ins> ──
        const _caretInsEl = () => {
          const sel = window.getSelection();
          const c = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
          if (!c || !c.collapsed) return null;
          const n = c.startContainer.nodeType === Node.ELEMENT_NODE
            ? c.startContainer : c.startContainer.parentElement;
          return n ? n.closest('ins[data-tc-id]') : null;
        };

        // ── Single-char backspace / delete inside an <ins> element ──
        // getTargetRanges() can return a range at the *paragraph* level that
        // spans the entire <ins> (collapsed or non-collapsed).  We must
        // detect via the caret, not the target range, and handle manually.
        if (type === 'deleteContentBackward' || type === 'deleteContentForward') {
          const insEl = _caretInsEl();
          if (insEl) {
            const sel = window.getSelection();
            const caret = sel.getRangeAt(0);

            // Block-boundary checks still apply
            if (type === 'deleteContentBackward' && isAtBlockStart(caret)) {
              e.preventDefault();
              const block = getBlock(caret.startContainer);
              if (block) { pushUndo(); mergeBlockIntoPrevious(block); ensureBodyHasParagraph(); updateTcBar(); }
              return;
            }
            if (type === 'deleteContentForward' && isAtBlockEnd(caret)) {
              e.preventDefault();
              const block = getBlock(caret.startContainer);
              if (block) { pushUndo(); mergeNextBlockIntoCurrent(block); ensureBodyHasParagraph(); updateTcBar(); }
              return;
            }

            // Own insertion → let browser delete natively (no tracking needed)
            if (insEl.getAttribute('data-tc-author') === tc.authorName) {
              return;
            }

            // Other user's insertion → track-delete exactly ONE character.
            if (caret.startContainer.nodeType === Node.TEXT_NODE) {
              const txt = caret.startContainer;
              const off = caret.startOffset;
              let oneChar = null;
              if (type === 'deleteContentBackward' && off > 0) {
                oneChar = document.createRange();
                oneChar.setStart(txt, off - 1);
                oneChar.setEnd(txt, off);
              } else if (type === 'deleteContentForward' && off < txt.length) {
                oneChar = document.createRange();
                oneChar.setStart(txt, off);
                oneChar.setEnd(txt, off + 1);
              }
              if (oneChar) {
                pushUndo('deleting');
                e.preventDefault();
                wrapRangeAsDeletion(oneChar, false);
                ensureBodyHasParagraph();
                updateTcBar();
                return;
              }
            }
            // At element boundary inside <ins> — fall through to normal path
          }
        }

        // Collapsed target = single-char delete (not a selection)
        if (dr && dr.collapsed) {
          const sel = window.getSelection();
          const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;

          if (type === 'deleteContentBackward' && range && isAtBlockStart(range)) {
            // Backspace at start of block → merge with previous (Word behavior)
            e.preventDefault();
            const block = getBlock(range.startContainer);
            if (block) {
              pushUndo();
              mergeBlockIntoPrevious(block);
              ensureBodyHasParagraph();
              updateTcBar();
            }
            return;
          }

          if (type === 'deleteContentForward' && range && isAtBlockEnd(range)) {
            // Delete at end of block → merge next block in (Word behavior)
            e.preventDefault();
            const block = getBlock(range.startContainer);
            if (block) {
              pushUndo();
              mergeNextBlockIntoCurrent(block);
              ensureBodyHasParagraph();
              updateTcBar();
            }
            return;
          }

          // Normal collapsed delete (single char in middle of text) →
          // let browser handle natively, no preventDefault
          return;
        }

        // Non-collapsed target with no text content → let browser handle
        if (dr && !dr.toString()) return;

        // Non-collapsed with text → falls through to wrapRangeAsDeletion below
      }

      // ── Normal path: push undo, prevent default, dispatch ──
      // Burst typing / repeated deleting coalesce into one undo step.
      pushUndo(type === 'insertText' ? 'typing' : (isDeleteOp ? 'deleting' : null));
      e.preventDefault();

      const staticRanges = e.getTargetRanges ? e.getTargetRanges() : [];
      const targetRange = staticRanges[0]
        ? staticToRange(staticRanges[0])
        : (window.getSelection().rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null);
      if (!targetRange) return;

      if (type === 'insertText' || type === 'insertReplacementText') {
        if (!targetRange.collapsed) wrapRangeAsDeletion(targetRange, true);
        insertTracked(e.data);
      } else if (type === 'insertFromPaste' || type === 'insertFromDrop') {
        if (!targetRange.collapsed) wrapRangeAsDeletion(targetRange, true);
        const dt = e.dataTransfer || null;
        const html = dt?.getData('text/html') || '';
        if (html) {
          insertTrackedHtml(html);
        } else {
          const text = dt?.getData('text/plain') || '';
          if (text) insertTracked(text);
        }
      } else if (type === 'deleteByCut') {
        if (!targetRange.collapsed) wrapRangeAsDeletion(targetRange, false);
      } else if (isDeleteOp) {
        wrapRangeAsDeletion(targetRange, false);
      } else if (type === 'insertParagraph') {
        if (!targetRange.collapsed) wrapRangeAsDeletion(targetRange, true);
        insertTrackedParagraph();
      } else if (type === 'insertLineBreak') {
        insertTrackedLineBreak();
      }

      if (isDeleteOp) ensureBodyHasParagraph();
      updateTcBar();
    });

    // ── IME / composition input (autocorrect, dead keys, mobile keyboards) ──
    // insertCompositionText is not cancelable, so composed text cannot be
    // intercepted in beforeinput like normal typing. Instead the browser
    // inserts it natively and compositionend wraps the final composed text in
    // a tracked <ins>. Known limitation: if a composition *replaces* a
    // non-collapsed selection, the replaced text is not recorded as a tracked
    // deletion (mutating the DOM at compositionstart aborts composition in
    // some browsers).
    let composing = null;

    body.addEventListener('compositionstart', () => {
      if (!body.isContentEditable) return;
      pushUndo();
      composing = {};
    });

    body.addEventListener('compositionend', e => {
      const wasComposing = composing;
      composing = null;
      if (!wasComposing || !e.data) { updateTcBar(); return; }
      try {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const caret = sel.getRangeAt(0);
        if (!caret.collapsed || caret.startContainer.nodeType !== Node.TEXT_NODE) return;
        const node = caret.startContainer;
        const end = caret.startOffset;
        const start = end - e.data.length;
        // Only wrap when the composed text sits exactly before the caret —
        // anything else means the browser did something we can't attribute.
        if (start < 0 || node.textContent.slice(start, end) !== e.data) return;
        // Already inside one of our own insertions — nothing to mark.
        if (getSelfIns(node)) return;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const ins = document.createElement('ins');
        ins.setAttribute('data-tc-id', newTcId());
        applyAuthorAttrs(ins);
        ins.appendChild(range.extractContents());
        range.insertNode(ins);
        const r = document.createRange();
        r.setStart(ins.firstChild, ins.firstChild.length);
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        mergeAdjacentIns();
      } catch (_) { /* fall back to untracked rather than corrupt the DOM */ }
      finally { updateTcBar(); }
    });

    // ── Active state update ──────────────────────────────────────────────────

    function updateActive() {
      // Detect current block for heading/alignment
      let currentBlock = null;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          let node = sel.getRangeAt(0).startContainer;
          while (node && node !== body) {
            if (node.nodeType === 1 && /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/i.test(node.tagName)) { currentBlock = node; break; }
            node = node.parentNode;
          }
        }
      } catch (_) {}
      const currentTag = currentBlock ? currentBlock.tagName.toLowerCase() : '';
      const currentAlign = currentBlock ? (currentBlock.style.textAlign || window.getComputedStyle(currentBlock).textAlign || 'left') : 'left';
      const ALIGN_MAP = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' };

      toolbar.querySelectorAll('.gcp-re-btn').forEach(btn => {
        const cmd = btn.dataset.cmd;
        if (!cmd || cmd === 'removeFormat') { btn.classList.remove('active'); return; }
        // #4 — Heading active state
        if (cmd === 'h2' || cmd === 'h3') {
          btn.classList.toggle('active', currentTag === cmd);
          return;
        }
        // #7 — Alignment active state
        if (ALIGN_MAP[cmd]) {
          btn.classList.toggle('active', currentAlign === ALIGN_MAP[cmd] || (ALIGN_MAP[cmd] === 'left' && currentAlign === 'start'));
          return;
        }
        try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch (_) {}
      });

      // #6 — Font family/size feedback
      try {
        const rawFont = document.queryCommandValue('fontName').replace(/["']/g, '');
        const match = FONT_FAMILIES.find(f => f.value && rawFont.toLowerCase().includes(f.value.toLowerCase()));
        fontFamilySelect.value = match ? match.value : '';
      } catch (_) { fontFamilySelect.value = ''; }

      try {
        if (currentBlock) {
          const computed = window.getComputedStyle(currentBlock).fontSize; // e.g. "15px"
          const px = parseFloat(computed);
          if (px) {
            const pt = Math.round(px * 72 / 96);
            const match = FONT_SIZES.find(f => f.value && parseInt(f.value) === pt);
            fontSizeSelect.value = match ? match.value : '';
          }
        }
      } catch (_) { fontSizeSelect.value = ''; }

      // #8 — Color bar feedback
      try {
        const fc = document.queryCommandValue('foreColor');
        if (fc) colorBar.style.background = fc;
      } catch (_) {}
      try {
        const bc = document.queryCommandValue('backColor');
        if (bc && bc !== 'rgba(0, 0, 0, 0)' && bc !== 'transparent') bgColorBar.style.background = bc;
      } catch (_) {}
    }

    body.addEventListener('keyup', updateActive);
    body.addEventListener('mouseup', updateActive);
    // selectionchange only fires on document — filter to selections inside the body
    function onDocSelectionChange() {
      const sel = window.getSelection();
      if (sel && sel.anchorNode && body.contains(sel.anchorNode)) updateActive();
    }
    document.addEventListener('selectionchange', onDocSelectionChange);

    body.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey) {
        if (e.key === 'b') { e.preventDefault(); trackFmtChange('bold');      updateActive(); }
        if (e.key === 'i') { e.preventDefault(); trackFmtChange('italic');    updateActive(); }
        if (e.key === 'u') { e.preventDefault(); trackFmtChange('underline'); updateActive(); }
        if (e.key === 'z') { e.preventDefault(); performUndo(); }
        if (e.key === 'y') { e.preventDefault(); performRedo(); }
        // #9 — Ctrl+A selects editor body only
        if (e.key === 'a') {
          e.preventDefault();
          const sel = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(body);
          sel.removeAllRanges(); sel.addRange(r);
        }
      }
      // Ctrl+Shift+Z = redo
      if (mod && e.shiftKey && e.key === 'Z') { e.preventDefault(); performRedo(); }
      // #5 — Tab key handling
      if (e.key === 'Tab') {
        e.preventDefault();
        const sel = window.getSelection();
        const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
        const li = node ? (node.nodeType === 1 ? node : node.parentElement)?.closest('li') : null;
        const td = node ? (node.nodeType === 1 ? node : node.parentElement)?.closest('td,th') : null;
        if (li) {
          execCmd(e.shiftKey ? 'outdent' : 'indent');
        } else if (td) {
          const cells = [...td.closest('table').querySelectorAll('td,th')];
          const idx = cells.indexOf(td);
          const next = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
          if (next) {
            const r = document.createRange();
            r.selectNodeContents(next); sel.removeAllRanges(); sel.addRange(r);
          }
        } else {
          insertTracked('    ');
        }
      }
      if (e.key === 'Escape' && fsActive) { e.preventDefault(); toggleFullscreen(false); }
      if (e.key === 'Escape' && findPanel) { e.preventDefault(); closeFindPanel(); }
      // #13 — Find (Ctrl+F) and Find & Replace (Ctrl+H)
      if (mod && !e.shiftKey && e.key === 'f') { e.preventDefault(); openFindPanel(false); }
      if (mod && !e.shiftKey && e.key === 'h') { e.preventDefault(); openFindPanel(true); }
    });

    // ── Public API ───────────────────────────────────────────────────────────

    function getHtml() {
      return body.innerHTML.replace(/(<br\s*\/?>|\s|&nbsp;)*$/, '').trim();
    }

    function setHtml(html) { body.innerHTML = sanitizeUntrustedHtml(html); mergeAdjacentIns(); updateTcBar(); }
    function destroy() {
      if (fsActive) {
        document.body.style.overflow = '';
        if (fsOriginalParent) fsOriginalParent.insertBefore(wrap, fsOriginalNextSibling || null);
      }
      document.removeEventListener('keydown', onDocKeydown);
      document.removeEventListener('selectionchange', onDocSelectionChange);
      cancelAnimationFrame(_positionBalloonRafId);
      clearTimeout(_scrollSettleTimer);
      container.innerHTML = '';
    }
    function focus() { body.focus(); }

    function setCommentsActive(active) {
      cmtPanelVisible = active;
      cmtBtn.classList.toggle('active', active && storedComments.length > 0);
    }
    function setCommentsBadge(n) {
      if (n > 0) { cmtBadge.textContent = String(n); cmtBadge.style.display = ''; }
      else cmtBadge.style.display = 'none';
      cmtBtn.classList.toggle('active', cmtPanelVisible && n > 0);
    }
    function setComments(comments) {
      storedComments = comments || [];
      setCommentsBadge(storedComments.length);
      updateTcBar();
      positionBalloons();
    }

    function onDocKeydown(e) {
      if (e.key === 'Escape' && fsActive) { e.preventDefault(); toggleFullscreen(false); }
    }
    document.addEventListener('keydown', onDocKeydown);

    if (initialHtml) mergeAdjacentIns();
    updateTcBar();

    // ── Orphaned comments ────────────────────────────────────────────────────
    // Comments whose anchor span no longer exists in the document. Computed on
    // demand (typically at save time) rather than auto-deleted by a
    // MutationObserver — transient DOM states like undo or reject-all must
    // never destroy comments on the server. Replies to an orphaned root are
    // included so no dangling thread survives the root's deletion.
    function getOrphanedCommentIds() {
      const present = new Set(
        [...body.querySelectorAll('.gcp-cmt-anchor[data-cmt-anchor-id]')]
          .map(el => el.getAttribute('data-cmt-anchor-id'))
      );
      const orphanRootIds = new Set(
        storedComments
          .filter(c => !c.parent_id && c.anchor_id && !present.has(c.anchor_id))
          .map(c => c.id)
      );
      const ids = [...orphanRootIds];
      storedComments.forEach(c => {
        if (c.parent_id && orphanRootIds.has(c.parent_id)) ids.push(c.id);
      });
      return ids;
    }

    return {
      getHtml, getCleanHtml, setHtml, destroy, focus, el: body,
      toolbarEl: toolbar, wrapEl: wrap,
      acceptAllChanges, rejectAllChanges, hasTrackedChanges,
      setCommentsActive, setCommentsBadge, setComments, removeCommentAnchor,
      getOrphanedCommentIds,
      toggleFullscreen,
    };
  }

  // ── Expose on window.GCP ─────────────────────────────────────────────────
  window.GCP.RichEditor = RichEditor;

})();
