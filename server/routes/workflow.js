const express = require('express');
const db = require('../db');
const { requireAuth, denyAnalyst } = require('../middleware/auth');
const { ROLES } = require('../helpers/roles');
const {
  STATUS,
  baseRole,
  buildChain,
  nextInChain,
  isFinalApprover,
  firstEditorRole,
  submittedToStatus,
  approvedByStatus,
  returnedByStatus,
  currentHolderRole,
  canPushSection,
  canPullSection,
} = require('../helpers/pipeline');
const { notifySectionTurn } = require('../helpers/notifications');

const router = express.Router();

// ─── Helper: resolve user full name + department from DB ──────────────────────
// JWT doesn't carry full_name, so we look it up for history/audit records.
async function resolveUser(jwtUser) {
  const { rows: [row] } = await db.query(
    'SELECT full_name, department_id FROM users WHERE id = $1', [jwtUser.id]
  );
  return {
    ...jwtUser,
    full_name: row ? row.full_name : jwtUser.username,
    department_id: row ? row.department_id : jwtUser.departmentId || null,
  };
}

// ─── Helper: load section context ─────────────────────────────────────────────

async function loadSectionContext(eventId, sectionId, jwtUser) {
  const { rows: [event] } = await db.query(
    `SELECT id, document_submitter_role, document_submitter_id, deputy_id,
            supervisor_id, curator_required, workflow_type, country_id,
            status AS event_status
     FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) return null;

  const { rows: [sc] } = await db.query(
    `SELECT status, original_submitter_role, return_target_role, last_updated_by_user_id
     FROM section_content WHERE event_id = $1 AND section_id = $2`,
    [eventId, sectionId]
  );
  if (!sc) return null;

  // Determine if section has cross-department assignments.
  // For Deputy DS, the "home department" is the Responsible Supervisor's
  // department, since Deputies oversee multiple departments.
  // Note: a MINISTER DS falls into the else branch and resolves dsDeptId from
  // the minister's (likely NULL) department. That's fine — Minister-DS events
  // always run in simple mode, where buildChain ignores dsRole and dsDeptId.
  let dsDeptId = null;
  if (event.document_submitter_role === 'DEPUTY' && event.supervisor_id) {
    const { rows: [sv] } = await db.query(
      'SELECT department_id FROM users WHERE id = $1', [event.supervisor_id]
    );
    dsDeptId = sv ? sv.department_id : null;
  } else {
    const { rows: [dsUser] } = await db.query(
      'SELECT department_id FROM users WHERE id = $1', [event.document_submitter_id]
    );
    dsDeptId = dsUser ? dsUser.department_id : null;
  }
  const { rows: deptRows } = await db.query(
    'SELECT department_id FROM section_departments WHERE section_id = $1', [sectionId]
  );
  const sectionDeptIds = deptRows.map(r => r.department_id);
  const isCrossDept = sectionDeptIds.some(d => d !== dsDeptId);

  const workflowType = event.workflow_type || 'advanced';
  const chain = buildChain(event.document_submitter_role, event.curator_required, isCrossDept, workflowType);

  // Resolve the user's effective role for THIS section. We honour the
  // amendment override here so every write handler picks up the same
  // canonical value via ctx.userRole — without it, save / submit /
  // return etc. compare the DS's JWT role (e.g. SUPERVISOR) to the
  // synthetic 'AMENDING_DS' holder and 403 the DS out of their own
  // amendment.
  let userRole = null;
  if (jwtUser) {
    if (sc.status === 'submitted_to_amending_ds'
        && jwtUser.id === event.document_submitter_id) {
      userRole = 'AMENDING_DS';
    } else {
      userRole = await effectiveRole(jwtUser, event, sectionDeptIds, chain);
    }
  }

  return {
    event,
    sectionStatus: sc.status || 'draft',
    originalSubmitterRole: sc.original_submitter_role,
    returnTargetRole: sc.return_target_role,
    lastUpdatedByUserId: sc.last_updated_by_user_id,
    chain,
    isCrossDept,
    dsDeptId,
    sectionDeptIds,
    workflowType,
    userRole,
  };
}

/**
 * Map user role to the effective pipeline step label for a given section.
 *
 * - A Deputy who oversees the section's department and is NOT the DS → CURATOR
 * - A user in the DS's home dept whose RECEIVING_ variant exists in the chain
 *   → RECEIVING_SUPER_COLLABORATOR or RECEIVING_SUPERVISOR
 * - Otherwise → the user's base role
 */
async function effectiveRole(user, event, sectionDeptIds, chain) {
  // Normalize department_id (JWT uses camelCase, resolveUser uses snake_case)
  const userDeptId = parseInt(user.department_id || user.departmentId) || null;
  // Deputy as Curator. In advanced mode the document submitter (a deputy) is
  // the final approver, not a mid-chain curator, so they're excluded here. In
  // simple mode there's no single submitter — there's a Document Owner — and a
  // Deputy owner *also* curates the sections in departments they oversee, so we
  // don't exclude them.
  const curatorEligible = event.workflow_type === 'simple'
    || event.document_submitter_id !== user.id;
  if (user.role === ROLES.DEPUTY && curatorEligible && sectionDeptIds) {
    const { rows } = await db.query(
      `SELECT 1 FROM deputy_department_links
       WHERE deputy_id = $1 AND department_id = ANY($2) LIMIT 1`,
      [user.id, sectionDeptIds]
    );
    if (rows.length > 0) return 'CURATOR';
  }

  // Check if user belongs to the receiving chain (home department)
  // But only if the user is NOT already acting as the section department's
  // actor for the same base role. A user in the section's department fills
  // the non-RECEIVING step; a user in the DS home department (but NOT in
  // the section's department) fills the RECEIVING_ step.
  if (chain && sectionDeptIds) {
    const receivingLabel = 'RECEIVING_' + user.role;
    if (chain.includes(receivingLabel)) {
      // If the user's base role is also in the chain as a non-receiving step
      // AND the user is in one of the section's departments, they are the
      // section department actor, not the receiving chain actor.
      const isInSectionDept = sectionDeptIds.includes(userDeptId);
      if (chain.includes(user.role) && isInSectionDept) {
        return user.role;
      }

      // Otherwise check if user is in the DS home department
      let homeDeptId = null;
      if (event.document_submitter_role === 'DEPUTY' && event.supervisor_id) {
        const { rows: [sv] } = await db.query(
          'SELECT department_id FROM users WHERE id = $1', [event.supervisor_id]
        );
        homeDeptId = sv ? sv.department_id : null;
      } else {
        const { rows: [dsUser] } = await db.query(
          'SELECT department_id FROM users WHERE id = $1', [event.document_submitter_id]
        );
        homeDeptId = dsUser ? dsUser.department_id : null;
      }
      if (homeDeptId && userDeptId === homeDeptId) {
        return receivingLabel;
      }
    }
  }

  return user.role;
}

// ─── POST /api/workflow/save ──────────────────────────────────────────────────

router.post('/save', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId, htmlContent } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    // Authorization: only the current holder can save, and only in editable statuses
    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);

    if (userRole !== holder) {
      return res.status(403).json({ error: `Section is held by ${holder}, not ${userRole}` });
    }

    await db.query(
      `UPDATE section_content
       SET html_content = $1,
           last_updated_by_user_id = $2,
           last_updated_at = now(),
           last_content_edited_at = now(),
           last_content_edited_by_user_id = $2
       WHERE event_id = $3 AND section_id = $4`,
      [htmlContent || '', req.user.id, eventId, sectionId]
    );

    // Record in history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role)
       SELECT $1, $2, 'saved', sc.status, sc.status, $3, u.full_name, $4
       FROM section_content sc, users u
       WHERE sc.event_id = $1 AND sc.section_id = $2 AND u.id = $3`,
      [eventId, sectionId, req.user.id, req.user.role]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/submit ────────────────────────────────────────────────

router.post('/submit', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);

    // Verify user is the current holder
    if (userRole !== holder) {
      return res.status(403).json({
        error: `Section is held by ${holder}, not ${userRole}`,
      });
    }

    // Verify section is in a submittable status (draft or returned)
    if (ctx.sectionStatus !== 'draft' && !ctx.sectionStatus.startsWith('returned_')) {
      return res.status(400).json({ error: `Cannot submit — section status is ${ctx.sectionStatus}` });
    }

    // Find the next role in the chain.
    // Simple-mode short-circuit: in simple workflow, the section's
    // department supervisor IS the final approver, so their "submit"
    // collapses into the final approval (no separate Approve click).
    const nextRole = nextInChain(userRole, ctx.chain);
    let toStatus;
    let historyAction = 'submitted';
    let didFinalApprove = false;
    if (!nextRole) {
      if (ctx.workflowType === 'simple' && isFinalApprover(userRole, ctx.chain)) {
        toStatus = approvedByStatus(userRole);
        historyAction = 'approved';
        didFinalApprove = true;
      } else {
        return res.status(400).json({ error: 'No next step in chain — use approve if you are the final approver' });
      }
    } else {
      toStatus = submittedToStatus(nextRole);
    }

    const fromStatus = ctx.sectionStatus;

    // Set original_submitter_role on first submit from draft
    const origRole = ctx.originalSubmitterRole || userRole;

    await db.query(
      `UPDATE section_content
       SET status = $1, original_submitter_role = $2,
           last_updated_by_user_id = $3, last_updated_at = now(),
           status_comment = NULL, return_target_role = NULL
       WHERE event_id = $4 AND section_id = $5`,
      [toStatus, origRole, req.user.id, eventId, sectionId]
    );

    // Update event to IN_PROGRESS if still DRAFT
    if (ctx.event.event_status === 'DRAFT') {
      await db.query("UPDATE events SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1", [eventId]);
    }

    // Record history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [eventId, sectionId, historyAction, fromStatus, toStatus, req.user.id, resolvedUser.full_name, userRole]
    );

    // Clear any pending return requests for this section
    await db.query(
      'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
      [eventId, sectionId]
    );

    // Auto-complete the event if the simple-mode short-circuit just
    // fired and every section is now approved.
    if (didFinalApprove) {
      await checkEventCompletion(eventId);
    }

    // Notify whoever now holds the section (no-op if it just auto-completed).
    await notifySectionTurn(db, {
      eventId, sectionId, actorUserId: req.user.id,
      holderRole: currentHolderRole(toStatus, origRole, null, ctx.chain),
    });

    res.json({ success: true, newStatus: toStatus });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/approve ───────────────────────────────────────────────

router.post('/approve', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId, comment } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);
    const isDS = req.user.id === ctx.event.document_submitter_id;

    // ── Amendment-approval branch ────────────────────────────────────
    // Reopened-event DS pull lands the section on
    // 'submitted_to_amending_ds'. Only the DS may approve from this
    // state, and the approval finalises the section under the DS's
    // own role (so it slots back into the existing approved_by_*
    // semantics that checkEventCompletion looks for).
    if (ctx.sectionStatus === 'submitted_to_amending_ds') {
      if (!isDS) {
        return res.status(403).json({ error: 'Only the Document Submitter can approve an amendment' });
      }
      const fromStatus = ctx.sectionStatus;
      // Use a dedicated final state so the chain bar's per-role actor
      // lookup never matches the DS into a chain slot. Still passes
      // checkEventCompletion's `startsWith('approved_by_')` test, so
      // simple-mode auto-publish kicks in once every section reaches
      // any approved_by_* state.
      const toStatus = 'approved_by_ds_amendment';

      await db.query(
        `UPDATE section_content
         SET status = $1, status_comment = $2,
             last_updated_by_user_id = $3, last_updated_at = now(),
             return_target_role = NULL
         WHERE event_id = $4 AND section_id = $5`,
        [toStatus, comment || null, req.user.id, eventId, sectionId]
      );
      // History row carries the synthetic role 'AMENDING_DS' instead
      // of the DS's JWT role. Same reasoning as the pull-section
      // history row above — keeps the chain bar's actor map clean.
      await db.query(
        `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role, note)
         VALUES ($1, $2, 'approved', $3, $4, $5, $6, $7, $8)`,
        [eventId, sectionId, fromStatus, toStatus, req.user.id,
         resolvedUser.full_name, 'AMENDING_DS', comment || null]
      );
      await db.query(
        'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
        [eventId, sectionId]
      );
      await checkEventCompletion(eventId);
      return res.json({ success: true, newStatus: toStatus });
    }

    // Must be submitted to this role
    if (userRole !== holder) {
      return res.status(403).json({
        error: `Section is held by ${holder}, not ${userRole}`,
      });
    }

    // Status must be "submitted_to_<role>"
    const expectedStatus = submittedToStatus(userRole);
    if (ctx.sectionStatus !== expectedStatus) {
      return res.status(400).json({
        error: `Cannot approve — section status is ${ctx.sectionStatus}, expected ${expectedStatus}`,
      });
    }

    const fromStatus = ctx.sectionStatus;
    const isSimpleDsOverride = ctx.workflowType === 'simple' && isDS;
    let toStatus;
    let isFinal;

    if (isFinalApprover(userRole, ctx.chain) || isSimpleDsOverride) {
      // Final approval — DS in simple mode gets the same shortcut as a
      // chain-final approver. Marks the section approved_by_<userRole>.
      toStatus = approvedByStatus(userRole);
      isFinal = true;
    } else {
      // Mid-chain approval — submit to the next role in the chain
      const nextRole = nextInChain(userRole, ctx.chain);
      toStatus = submittedToStatus(nextRole);
      isFinal = false;
    }

    await db.query(
      `UPDATE section_content
       SET status = $1, status_comment = $2,
           last_updated_by_user_id = $3, last_updated_at = now(),
           return_target_role = NULL
       WHERE event_id = $4 AND section_id = $5`,
      [toStatus, comment || null, req.user.id, eventId, sectionId]
    );

    // Record history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role, note)
       VALUES ($1, $2, 'approved', $3, $4, $5, $6, $7, $8)`,
      [eventId, sectionId, fromStatus, toStatus, req.user.id,
       resolvedUser.full_name, userRole, comment || null]
    );

    // Clear any pending return requests
    await db.query(
      'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
      [eventId, sectionId]
    );

    // If this was the final approval, check if all sections are approved → complete event
    if (isFinal) {
      await checkEventCompletion(eventId);
    }

    // Notify the next holder (no-op when this was the final approval).
    await notifySectionTurn(db, {
      eventId, sectionId, actorUserId: req.user.id,
      holderRole: currentHolderRole(toStatus, ctx.originalSubmitterRole, null, ctx.chain),
    });

    res.json({ success: true, newStatus: toStatus });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/return ────────────────────────────────────────────────

router.post('/return', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId, comment } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    // Return doesn't apply to a DS amendment — the section was already
    // approved before the reopen, so there's no chain step to return
    // it to. Frontend hides the button (dashboard + editor); this is
    // the server-side belt-and-suspenders.
    if (ctx.sectionStatus === 'submitted_to_amending_ds') {
      return res.status(400).json({
        error: 'Cannot return an amendment — approve or leave it open',
      });
    }

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);

    // Return goes back to the original editor level (§5.2 rule 6)
    const returnTarget = firstEditorRole(ctx.chain);
    const chain = ctx.chain || [];
    const effIdx = chain.indexOf(userRole);
    const holderIdx = chain.indexOf(holder);
    const targetIdx = chain.indexOf(returnTarget);
    const isHolder = userRole === holder;
    // A role AHEAD of the holder may return a section held below them — it goes
    // back to the first editor (collaborator). Only when the holder is past the
    // first editor, so it never applies at the collaborator stage.
    const isAheadReturn = !isHolder
      && effIdx !== -1 && holderIdx !== -1
      && effIdx > holderIdx && holderIdx > targetIdx;

    if (!isHolder && !isAheadReturn) {
      return res.status(403).json({
        error: `Section is held by ${holder}, not ${userRole}`,
      });
    }

    // Section must currently be submitted to its holder (actively in review),
    // whether the holder themselves or a role ahead of them is returning it.
    const expectedStatus = submittedToStatus(holder);
    if (ctx.sectionStatus !== expectedStatus) {
      return res.status(400).json({
        error: `Cannot return — section status is ${ctx.sectionStatus}, expected ${expectedStatus}`,
      });
    }

    const fromStatus = ctx.sectionStatus;
    const toStatus = returnedByStatus(userRole);

    await db.query(
      `UPDATE section_content
       SET status = $1, status_comment = $2,
           return_target_role = $3,
           last_updated_by_user_id = $4, last_updated_at = now()
       WHERE event_id = $5 AND section_id = $6`,
      [toStatus, comment || null, returnTarget, req.user.id, eventId, sectionId]
    );

    // Record history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role, note)
       VALUES ($1, $2, 'returned', $3, $4, $5, $6, $7, $8)`,
      [eventId, sectionId, fromStatus, toStatus, req.user.id,
       resolvedUser.full_name, userRole, comment || null]
    );

    // Clear any pending ask-to-return requests — the return fulfills them
    await db.query(
      'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
      [eventId, sectionId]
    );

    // Notify whoever the section was returned to (the first editor).
    await notifySectionTurn(db, {
      eventId, sectionId, actorUserId: req.user.id,
      holderRole: returnTarget, type: 'returned',
    });

    res.json({ success: true, newStatus: toStatus, returnTargetRole: returnTarget });
  } catch (err) {
    console.error('Return error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/ask-to-return ─────────────────────────────────────────

router.post('/ask-to-return', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId, note } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;

    // The user's effective role must be part of this section's chain
    if (!ctx.chain.includes(userRole)) {
      return res.status(403).json({ error: 'You are not part of this section\'s approval chain' });
    }

    // The section must NOT be at the requester's stage (they can't ask-to-return their own stage)
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);
    if (userRole === holder) {
      return res.status(400).json({ error: 'You currently hold this section — use return instead' });
    }

    // The section must have already passed the requester's step
    const userIdx = ctx.chain.indexOf(userRole);
    const holderIdx = ctx.chain.indexOf(holder);
    if (holderIdx <= userIdx) {
      return res.status(400).json({ error: 'The section has not passed your step yet' });
    }

    // Broadcast upward to all roles above requester in the chain
    await db.query(
      `INSERT INTO section_return_requests
       (event_id, section_id, requested_by_user_id, requested_by_name, requested_by_role, broadcast_above_role, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, sectionId, req.user.id,
       resolvedUser.full_name, userRole, userRole, note || null]
    );

    // Record history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role, note)
       VALUES ($1, $2, 'asked_to_return', $3, $3, $4, $5, $6, $7)`,
      [eventId, sectionId, ctx.sectionStatus, req.user.id,
       resolvedUser.full_name, userRole, note || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Ask-to-return error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/workflow/return-requests ─────────────────────────────────────────

router.get('/return-requests', requireAuth, async (req, res) => {
  try {
    const { event_id, section_id } = req.query;
    if (!event_id) return res.status(400).json({ error: 'event_id is required' });

    let query = `SELECT id, event_id, section_id, requested_by_user_id,
                        requested_by_name, requested_by_role, broadcast_above_role,
                        note, created_at
                 FROM section_return_requests WHERE event_id = $1`;
    const params = [event_id];

    if (section_id) {
      query += ' AND section_id = $2';
      params.push(section_id);
    }
    query += ' ORDER BY created_at DESC';

    const { rows } = await db.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      eventId: r.event_id,
      sectionId: r.section_id,
      requestedByUserId: r.requested_by_user_id,
      requestedByName: r.requested_by_name,
      requestedByRole: r.requested_by_role,
      broadcastAboveRole: r.broadcast_above_role,
      note: r.note,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('Return requests error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/send-to-library ───────────────────────────────────────

router.post('/send-to-library', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    // Verify user is the Document Submitter
    const { rows: [event] } = await db.query(
      'SELECT document_submitter_id, status FROM events WHERE id = $1', [eventId]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.document_submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the Document Submitter can send to library' });
    }

    // Verify all sections are fully approved
    const { rows: sections } = await db.query(
      `SELECT sc.status FROM section_content sc WHERE sc.event_id = $1`, [eventId]
    );

    const allApproved = sections.every(s => s.status.startsWith('approved_by_'));
    if (!allApproved) {
      return res.status(400).json({ error: 'All sections must be approved before sending to library' });
    }

    await db.query(
      "UPDATE events SET status = 'COMPLETED', is_active = false, ended_at = now(), updated_at = now() WHERE id = $1",
      [eventId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Send to library error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/push-section ──────────────────────────────────────────

router.post('/push-section', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);
    const isLastActor = ctx.lastUpdatedByUserId != null && ctx.lastUpdatedByUserId == req.user.id;

    if (!canPushSection(userRole, ctx.chain, ctx.isCrossDept, holder, isLastActor, ctx.workflowType)) {
      return res.status(400).json({ error: 'Push is not available for this section' });
    }

    const fromStatus = ctx.sectionStatus;
    // Advanced mode pushes to RECEIVING_SUPER_COLLABORATOR (cross-dept
    // expedite). Simple mode hands the section to the curator for approval
    // (submitted_to_curator); only when there's no curator does push complete
    // the section outright (approved_by_<last chain role>).
    const isSimplePush = ctx.workflowType === 'simple';
    const hasCurator = ctx.chain.includes('CURATOR');
    const finalChainRole = ctx.chain[ctx.chain.length - 1];
    // Simple push semantics depend on who pushes:
    //  - Super-Collaborator skips the supervisor → hands to the curator (or
    //    completes the section when there is no curator);
    //  - Supervisor skips the curator → completes the section outright.
    let toStatus;
    if (!isSimplePush) {
      toStatus = submittedToStatus('RECEIVING_SUPER_COLLABORATOR');
    } else if (userRole === ROLES.SUPER_COLLABORATOR) {
      toStatus = hasCurator ? submittedToStatus('CURATOR') : approvedByStatus(finalChainRole);
    } else {
      toStatus = approvedByStatus(finalChainRole);
    }
    const origRole = ctx.originalSubmitterRole || userRole;

    await db.query(
      `UPDATE section_content
       SET status = $1, original_submitter_role = $2,
           last_updated_by_user_id = $3, last_updated_at = now(),
           status_comment = NULL, return_target_role = NULL
       WHERE event_id = $4 AND section_id = $5`,
      [toStatus, origRole, req.user.id, eventId, sectionId]
    );

    // Update event to IN_PROGRESS if still DRAFT
    if (ctx.event.event_status === 'DRAFT') {
      await db.query("UPDATE events SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1", [eventId]);
    }

    // Record history
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role)
       VALUES ($1, $2, 'pushed', $3, $4, $5, $6, $7)`,
      [eventId, sectionId, fromStatus, toStatus, req.user.id, resolvedUser.full_name, userRole]
    );

    // Clear any pending return requests
    await db.query(
      'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
      [eventId, sectionId]
    );

    // A simple-mode push that completes the section (no curator) lands on
    // approved_by_*, so trigger the same auto-completion check as a final
    // approval. A push to the curator is not completion.
    if (toStatus.startsWith('approved_by_')) {
      await checkEventCompletion(eventId);
    }

    // A push to the curator hands them the section — notify them. (A completing
    // push lands on approved_by_*, so currentHolderRole is null → no-op.)
    await notifySectionTurn(db, {
      eventId, sectionId, actorUserId: req.user.id,
      holderRole: currentHolderRole(toStatus, origRole, null, ctx.chain),
    });

    res.json({ success: true, newStatus: toStatus });
  } catch (err) {
    console.error('Push section error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/workflow/pull-section ──────────────────────────────────────────
router.post('/pull-section', requireAuth, denyAnalyst, async (req, res) => {
  try {
    const { eventId, sectionId } = req.body;
    if (!eventId || !sectionId) {
      return res.status(400).json({ error: 'eventId and sectionId are required' });
    }

    const [ctx, resolvedUser] = await Promise.all([
      loadSectionContext(eventId, sectionId, req.user),
      resolveUser(req.user),
    ]);
    if (!ctx) return res.status(404).json({ error: 'Section not found' });

    const userRole = ctx.userRole;
    const holder = currentHolderRole(ctx.sectionStatus, ctx.originalSubmitterRole, ctx.returnTargetRole, ctx.chain);
    const isDS = req.user.id === ctx.event.document_submitter_id;

    // Simple-mode DS pulls use the user's actual role (e.g. DEPUTY)
    // even though it isn't in the chain — that's the override that
    // canPullSection allows.
    const pullingRole = (ctx.workflowType === 'simple' && isDS)
      ? req.user.role
      : userRole;

    if (!canPullSection(pullingRole, ctx.chain, holder, {
      workflowType: ctx.workflowType,
      isDS,
      status: ctx.sectionStatus,
      eventStatus: ctx.event.event_status,
    })) {
      return res.status(400).json({ error: 'Pull is not available for this section' });
    }

    const fromStatus = ctx.sectionStatus;
    // Reopened-event DS pull lands on a dedicated 'amendment' state
    // that lives outside the chain. The chain bar keeps showing the
    // original approval history; only a separate "Amendment in
    // progress" indicator appears. Approve from this state finalises
    // the section as approved_by_<dsRole> — see /approve.
    const isAmendmentPull = ctx.workflowType === 'simple'
      && isDS
      && ctx.sectionStatus.startsWith('approved_by_');
    const toStatus = isAmendmentPull
      ? 'submitted_to_amending_ds'
      : submittedToStatus(pullingRole);
    const origRole = ctx.originalSubmitterRole || ctx.chain[0];

    await db.query(
      `UPDATE section_content
       SET status = $1, original_submitter_role = $2,
           last_updated_by_user_id = $3, last_updated_at = now(),
           status_comment = NULL, return_target_role = NULL
       WHERE event_id = $4 AND section_id = $5`,
      [toStatus, origRole, req.user.id, eventId, sectionId]
    );

    // Update event to IN_PROGRESS if still DRAFT
    if (ctx.event.event_status === 'DRAFT') {
      await db.query("UPDATE events SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1", [eventId]);
    }

    // Record history. For amendment pulls, label the row with the
    // synthetic 'AMENDING_DS' role so the per-section chain-actor
    // lookup (status-grid) doesn't latch the DS into the SUPERVISOR /
    // SUPER_COLLABORATOR / etc. slot just because the DS happens to
    // have one of those JWT roles. Audit log keeps the user_id +
    // user_name so there's no loss of traceability.
    const historyRole = isAmendmentPull ? 'AMENDING_DS' : pullingRole;
    await db.query(
      `INSERT INTO section_history (event_id, section_id, action, from_status, to_status, user_id, user_name, user_role)
       VALUES ($1, $2, 'pulled', $3, $4, $5, $6, $7)`,
      [eventId, sectionId, fromStatus, toStatus, req.user.id, resolvedUser.full_name, historyRole]
    );

    // Clear any pending return requests
    await db.query(
      'DELETE FROM section_return_requests WHERE event_id = $1 AND section_id = $2',
      [eventId, sectionId]
    );

    res.json({ success: true, newStatus: toStatus });
  } catch (err) {
    console.error('Pull section error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/workflow/status-grid ────────────────────────────────────────────

router.get('/status-grid', requireAuth, async (req, res) => {
  try {
    const eventId = req.query.event_id;
    if (!eventId) return res.status(400).json({ error: 'event_id is required' });

    const { rows: [event] } = await db.query(
      `SELECT id, document_submitter_role, document_submitter_id,
              deputy_id, supervisor_id, curator_required, workflow_type, country_id,
              status AS event_status
       FROM events WHERE id = $1`,
      [eventId]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const eventWorkflowType = event.workflow_type || 'advanced';

    // When a Deputy owns the document, a supervisor explicitly linked to that
    // deputy (deputy_supervisor_links) is allowed to see the whole document's
    // progress — but only if they also participate in it (the frontend checks
    // that they have at least one of their own sections).
    let viewerLinkedToOwnerDeputy = false;
    if (event.document_submitter_role === 'DEPUTY' && req.user.role === 'SUPERVISOR') {
      const { rows: [link] } = await db.query(
        `SELECT 1 FROM deputy_supervisor_links
         WHERE deputy_id = $1 AND supervisor_id = $2 LIMIT 1`,
        [event.document_submitter_id, req.user.id]);
      viewerLinkedToOwnerDeputy = !!link;
    }

    // Get "home department" for the receiving chain.
    // For Deputy DS, use the Responsible Supervisor's department since
    // Deputies oversee multiple departments.
    let dsDeptId = null;
    if (event.document_submitter_role === 'DEPUTY' && event.supervisor_id) {
      const { rows: [sv] } = await db.query(
        'SELECT department_id FROM users WHERE id = $1', [event.supervisor_id]
      );
      dsDeptId = sv ? sv.department_id : null;
    } else {
      const { rows: [dsUser] } = await db.query(
        'SELECT department_id FROM users WHERE id = $1', [event.document_submitter_id]
      );
      dsDeptId = dsUser ? dsUser.department_id : null;
    }

    const { rows: sections } = await db.query(
      `SELECT s.id AS section_id, s.title AS section_label,
              sc.status, sc.status_comment, sc.last_updated_at,
              sc.original_submitter_role, sc.return_target_role,
              sc.last_updated_by_user_id,
              u.full_name AS last_updated_by, u.full_name_ka AS last_updated_by_ka,
              sc.last_content_edited_by_user_id
       FROM sections s
       LEFT JOIN section_content sc ON sc.section_id = s.id AND sc.event_id = s.event_id
       LEFT JOIN users u ON u.id = sc.last_updated_by_user_id
       WHERE s.event_id = $1
       ORDER BY s.sort_order`,
      [eventId]
    );

    // Build a lookup of the last actor per (section, role) from history.
    // Used to show who actually acted on multi-user steps instead of a static pick.
    const { rows: historyRows } = await db.query(
      `SELECT DISTINCT ON (sh.section_id, sh.user_role)
         sh.section_id, sh.user_role, sh.user_id, sh.user_name,
         d.name_en AS department_name
       FROM section_history sh
       LEFT JOIN users u ON u.id = sh.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE sh.event_id = $1
       ORDER BY sh.section_id, sh.user_role, sh.acted_at DESC`,
      [eventId]
    );
    const historyActors = {};
    for (const h of historyRows) {
      if (!historyActors[h.section_id]) historyActors[h.section_id] = {};
      historyActors[h.section_id][h.user_role] = {
        actorName: h.user_name,
        actorId: h.user_id,
        departmentName: h.department_name,
      };
    }

    // Get department assignments and actor names for each section
    const enrichedSections = [];
    for (const s of sections) {
      const { rows: deptRows } = await db.query(
        `SELECT sd.department_id, d.name_en AS department_name
         FROM section_departments sd
         LEFT JOIN departments d ON d.id = sd.department_id
         WHERE sd.section_id = $1`,
        [s.section_id]
      );
      const sectionDeptIds = deptRows.map(r => r.department_id);
      const sectionDeptNames = deptRows.map(r => r.department_name).filter(Boolean);
      const isCrossDept = sectionDeptIds.some(d => d !== dsDeptId);
      const chain = buildChain(event.document_submitter_role, event.curator_required, isCrossDept, eventWorkflowType);

      // Resolve actor names for each step in the chain
      const steps = [];
      for (const step of chain) {
        let actorName = null;
        let actorNameKa = null;
        let actorId = null;
        let deptName = null;

        if (step === 'CURATOR') {
          // Find the deputy who oversees the section's department(s). In advanced
          // mode the document submitter is excluded (a deputy DS is the final
          // approver, not a curator). In simple mode there's a Document Owner, and
          // a Deputy owner curates their own-department sections — so include them
          // and prefer them when they oversee the section's department.
          // Deputies oversee multiple departments, so don't show a single department name.
          const isSimpleWf = event.workflow_type === 'simple';
          const { rows: [dep] } = await db.query(
            isSimpleWf
              ? `SELECT u.id, u.full_name, u.full_name_ka
                 FROM deputy_department_links ddl
                 JOIN users u ON u.id = ddl.deputy_id
                 WHERE ddl.department_id = ANY($1)
                 ORDER BY (u.id = $2) DESC, u.id LIMIT 1`
              : `SELECT u.id, u.full_name, u.full_name_ka
                 FROM deputy_department_links ddl
                 JOIN users u ON u.id = ddl.deputy_id
                 WHERE ddl.department_id = ANY($1) AND u.id != $2
                 ORDER BY u.id LIMIT 1`,
            [sectionDeptIds, event.document_submitter_id]);
          if (dep) { actorName = dep.full_name; actorNameKa = dep.full_name_ka; actorId = dep.id; deptName = null; }
        } else if (step === ROLES.DEPUTY && event.document_submitter_role === 'DEPUTY') {
          // Deputy step = the Document Submitter themselves.
          // Deputies oversee multiple departments, so don't show a single department name.
          const { rows: [dep] } = await db.query(
            `SELECT id, full_name, full_name_ka FROM users WHERE id = $1`, [event.document_submitter_id]);
          if (dep) { actorName = dep.full_name; actorNameKa = dep.full_name_ka; actorId = dep.id; deptName = null; }
        } else {
          // Multi-user roles (Collaborator, SC, Supervisor, Receiving_*):
          // Only show name after someone actually acted — use history lookup.
          const hist = (historyActors[s.section_id] || {})[step];
          if (hist) {
            actorName = hist.actorName;
            actorNameKa = hist.actorNameKa;
            actorId = hist.actorId;
            deptName = hist.departmentName;
          }
        }

        const acted = !!(historyActors[s.section_id] || {})[step];
        steps.push({ role: step, actorName, actorNameKa, actorId, departmentName: deptName, acted });
      }

      const status = s.status || 'draft';
      const holderRole = currentHolderRole(status, s.original_submitter_role, s.return_target_role, chain);

      // Load return request for this section (if any)
      const { rows: rrRows } = await db.query(
        `SELECT requested_by_name, requested_by_role, note, created_at
         FROM section_return_requests
         WHERE event_id = $1 AND section_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [eventId, s.section_id]
      );
      const returnRequest = rrRows.length > 0 ? {
        from: rrRows[0].requested_by_name,
        fromRole: rrRows[0].requested_by_role,
        note: rrRows[0].note,
        at: rrRows[0].created_at,
      } : null;

      // Load most recent return action for returned sections
      let returnInfo = null;
      if (status.startsWith('returned_by_')) {
        const { rows: riRows } = await db.query(
          `SELECT user_name, user_role, note, acted_at
           FROM section_history
           WHERE event_id = $1 AND section_id = $2 AND action = 'returned'
           ORDER BY acted_at DESC LIMIT 1`,
          [eventId, s.section_id]
        );
        if (riRows.length > 0) {
          returnInfo = {
            from: riRows[0].user_name,
            fromRole: riRows[0].user_role,
            note: riRows[0].note,
            at: riRows[0].acted_at,
          };
        }
      }

      // Compute the requesting user's effective role for this section.
      // While the section is under DS amendment (after a Library
      // reopen), the DS holds the section under the synthetic
      // 'AMENDING_DS' role so the existing
      // "approve when status === submitted_to_<userRole>" pathway
      // matches without further special-casing on the frontend.
      const isAmendmentDS = status === 'submitted_to_amending_ds'
        && req.user.id === event.document_submitter_id;
      const userEffRole = isAmendmentDS
        ? 'AMENDING_DS'
        : await effectiveRole(req.user, event, sectionDeptIds, chain);


      enrichedSections.push({
        sectionId: s.section_id,
        sectionLabel: s.section_label,
        status,
        statusComment: s.status_comment,
        lastUpdatedAt: s.last_updated_at,
        lastUpdatedBy: s.last_updated_by,
        lastUpdatedByKa: s.last_updated_by_ka,
        originalSubmitterRole: s.original_submitter_role,
        returnTargetRole: s.return_target_role,
        currentHolderRole: holderRole,
        userEffectiveRole: userEffRole,
        departmentIds: sectionDeptIds,
        departmentNames: sectionDeptNames,
        isCrossDept,
        chain,
        steps,
        canPush: canPushSection(userEffRole, chain, isCrossDept, holderRole, s.last_updated_by_user_id != null && s.last_updated_by_user_id == req.user.id, eventWorkflowType),
        canPull: canPullSection(userEffRole, chain, holderRole, {
          workflowType: eventWorkflowType,
          isDS: req.user.id === event.document_submitter_id,
          status: s.status,
          eventStatus: event.event_status,
        }),
        returnRequest,
        returnInfo,
      });
    }

    res.json({
      event_id: parseInt(eventId),
      documentSubmitterRole: event.document_submitter_role,
      documentSubmitterId: event.document_submitter_id,
      deputyId: event.deputy_id,
      curatorRequired: event.curator_required,
      workflowType: eventWorkflowType,
      homeDepartmentId: dsDeptId,
      viewerLinkedToOwnerDeputy,
      sections: enrichedSections,
    });
  } catch (err) {
    console.error('Status grid error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/workflow/stage-users ─────────────────────────────────────────────

router.get('/stage-users', requireAuth, async (req, res) => {
  try {
    const { event_id, section_id, role } = req.query;
    if (!event_id || !section_id || !role) {
      return res.status(400).json({ error: 'event_id, section_id, and role are required' });
    }

    const { rows: [event] } = await db.query(
      `SELECT id, document_submitter_role, document_submitter_id,
              supervisor_id, curator_required, workflow_type, country_id
       FROM events WHERE id = $1`,
      [event_id]
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const stageWorkflowType = event.workflow_type || 'advanced';

    // Resolve home department (same logic as status-grid)
    let dsDeptId = null;
    if (event.document_submitter_role === 'DEPUTY' && event.supervisor_id) {
      const { rows: [sup] } = await db.query(
        'SELECT department_id FROM users WHERE id = $1', [event.supervisor_id]
      );
      dsDeptId = sup ? sup.department_id : null;
    } else {
      const { rows: [dsUser] } = await db.query(
        'SELECT department_id FROM users WHERE id = $1', [event.document_submitter_id]
      );
      dsDeptId = dsUser ? dsUser.department_id : null;
    }

    // Section departments
    const { rows: deptRows } = await db.query(
      'SELECT department_id FROM section_departments WHERE section_id = $1',
      [section_id]
    );
    const sectionDeptIds = deptRows.map(r => r.department_id);
    const isCrossDept = sectionDeptIds.some(d => d !== dsDeptId);
    const chain = buildChain(event.document_submitter_role, event.curator_required, isCrossDept, stageWorkflowType);

    if (!chain.includes(role)) {
      return res.status(400).json({ error: 'Role is not in the approval chain for this section' });
    }

    let users = [];

    if (role === 'CURATOR') {
      const { rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM deputy_department_links ddl
         JOIN users u ON u.id = ddl.deputy_id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE ddl.department_id = ANY($1) AND u.id != $2
         ORDER BY u.full_name`,
        [sectionDeptIds, event.document_submitter_id]
      );
      users = rows;
    } else if (role === 'DEPUTY') {
      const { rows } = await db.query(
        `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = $1`,
        [event.document_submitter_id]
      );
      users = rows;
    } else if (role.startsWith('RECEIVING_')) {
      const dbRole = baseRole(role);
      if (dsDeptId) {
        const { rows } = await db.query(
          `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
           FROM users u
           LEFT JOIN departments d ON d.id = u.department_id
           LEFT JOIN country_assignments ca ON ca.user_id = u.id AND ca.country_id = $3
           WHERE u.role = $1 AND u.department_id = $2
             AND (ca.user_id IS NOT NULL
                  OR NOT EXISTS (SELECT 1 FROM country_assignments ca2 WHERE ca2.user_id = u.id))
           ORDER BY u.full_name`,
          [dbRole, dsDeptId, event.country_id]
        );
        users = rows;
      }
    } else {
      if (sectionDeptIds.length > 0 && sectionDeptIds[0]) {
        const { rows } = await db.query(
          `SELECT u.id, u.full_name, u.full_name_ka, d.name_en AS department_name
           FROM users u
           LEFT JOIN departments d ON d.id = u.department_id
           LEFT JOIN country_assignments ca ON ca.user_id = u.id AND ca.country_id = $3
           WHERE u.role = $1 AND u.department_id = ANY($2)
             AND (ca.user_id IS NOT NULL
                  OR NOT EXISTS (SELECT 1 FROM country_assignments ca2 WHERE ca2.user_id = u.id))
           ORDER BY u.full_name`,
          [role, sectionDeptIds, event.country_id]
        );
        users = rows;
      }
    }

    res.json({
      role,
      users: users.map(u => ({
        id: u.id,
        fullName: u.full_name,
        fullNameKa: u.full_name_ka,
        departmentName: u.department_name,
      })),
    });
  } catch (err) {
    console.error('Stage users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/workflow/section-content ────────────────────────────────────────

router.get('/section-content', requireAuth, async (req, res) => {
  try {
    const { event_id, section_id } = req.query;
    if (!event_id || !section_id) {
      return res.status(400).json({ error: 'event_id and section_id are required' });
    }

    const { rows: [content] } = await db.query(
      `SELECT sc.html_content, sc.status, sc.last_content_edited_at,
              u.full_name AS last_edited_by, u.full_name_ka AS last_edited_by_ka
       FROM section_content sc
       LEFT JOIN users u ON u.id = sc.last_content_edited_by_user_id
       WHERE sc.event_id = $1 AND sc.section_id = $2`,
      [event_id, section_id]
    );

    if (!content) return res.status(404).json({ error: 'Content not found' });

    res.json({
      htmlContent: content.html_content,
      status: content.status,
      lastEditedAt: content.last_content_edited_at,
      lastEditedBy: content.last_edited_by,
      lastEditedByKa: content.last_edited_by_ka,
    });
  } catch (err) {
    console.error('Section content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Helper: check event completion ───────────────────────────────────────────

async function checkEventCompletion(eventId) {
  // Auto-completion is only enabled in 'simple' workflow mode. Advanced
  // mode keeps the manual "Send to library" gate (the DS clicks it once
  // they're satisfied with the final approved sections).
  const { rows: [event] } = await db.query(
    'SELECT workflow_type, status FROM events WHERE id = $1', [eventId]
  );
  if (!event) return;
  const workflowType = event.workflow_type || 'advanced';
  if (workflowType !== 'simple') return;
  if (event.status === 'COMPLETED') return;

  const { rows: sections } = await db.query(
    'SELECT status FROM section_content WHERE event_id = $1', [eventId]
  );
  if (sections.length === 0) return;
  const allApproved = sections.every(s => s.status && s.status.startsWith('approved_by_'));
  if (!allApproved) return;

  await db.query(
    `UPDATE events
     SET status = 'COMPLETED', is_active = false, ended_at = now(), updated_at = now()
     WHERE id = $1 AND status <> 'COMPLETED'`,
    [eventId]
  );
}

module.exports = router;
