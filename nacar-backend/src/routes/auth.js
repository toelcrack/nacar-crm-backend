const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth, permisosDe, esSupremo } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { correo, password } = req.body || {};
  const recordar = (req.body || {}).recordar !== false;
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
  const token = firmarToken(usuario, recordar);
  setCookieSesion(res, token, recordar);
  const p = await permisosDe(usuario.id);
  res.json({ nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol, acceso_taller: !!(p && p.taller), acceso_agenda: !!(p && p.agenda), agenda_editar: !!(p && p.agenda_editar), es_supremo: await esSupremo(usuario.id) });
});

router.post('/logout', (req, res) => {
  borrarCookieSesion(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const p = await permisosDe(req.usuario.id);
  if (!p) return res.status(401).json({ error: 'Tu cuenta está desactivada o ya no existe.' });
  let fresco = {};
  try {
    const f = await pool.query('SELECT nombre, correo FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (f.rows[0]) fresco = f.rows[0];
  } catch (e) { /* si falla, queda lo del token */ }
  // Sesión recordada: se renueva en cada apertura de la app (otros 180 días desde hoy).
  if (req.recordar) {
    setCookieSesion(res, firmarToken(Object.assign({}, req.usuario, fresco), true), true);
  }
  res.json(Object.assign({}, req.usuario, fresco, { acceso_taller: p.taller, acceso_agenda: p.agenda, agenda_editar: p.agenda_editar, es_supremo: await esSupremo(req.usuario.id) }));
});

module.exports = router;
