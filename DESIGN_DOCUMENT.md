# Vector Portal — Workflow & Architecture Design Document

## 1. Overview

This document defines the redesigned document approval workflow, user management,
event creation, and progress tracking for the Vector Portal system.

**Key changes from the previous approach:**
- Remove the rigid single-deputy linear workflow
- Introduce department/agency-based user assignment
- Make the document submitter role dynamic (Deputy, Supervisor, or Senior Editor)
- Remove Minister from the approval chain
- Replace Collaborator I / Head Collaborator with simplified Editor / Senior Editor roles
- Add external user support (non-Ministry of Economy)
- **Documents are composed of sections**, each assigned to one or more departments — approval chains are **per-section**
- Curator (Deputy) involvement on cross-department sections is **optional**, configured per event

---

## 2. Roles

### 2.1 Role Definitions

| Role                | Scope        | Description |
|---------------------|--------------|-------------|
| **Admin**           | System-wide  | System administrator. Manages departments, users, Deputy–Supervisor links, and country assignments via the Admin Panel. Does **not** participate in document workflows. |
| **Deputy**          | Cross-department | Top-level official. Acts as **Document Submitter** (final approver) or **Curator** (mid-tier reviewer) depending on the document. |
| **Supervisor**      | Per department | Oversees department workflow. Can also serve as Document Submitter. |
| **Senior Editor**   | Per department | Senior departmental officer. Reviews Editor submissions and can also serve as Document Submitter. |
| **Editor**          | Per department | Base-level author. Drafts the section content. |
| **Protocol**        | System-wide  | Operational role. Can create and end events. Does **not** participate in document approval workflows (non-pipeline role, similar to Admin). |

> **Display names vs. identifiers.** "Editor" and "Senior Editor" (Georgian
> **შემსრულებელი** / **უფროსი შემსრულებელი**) are display labels only. In the
> database and in code these roles remain `COLLABORATOR` and
> `SUPER_COLLABORATOR`, because section statuses are stored as strings derived
> from them (`submitted_to_super_collaborator`) — renaming the enum would mean
> migrating live approval state. Expect the two to differ throughout this
> document: role tables and prose use the display names, schema listings and
> status values use the identifiers.

> **Supervisor in Georgian.** The Supervisor is shown as **ხელმძღვანელი**, not
> ზედამხედველი. This one is a Georgian-only rename — the English label stays
> "Supervisor" and the `SUPERVISOR` identifier is untouched. Note that two
> external agencies in `server/data/departments.json` are named for supervision
> as an activity (ზედამხედველობის სააგენტო); those are proper nouns and keep
> their own spelling.

### 2.2 Removed Roles

- **Minister** — Will not be involved in document creation or approval.
- **Collaborator I / Head Collaborator** — Replaced by the simplified Editor / Senior Editor distinction.

### 2.3 The "Curator" Label

"Curator" is **not a separate role**. It is a contextual label applied to a **Deputy**
when that Deputy is **not** the Document Submitter for a given document. In this context,
the Deputy drops into the approval chain as a mid-tier reviewer (curator).

---

## 3. Departments & Agencies

### 3.1 Structure

- The system manages multiple **departments** and **agencies**.
- Departments and agencies are created and managed via the **Admin Panel**.
- Each user is assigned to **exactly one** department or agency.

### 3.2 Department Composition

- Departments have **no strict role composition requirements**. A department may have any combination of roles — sometimes only one person from a department participates in a section.
- Deputies exist **above** the department level and can be linked to one or more departments.
- If a department lacks a role level (e.g., no Senior Editor or no Supervisor), the workflow chain **skips that step** and proceeds to the next applicable level.

### 3.3 External Organizations

External entities (non-Ministry of Economy) are also represented as departments/agencies
with the `external` flag. They can have their own:
- Editors
- Senior Editors
- Supervisors
- Curators (Deputies acting as curators)

### 3.4 Countries

Each event is associated with exactly **one country**. Countries control event visibility
and user access for pipeline roles.

- The system is seeded with a full ISO country list (~195 countries).
- Each country has: `name_en` (English name), `code` (ISO-2 country code).
- Countries are **permanent** — they cannot be deactivated or removed.
- **Regions** are **UI-only groupings** used to help admins select countries more easily — they are not stored in the database. The region groupings match the previous system exactly:
  - **Neighbors**: BY, UA, MD, RU, AZ, AM, KZ, TJ, KG, UZ, TM
  - **EU**: AT, BE, BG, HR, CY, CZ, DK, EE, FI, FR, DE, GR, HU, IE, IT, LV, LT, LU, MT, NL, PL, PT, RO, SK, SI, ES, SE
  - **Other Europe**: AL, AD, BA, CH, IS, LI, MC, ME, MK, NO, RS, SM, TR, GB, VA, GE, XK
  - **North America**: US, CA, MX, GL, BM
  - **Central America & Caribbean**: BZ, CR, SV, GT, HN, NI, PA, AG, BS, BB, CU, DM, DO, GD, HT, JM, KN, LC, VC, TT, PR
  - **South America**: AR, BO, BR, CL, CO, EC, GY, PY, PE, SR, UY, VE, FK, GF
  - **Africa**: All African nations (~54 countries)
  - **Asia**: All Asian nations (~48 countries)
  - **Oceania**: AU, NZ, FJ, FM, KI, MH, NR, PW, PG, WS, SB, TO, TV, VU

#### 3.4.1 Country Assignments

- **Editors** and **Senior Editors** are assigned to one or more countries.
- **Supervisors** and **Deputies** are NOT assigned to countries — they can see all events
  within their scope (department or linked departments).
- A pipeline user can only view and work on events for countries they are assigned to.
- Country assignments are managed in the Admin Panel alongside section/department assignments.

#### 3.4.2 Country–Event Relationship

- Each event has a required `country_id` field — one country per event.
- When creating an event, the creator selects which country the event is for.
- All sections within an event inherit the event's country context.
- Document status (approval progress) is tracked per event (which is inherently per-country).

---

## 4. User Management

### 4.1 User Creation (Admin Panel)

When creating a user, the admin must provide:

| Field             | Required | Description |
|-------------------|----------|-------------|
| **Full Name**     | Yes      | User's full name |
| **Username**      | Yes      | Unique login identifier. Used for authentication (username + password). |
| **Email**         | Yes      | For notifications and password reset |
| **Country Assignments** | Conditional | One or more countries the user can work on. Required for Editor and Senior Editor roles. Not applicable for Supervisors and Deputies. |
| **Department / Agency** | Yes | Assign to exactly one department or agency |
| **Role**          | Yes      | One of: Deputy, Supervisor, Senior Editor, Editor |
| **External**      | Yes      | Boolean flag — `true` for users not from the Ministry of Economy |

#### 4.1.1 Authentication Setup

Users authenticate with **username + password**. When creating a user, the admin can choose either:
- **Set an initial temporary password** — the user must change it on first login.
- **Send an email invitation** — the system emails the user a link to set their own password.

### 4.2 Validation Rules

- Usernames must be unique across all users.
- Deputies are not bound to a per-department constraint (they operate cross-department).
- A department must have at least **one user** to be usable in events.

