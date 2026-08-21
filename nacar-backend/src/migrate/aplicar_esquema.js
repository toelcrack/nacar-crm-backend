require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Esquema aplicado correctamente.');
  await pool.end();
}

main().catch((e) => {
  console.error('Error aplicando el esquema:', e);
  process.exit(1);
});
