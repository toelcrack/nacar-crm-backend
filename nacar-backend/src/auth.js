const jwt = require('jsonwebtoken');
const { pool } = require('./db');

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

// Permisos por sección. Se leen de la base en cada pedido (no del token), para que un cambio
// hecho por el administrador valga al tiro, sin que la persona tenga que volver a iniciar sesión.
// Los administradores pasan siempre. Con varias secciones basta tener UNA (ej. 'taller','agenda').
async function permisosDe(usuarioId) {
  let r;
  try {
    r = await pool.query('SELECT rol, activo, acceso_taller, acceso_agenda FROM usuarios WHERE id = $1', [usuarioId]);
  } catch (e) {
    // Columnas todavía no creadas (el deploy llegó antes que la migración): todos con acceso,
    // como era antes de existir los permisos, en vez de dejar a todos sin poder entrar.
    if (e.code !== '42703') throw e;
    r = await pool.query('SELECT rol, activo, true AS acceso_taller, true AS acceso_agenda FROM usuarios WHERE id = $1', [usuarioId]);
  }
  const u = r.rows[0];
  if (!u || !u.activo) return null;
  const admin = u.rol === 'admin';
  return { taller: admin || u.acceso_taller, agenda: admin || u.acceso_agenda };
}

function requireAcceso(...secciones) {
  return async (req, res, next) => {
    try {
      const p = req.usuario ? await permisosDe(req.usuario.id) : null;
      if (!p) return res.status(401).json({ error: 'Sesión inválida, inicia sesión de nuevo.' });
      if (!secciones.some((s) => p[s])) {
        const nombre = secciones.length === 1 ? 'la sección ' + (secciones[0] === 'taller' ? 'Taller' : 'Agenda') : 'esta sección';
        return res.status(403).json({ error: 'No tienes acceso a ' + nombre + '. Pídele al administrador que te lo active.' });
      }
      next();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      res.status(500).json({ error: 'No se pudo verificar tu acceso.' });
    }
  };
}

module.exports = { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth, requireAdmin, requireAcceso, permisosDe, COOKIE_NAME };
