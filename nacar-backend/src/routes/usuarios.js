const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireSupremo } = require('../auth');

const router = express.Router();

// ¿La cuenta :id es la del administrador supremo? (false si la columna aún no existe)
async function esSupremoObjetivo(id) {
  try {
    const r = await pool.query('SELECT es_supremo FROM usuarios WHERE id = $1', [id]);
    return !!(r.rows[0] && r.rows[0].es_supremo);
  } catch (e) {
    if (e.code === '42703') return false;
    throw e;
  }
}
router.use(requireAuth, requireAdmin);

// GET /api/usuarios -> lista de cuentas del taller (sin password)
router.get('/', async (req, res) => {
  let r;
  try {
    r = await pool.query('SELECT id, nombre, correo, rol, activo, acceso_taller, acceso_agenda, agenda_solo_ver, es_supremo, creado_en FROM usuarios ORDER BY es_supremo DESC, creado_en ASC');
  } catch (e) {
    if (e.code !== '42703') throw e;
    r = await pool.query('SELECT id, nombre, correo, rol, activo, acceso_taller, acceso_agenda, false AS agenda_solo_ver, false AS es_supremo, creado_en FROM usuarios ORDER BY creado_en ASC');
  }
  res.json(r.rows);
});

// POST /api/usuarios -> crear cuenta para un mecánico/recepción (o otro admin)
router.post('/', async (req, res) => {
  const { nombre, correo, password, rol } = req.body || {};
  const accesoTaller = (req.body || {}).accesoTaller !== false;
  // agendaNivel: 'no' | 'ver' (solo mirar) | 'editar'. Compatible con accesoAgenda (booleano) de antes.
  const nivelAg = (req.body || {}).agendaNivel || ((req.body || {}).accesoAgenda === false ? 'no' : 'editar');
  const accesoAgenda = nivelAg !== 'no';
  const agendaSoloVer = nivelAg === 'ver';
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
      `INSERT INTO usuarios (nombre, correo, password_hash, rol, acceso_taller, acceso_agenda, agenda_solo_ver) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, nombre, correo, rol, activo, acceso_taller, acceso_agenda, agenda_solo_ver, creado_en`,
      [nombre, String(correo).trim().toLowerCase(), hash, rolFinal, accesoTaller, accesoAgenda, agendaSoloVer]
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
  if (await esSupremoObjetivo(id)) {
    return res.status(403).json({ error: 'Esa cuenta es la del administrador supremo; no se puede desactivar.' });
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
  // agenda_nivel: 'no' (no la ve) | 'ver' (solo mirar) | 'editar' (ver y modificar)
  let agendaAcceso = typeof b.acceso_agenda === 'boolean' ? b.acceso_agenda : null;
  let agendaSoloVer = null;
  if (['no', 'ver', 'editar'].includes(b.agenda_nivel)) {
    agendaAcceso = b.agenda_nivel !== 'no';
    agendaSoloVer = b.agenda_nivel === 'ver';
  }
  const r = await pool.query(
    `UPDATE usuarios
     SET acceso_taller = COALESCE($1, acceso_taller), acceso_agenda = COALESCE($2, acceso_agenda),
         agenda_solo_ver = COALESCE($3, agenda_solo_ver)
     WHERE id = $4 AND rol <> 'admin'
     RETURNING id, nombre, rol, acceso_taller, acceso_agenda, agenda_solo_ver`,
    [typeof b.acceso_taller === 'boolean' ? b.acceso_taller : null, agendaAcceso, agendaSoloVer, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada, o es administrador (siempre tiene todo el acceso).' });
  res.json(r.rows[0]);
});

// PUT /api/usuarios/:id/password -> cambiar la clave de CUALQUIER cuenta (solo el administrador
// supremo). Body: { password }. La persona ya no puede entrar con la clave anterior; si tenía la
// sesión abierta, la sigue usando hasta que expire el token (7 días a lo sumo).
router.put('/:id/password', requireSupremo, async (req, res) => {
  const id = Number(req.params.id);
  const password = String((req.body || {}).password || '');
  if (password.length < 6) {
    return res.status(400).json({ error: 'La clave debe tener al menos 6 caracteres.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING id, nombre', [hash, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json({ ok: true, nombre: r.rows[0].nombre });
});

// PUT /api/usuarios/:id/datos -> cambiar el correo (y/o el nombre) de CUALQUIER cuenta (solo el
// administrador supremo). Body: { correo?, nombre? }. La persona entra con el correo nuevo.
router.put('/:id/datos', requireSupremo, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const correo = b.correo === undefined ? null : String(b.correo).trim().toLowerCase();
  const nombre = b.nombre === undefined ? null : String(b.nombre).trim();
  if (correo !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ error: 'Escribe un correo válido.' });
  }
  if (nombre !== null && !nombre) {
    return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
  }
  if (correo === null && nombre === null) {
    return res.status(400).json({ error: 'No hay nada que cambiar.' });
  }
  try {
    const r = await pool.query(
      'UPDATE usuarios SET correo = COALESCE($1, correo), nombre = COALESCE($2, nombre) WHERE id = $3 RETURNING id, nombre, correo',
      [correo, nombre, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    res.json({ ok: true, nombre: r.rows[0].nombre, correo: r.rows[0].correo });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe otra cuenta con ese correo.' });
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cambiar el correo.' });
  }
});

module.exports = router;
