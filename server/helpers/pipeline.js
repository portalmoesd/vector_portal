const { ROLES } = require('./roles');

/**
 * Section status enum values
 */
const STATUS = {
  DRAFT: 'draft',
  SUBMITTED_TO_SUPER_COLLABORATOR: 'submitted_to_super_collaborator',
  RETURNED_BY_SUPER_COLLABORATOR: 'returned_by_super_collaborator',
  APPROVED_BY_SUPER_COLLABORATOR: 'approved_by_super_collaborator',
  SUBMITTED_TO_CURATOR: 'submitted_to_curator',
  RETURNED_BY_CURATOR: 'returned_by_curator',
  APPROVED_BY_CURATOR: 'approved_by_curator',
  SUBMITTED_TO_SUPERVISOR: 'submitted_to_supervisor',
  RETURNED_BY_SUPERVISOR: 'returned_by_supervisor',
  APPROVED_BY_SUPERVISOR: 'approved_by_supervisor',
  SUBMITTED_TO_DEPUTY: 'submitted_to_deputy',
  RETURNED_BY_DEPUTY: 'returned_by_deputy',
  APPROVED_BY_DEPUTY: 'approved_by_deputy',
  // Receiving chain statuses (DS's home department review of cross-dept sections)
  SUBMITTED_TO_RECEIVING_SUPER_COLLABORATOR: 'submitted_to_receiving_super_collaborator',
  RETURNED_BY_RECEIVING_SUPER_COLLABORATOR: 'returned_by_receiving_super_collaborator',
  APPROVED_BY_RECEIVING_SUPER_COLLABORATOR: 'approved_by_receiving_super_collaborator',
  SUBMITTED_TO_RECEIVING_SUPERVISOR: 'submitted_to_receiving_supervisor',
  RETURNED_BY_RECEIVING_SUPERVISOR: 'returned_by_receiving_supervisor',
  APPROVED_BY_RECEIVING_SUPERVISOR: 'approved_by_receiving_supervisor',
};

/**
 * Strip the RECEIVING_ prefix to get the underlying database role.
 * e.g. 'RECEIVING_SUPERVISOR' → 'SUPERVISOR', 'CURATOR' → 'CURATOR'
 */
function baseRole(step) {
  return step.startsWith('RECEIVING_') ? step.replace('RECEIVING_', '') : step;
}

/**
 * Determine who currently holds a section based on its status and chain.
 */
function currentHolderRole(status, originalSubmitterRole, returnTargetRole, chain) {
  if (status === STATUS.DRAFT) {
    return originalSubmitterRole || ROLES.COLLABORATOR;
  }
  if (status.startsWith('returned_')) {
    return returnTargetRole || originalSubmitterRole || ROLES.COLLABORATOR;
  }
  if (status.startsWith('submitted_to_')) {
    const target = status.replace('submitted_to_', '').toUpperCase();
    return target;
  }
  if (status.startsWith('approved_by_')) {
    const approver = status.replace('approved_by_', '').toUpperCase();
    // Use chain to find the next step (if chain provided)
    if (chain) {
      const idx = chain.indexOf(approver);
      if (idx !== -1 && idx < chain.length - 1) return chain[idx + 1];
    }
    return null;
  }
  return originalSubmitterRole || ROLES.COLLABORATOR;
}

/**
 * Get the status string for submitting to a target role.
 */
function submittedToStatus(targetRole) {
  return `submitted_to_${targetRole.toLowerCase()}`;
}

/**
 * Get the status string when a role approves.
 */
function approvedByStatus(role) {
  return `approved_by_${role.toLowerCase()}`;
}

/**
 * Get the status string when a role returns.
 */
function returnedByStatus(role) {
  return `returned_by_${role.toLowerCase()}`;
}

/**
 * Build the pipeline chain for a section given the event context.
 *
 * For home-department sections, the chain goes through the section's
 * department up to the Document Submitter.
 *
 * For cross-department sections, the chain has two phases:
 *   1. Section department chain: Collaborator → SC → Supervisor
 *   2. [Optional Curator step]
 *   3. Receiving chain: RECEIVING_SC → RECEIVING_SUPERVISOR (DS's home dept)
 *   4. Final approver (DS)
 *
 * RECEIVING_ prefixed steps belong to the DS's home department and are
 * distinct from same-named steps in the section's department chain.
 *
 * In **simple** workflow mode, every section uses the same fixed
 * three-step chain regardless of dsRole / curator / cross-dept status.
 * The DS isn't part of the per-section chain — they sit outside it and
 * use pull-section to override on demand (handled in canPullSection).
 *
 * @param {string} dsRole - Document Submitter role (DEPUTY, SUPERVISOR, SUPER_COLLABORATOR)
 * @param {boolean} curatorRequired - Whether curator review is required
 * @param {boolean} isCrossDept - Whether this section has cross-department assignments
 * @param {string} [workflowType='advanced'] - 'advanced' (default) or 'simple'
 * @returns {string[]} Ordered list of step labels
 */
