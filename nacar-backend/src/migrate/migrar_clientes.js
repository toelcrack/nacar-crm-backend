// Migra los clientes que hoy viven como texto suelto en vehiculos.cliente_nombre/cliente_correo
// a la tabla propia "clientes" + vehiculos.cliente_id (agregado 14-sep-2026).
//
// Idempotente y seguro de correr muchas veces: solo toca vehículos con cliente_id todavía NULL.
// Un correo repetido en más de un vehículo se reconoce como EL MISMO cliente (así un cliente con
// dos autos queda con un solo registro de cliente, no dos) — sin correo, no hay forma segura de
// saber si dos nombres iguales son la misma persona, así que cada vehículo sin correo se queda
// con su propio cliente nuevo (mejor eso que fusionar por error dos personas distintas).
//
// Uso: node src/migrate/migrar_clientes.js
require('dotenv').config();
const { pool } = require('../db');

function normalizarCorreo(correo) {
  const c = String(correo || '').trim().toLowerCase();
  return c || null;
}

async function main() {
  const r = await pool.query(
    `SELECT id, cliente_nombre, cliente_correo FROM vehiculos
     WHERE cliente_id IS NULL AND (COALESCE(cliente_nombre,'') <> '' OR COALESCE(cliente_correo,'') <> '')`
  );

  let clientesNuevos = 0;
  let clientesReusados = 0;
  let vehiculosActualizados = 0;
  const cacheCorreoAId = new Map();

  for (const v of r.rows) {
    const nombre = (v.cliente_nombre || '').trim() || 'Sin nombre';
    const correo = normalizarCorreo(v.cliente_correo);

    let clienteId;
    if (correo && cacheCorreoAId.has(correo)) {
      clienteId = cacheCorreoAId.get(correo);
    } else if (correo) {
      const existente = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = $1 LIMIT 1', [correo]);
      if (existente.rows[0]) {
        clienteId = existente.rows[0].id;
        clientesReusados++;
      } else {
        const nuevo = await pool.query(
          'INSERT INTO clientes (nombre, correo) VALUES ($1, $2) RETURNING id',
          [nombre, v.cliente_correo.trim()]
        );
        clienteId = nuevo.rows[0].id;
        clientesNuevos++;
      }
      cacheCorreoAId.set(correo, clienteId);
    } else {
      const nuevo = await pool.query('INSERT INTO clientes (nombre, correo) VALUES ($1, NULL) RETURNING id', [nombre]);
      clienteId = nuevo.rows[0].id;
      clientesNuevos++;
    }

    await pool.query('UPDATE vehiculos SET cliente_id = $1 WHERE id = $2', [clienteId, v.id]);
    vehiculosActualizados++;
  }

  console.log('Migración de clientes terminada.');
  console.log('  Vehículos revisados (con nombre/correo y sin cliente_id todavía):', r.rows.length);
  console.log('  Vehículos actualizados con cliente_id:', vehiculosActualizados);
  console.log('  Clientes nuevos creados:', clientesNuevos);
  console.log('  Clientes reusados (mismo correo en más de un auto):', clientesReusados);
  await pool.end();
}

main().catch((e) => {
  console.error('Error migrando clientes:', e);
  process.exit(1);
});
