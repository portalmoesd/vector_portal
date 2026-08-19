const { buildChain, baseRole } = require('./pipeline');
const { ROLES } = require('./roles');

const MAILTO_URL_LIMIT = 1800;

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function roleLabel(role) {
  return (
    {
      [ROLES.DEPUTY]: 'Deputy',
      [ROLES.SUPERVISOR]: 'Supervisor',
      [ROLES.SUPER_COLLABORATOR]: 'Senior Editor',
      [ROLES.COLLABORATOR]: 'Editor',
      CURATOR: 'Curator',
      RECEIVING_SUPER_COLLABORATOR: 'Receiving Senior Editor',
      RECEIVING_SUPERVISOR: 'Receiving Supervisor',
    }[role] ||
    role ||
    'Participant'
  );
}

// Georgian role labels for the email body (mirrors frontend locales roles.*).
function roleLabelKa(role) {
  return (
    {
      [ROLES.ADMIN]: 'ადმინი',
      [ROLES.PROTOCOL]: 'პროტოკოლი',
      [ROLES.DEPUTY]: 'მოადგილე',
      [ROLES.MINISTER]: 'მინისტრი',
      [ROLES.SUPERVISOR]: 'ხელმძღვანელი',
      [ROLES.SUPER_COLLABORATOR]: 'უფროსი შემსრულებელი',
      [ROLES.COLLABORATOR]: 'შემსრულებელი',
      CURATOR: 'კურატორი',
      RECEIVING_SUPER_COLLABORATOR: 'უფროსი შემსრულებელი',
      RECEIVING_SUPERVISOR: 'ხელმძღვანელი',
    }[role] ||
    role ||
    'მონაწილე'
  );
}

function addParticipant(participants, user, sourceRole) {
  if (!user || !user.id) return;
  const existing = participants.get(Number(user.id));
  const source = roleLabel(sourceRole || user.role);
  if (existing) {
    if (!existing.sourceRoles.includes(source)) existing.sourceRoles.push(source);
    return;
  }

  participants.set(Number(user.id), {
    id: Number(user.id),
    fullName: user.full_name,
    fullNameKa: user.full_name_ka,
    email: user.email,
    role: user.role || sourceRole,
    departmentName: user.department_name || null,
    sourceRoles: [source],
  });
}

async function getEvent(db, eventId) {
  const {
    rows: [event],
  } = await db.query(
    `SELECT e.id, e.title, e.country_id, e.document_submitter_role,
            e.document_submitter_id, e.deputy_id, e.supervisor_id,
            e.curator_required, e.workflow_type, e.language, e.deadline_date,
            e.occasion, e.created_by_id, e.created_at,
            c.name_en AS country_name,
            ds.full_name AS document_submitter_name,
            ds.full_name_ka AS document_submitter_name_ka,
            dep.full_name AS deputy_name,
            sv.full_name AS supervisor_name
     FROM events e
     JOIN countries c ON c.id = e.country_id
     JOIN users ds ON ds.id = e.document_submitter_id
     LEFT JOIN users dep ON dep.id = e.deputy_id
     LEFT JOIN users sv ON sv.id = e.supervisor_id
     WHERE e.id = $1`,
    [eventId]
  );
  return event || null;
}

async function getEventSections(db, eventId) {
  const { rows } = await db.query(
    `SELECT s.id, s.title, s.sort_order,
            COALESCE(
              json_agg(
                json_build_object('id', d.id, 'name', d.name_en)
                ORDER BY d.name_en
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'
            ) AS departments
     FROM sections s
     LEFT JOIN section_departments sd ON sd.section_id = s.id
     LEFT JOIN departments d ON d.id = sd.department_id
     WHERE s.event_id = $1
     GROUP BY s.id
     ORDER BY s.sort_order`,
    [eventId]
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sortOrder: row.sort_order,
    departments: row.departments || [],
  }));
}

async function getEventFiles(db, eventId) {
  const { rows } = await db.query(
    `SELECT id, original_name FROM event_files WHERE event_id = $1 ORDER BY created_at`,
    [eventId]
  );
  return rows.map((r) => ({ id: r.id, originalName: r.original_name }));
}

async function getUserById(db, userId) {
  if (!userId) return null;
  const {
    rows: [user],
  } = await db.query(
    `SELECT u.id, u.full_name, u.full_name_ka, u.email, u.role, d.name_en AS department_name, u.department_id
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id = $1`,
    [userId]
  );
  return user || null;
}

async function getHomeDepartmentId(db, event) {
  if (event.document_submitter_role === ROLES.DEPUTY && event.supervisor_id) {
    const supervisor = await getUserById(db, event.supervisor_id);
    return supervisor ? supervisor.department_id : null;
  }

  const submitter = await getUserById(db, event.document_submitter_id);
  return submitter ? submitter.department_id : null;
}

