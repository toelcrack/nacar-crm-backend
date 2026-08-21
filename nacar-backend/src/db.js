const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('Falta la variable de entorno DATABASE_URL. Revisa tu archivo .env (usa .env.example de guía).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/Render entregan Postgres con SSL. En desarrollo local normalmente no hace falta.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
