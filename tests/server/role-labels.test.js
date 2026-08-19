/**
 * Role display labels.
 *
 * The two departmental working roles are shown as Editor / Senior Editor
 * (შემსრულებელი / უფროსი შემსრულებელი), while their internal identifiers stay
 * COLLABORATOR / SUPER_COLLABORATOR — those are baked into stored section
 * statuses and are deliberately not renamed.
 *
 * SUPERVISOR is renamed in Georgian only: ხელმძღვანელი, not ზედამხედველი. The
 * English label stays "Supervisor", so unlike the pair above this one has to be
 * checked per language.
 *
 * The display text is duplicated across four files (both locale bundles, the
 * frontend's offline fallback maps, and the server's own tables for outgoing
 * email), so these tests exist to stop one of them drifting: a locale-only edit
 * would leave stale English in the fallbacks and in email bodies.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const en = JSON.parse(read('frontend/locales/en.json'));
const ka = JSON.parse(read('frontend/locales/ka.json'));

// Files that carry role display text. Keys and identifiers may still say
// "collaborator"; only rendered strings are checked below.
const LABEL_SOURCES = [
  'frontend/locales/en.json',
  'frontend/locales/ka.json',
  'frontend/js/core/utils.js',
  'server/helpers/event-notification-draft.js',
  'frontend/js/pages/dashboard-minister.js',
];

/** Every string value in a locale bundle, as "dotted.key" -> value. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

const enFlat = flatten(en);
const kaFlat = flatten(ka);

test('role labels read Editor / Senior Editor', () => {
  assert.equal(en.roles.COLLABORATOR, 'Editor');
  assert.equal(en.roles.SUPER_COLLABORATOR, 'Senior Editor');
  // The receiving-chain role shows the same label; the department name
  // underneath is what distinguishes it.
  assert.equal(en.roles.RECEIVING_SUPER_COLLABORATOR, en.roles.SUPER_COLLABORATOR);
});

test('role labels read შემსრულებელი / უფროსი შემსრულებელი', () => {
  assert.equal(ka.roles.COLLABORATOR, 'შემსრულებელი');
  assert.equal(ka.roles.SUPER_COLLABORATOR, 'უფროსი შემსრულებელი');
  assert.equal(ka.roles.RECEIVING_SUPER_COLLABORATOR, ka.roles.SUPER_COLLABORATOR);
});

test('no locale value still says Collaborator in either language', () => {
  for (const [name, flat] of [['en.json', enFlat], ['ka.json', kaFlat]]) {
    const stale = Object.entries(flat)
      .filter(([, v]) => /collab/i.test(v) || /კოლაბორატორ/.test(v))
      .map(([k, v]) => `${k} = ${v}`);
    assert.deepEqual(stale, [], `${name} still renders the old role name`);
  }
});

test('no in-code label fallback still says Collaborator', () => {
  // These maps render whenever I18n has not loaded or misses a key, and the
  // server ones are never translated at all.
  for (const file of LABEL_SOURCES) {
    if (file.endsWith('.json')) continue;
    const src = read(file);
    // Strip identifiers and comments; what remains is display text.
    const strings = [...src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)]
      .map(m => m[1] ?? m[2] ?? m[3])
      .filter(s => /collab/i.test(s) || /კოლაბორატორ/.test(s))
      // Identifiers that legitimately keep the old name.
      .filter(s => !/^[A-Z_]+$/.test(s))                       // ROLES constants
      .filter(s => !/^(submitted_to|returned_by|approved_by)_/.test(s))  // status values
      .filter(s => !/^calendar\.form\.|^admin\.hier\.|^roles\.|^status\./.test(s)) // i18n keys
      .filter(s => !s.startsWith('/api/'))                     // endpoint paths
      .filter(s => !s.startsWith('/pages/'));                  // dashboard URLs
    assert.deepEqual(strings, [], `${file} still contains the old display name`);
  }
});

test('the Supervisor is ხელმძღვანელი in Georgian and unchanged in English', () => {
  assert.equal(ka.roles.SUPERVISOR, 'ხელმძღვანელი');
  // The receiving-chain role shows the same label; the department name
  // underneath is what distinguishes it.
  assert.equal(ka.roles.RECEIVING_SUPERVISOR, ka.roles.SUPERVISOR);
  // English was not part of the rename.
  assert.equal(en.roles.SUPERVISOR, 'Supervisor');
  assert.equal(en.roles.RECEIVING_SUPERVISOR, 'Supervisor');
});

test('no Georgian string still says ზედამხედველი', () => {
  // Every inflected form shares the ზედამხედველ stem — genitive -ის, adessive
  // -თან, plural -ები — so one stem check covers the lot.
  const stale = Object.entries(kaFlat)
    .filter(([, v]) => v.includes('ზედამხედველ'))
    .map(([k, v]) => `${k} = ${v}`);
  assert.deepEqual(stale, [], 'ka.json still renders the old Supervisor name');

  for (const file of LABEL_SOURCES) {
    if (file.endsWith('.json')) continue;
    assert.ok(!read(file).includes('ზედამხედველ'), `${file} still contains the old Supervisor name`);
  }
});

test('the department list keeps ზედამხედველობა in agency names', () => {
  // Two real agencies are named for *supervision* as an activity, not for the
  // role — "ტექნიკური და სამშენებლო ზედამხედველობის სააგენტო" and "ბაზარზე
  // ზედამხედველობის სააგენტო". A blanket stem rename would corrupt them.
  const depts = JSON.parse(read('server/data/departments.json'));
  const kept = depts.filter(d => (d.name || '').includes('ზედამხედველობ'));
  assert.equal(kept.length, 2, 'the two supervision agencies must keep their own names');
  assert.ok(!depts.some(d => (d.name || '').includes('ხელმძღვანელობ')),
    'an agency name was caught by the role rename');
});

test('status labels name the Senior Editor', () => {
  assert.equal(en.status.submitted_to_super_collaborator, 'At Senior Editor');
  assert.equal(en.status.returned_by_super_collaborator, 'Returned by Senior Editor');
  assert.equal(en.status.approved_by_super_collaborator, 'Approved (Senior Editor)');
  // Georgian needs the adessive, with the adjective declined: უფროსი -> უფროს.
  assert.equal(ka.status.submitted_to_super_collaborator, 'უფროს შემსრულებელთან');
});

test('status labels name the Supervisor in the right case', () => {
  assert.equal(en.status.submitted_to_supervisor, 'At Supervisor');
  assert.equal(ka.status.submitted_to_supervisor, 'ხელმძღვანელთან');            // adessive
  assert.equal(ka.status.returned_by_supervisor, 'დაბრუნებული ხელმძღვანელის მიერ'); // genitive
  assert.equal(ka.status.approved_by_supervisor, 'დადასტურებული (ხელმძღვანელი)');   // nominative
});

test('the Georgian adessive map declines the adjective', () => {
  // dashboard-minister.js builds "with <role>" itself and bypasses the locale
  // files. Its generic fallback only strips the noun's trailing ი, which would
  // leave "უფროსი შემსრულებელთან" — so the entries must be explicit.
  const src = read('frontend/js/pages/dashboard-minister.js');
  assert.match(src, /COLLABORATOR: 'შემსრულებელთან'/);
  assert.match(src, /SUPERVISOR: 'ხელმძღვანელთან'/);
  assert.match(src, /RECEIVING_SUPERVISOR: 'ხელმძღვანელთან'/);
  assert.match(src, /SUPER_COLLABORATOR: 'უფროს შემსრულებელთან'/);
  assert.match(src, /RECEIVING_SUPER_COLLABORATOR: 'უფროს შემსრულებელთან'/);
  assert.doesNotMatch(src, /'უფროსი შემსრულებელთან'/);
});

test('the server email tables match the locale labels', () => {
  // event-notification-draft.js never reads the locale files, and its Georgian
  // table reaches real outgoing email bodies.
  const src = read('server/helpers/event-notification-draft.js');
  assert.match(src, /\[ROLES\.SUPER_COLLABORATOR\]: 'Senior Editor'/);
  assert.match(src, /\[ROLES\.COLLABORATOR\]: 'Editor'/);
  assert.match(src, new RegExp(`\\[ROLES\\.SUPER_COLLABORATOR\\]: '${ka.roles.SUPER_COLLABORATOR}'`));
  assert.match(src, new RegExp(`\\[ROLES\\.COLLABORATOR\\]: '${ka.roles.COLLABORATOR}'`));
  assert.match(src, new RegExp(`\\[ROLES\\.SUPERVISOR\\]: '${ka.roles.SUPERVISOR}'`));
  assert.match(src, new RegExp(`RECEIVING_SUPERVISOR: '${ka.roles.RECEIVING_SUPERVISOR}'`));
});

test('the two locale bundles stay key-for-key identical', () => {
  // Guards against renaming a string in one language and forgetting the other.
  const enKeys = Object.keys(enFlat).sort();
  const kaKeys = Object.keys(kaFlat).sort();
  assert.deepEqual(
    enKeys.filter(k => !kaKeys.includes(k)), [], 'keys present in en.json but missing from ka.json');
  assert.deepEqual(
    kaKeys.filter(k => !enKeys.includes(k)), [], 'keys present in ka.json but missing from en.json');
});

test('internal role identifiers are deliberately unchanged', () => {
  // The rename is display-only: stored section statuses are derived from these
  // names, so renaming them would mean migrating live approval state.
  const roles = read('server/helpers/roles.js');
  assert.match(roles, /COLLABORATOR: 'COLLABORATOR'/);
  assert.match(roles, /SUPER_COLLABORATOR: 'SUPER_COLLABORATOR'/);
  assert.ok(Object.prototype.hasOwnProperty.call(en.roles, 'COLLABORATOR'));
  assert.ok(Object.prototype.hasOwnProperty.call(en.status, 'submitted_to_super_collaborator'));
});
