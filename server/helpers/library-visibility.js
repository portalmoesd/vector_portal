/**
 * Who may see a finished document.
 *
 * The rule behind GET /api/library, extracted so anything hanging off a
 * published document — the Meeting Summary, for one — is gated by exactly the
 * same predicate rather than a second, drifting copy of it.
 *
 * Visibility is role-shaped:
 *   - ADMIN / MINISTER / DEPUTY / PROTOCOL (seesAllCompletedDocs): everything.
 *   - Collaborator / Senior Editor: assigned country AND their department on a
 *     section.
 *   - Supervisor / Deputy: assigned country, their department on a section, or
 *     (deputies) a department they oversee via deputy_department_links.
 * Anyone named on the event, or who has acted on it, always sees it.
 */
const { seesAllCompletedDocs } = require('./roles');

/** The OR-clause every non-ministry-wide role shares: named on it, or acted. */
const BASE_OR = `
      sh.user_id = $1
      OR e.document_submitter_id = $1
      OR e.deputy_id = $1
      OR e.supervisor_id = $1
      OR e.created_by_id = $1`;

const COLLAB_CHAIN_OR = `
        OR (
          e.country_id IN (SELECT country_id FROM country_assignments WHERE user_id = $1)
          AND EXISTS (
            SELECT 1 FROM sections s
            JOIN section_departments sd ON sd.section_id = s.id
            WHERE s.event_id = e.id
              AND sd.department_id = (SELECT department_id FROM users WHERE id = $1)
          )
        )`;

const SUPERVISOR_CHAIN_OR = `
        OR e.country_id IN (SELECT country_id FROM country_assignments WHERE user_id = $1)
        OR EXISTS (
          SELECT 1 FROM sections s
          JOIN section_departments sd ON sd.section_id = s.id
          WHERE s.event_id = e.id
            AND sd.department_id = (SELECT department_id FROM users WHERE id = $1)
        )
        OR EXISTS (
          SELECT 1 FROM sections s
          JOIN section_departments sd ON sd.section_id = s.id
          JOIN deputy_department_links ddl ON ddl.department_id = sd.department_id
          WHERE s.event_id = e.id AND ddl.deputy_id = $1
        )`;

/** The chain clause for a role. `$1` is the user id in both branches. */
function chainOrFor(role) {
  return (role === 'COLLABORATOR' || role === 'SUPER_COLLABORATOR')
    ? COLLAB_CHAIN_OR
    : SUPERVISOR_CHAIN_OR;
}

/**
 * Can this user see this finished document?
 *
 * ANALYST is excluded outright: it is a read-only Statistics role that never
 * participates in the workflow, and the list query only ever returned nothing
 * for it because no clause could match — worth being explicit where a single
 * event is addressed by id.
 */
async function canSeeCompletedEvent(db, user, eventId) {
  if (!user || user.role === 'ANALYST') return false;
  if (seesAllCompletedDocs(user.role)) return true;

  const { rows } = await db.query(
    `SELECT 1
     FROM events e
     LEFT JOIN section_history sh ON sh.event_id = e.id
     WHERE e.id = $2
       AND (
         ${BASE_OR}
         ${chainOrFor(user.role)}
       )
     LIMIT 1`,
    [user.id, eventId]
  );
  return rows.length > 0;
}

module.exports = { BASE_OR, chainOrFor, canSeeCompletedEvent };