function buildChain(dsRole, curatorRequired, isCrossDept, workflowType) {
  if (workflowType === 'simple') {
    const simple = [ROLES.COLLABORATOR, ROLES.SUPER_COLLABORATOR, ROLES.SUPERVISOR];
    // Curator is opt-in and acts as the final approver when present —
    // a deputy who oversees the section's department signs off after
    // the section's own supervisor.
    if (curatorRequired) simple.push('CURATOR');
    return simple;
  }

  const chain = [ROLES.COLLABORATOR];

  if (dsRole === 'SUPER_COLLABORATOR') {
    chain.push(ROLES.SUPER_COLLABORATOR);

    if (isCrossDept) {
      // Cross-dept: section dept chain → [Curator] → DS receives
      chain.push(ROLES.SUPERVISOR);
      if (curatorRequired) {
        chain.push('CURATOR');
      }
      // SC(A) is the DS — final approver
      chain.push('RECEIVING_SUPER_COLLABORATOR');
    }
  } else if (dsRole === 'SUPERVISOR') {
    chain.push(ROLES.SUPER_COLLABORATOR);
    chain.push(ROLES.SUPERVISOR);

    if (isCrossDept) {
      // Cross-dept: section dept chain → [Curator] → receiving chain → DS
      if (curatorRequired) {
        chain.push('CURATOR');
      }
      chain.push('RECEIVING_SUPER_COLLABORATOR');
      // Supervisor(A) is the DS — final approver
      chain.push('RECEIVING_SUPERVISOR');
    }
  } else if (dsRole === 'DEPUTY') {
    chain.push(ROLES.SUPER_COLLABORATOR);
    chain.push(ROLES.SUPERVISOR);

    if (isCrossDept) {
      // Cross-dept: section dept chain → [Curator] → receiving chain → Deputy
      if (curatorRequired) {
        chain.push('CURATOR');
      }
      chain.push('RECEIVING_SUPER_COLLABORATOR');
      chain.push('RECEIVING_SUPERVISOR');
    }
    chain.push(ROLES.DEPUTY);
  }

  return chain;
}

/**
 * Determine the next role to submit to, given the current user's role
 * and the section's chain.
 *
 * @param {string} userRole - The submitting user's effective role (or 'CURATOR', 'RECEIVING_*')
 * @param {string[]} chain - The pipeline chain for this section
 * @returns {string|null} The next role in the chain, or null if at the end
 */
function nextInChain(userRole, chain) {
  const idx = chain.indexOf(userRole);
  if (idx === -1 || idx >= chain.length - 1) return null;
  return chain[idx + 1];
}

/**
 * Check if the user's role is the final approver in the chain (Document Submitter).
 */
function isFinalApprover(userRole, chain) {
  return chain.length > 0 && chain[chain.length - 1] === userRole;
}

/**
 * Get the first role in the chain (the original editor level for returns).
 */
function firstEditorRole(chain) {
  return chain.length > 0 ? chain[0] : ROLES.COLLABORATOR;
}

/**
 * Determine whether a Department B user can "push" a cross-dept section
 * directly to RECEIVING_SUPER_COLLABORATOR, bypassing remaining Dept B steps.
 *
 * Two scenarios:
 *  1. User IS the current holder — they can push instead of submitting/approving
 *     through the normal chain (only when there's >1 step to RECEIVING_SC).
 *  2. User is NOT the holder — they already submitted/approved, the section
 *     moved to the next step, but the next person is unresponsive. The user
 *     can still push as long as:
 *       a) they were the last person to act (lastUpdatedByUserId matches)
 *       b) the section is currently held by a role between the user and RECEIVING_SC
 *
 * @param {string}   userRole            - The user's effective role
 * @param {string[]} chain               - The pipeline chain for this section
 * @param {boolean}  isCrossDept         - Whether the section is cross-department
 * @param {string}   [holderRole]        - Current holder role (optional, for non-holder check)
 * @param {boolean}  [isLastActor=false] - Whether this user was the last to update the section
 * @returns {boolean}
 */
