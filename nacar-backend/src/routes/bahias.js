const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
// Cualquier usuario logueado (admin o mecánico) puede ver y mover la agenda del taller —
// es organización del día a día del taller físico, no un dato sensible como Estadísticas.
router.use(requireAuth);

// GET /api/bahias -> estado de las bahías (elevadores + patio), con el vehículo si está ocupada.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.nombre, b.tipo, b.orden, b.nota, b.ocupado_desde,
              v.id AS vehiculo_id, v.patente, v.marca, v.modelo, v.anio, v.cliente_nombre
       FROM bahias b
       LEFT JOIN vehiculos v ON v.id = b.vehiculo_id
       ORDER BY b.orden ASC, b.id ASC`
    );
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar la agenda del taller.' });
  }
});

// POST /api/bahias/:id/asignar -> pone un vehículo (por patente, ya registrado en Vehículos) en la bahía.
router.post('/:id/asignar', async (req, res) => {
  const id = Number(req.params.id);
  const patente = String((req.body || {}).patente || '').trim().toUpperCase();
  const nota = String((req.body || {}).nota || '').trim();
  if (!patente) return res.status(400).json({ error: 'Escribe la patente del vehículo.' });
  try {
    const v = await pool.query('SELECT id FROM vehiculos WHERE patente = $1', [patente]);
    if (!v.rows[0]) {
      return res.status(404).json({
        error: 'Esa patente no está registrada todavía. Regístrala primero en la pestaña Vehículos y luego asígnala aquí.',
      });
    }
    const r = await pool.query(
      `UPDATE bahias SET vehiculo_id = $1, nota = $2, ocupado_desde = now() WHERE id = $3 RETURNING id`,
      [v.rows[0].id, nota, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo asignar el vehículo.' });
  }
});

// POST /api/bahias/:id/liberar -> deja la bahía disponible de nuevo (no borra nada del historial del auto).
router.post('/:id/liberar', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE bahias SET vehiculo_id = NULL, nota = NULL, ocupado_desde = NULL WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo liberar la bahía.' });
  }
});

// PUT /api/bahias/:id/nota -> corrige solo la nota (qué se le está haciendo), sin tocar el vehículo asignado.
router.put('/:id/nota', async (req, res) => {
  const id = Number(req.params.id);
  const nota = String((req.body || {}).nota || '').trim();
  try {
    const r = await pool.query('UPDATE bahias SET nota = $1 WHERE id = $2 RETURNING id', [nota, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo actualizar la nota.' });
  }
});

module.exports = router;
