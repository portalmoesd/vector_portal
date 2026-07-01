// In-app notification orchestration. Resolves recipients via the shared
// participant/step resolvers and bulk-inserts rows. Every entry point is
// wrapped so a notification failure never breaks the triggering action.
const {
  resolveEventParticipantIds,
  resolveStepUserIds,
} = require('./event-notification-draft');

async function insertNotifications(db, userIds, { type, eventId = null, sectionId = null, meta = {} }) {
  const ids = [...new Set(userIds)].filter((id) => id != null);
  if (!ids.length) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const uid of ids) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(uid, type, eventId, sectionId, JSON.stringify(meta));
  }
  await db.query(
    `INSERT INTO notifications (user_id, type, event_id, section_id, meta)
     VALUES ${values.join(', ')}`,
    params
  );
}

// New event created → notify every participant except the creator.
async function notifyEventCreated(db, eventId, exceptUserId) {
  try {
    const { rows: [ev] } = await db.query('SELECT title FROM events WHERE id = $1', [eventId]);
    const ids = (await resolveEventParticipantIds(db, eventId))
      .filter((id) => id !== exceptUserId);
    await insertNotifications(db, ids, {
      type: 'event_created',
      eventId,
      meta: { eventTitle: ev ? ev.title : '' },
    });
  } catch (err) {
    console.error('notifyEventCreated error:', err.message);
  }
}

// Event published (COMPLETED) → tell participants the document is ready to read.
async function notifyEventCompleted(db, eventId, exceptUserId) {
  try {
    const { rows: [ev] } = await db.query('SELECT title FROM events WHERE id = $1', [eventId]);
    const ids = (await resolveEventParticipantIds(db, eventId))
      .filter((id) => id !== exceptUserId);
    await insertNotifications(db, ids, {
      type: 'completed',
      eventId,
      meta: { eventTitle: ev ? ev.title : '' },
    });
  } catch (err) {
    console.error('notifyEventCompleted error:', err.message);
  }
}

// A section's baton moved to `holderRole` → notify whoever can act there now
// (except the user who triggered it). type: 'your_turn' | 'returned'.
async function notifySectionTurn(db, { eventId, sectionId, holderRole, actorUserId, type = 'your_turn' }) {
  try {
    if (!holderRole) return;
    const ids = (await resolveStepUserIds(db, eventId, sectionId, holderRole))
      .filter((id) => id !== actorUserId);
    if (!ids.length) return;
    const { rows: [info] } = await db.query(
      `SELECT e.title AS event_title, s.title AS section_title
       FROM events e JOIN sections s ON s.id = $2
       WHERE e.id = $1`,
      [eventId, sectionId]
    );
    await insertNotifications(db, ids, {
      type,
      eventId,
      sectionId,
      meta: {
        eventTitle: info ? info.event_title : '',
        sectionTitle: info ? info.section_title : '',
        role: holderRole,
      },
    });
  } catch (err) {
    console.error('notifySectionTurn error:', err.message);
  }
}

// The user just acted on a section → clear their own "your turn" / "returned"
// notification for it (so the attention dot disappears on any action path).
async function markActorTurnRead(db, userId, eventId, sectionId) {
  try {
    if (!userId || !eventId || !sectionId) return;
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE user_id = $1 AND event_id = $2 AND section_id = $3
         AND type IN ('your_turn', 'returned') AND is_read = FALSE`,
      [userId, eventId, sectionId]
    );
  } catch (err) {
    console.error('markActorTurnRead error:', err.message);
  }
}

module.exports = { insertNotifications, notifyEventCreated, notifyEventCompleted, notifySectionTurn, markActorTurnRead };
