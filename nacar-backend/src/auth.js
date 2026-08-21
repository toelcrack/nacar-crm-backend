const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('Falta la variable de entorno JWT_SECRET. Revisa tu archivo .env (usa .env.example de guía).');
  process.exit(1);
}

const COOKIE_NAME = 'nacar_token';
const EXPIRA_EN = '30d';

function firmarToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol },
    JWT_SECRET,
    { expiresIn: EXPIRA_EN }
  );
}

function setCookieSesion(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function borrarCookieSesion(res) {
  res.clearCookie(COOKIE_NAME);
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No has iniciado sesión.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario = { id: payload.sub, nombre: payload.nombre, correo: payload.correo, rol: payload.rol };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesión inválida o vencida, inicia sesión de nuevo.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Esta acción es solo para administradores.' });
  }
  next();
}

module.exports = { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth, requireAdmin, COOKIE_NAME };
