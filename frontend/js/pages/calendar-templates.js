/**
 * Calendar Templates card — thin wrapper around the shared TemplatesManager
 * (frontend/js/core/templates-manager.js), which owns the list rendering and
 * the editor modal. Any user who can create events can also manage their own
 * templates; the Default Template is shown but cannot be deleted.
 */
(async function () {
  if (!window.TemplatesManager || !TemplatesManager.canManage()) return;

  const card = document.getElementById('templatesCard');
  const container = document.getElementById('templatesContainer');
  const createBtn = document.getElementById('createTemplateBtn');
  if (!card || !container) return;

  card.style.display = '';
  try {
    await TemplatesManager.mount(container, { createBtn });
  } catch (e) {
    container.innerHTML = `<div class="msg msg-error">${escapeHtml(e.message)}</div>`;
  }
})();
