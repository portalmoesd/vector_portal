/**
 * Pure helpers shared by the Meeting Summary route and the send path.
 *
 * Kept free of `db` so both can require it without pulling in the other's
 * side effects, and so it is unit-testable the way roles.js and sanitize.js are.
 */

// Georgia is UTC+4 and observes no DST, so meeting times are unambiguous; only
// the calendar-day arithmetic below needs the zone named.
const TBILISI_OFFSET_HOURS = 4;

/**
 * A summary counts as written when it holds something a reader would see.
 * Mirrors GCP.DiscussionPoints.isBlankHtml so client and server agree on when
 * a row is done.
 */
function isBlankHtml(html) {
  if (!html) return true;
  return String(html)
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim() === '';
}

/**
 * A DATE column as a plain YYYY-MM-DD string.
 *
 * node-postgres hands a DATE back as a Date at local midnight; letting that
 * reach JSON would turn a date into a UTC instant and, west of Greenwich, a
 * different day.
 */
function ymd(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The summary deadline: a week from the day it is sent.
 *
 * Measured from the send rather than from the meeting so supervisors always get
 * a full week, however long the owner takes to send. Anchored to Tbilisi rather
 * than the server's zone — the app runs in UTC, where anything sent after 20:00
 * UTC already belongs to the next Tbilisi day and would be dated a day early.
 */
function deadlineFromSend(now) {
  const d = now ? new Date(now) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const tb = new Date(d.getTime() + TBILISI_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const due = new Date(Date.UTC(tb.getUTCFullYear(), tb.getUTCMonth(), tb.getUTCDate() + 7));
  return `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())}`;
}

/**
 * May this user act as the Document Owner of this event — record its meeting
 * agenda, and send it out for summaries?
 *
 * Three ways in:
 *   - the owner themself, which covers a Deputy, Supervisor or Senior Editor
 *     document since the owner *is* events.document_submitter_id;
 *   - PROTOCOL, but only where the document submitter role is MINISTER. The
 *     Minister is a read-only role that never logs in, so without this nobody
 *     at all could record or send a Minister's document. Protocol's authority
 *     here is not general: on a Deputy's document it is no wider than anyone
 *     else's. It needs no Minister lookup — PROTOCOL is a global role with no
 *     link to a particular Minister row, so the submitter role is the whole
 *     test.
 *   - ADMIN, as the fallback for a document whose owner has left or is away.
 *
 * `event` needs only { document_submitter_id, document_submitter_role }.
 */
function canActAsOwner(user, event) {
  if (!user || !event) return false;
  if (user.role === 'ADMIN') return true;
  if (event.document_submitter_id === user.id) return true;
  return user.role === 'PROTOCOL' && event.document_submitter_role === 'MINISTER';
}

/**
 * Normalise the points an owner's export offers into agenda rows.
 *
 * Drops anything without a section or a dp id, drops points belonging to some
 * other document, de-duplicates repeated (sectionId, dpId) pairs — a duplicate
 * would collide on the table's unique key mid-upsert — and renumbers positions
 * so the agenda's order is its own, independent of any later reordering of the
 * document.
 *
 * `allowedSectionIds` is the event's own sections; pass null to skip the check.
 */
function normalizeAgendaPoints(points, allowedSectionIds) {
  // An explicit allowlist is always enforced, empty included: an event with no
  // sections must accept no points, not every point. Pass null only where
  // there is genuinely nothing to check against.
  const allowed = allowedSectionIds == null
    ? null
    : (allowedSectionIds instanceof Set ? allowedSectionIds : new Set(allowedSectionIds));
  const out = [];
  const seen = new Set();
  (points || []).forEach((p) => {
    const sectionId = parseInt(p && p.sectionId, 10);
    const dpId = p && p.dpId ? String(p.dpId).slice(0, 60) : '';
    if (!sectionId || !dpId) return;
    if (allowed && !allowed.has(sectionId)) return;
    const key = `${sectionId}:${dpId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      sectionId,
      dpId,
      position: out.length,
      topic: String(p.topic == null ? '' : p.topic).slice(0, 2000),
      contextHtml: p.contextHtml || '',
      additionalHtml: p.additionalHtml || '',
    });
  });
  return out;
}

/** The key form the soft-remove sweep compares against. */
function agendaKeys(points) {
  return points.map((p) => `${p.sectionId}:${p.dpId}`);
}

module.exports = {
  isBlankHtml, ymd, deadlineFromSend, canActAsOwner, normalizeAgendaPoints, agendaKeys,
};
