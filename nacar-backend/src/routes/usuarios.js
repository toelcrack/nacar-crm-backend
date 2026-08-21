const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/usuarios -> lista de cuentas del taller (sin password)
router.get('/', async (req, res) => {
  const r = await pool.query('SELECT id, nombre, correo, rol, activo, creado_en FROM usuarios ORDER BY creado_en ASC');
  res.json(r.rows);
});

// POST /api/usuarios -> crear cuenta para un mecánico/recepción (o otro admin)
router.post('/', async (req, res) => {
  const { nombre, correo, password, rol } = req.body || {};
  if (!nombre || !correo || !password) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña son obligatorios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const rolFinal = rol === 'admin' ? 'admin' : 'mecanico';
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      `INSERT INTO usuarios (nombre, correo, password_hash, rol) VALUES ($1,$2,$3,$4)
       RETURNING id, nombre, correo, rol, activo, creado_en`,
      [nombre, String(correo).trim().toLowerCase(), hash, rolFinal]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

// PUT /api/usuarios/:id/activo -> activar/desactivar una cuenta (en vez de borrarla)
router.put('/:id/activo', async (req, res) => {
  const id = Number(req.params.id);
  const activo = !!(req.body || {}).activo;
  if (id === req.usuario.id && !activo) {
    return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta.' });
  }
  const r = await pool.query(
    'UPDATE usuarios SET activo=$1 WHERE id=$2 RETURNING id, nombre, correo, rol, activo',
    [activo, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json(r.rows[0]);
});

module.exports = router;