async function getUsersForStep(db, event, sectionDeptIds, homeDepartmentId, step) {
  if (step === 'CURATOR') {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.full_name_ka, u.email, u.role, d.name_en AS department_name
       FROM deputy_department_links ddl
       JOIN users u ON u.id = ddl.deputy_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE ddl.department_id = ANY($1) AND u.id != $2
       ORDER BY u.full_name`,
      [sectionDeptIds, event.document_submitter_id]
    );
    return rows;
  }

  if (step === ROLES.DEPUTY) {
    const deputy = await getUserById(db, event.document_submitter_id);
    return deputy ? [deputy] : [];
  }

  if (step.startsWith('RECEIVING_')) {
    if (!homeDepartmentId) return [];
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.full_name_ka, u.email, u.role, d.name_en AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN country_assignments ca ON ca.user_id = u.id AND ca.country_id = $3
       WHERE u.role = $1 AND u.department_id = $2
         AND (
           ca.user_id IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM country_assignments ca2 WHERE ca2.user_id = u.id)
         )
       ORDER BY u.full_name`,
      [baseRole(step), homeDepartmentId, event.country_id]
    );
    return rows;
  }

  if (!sectionDeptIds.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.full_name_ka, u.email, u.role, d.name_en AS department_name
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN country_assignments ca ON ca.user_id = u.id AND ca.country_id = $3
     WHERE u.role = $1 AND u.department_id = ANY($2)
       AND (
         ca.user_id IS NOT NULL
         OR NOT EXISTS (SELECT 1 FROM country_assignments ca2 WHERE ca2.user_id = u.id)
       )
     ORDER BY u.full_name`,
    [step, sectionDeptIds, event.country_id]
  );
  return rows;
}

function splitRecipients(participants) {
  const recipients = [];
  const missingEmails = [];
  const seenEmails = new Set();

  for (const participant of participants.values()) {
    const email = normalizeEmail(participant.email);
    const payload = {
      id: participant.id,
      fullName: participant.fullName,
      fullNameKa: participant.fullNameKa,
      role: participant.role,
      roleLabels: participant.sourceRoles,
      departmentName: participant.departmentName,
    };

    if (!email) {
      missingEmails.push(payload);
      continue;
    }

    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipients.push({ ...payload, email });
  }

  recipients.sort((a, b) => a.fullName.localeCompare(b.fullName));
  missingEmails.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { recipients, missingEmails };
}

const GEORGIAN_MONTHS = [
  'იანვარი',
  'თებერვალი',
  'მარტი',
  'აპრილი',
  'მაისი',
  'ივნისი',
  'ივლისი',
  'აგვისტო',
  'სექტემბერი',
  'ოქტომბერი',
  'ნოემბერი',
  'დეკემბერი',
];

const LANGUAGE_LABELS = {
  KA: 'ქართული',
  RU: 'Русский',
  EN: 'English',
};

function formatDeadlineDate(value) {
  if (!value) return 'არ არის მითითებული';
  let year;
  let monthIndex;
  let day;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'არ არის მითითებული';
    year = value.getUTCFullYear();
    monthIndex = value.getUTCMonth();
    day = value.getUTCDate();
  } else {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return String(value);
    year = Number(match[1]);
    monthIndex = Number(match[2]) - 1;
    day = Number(match[3]);
  }
  const monthName = GEORGIAN_MONTHS[monthIndex] || '';
  return `${day} ${monthName} ${year}`.trim();
}

function buildEmailBody(event, sections, recipients, missingEmails) {
  // The body is Georgian, so the creator shows their Georgian-script name
  // (falling back to the Latin one) and a Georgian role label.
  const creatorName = event.document_submitter_name_ka || event.document_submitter_name || 'უცნობი';
  const creatorLine = `${creatorName} (${roleLabelKa(event.document_submitter_role)})`;
  const taskText = stripHtml(event.occasion);
  const languageLabel = LANGUAGE_LABELS[event.language] || event.language || 'არ არის მითითებული';

  return [
    `ენა: ${languageLabel}`,
    `შესრულების ვადა: ${formatDeadlineDate(event.deadline_date)}`,
    `შემქმნელი: ${creatorLine}`,
    '',
    taskText || 'არ არის მითითებული',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// Returns {year, monthIndex, day} from a date value, or null if unparseable.
function dateParts(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { year: value.getUTCFullYear(), monthIndex: value.getUTCMonth(), day: value.getUTCDate() };
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1, day: Number(match[3]) };
}

// iCalendar text escaping (RFC 5545): backslash, comma, semicolon, newlines.
function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Build an all-day VEVENT (.ics) on the deadline date plus a Google Calendar
// "add" URL. Returns null when the event has no usable deadline.
function buildCalendarForEvent(event) {
  const parts = dateParts(event.deadline_date);
  if (!parts) return null;

  const startYmd = `${parts.year}${pad2(parts.monthIndex + 1)}${pad2(parts.day)}`;
  // All-day events use an exclusive DTEND of the next day.
  const endDate = new Date(Date.UTC(parts.year, parts.monthIndex, parts.day + 1));
  const endYmd = `${endDate.getUTCFullYear()}${pad2(endDate.getUTCMonth() + 1)}${pad2(endDate.getUTCDate())}`;

  const now = new Date();
  const dtstamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const title = event.title || 'ღონისძიება';
  const description = stripHtml(event.occasion);

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vector Portal//Event//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${event.id}@vector-portal`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${startYmd}`,
    `DTEND;VALUE=DATE:${endYmd}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  // Outlook (Microsoft 365) "add event" deeplink — the ministry's mail is
  // Outlook, so the email's add-to-calendar link opens Outlook web compose.
  // startdt/enddt use ISO dates; enddt stays the exclusive next day.
  const startIso = `${parts.year}-${pad2(parts.monthIndex + 1)}-${pad2(parts.day)}`;
  const endIso = `${endDate.getUTCFullYear()}-${pad2(endDate.getUTCMonth() + 1)}-${pad2(endDate.getUTCDate())}`;
  const addUrl =
    'https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent' +
    '&allday=true' +
    `&subject=${encodeURIComponent(title)}` +
    `&startdt=${startIso}` +
    `&enddt=${endIso}` +
    (description ? `&body=${encodeURIComponent(description)}` : '');

  return { ics, filename: `event-${event.id}.ics`, addUrl };
}