---

## 5. Document Approval Workflow

### 5.1 Core Concept — Per-Section Approval

A **document (event)** is composed of multiple **sections**. Each section can be assigned
to **one or more departments**. The approval chain is **per-section**, not per-document.

When a section has multiple departments, each department's chain runs **in parallel**.
Once all department chains for a section are complete, the section moves to the
Curator/Document Submitter level. The overall document is considered complete only when
**all sections** have been fully approved.

Sections themselves also run **in parallel** — they do not depend on each other.
New sections **can be added** after event creation.

Any of the following roles can be the Document Submitter:
- **Deputy**
- **Supervisor**
- **Senior Editor**

### 5.2 Key Rules

1. **Home-department sections** (where the section's department matches the Document Submitter's department) go through the department chain and stop at the Document Submitter — **no Curator step**.
2. **Cross-department sections** (where the section's department differs from the Document Submitter's department) go through their own department's full chain, then **optionally** through the **Curator (Deputy)**, then through the **Document Submitter's home department receiving chain** (starting at SC), then to the Document Submitter.
3. The **Curator step is optional** — it is configured during event creation ("Curator required" toggle).
4. **Receiving chain**: When a cross-department section arrives at the Document Submitter's home department, it enters at the **Senior Editor** level and works up. This ensures the home department reviews cross-department content before the Document Submitter gives final approval. Exception: when SC is the Document Submitter, SC directly receives — no intermediate receiving chain.
5. **Skip missing levels**: If a department lacks a role (e.g., no Senior Editor or no Supervisor), the workflow chain **skips that step** and proceeds to the next applicable level.
6. **Return flow**: When a section is returned (rejected), it goes back to the **original editor level** — the first level to edit (Editor or Senior Editor), not one step back. The section must then re-traverse the entire chain from that point.
7. **Auto-assignment**: When a section is assigned to a department, Editors and Senior Editors are **automatically pulled from that department's roster** (filtered by the event's country assignment).
8. **Multi-department sections**: When a section is assigned to multiple departments, each department's internal chain runs **in parallel**. Once all department chains complete, the section proceeds to the Curator/DS level.
9. **First editor flexibility**: Any role in a department's chain can be the first editor of a section — not just Editor. For example, a Supervisor can directly edit a section without it first passing through Editor → SC. The progress bar starts at whichever role first edited the section (`original_submitter_role`), and earlier steps are omitted entirely. Additionally, SC(A) and Supervisor(A) from the Document Submitter's home department can be the first editors for sections assigned to other departments (cross-department first-editing).

### 5.3 Workflow Chains

#### Chain A — Deputy is Document Submitter

The Deputy is linked to a Supervisor (Dept A). Dept A serves as the **home department**
whose chain all sections must pass through before reaching the Deputy.

**Home-department section (Dept A):**
```
Editor(A) → Senior Editor(A) → Supervisor(A) → Deputy (approves & submits)
```

**Cross-department section (Dept B):**
```
Editor(B) → SC(B) → Supervisor(B) → [Deputy as Curator*] → SC(A) → Supervisor(A) → Deputy (approves & submits)
```

- Cross-department sections first complete their own department's chain, then pass through
  the home department's chain (SC(A) → Supervisor(A)) before reaching the Deputy.
- The Curator step is optional — it sits between the originating department's chain and the home department's receiving chain.
- Home-department sections skip the Curator step entirely.

`*` Curator step included only if "Curator required" is enabled during event creation.

#### Chain B — Supervisor (Dept A) is Document Submitter

**Own-department section (Dept A):**
```
Editor(A) → Senior Editor(A) → Supervisor(A) ✓ (approves & submits)
```
- No Curator needed — Supervisor directly oversees their own department's work.

**Cross-department section (Dept B):**
```
Editor(B) → SC(B) → Supervisor(B) → [Deputy as Curator*] → SC(A) → Supervisor(A) ✓ (approves & submits)
```
- The section goes through Dept B's **full internal chain** (up to Supervisor B).
- Then **optionally** through the Deputy acting as Curator.
- Then passes through the **home department's receiving chain** (SC(A) → Supervisor(A)) before reaching Supervisor A as the Document Submitter for final approval.

`*` Curator step included only if "Curator required" is enabled during event creation.

#### Chain C — Senior Editor (Dept A) is Document Submitter

**Own-department section (Dept A):**
```
Editor(A) → Senior Editor(A) ✓ (approves & submits)
```
- No Curator needed — Senior Editor directly oversees their own department's section.

**Cross-department section (Dept B):**
```
Editor(B) → SC(B) → Supervisor(B) → [Deputy as Curator*] → Senior Editor(A) ✓ (approves & submits)
```
- The section goes through Dept B's **full internal chain** (up to Supervisor B).
- Then **optionally** through the Deputy acting as Curator.
- Finally reaches Senior Editor A (the Document Submitter) for final approval.
- Note: SC(A) is the final approver here, so the section does **not** pass through SC(A) as an intermediate step — SC(A) directly receives and approves.

`*` Curator step included only if "Curator required" is enabled during event creation.

#### Multi-Department Sections

When a section is assigned to multiple departments (e.g., Dept B and Dept C), each department's
chain runs in parallel. Once all have completed, the section proceeds to the Curator/DS level:

```
Section "Joint Analysis" (Dept B + Dept C):
  Dept B track: Editor(B) → SC(B) → Supervisor(B) ──┐
  Dept C track: Editor(C) → SC(C) → Supervisor(C) ──┤→ [Curator*] → SC(A) → Supervisor(A) → Deputy
```

#### Skipping Missing Levels

If a department lacks a role, that step is skipped. For example, if Dept B has no Senior Editor:

```
Editor(B) → Supervisor(B) → ...
```

### 5.4 Workflow Summary Table

| Document Submitter        | Own-Dept Section Chain | Cross-Dept Section Chain | Curator Step |
|---------------------------|------------------------|--------------------------|--------------|
| **Deputy**                | Collab(A) → SC(A) → Supervisor(A) → **Deputy** | Collab(B) → SC(B) → Supervisor(B) → [Curator] → SC(A) → Supervisor(A) → **Deputy** | Optional |
| **Supervisor (Dept A)**   | Collab(A) → SC(A) → **Supervisor(A)** | Collab(B) → SC(B) → Supervisor(B) → [Curator] → SC(A) → **Supervisor(A)** | Optional |
| **Super-Collab (Dept A)** | Collab(A) → **SC(A)** | Collab(B) → SC(B) → Supervisor(B) → [Curator] → **SC(A)** | Optional |

---

## 6. Event Creation (Redesigned)

### 6.0 Who Can Create Events

Events can be created by:
- **Deputy**
- **Supervisor**
- **Senior Editor**
- **Admin**
- **Protocol**

Editors **cannot** create events.

### 6.1 Event Fields

When creating an event, the following must be specified:

