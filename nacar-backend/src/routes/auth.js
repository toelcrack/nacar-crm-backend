const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth } = require('../auth');

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
  res.json({ nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol });
});

router.post('/logout', (req, res) => {
  borrarCookieSesion(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.usuario);
});

module.exports = router;
