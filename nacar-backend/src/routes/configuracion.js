const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const TABLAS = { marcas: 'marcas', tecnicos: 'tecnicos' };

function tablaValida(tipo) {
  return TABLAS[tipo] || null;
}

// GET /api/configuracion/:tipo  -> lista completa (marcas o tecnicos), cualquier usuario autenticado
router.get('/:tipo', async (req, res) => {
  const tabla = tablaValida(req.params.tipo);
  if (!tabla) return res.status(404).json({ error: 'Lista no encontrada.' });
  try {
    const r = await pool.query(`SELECT id, nombre FROM ${tabla} ORDER BY nombre ASC`);
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar la lista.' });
  }
});

// POST /api/configuracion/:tipo  -> agregar un valor nuevo (cualquier usuario autenticado,
// para que un mecánico pueda sumar una marca o técnico que falte sin tener que pedir ayuda).
router.post('/:tipo', async (req, res) => {
  const tabla = tablaValida(req.params.tipo);
  if (!tabla) return res.status(404).json({ error: 'Lista no encontrada.' });
  const nombre = String((req.body || {}).nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre.' });
  try {
    const existente = await pool.query(`SELECT id, nombre FROM ${tabla} WHERE LOWER(nombre) = LOWER($1)`, [nombre]);
    if (existente.rows[0]) return res.status(200).json(existente.rows[0]);
    const r = await pool.query(`INSERT INTO ${tabla} (nombre) VALUES ($1) RETURNING id, nombre`, [nombre]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const existente = await pool.query(`SELECT id, nombre FROM ${tabla} WHERE LOWER(nombre) = LOWER($1)`, [nombre]);
      if (existente.rows[0]) return res.status(200).json(existente.rows[0]);
    }
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo agregar.' });
  }
});

// DELETE /api/configuracion/:tipo/:id  -> eliminar un valor (solo administrador, para limpiar
// duplicados o errores de tipeo; no afecta vehículos/mantenciones ya guardados, esos quedan igual).
router.delete('/:tipo/:id', requireAdmin, async (req, res) => {
  const tabla = tablaValida(req.params.tipo);
  if (!tabla) return res.status(404).json({ error: 'Lista no encontrada.' });
  const id = Number(req.params.id);
  try {
    const r = await pool.query(`DELETE FROM ${tabla} WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo eliminar.' });
  }
});

module.exports = router;
