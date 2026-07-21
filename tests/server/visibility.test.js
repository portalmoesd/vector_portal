const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, seesAllCompletedDocs, canSeeEventDateTime } = require('../../server/helpers/roles');

test('seesAllCompletedDocs: ministry-wide roles only', () => {
  assert.equal(seesAllCompletedDocs(ROLES.ADMIN), true);
  assert.equal(seesAllCompletedDocs(ROLES.MINISTER), true);
  assert.equal(seesAllCompletedDocs(ROLES.DEPUTY), true);

  assert.equal(seesAllCompletedDocs(ROLES.SUPERVISOR), false);
  assert.equal(seesAllCompletedDocs(ROLES.SUPER_COLLABORATOR), false);
  assert.equal(seesAllCompletedDocs(ROLES.COLLABORATOR), false);
  assert.equal(seesAllCompletedDocs(ROLES.ANALYST), false);
  assert.equal(seesAllCompletedDocs(ROLES.PROTOCOL), false);
  assert.equal(seesAllCompletedDocs(undefined), false);
});

test('canSeeEventDateTime: admin and protocol always see it', () => {
  assert.equal(canSeeEventDateTime(ROLES.ADMIN, 1, 2), true);
  assert.equal(canSeeEventDateTime(ROLES.PROTOCOL, 1, 2), true);
});

test('canSeeEventDateTime: deputies see it regardless of ownership', () => {
  assert.equal(canSeeEventDateTime(ROLES.DEPUTY, 1, 2), true);
  assert.equal(canSeeEventDateTime(ROLES.DEPUTY, 1, 1), true);
});

test('canSeeEventDateTime: everyone else only when they own the event', () => {
  for (const role of [ROLES.MINISTER, ROLES.SUPERVISOR, ROLES.SUPER_COLLABORATOR,
    ROLES.COLLABORATOR, ROLES.ANALYST]) {
    assert.equal(canSeeEventDateTime(role, 1, 1), true, `${role} owner`);
    assert.equal(canSeeEventDateTime(role, 1, 2), false, `${role} non-owner`);
  }
});