// Walk the named users + every section × chain step into a participant Map.
// Shared by the email draft and the in-app notification recipient resolver.
async function collectParticipants(db, event, sections, homeDepartmentId) {
  const participants = new Map();

  for (const userId of [event.document_submitter_id, event.deputy_id, event.supervisor_id]) {
    const user = await getUserById(db, userId);
    if (user) addParticipant(participants, user, user.role);
  }

  for (const section of sections) {
    const sectionDeptIds = section.departments.map((department) => department.id).filter(Boolean);
    const isCrossDept = sectionDeptIds.some((departmentId) => departmentId !== homeDepartmentId);
    const chain = buildChain(
      event.document_submitter_role,
      event.curator_required,
      isCrossDept,
      event.workflow_type || 'advanced'
    );

    for (const step of chain) {
      const users = await getUsersForStep(db, event, sectionDeptIds, homeDepartmentId, step);
      for (const user of users) addParticipant(participants, user, step);
    }
  }

  return participants;
}

// Every participant of an event, as a deduped array of user ids. In-app
// notifications don't need email, so unlike the draft this keeps everyone.
async function resolveEventParticipantIds(db, eventId) {
  const event = await getEvent(db, eventId);
  if (!event) return [];
  const sections = await getEventSections(db, eventId);
  const homeDepartmentId = await getHomeDepartmentId(db, event);
  const participants = await collectParticipants(db, event, sections, homeDepartmentId);
  return [...participants.keys()];
}

// The user ids who can act on a given section at a given chain step (role) —
// used to resolve "whose turn is it now" for turn notifications.
async function resolveStepUserIds(db, eventId, sectionId, role) {
  const event = await getEvent(db, eventId);
  if (!event) return [];
  const { rows } = await db.query(
    'SELECT department_id FROM section_departments WHERE section_id = $1',
    [sectionId]
  );
  const sectionDeptIds = rows.map((r) => r.department_id).filter(Boolean);
  const homeDepartmentId = await getHomeDepartmentId(db, event);
  const users = await getUsersForStep(db, event, sectionDeptIds, homeDepartmentId, role);
  return users.map((u) => u.id);
}

async function resolveEventNotificationDraft(db, eventId) {
  const event = await getEvent(db, eventId);
  if (!event) return null;

  const sections = await getEventSections(db, eventId);
  const homeDepartmentId = await getHomeDepartmentId(db, event);
  const participants = await collectParticipants(db, event, sections, homeDepartmentId);

  const { recipients, missingEmails } = splitRecipients(participants);
  const files = await getEventFiles(db, eventId);
  const calendar = buildCalendarForEvent(event);
  const subject = `ახალი ღონისძიება: ${event.title}`;
  const body = buildEmailBody(event, sections, recipients, missingEmails);

  return {
    event: {
      id: event.id,
      title: event.title,
      countryName: event.country_name,
      deadlineDate: event.deadline_date,
      workflowType: event.workflow_type,
      documentSubmitterName: event.document_submitter_name,
      deputyName: event.deputy_name,
      supervisorName: event.supervisor_name,
    },
    recipients,
    missingEmails,
    files,
    calendar,
    subject,
    body,
    mailtoUrlLimit: MAILTO_URL_LIMIT,
  };
}

module.exports = {
  MAILTO_URL_LIMIT,
  normalizeEmail,
  stripHtml,
  splitRecipients,
  buildEmailBody,
  buildCalendarForEvent,
  getEvent,
  resolveEventNotificationDraft,
  resolveEventParticipantIds,
  resolveStepUserIds,
};
