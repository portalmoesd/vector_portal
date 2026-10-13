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
    Population: { total: { text: '4,900,961 (2024 est.)' } },
    Languages: { Languages: { text: 'Georgian (official) 87.6%' }, 'major-language sample(s)': { text: '<br>სატესტო<br><br>The World Factbook' } },
    Religions: { text: 'Orthodox (official) 83.4%' },
    'Age structure': { '0-14 years': { text: '18%' } },
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
    'Legal system': { text: 'civil law system' },
    Citizenship: { 'citizenship by birth': { text: 'no' } },
    Suffrage: { text: '18 years of age; universal' },
    'Legislative branch': {
      'legislature name': { text: 'Parliament (Sakartvelos Parlamenti)' },
      'legislative structure': { text: 'unicameral' },
      'number of seats': { text: '150 (all directly elected)' },
      'most recent election date': { text: '10/26/2024' },
      note: { text: 'some note' },
    },
    'Judicial branch': { 'highest court(s)': { text: 'Supreme Court' } },
    'International organization participation': { text: 'UN, WTO' },
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
  assert.deepStrictEqual(gov.map((r) => r.field), ['Country name', 'Executive branch', 'Legislative branch', 'National holiday']);
  const exec = gov.find((r) => r.field === 'Executive branch');
  assert.deepStrictEqual(exec.content.items.map((i) => i.label), ['election/appointment process']);
  // Legislative branch keeps only the chamber name and the number of seats.
  const leg = gov.find((r) => r.field === 'Legislative branch');
  assert.deepStrictEqual(leg.content.items.map((i) => i.label), ['legislature name', 'number of seats']);
  assert.strictEqual(leg.content.text, null);
  // People and Society is an allow-list of Languages and Religions.
  assert.deepStrictEqual(sections['People and Society'].map((r) => r.field), ['Languages', 'Religions']);
  assert.deepStrictEqual(sections['People and Society'][0].content.items.map((i) => i.label), ['Languages']);
  for (const gone of ['Ambassador Z', 'President X', 'Supreme Court', 'civil law system', 'UN, WTO', 'unicameral', 'some note', '4,900,961', 'The World Factbook']) {
    assert.ok(!JSON.stringify(sections).includes(gone), gone);
  }
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

test('the keep rules also filter stored rows at read time (stale rows from a wider snapshot stay hidden)', () => {
  assert.strictEqual(fb.isFieldKept('People and Society', 'Population'), false);
  assert.strictEqual(fb.isFieldKept('People and Society', 'Religions'), true);
  assert.strictEqual(fb.isFieldKept('Geography', 'Location'), false);
  assert.strictEqual(fb.isFieldKept('Geography', 'Climate'), true);
  assert.strictEqual(fb.isFieldKept('Government', 'Judicial branch'), false);
  assert.strictEqual(fb.isFieldKept('Economy', 'GDP'), false);
  // A legislative row stored with every sub-entry is reduced to the two kept ones.
  const stored = { text: 'ignored', items: [
    { label: 'legislature name', text: 'Parliament' }, { label: 'legislative structure', text: 'unicameral' },
    { label: 'number of seats', text: '150' }, { label: 'note', text: 'x' },
  ] };
  assert.deepStrictEqual(fb.filterContent('Government', 'Legislative branch', stored), {
    text: null, items: [{ label: 'legislature name', text: 'Parliament' }, { label: 'number of seats', text: '150' }],
  });
  // Officials entries stored earlier are dropped; the language sample too.
  const exec = { text: null, items: [{ label: 'chief of state', text: 'President X' }, { label: 'election results', text: 'r' }] };
  assert.deepStrictEqual(fb.filterContent('Government', 'Executive branch', exec).items.map((i) => i.label), ['election results']);
  const lang = { text: null, items: [{ label: 'Languages', text: 'Georgian' }, { label: 'major-language sample(s)', text: 'slogan' }] };
  assert.deepStrictEqual(fb.filterContent('People and Society', 'Languages', lang).items.map((i) => i.label), ['Languages']);
  // Nothing left -> null, so the row disappears.
  assert.strictEqual(fb.filterContent('Government', 'Executive branch', { text: null, items: [{ label: 'cabinet', text: 'c' }] }), null);
  assert.strictEqual(fb.filterContent('Geography', 'Climate', { text: 'warm', items: [] }).text, 'warm');
});

test('normalizeField trims sub-keys, sanitizes HTML and strips leading/trailing breaks', () => {
  const area = fb.normalizeField('Geography', 'Area', profile.Geography.Area);
  assert.strictEqual(area.text, null);
  assert.deepStrictEqual(area.items.map((i) => i.label), ['total', 'land', 'water']);
  const bg = fb.normalizeField('Introduction', 'Background', profile.Introduction.Background);
  assert.strictEqual(bg.text, 'Once upon a time.<br /><br />Then later.');
  const sample = fb.normalizeField('Geography', 'Sample', { note: { text: '<br>სატესტო<br><br>The World Factbook<br>' } });
  assert.strictEqual(sample.items[0].text, 'სატესტო<br /><br />The World Factbook');
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
  assert.deepStrictEqual(geo.sections['People and Society'].map((r) => r.field), ['Languages', 'Religions']);
  const govFields = geo.sections.Government.map((r) => r.field);
  assert.ok(!govFields.includes('Diplomatic representation in the US'));
  for (const f of ['Administrative divisions', 'Legal system', 'International law organization participation', 'Citizenship', 'Suffrage', 'Judicial branch', 'International organization participation']) {
    assert.ok(!govFields.includes(f), f);
  }
  const leg = geo.sections.Government.find((r) => r.field === 'Legislative branch');
  assert.deepStrictEqual(leg.content.items.map((i) => i.label), ['legislature name', 'number of seats']);
  const exec = geo.sections.Government.find((r) => r.field === 'Executive branch');
  assert.ok(!exec.content.items.some((i) => ['chief of state', 'head of government', 'cabinet'].includes(i.label)));
  assert.strictEqual(fb.readMeta().snapshotDate, '2026-01');
});
