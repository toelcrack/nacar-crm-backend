// Marca una cuenta como administrador supremo (el dueño). Uso:
//   node src/migrate/marcar_supremo.js tomas        (busca por parte del nombre o del correo)
// Si hay más de una coincidencia, las lista y no cambia nada. Deja un solo supremo.
require('dotenv').config();
const { pool } = require('../db');

async function main() {
  const q = String(process.argv[2] || '').trim();
  if (!q) { console.log('Falta el nombre o correo a buscar.'); process.exit(1); }
  const r = await pool.query(
    `SELECT id, nombre, correo, rol, activo FROM usuarios WHERE nombre ILIKE $1 OR correo ILIKE $1 ORDER BY id`,
    ['%' + q + '%']
  );
  if (r.rows.length !== 1) {
    console.log(r.rows.length ? 'Hay varias coincidencias, usa un correo completo:' : 'No encontré cuentas con ese texto.');
    r.rows.forEach((u) => console.log(` - #${u.id} ${u.nombre} <${u.correo}> ${u.rol}${u.activo ? '' : ' (desactivada)'}`));
    await pool.end();
    return;
  }
  const u = r.rows[0];
  await pool.query("UPDATE usuarios SET rol = 'admin', activo = true WHERE id = $1", [u.id]);
  await pool.query('UPDATE usuarios SET es_supremo = (id = $1)', [u.id]);
  console.log(`Listo: ${u.nombre} <${u.correo}> es ahora el administrador supremo.`);
  await pool.end();
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
