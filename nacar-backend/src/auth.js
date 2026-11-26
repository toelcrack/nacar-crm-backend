const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('Falta la variable de entorno JWT_SECRET. Revisa tu archivo .env (usa .env.example de guía).');
  process.exit(1);
}

const COOKIE_NAME = 'nacar_token';
// "Mantener sesión iniciada": con la casilla marcada la sesión dura 180 días y se renueva sola
// cada vez que se abre la app (así quien la usa seguido nunca vuelve a ver el login). Sin marcar,
// es una cookie de sesión (se pierde al cerrar el navegador) y el token vale 1 día.
const EXPIRA_RECORDAR = '180d';
const EXPIRA_NORMAL = '1d';

function firmarToken(usuario, recordar = true) {
  return jwt.sign(
    { sub: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol, rec: recordar ? 1 : 0 },
    JWT_SECRET,
    { expiresIn: recordar ? EXPIRA_RECORDAR : EXPIRA_NORMAL }
  );
}

function setCookieSesion(res, token, recordar = true) {
  const opciones = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  };
  if (recordar) opciones.maxAge = 180 * 24 * 60 * 60 * 1000;
  res.cookie(COOKIE_NAME, token, opciones);
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
    // Los tokens anteriores a esta opción (sin 'rec') se tratan como "recordar".
    req.recordar = payload.rec === undefined ? true : !!payload.rec;
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
    r = await pool.query('SELECT rol, activo, acceso_taller, acceso_agenda, agenda_solo_ver FROM usuarios WHERE id = $1', [usuarioId]);
  } catch (e) {
    if (e.code !== '42703') throw e;
    // Falta la columna agenda_solo_ver (el deploy llegó antes que la migración): sin ese límite.
    try {
      r = await pool.query('SELECT rol, activo, acceso_taller, acceso_agenda, false AS agenda_solo_ver FROM usuarios WHERE id = $1', [usuarioId]);
    } catch (e2) {
      // Columnas todavía no creadas: todos con acceso, como era antes de existir los permisos,
      // en vez de dejar a todos sin poder entrar.
      if (e2.code !== '42703') throw e2;
      r = await pool.query('SELECT rol, activo, true AS acceso_taller, true AS acceso_agenda, false AS agenda_solo_ver FROM usuarios WHERE id = $1', [usuarioId]);
    }
  }
  const u = r.rows[0];
  if (!u || !u.activo) return null;
  const admin = u.rol === 'admin';
  return {
    taller: admin || u.acceso_taller,
    agenda: admin || u.acceso_agenda,
    // 'agenda_editar': puede crear/mover/cancelar citas (los administradores siempre).
    agenda_editar: admin || (u.acceso_agenda && !u.agenda_solo_ver),
  };
}

function requireAcceso(...secciones) {
  return async (req, res, next) => {
    try {
      const p = req.usuario ? await permisosDe(req.usuario.id) : null;
      if (!p) return res.status(401).json({ error: 'Sesión inválida, inicia sesión de nuevo.' });
      if (!secciones.some((s) => p[s])) {
        if (secciones.length === 1 && secciones[0] === 'agenda_editar') {
          return res.status(403).json({ error: 'Tu cuenta puede ver la agenda pero no modificarla. Pídele al administrador que te dé permiso para editarla.' });
        }
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

// Administrador supremo (el dueño del taller). Se lee de la base en cada pedido. Si la columna
// todavía no existe (deploy antes que la migración) nadie es supremo, sin romper nada.
async function esSupremo(usuarioId) {
  try {
    const r = await pool.query('SELECT es_supremo FROM usuarios WHERE id = $1 AND activo AND rol = \'admin\'', [usuarioId]);
    return !!(r.rows[0] && r.rows[0].es_supremo);
  } catch (e) {
    if (e.code === '42703') return false;
    throw e;
  }
}

async function requireSupremo(req, res, next) {
  try {
    if (!req.usuario || !(await esSupremo(req.usuario.id))) {
      return res.status(403).json({ error: 'Esta acción es solo para el administrador supremo.' });
    }
    next();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo verificar tu permiso.' });
  }
}

module.exports = { firmarToken, setCookieSesion, borrarCookieSesion, requireAuth, requireAdmin, requireAcceso, requireSupremo, esSupremo, permisosDe, COOKIE_NAME };
