# Event email drafts

When an event is created, Vector Portal prepares a local email draft for the event creator. The server resolves the event workflow participants and returns a subject, body, recipients with email addresses, and a list of participants who do not have email addresses.

The browser opens the user's default mail handler with a `mailto:` link. This only creates a draft on the user's machine; the portal does not send email, store the email content, or require SMTP/server mail credentials.

## Recipient rules

- Recipients are placed in `BCC` to protect participant privacy.
- Explicit workflow assignments are included: document submitter, deputy, and responsible supervisor where present.
- Section department participants are resolved using the same workflow-chain rules used by the dashboard.
- Country assignments are respected for workflow roles that are country-filtered elsewhere in the app.
- Curator participants are included when curator review is required.
- Duplicate users and duplicate email addresses are removed.
- Users without email addresses are skipped from the draft and shown to the creator as a warning.

## Fallback behaviour

Some mail clients and browsers reject very long `mailto:` URLs. If the generated draft is too long, the portal shows a copyable fallback with the `BCC`, subject, and body so the creator can paste them into a new message manually.

If the user's machine does not have a default mail app configured, the browser/operating system controls what happens. The event remains created even if the mail draft cannot be opened.