| Field                  | Required   | Description |
|------------------------|------------|-------------|
| **Event Title**        | Yes        | Name of the event |
| **Country**            | Yes        | The country this event is for. Determines which pipeline users (Editors, Senior Editors) can participate. |
| **Document Submitter Role** | Yes  | Who will be the final approver: Deputy, Supervisor, or Senior Editor |
| **Document Submitter** | Yes        | The specific user who will be the final approver (filtered by role selection) |
| **Deputy**             | Conditional | Selected from dropdown. Required if Deputy is Document Submitter **or** if Curator is enabled. |
| **Curator Required**   | Conditional | Toggle/checkbox. Shown when Document Submitter is **not** a Deputy. Controls whether the Deputy reviews cross-department sections. |
| **Supervisor**         | Conditional | Selected from dropdown, **filtered by the selected Deputy** (linked relationship). Required if Supervisor is in the chain. |
| **Sections**           | Yes        | Define the sections that compose this document (see §6.3). |
| **Language**           | Yes        | Document language. Supported: English, French, Arabic, Spanish, Russian, Chinese, Portuguese, German. |
| **Deadline Date**      | No         | Submission deadline for the event. Used for deadline tracking and visual indicators on the event list. |
| **Task Description**   | No         | Rich text description of the event task. Uses the Simple Editor (see §12). |

### 6.2 Deputy–Supervisor Linking

Supervisors are **linked to Deputies**. When the event creator selects a Deputy from
the dropdown, the Supervisor dropdown is filtered to only show Supervisors associated
with that Deputy.

This linking is defined in the admin panel when setting up department/Deputy relationships.

### 6.3 Section Definition

During event creation, the creator defines the **sections** that compose the document:

- Each section has a **title** and is assigned to **one or more departments**.
- At least one section must be defined.
- Sections can be **added after event creation**.
- If all of a section's departments match the Document Submitter's home department, it follows the shorter (no-curator) chain.
- If any of a section's departments differ from the Document Submitter's department, the section follows the cross-department chain for those departments.
- When a section has multiple departments, each department's chain runs in parallel; once all complete, the section proceeds to the Curator/DS level.

The system automatically generates the correct **workflow steps** for each section based on:
1. The section's assigned departments
2. The Document Submitter role and department
3. Whether "Curator required" is enabled
4. The event's country (determines eligible pipeline users)
5. Which roles exist in each department (missing levels are skipped)

### 6.4 Assignment Logic

- If **Deputy is Document Submitter**: Select a Deputy → define sections (any departments) → all sections flow up to the Deputy.
- If **Supervisor is Document Submitter**: Select Supervisor → optionally enable "Curator required" → if enabled, select a Deputy (who acts as Curator) → define sections → own-dept sections skip curator, cross-dept sections go through curator if enabled.
- If **Senior Editor is Document Submitter**: Select Senior Editor → optionally enable "Curator required" → if enabled, select a Deputy (who acts as Curator) → define sections → own-dept sections skip curator, cross-dept sections go through curator if enabled.

### 6.5 Event Templates

Users can create **event templates** to avoid re-entering event details manually each time.
A template saves:
- Section structure (titles and department assignments)
- Document Submitter role
- Curator required toggle

Templates are **user-created and user-owned** — each user manages their own templates.
When creating a new event from a template, the saved configuration is pre-filled and can be
adjusted before finalizing.

See §8.10–8.12 for the template data model.

---

## 7. Progress Bar

### 7.1 Per-Section Progress

Since documents are composed of sections with independent approval chains, the progress
bar displays **per-section status**. Each section shows its own chain progression.

#### Section-Level Progress Display

Each section shows its chain as a row/track:

**Example — Supervisor (Dept A) is Document Submitter, Curator enabled:**
```
Section "Budget" (Dept A — home dept):
  [Editor ✓] → [SC(A) ●] → [Supervisor A ○]

Section "Legal Review" (Dept B — cross-dept):
  [Editor ✓] → [SC(B) ✓] → [Supervisor B ✓] → [Curator ●] → [SC(A) ○] → [Supervisor A ○]

Section "Joint Analysis" (Dept B + Dept C — multi-dept):
  Dept B: [Editor ✓] → [SC(B) ✓] → [Supervisor B ✓] ──┐
  Dept C: [Editor ●] → [SC(C) ○] → [Supervisor C ○] ──┤→ [Curator ○] → [SC(A) ○] → [Supervisor A ○]
```

Legend: `✓` = Approved, `●` = In Progress, `○` = Pending

### 7.2 Overall Document Status

The overall document status is derived from the status of all its sections:

- **Draft** — Event created but workflow not started
- **In Progress** — At least one section is being worked on
- **Awaiting Final Approval** — All sections have reached the Document Submitter and await final sign-off
- **Completed** — All sections approved by the Document Submitter
- **Returned** — One or more sections have been sent back for revision

### 7.3 Status Indicators (Per Step)

Each step in a section's progress bar shows:
- **Pending** — Not yet reached
- **In Progress** — Currently being reviewed by this role
- **Approved** — This role has approved the section
- **Returned** — This role has sent the section back for revision

---

## 8. Data Model (High-Level)

### 8.1 Country

```
Country {
  id
  name_en: string              // English name (unique)
  code: string                 // ISO-2 country code (unique)
  created_at
  updated_at
}
```

Seeded with the full ISO country list (~195 countries). Countries are permanent and cannot be removed.

### 8.2 Country Assignment

```
CountryAssignment {
  user_id: FK → User           // PRIMARY KEY part 1
  country_id: FK → Country     // PRIMARY KEY part 2
}
```

Many-to-many link between users and countries. Only applicable for Editor and
Senior Editor roles. Supervisors and Deputies do not have country assignments.

### 8.3 Department / Agency

```
Department {
  id
  name
  is_external: boolean    // true for non-Ministry organizations
  created_at
  updated_at
}
```

### 8.4 User

```
User {
  id
  full_name
  username: string (unique)        // Login identifier
  email
  password_hash: string            // Bcrypt/argon2 hash — never store plaintext
  role: enum [ADMIN, PROTOCOL, DEPUTY, SUPERVISOR, SUPER_COLLABORATOR, COLLABORATOR]
  department_id: FK → Department (nullable) // Null for Admin users
  is_external: boolean
  must_change_password: boolean (default true)  // Forces password change on first login
  created_at
  updated_at
}
```

Country assignments are managed via the `CountryAssignment` join table (§8.2), not as a
direct field on the User model. Only Editor and Senior Editor roles have country assignments.

### 8.5 Deputy–Supervisor Link

```
DeputySupervisorLink {
  id
  deputy_id: FK → User (where role = DEPUTY)
  supervisor_id: FK → User (where role = SUPERVISOR)
}
```

This defines which Supervisors a Deputy oversees, enabling the filtered dropdown in event creation.

### 8.6 Event

```
Event {
  id
  title
  description
  country_id: FK → Country (NOT NULL)       // Each event is for exactly one country
  document_submitter_role: enum [DEPUTY, SUPERVISOR, SUPER_COLLABORATOR]
  document_submitter_id: FK → User          // The specific user who is the final approver
  deputy_id: FK → User (nullable)           // The assigned Deputy (as submitter or curator)
  curator_required: boolean (default false)  // Whether Deputy reviews cross-dept sections
  language: enum [EN, FR, AR, ES, RU, ZH, PT, DE]  // Document language
  deadline_date: date (nullable)                    // Submission deadline
  occasion: text (nullable)                         // Task description (rich text HTML)
  is_active: boolean (default true)                 // Whether the event is active
  ended_at: datetime (nullable)                     // When the event was ended
  status: enum [DRAFT, IN_PROGRESS, COMPLETED, ARCHIVED]
  created_at
  updated_at
}
```

