// Lógica compartida para resolver o crear un cliente (agregado 14-sep-2026, junto con la tabla
// "clientes" — ver esquema.sql y migrar_clientes.js). La reusan src/routes/vehiculos.js (al
// registrar/editar un vehículo) y src/routes/citas.js (al agendar con un vehículo nuevo), para
// que las dos pantallas se comporten igual: si viene un clienteId ya elegido (de un buscador de
// clientes existentes), se usa tal cual; si vienen nombre/correo sueltos, se reusa el cliente que
// ya tenga ese correo (así un cliente con dos autos queda con un solo registro, no dos) o se
// crea uno nuevo si no existe.
const { pool } = require('./db');

function normalizarCorreo(correo) {
  const c = String(correo || '').trim();
  return c || null;
}

// datos: { clienteId, clienteNombre, clienteCorreo, clienteIdActual }. Devuelve el id de
// cliente a usar.
//
// clienteIdActual (opcional) es el cliente que YA tenía vinculado el vehículo que se está
// editando — se usa solo en el formulario normal de "editar vehículo" (los mismos 2 campos de
// texto de siempre), para que corregir un dato (ej. arreglar el correo mal tipeado) ACTUALICE
// ese mismo cliente en vez de crear uno nuevo y dejar el auto "separado" de sus otros autos. Sin
// clienteIdActual (como al registrar un vehículo nuevo, o al reasignar el dueño explícitamente
// con PUT /vehiculos/:id/cliente), nombre/correo sueltos siempre buscan-o-crean un cliente
// distinto — nunca modifican en silencio un cliente que ya tenía otro auto.
async function resolverClienteId({ clienteId, clienteNombre, clienteCorreo, clienteTelefono, clienteIdActual }) {
  if (clienteId) {
    const r = await pool.query('SELECT id FROM clientes WHERE id = $1', [Number(clienteId)]);
    return r.rows[0] ? r.rows[0].id : null;
  }
  const nombre = String(clienteNombre || '').trim();
  const correo = normalizarCorreo(clienteCorreo);
  const telefono = String(clienteTelefono || '').trim() || null;
  if (!nombre && !correo && !telefono) return clienteIdActual || null;

  if (correo) {
    const existente = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = LOWER($1)', [correo]);
    if (existente.rows[0]) {
      if (telefono) await pool.query('UPDATE clientes SET telefono = $1 WHERE id = $2', [telefono, existente.rows[0].id]);
      return existente.rows[0].id;
    }
  }

  // Sin correo: reusar al cliente si el teléfono ya está registrado, o si hay exactamente UN
  // cliente con ese mismo nombre — así un cliente con dos autos no queda duplicado (y su
  // teléfono se lee del cliente existente en vez de pedirlo de nuevo). Solo al crear/asignar,
  // nunca al corregir los datos de un vehículo existente (clienteIdActual).
  if (!clienteIdActual) {
    let existente = null;
    if (telefono) {
      const t = await pool.query('SELECT id FROM clientes WHERE telefono = $1 ORDER BY id LIMIT 2', [telefono]);
      if (t.rows.length === 1) existente = t.rows[0].id;
    }
    if (!existente && nombre && !correo) {
      const n = await pool.query('SELECT id FROM clientes WHERE LOWER(TRIM(nombre)) = LOWER($1) LIMIT 2', [nombre]);
      if (n.rows.length === 1) existente = n.rows[0].id;
    }
    if (existente) {
      if (telefono) await pool.query('UPDATE clientes SET telefono = $1, actualizado_en = now() WHERE id = $2', [telefono, existente]);
      if (correo) await pool.query('UPDATE clientes SET correo = COALESCE(correo, $1) WHERE id = $2', [correo, existente]);
      return existente;
    }
  }

  if (clienteIdActual) {
    await pool.query(
      'UPDATE clientes SET nombre = $1, correo = $2, telefono = $3, actualizado_en = now() WHERE id = $4',
      [nombre || 'Sin nombre', correo, telefono, clienteIdActual]
    );
    return clienteIdActual;
  }

  const r = await pool.query('INSERT INTO clientes (nombre, correo, telefono) VALUES ($1, $2, $3) RETURNING id', [nombre || 'Sin nombre', correo, telefono]);
  return r.rows[0].id;
}

module.exports = { resolverClienteId };