function canPushSection(userRole, chain, isCrossDept, holderRole, isLastActor, workflowType) {
  // Simple-mode push is a holder-only expedite to the curator:
  //  - the Super-Collaborator holder can always push (→ curator, or completes
  //    the section when no curator is in the chain);
  //  - the Supervisor holder can push only when a curator is participating;
  //  - the Collaborator and the Curator never push.
  if (workflowType === 'simple') {
    if (!chain || chain.length < 2) return false;
    if (!holderRole || !chain.includes(holderRole)) return false;
    if (userRole !== holderRole) return false;
    if (userRole === ROLES.SUPER_COLLABORATOR) return true;
    if (userRole === ROLES.SUPERVISOR) return chain.includes('CURATOR');
    return false;
  }

  if (!isCrossDept || !chain || !chain.includes('RECEIVING_SUPER_COLLABORATOR')) return false;

  const pushableRoles = [ROLES.COLLABORATOR, ROLES.SUPER_COLLABORATOR, ROLES.SUPERVISOR];
  if (!pushableRoles.includes(userRole)) return false;

  const userIdx = chain.indexOf(userRole);
  const receivingScIdx = chain.indexOf('RECEIVING_SUPER_COLLABORATOR');
  if (userIdx === -1 || receivingScIdx === -1) return false;

  const isHolder = !holderRole || holderRole === userRole;

  if (isHolder) {
    // Holder case: must have >1 step gap to RECEIVING_SC
    return (receivingScIdx - userIdx) > 1;
  }

  // Non-holder case: the user already submitted/approved but next in chain
  // is unresponsive. Allow push if:
  //  - user was the last actor on the section
  //  - section is currently at a role between user and RECEIVING_SC
  if (!isLastActor) return false;
  const holderIdx = chain.indexOf(holderRole);
  if (holderIdx === -1) return false;
  return holderIdx > userIdx && holderIdx < receivingScIdx;
}

/**
 * Determine whether a user can "pull" a section to themselves from a user
 * earlier in the approval chain.
 *
 * Rules:
 *  - User must be in the chain at a position AFTER the current holder
 *  - Both user and holder must be on the same side of the RECEIVING_ boundary
 *    (Department A cannot pull from Department B)
 *
 * In **simple** workflow mode, the Document Submitter sits outside the
 * per-section chain and gets a special override: they can pull any
 * not-yet-finalised section regardless of position. The opts.isDS +
 * opts.workflowType flags drive that branch.
 *
 * @param {string}   userRole   - The user's effective role
 * @param {string[]} chain      - The pipeline chain for this section
 * @param {string}   holderRole - Current holder role
 * @param {object}   [opts]
 * @param {string}   [opts.workflowType='advanced'] - 'advanced' or 'simple'
 * @param {boolean}  [opts.isDS=false]              - Is the user the event's DS?
 * @param {string}   [opts.status]                  - Section status (used only for the simple/DS branch)
 * @returns {boolean}
 */
function canPullSection(userRole, chain, holderRole, opts) {
  const o = opts || {};

  // Simple-mode DS override: pull any section that hasn't already been
  // finalised. DS isn't in the chain in simple mode, so the standard
  // index check below would reject them. But: if the section is
  // already submitted_to_<dsRole> (DS holds it), the pull button is
  // meaningless — block it so the DS dashboard doesn't show "Pull"
  // for a section the DS is already holding.
  //
  // Special case: when the event was published and then reopened
  // (events.status flipped back from COMPLETED → IN_PROGRESS via the
  // library "Edit" button), the section statuses stay approved_by_*
  // but the DS legitimately needs to pull them to make corrections.
  // Allow pull on approved_by_* iff the event has been reopened. The
  // pull lands on a dedicated 'submitted_to_amending_ds' state — see
  // pull-section / approve handlers in routes/workflow.js.
  //
  // While an amendment is in progress (status starts with
  // submitted_to_amending_ds) the DS already holds the section, so
  // pull is a no-op.
  if (o.workflowType === 'simple' && o.isDS) {
    if (!o.status) return false;
    if (o.status === 'submitted_to_amending_ds') return false;
    if (holderRole && userRole === holderRole) return false;
    if (o.status.startsWith('approved_by_')) {
      // Reopened event → DS can pull approved sections to amend them.
      // Otherwise (event still in progress, sections normally finalised)
      // there's nothing to pull.
      return o.eventStatus === 'IN_PROGRESS';
    }
    return true;
  }

  if (!chain || chain.length < 2 || !holderRole) return false;

  const userIdx = chain.indexOf(userRole);
  const holderIdx = chain.indexOf(holderRole);
  if (userIdx === -1 || holderIdx === -1) return false;

  // User must be AFTER the holder in the chain
  if (userIdx <= holderIdx) return false;

  // Department boundary: can't pull across the RECEIVING_ boundary
  const boundaryIdx = chain.findIndex(r => r.startsWith('RECEIVING_'));
  if (boundaryIdx !== -1) {
    const userBeforeBoundary = userIdx < boundaryIdx;
    const holderBeforeBoundary = holderIdx < boundaryIdx;
    if (userBeforeBoundary !== holderBeforeBoundary) return false;
  }

  return true;
}

module.exports = {
  STATUS,
  baseRole,
  currentHolderRole,
  submittedToStatus,
  approvedByStatus,
  returnedByStatus,
  buildChain,
  nextInChain,
  isFinalApprover,
  firstEditorRole,
  canPushSection,
  canPullSection,
};
