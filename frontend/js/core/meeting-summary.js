/**
 * Meeting Summary — the two-column table a Supervisor fills in after a meeting.
 *
 * Left: the discussion point as it was taken into the meeting (from the agenda
 * snapshot, so it never shifts under the writer when the owner reopens and
 * edits the document). Right: the summary, editable only by the supervisors
 * that point was assigned to.
 *
 * Styles are injected here rather than added to a stylesheet because
 * frontend/pages/library.html loads no dashboard-minister.css, so the
 * .preview-overlay rules the other modals rely on are simply absent there.
 */
(function () {
  'use strict';

  var cssInjected = false;
  function injectCss() {
    if (cssInjected || typeof document === 'undefined') return;
    cssInjected = true;
    var style = document.createElement('style');
    style.textContent = [
      '.ms-overlay{position:fixed;inset:0;background:rgba(17,24,39,.55);z-index:1200;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:32px 16px;}',
      '.ms-card{background:#fff;border-radius:16px;max-width:1100px;width:100%;padding:24px 26px 28px;box-shadow:0 24px 60px rgba(0,0,0,.28);}',
      '.ms-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:6px;}',
      '.ms-head h2{margin:0;font-size:20px;color:#22395a;flex:1;}',
      '.ms-close{background:none;border:none;font-size:26px;line-height:1;cursor:pointer;color:#6b7280;padding:0 4px;}',
      '.ms-meta{font-size:13px;color:#6b7280;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;}',
      '.ms-chip{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(43,68,91,.08);color:#22395a;}',
      '.ms-chip--due{background:rgba(234,88,12,.12);color:#c2410c;}',
      '.ms-chip--overdue{background:rgba(220,38,38,.12);color:#dc2626;}',
      '.ms-chip--removed{background:rgba(107,114,128,.15);color:#4b5563;}',
      '.ms-chip--unassigned{background:rgba(202,138,4,.15);color:#a16207;}',
      '.ms-note{font-size:13px;color:#6b7280;background:rgba(43,68,91,.05);border-radius:10px;padding:10px 12px;margin-bottom:14px;}',
      '.ms-table{width:100%;border-collapse:collapse;table-layout:fixed;}',
      '.ms-table th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;padding:8px 10px;border-bottom:2px solid #e5e7eb;}',
      '.ms-table td{vertical-align:top;padding:12px 10px;border-bottom:1px solid #eef1f5;}',
      '.ms-table th.ms-col,.ms-table td.ms-col{width:50%;}',
      '.ms-point-title{font-weight:700;color:#22395a;margin:0 0 6px;font-size:14px;}',
      '.ms-point-body{font-size:13px;line-height:1.6;color:#374151;}',
      '.ms-point-body p{margin:0 0 6px;}',
      '.ms-label{display:block;font-size:11px;font-weight:700;color:#6b7280;margin:8px 0 2px;text-transform:uppercase;letter-spacing:.03em;}',
      '.ms-ro{font-size:13px;line-height:1.6;color:#374151;background:rgba(43,68,91,.04);border-radius:8px;padding:10px 12px;min-height:44px;}',
      '.ms-ro--empty{color:#9ca3af;font-style:italic;}',
      '.ms-byline{font-size:12px;color:#6b7280;margin-top:6px;}',
      // The Task-field editor sizes itself for a full-width form; inside a
      // half-width table cell it only needs a few lines to start with.
      ".ms-col .se-body{min-height:96px;max-height:260px;}",
      ".ms-col .se-wrap{border-radius:8px;}",
      '.ms-rowactions{margin-top:8px;display:flex;gap:8px;align-items:center;}',
      '.ms-btn{border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#22395a;cursor:pointer;}',
      '.ms-btn:hover{background:rgba(43,68,91,.06);}',
      '.ms-btn--primary{background:#22395a;border-color:#22395a;color:#fff;}',
      '.ms-btn--primary:hover{background:#1a2c47;}',
      '.ms-btn[disabled]{opacity:.5;cursor:default;}',
      '.ms-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}',
      '.ms-empty{padding:26px 0;color:#6b7280;font-size:14px;text-align:center;}',
      '@media (max-width:760px){.ms-table,.ms-table tbody,.ms-table tr,.ms-table td{display:block;width:100%;}.ms-table thead{display:none;}.ms-table td{border-bottom:none;}.ms-table tr{border-bottom:1px solid #eef1f5;padding-bottom:10px;}}',
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

  function esc(s) {
    return (typeof escapeHtml === 'function')
      ? escapeHtml(s)
      : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
  }

  function name(full, ka) {
    return (typeof localizedName === 'function') ? localizedName(full, ka) : (full || '');
  }

  /** Days until a YYYY-MM-DD deadline; negative once it has passed. */
  function daysUntil(ymd) {
    if (!ymd) return null;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var d = new Date(ymd + 'T00:00:00'); d.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }

  function deadlineChip(ymd) {
    if (!ymd) return '';
    var days = daysUntil(ymd);
    var pretty = (typeof formatDate === 'function') ? formatDate(ymd) : ymd;
    if (days < 0) return '<span class="ms-chip ms-chip--overdue">' + esc(tr('library.summary.overdue', 'Overdue')) + '</span>';
    var label = tr('library.summary.deadline', 'Due {date}').replace('{date}', pretty);
    return '<span class="ms-chip ' + (days <= 7 ? 'ms-chip--due' : '') + '">' + esc(label) + '</span>';
  }

  /** The point as the reader saw it, rendered the way the exports render it. */
  function pointHtml(item, lang) {
    var L = (typeof GCP !== 'undefined' && GCP.DiscussionPoints)
      ? GCP.DiscussionPoints.exportLabels(lang)
      : { context: 'Discussion Point', additional: 'Additional Information' };
    var blank = (typeof GCP !== 'undefined' && GCP.DiscussionPoints)
      ? GCP.DiscussionPoints.isBlankHtml
      : function (h) { return !h; };

    var out = '<p class="ms-point-title">' + (item.position + 1) + '. ' + esc(item.topic || '') + '</p>';
    if (!blank(item.contextHtml)) {
      out += '<span class="ms-label">' + esc(L.context) + '</span>';
      out += '<div class="ms-point-body">' + item.contextHtml + '</div>';
    }
    if (!blank(item.additionalHtml)) {
      out += '<span class="ms-label">' + esc(L.additional) + '</span>';
      out += '<div class="ms-point-body">' + item.additionalHtml + '</div>';
    }
    return out;
  }

  function bylineHtml(item) {
    if (!item.lastEditedBy) return '';
    var when = (typeof formatDate === 'function' && item.lastEditedAt)
      ? formatDate(item.lastEditedAt) : '';
    return '<div class="ms-byline">' + esc(
      tr('library.summary.lastEdited', 'Last edited by {name} · {when}')
        .replace('{name}', name(item.lastEditedBy, item.lastEditedByKa))
        .replace('{when}', when)
    ) + '</div>';
  }

  function statusChips(item) {
    var out = '';
    if (item.removedFromAgenda) {
      out += '<span class="ms-chip ms-chip--removed">' + esc(tr('library.summary.removedFromAgenda', 'Removed from the agenda')) + '</span> ';
    }
    if (item.opened && !item.assignees.length) {
      out += '<span class="ms-chip ms-chip--unassigned">' + esc(tr('library.summary.unassigned', 'No responsible department head')) + '</span> ';
    } else if (item.assignees.length) {
      out += '<span class="ms-chip">' + esc(
        tr('library.summary.assignedTo', 'Responsible: {names}')
          .replace('{names}', item.assignees.map(function (a) { return name(a.fullName, a.fullNameKa); }).join(', '))
      ) + '</span> ';
    }
    return out;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * May this viewer send? Delegates to the shared rule in library-doc.js so the
   * card buttons and this modal cannot drift apart. The server re-checks.
   */
  function canSend(doc, viewer) {
    if (typeof LibraryDoc === 'undefined' || !LibraryDoc.canActAsOwner) return false;
    return LibraryDoc.canActAsOwner(doc, viewer);
  }

  /** Sending assigns work to other people, so it is always confirmed first. */
  function confirmSend(doc) {
    var msg = tr('library.summary.sendConfirm',
      'Send {n} discussion point(s) to the responsible department heads? They have one week to write their summaries.')
      .replace('{n}', String(doc.unsentCount));
    if (typeof GCP !== 'undefined' && GCP.ActionDialog && GCP.ActionDialog.confirm) {
      return GCP.ActionDialog.confirm(msg, {
        confirmLabel: tr('library.summary.send', 'Send for Meeting Summary ({n})').replace(' ({n})', ''),
      });
    }
    return Promise.resolve(typeof window === 'undefined' || window.confirm(msg));
  }

  /**
   * Send an event's unsent points out for summaries.
   *
   * Resolves to the server's report on success, or null on failure — the
   * caller re-enables its button rather than navigating.
   */
  function send(eventId) {
    return Api.post('/api/meeting-summaries/' + eventId + '/send', {})
      .then(function (out) {
        if (out.opened) {
          toast.success(tr('library.summary.sendDone', 'Sent {n} point(s) to {s} department head(s).')
            .replace('{n}', String(out.opened)).replace('{s}', String(out.supervisors)));
        } else {
          toast.warn(tr('library.summary.allSent', 'Every discussion point has already been sent.'));
        }
        if (out.unassigned) {
          toast.warn(tr('library.summary.sentUnassigned', '{n} point(s) have no responsible department head.')
            .replace('{n}', String(out.unassigned)));
        }
        return out;
      })
      .catch(function (e) {
        toast.error(tr('library.summary.sendFail', 'Sending for meeting summaries failed:') + ' ' + (e && e.message));
        return null;
      });
  }

  // ── The modal ──────────────────────────────────────────────────────────────

  async function open(eventId) {
    injectCss();
    var doc;
    try {
      doc = await Api.get('/api/meeting-summaries/' + eventId);
    } catch (e) {
      if (e && e.status === 404) { toast.warn(tr('library.summary.empty', 'No meeting agenda has been recorded for this document yet.')); return; }
      toast.error(tr('library.summary.failLoad', 'Failed to load the meeting summary:') + ' ' + (e && e.message));
      return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'ms-overlay';

    // What still has to be sent, and by whom. A viewer who cannot send is told
    // it is waiting on someone; one who can gets the button below.
    var notes = '';
    if (doc.unsentCount) {
      notes += '<div class="ms-note">' + esc(
        (doc.canSend
          ? tr('library.summary.unsent', '{n} discussion point(s) have not been sent for summaries yet.')
          : tr('library.summary.notSent', '{n} discussion point(s) are waiting for the document owner to send them.')
        ).replace('{n}', String(doc.unsentCount))
      ) + '</div>';
    } else if (!doc.canEditAny && doc.items.length) {
      notes += '<div class="ms-note">' + esc(tr('library.summary.readOnly', 'You can read this summary but not edit it.')) + '</div>';
    }

    var deadline = (doc.items.find(function (i) { return i.deadlineDate; }) || {}).deadlineDate;

    overlay.innerHTML =
      '<div class="ms-card">' +
        '<div class="ms-head">' +
          '<h2>' + esc(tr('library.summary.title', 'Meeting Summary')) + ' — ' + esc(doc.title) + '</h2>' +
          '<button class="ms-close" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="ms-meta">' +
          '<span data-progress>' + esc(tr('library.summary.progress', '{done} of {total} written')
            .replace('{done}', doc.progress.done).replace('{total}', doc.progress.total)) + '</span>' +
          deadlineChip(deadline) +
        '</div>' +
        notes +
        (doc.items.length
          ? '<table class="ms-table"><thead><tr>' +
              '<th class="ms-col">' + esc(tr('library.summary.colPoint', 'Discussion Point')) + '</th>' +
              '<th class="ms-col">' + esc(tr('library.summary.colSummary', 'Summary')) + '</th>' +
            '</tr></thead><tbody>' +
            doc.items.map(function (item, idx) {
              return '<tr data-row="' + idx + '">' +
                '<td class="ms-col">' + pointHtml(item, doc.language) + '</td>' +
                '<td class="ms-col" data-cell="' + idx + '">' + statusChips(item) +
                  '<div data-host="' + idx + '"></div>' + bylineHtml(item) +
                '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>'
          : '<div class="ms-empty">' + esc(tr('library.summary.empty', 'No meeting agenda has been recorded for this document yet.')) + '</div>') +
        '<div class="ms-foot">' +
          (doc.canSend && doc.unsentCount
            ? '<button class="ms-btn ms-btn--primary ms-btn--send" data-act="send">' + esc(
                (doc.opened
                  ? tr('library.summary.sendNew', 'Send new points ({n})')
                  : tr('library.summary.send', 'Send for Meeting Summary ({n})')
                ).replace('{n}', String(doc.unsentCount))
              ) + '</button>'
            : '') +
          '<button class="ms-btn" data-act="pdf">' + esc(tr('library.summary.exportPdf', 'Summary PDF')) + '</button>' +
          '<button class="ms-btn" data-act="word">' + esc(tr('library.summary.exportWord', 'Summary Word')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    if (typeof I18n !== 'undefined' && I18n.translateRoot) I18n.translateRoot(overlay);

    function paintProgress() {
      var el = overlay.querySelector('[data-progress]');
      if (!el) return;
      el.textContent = tr('library.summary.progress', '{done} of {total} written')
        .replace('{done}', doc.progress.done).replace('{total}', doc.progress.total);
    }

    var close = function () { overlay.remove(); };
    overlay.querySelector('.ms-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    // Mount each summary cell: an editor for rows this user owns, static
    // sanitized HTML for the rest.
    doc.items.forEach(function (item, idx) {
      var host = overlay.querySelector('[data-host="' + idx + '"]');
      if (!host) return;

      if (!item.canEdit) {
        var empty = !item.summaryHtml || !item.filled;
        host.innerHTML = '<div class="ms-ro' + (empty ? ' ms-ro--empty' : '') + '">' +
          (empty ? esc(tr('library.summary.notFilled', 'Not yet written')) : item.summaryHtml) + '</div>';
        return;
      }

      // The Task field's lightweight editor: its whole vocabulary already sits
      // inside sanitizeEditorHtml's allowlist, and GCP.RichEditor would drag in
      // track changes and comment anchors that make no sense here.
      var editorHost = document.createElement('div');
      host.appendChild(editorHost);
      var editor = window.GCP.createSimpleEditor(editorHost, {
        placeholder: tr('library.summary.placeholder', 'Write the meeting summary for this point…'),
      });
      editor.setHtml(item.summaryHtml || '');

      var actions = document.createElement('div');
      actions.className = 'ms-rowactions';
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'ms-btn ms-btn--primary';
      save.textContent = tr('library.summary.save', 'Save');
      actions.appendChild(save);
      host.appendChild(actions);

      save.addEventListener('click', async function () {
        save.disabled = true;
        try {
          var html = editor.getHtml();
          var out = await Api.put('/api/meeting-summaries/row/' + item.summaryId, {
            summaryHtml: html,
          });
          // Fold the save back into the loaded document, not just the byline:
          // the header count and both exporters read from `doc`, so leaving it
          // stale would print "not yet written" for a row just saved.
          var wasFilled = item.filled;
          item.summaryHtml = html;
          item.filled = !!out.filled;
          item.lastEditedBy = out.lastEditedBy;
          item.lastEditedByKa = out.lastEditedByKa;
          item.lastEditedAt = out.lastEditedAt;
          if (item.filled !== wasFilled && !item.removedFromAgenda) {
            doc.progress.done += item.filled ? 1 : -1;
            paintProgress();
          }
          var cell = overlay.querySelector('[data-cell="' + idx + '"]');
          var stale = cell.querySelector('.ms-byline');
          if (stale) stale.remove();
          cell.insertAdjacentHTML('beforeend', bylineHtml(item));
          toast.success(tr('library.summary.saved', 'Summary saved'));
        } catch (e) {
          toast.error(tr('library.summary.saveFail', 'Failed to save the summary:') + ' ' + (e && e.message));
        } finally {
          save.disabled = false;
        }
      });
    });

    var sendBtn = overlay.querySelector('[data-act="send"]');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        confirmSend(doc).then(function (ok) {
          if (!ok) return;
          sendBtn.disabled = true;
          send(doc.eventId).then(function (sent) {
            if (!sent) { sendBtn.disabled = false; return; }
            // Reopen on the fresh state rather than patching rows in place:
            // a send changes assignees, deadlines and every row's canEdit.
            close();
            open(doc.eventId);
          });
        });
      });
    }

    overlay.querySelector('[data-act="pdf"]').addEventListener('click', function () { exportPdf(doc); });
    overlay.querySelector('[data-act="word"]').addEventListener('click', function () { exportWord(doc); });
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  // Both build one table and hand it to the existing exporters, so neither the
  // PDF nor the Word path needs to know Meeting Summaries exist.

  function tableHtml(doc) {
    return '<table><thead><tr>' +
      '<th style="width:50%;">' + esc(tr('library.summary.colPoint', 'Discussion Point')) + '</th>' +
      '<th style="width:50%;">' + esc(tr('library.summary.colSummary', 'Summary')) + '</th>' +
      '</tr></thead><tbody>' +
      doc.items.map(function (item) {
        var summary = item.filled
          ? item.summaryHtml
          : '<p><i>' + esc(tr('library.summary.notFilled', 'Not yet written')) + '</i></p>';
        return '<tr><td>' + pointHtml(item, doc.language) + '</td><td>' + summary + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  function exportSections(doc) {
    return [{
      id: 0,
      title: tr('library.summary.title', 'Meeting Summary'),
      sectionLabel: tr('library.summary.title', 'Meeting Summary'),
      htmlContent: tableHtml(doc),
    }];
  }

  async function exportPdf(doc) {
    try {
      await LibraryDoc.exportHtmlAsPdf(doc, exportSections(doc));
    } catch (e) {
      toast.error(tr('library.export.fail', 'Export failed:') + ' ' + (e && e.message));
    }
  }

  async function exportWord(doc) {
    try {
      await LibraryDoc.exportSectionsAsDocx(doc, exportSections(doc));
    } catch (e) {
      toast.error(tr('library.export.wordFail', 'Word export failed:') + ' ' + (e && e.message));
    }
  }

  if (typeof window !== 'undefined') {
    window.GCP = window.GCP || {};
    window.GCP.MeetingSummary = {
      open: open, exportPdf: exportPdf, exportWord: exportWord,
      send: send, canSend: canSend,
    };
  }
})();