### 8.7 Section

```
Section {
  id
  event_id: FK → Event
  title: string
  status: enum [PENDING, IN_PROGRESS, APPROVED, RETURNED]
  created_at
  updated_at
}
```

Departments are assigned to sections via the `SectionDepartment` join table (§8.8).
Each section generates its own set of workflow steps. When a section has multiple departments,
each department's chain runs in parallel; the section proceeds to the Curator/DS level once all complete.

### 8.8 Section–Department Assignment

```
SectionDepartment {
  section_id: FK → Section         // PRIMARY KEY part 1
  department_id: FK → Department   // PRIMARY KEY part 2
}
```

Many-to-many link between sections and departments. A section can be assigned to one or more departments.

### 8.9 Document Workflow Step

```
WorkflowStep {
  id
  section_id: FK → Section                  // Steps belong to a section, not directly to an event
  department_id: FK → Department (nullable) // Which department track this step belongs to (null for Curator/DS steps)
  step_order: integer
  role_label: string          // "Editor", "Senior Editor", "Curator", "Supervisor", "Deputy"
  assigned_user_id: FK → User
  status: enum [PENDING, IN_PROGRESS, APPROVED, RETURNED]
  reviewed_at: datetime (nullable)
  comments: text (nullable)
}
```

### 8.10 Event Template

```
EventTemplate {
  id
  name: string                               // User-defined template name
  created_by_id: FK → User                   // The user who created this template
  document_submitter_role: enum [DEPUTY, SUPERVISOR, SUPER_COLLABORATOR]
  curator_required: boolean (default false)
  created_at
  updated_at
}
```

Templates are user-created and user-owned — each user manages their own templates.

### 8.11 Event Template Section

```
EventTemplateSection {
  id
  template_id: FK → EventTemplate
  title: string
  sort_order: integer
}
```

### 8.12 Event Template Section–Department

```
EventTemplateSectionDepartment {
  template_section_id: FK → EventTemplateSection   // PRIMARY KEY part 1
  department_id: FK → Department                    // PRIMARY KEY part 2
}
```

### 8.13 Section Return Request

```
SectionReturnRequest {
  id
  event_id: FK → Event
  section_id: FK → Section
  requested_by_user_id: FK → User
  requested_by_name: string              // Denormalized for display
  requested_by_role: string              // Role of the requester
  broadcast_above_role: string            // All roles above this role are notified
  note: text (nullable)                  // Optional reason for the request
  created_at
}
```

Used by the "Ask to Return" feature (§15). Records are auto-deleted when any notified role
takes an action (approve or return) on the section.

### 8.14 Section History

```
SectionHistory {
  id
  event_id: FK → Event
  section_id: FK → Section
  action: enum [saved, submitted, returned, approved, asked_to_return]
  from_status: string (nullable)         // Status before action
  to_status: string                      // Status after action
  user_id: FK → User (nullable)
  user_name: string (nullable)           // Denormalized for display
  user_role: string (nullable)           // Role at time of action
  note: text (nullable)                  // Comment (e.g., on return actions)
  acted_at: timestamp
}
```

Index: `(event_id, section_id, acted_at)` for fast lookups. See §19 for the full history feature.

### 8.15 Section Comment

```
SectionComment {
  id
  event_id: FK → Event
  section_id: FK → Section
  user_id: FK → User
  anchor_id: string (nullable)           // Text anchor ID in editor content
  content: text
  created_at
}
```

### 8.16 Section Content

```
SectionContent {
  id
  event_id: FK → Event
  section_id: FK → Section
  html_content: text (default '')        // Section content (HTML with track changes markup)
  status: string                         // Current workflow status (see §20 for full enum)
  status_comment: text (nullable)        // Comment when returned
  original_submitter_role: string (nullable)  // Role that first submitted this section
  return_target_role: string (nullable)       // When returned, who it goes back to
  last_updated_by_user_id: FK → User
  last_updated_at: timestamp
  last_content_edited_at: timestamp      // When content itself was last edited
  last_content_edited_by_user_id: FK → User
}
```

Unique constraint: `(event_id, section_id)`. See §20 for full status enum and workflow logic.

---

## 9. Admin Panel Requirements

### 9.1 Department Management
- CRUD operations for departments/agencies
- View department members and their roles

### 9.2 User Management
- Create/edit/deactivate users
- Assign role and department
- Set external flag
- Manage country assignments (for Editor and Senior Editor roles)
  - Region-based grouping in UI for easier selection (Neighbors, EU, Asia, Africa, etc.)
  - Hierarchical checkboxes: select a region to toggle all countries in that region

### 9.3 Deputy–Supervisor Linking
- Interface to define which Supervisors are overseen by which Deputies
- This drives the filtered dropdown behavior in event creation

---

## 10. Notification System

### 10.1 Email Notifications

Users receive email notifications in the following scenarios:
- **Event created** — All participating users are notified when an event is created.
- **Section reaches user's level** — A user is notified when a section arrives at their step in the workflow chain.
- **Section returned** — The original editor level is notified when a section is returned for revision.

### 10.2 Dashboard Notifications

Each user's dashboard displays **pending action notifications** — sections that are currently
at their level and require their review or editing. This ensures users can see at a glance
what work is waiting for them.

---

## 11. Resolved Design Decisions

The following questions were raised during design and have been resolved:

1. **Concurrent curator duties** — A Deputy can act as Curator for multiple concurrent documents. Users work on "sections" during the workflow; the work becomes a "document" only after the Document Submitter submits it to the library.
2. **Role consistency** — Users hold their assigned role. The only contextual change is that a Deputy acts as Curator when they are not the Document Submitter but are required to participate.
3. **Event templates** — Implemented in §6.5. Users can create templates to avoid re-entering event details.
4. **Notification system** — Implemented in §10. Email + dashboard notifications.
5. **Return flow** — Documented in §5.2 rule 6. Returns go to the original editor level, not one step back.
6. **Section-level UX** — See the reference project for section visualization approach.
7. **Cross-department auto-assignment** — Documented in §5.2 rule 7. Editors and Senior Editors are automatically pulled from the assigned department's roster.
8. **Parallel sections** — Documented in §5.1. Sections are worked on in parallel.
9. **Section addition** — Documented in §5.1. Sections can be added after event creation.
10. **Region groupings** — Documented in §3.4. Use the same groupings as the previous system.
11. **Country permanence** — Documented in §3.4. Countries are permanent; no deactivation needed.

---

## 12. Rich Text Editor

### 12.1 Overview

The system uses a **custom-built rich text editor** (no external library dependency). The editor is based on `contenteditable` and provides Word-style track changes, inline comments, and comprehensive formatting.

### 12.2 Primary Editor (RichEditor)

The main editor is used for section content editing within the document workflow.

