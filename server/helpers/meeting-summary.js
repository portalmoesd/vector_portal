/**
 * Pure helpers shared by the Meeting Summary route and its scheduler.
 *
 * Kept free of `db` and of any timer so both can require it without pulling in
 * the other's side effects, and so it is unit-testable the way roles.js and
 * sanitize.js are.
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

/** When a meeting's summary task becomes due: one hour after the meeting. */
function dueAt(eventDateTime) {
  if (!eventDateTime) return null;
  const d = new Date(eventDateTime);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 60 * 60 * 1000);
}

/**
 * The summary deadline: the meeting's Tbilisi calendar day plus seven.
 *
 * Anchored to Tbilisi rather than the server's zone — the app runs in UTC,
 * where a meeting held after midnight Tbilisi time falls on the previous
 * calendar day and would be given a deadline a day early.
 */
function deadlineFromMeeting(eventDateTime) {
  if (!eventDateTime) return null;
  const d = new Date(eventDateTime);
  if (Number.isNaN(d.getTime())) return null;
  const tb = new Date(d.getTime() + TBILISI_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const due = new Date(Date.UTC(tb.getUTCFullYear(), tb.getUTCMonth(), tb.getUTCDate() + 7));
  return `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())}`;
}

/**
 * Normalise the points an owner's export offers into agenda rows.
 *
 * Drops anything without a section or a dp id, de-duplicates repeated
 * (sectionId, dpId) pairs — a duplicate would collide on the table's unique
 * key mid-upsert — and renumbers positions so the agenda's order is its own,
 * independent of any later reordering of the document.
 */
function normalizeAgendaPoints(points, allowedSectionIds) {
  const allowed = allowedSectionIds instanceof Set
    ? allowedSectionIds
    : new Set(allowedSectionIds || []);
  const out = [];
  const seen = new Set();
  (points || []).forEach((p) => {
    const sectionId = parseInt(p && p.sectionId, 10);
    const dpId = p && p.dpId ? String(p.dpId).slice(0, 60) : '';
    if (!sectionId || !dpId) return;
    if (allowed.size && !allowed.has(sectionId)) return;
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
  isBlankHtml, ymd, dueAt, deadlineFromMeeting, normalizeAgendaPoints, agendaKeys,
};
