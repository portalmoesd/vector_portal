-- Vector Portal — Database Schema (idempotent — safe to run multiple times)

BEGIN;

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('ADMIN','PROTOCOL','DEPUTY','SUPERVISOR','SUPER_COLLABORATOR','COLLABORATOR','ANALYST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ANALYST'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The Minister is a first-class role: a read-only Library consumer who never
-- participates in the workflow. May be named as a Document Submitter (the doc
-- is "theirs") while an assigned deputy drives it as curator.
DO $$ BEGIN ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'MINISTER'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE ds_role AS ENUM ('DEPUTY','SUPERVISOR','SUPER_COLLABORATOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE ds_role ADD VALUE IF NOT EXISTS 'MINISTER'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE event_language AS ENUM ('EN','FR','AR','ES','RU','ZH','PT','DE','KA'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE event_language ADD VALUE IF NOT EXISTS 'KA'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE event_status AS ENUM ('DRAFT','IN_PROGRESS','COMPLETED','ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workflow_step_status AS ENUM ('PENDING','IN_PROGRESS','APPROVED','RETURNED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE history_action AS ENUM ('saved','submitted','returned','approved','asked_to_return','pushed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE event_workflow_type AS ENUM ('advanced','simple'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE event_document_type AS ENUM ('OTHER','DISCUSSION_POINTS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE meeting_summary_status AS ENUM ('PENDING','SUBMITTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE history_action ADD VALUE IF NOT EXISTS 'pushed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE history_action ADD VALUE IF NOT EXISTS 'pulled'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Countries ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS countries (
  id            SERIAL PRIMARY KEY,
  name_en       VARCHAR(120) NOT NULL UNIQUE,
  name_ka       VARCHAR(160),
  code          CHAR(2) NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill for databases predating the name_ka column.
ALTER TABLE countries ADD COLUMN IF NOT EXISTS name_ka VARCHAR(160);

-- ─── Departments ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS departments (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(500) NOT NULL,
  name_en       VARCHAR(500),
  is_external   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Users ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  full_name             VARCHAR(200) NOT NULL,
  -- Georgian-script spelling of full_name. full_name itself holds the Latin
  -- transliteration; this is shown instead when the UI is in Georgian (with
  -- full_name as the fallback when it is empty — e.g. legacy/external users).
  full_name_ka          VARCHAR(200),
  username              VARCHAR(100) NOT NULL UNIQUE,
  email                 VARCHAR(200) NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  user_role NOT NULL,
  department_id         INT REFERENCES departments(id) ON DELETE SET NULL,
  is_external           BOOLEAN NOT NULL DEFAULT false,
  entity_name           VARCHAR(200),
  is_minister           BOOLEAN NOT NULL DEFAULT false,
  must_change_password  BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill for databases predating the entity_name column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS entity_name VARCHAR(200);
-- Backfill for databases predating the full_name_ka column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name_ka VARCHAR(200);
-- DEPRECATED: the Minister used to be modelled as a DEPUTY flagged with
-- is_minister. It is now a first-class 'MINISTER' user_role (see migration in
-- server/index.js). The column is kept for backward compatibility / backfill
-- but is no longer read or written by the application.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_minister BOOLEAN NOT NULL DEFAULT false;

-- ─── Country Assignments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS country_assignments (
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_id INT NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, country_id)
);

-- ─── Deputy–Supervisor Links ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deputy_supervisor_links (
  id            SERIAL PRIMARY KEY,
  deputy_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (deputy_id, supervisor_id)
);

-- ─── Deputy–Department Links (direct mapping from org chart) ──────────────

CREATE TABLE IF NOT EXISTS deputy_department_links (
  deputy_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (deputy_id, department_id)
);

-- ─── Events ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id                        SERIAL PRIMARY KEY,
  title                     VARCHAR(500) NOT NULL,
  description               TEXT,
  country_id                INT NOT NULL REFERENCES countries(id),
  document_submitter_role   ds_role NOT NULL,
  document_submitter_id     INT NOT NULL REFERENCES users(id),
  deputy_id                 INT REFERENCES users(id),
  supervisor_id             INT REFERENCES users(id),
  curator_required          BOOLEAN NOT NULL DEFAULT false,
  workflow_type             event_workflow_type NOT NULL DEFAULT 'advanced',
  document_type             event_document_type NOT NULL DEFAULT 'OTHER',
  language                  event_language NOT NULL DEFAULT 'EN',
  deadline_date             DATE,
  occasion                  TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  ended_at                  TIMESTAMPTZ,
  status                    event_status NOT NULL DEFAULT 'DRAFT',
  created_by_id             INT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill for databases predating the workflow_type column. Idempotent:
-- ADD COLUMN IF NOT EXISTS is a no-op once the column has been added.
ALTER TABLE events ADD COLUMN IF NOT EXISTS workflow_type event_workflow_type NOT NULL DEFAULT 'advanced';
-- Backfill for databases predating the document_type column. 'OTHER' keeps
-- every existing event on the free-form editor and export paths unchanged.
ALTER TABLE events ADD COLUMN IF NOT EXISTS document_type event_document_type NOT NULL DEFAULT 'OTHER';
-- Optional date/time of the actual event (used for Minister/Deputy owners).
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_datetime TIMESTAMPTZ;

-- ─── Sections ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sections (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title       VARCHAR(500) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Section–Department Assignment ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_departments (
  section_id    INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, department_id)
);

-- ─── Workflow Steps ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_steps (
  id                SERIAL PRIMARY KEY,
  section_id        INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  department_id     INT REFERENCES departments(id),
  step_order        INT NOT NULL,
  role_label        VARCHAR(50) NOT NULL,
  assigned_user_id  INT REFERENCES users(id),
  status            workflow_step_status NOT NULL DEFAULT 'PENDING',
  reviewed_at       TIMESTAMPTZ,
  comments          TEXT
);

-- ─── Section Content ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_content (
  id                            SERIAL PRIMARY KEY,
  event_id                      INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id                    INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  html_content                  TEXT NOT NULL DEFAULT '',
  status                        VARCHAR(60) NOT NULL DEFAULT 'draft',
  status_comment                TEXT,
  original_submitter_role       VARCHAR(50),
  return_target_role            VARCHAR(50),
  last_updated_by_user_id       INT REFERENCES users(id),
  last_updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_content_edited_at        TIMESTAMPTZ,
  last_content_edited_by_user_id INT REFERENCES users(id),
  UNIQUE (event_id, section_id)
);

-- ─── Section Files ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_files (
  id              SERIAL PRIMARY KEY,
  event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id      INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  original_name   VARCHAR(500) NOT NULL,
  stored_name     VARCHAR(500) NOT NULL,
  mime_type       VARCHAR(200),
  size            BIGINT NOT NULL DEFAULT 0,
  file_data       BYTEA,
  uploaded_by_id  INT REFERENCES users(id),
  uploaded_by_name VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_section_files_lookup ON section_files (event_id, section_id);

-- ─── Event Files ────────────────────────────────────────────────────────────
-- Event-level attachments (added at creation time), independent of sections.
CREATE TABLE IF NOT EXISTS event_files (
  id               SERIAL PRIMARY KEY,
  event_id         INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  original_name    VARCHAR(500) NOT NULL,
  mime_type        VARCHAR(200),
  size             BIGINT NOT NULL DEFAULT 0,
  file_data        BYTEA,
  uploaded_by_id   INT REFERENCES users(id),
  uploaded_by_name VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_files_lookup ON event_files (event_id);

-- ─── Section History ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_history (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id  INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  action      history_action NOT NULL,
  from_status VARCHAR(60),
  to_status   VARCHAR(60) NOT NULL,
  user_id     INT REFERENCES users(id),
  user_name   VARCHAR(200),
  user_role   VARCHAR(50),
  note        TEXT,
  acted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_section_history_lookup ON section_history (event_id, section_id, acted_at);

-- ─── Section Comments ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_comments (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id  INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id),
  parent_id   INT REFERENCES section_comments(id) ON DELETE CASCADE,
  anchor_id   VARCHAR(100),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Section Return Requests ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS section_return_requests (
  id                      SERIAL PRIMARY KEY,
  event_id                INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id              INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  requested_by_user_id    INT NOT NULL REFERENCES users(id),
  requested_by_name       VARCHAR(200) NOT NULL,
  requested_by_role       VARCHAR(50) NOT NULL,
  broadcast_above_role    VARCHAR(50) NOT NULL,
  note                    TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Notifications ──────────────────────────────────────────────────────────
-- In-app, per-user notifications surfaced on the dashboard. `meta` carries the
-- denormalised display strings (eventTitle, sectionTitle, role) so the UI can
-- render without extra joins and survive title changes/deletions.
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(40) NOT NULL,   -- 'event_created' | 'your_turn' | 'returned' | 'completed'
                                      -- | 'summary_due' | 'summary_unassigned'
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  section_id  INT REFERENCES sections(id) ON DELETE CASCADE,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, is_read, created_at DESC);

-- ─── Meeting Summaries ──────────────────────────────────────────────────────
-- After a Discussion Points meeting, the Supervisors responsible for each
-- extracted point write a summary against it. Three tables:
--
--   meeting_agenda_points   what the Document Owner extracted for the meeting
--   meeting_summaries       one shared summary row per extracted point
--   meeting_summary_assignees  which supervisors own that row
--
-- The agenda stores a *snapshot* of each point rather than a pointer into
-- section_content.html_content. The owner can reopen a published document and
-- edit, reorder or delete points afterwards (and parsePoints() regenerates ids
-- it finds missing or duplicated), so a pointer would rot. section_id / dp_id /
-- position are kept alongside so a live re-link is still possible when the id
-- still resolves.
CREATE TABLE IF NOT EXISTS meeting_agenda_points (
  id                  SERIAL PRIMARY KEY,
  event_id            INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id          INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  dp_id               VARCHAR(60) NOT NULL,   -- the data-dp-id at extraction time
  position            INT NOT NULL DEFAULT 0, -- order within the agenda
  topic_snapshot      TEXT NOT NULL DEFAULT '',
  context_snapshot    TEXT NOT NULL DEFAULT '',
  additional_snapshot TEXT NOT NULL DEFAULT '',
  -- Set when a later re-export drops this point. Soft, never DELETE: a point
  -- that already carries a written summary must not lose it silently.
  removed_at          TIMESTAMPTZ,
  recorded_by_id      INT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, section_id, dp_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_agenda_event
  ON meeting_agenda_points (event_id, position);

-- One shared row per agenda point (hence UNIQUE agenda_point_id): either
-- assigned supervisor may fill it and the last save wins, so the row records
-- who wrote it and when. The row's existence means the task is open.
CREATE TABLE IF NOT EXISTS meeting_summaries (
  id                     SERIAL PRIMARY KEY,
  agenda_point_id        INT NOT NULL UNIQUE REFERENCES meeting_agenda_points(id) ON DELETE CASCADE,
  event_id               INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  summary_html           TEXT NOT NULL DEFAULT '',
  status                 meeting_summary_status NOT NULL DEFAULT 'PENDING',
  deadline_date          DATE,
  opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who sent this out. Sending is a deliberate act by the Document Owner (or
  -- Protocol acting for the Minister), so the row records who performed it.
  opened_by_user_id      INT REFERENCES users(id),
  last_edited_by_user_id INT REFERENCES users(id),
  last_edited_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_summaries_event ON meeting_summaries (event_id);
-- Backfill for databases predating the opened_by_user_id column.
ALTER TABLE meeting_summaries ADD COLUMN IF NOT EXISTS opened_by_user_id INT REFERENCES users(id);

-- Resolved once when the task opens and then frozen, so a supervisor who moves
-- department keeps the task they were actually given.
CREATE TABLE IF NOT EXISTS meeting_summary_assignees (
  summary_id INT NOT NULL REFERENCES meeting_summaries(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_summary_assignees_user
  ON meeting_summary_assignees (user_id);

-- ─── Event Templates ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_templates (
  id                        SERIAL PRIMARY KEY,
  name                      VARCHAR(300) NOT NULL,
  created_by_id             INT REFERENCES users(id),
  document_submitter_role   ds_role NOT NULL DEFAULT 'DEPUTY',
  curator_required          BOOLEAN NOT NULL DEFAULT false,
  is_default                BOOLEAN NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_template_sections (
  id            SERIAL PRIMARY KEY,
  template_id   INT NOT NULL REFERENCES event_templates(id) ON DELETE CASCADE,
  title         VARCHAR(500) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_template_section_departments (
  template_section_id INT NOT NULL REFERENCES event_template_sections(id) ON DELETE CASCADE,
  department_id       INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (template_section_id, department_id)
);

-- Admin-uploaded datasets (companies registry, FDI sectors, etc.).
-- Rows are keyed by a short kind string; parsed_json holds the aggregated
-- result the statistics page reads, and raw_bytes + file_name keep the
-- original XLSX so the admin can download it back from the admin page after
-- a deploy. Rows predating that (and the legacy disk migration's imports)
-- have no raw_bytes, and simply offer no download.
CREATE TABLE IF NOT EXISTS admin_uploads (
  kind         TEXT PRIMARY KEY,
  parsed_json  JSONB NOT NULL,
  raw_bytes    BYTEA,
  file_name    TEXT,
  -- When the *file* was stored, which is not always when the data was: a
  -- dataset parsed in the browser saves its summary first and uploads the file
  -- after, so if that second step fails the stored file is older than the
  -- figures. Reporting its own timestamp keeps the download line honest
  -- instead of stamping yesterday's workbook with today's date.
  file_uploaded_at TIMESTAMPTZ,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill for databases predating these columns.
ALTER TABLE admin_uploads ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE admin_uploads ADD COLUMN IF NOT EXISTS file_uploaded_at TIMESTAMPTZ;

-- Persisted trade-API computations so deploys don't wipe them and Geostat
-- is hit once per period instead of once per restart. Keys look like
-- 'ranking:2026:1,2,3', 'appendix:2026:5', 'classificatory:en', and
-- 'trade-state' (the monthly publication detector's last-seen period).
CREATE TABLE IF NOT EXISTS trade_cache (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