**Core features:**
- **Track changes** — Word-style revision tracking with an 8-color author palette. Insertions and deletions are marked inline with author attribution and timestamps.
- **Inline comments** — Users can add comments and comment threads anchored to specific text ranges, displayed as margin balloons.
- **Format change tracking** — Tracks formatting changes (bold, italic, color, etc.) as distinct revisions.
- **Context menu** — Right-click to insert tables.
- **Fullscreen mode** — A4 paper layout for focused editing.
- **Dark mode** — Full dark mode support.
- **Responsive** — Adapts to different screen sizes.

**Formatting options:**
- Bold, Italic, Underline
- Headings (H2, H3)
- Lists (Bullet, Numbered)
- Text alignment (Left, Center, Right, Justify)
- Text color with custom palette picker
- Font selection: Arial, Sylfaen, Calibri, Noto Sans Georgian, Noto Serif Georgian, FiraGO
- Font sizes: 8–72pt
- Format removal (clear formatting)

**API surface:**
```
GCP.RichEditor({
  container,         // DOM element to render into
  initialHtml,       // Initial HTML content
  authorName,        // Current user's name (for track changes attribution)
  sectionTitle,      // Section label
  onCommentsClick,   // Callback for comments panel toggle
  onDeleteComment,   // Callback when a comment is deleted
  onReplyComment     // Callback when a comment reply is added
})
```

### 12.3 Simple Editor

A lightweight variant used for task descriptions, notes, and other short-form rich text fields.

**Features:** Bold, Italic, Underline, Text color only.

**API surface:**
```
GCP.createSimpleEditor(container, {
  placeholder: 'Enter text...'
})
```

### 12.4 Supported Fonts

The following fonts are bundled as TTF files for both editor display and document export:

| Font | Variants | Purpose |
|------|----------|---------|
| Arial | Regular, Bold | Latin text |
| Calibri | Regular, Bold | Latin text |
| FiraGO | Regular, Bold | Multi-script |
| Noto Sans Georgian | Regular | Georgian script |
| Noto Serif Georgian | Regular | Georgian script (serif) |
| Sylfaen | Regular | Georgian script |

---

## 13. Icons & Assets

### 13.1 Icon System

The system uses **custom SVG icons** — no external icon library (no FontAwesome, Material Icons, etc.).

**Implementation technique:**
- SVG files stored as static assets
- CSS `mask-image` property with `--icon-url` CSS variables
- Rendered via `::before` pseudo-elements
- Colors controlled via `background-color: currentColor`, allowing CSS-based color theming
- Sizes vary by context (20px, 22px, 24px, 28px)

### 13.2 Action Icons

The following SVG icons are used for document and workflow actions:

| Icon | Usage |
|------|-------|
| `approve-icon.svg` | Approve a section |
| `ask_to_return_icon.svg` | Ask to return a section |
| `edit-icon.svg` | Edit a section |
| `end_event-icon.svg` | End an event |
| `export-pdf-icon.svg` | Export to PDF |
| `export-word-icon.svg` | Export to Word |
| `files-icon.svg` | View attached files |
| `open-icon.svg` | Open a document |
| `return-icon.svg` | Return a section |
| `save-icon.svg` | Save changes |
| `side-panel-icon.svg` | Toggle side panel |
| `submit-icon.svg` | Submit a section |
| `upload-icon.svg` | Upload a file |
| `view-icon.svg` | View/preview a document |
| `portal-logo-new.svg` | Application logo |

### 13.3 Sidebar Navigation Icons

Navigation icons are embedded as inline SVGs in the application shell:
- Logo, Dashboard, Calendar, Library, Statistics, Logout, User profile, Menu, Close

### 13.4 Icon Color Conventions

Icons use semantic color coding via CSS variables:
- **Submit** — Blue (`#1d4ed8`)
- **Approve** — Green (`#16a34a`)
- **Return / Ask to Return** — Red (`#dc2626`)
- **Save, Edit, View** — Default text color (neutral)

---

## 14. Library Page

### 14.1 Purpose

The Library page is the **approved-document viewing and export portal**. It displays documents that have completed the approval workflow and been submitted by the Document Submitter.

### 14.2 Access Control

All roles can access the Library, but visibility is **scoped to participation**:
- Users can only see documents for events they **participated in**.
- If a user did not participate in an event, that event's documents are not visible to them.
- This applies equally to all roles, including Editors.

### 14.3 Filters

| Filter | Type | Behavior |
|--------|------|----------|
| **Country** | Dropdown | Filter documents by country. Default: "All countries". |
| **Keyword search** | Text input | Searches across document title, country name, and approver name. Real-time filtering. |
| **Date** | Date picker | Filters by approval date (exact match). |

All filtering is client-side after initial data load. Filters combine with AND logic.

### 14.4 Views

- **Table view** (desktop): Columns — Event title, Country (colored badge), Language (badge), Approval date (DD.MM.YYYY), Approver name.
- **Card view** (mobile): Responsive card grid with the same data fields.

### 14.5 Document Actions

#### Preview
Opens a modal displaying the full document content:
- Shows event title and country
- Renders all required sections in order with their HTML content
- Track changes markup is hidden (insertions shown as plain text, deletions hidden)
- Shows "Last updated" timestamp

#### Export to PDF
- Modal with checklist of all document sections (all checked by default)
- "Select all / Select none" toggles
- Uses **html2pdf.js** (v0.10.1) for client-side PDF generation
- Settings: A4 portrait, 0.5-inch margins, JPEG images at 0.98 quality, 2x canvas scale
- Track changes are **hidden** in PDF output (accepted view)
- Body text is **justified** (see "Justified body text" below)
- Content is kept inside the page (see "Fitting the PDF page" below)
- Filename: slugified document title + `.pdf`

#### Export to Word
- Modal with same section checklist as PDF export
- Uses **docx** library (v8.5.0) for client-side DOCX generation
- **Track changes are preserved as native Word revisions:**
  - `<ins>` elements → `InsertedTextRun` (Word insertion revision)
  - `<del>` elements → `DeletedTextRun` (Word deletion revision)
  - Each revision carries author name, timestamp, and unique revision ID
  - Users can accept/reject revisions natively in Microsoft Word
- **Supported formatting in export:** Bold, Italic, Underline, Strikethrough, Superscript, Subscript, Font family, Font size, Text color, Headings (H1–H4), Bullet and numbered lists (up to 9 nesting levels), Text alignment
- Page layout: 1-inch margins, A4
- Body text is **justified** (see "Justified body text" below)
- Font names are referenced (not embedded) — Word uses local fonts or substitutes
- Tables are flattened to tab-delimited text (not native Word tables)
- Filename: slugified title + `.docx` (max 80 chars)

#### Justified body text

Exported documents circulate as formal ministry papers, so body prose is set
flush to both margins. `justifyBodyHtml()` in `frontend/js/core/library-doc.js`
normalises each section's HTML once, before it reaches either exporter — the PDF
renders the resulting inline styles directly, and the Word path converts them
through `getAlignment()` in `docx-export.js`, which already maps `justify` to
`AlignmentType.BOTH` (OOXML `<w:jc w:val="both"/>`). Neither exporter needed
changing.

- **Justified:** paragraphs and list items, including any the author had
  explicitly centred or right-aligned — the exported document is uniform by
  design.
