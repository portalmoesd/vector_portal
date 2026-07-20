const ROLES = {
  ADMIN: 'ADMIN',
  PROTOCOL: 'PROTOCOL',
  DEPUTY: 'DEPUTY',
  SUPERVISOR: 'SUPERVISOR',
  SUPER_COLLABORATOR: 'SUPER_COLLABORATOR',
  COLLABORATOR: 'COLLABORATOR',
  // Read-only role: sees the Statistics page only, can't participate
  // in workflow / events / library / admin. Intentionally absent from
  // PIPELINE_ROLES, EVENT_CREATOR_ROLES, EVENT_ENDER_ROLES below.
  ANALYST: 'ANALYST',
  // Library-only role: the Minister reads finished documents prepared for
  // her/him and never participates in the workflow or creates/ends events.
  // She/he may be named as a Document Submitter (an assigned deputy drives
  // the document as curator). Like ANALYST, intentionally absent from the
  // PIPELINE / CREATOR / ENDER lists below.
  MINISTER: 'MINISTER',
};

// Roles that participate in the document approval pipeline
const PIPELINE_ROLES = [
  ROLES.COLLABORATOR,
  ROLES.SUPER_COLLABORATOR,
  ROLES.SUPERVISOR,
  ROLES.DEPUTY,
];

// Roles that can create events
const EVENT_CREATOR_ROLES = [
  ROLES.ADMIN,
  ROLES.PROTOCOL,
  ROLES.DEPUTY,
  ROLES.SUPERVISOR,
  ROLES.SUPER_COLLABORATOR,
];

// Roles that can end events
const EVENT_ENDER_ROLES = [
  ROLES.ADMIN,
  ROLES.PROTOCOL,
  ROLES.DEPUTY,
  ROLES.SUPERVISOR,
];

// Roles whose Library ("ready documents") view is ministry-wide: every
// COMPLETED event, not just the ones they own, acted on or curate.
const LIBRARY_ALL_COMPLETED_ROLES = [
  ROLES.ADMIN,
  ROLES.MINISTER,
  ROLES.DEPUTY,
];

function isPipelineRole(role) {
  return PIPELINE_ROLES.includes(role);
}

function seesAllCompletedDocs(role) {
  return LIBRARY_ALL_COMPLETED_ROLES.includes(role);
}

// Who may see an event's meeting date/time (event_datetime): admins/protocol,
// the document owner, and any Deputy Minister — deputies plan around the
// meeting itself, so they see real times even on events they only contribute
// to. Everyone else only ever sees the document deadline.
function canSeeEventDateTime(role, userId, ownerId) {
  return role === ROLES.ADMIN
    || role === ROLES.PROTOCOL
    || role === ROLES.DEPUTY
    || ownerId === userId;
}

function canCreateEvent(role) {
  return EVENT_CREATOR_ROLES.includes(role);
}

function canEndEvent(role) {
  return EVENT_ENDER_ROLES.includes(role);
}

module.exports = {
  ROLES,
  PIPELINE_ROLES,
  EVENT_CREATOR_ROLES,
  EVENT_ENDER_ROLES,
  LIBRARY_ALL_COMPLETED_ROLES,
  isPipelineRole,
  seesAllCompletedDocs,
  canSeeEventDateTime,
  canCreateEvent,
  canEndEvent,
};
