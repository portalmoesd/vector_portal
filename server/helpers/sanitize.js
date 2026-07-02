/**
 * Server-side HTML sanitization for editor content (section html_content).
 *
 * The allowlist mirrors the vocabulary GCP.RichEditor actually produces:
 * basic blocks, inline formatting, tables, tracked-change markup
 * (<ins>/<del>/<span> with data-tc-* attributes) and comment anchors
 * (<span class="gcp-cmt-anchor" data-cmt-anchor-id>). Everything else —
 * scripts, event handlers, javascript: URLs, iframes — is stripped before
 * the content ever reaches the database.
 */
const sanitizeHtml = require('sanitize-html');

const TC_DATA_ATTRS = [
  'data-tc-id', 'data-tc-para', 'data-tc-tbl',
  'data-tc-fmt-id', 'data-tc-fmt-cmd', 'data-tc-fmt-old', 'data-tc-fmt-val',
  'data-tc-author', 'data-tc-initials', 'data-tc-color', 'data-tc-time',
  'data-cmt-anchor-id',
];

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|[a-zA-Z-]+)$/;
const SIZE_RE = /^-?\d+(\.\d+)?(px|pt|em|rem|%)?$/;
const BORDER_RE = /^(none|(\d+(\.\d+)?(px|pt)?\s+(solid|dashed|dotted)(\s+(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|[a-zA-Z-]+))?))$/;

const ALLOWED_STYLES = {
  'color': [COLOR_RE],
  'background-color': [COLOR_RE],
  'background': [COLOR_RE],
  'font-size': [SIZE_RE],
  'font-family': [/^[\w\s,'"‑-]+$/],
  'font-weight': [/^(normal|bold|[1-9]00)$/],
  'font-style': [/^(normal|italic|oblique)$/],
  'text-decoration': [/^[\w\s-]+$/],
  'text-decoration-line': [/^[\w\s-]+$/],
  'text-align': [/^(left|right|center|justify|start|end)$/],
  'vertical-align': [/^(baseline|sub|super|top|middle|bottom)$/],
  'margin-left': [SIZE_RE],
  'padding-left': [SIZE_RE],
  'border': [BORDER_RE],
  'border-color': [COLOR_RE],
  'width': [SIZE_RE],
  'height': [SIZE_RE],
  // Track-changes author colouring (CSS custom properties set by the editor)
  '--tc-color': [COLOR_RE],
  '--tc-bg': [COLOR_RE],
};

const OPTIONS = {
  allowedTags: [
    'p', 'div', 'br', 'hr', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'span', 'font', 'a',
    'ins', 'del',
    'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'img',
  ],
  allowedAttributes: {
    '*': ['style', 'title', ...TC_DATA_ATTRS],
    a: ['href', 'name', 'target', 'rel'],
    font: ['color', 'face', 'size'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    ol: ['start', 'type'],
    img: ['src', 'alt', 'width', 'height'],
  },
  // Comment anchors are the only class the editor persists
  allowedClasses: { span: ['gcp-cmt-anchor'] },
  allowedStyles: { '*': ALLOWED_STYLES },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

function sanitizeEditorHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), OPTIONS);
}

module.exports = { sanitizeEditorHtml };
