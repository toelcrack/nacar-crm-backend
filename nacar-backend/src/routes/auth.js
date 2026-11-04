const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth, permisosDe } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { correo, password } = req.body || {};
  if (!correo || !password) {
    return res.status(400).json({ error: 'Escribe tu correo y tu contraseña.' });
  }
  const r = await pool.query(
    'SELECT id, nombre, correo, password_hash, rol, activo FROM usuarios WHERE correo = $1',
    [String(correo).trim().toLowerCase()]
  );
  const usuario = r.rows[0];
  if (!usuario || !usuario.activo) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  const ok = await bcrypt.compare(password, usuario.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  const token = firmarToken(usuario);
  setCookieSesion(res, token);
  const p = await permisosDe(usuario.id);
  res.json({ nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol, acceso_taller: !!(p && p.taller), acceso_agenda: !!(p && p.agenda) });
});

router.post('/logout', (req, res) => {
  borrarCookieSesion(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const p = await permisosDe(req.usuario.id);
  if (!p) return res.status(401).json({ error: 'Tu cuenta está desactivada o ya no existe.' });
  res.json(Object.assign({}, req.usuario, { acceso_taller: p.taller, acceso_agenda: p.agenda }));
});

module.exports = router;
