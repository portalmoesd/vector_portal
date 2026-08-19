/**
 * GCP Discussion Points editor — the section editor for documents whose
 * event.document_type is DISCUSSION_POINTS.
 *
 * A section is authored as an ordered list of discussion points; each point has
 * a plain-text Topic and two rich bodies, Context and Additional Information.
 * The whole list still serialises to the one `section_content.html_content`
 * string every other part of the system already reads, so the workflow (save,
 * submit, approve, return, history, comments, optimistic locking) is untouched.
 *
 * Persisted markup — structure carried by data attributes only, never classes,
 * because server/helpers/sanitize.js strips every class but the comment anchor:
 *
 *   <div data-dp-id="dp-k3n1x8">
 *     <h3 data-dp-field="topic">Trade turnover</h3>
 *     <div data-dp-field="context"><p>…</p></div>
 *     <div data-dp-field="additional"><p>…</p></div>
 *   </div>
 *
 * `GCP.DiscussionPointsEditor(opts)` takes the same option bag as
 * GCP.RichEditor and returns the same surface, so the section pages swap the
 * factory and change nothing else. Internally it owns one GCP.RichEditor per
 * rich field: separate contenteditable roots mean the browser cannot merge
 * across a field boundary, so track changes, paste and Backspace behave exactly
 * as they do in a normal section without any guard code.
 *
 * The pure serialisation helpers are also exported for Node (`module.exports`)
 * so they can be unit-tested without a DOM.
 */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  var FIELDS = ['context', 'additional'];
  var EMPTY_BODY = '<p><br></p>';

  // Export-time field labels follow the *document's* language (events.language),
  // not the reader's UI locale — a Georgian brief must read as Georgian
  // wherever it is opened. I18n only ships en/ka, hence the local table.
  var EXPORT_LABELS = {
    KA: { context: 'განსახილველი საკითხი', additional: 'დამატებითი ინფორმაცია', point: 'საკითხი' },
    EN: { context: 'Discussion Point', additional: 'Additional Information', point: 'Point' },
    RU: { context: 'Обсуждаемый вопрос', additional: 'Дополнительная информация', point: 'Вопрос' },
  };

  function exportLabels(lang) {
    return EXPORT_LABELS[String(lang || '').toUpperCase()] || EXPORT_LABELS.KA;
  }

  // ── Pure helpers (DOM-free — safe to require() in Node) ────────────────────

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Serialise points to the persisted markup.
   *
   * Determinism matters: the section pages autosave by comparing getHtml()
   * against the last saved string every 20s, so a serialiser that reordered
   * attributes or regenerated ids would save (and write a section_history row)
   * forever. Ids are assigned once, at parse or add time, and attribute order
   * is fixed here.
   *
   * @param {Array<{id:string, topic:string, contextHtml:string, additionalHtml:string}>} points
   * @returns {string} '' for an empty list — the same representation an empty
   *   free-form section already has.
   */
  function serializePoints(points) {
    if (!points || !points.length) return '';
    return points.map(function (p) {
      var out = '<div data-dp-id="' + escapeText(p.id) + '">';
      out += '<h3 data-dp-field="topic">' + escapeText(p.topic) + '</h3>';
      out += '<div data-dp-field="context">' + (p.contextHtml || EMPTY_BODY) + '</div>';
      out += '<div data-dp-field="additional">' + (p.additionalHtml || EMPTY_BODY) + '</div>';
      return out + '</div>';
    }).join('');
  }

  /** True when a rich body holds nothing a reader would see. */
  function isBlankHtml(html) {
    if (!html) return true;
    return String(html)
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim() === '';
  }

  /** Picker/export label for a point, falling back to "Point N". */
  function topicLabel(point, lang, index) {
    var topic = point && point.topic ? String(point.topic).trim() : '';
    if (topic) return topic;
    return exportLabels(lang).point + ' ' + ((index == null ? 0 : index) + 1);
  }

  /**
   * Presentation HTML for export and preview.
   *
   * Emits headings and labelled prose rather than the storage scaffolding, so
   * html2pdf renders it directly and docx-export's parseBlock maps <h3> to
   * Heading 3 and recurses through the <div>s — neither exporter needs to know
   * discussion points exist. Track-change markup and comment anchors are
   * carried through verbatim so the Word path still emits native revisions and
   * comments. Numbering runs 1..n over the *selected* points.
   */
  function toExportHtml(points, lang) {
    if (!points || !points.length) return '';
    var L = exportLabels(lang);
    return points.map(function (p, i) {
      var out = '<h3 style="font-size:12pt;font-weight:bold;margin:14px 0 4px;">' +
        (i + 1) + '. ' + escapeText(topicLabel(p, lang, i)) + '</h3>';
      if (!isBlankHtml(p.contextHtml)) {
        out += '<p style="margin:8px 0 2px;"><b>' + escapeText(L.context) + '</b></p>';
        out += '<div>' + p.contextHtml + '</div>';
      }
      if (!isBlankHtml(p.additionalHtml)) {
        out += '<p style="margin:8px 0 2px;"><b>' + escapeText(L.additional) + '</b></p>';
        out += '<div>' + p.additionalHtml + '</div>';
      }
      return out;
    }).join('');
  }

  // ── Parsing (needs a DOM) ─────────────────────────────────────────────────

  var _idSeq = 0;
  function newPointId() {
    _idSeq += 1;
    return 'dp-' + Date.now().toString(36) + _idSeq.toString(36);
  }

  /**
   * Parse persisted markup into points, repairing anything unexpected.
   *
   * Nothing is ever discarded:
   *  - HTML with no cards at all (a legacy free-form section, or a document
   *    whose type was changed) becomes one point whose Context is the whole
   *    input;
   *  - stray nodes between cards are appended to the previous point's
   *    Additional Information, or the first point's Context if none precedes;
   *  - missing or duplicate ids are regenerated.
   */
  function parsePoints(html) {
    var root = document.createElement('div');
    root.innerHTML = html || '';

    var cards = root.querySelectorAll(':scope > [data-dp-id]');
    if (!cards.length) {
      var body = (html || '').trim();
      if (!body) return [];
      return [{ id: newPointId(), topic: '', contextHtml: body, additionalHtml: '' }];
    }

    var points = [];
    var seen = {};
    var stray = [];

    Array.prototype.forEach.call(root.childNodes, function (node) {
      if (node.nodeType === 1 && node.hasAttribute('data-dp-id')) {
        var id = node.getAttribute('data-dp-id');
        if (!id || seen[id]) id = newPointId();
        seen[id] = true;

        var topicEl = node.querySelector('[data-dp-field="topic"]');
        points.push({
          id: id,
          // Topic is plain text by contract; strip any markup that reached it
          // (a paste, or content folded in by an earlier repair).
          topic: topicEl ? (topicEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
          contextHtml: fieldHtml(node, 'context'),
          additionalHtml: fieldHtml(node, 'additional'),
        });
        return;
      }
      // Anything outside a card: keep it, attached to the nearest point.
      var frag = node.nodeType === 1 ? node.outerHTML : (node.textContent || '').trim();
      if (frag) stray.push(frag);
      if (stray.length && points.length) {
        points[points.length - 1].additionalHtml += stray.join('');
        stray = [];
      }
    });

    if (stray.length) {
      if (points.length) points[0].contextHtml = stray.join('') + points[0].contextHtml;
      else points.push({ id: newPointId(), topic: '', contextHtml: stray.join(''), additionalHtml: '' });
    }
    return points;
  }

  function fieldHtml(cardEl, name) {
    var el = cardEl.querySelector('[data-dp-field="' + name + '"]');
    return el ? el.innerHTML : '';
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // Injected on first mount, mirroring simple-editor.js / editor-core.js.
  // The overrides matter: GCP.RichEditor styles its body as a standalone A4
  // sheet (flex:0 0 794px; min-height:1123px; padding:96px on an #e8eaed
  // backdrop). Inside a card that has to collapse to an inline box, so the
  // rules below win on specificity rather than editor-core.css being edited.

  var _cssInjected = false;
  function injectCss() {
    if (_cssInjected || typeof document === 'undefined') return;
    _cssInjected = true;
    var style = document.createElement('style');
    style.textContent = [
      '.gcp-dp-wrap{display:flex;flex-direction:column;min-height:0;}',
      '.gcp-dp-dock{position:sticky;top:0;z-index:5;}',
      '.gcp-dp-dock:empty{display:none;}',
      '.gcp-dp-root{padding:16px 18px 28px;overflow-y:auto;}',
      '.gcp-dp-hint{font-size:13px;color:var(--text-muted,#6b7280);margin:0 0 14px;}',
      '.gcp-dp-empty{font-size:14px;color:var(--text-muted,#6b7280);padding:18px 0;}',
      /* Card */
      '.gcp-dp-card{border:1px solid var(--border-color,#e2e6ec);border-radius:12px;background:var(--bg-card,#fff);margin-bottom:16px;overflow:hidden;}',
      '.gcp-dp-card-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(43,68,91,.04);border-bottom:1px solid var(--border-color,#e2e6ec);}',
      '.gcp-dp-card-num{font-size:12px;font-weight:700;color:#22395a;min-width:20px;}',
      '.gcp-dp-card-actions{margin-left:auto;display:flex;gap:4px;}',
      '.gcp-dp-card-actions button{background:none;border:none;cursor:pointer;padding:3px 7px;border-radius:6px;font-size:12px;line-height:1;color:#22395a;}',
      '.gcp-dp-card-actions button:hover{background:rgba(43,68,91,.10);}',
      '.gcp-dp-card-actions button[disabled]{opacity:.35;cursor:default;}',
      '.gcp-dp-card-actions button.gcp-dp-del:hover{background:rgba(220,38,38,.12);color:#dc2626;}',
      '.gcp-dp-card-body{padding:12px 14px 14px;}',
      '.gcp-dp-label{display:block;font-size:12px;font-weight:700;color:#22395a;margin:12px 0 5px;}',
      '.gcp-dp-label:first-child{margin-top:0;}',
      '.gcp-dp-topic{width:100%;box-sizing:border-box;font-size:15px;font-weight:600;padding:8px 10px;border:1px solid var(--border-color,#dde2e9);border-radius:8px;background:var(--bg-input,#fff);color:var(--text,#1f2a37);}',
      '.gcp-dp-topic:focus{outline:none;border-color:#0a84ff;}',
      '.gcp-dp-topic[disabled]{background:rgba(43,68,91,.04);}',
      '.gcp-dp-add{margin-top:4px;}',
      /* Collapse the RichEditor page sheet down to an inline field box. */
      '.gcp-dp-field .gcp-re-wrap{border:1px solid var(--border-color,#dde2e9);border-radius:8px;overflow:hidden;}',
      '.gcp-dp-field .gcp-re-toolbar{display:none;}',
      '.gcp-dp-field .gcp-re-content-row{background:transparent;padding:0;min-height:0;display:block;overflow:visible;}',
      '.gcp-dp-field .gcp-re-body{flex:1 1 auto;width:auto;min-height:96px;padding:10px 12px;box-shadow:none;background:var(--bg-input,#fff);}',
      '.gcp-dp-field .gcp-re-margin{width:0;}',
      /* The docked toolbar is the only visible one. */
      '.gcp-dp-dock .gcp-re-toolbar{display:flex;}',
      /* Fullscreen would reparent a single field to document.body, away from */
      /* the shared dock its toolbar lives in — meaningless for a card list.  */
      '.gcp-dp-dock .gcp-re-btn--fullscreen,.gcp-dp-dock .gcp-re-sep--fullscreen{display:none;}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function tr(key, fallback) {
    try {
      if (typeof I18n !== 'undefined' && I18n.tr) {
        var v = I18n.tr(key);
        if (v && v !== key) return v;
      }
    } catch (_) { /* I18n not loaded (tests) */ }
    return fallback;
  }

  // ── The editor ────────────────────────────────────────────────────────────

  function DiscussionPointsEditor(opts) {
    opts = opts || {};
    injectCss();

    var readOnly = !!opts.readOnly;
    var cards = [];               // { id, topicInput, editors: {context, additional}, el }
    var storedComments = [];      // last setComments() payload, unfiltered
    var dockedToolbar = null;     // toolbar currently living in the dock

    var wrap = document.createElement('div');
    wrap.className = 'gcp-dp-wrap';

    var dock = document.createElement('div');
    dock.className = 'gcp-dp-dock';

    var root = document.createElement('div');
    root.className = 'gcp-dp-root';

    var hint = document.createElement('p');
    hint.className = 'gcp-dp-hint';
    hint.textContent = tr('editor.dp.sectionHint', 'This document is composed of discussion points.');

    var list = document.createElement('div');
    list.className = 'gcp-dp-list';

    var emptyEl = document.createElement('div');
    emptyEl.className = 'gcp-dp-empty';
    emptyEl.textContent = readOnly
      ? tr('editor.dp.emptyReadonly', 'No discussion points have been added yet.')
      : tr('editor.dp.empty', 'No discussion points yet.');

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-outline gcp-dp-add';
    addBtn.textContent = tr('editor.dp.add', '+ Add discussion point');
    if (readOnly) addBtn.style.display = 'none';
    addBtn.addEventListener('click', function () {
      var card = buildCard({ id: newPointId(), topic: '', contextHtml: '', additionalHtml: '' });
      cards.push(card);
      list.appendChild(card.el);
      renumber();
      card.topicInput.focus();
    });

    root.appendChild(hint);
    root.appendChild(list);
    root.appendChild(emptyEl);
    root.appendChild(addBtn);
    wrap.appendChild(dock);
    wrap.appendChild(root);
    opts.container.innerHTML = '';
    opts.container.appendChild(wrap);

    // ── Toolbar docking ──────────────────────────────────────────────────────
    // Each field editor renders its own toolbar; showing all of them would put
    // two toolbars on every point. Instead the focused field's toolbar is moved
    // into a single sticky dock — the same trick editor-all.js uses to dock the
    // focused section's toolbar.

    function dockToolbar(editor) {
      if (readOnly || !editor || !editor.toolbarEl || dockedToolbar === editor.toolbarEl) return;
      undockToolbar();
      dockedToolbar = editor.toolbarEl;
      dock.appendChild(dockedToolbar);
    }

    function undockToolbar() {
      if (!dockedToolbar) return;
      var owner = dockedToolbar._gcpDpOwner;
      if (owner && owner.wrapEl) owner.wrapEl.insertBefore(dockedToolbar, owner.wrapEl.firstChild);
      dockedToolbar = null;
    }

    // ── Cards ────────────────────────────────────────────────────────────────

    function buildCard(point) {
      var card = { id: point.id, editors: {}, el: null, topicInput: null };

      var el = document.createElement('div');
      el.className = 'gcp-dp-card';
      el.setAttribute('data-dp-card-id', point.id);

      var head = document.createElement('div');
      head.className = 'gcp-dp-card-head';
      var num = document.createElement('span');
      num.className = 'gcp-dp-card-num';
      head.appendChild(num);
      card.numEl = num;

      if (!readOnly) {
        var actions = document.createElement('div');
        actions.className = 'gcp-dp-card-actions';
        var up = mkBtn('▲', tr('editor.dp.moveUp', 'Move up'), function () { movePoint(card, -1); });
        var down = mkBtn('▼', tr('editor.dp.moveDown', 'Move down'), function () { movePoint(card, 1); });
        var del = mkBtn('✕', tr('editor.dp.delete', 'Delete discussion point'), function () { deletePoint(card); });
        up.classList.add('gcp-dp-up');
        down.classList.add('gcp-dp-down');
        del.classList.add('gcp-dp-del');
        actions.appendChild(up); actions.appendChild(down); actions.appendChild(del);
        head.appendChild(actions);
        card.upBtn = up; card.downBtn = down;
      }
      el.appendChild(head);

      var body = document.createElement('div');
      body.className = 'gcp-dp-card-body';

      body.appendChild(mkLabel(tr('editor.dp.topic', 'Discussion Point Title')));
      var topic = document.createElement('input');
      topic.type = 'text';
      topic.className = 'gcp-dp-topic';
      topic.value = point.topic || '';
      topic.placeholder = tr('editor.dp.topicPlaceholder', 'Enter the title…');
      topic.disabled = readOnly;
      body.appendChild(topic);
      card.topicInput = topic;

      FIELDS.forEach(function (name) {
        body.appendChild(mkLabel(tr('editor.dp.' + name, name)));
        var host = document.createElement('div');
        host.className = 'gcp-dp-field';
        host.setAttribute('data-dp-host', name);
        body.appendChild(host);

        var editor = GCP.RichEditor({
          container: host,
          initialHtml: name === 'context' ? point.contextHtml : point.additionalHtml,
          authorName: opts.authorName,
          sectionTitle: opts.sectionTitle,
          readOnly: readOnly,
          onCommentsClick: opts.onCommentsClick,
          onDeleteComment: opts.onDeleteComment,
          onReplyComment: opts.onReplyComment,
        });
        if (editor.toolbarEl) editor.toolbarEl._gcpDpOwner = editor;
        if (editor.el) {
          editor.el.addEventListener('focusin', function () { dockToolbar(editor); });
        }
        card.editors[name] = editor;
      });

      el.appendChild(body);
      card.el = el;
      return card;
    }

    function mkBtn(glyph, title, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    }

    function mkLabel(text) {
      var l = document.createElement('label');
      l.className = 'gcp-dp-label';
      l.textContent = text;
      return l;
    }

    function renumber() {
      cards.forEach(function (c, i) {
        c.numEl.textContent = String(i + 1);
        if (c.upBtn) c.upBtn.disabled = i === 0;
        if (c.downBtn) c.downBtn.disabled = i === cards.length - 1;
      });
      emptyEl.style.display = cards.length ? 'none' : '';
    }

    function movePoint(card, delta) {
      var i = cards.indexOf(card);
      var j = i + delta;
      if (i < 0 || j < 0 || j >= cards.length) return;
      cards.splice(i, 1);
      cards.splice(j, 0, card);
      // Move the node rather than rebuilding it, so the field editors keep
      // their undo stacks, tracked changes and balloons.
      if (j >= cards.length - 1) list.appendChild(card.el);
      else list.insertBefore(card.el, cards[j + 1].el);
      renumber();
    }

    function deletePoint(card) {
      var run = function () {
        var i = cards.indexOf(card);
        if (i < 0) return;
        cards.splice(i, 1);
        FIELDS.forEach(function (n) {
          var ed = card.editors[n];
          if (ed && ed.toolbarEl === dockedToolbar) dockedToolbar = null;
          if (ed && ed.destroy) ed.destroy();
        });
        card.el.remove();
        renumber();
      };
      var msg = tr('editor.dp.confirmDelete', 'Delete this discussion point and all of its content?');
      if (typeof GCP !== 'undefined' && GCP.ActionDialog && GCP.ActionDialog.confirm) {
        GCP.ActionDialog.confirm(msg, { confirmLabel: tr('common.delete', 'Delete'), confirmColor: '#dc2626' })
          .then(function (ok) { if (ok) run(); });
      } else if (typeof window === 'undefined' || window.confirm(msg)) {
        run();
      }
    }

    // ── Public surface (mirrors GCP.RichEditor) ──────────────────────────────

    function getPoints() {
      return cards.map(function (c) {
        return {
          id: c.id,
          topic: c.topicInput.value.trim(),
          contextHtml: c.editors.context.getHtml(),
          additionalHtml: c.editors.additional.getHtml(),
        };
      });
    }

    function getHtml() {
      // Drop points the author left completely empty so an untouched card
      // never persists — matches how an empty free-form section stays ''.
      return serializePoints(getPoints().filter(function (p) {
        return p.topic || !isBlankHtml(p.contextHtml) || !isBlankHtml(p.additionalHtml);
      }));
    }

    function getCleanHtml() {
      return serializePoints(cards.map(function (c) {
        return {
          id: c.id,
          topic: c.topicInput.value.trim(),
          contextHtml: c.editors.context.getCleanHtml(),
          additionalHtml: c.editors.additional.getCleanHtml(),
        };
      }));
    }

    function setHtml(html) {
      cards.forEach(function (c) {
        FIELDS.forEach(function (n) { if (c.editors[n].destroy) c.editors[n].destroy(); });
      });
      cards = [];
      dockedToolbar = null;
      list.innerHTML = '';
      parsePoints(html).forEach(function (p) {
        var card = buildCard(p);
        cards.push(card);
        list.appendChild(card.el);
      });
      renumber();
      if (storedComments.length) setComments(storedComments);
    }

    function eachEditor(fn) {
      cards.forEach(function (c) { FIELDS.forEach(function (n) { fn(c.editors[n], c, n); }); });
    }

    /** Anchor ids currently rendered anywhere in this section. */
    function presentAnchorIds() {
      var present = {};
      eachEditor(function (ed) {
        if (!ed.el) return;
        Array.prototype.forEach.call(
          ed.el.querySelectorAll('.gcp-cmt-anchor[data-cmt-anchor-id]'),
          function (span) { present[span.getAttribute('data-cmt-anchor-id')] = true; }
        );
      });
      return present;
    }

    /**
     * Hand each field editor only the comments anchored inside it.
     *
     * A field editor renders a balloon for every comment it is given, whether
     * or not it can find the anchor, so passing the whole section's list to all
     * of them would draw each comment once per field.
     */
    function setComments(comments) {
      storedComments = comments || [];
      eachEditor(function (ed) {
        if (!ed.el) return;
        var mine = {};
        Array.prototype.forEach.call(
          ed.el.querySelectorAll('.gcp-cmt-anchor[data-cmt-anchor-id]'),
          function (span) { mine[span.getAttribute('data-cmt-anchor-id')] = true; }
        );
        var roots = {};
        var subset = storedComments.filter(function (c) {
          if (c.parent_id) return false;
          if (!c.anchor_id || !mine[c.anchor_id]) return false;
          roots[c.id] = true;
          return true;
        });
        storedComments.forEach(function (c) {
          if (c.parent_id && roots[c.parent_id]) subset.push(c);
        });
        ed.setComments(subset);
      });
    }

    /**
     * Comments whose anchor no longer exists anywhere in the section.
     *
     * Computed here rather than delegated: each field editor only sees its own
     * anchors, so asking them individually would report every *other* field's
     * comments as orphaned — and the pages delete whatever this returns on the
     * next save. Same root+replies rule as GCP.RichEditor.
     */
    function getOrphanedCommentIds() {
      var present = presentAnchorIds();
      var orphanRoots = {};
      storedComments.forEach(function (c) {
        if (!c.parent_id && c.anchor_id && !present[c.anchor_id]) orphanRoots[c.id] = true;
      });
      var ids = Object.keys(orphanRoots).map(function (k) {
        // Ids come back as object keys (strings); return the original values.
        return storedComments.filter(function (c) { return String(c.id) === k; })[0].id;
      });
      storedComments.forEach(function (c) {
        if (c.parent_id && orphanRoots[c.parent_id]) ids.push(c.id);
      });
      return ids;
    }

    function removeCommentAnchor(anchorId) {
      eachEditor(function (ed) { ed.removeCommentAnchor(anchorId); });
    }

    function destroy() {
      undockToolbar();
      eachEditor(function (ed) { if (ed.destroy) ed.destroy(); });
      cards = [];
      list.innerHTML = '';
    }

    function focus() {
      if (cards.length) cards[0].topicInput.focus();
      else addBtn.focus();
    }

    // Initial render.
    parsePoints(opts.initialHtml).forEach(function (p) {
      var card = buildCard(p);
      cards.push(card);
      list.appendChild(card.el);
    });
    renumber();

    return {
      getHtml: getHtml,
      getCleanHtml: getCleanHtml,
      setHtml: setHtml,
      setComments: setComments,
      getOrphanedCommentIds: getOrphanedCommentIds,
      removeCommentAnchor: removeCommentAnchor,
      destroy: destroy,
      focus: focus,
      el: root,
      toolbarEl: dock,
      wrapEl: wrap,
      // Fan-outs so anything reaching for the RichEditor surface still works.
      hasTrackedChanges: function () {
        var any = false;
        eachEditor(function (ed) { if (ed.hasTrackedChanges && ed.hasTrackedChanges()) any = true; });
        return any;
      },
      acceptAllChanges: function () { eachEditor(function (ed) { if (ed.acceptAllChanges) ed.acceptAllChanges(); }); },
      rejectAllChanges: function () { eachEditor(function (ed) { if (ed.rejectAllChanges) ed.rejectAllChanges(); }); },
      setCommentsActive: function (a) { eachEditor(function (ed) { if (ed.setCommentsActive) ed.setCommentsActive(a); }); },
      setCommentsBadge: function (n) { eachEditor(function (ed) { if (ed.setCommentsBadge) ed.setCommentsBadge(n); }); },
      toggleFullscreen: function () { /* per-field fullscreen is meaningless here */ },
      // Discussion-point specifics.
      getPoints: getPoints,
    };
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  var api = {
    serializePoints: serializePoints,
    parsePoints: parsePoints,
    toExportHtml: toExportHtml,
    topicLabel: topicLabel,
    isBlankHtml: isBlankHtml,
    exportLabels: exportLabels,
    newPointId: newPointId,
  };

  if (typeof window !== 'undefined') {
    window.GCP = window.GCP || {};
    window.GCP.DiscussionPointsEditor = DiscussionPointsEditor;
    window.GCP.DiscussionPoints = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