- **Left as authored:** headings, discussion-point topics, the document title
  block, and anything inside a table (justifying a narrow column opens ugly
  gaps between words).
- The read-only Preview goes through the same helper, so what is on screen
  matches the exported file. The editing canvas is unchanged.
- Justification never stretches the last line of a paragraph, so single-line
  text — headings, the Context / Additional Information labels — renders
  identically either way.
- All generation happens client-side (no backend processing)

#### Fitting the PDF page

html2pdf renders the whole document into one tall canvas and then slices it into
fixed-height bands, so nothing about the export is page-aware by default. Two
things had to be added, both in `frontend/js/core/library-doc.js`.

**Right edge — `constrainForPdf()`.** html2pdf builds its own container at
exactly the printable width (210 mm − 2 × 12.7 mm = 184.6 mm, about 698 CSS px)
and html2canvas crops at that box: anything laid out wider is rasterised off the
edge and silently disappears. The editor's own protections are scoped to
`.gcp-re-body` and do not travel with the content, so the export instead inherits
the app's *global* table styling, which is wider. `constrainForPdf()` restores
them as inline styles on the section HTML: `overflow-wrap` on body blocks so a
long URL can break, `max-width: 100%` on images, `width: 100%; table-layout:
fixed` on tables, the editor's narrower cell padding, and no uppercasing on
`<th>`. The export wrapper also carries `padding-right: 3px` — justified lines
end flush at the measure, where ragged-right lines used to stop ~6 px short.

**Page breaks — `alignCanvasToPages()`.** html2pdf's `pagebreak` plugin measures
elements in the *live* DOM and inserts spacers to push straddling ones down, but
html2canvas rasterises a re-laid-out clone, and the two disagree: measured on a
four-page export, the clone's lines sat between 1.5 px above and 10 px below the
live layout, drifting further down the document. The plugin also aligns to
`floor(inner.height in px)` = 1026 CSS px while the slicer cuts every
`floor(canvasWidth × ratio) / scale` = 1026.5 CSS px. Paragraphs it had already
moved were still sliced through the glyphs.

Pagination is therefore done on the canvas, which is the thing actually being
cut. Between `toCanvas()` and `toPdf()` the export walks each upcoming band
boundary, retreats to the nearest near-blank row (up to 30 % of a page) and pads
the page out to full height from there. Every boundary then falls in whitespace
by construction, whatever the clone's layout turned out to be.

- A row counts as a cut point at ≤ 2 % ink, so a break between two table rows —
  which still crosses the vertical borders — is treated as clean. Long tables
  split between rows rather than being pushed whole.
- A block taller than the search window (a full-page image) is cut where it
  falls, as before. Nothing loops or is dropped.
- If the canvas is tainted — a cross-origin image the browser will not let us
  read back — alignment is skipped and the old geometric slicing applies, rather
  than the export failing.

#### View Files
Opens a modal listing all uploaded files for the event:
- File metadata table: name (clickable download link), section label, upload date, uploader name, file size (KB)
- Authenticated file download via JWT token

### 14.6 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/library` | GET | List approved documents. Optional `country_id` filter. |
| `/api/library/document` | GET | Full document content with all sections. Params: `event_id`, `country_id`. |
| `/api/library/files` | GET | List uploaded files for an event. Param: `event_id`. |
| `/api/workflow/files/download` | GET | Download individual file. Params: `event_id`, `section_id`, `filename`. |

---

## 15. Ask to Return

### 15.1 Overview

"Ask to Return" is a **request-based workflow mechanism** that allows a user to request that the current holder return a section, even when the section is not at the requester's review stage. This is distinct from a **direct return** (§5.2 rule 6), which can only be performed by the user who currently holds the section.

### 15.2 When It Applies

| Condition | Action Available |
|-----------|-----------------|
| Section IS at the user's stage | User should use **direct Return** (not Ask to Return) |
| Section is NOT at the user's stage | User can use **Ask to Return** |

The system enforces this: if the section is already at the requester's stage, the API returns an error instructing them to use direct Return instead.

### 15.3 Flow

1. **User clicks "Ask to Return"** — A dropdown prompts for an optional note: "Why do you need it back?"
2. **System records the request** — Inserts a record into `SectionReturnRequest` (§8.13). The section status remains **unchanged**.
3. **All roles above the requester are notified** — Every role in the chain above the requester sees the notification on their dashboard: "Return requested by [name]: [note or '(no comment)']"
4. **Any notified role can act:**
   - **Returns the section** → return request is auto-deleted
   - **Approves the section** → return request is auto-deleted
   - **Ignores** → request remains visible as a notification

### 15.4 Key Characteristics

- **Non-blocking**: The request does not change the section's workflow status. It is purely a notification.
- **Broadcast upward**: All roles above the requester in the pipeline are notified, and any of them can act on it (not just the current holder).
- **Auto-clearing**: Requests are automatically deleted when any notified role takes an action (approve or return) on the section.
- **Audited**: An `asked_to_return` action is recorded in the section history for audit trail purposes.

### 15.5 Comparison with Direct Return

| Aspect | Ask to Return | Direct Return |
|--------|---------------|---------------|
| **Who triggers** | Any user when section is NOT at their stage | Current holder when section IS at their stage |
| **Who sees it** | All roles above the requester in the chain | N/A — only the holder acts |
| **Who can act** | Any notified role can return the section | Only the current holder |
| **Effect on status** | None — notification only | Changes status to returned; section goes back to original editor |
| **Database** | Inserts into `SectionReturnRequest` | Updates section/workflow step status |
| **Clearing** | Auto-deleted when any notified role acts | N/A — status change is the action |

### 15.6 API Endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflow/ask-to-return` | POST | Create a return request. Body: `eventId`, `sectionId`, `note` (optional). Returns `{ success, directedToRole }`. |

---

## 16. Calendar / Event List

### 16.1 Overview

The Calendar page is an **event management interface** that displays events as a filterable, paginated table/card list. It is **not** a visual calendar grid — it shows events in tabular format with tabs for upcoming and past events.

### 16.2 Layout

- **Table view** (desktop): Responsive table with event details
- **Card view** (mobile): Card grid layout
- **Tabs**: "Upcoming" (active, non-ended events) and "Past events" (ended events)

### 16.3 Filters & Pagination

| Control | Type | Behavior |
|---------|------|----------|
| **Keyword search** | Text input | Searches title, country name, submitter name. Real-time. |
| **Date filter** | Date picker | Filters by deadline date. |
| **Country filter** | Dropdown | Filter by specific country. |

- Filters combine with AND logic, applied client-side
- Pagination: 5 events per page with previous/next and direct page number buttons

### 16.4 Event Data Displayed

Each event row/card shows:
- Event title
- Country (colored badge)
- Deadline date (with visual indicators: **red** for overdue, **yellow** for upcoming)
- Document Submitter role
- Language
- Status (active/ended)

### 16.5 Actions

#### Create Event
- Available to: Deputy, Supervisor, Senior Editor, Admin, Protocol
- Form includes: country, title, DS role, curator required toggle, deadline date, language, required sections + departments (hierarchical checklist), task description (Simple Editor)
- Form resets on success

