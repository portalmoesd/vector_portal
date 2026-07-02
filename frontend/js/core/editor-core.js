/**
 * GCP Rich Editor — shared core: constants, styles, and pure helpers.
 * Loaded BEFORE editor.js; exposes window.GCP.EditorCore for the factory
 * plus the public compat helpers GCP.authorColor / GCP.authorInitials.
 */
(function () {
  'use strict';


  // ── Constants ──────────────────────────────────────────────────────────────

  const FONT_FAMILIES = [
    { label: 'Calibri',             value: '' },
    { label: 'Arial',               value: 'Arial' },
    { label: 'Sylfaen',             value: 'Sylfaen' },
    { label: 'Calibri',             value: 'Calibri' },
    { label: 'Noto Sans Georgian',  value: 'Noto Sans Georgian' },
    { label: 'Noto Serif Georgian', value: 'Noto Serif Georgian' },
    { label: 'FiraGO',              value: 'FiraGO' },
  ];

  const FONT_SIZES = [
    { label: 'Size',              value: '' },
    { label: '8',                 value: '8' },
    { label: '9',                 value: '9' },
    { label: '10',                value: '10' },
    { label: '11 (Recommended)',  value: '11' },
    { label: '12',                value: '12' },
    { label: '14',                value: '14' },
    { label: '16',                value: '16' },
    { label: '18',                value: '18' },
    { label: '20',                value: '20' },
    { label: '24',                value: '24' },
    { label: '28',                value: '28' },
    { label: '36',                value: '36' },
    { label: '48',                value: '48' },
    { label: '72',                value: '72' },
  ];

  const TOOLS = [
    { cmd: 'bold',          icon: '<b>B</b>',          title: 'Bold (Ctrl+B)' },
    { cmd: 'italic',        icon: '<i>I</i>',          title: 'Italic (Ctrl+I)' },
    { cmd: 'underline',     icon: '<u>U</u>',          title: 'Underline (Ctrl+U)' },
    { cmd: 'superscript',  icon: 'X<sup style="font-size:.7em">2</sup>', title: 'Superscript' },
    { cmd: 'subscript',    icon: 'X<sub style="font-size:.7em">2</sub>', title: 'Subscript' },
    { sep: true },
    { cmd: 'h2',            icon: 'H2',                title: 'Heading 2' },
    { cmd: 'h3',            icon: 'H3',                title: 'Heading 3' },
    { sep: true },
    { cmd: 'insertUnorderedList', icon: '&#8226;&#8212;', title: 'Bullet list' },
    { cmd: 'insertOrderedList',   icon: '1.',            title: 'Numbered list' },
    { sep: true },
    { cmd: 'justifyLeft',   icon: '<svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="14" height="1.8" rx=".6"/><rect x="0" y="3.4" width="9" height="1.8" rx=".6"/><rect x="0" y="6.8" width="14" height="1.8" rx=".6"/><rect x="0" y="10.2" width="9" height="1.8" rx=".6"/></svg>', title: 'Align left' },
    { cmd: 'justifyCenter', icon: '<svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="14" height="1.8" rx=".6"/><rect x="2.5" y="3.4" width="9" height="1.8" rx=".6"/><rect x="0" y="6.8" width="14" height="1.8" rx=".6"/><rect x="2.5" y="10.2" width="9" height="1.8" rx=".6"/></svg>', title: 'Center' },
    { cmd: 'justifyRight',  icon: '<svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="14" height="1.8" rx=".6"/><rect x="5" y="3.4" width="9" height="1.8" rx=".6"/><rect x="0" y="6.8" width="14" height="1.8" rx=".6"/><rect x="5" y="10.2" width="9" height="1.8" rx=".6"/></svg>', title: 'Align right' },
    { cmd: 'justifyFull',   icon: '<svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="14" height="1.8" rx=".6"/><rect x="0" y="3.4" width="14" height="1.8" rx=".6"/><rect x="0" y="6.8" width="14" height="1.8" rx=".6"/><rect x="0" y="10.2" width="14" height="1.8" rx=".6"/></svg>', title: 'Justify' },
    { sep: true },
    { cmd: 'removeFormat',  icon: '&#10005;',          title: 'Clear formatting' },
  ];

  // Word-style 8-colour author palette  [text/border, background]
  const TC_PALETTE = [
    ['#1d4ed8', 'rgba(29,78,216,.11)'],
    ['#b91c1c', 'rgba(185,28,28,.11)'],
    ['#15803d', 'rgba(21,128,61,.11)'],
    ['#7c3aed', 'rgba(124,58,237,.11)'],
    ['#c2410c', 'rgba(194,65,12,.11)'],
    ['#0f766e', 'rgba(15,118,110,.11)'],
    ['#9d174d', 'rgba(157,23,77,.11)'],
    ['#3730a3', 'rgba(55,48,163,.11)'],
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function authorColorIdx(name) {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % TC_PALETTE.length;
  }

  function getInitials(name) {
    return (name || '').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s[0] && s[0].toUpperCase()).filter(Boolean).join('') || '?';
  }

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return ''; }
  }

  // ── Security-only sanitization for HTML loaded from the server ────────────
  // Defence in depth: the server sanitizes on write and read, but any HTML
  // assigned to the editable body must never execute. Unlike the paste-time
  // sanitizeHtml() below, this preserves formatting (classes, styles,
  // data-tc-* attributes) and only strips active content. <template> content
  // is inert — nothing executes or loads while it is parsed and cleaned.
  const DANGEROUS_TAGS = 'script,style,link,meta,base,iframe,frame,object,embed,form,svg,math';
  const URL_ATTRS = ['href', 'src', 'xlink:href', 'action'];
  function sanitizeUntrustedHtml(html) {
    if (!html) return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll(DANGEROUS_TAGS).forEach(el => el.remove());
    tpl.content.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (URL_ATTRS.includes(name)) {
          const v = attr.value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
          if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:')) {
            el.removeAttribute(attr.name);
          }
        }
      }
    });
    return tpl.innerHTML;
  }

  // Translate with an explicit fallback for when the key has no entry
  // (I18n.tr returns the key itself in that case).
  function trOr(key, fallback) {
    const t = I18n.tr(key);
    return t !== key ? t : fallback;
  }

  // ── Backward-compat helpers exposed on window.GCP ─────────────────────────
  function authorColor(name) {
    return TC_PALETTE[authorColorIdx(name)][0];
  }
  function authorInitials(name) {
    return getInitials(name);
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  const TOOLBAR_CSS = `
    .gcp-re-wrap { display:flex; flex-direction:column; border:1px solid var(--border,#e5e7eb); border-radius:14px; overflow:hidden; background:var(--card,#fff); }
    .gcp-re-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:2px; padding:6px 8px; border-bottom:1px solid var(--border,#e5e7eb); background:rgba(0,0,0,.02); }
    .gcp-re-btn { display:inline-flex; align-items:center; justify-content:center; gap:4px; min-width:30px; height:30px; padding:0 7px; border-radius:8px; border:1px solid transparent; background:transparent; cursor:pointer; font-size:13px; font-weight:700; color:var(--text,#1f2a37); transition:background .12s,border-color .12s; }
    .gcp-re-btn:hover { background:rgba(0,0,0,.06); border-color:rgba(0,0,0,.10); }
    .gcp-re-btn.active { background:rgba(10,132,255,.14); border-color:rgba(10,132,255,.30); color:#0a84ff; }
    .gcp-re-sep { width:1px; height:22px; background:var(--border,#e5e7eb); margin:0 3px; align-self:center; flex-shrink:0; }
    .gcp-re-select { height:30px; padding:0 5px; border-radius:8px; border:1px solid transparent; background:transparent; cursor:pointer; font-size:12px; font-weight:600; color:var(--text,#1f2a37); outline:none; max-width:130px; transition:background .12s,border-color .12s; }
    .gcp-re-select:hover { background:rgba(0,0,0,.06); border-color:rgba(0,0,0,.10); }
    .gcp-re-color-wrap { position:relative; display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:30px; padding:0 7px; border-radius:8px; border:1px solid transparent; background:transparent; cursor:pointer; transition:background .12s,border-color .12s; overflow:hidden; }
    .gcp-re-color-wrap:hover { background:rgba(0,0,0,.06); border-color:rgba(0,0,0,.10); }
    .gcp-re-color-label { display:flex; flex-direction:column; align-items:center; gap:1px; pointer-events:none; }
    .gcp-re-color-a { font-size:13px; font-weight:900; line-height:1; color:var(--text,#1f2a37); }
    .gcp-re-color-bar { height:3px; width:14px; border-radius:2px; background:#000; }
    .gcp-re-color-input { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; border:none; padding:0; }
    [data-theme="dark"] .gcp-re-wrap { background:rgba(30,33,44,.92); }
    [data-theme="dark"] .gcp-re-toolbar { background:rgba(22,25,34,.60); }
    [data-theme="dark"] .gcp-re-btn { color:#c0cce0; }
    [data-theme="dark"] .gcp-re-btn:hover { background:rgba(255,255,255,.07); }
    [data-theme="dark"] .gcp-re-btn.active { background:rgba(33,150,243,.20); color:#90caf9; }
    [data-theme="dark"] .gcp-re-body { color:#e8ecf4; }
    [data-theme="dark"] .gcp-re-select { color:#c0cce0; }
    [data-theme="dark"] .gcp-re-select:hover { background:rgba(255,255,255,.07); }
    [data-theme="dark"] .gcp-re-color-a { color:#c0cce0; }
    .gcp-re-tc-badge { display:inline-flex; align-items:center; justify-content:center; min-width:15px; height:15px; padding:0 3px; border-radius:999px; background:rgba(220,38,38,.15); color:#b91c1c; font-size:10px; font-weight:800; line-height:1; }
    .gcp-re-btn.tc-active { background:rgba(245,158,11,.15); border-color:rgba(217,119,6,.38); color:#92400e; }
    .gcp-re-btn.tc-active .gcp-re-tc-badge { background:rgba(59,130,246,.14); color:#1d4ed8; }
    [data-theme="dark"] .gcp-re-btn.tc-active { background:rgba(245,158,11,.20); color:#fcd34d; }
    .gcp-re-cmt-badge { display:inline-flex; align-items:center; justify-content:center; min-width:15px; height:15px; padding:0 3px; border-radius:999px; background:rgba(3,105,161,.14); color:#0369a1; font-size:10px; font-weight:800; line-height:1; }
    .gcp-re-tc-bar { display:flex; align-items:center; gap:8px; padding:5px 10px; border-bottom:1px solid var(--border,#e5e7eb); background:rgba(245,158,11,.06); font-size:12px; font-weight:600; color:#78350f; }
    .gcp-re-tc-bar-left { flex:1; display:flex; flex-direction:column; gap:1px; min-width:0; }
    .gcp-re-tc-summary { font-size:12px; font-weight:700; }
    .gcp-re-tc-authors-row { font-size:11px; font-weight:500; color:#92400e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gcp-re-tc-bar-actions { display:flex; gap:5px; flex-shrink:0; }
    .gcp-re-tc-action { padding:2px 9px; border-radius:6px; border:1px solid; cursor:pointer; font-size:11px; font-weight:700; background:transparent; line-height:1.6; }
    .gcp-re-tc-action.accept { border-color:rgba(22,163,74,.35); color:#15803d; }
    .gcp-re-tc-action.accept:hover { background:rgba(22,163,74,.10); }
    .gcp-re-tc-action.reject { border-color:rgba(220,38,38,.35); color:#b91c1c; }
    .gcp-re-tc-action.reject:hover { background:rgba(220,38,38,.10); }
    [data-theme="dark"] .gcp-re-tc-bar { background:rgba(120,80,10,.16); color:#fcd34d; }
    [data-theme="dark"] .gcp-re-tc-authors-row { color:#fbbf24; }
    .gcp-re-tc-pane { display:none; }
    .gcp-re-content-row { display:flex; overflow-y:auto; overflow-x:auto; min-height:400px; align-items:flex-start; position:relative; background:#e8eaed; padding:40px 32px 64px; gap:24px; justify-content:center; }
    .gcp-re-body { flex:0 0 794px; width:794px; box-sizing:border-box; min-height:1123px; padding:96px; outline:none; font-family:Calibri,sans-serif; font-size:15px; line-height:1.65; color:var(--text,#1f2a37); overflow-y:visible; word-break:normal; overflow-wrap:break-word; background:#fff; box-shadow:0 4px 16px rgba(0,0,0,.18); }
    .gcp-re-body:empty::before { content:attr(data-placeholder); color:var(--muted,#6b7280); pointer-events:none; }
    .gcp-re-body h2 { font-size:1.3em; font-weight:800; margin:.8em 0 .3em; }
    .gcp-re-body h3 { font-size:1.1em; font-weight:700; margin:.7em 0 .25em; }
    .gcp-re-body ul,.gcp-re-body ol { margin:.4em 0; padding-left:1.6em; }
    .gcp-re-body li { margin:.2em 0; }
    .gcp-re-body p { margin:0; }
    .gcp-re-wrap.tc-visible .gcp-re-body .gcp-tc-changed { border-left:3px solid #b91c1c; padding-left:6px; margin-left:-9px; }
    .gcp-re-margin { width:0; flex-shrink:0; position:relative; overflow:visible; }
    .gcp-re-wrap.tc-visible .gcp-re-margin,.gcp-re-wrap.has-comments .gcp-re-margin { width:240px; }
    .gcp-re-connectors { position:absolute; top:0; left:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
    .gcp-re-balloon-avatar { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:50%; font-size:9px; font-weight:800; color:#fff; flex-shrink:0; }
    .gcp-re-balloon { position:absolute; left:8px; right:4px; background:#fff; border-radius:8px; padding:7px 10px; box-shadow:0 1px 6px rgba(15,23,42,.10); font-size:11px; box-sizing:border-box; border:1px solid #e2e8f0; }
    .gcp-re-balloon--del { border-left:3px solid #dc2626; background:#fff8f8; }
    .gcp-re-balloon--ins { border-left:3px solid var(--tc-bcolor,#1d4ed8); background:#f8faff; }
    .gcp-re-balloon--cmt { border-left:3px solid #f59e0b; background:#fffdf5; }
    .gcp-re-balloon--tc-group { border-left:3px solid #64748b; background:#f8fafc; }
    .gcp-re-balloon-change-count { font-size:10px; color:#64748b; margin-top:1px; }
    .gcp-re-snippet { font-size:10px; font-family:monospace; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gcp-re-snippet--wrap { white-space:pre-wrap; overflow:visible; text-overflow:unset; overflow-wrap:break-word; word-break:break-word; }
    .gcp-re-snippet-ins { color:#15803d; }
    .gcp-re-snippet-del { color:#b91c1c; text-decoration:line-through; }
    .gcp-re-balloon-expand { margin-top:4px; background:none; border:none; padding:0; font-size:10px; font-weight:700; color:#0a84ff; cursor:pointer; line-height:1.4; }
    .gcp-re-balloon-expand:hover { text-decoration:underline; }
    .gcp-re-balloon-header { display:flex; align-items:center; gap:5px; margin-bottom:4px; }
    .gcp-re-balloon-author { font-weight:800; color:#0f172a; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gcp-re-balloon-time { color:#94a3b8; white-space:nowrap; flex-shrink:0; }
    .gcp-re-balloon-body { color:#334155; line-height:1.4; word-break:break-word; }
    .gcp-re-balloon-kind { display:inline-block; font-size:9px; font-weight:800; padding:1px 4px; border-radius:3px; margin-right:3px; vertical-align:middle; }
    .gcp-re-balloon-kind.del { background:rgba(220,38,38,.12); color:#dc2626; }
    .gcp-re-balloon-kind.ins { background:rgba(29,78,216,.12); color:#1d4ed8; }
    .gcp-re-balloon-kind.cmt { background:rgba(245,158,11,.14); color:#b45309; }
    .gcp-re-balloon-btns { display:flex; gap:3px; margin-top:5px; }
    .gcp-re-balloon-acc,.gcp-re-balloon-rej,.gcp-re-balloon-del { font-size:10px; font-weight:800; border:none; border-radius:4px; padding:2px 7px; cursor:pointer; line-height:1.4; transition:background .1s; }
    .gcp-re-balloon-acc { background:rgba(21,128,61,.12); color:#15803d; }
    .gcp-re-balloon-acc:hover { background:rgba(21,128,61,.22); }
    .gcp-re-balloon-rej { background:rgba(185,28,28,.12); color:#b91c1c; }
    .gcp-re-balloon-rej:hover { background:rgba(185,28,28,.22); }
    .gcp-re-balloon-del { background:rgba(185,28,28,.10); color:#b91c1c; }
    .gcp-re-balloon-del:hover { background:rgba(185,28,28,.22); }
    .gcp-re-wrap.gcp-fullscreen { position:fixed; inset:0; z-index:9990; border-radius:0; border:none; width:100vw; height:100dvh; display:flex; flex-direction:column; background:#f1f5f9 !important; }
    .gcp-re-wrap.gcp-fullscreen .gcp-re-content-row { flex:1 1 0; min-height:0; overflow-y:auto; overflow-x:auto; padding:40px 32px 64px; gap:24px; justify-content:center; }
    .gcp-re-wrap.gcp-fullscreen .gcp-re-body { flex:0 0 794px; width:794px; box-sizing:border-box; min-height:1123px; background:#ffffff; box-shadow:0 4px 16px rgba(0,0,0,.18); border-radius:0; padding:96px; }
    .gcp-re-fs-titlebar { display:none; align-items:center; gap:10px; padding:10px 56px; background:#ffffff; border-bottom:1px solid #e2e8f0; flex-shrink:0; }
    .gcp-re-wrap.gcp-fullscreen .gcp-re-fs-titlebar { display:flex; }
    .gcp-re-fs-title { font-size:14px; font-weight:700; color:#0f172a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    [data-theme="dark"] .gcp-re-wrap.gcp-fullscreen { background:#161b27 !important; }
    [data-theme="dark"] .gcp-re-wrap.gcp-fullscreen .gcp-re-body { background:#1e212c; box-shadow:0 1px 4px rgba(0,0,0,.25); }
    [data-theme="dark"] .gcp-re-wrap.gcp-fullscreen .gcp-re-fs-titlebar { background:#1e212c; border-color:#2d3348; }
    [data-theme="dark"] .gcp-re-fs-title { color:#f1f5f9; }
    .gcp-re-btn-fullscreen-icon-expand,.gcp-re-btn-fullscreen-icon-compress { pointer-events:none; }
    .gcp-re-wrap:not(.gcp-fullscreen) .gcp-re-btn-fullscreen-icon-compress { display:none; }
    .gcp-re-wrap.gcp-fullscreen .gcp-re-btn-fullscreen-icon-expand { display:none; }
    .gcp-re-ctx { position:fixed; z-index:9999; background:#fff; border:1px solid #e2e8f0; border-radius:9px; box-shadow:0 4px 20px rgba(15,23,42,.14); padding:4px; min-width:160px; }
    .gcp-re-ctx-item { display:flex; align-items:center; gap:7px; padding:7px 12px; border-radius:6px; font-size:13px; font-weight:600; color:#0f172a; cursor:pointer; white-space:nowrap; transition:background .1s; }
    .gcp-re-ctx-item:hover { background:rgba(10,132,255,.09); color:#0a84ff; }
    .gcp-re-ctx-sep { height:1px; background:#e2e8f0; margin:3px 0; }
    .gcp-re-ctx-tbl-row { display:flex; align-items:center; gap:3px; padding:3px 10px; }
    .gcp-re-ctx-tbl-lbl { font-size:10px; font-weight:800; color:#64748b; flex:0 0 58px; }
    .gcp-re-ctx-tbl-btn { font-size:10px; font-weight:700; padding:2px 6px; border:1px solid #e2e8f0; border-radius:3px; cursor:pointer; background:#f8fafc; color:#334155; line-height:1.4; white-space:nowrap; }
    .gcp-re-ctx-tbl-btn:hover { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    [data-theme="dark"] .gcp-re-ctx-tbl-btn { background:#2a2d3e; border-color:#3d4155; color:#c0cce0; }
    [data-theme="dark"] .gcp-re-ctx-tbl-btn:hover { background:rgba(29,78,216,.25); border-color:#4f87e8; color:#93c5fd; }
    [data-theme="dark"] .gcp-re-ctx { background:#1e212c; border-color:rgba(255,255,255,.10); }
    [data-theme="dark"] .gcp-re-ctx-item { color:#e8ecf4; }
    [data-theme="dark"] .gcp-re-ctx-item:hover { background:rgba(10,132,255,.15); color:#60a5fa; }
    .gcp-re-body ins[data-tc-id] { text-decoration:none; background:none; padding:0; font-style:normal; }
    .gcp-re-body del[data-tc-id] { display:none; }
    .gcp-re-wrap.tc-visible .gcp-re-body ins[data-tc-id] { text-decoration-line:underline; text-decoration-style:dotted; text-decoration-color:var(--tc-color,#1d4ed8); background:var(--tc-bg,rgba(29,78,216,.11)); border-radius:2px; padding:0 1px; cursor:default; font-style:normal; }
    .gcp-re-wrap.tc-visible .gcp-re-body del[data-tc-id] { display:inline; text-decoration:line-through; text-decoration-color:var(--tc-color,#b91c1c); color:var(--tc-color,#b91c1c); border-radius:2px; padding:0 1px; cursor:default; }
    [data-theme="dark"] .gcp-re-wrap.tc-visible .gcp-re-body ins[data-tc-id] { background:color-mix(in srgb, var(--tc-color,#1d4ed8) 18%, transparent); }
    [data-theme="dark"] .gcp-re-wrap.tc-visible .gcp-re-body del[data-tc-id] { background:color-mix(in srgb, var(--tc-color,#b91c1c) 18%, transparent); }
    .gcp-re-body [data-tc-fmt-id] { border-radius:2px; }
    .gcp-re-wrap.tc-visible .gcp-re-body [data-tc-fmt-id] { outline:1.5px dotted var(--tc-color,#7c3aed); background:rgba(124,58,237,.07); border-radius:2px; padding:0 1px; cursor:default; }
    [data-theme="dark"] .gcp-re-wrap.tc-visible .gcp-re-body [data-tc-fmt-id] { background:rgba(124,58,237,.15); }
    .gcp-re-balloon-kind.fmt { background:rgba(124,58,237,.12); color:#7c3aed; }
    .gcp-re-cmt-replies { margin-top:6px; padding-top:6px; border-top:1px solid rgba(0,0,0,.08); display:flex; flex-direction:column; gap:5px; }
    .gcp-re-cmt-reply { padding:0; }
    .gcp-re-cmt-reply-form { margin-top:6px; padding-top:6px; border-top:1px solid rgba(0,0,0,.08); }
    .gcp-re-cmt-reply-input { width:100%; box-sizing:border-box; border:1px solid #e2e8f0; border-radius:6px; padding:5px 8px; font-size:11px; resize:none; outline:none; font-family:inherit; line-height:1.4; }
    .gcp-re-cmt-reply-input:focus { border-color:#93c5fd; box-shadow:0 0 0 2px rgba(147,197,253,.25); }
    .gcp-re-balloon-reply { background:rgba(3,105,161,.10); color:#0369a1; font-size:10px; font-weight:800; border:none; border-radius:4px; padding:2px 7px; cursor:pointer; line-height:1.4; transition:background .1s; }
    .gcp-re-balloon-reply:hover { background:rgba(3,105,161,.20); }
    .gcp-re-cmt-reply-send { background:rgba(21,128,61,.12); color:#15803d; font-size:10px; font-weight:800; border:none; border-radius:4px; padding:2px 7px; cursor:pointer; line-height:1.4; transition:background .1s; }
    .gcp-re-cmt-reply-send:hover { background:rgba(21,128,61,.22); }
    .gcp-re-cmt-reply-send:disabled { opacity:.5; cursor:default; }
    .gcp-re-cmt-reply-cancel { background:transparent; color:#64748b; font-size:10px; font-weight:700; border:none; border-radius:4px; padding:2px 7px; cursor:pointer; line-height:1.4; transition:background .1s; }
    .gcp-re-cmt-reply-cancel:hover { background:rgba(0,0,0,.06); }
    .gcp-re-wrap.has-comments .gcp-re-body .gcp-cmt-anchor { background:rgba(255,210,0,.30); border-bottom:2px solid #d97706; border-radius:2px; cursor:default; box-shadow:0 0 0 1px rgba(217,119,6,.20); }
    .gcp-re-wrap.has-comments .gcp-re-body .gcp-cmt-anchor:hover { background:rgba(255,210,0,.50); box-shadow:0 0 0 1px rgba(217,119,6,.45); }
    .gcp-re-palette { position:fixed; z-index:10000; background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 6px 24px rgba(15,23,42,.16); padding:10px; min-width:196px; }
    .gcp-re-palette-grid { display:grid; grid-template-columns:repeat(8,20px); gap:3px; }
    .gcp-re-palette-swatch { width:20px; height:20px; border-radius:3px; border:1px solid rgba(0,0,0,.12); cursor:pointer; transition:transform .1s,box-shadow .1s; }
    .gcp-re-palette-swatch:hover { transform:scale(1.2); box-shadow:0 0 0 2px rgba(10,132,255,.5); z-index:1; position:relative; }
    .gcp-re-palette-divider { height:1px; background:#e2e8f0; margin:8px 0; }
    .gcp-re-palette-custom { display:flex; align-items:center; gap:6px; font-size:11px; color:#0369a1; font-weight:700; cursor:pointer; padding:3px 2px; border-radius:5px; }
    .gcp-re-palette-custom:hover { background:rgba(3,105,161,.08); }
    .gcp-re-palette-custom input[type="color"] { width:20px; height:20px; border:none; padding:0; border-radius:3px; cursor:pointer; }
    [data-theme="dark"] .gcp-re-palette { background:#1e212c; border-color:rgba(255,255,255,.1); }
    [data-theme="dark"] .gcp-re-palette-custom { color:#60a5fa; }
    .gcp-re-tbl-picker { position:fixed; z-index:10000; background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 6px 24px rgba(15,23,42,.16); padding:10px; }
    .gcp-re-tbl-grid { display:grid; grid-template-columns:repeat(8,22px); gap:2px; }
    .gcp-re-tbl-cell { width:22px; height:22px; border:1px solid #d1d5db; border-radius:2px; background:#f8fafc; cursor:pointer; box-sizing:border-box; }
    .gcp-re-tbl-cell.hi { background:#dbeafe; border-color:#93c5fd; }
    .gcp-re-tbl-label { text-align:center; font-size:11px; color:#64748b; margin-top:6px; font-weight:600; }
    [data-theme="dark"] .gcp-re-tbl-picker { background:#1e212c; border-color:rgba(255,255,255,.1); }
    [data-theme="dark"] .gcp-re-tbl-cell { background:#252836; border-color:#3d4155; }
    [data-theme="dark"] .gcp-re-tbl-cell.hi { background:rgba(29,78,216,.25); border-color:#4f87e8; }
    .gcp-re-body table { border-collapse:collapse; width:100%; margin:.5em 0; }
    .gcp-re-body th,.gcp-re-body td { border:1px solid #d1d5db; padding:6px 10px; font-size:14px; min-width:48px; vertical-align:top; }
    .gcp-re-body th { background:#f1f5f9; font-weight:700; text-align:left; }
    .gcp-re-body td:focus,.gcp-re-body th:focus { outline:2px solid #93c5fd; outline-offset:-1px; }
    .gcp-re-btn--mobile-only { display:none; }
    @media (max-width: 820px) {
      .gcp-re-btn--mobile-only { display:inline-flex; }
      .gcp-re-content-row { padding:16px 4px 40px; }
      .gcp-re-body { flex:1 1 auto; width:100% !important; min-width:0; padding:32px 20px; min-height:400px; }
      .gcp-re-wrap.tc-visible .gcp-re-margin,
      .gcp-re-wrap.has-comments .gcp-re-margin { width:0; overflow:hidden; }
      .gcp-re-balloon { display:none; }
      .gcp-re-connectors { display:none; }
      .gcp-re-wrap.gcp-fullscreen .gcp-re-content-row { padding:16px 4px 40px; }
      .gcp-re-wrap.gcp-fullscreen .gcp-re-body { flex:1 1 auto; width:100% !important; min-width:0; padding:32px 20px; min-height:400px; }
    }
    .gcp-re-mobile-sheet-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.3); z-index:9998; }
    .gcp-re-mobile-sheet-overlay.visible { display:block; }
    .gcp-re-mobile-sheet { position:fixed; bottom:0; left:0; right:0; z-index:9999; background:#fff; border-radius:14px 14px 0 0; box-shadow:0 -4px 24px rgba(0,0,0,.18); padding:16px 20px 24px; max-height:50vh; overflow-y:auto; transform:translateY(100%); transition:transform .25s ease; }
    .gcp-re-mobile-sheet.visible { transform:translateY(0); }
    .gcp-re-mobile-sheet-handle { width:36px; height:4px; border-radius:2px; background:#cbd5e1; margin:0 auto 12px; }
    .gcp-re-mobile-sheet .gcp-re-balloon-header { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
    .gcp-re-mobile-sheet .gcp-re-balloon-avatar { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%; font-size:10px; font-weight:800; color:#fff; flex-shrink:0; }
    .gcp-re-mobile-sheet .gcp-re-balloon-author { font-weight:800; font-size:14px; color:#0f172a; }
    .gcp-re-mobile-sheet .gcp-re-balloon-time { color:#94a3b8; font-size:12px; margin-left:auto; }
    .gcp-re-mobile-sheet .gcp-re-snippet { font-size:13px; font-family:monospace; margin:4px 0; white-space:pre-wrap; }
    .gcp-re-mobile-sheet .gcp-re-snippet-ins { color:#15803d; }
    .gcp-re-mobile-sheet .gcp-re-snippet-del { color:#b91c1c; text-decoration:line-through; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btns { display:flex; gap:8px; margin-top:14px; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btns button { flex:1; padding:10px; border-radius:10px; font-size:14px; font-weight:700; border:none; cursor:pointer; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btn-accept { background:rgba(21,128,61,.12); color:#15803d; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btn-reject { background:rgba(185,28,28,.12); color:#b91c1c; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btn-delete { background:rgba(185,28,28,.12); color:#b91c1c; }
    .gcp-re-mobile-sheet .gcp-re-mobile-sheet-btn-reply { background:rgba(29,78,216,.10); color:#1d4ed8; }
    .gcp-re-mobile-sheet-cmt-thread { margin-top:8px; }
    .gcp-re-mobile-sheet-cmt-reply { border-left:3px solid #e2e8f0; padding-left:12px; margin:10px 0; }
    .gcp-re-mobile-sheet-cmt-reply .gcp-re-balloon-header { margin-bottom:4px; }
    .gcp-re-mobile-sheet-cmt-body { font-size:14px; color:#334155; line-height:1.5; margin:4px 0 8px; white-space:pre-wrap; }
    .gcp-re-mobile-sheet-reply-form { margin-top:12px; }
    .gcp-re-mobile-sheet-reply-form textarea { width:100%; border:1px solid #cbd5e1; border-radius:8px; padding:10px 12px; font-size:14px; resize:none; font-family:inherit; box-sizing:border-box; }
    .gcp-re-mobile-sheet-reply-form textarea:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,.2); }
    .gcp-re-mobile-sheet-reply-actions { display:flex; gap:8px; margin-top:8px; }
    .gcp-re-mobile-sheet-reply-actions button { flex:1; padding:10px; border-radius:10px; font-size:14px; font-weight:700; border:none; cursor:pointer; }
    .gcp-re-mobile-sheet-btn-send { background:rgba(29,78,216,.12); color:#1d4ed8; }
    .gcp-re-mobile-sheet-btn-cancel { background:#f1f5f9; color:#64748b; }
    .gcp-re-mobile-sheet-highlighted { background:rgba(255,210,0,.18); border-radius:4px; padding:6px 8px; margin:-6px -8px 8px; }
    .gcp-re-find-panel { position:absolute; top:0; right:16px; z-index:200; background:#fff; border:1px solid #e2e8f0; border-radius:0 0 10px 10px; box-shadow:0 4px 16px rgba(15,23,42,.12); padding:10px 12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px; }
    [data-theme="dark"] .gcp-re-find-panel { background:#1e212c; border-color:#3d4155; }
    .gcp-re-find-panel input { height:28px; padding:0 8px; border:1px solid #d1d5db; border-radius:6px; font-size:12px; font-family:inherit; outline:none; min-width:160px; box-sizing:border-box; }
    .gcp-re-find-panel input:focus { border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,.2); }
    .gcp-re-find-panel button { height:28px; padding:0 10px; border-radius:6px; border:1px solid #d1d5db; background:#f8fafc; font-size:11px; font-weight:700; cursor:pointer; color:#334155; }
    .gcp-re-find-panel button:hover { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    .gcp-re-find-panel .gcp-re-find-close { border:none; background:transparent; font-size:16px; color:#94a3b8; cursor:pointer; padding:0 4px; }
    .gcp-re-find-panel .gcp-re-find-close:hover { color:#ef4444; }
    .gcp-re-find-panel .gcp-re-find-count { font-size:11px; color:#64748b; min-width:40px; }
    .gcp-re-find-highlight { background:rgba(250,204,21,.45); border-radius:2px; }
    .gcp-re-find-highlight-current { background:rgba(249,115,22,.50); border-radius:2px; }
    .gcp-re-body tr[data-tc-tbl="row-del"] { display:none; }
    .gcp-re-body td[data-tc-tbl="col-del"],.gcp-re-body th[data-tc-tbl="col-del"] { display:none; }
    .gcp-re-wrap.tc-visible .gcp-re-body tr[data-tc-tbl="row-del"] { display:table-row; }
    .gcp-re-wrap.tc-visible .gcp-re-body td[data-tc-tbl="col-del"],.gcp-re-wrap.tc-visible .gcp-re-body th[data-tc-tbl="col-del"] { display:table-cell; }
    .gcp-re-wrap.tc-visible .gcp-re-body [data-tc-tbl$="-del"] { background:rgba(185,28,28,.10) !important; text-decoration:line-through; text-decoration-color:#b91c1c; }
    .gcp-re-wrap.tc-visible .gcp-re-body [data-tc-tbl$="-add"] { background:rgba(29,78,216,.08) !important; }
  `;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const s = document.createElement('style');
    s.textContent = TOOLBAR_CSS;
    document.head.appendChild(s);
  }

  function execCmd(cmd, value) { document.execCommand(cmd, false, value || null); }

  function applyFontSizePt(pt) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontSize = pt + 'pt';
    span.appendChild(range.extractContents());
    range.insertNode(span);
    range.selectNodeContents(span);
    sel.removeAllRanges(); sel.addRange(range);
  }

  function handleHeading(tag) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    let block = range.commonAncestorContainer;
    while (block && block.nodeType !== Node.ELEMENT_NODE) block = block.parentNode;
    if (block && block.tagName && block.tagName.toLowerCase() === tag)
      document.execCommand('formatBlock', false, 'p');
    else
      document.execCommand('formatBlock', false, tag);
  }

  const COLOUR_PALETTE = [
    '#000000','#1f2937','#374151','#6b7280','#9ca3af','#d1d5db','#f3f4f6','#ffffff',
    '#5f0f40','#9a031e','#e05252','#f95738','#e36414','#fb8b24','#f4d35e','#ebebd3',
    '#def2f1','#b0d4db','#4878a0','#083d77','#3aafa9','#2b7a78','#0f4c5c','#17252a',
  ];

  window.GCP = window.GCP || {};
  window.GCP.authorColor = authorColor;
  window.GCP.authorInitials = authorInitials;
  window.GCP.EditorCore = {
    FONT_FAMILIES, FONT_SIZES, TOOLS, TC_PALETTE, COLOUR_PALETTE,
    authorColorIdx, getInitials, escHtml, fmtTime,
    sanitizeUntrustedHtml, trOr, injectStyle,
    execCmd, applyFontSizePt, handleHeading,
  };
})();
