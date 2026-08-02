/**
 * Seed script — creates tables and inserts initial data.
 * Usage: node server/seed.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seed() {
  console.log('Running schema...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema applied.');

  console.log('Seeding countries...');
  const countries = require('./data/countries.json');
  const { georgianCountryName } = require('./helpers/country-names');
  for (const c of countries) {
    await db.query(
      `INSERT INTO countries (name_en, code, name_ka) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [c.name, c.code, georgianCountryName(c.code)]
    );
  }
  console.log(`Seeded ${countries.length} countries.`);

  console.log('Creating default admin user...');
  const hash = await bcrypt.hash('admin123', 10);
  await db.query(
    `INSERT INTO users (full_name, username, email, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (username) DO NOTHING`,
    ['System Administrator', 'admin', 'admin@vector-portal.gov.ge', hash, 'ADMIN']
  );
  console.log('Admin user created (admin / admin123).');

  console.log('Seed complete.');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