#### View Event
- Available to: all authenticated users
- Modal shows: title, country, deadline, submitter roles, language, task description (rendered HTML), involved deputies, required sections with nested departments, created/ended timestamps

#### Edit Event
- Available to: managers (Deputy, Supervisor, Senior Editor, Admin) on non-ended events only
- All fields are editable; section/department checkboxes restore their state

#### End Event
- Available to: Admin, Deputy, Supervisor, Protocol
- Confirmation prompt required
- Marks event as ended (`ended_at` = now, `is_active` = false)
- Event moves from "Upcoming" to "Past events" tab

### 16.6 Relationship to Workflow

- **Calendar** shows **what** needs doing — events, deadlines, and section requirements
- **Dashboards** show **how** it's progressing — per-section status, current holder, approval state
- **Editor** shows **where** content is created — rich editor for each section
- **Library** shows **what's done** — approved documents available for export

---

## 17. Dashboards

### 17.1 Overview

Each role has its own dashboard with tailored views and actions. Dashboards are the primary interface for users to monitor and act on their assigned sections.

### 17.2 Common Layout

All dashboards share:
- **Sidebar navigation** (shared app shell)
- **Event selector dropdown** — switch between assigned events
- **Required sections** — table (desktop) / card (mobile) view
- **Per-section row/card**: status label, last updated info, progress bar (§20), action buttons
- **Upcoming events panel**

### 17.3 Dashboard Capabilities Matrix

| Dashboard | Role | Can Edit | Can Submit | Can Approve | Can Return | Ask to Return | Send to Library | Paper Preview |
|-----------|------|----------|------------|-------------|------------|---------------|-----------------|---------------|
| Editor | COLLABORATOR | Own sections | Yes (→ Senior Editor) | No | No | Yes | No | No |
| Senior Editor | SUPER_COLLABORATOR | Assigned sections | Yes (→ Supervisor/Curator) | Yes | Yes | Yes | Yes* | Yes |
| Supervisor | SUPERVISOR | All sections | No | Yes | Yes | Yes | Yes* | Yes |
| Deputy | DEPUTY | All sections | No | Yes | Yes | Yes | Yes* | Yes |

`*` Only when that role is the Document Submitter for the event.

### 17.4 Dashboard Details

- **Editor**: Sees only assigned sections. Can open editor and submit to Senior Editor. Can use "Ask to Return" for sections past their stage.
- **Senior Editor**: Sees all assigned sections. Has "Approve" + "Approve All" bulk button + "Open All Sections" button. "Send to Library" shown when SC is Document Submitter.
- **Supervisor**: Similar to Senior Editor. Cannot approve sections already past their stage. "Send to Library" when Supervisor is DS.
- **Deputy**: Approve sections + "Send to Library" button (when Deputy is DS). Can end events. Also acts as Curator for cross-department sections when curator_required=true.

### 17.5 Micro-Actions

Action buttons rendered per section:

| Action | Icon | Behavior |
|--------|------|----------|
| `open` | edit-icon | Navigate to editor (§18) |
| `submit` | submit-icon | Route to next tier (blue) |
| `approve` | approve-icon | Approve section with confirmation dialog (green) |
| `return` | return-icon | Return with comment via dropdown (red) |
| `ask-to-return` | ask-to-return-icon | Request return with optional note (red) |

### 17.6 Shared Helpers

- `renderUpperTierProgress()` — Progress bar HTML (§20)
- `attachSectionHistoryToggle()` — Mount history timeline on section (§19)
- `showCommentDropdown()` — Comment input for return/ask-to-return
- `openPaperPreview()` — Full document preview modal

### 17.7 Status Display

Each section row shows a human-readable status label mapped from the internal status string:
- `draft` → "Draft"
- `submitted_to_super_collaborator` → "At Senior Editor"
- `returned_by_supervisor` → "Returned by Supervisor"
- `approved_by_deputy` → "Approved (Deputy)"
- etc.

---

## 18. Editor Page

### 18.1 Single-Section Editor

The primary editing interface for section content.

**Layout:**
- **Topbar**: "Task Editor" title
- **Header**: Event title, country, section label (editable inline), status pill, last-updated info
- **Toolbar**: Action buttons (dynamically shown/hidden based on role + section status)
- **Content area**: Rich text editor (RichEditor from §12)
- **Comments**: Floating comment card anchored to text selections

### 18.2 Action Buttons

| Action | API Endpoint | Description |
|--------|-------------|-------------|
| **Save** | `POST /api/workflow/save` | Saves HTML content, records "saved" in history |
| **Submit** | `POST /api/workflow/submit` | Moves section to next pipeline stage |
| **Approve** | `POST /api/workflow/approve-section` | Approves section (Senior Editor and above) |
| **Return** | `POST /api/workflow/return` | Returns with optional comment |
| **Upload** | `POST /api/workflow/files/upload` | Upload files (multiple, base64 encoded) |
| **Ask to Return** | `POST /api/workflow/ask-to-return` | Request return with optional note |
| **View Files** | `GET /api/workflow/files` | Modal listing uploaded files |

Buttons are dynamically shown/hidden based on the user's role and the section's current status.

### 18.3 File Upload

1. Hidden file input (multiple files allowed)
2. Files read as base64 via FileReader
3. `POST /api/workflow/files/upload` with `{ eventId, sectionId, filename, mimeType, base64 }`
4. Files listed in modal: filename, upload date, uploader name, file size
5. Download via authenticated `GET /api/workflow/files/download` endpoint

### 18.4 Inline Comments

- Floating comment card (292px wide) positioned near text anchor or editor edge
- Shows user avatar (colored initials based on username hash), name, textarea
- Keyboard shortcuts: Ctrl+Enter to submit, Escape to cancel
- API: `POST /api/workflow/comments`, `DELETE /api/workflow/comments/{id}`, `GET /api/workflow/comments`

### 18.5 Editor-All (Multi-Section Review)

The "All Sections" page displays every required section for an event on a single page for comprehensive review.

**Access**: Available to **Senior Editor(A) and above** (Supervisor, Deputy, Minister). Accessed via "Open All Sections" button on their dashboards.

**Current reference implementation:**
- Sections rendered sequentially as cards
- Each card shows: section title (click-to-rename), status pill, last-updated info, return comment box
- Content displayed in a **read-only** RichEditor instance
- Comments fully functional: add, delete, reply
- Section labels editable inline

**UX improvement needed**: The sequential card layout needs a better, more user-friendly UI in the new system. Consider: collapsible accordion sections, sticky section navigation sidebar, section-jumping quick links, or a tabbed interface for easier navigation across many sections.

### 18.6 Autosave

No autosave — all saves are explicit via the Save button.

---

## 19. Section History

### 19.1 Overview

Every action on a section is recorded in the `SectionHistory` table (§8.14) for audit trail and progress visualization purposes.

### 19.2 Recorded Actions

| Action | Status Change | Note Stored |
|--------|--------------|-------------|
| `saved` | No change (from_status = to_status) | — |
| `submitted` | → `submitted_to_[next_role]` | — |
| `returned` | → `returned_by_[role]` | Reviewer's comment |
| `approved` | → `approved_by_[role]` | — |
| `asked_to_return` | No change | Requester's reason |

