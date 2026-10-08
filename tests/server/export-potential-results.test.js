const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../server/config');
const results = require('../../server/export-potential/results');
const { buildSampleResult } = require('../../server/export-potential/sample');

test('the sample partner is consistent with the engine and the contract', () => {
  const s = buildSampleResult();
  assert.strictEqual(s.sample, true);
  assert.ok(results.isValidResult(s));
  assert.ok(s.products.length >= 6);
  for (const p of s.products) {
    const sum = p.blocks.demandSize + p.blocks.demandGrowth + p.blocks.competitionAccess + p.blocks.georgiaPosition;
    assert.strictEqual(sum, p.score, `${p.hs4} blocks sum`);
    assert.ok(['High', 'Moderate', 'Low'].includes(p.rating));
    if (p.cap) assert.ok(p.flags.some((f) => f.code === `cap_${p.cap}`), `${p.hs4} cap flag`);
  }
  const wine = s.products.find((p) => p.hs4 === '2204');
  assert.strictEqual(wine.score, 77);
  assert.strictEqual(wine.rating, 'High');
  assert.strictEqual(wine.cap, null);
  assert.ok(s.products.some((p) => p.cap === 'small_market'));
  assert.ok(s.products.some((p) => p.cap === 'steep_decline'));
  assert.ok(s.products.some((p) => p.gate2.status === 'new'));
  assert.ok(s.products.some((p) => p.rating === 'Low'));
  assert.ok(s.products.some((p) => p.flags.some((f) => f.code === 'tariff_missing')));
  assert.strictEqual(s.watch.length, 2);
});

test('getCountry enriches products with HS4 names in both languages and sorts by rating then score', () => {
  const r = results.getCountry('smp');
  assert.ok(r);
  assert.strictEqual(r.summary.total, r.products.length);
  const wine = r.products.find((p) => p.hs4 === '2204');
  assert.strictEqual(wine.name.en, 'Wine');
  assert.ok(/ღვინო/.test(wine.name.ka), wine.name.ka);
  const rank = { High: 2, Moderate: 1, Low: 0 };
  for (let i = 1; i < r.products.length; i++) {
    const a = r.products[i - 1]; const b = r.products[i];
    assert.ok(rank[a.rating] > rank[b.rating] || (rank[a.rating] === rank[b.rating] && a.score >= b.score));
  }
  assert.strictEqual(results.getCountry('nope'), null);
  assert.strictEqual(results.getCountry('../etc/passwd'), null);
});

test('listCountries ends with the sample partner, marked as such', () => {
  const list = results.listCountries();
  const last = list[list.length - 1];
  assert.strictEqual(last.code, 'SMP');
  assert.strictEqual(last.sample, true);
  assert.strictEqual(last.summary.High + last.summary.Moderate + last.summary.Low, last.summary.total);
});

// ── Route guard ──────────────────────────────────────────────────────────
function startApp() {
  const app = express();
  app.use('/api/export-potential', require('../../server/routes/export-potential'));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    http.get({ host: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

test('the API is admin-only', async () => {
  const server = await startApp();
  try {
    const admin = jwt.sign({ id: 1, role: 'ADMIN' }, config.jwtSecret);
    const analyst = jwt.sign({ id: 2, role: 'ANALYST' }, config.jwtSecret);
    const deputy = jwt.sign({ id: 3, role: 'DEPUTY' }, config.jwtSecret);

    assert.strictEqual((await get(server, '/api/export-potential/countries')).status, 401);
    assert.strictEqual((await get(server, '/api/export-potential/countries', analyst)).status, 403);
    assert.strictEqual((await get(server, '/api/export-potential/countries/SMP', deputy)).status, 403);
    assert.strictEqual((await get(server, '/api/export-potential/config', deputy)).status, 403);

    const list = await get(server, '/api/export-potential/countries', admin);
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.some((c) => c.code === 'SMP'));

    const one = await get(server, '/api/export-potential/countries/SMP', admin);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.dataYear, 2025);
    assert.ok(Array.isArray(one.body.products));

    assert.strictEqual((await get(server, '/api/export-potential/countries/ZZZ', admin)).status, 404);

    const cfg = await get(server, '/api/export-potential/config', admin);
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.body.rating.highMin, 65);
  } finally {
    server.close();
  }
});

test('a real result file is listed from the index and served with names', () => {
  const fs = require('fs');
  const path = require('path');
  const { writeIndex } = require('../../server/export-potential/pipeline/write-index');
  const sample = buildSampleResult();
  const fake = { ...sample, sample: false, partner: { iso3: 'ZZT', iso2: 'zz', nameEn: 'Testland', nameKa: 'ტესტლანდი' } };
  const file = path.join(results.RESULTS_DIR, 'ZZT.json');
  const hadIndex = fs.existsSync(results.INDEX_FILE);
  const oldIndex = hadIndex ? fs.readFileSync(results.INDEX_FILE) : null;
  try {
    fs.writeFileSync(file, JSON.stringify(fake));
    writeIndex(results.RESULTS_DIR);
    const list = results.listCountries();
    const entry = list.find((c) => c.code === 'ZZT');
    assert.ok(entry, 'listed from the index');
    assert.strictEqual(entry.sample, false);
    assert.strictEqual(entry.summary.total, fake.products.length);
    assert.strictEqual(list[list.length - 1].code, 'SMP');
    const r = results.getCountry('zzt');
    assert.strictEqual(r.partner.nameEn, 'Testland');
    assert.strictEqual(r.products.find((p) => p.hs4 === '2204').name.en, 'Wine');
    // A file removed after the index was written is not listed.
    fs.unlinkSync(file);
    assert.ok(!results.listCountries().some((c) => c.code === 'ZZT'));
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (hadIndex) fs.writeFileSync(results.INDEX_FILE, oldIndex); else if (fs.existsSync(results.INDEX_FILE)) fs.unlinkSync(results.INDEX_FILE);
  }
});
