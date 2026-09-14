// Clientes como entidad propia (agregado 14-sep-2026): antes vivían como texto suelto colgado
// de cada vehículo (cliente_nombre/cliente_correo) — eso no permitía saber que dos autos son
// del mismo dueño, ni reasignar un auto a otro dueño cuando se vende sin perder su historial.
// Ver src/migrate/migrar_clientes.js para cómo se migran los datos que ya existían.
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function normalizarCorreo(correo) {
  const c = String(correo || '').trim();
  return c || null;
}

// GET /api/clientes?q=texto -> busca por nombre o correo (para el autocompletado al agendar o
// al registrar un vehículo — "¿es un cliente que ya existe, o uno nuevo?"). Cualquier usuario
// autenticado, igual que buscar vehículos.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let r;
    if (q) {
      r = await pool.query(
        `SELECT c.id, c.nombre, c.correo, COUNT(v.id)::int AS vehiculos_count
         FROM clientes c
         LEFT JOIN vehiculos v ON v.cliente_id = c.id
         WHERE c.nombre ILIKE $1 OR c.correo ILIKE $1
         GROUP BY c.id
         ORDER BY c.nombre ASC
         LIMIT 20`,
        [`%${q}%`]
      );
    } else {
      r = await pool.query(
        `SELECT c.id, c.nombre, c.correo, COUNT(v.id)::int AS vehiculos_count
         FROM clientes c
         LEFT JOIN vehiculos v ON v.cliente_id = c.id
         GROUP BY c.id
         ORDER BY c.nombre ASC
         LIMIT 50`
      );
    }
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo buscar clientes.' });
  }
});

// POST /api/clientes -> crear un cliente nuevo. Si ya existe uno con el mismo correo, se
// reusa ese en vez de crear un duplicado (mismo criterio que la migración) — así da lo mismo
// si dos pantallas distintas (Vehículos, Agenda) "crean" al mismo cliente por su correo.
router.post('/', async (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim();
  const correo = normalizarCorreo((req.body || {}).correo);
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
  try {
    if (correo) {
      const existente = await pool.query('SELECT id, nombre, correo FROM clientes WHERE LOWER(correo) = LOWER($1)', [correo]);
      if (existente.rows[0]) return res.status(200).json(existente.rows[0]);
    }
    const r = await pool.query(
      'INSERT INTO clientes (nombre, correo) VALUES ($1, $2) RETURNING id, nombre, correo',
      [nombre, correo]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo crear el cliente.' });
  }
});

// GET /api/clientes/:id -> detalle + todos sus vehículos (para ver, ej., que el mismo cliente
// tiene 2 autos registrados).
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await pool.query('SELECT id, nombre, correo FROM clientes WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const v = await pool.query(
      'SELECT id, patente, marca, modelo, anio FROM vehiculos WHERE cliente_id = $1 ORDER BY creado_en DESC',
      [id]
    );
    res.json({ cliente: c.rows[0], vehiculos: v.rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar el cliente.' });
  }
});

// PUT /api/clientes/:id -> corregir nombre/correo del cliente (ej. arreglar un correo mal
// tipeado). No toca qué vehículos le pertenecen — eso se hace desde el vehículo (ver
// PUT /api/vehiculos/:id/cliente), porque ahí es donde tiene sentido decidir "este auto cambió
// de dueño".
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const nombre = String((req.body || {}).nombre || '').trim();
  const correo = normalizarCorreo((req.body || {}).correo);
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
  try {
    const r = await pool.query(
      'UPDATE clientes SET nombre = $1, correo = $2, actualizado_en = now() WHERE id = $3 RETURNING id, nombre, correo',
      [nombre, correo, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo actualizar el cliente.' });
  }
});

module.exports = router;
