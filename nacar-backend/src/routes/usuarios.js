const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/usuarios -> lista de cuentas del taller (sin password)
router.get('/', async (req, res) => {
  const r = await pool.query('SELECT id, nombre, correo, rol, activo, acceso_taller, acceso_agenda, creado_en FROM usuarios ORDER BY creado_en ASC');
  res.json(r.rows);
});

// POST /api/usuarios -> crear cuenta para un mecánico/recepción (o otro admin)
router.post('/', async (req, res) => {
  const { nombre, correo, password, rol } = req.body || {};
  const accesoTaller = (req.body || {}).accesoTaller !== false;
  const accesoAgenda = (req.body || {}).accesoAgenda !== false;
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
      `INSERT INTO usuarios (nombre, correo, password_hash, rol, acceso_taller, acceso_agenda) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, nombre, correo, rol, activo, acceso_taller, acceso_agenda, creado_en`,
      [nombre, String(correo).trim().toLowerCase(), hash, rolFinal, accesoTaller, accesoAgenda]
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

// PUT /api/usuarios/:id/acceso -> a qué secciones puede entrar una cuenta (Taller y/o Agenda).
// Los administradores siempre tienen todo, así que a ellos no se les limita.
router.put('/:id/acceso', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE usuarios
     SET acceso_taller = COALESCE($1, acceso_taller), acceso_agenda = COALESCE($2, acceso_agenda)
     WHERE id = $3 AND rol <> 'admin'
     RETURNING id, nombre, rol, acceso_taller, acceso_agenda`,
    [typeof b.acceso_taller === 'boolean' ? b.acceso_taller : null, typeof b.acceso_agenda === 'boolean' ? b.acceso_agenda : null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada, o es administrador (siempre tiene todo el acceso).' });
  res.json(r.rows[0]);
});

module.exports = router;
