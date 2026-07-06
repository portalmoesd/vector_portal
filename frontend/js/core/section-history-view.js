/**
 * Shared section-visibility + section-history rendering.
 *
 * Two concerns that used to live inside individual pages are consolidated here so
 * there is a single source of truth:
 *   - SectionVisibility: "which sections may this user see" — the same rule the
 *     Minister dashboard uses (was dashboard-minister.js isOwnSection/seesAllSections),
 *     parameterised on the user object (from Api.getUser()).
 *   - SectionHistory.renderTimeline: the role-grouped ".sh-timeline" markup the editor
 *     renders for a section's history (was inline in editor.js loadHistory).
 *
 * Depends only on globals the core scripts already provide: I18n, escapeHtml,
 * roleLabel (utils.js). No DOM access — both APIs are pure.
 */
(function () {
  // ── Section visibility ──────────────────────────────────────────────────────
  // A section the user is directly responsible for: their department is on it, a
  // RECEIVING_* step they hold, or they curate it.
  function isOwnSection(user, s) {
    if (!user || !s) return false;
    if (s.departmentIds && s.departmentIds.includes(user.departmentId)) return true;
    if (s.userEffectiveRole && s.userEffectiveRole.startsWith('RECEIVING_')
        && s.chain && s.chain.includes(s.userEffectiveRole)) return true;
    if (s.userEffectiveRole === 'CURATOR') return true;
    return false;
  }

  // True when the viewer can see the whole document (every section): the document
  // submitter/owner, the Minister (top role — sees every document), the responsible
  // deputy, any deputy (matches the editor), or a supervisor linked to the owner
  // deputy who also participates here.
  function seesAllSections(user, grid) {
    if (!user || !grid) return false;
    if (grid.documentSubmitterId === user.id) return true;
    if (user.role === 'MINISTER') return true;
    if (grid.deputyId && grid.deputyId === user.id) return true;
    if (user.role === 'DEPUTY') return true;
    const own = (grid.sections || []).filter(s => isOwnSection(user, s));
    return !!(grid.viewerLinkedToOwnerDeputy && own.length > 0);
  }

  function visibleSectionsFor(user, grid) {
    const all = (grid && grid.sections) || [];
    return seesAllSections(user, grid) ? all : all.filter(s => isOwnSection(user, s));
  }

  // ── History timeline ────────────────────────────────────────────────────────
  const HISTORY_STAGES = [
    { role: 'COLLABORATOR' },
    { role: 'SUPER_COLLABORATOR' },
    { role: 'CURATOR' },
    { role: 'SUPERVISOR' },
    { role: 'DEPUTY' },
    { role: 'RECEIVING_SUPER_COLLABORATOR', labelKey: 'editor.history.stage.scReview' },
    { role: 'RECEIVING_SUPERVISOR', labelKey: 'editor.history.stage.svReview' },
  ];

  function stageLabel(stage) {
    if (stage.labelKey) return I18n.tr(stage.labelKey);
    return roleLabel(stage.role);
  }

  function formatHistoryDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const locale = (typeof I18n !== 'undefined' && I18n.getLocale && I18n.getLocale() === 'ka') ? 'ka-GE' : 'en-GB';
    return d.toLocaleString(locale, {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function actionColors() {
    return {
      saved:           { bg: '#ede9fe', color: '#5b21b6', label: I18n.tr('editor.history.action.saved') },
      submitted:       { bg: '#dbeafe', color: '#1d4ed8', label: I18n.tr('editor.history.action.submitted') },
      approved:        { bg: '#dcfce7', color: '#15803d', label: I18n.tr('editor.history.action.approved') },
      returned:        { bg: '#fee2e2', color: '#b91c1c', label: I18n.tr('editor.history.action.returned') },
      asked_to_return: { bg: '#fef3c7', color: '#92400e', label: I18n.tr('editor.history.action.askedToReturn') },
      pushed:          { bg: '#e0e7ff', color: '#4338ca', label: I18n.tr('editor.history.action.pushed') },
      pulled:          { bg: '#e0e7ff', color: '#4338ca', label: I18n.tr('editor.history.action.pulled') },
    };
  }

  // Build the role-grouped ".sh-timeline" HTML for a section's history array.
  // Returns '' for empty input (caller renders its own empty state).
  function renderTimeline(history) {
    if (!history || history.length === 0) return '';
    const ACTION_COLORS = actionColors();

    // Group by role
    const byRole = {};
    for (const h of history) {
      const r = h.userRole || 'UNKNOWN';
      if (!byRole[r]) byRole[r] = [];
      byRole[r].push(h);
    }

    // Collapse consecutive saves by same user
    function collapseEntries(entries) {
      const collapsed = [];
      for (const ev of entries) {
        const last = collapsed[collapsed.length - 1];
        if (last && last.action === 'saved' && ev.action === 'saved' && last.userName === ev.userName) {
          last.actedAt = ev.actedAt;
          last._count = (last._count || 1) + 1;
        } else {
          collapsed.push({ ...ev });
        }
      }
      return collapsed;
    }

    // Build ordered stages — only show stages that have entries
    const stageOrder = HISTORY_STAGES.map(s => s.role);
    const orderedRoles = [];
    for (const stage of HISTORY_STAGES) {
      if (byRole[stage.role]) orderedRoles.push(stage);
    }
    for (const role of Object.keys(byRole)) {
      if (!stageOrder.includes(role)) {
        orderedRoles.push({ role });
      }
    }

    return '<div class="sh-timeline">' + orderedRoles.map(stage => {
      const entries = collapseEntries(byRole[stage.role]);
      const eventsHtml = entries.map(h => {
        const ac = ACTION_COLORS[h.action] || { bg: '#f1f5f9', color: '#475569', label: h.action };
        const actor = escapeHtml(h.userName || I18n.tr('editor.history.unknownUser'));
        const date = formatHistoryDate(h.actedAt);
        const label = h.action === 'saved' && h._count > 1
          ? `${ac.label} (×${h._count})` : ac.label;

        if (h.action === 'returned' || h.action === 'asked_to_return') {
          const noteHtml = h.note
            ? escapeHtml(h.note)
            : `<span class="sh-return-note__empty">${escapeHtml(I18n.tr('editor.history.noComment'))}</span>`;
          return `<div class="sh-event">
            <span class="sh-actor">${actor}</span>
            <details class="sh-return-details${h.action === 'asked_to_return' ? ' sh-return-details--ask' : ''}">
              <summary>${escapeHtml(label)}</summary>
              <div class="sh-return-note">${noteHtml}</div>
            </details>
            <span class="sh-date">${date}</span>
          </div>`;
        }

        return `<div class="sh-event">
          <span class="sh-actor">${actor}</span>
          <span class="sh-action-tag" style="background:${ac.bg};color:${ac.color}">${escapeHtml(label)}</span>
          <span class="sh-date">${date}</span>
        </div>`;
      }).join('');

      return `<div class="sh-stage">
        <div class="sh-dot"></div>
        <div class="sh-body">
          <div class="sh-stage-label">${escapeHtml(stageLabel(stage).toUpperCase())}</div>
          <div class="sh-events">${eventsHtml}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  window.SectionVisibility = { isOwnSection, seesAllSections, visibleSectionsFor };
  window.SectionHistory = { renderTimeline };
})();
