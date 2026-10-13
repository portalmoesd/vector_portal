const test = require('node:test');
const assert = require('node:assert');
const fb = require('../../server/country-profiles/factbook');

const profile = {
  Introduction: { Background: { text: 'Once upon a time.<br><br>Then later.<script>alert(1)</script>' } },
  Geography: {
    Location: { text: 'Southwestern Asia' },
    'Map references': { text: 'Asia' },
    Area: { 'total ': { text: '69,700 sq km' }, land: { text: '69,700 sq km' }, water: { text: '0 sq km' } },
    Climate: { text: 'warm and pleasant' },
    'Empty field': {},
  },
  'People and Society': {
    Languages: { Languages: { text: 'Georgian (official) 87.6%' }, 'major-language sample(s)': { text: '<br>სატესტო<br><br>The World Factbook' } },
  },
  Government: {
    'Country name': { 'conventional short form': { text: 'Georgia' }, 'conventional long form': { text: 'none' } },
    'Executive branch': {
      'chief of state': { text: 'President X' },
      'head of government': { text: 'Prime Minister Y' },
      cabinet: { text: 'Cabinet of Ministers' },
      'election/appointment process': { text: 'elected by a College of Electors' },
    },
    'Diplomatic representation in the US': { 'chief of mission': { text: 'Ambassador Z' } },
    'National holiday': { text: 'Independence Day, 26 May (1918)' },
  },
  Economy: { 'Economic overview': { text: 'ignored here' } },
};

test('extractProfile keeps the four sections, drops officials and empty fields, keeps order', () => {
  const { sections } = fb.extractProfile(profile);
  assert.deepStrictEqual(Object.keys(sections), ['Introduction', 'Geography', 'People and Society', 'Government']);
  // Location and Area are excluded geography detail; Map references and Climate stay.
  assert.deepStrictEqual(sections.Geography.map((r) => r.field), ['Map references', 'Climate']);
  assert.deepStrictEqual(sections.Geography.map((r) => r.order), [10, 20]);
  const gov = sections.Government;
  assert.deepStrictEqual(gov.map((r) => r.field), ['Country name', 'Executive branch', 'National holiday']);
  const exec = gov.find((r) => r.field === 'Executive branch');
  assert.deepStrictEqual(exec.content.items.map((i) => i.label), ['election/appointment process']);
  assert.ok(!JSON.stringify(sections).includes('Ambassador Z'));
  assert.ok(!JSON.stringify(sections).includes('President X'));
});

test('displayPlacement sends geography to Overview with Map references shown as Continent', () => {
  assert.deepStrictEqual(fb.displayPlacement('Geography', 'Map references'), { page: 'overview', label: 'Continent' });
  assert.deepStrictEqual(fb.displayPlacement('Geography', 'Natural hazards'), { page: 'overview', label: 'Natural hazards' });
  assert.deepStrictEqual(fb.displayPlacement('Introduction', 'Background'), { page: 'introduction', label: 'Background' });
  assert.deepStrictEqual(fb.displayPlacement('People and Society', 'Languages'), { page: 'people', label: 'Languages' });
  assert.deepStrictEqual(fb.displayPlacement('Government', 'Flag'), { page: 'government', label: 'Flag' });
  assert.strictEqual(fb.displayPlacement('Economy', 'GDP').page, null);
  for (const f of ['Location', 'Geographic coordinates', 'Area', 'Area - comparative', 'Maritime claims', 'Land use', 'Irrigated land']) {
    assert.ok(fb.EXCLUDED_FIELDS.Geography.includes(f), f);
  }
});

test('normalizeField trims sub-keys, sanitizes HTML and strips leading/trailing breaks', () => {
  const area = fb.normalizeField('Geography', 'Area', profile.Geography.Area);
  assert.strictEqual(area.text, null);
  assert.deepStrictEqual(area.items.map((i) => i.label), ['total', 'land', 'water']);
  const bg = fb.normalizeField('Introduction', 'Background', profile.Introduction.Background);
  assert.strictEqual(bg.text, 'Once upon a time.<br /><br />Then later.');
  const lang = fb.normalizeField('People and Society', 'Languages', profile['People and Society'].Languages);
  assert.strictEqual(lang.items[1].text, 'სატესტო<br /><br />The World Factbook');
});

test('cleanText decodes entities and removes disallowed tags but keeps emphasis and lists', () => {
  assert.strictEqual(fb.cleanText('C&ocirc;te d&#39;Ivoire'), "Côte d'Ivoire");
  assert.strictEqual(fb.cleanText('<a href="x">link</a> <em>em</em> <strong>b</strong><img src=x onerror=alert(1)>'), 'link <em>em</em> <strong>b</strong>');
  assert.strictEqual(fb.cleanText('<ul><li>one</li></ul>'), '<ul><li>one</li></ul>');
  assert.strictEqual(fb.cleanText('   '), null);
  assert.strictEqual(fb.cleanText(null), null);
});

test('factbookName prefers the conventional short form and falls back to the long form', () => {
  assert.strictEqual(fb.factbookName(profile), 'Georgia');
  assert.strictEqual(fb.factbookName({ Government: { 'Country name': { 'conventional short form': { text: 'none' }, 'conventional long form': { text: 'Federated States of Micronesia' } } } }), 'Federated States of Micronesia');
  assert.strictEqual(fb.factbookName({}), null);
});

test('the committed snapshot covers the mapped economies and contains no officials fields', () => {
  const fs = require('fs');
  const path = require('path');
  const mapping = JSON.parse(fs.readFileSync(path.join(fb.DATA_DIR, 'gec-to-iso3.json'), 'utf8'));
  const files = fb.listProfiles();
  assert.strictEqual(files.length, Object.keys(mapping).length);
  const geo = JSON.parse(fs.readFileSync(path.join(fb.PROFILES_DIR, 'GEO.json'), 'utf8'));
  assert.strictEqual(geo.gec, 'gg');
  assert.strictEqual(geo.name, 'Georgia');
  assert.ok(geo.sections.Introduction[0].content.text.includes('Colchis'));
  const geoFields = geo.sections.Geography.map((r) => r.field);
  assert.ok(!geoFields.includes('Location') && !geoFields.includes('Area') && !geoFields.includes('Land use'));
  assert.ok(geoFields.includes('Map references') && geoFields.includes('Climate') && geoFields.includes('Natural resources'));
  const govFields = geo.sections.Government.map((r) => r.field);
  assert.ok(!govFields.includes('Diplomatic representation in the US'));
  const exec = geo.sections.Government.find((r) => r.field === 'Executive branch');
  assert.ok(!exec.content.items.some((i) => ['chief of state', 'head of government', 'cabinet'].includes(i.label)));
  assert.strictEqual(fb.readMeta().snapshotDate, '2026-01');
});
