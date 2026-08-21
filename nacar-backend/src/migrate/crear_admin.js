// Crea (o actualiza la contraseña de) la primera cuenta administradora.
// Uso: node src/migrate/crear_admin.js "Tu Nombre" tu@correo.com "tu-contraseña"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

async function main() {
  const [, , nombre, correo, password] = process.argv;
  if (!nombre || !correo || !password) {
    console.error('Uso: node src/migrate/crear_admin.js "Tu Nombre" tu@correo.com "tu-contraseña"');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('La contraseña debe tener al menos 6 caracteres.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const correoNorm = correo.trim().toLowerCase();
  const r = await pool.query(
    `INSERT INTO usuarios (nombre, correo, password_hash, rol)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (correo) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = 'admin', activo = true
     RETURNING id, nombre, correo, rol`,
    [nombre, correoNorm, hash]
  );
  console.log('Cuenta administradora lista:', r.rows[0]);
  await pool.end();
}

main().catch((e) => {
  console.error('Error creando la cuenta admin:', e);
  process.exit(1);
});