### 19.3 Timeline Visualization

History is displayed as a collapsible vertical timeline panel on dashboards and in the editor.

**Timeline structure:**
- Each pipeline stage is a row with a colored dot and role label
- Under each stage: events showing actor name, action tag, and timestamp

**Dot colors by stage status:**
- **Green** — Stage completed (actor approved/submitted)
- **Blue** — Active (current stage)
- **Orange** — Returned (section was sent back from this stage)
- **Gray** — Pending (stage not yet reached)

**Smart features:**
- Consecutive saves by the same actor are collapsed: "Edited (×3)"
- "No action recorded" placeholder for stages reached without explicit history
- Stages are filtered based on the event's `curatorRequired` flag and `documentSubmitterRole`
- Timeline starts from `originalSubmitterRole` (earlier stages are omitted)

### 19.4 API Endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflow/section-history` | GET | Returns `{ history: [...] }` ordered chronologically. Params: `event_id`, `section_id`. |

### 19.5 Limitations

- **No content snapshots**: History tracks actions, not content diffs. Only the current HTML is stored in `SectionContent` (§8.16).
- Content diff/comparison view could be added as a future enhancement.

---

## 20. Progress Bar / Status Grid

### 20.1 Overview

Each section in the workflow has a visual progress bar showing its journey through the approval pipeline. The progress bar is rendered on dashboards and is driven by the `SectionContent` table (§8.16) and `SectionHistory` table (§8.14).

### 20.2 Section Status Enum

The full set of possible section statuses:

```
draft,
submitted_to_super_collaborator, returned_by_super_collaborator, approved_by_super_collaborator,
submitted_to_curator, returned_by_curator, approved_by_curator,
submitted_to_supervisor, returned_by_supervisor, approved_by_supervisor,
submitted_to_deputy, returned_by_deputy, approved_by_deputy
```

### 20.3 Current Holder Logic

The `currentHolderRole()` function determines who currently holds a section based on its status:

| Status Pattern | Current Holder |
|----------------|---------------|
| `draft` / `in_progress` | `original_submitter_role` |
| `returned_*` | Explicit `return_target_role` |
| `submitted_to_X` | Role X |
| `approved_by_X` | Next role in the chain |

**`original_submitter_role`**: The role that first edited/submitted this section. Any role can be the first editor (§5.2 rule 9). Determines where the progress bar starts — earlier steps are hidden entirely, not greyed out.

**`return_target_role`**: Set when a section is returned; records which role the section goes back to. Cleared when the section is re-submitted.

### 20.4 Status Grid API

`GET /api/workflow/status-grid?event_id=X` returns:

```json
{
  "event_id": number,
  "documentSubmitterRole": string,
  "curatorRequired": boolean,
  "sections": [{
    "sectionId": number,
    "sectionLabel": string,
    "status": string,
    "statusComment": string | null,
    "lastUpdatedAt": timestamp,
    "lastUpdatedBy": string | null,
    "isAssigned": boolean,
    "originalSubmitterRole": string | null,
    "returnTargetRole": string | null,
    "returnRequest": { "from": string, "fromRole": string, "note": string, "at": timestamp } | null,
    "stepNames": {
      "editor": string | null,
      "superEditor": string | null,
      "curator": string | null,
      "supervisor": string | null,
      "deputy": string | null
    }
  }]
}
```

`stepNames` maps each pipeline role to the name of the user who acted at that stage (from section history). The progress bar shows actor names instead of role labels when available.

### 20.5 Progress Bar Rendering

The `renderUpperTierProgress()` function generates a numbered-step progress bar:

**Steps shown** (from `originalSubmitterRole` onward — earlier steps omitted):
- Editor → Senior Editor → [Curator] → Supervisor → Deputy → Approved
- Steps vary by `documentSubmitterRole`:
  - SC is DS: Editor → Senior Editor → Approved
  - Supervisor is DS: Editor → Senior Editor → [Curator] → Supervisor → Approved
  - Deputy is DS: Editor → Senior Editor → [Curator] → Supervisor → Deputy → Approved
- Curator step shown only when `curatorRequired=true` and section is cross-department

**Step states:**
- `done` — Completed (blue gradient circle, numbered)
- `active` — Current step (blue with outer glow ring)
- `todo` — Pending (grey outline circle)
- `no-actor` — Completed but no actor recorded (faded at 45% opacity)

**Track**: Horizontal line with animated blue fill showing percentage complete.

**Labels**: Show actor name if available (from `stepNames`), otherwise role label.

**Awaiting state**: "Awaiting action" placeholder shown when a section has never been acted on (status = `draft`, no step names recorded).

---

## 21. Internationalization (i18n) & Language

### 21.1 Overview

The portal is built for the **Ministry of Economy of Georgia**. Georgian is the primary UI language, with English as a secondary language.

### 21.2 Language Configuration

| Setting | Value |
|---------|-------|
| **Primary language** | Georgian (ka) |
| **Secondary language** | English (en) |
| **Default for new users** | Georgian |
| **Scope** | UI language only — document content language is separate (set per event in §6.1) |

### 21.3 Architecture

- **Key-based i18n system**: All UI strings (labels, buttons, messages, status names, role names) use translation keys (e.g., `t('dashboard.title')`).
- **Language files**: JSON files per language (`ka.json`, `en.json`) containing all translated strings.
- **Language toggle**: Users can switch between Georgian and English via a toggle in the app shell (sidebar or topbar).
- **User preference**: The selected language is persisted per user (stored in user profile or local storage).

### 21.4 Georgian Font Support

The system bundles Georgian fonts (see §12.4): Noto Sans Georgian, Noto Serif Georgian, Sylfaen, FiraGO. These must be used for Georgian UI text rendering as well as document content.

---

## 22. Dark Mode / Light Mode

### 22.1 Overview

The portal supports both dark and light themes.

### 22.2 Configuration

| Setting | Value |
|---------|-------|
| **Toggle** | Theme switcher in the app shell (sidebar or topbar) |
| **Default** | Follow system preference (`prefers-color-scheme` media query), with manual override |
| **Persistence** | Per user (stored in user profile or local storage) |
| **Scope** | All pages — dashboards, editor, calendar, library, statistics, admin panel |

### 22.3 Implementation

- Use a `data-theme="dark"` attribute on `<body>` (matching the reference repo pattern).
- All component styles must support both themes via **CSS variables** or theme-aware selectors (`[data-theme="dark"]`).
- The RichEditor already has dark mode support (§12.2) — it must follow the app-level theme toggle.

---

## 23. Deployment

### 23.1 Platform

The portal will be deployed on **Render** (render.com).

### 23.2 Architecture

| Component | Render Service Type |
|-----------|-------------------|
| **Backend** | Web Service (Node.js) |
| **Frontend** | Static Site or same Web Service |
| **Database** | PostgreSQL (Render-managed or external) |

### 23.3 Environment Variables

Required environment variables (provided by the user from the Render dashboard):
- Database connection string
- JWT secret
- API keys (if applicable)
- Other deployment-specific configuration

Build and start commands will be configured based on the final project structure.
