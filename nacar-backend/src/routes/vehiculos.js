const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { consultarPatenteNacional } = require('../getapi');

const router = express.Router();
router.use(requireAuth);

function safeInt(v) {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) ? Math.round(n) : null;
}

// GET /api/vehiculos?q=texto  -> lista (busca por patente, marca, modelo, cliente)
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  let r;
  if (q) {
    r = await pool.query(
      `SELECT v.*, COUNT(m.id)::int AS mantenciones_count
       FROM vehiculos v
       LEFT JOIN mantenciones m ON m.vehiculo_id = v.id
       WHERE v.patente ILIKE $1 OR v.marca ILIKE $1 OR v.modelo ILIKE $1 OR v.cliente_nombre ILIKE $1
       GROUP BY v.id
       ORDER BY v.creado_en DESC
       LIMIT 200`,
      [`%${q}%`]
    );
  } else {
    r = await pool.query(
      `SELECT v.*, COUNT(m.id)::int AS mantenciones_count
       FROM vehiculos v
       LEFT JOIN mantenciones m ON m.vehiculo_id = v.id
       GROUP BY v.id
       ORDER BY v.creado_en DESC
       LIMIT 200`
    );
  }
  res.json(r.rows);
});

// POST /api/vehiculos  -> crear vehiculo nuevo
router.post('/', async (req, res) => {
  const { patente, marca, modelo, anio, combustible, motor, vin, clienteNombre, clienteCorreo } = req.body || {};
  const patenteLimpia = String(patente || '').trim().toUpperCase();
  if (!patenteLimpia) return res.status(400).json({ error: 'La patente es obligatoria.' });
  const comb = combustible === 'diesel' ? 'diesel' : 'bencina';
  try {
    const r = await pool.query(
      `INSERT INTO vehiculos (patente, marca, modelo, anio, combustible, motor, vin, cliente_nombre, cliente_correo, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [patenteLimpia, marca || '', modelo || '', String(anio || ''), comb, (motor || '').trim(), (vin || '').trim().toUpperCase(), (clienteNombre || '').trim(), clienteCorreo || '', req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Esa patente ya está registrada. Búscala en vez de crearla de nuevo.' });
    }
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar el vehículo.' });
  }
});

// GET /api/vehiculos/buscar/:patente -> coincidencia EXACTA por patente (no búsqueda difusa).
// Es lo que usa el Simulador de mantención para "reconocer" un auto:
//   1) Si ya está en la base del taller, se devuelve al instante desde ahí (_origen: 'base').
//   2) Si no está, y GETAPI_API_KEY está configurada (contratado 11-sep-2026), se consulta el
//      registro nacional de vehículos (GetAPI) por esa patente CADA VEZ que se busca — a
//      propósito no se guarda ni se cachea nada acá (decisión del usuario: prefiere pagar la
//      consulta de nuevo cada vez antes que meter una tabla de caché que en algún momento
//      pueda hacer más lento el CRM). El resultado se devuelve (_origen: 'api_nacional') SIN
//      insertarlo en "vehiculos" — el auto NO se registra como cliente del taller solo por
//      haber sido buscado; el frontend ofrece un botón para registrarlo recién cuando de
//      verdad se decide darle un servicio (ver registrarVehiculoIdentificado en app.js).
//   3) Si ni la base propia ni el registro nacional la tienen (o la API falla por cualquier
//      motivo: key inválida, caída, timeout), se responde 404 y el frontend ofrece el
//      formulario de carga manual — nunca se bloquea al mecánico por un problema de la API.
router.get('/buscar/:patente', async (req, res) => {
  const patenteLimpia = String(req.params.patente || '').trim().toUpperCase();
  if (!patenteLimpia) return res.status(400).json({ error: 'Falta la patente.' });

  const r = await pool.query('SELECT * FROM vehiculos WHERE patente = $1', [patenteLimpia]);
  if (r.rows[0]) return res.json(Object.assign({ _origen: 'base' }, r.rows[0]));

  let datosNacionales = null;
  try {
    datosNacionales = await consultarPatenteNacional(patenteLimpia);
  } catch (e) {
    // No bloquea al mecánico: se loguea para que el administrador note si la key quedó mal
    // configurada o el servicio está caído, y se sigue igual al flujo de carga manual.
    // eslint-disable-next-line no-console
    console.error('Error consultando GetAPI para', patenteLimpia, '-', e.message);
  }

  if (!datosNacionales) {
    return res.status(404).json({
      error: 'No encontrado en la base del taller ni en el registro nacional.',
      consultoRegistroNacional: !!process.env.GETAPI_API_KEY,
    });
  }

  res.json(Object.assign({ _origen: 'api_nacional', patente: patenteLimpia }, datosNacionales));
});

// GET /api/vehiculos/:id  -> detalle + historial de mantenciones
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const v = await pool.query('SELECT * FROM vehiculos WHERE id = $1', [id]);
  if (!v.rows[0]) return res.status(404).json({ error: 'Vehículo no encontrado.' });
  const m = await pool.query(
    `SELECT mant.*, uc.nombre AS creado_por_nombre, ue.nombre AS editado_por_nombre
     FROM mantenciones mant
     LEFT JOIN usuarios uc ON uc.id = mant.creado_por
     LEFT JOIN usuarios ue ON ue.id = mant.editado_por
     WHERE mant.vehiculo_id = $1
     ORDER BY mant.creado_en DESC`,
    [id]
  );
  res.json({ vehiculo: v.rows[0], mantenciones: m.rows });
});

// PUT /api/vehiculos/:id  -> editar datos del vehículo (solo administrador)
router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { patente, marca, modelo, anio, combustible, motor, vin, clienteNombre, clienteCorreo } = req.body || {};
  const patenteLimpia = String(patente || '').trim().toUpperCase();
  if (!patenteLimpia) return res.status(400).json({ error: 'La patente es obligatoria.' });
  const comb = combustible === 'diesel' ? 'diesel' : 'bencina';
  try {
    const r = await pool.query(
      `UPDATE vehiculos SET
         patente=$1, marca=$2, modelo=$3, anio=$4, combustible=$5, motor=$6, vin=$7, cliente_nombre=$8, cliente_correo=$9
       WHERE id=$10
       RETURNING *`,
      [patenteLimpia, marca || '', modelo || '', String(anio || ''), comb, (motor || '').trim(), (vin || '').trim().toUpperCase(), (clienteNombre || '').trim(), clienteCorreo || '', id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Vehículo no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Esa patente ya está registrada en otro vehículo.' });
    }
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo actualizar el vehículo.' });
  }
});

// DELETE /api/vehiculos/:id  -> eliminar vehículo y todo su historial de mantenciones (solo administrador)
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM vehiculos WHERE id=$1 RETURNING id', [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Vehículo no encontrado.' });
  res.json({ ok: true });
});

// POST /api/vehiculos/:id/mantenciones  -> agregar mantencion al historial (cualquier usuario autenticado)
router.post('/:id/mantenciones', async (req, res) => {
  const vehiculoId = Number(req.params.id);
  const b = req.body || {};

  const FILTROS = [
    { marcado: 'filtroAire', codigo: 'filtroAireCodigo', nombre: 'filtro de aire' },
    { marcado: 'filtroPolen', codigo: 'filtroPolenCodigo', nombre: 'filtro de polen' },
    { marcado: 'filtroAceite', codigo: 'filtroAceiteCodigo', nombre: 'filtro de aceite' },
    { marcado: 'filtroCombustible', codigo: 'filtroCombustibleCodigo', nombre: 'filtro de combustible' },
  ];
  for (const f of FILTROS) {
    if (b[f.marcado] && !String(b[f.codigo] || '').trim()) {
      return res.status(400).json({ error: `Pusiste el ${f.nombre} — falta el código del repuesto.` });
    }
  }
  const hayAlgo = FILTROS.some((f) => b[f.marcado]) || (b.aceite && String(b.aceite).trim()) || (b.notas && String(b.notas).trim());
  if (!b.fecha || !hayAlgo) {
    return res.status(400).json({ error: 'Completa la fecha y al menos un repuesto, el aceite o una nota.' });
  }

  const v = await pool.query('SELECT id FROM vehiculos WHERE id = $1', [vehiculoId]);
  if (!v.rows[0]) return res.status(404).json({ error: 'Vehículo no encontrado.' });

  const r = await pool.query(
    `INSERT INTO mantenciones
      (vehiculo_id, fecha, km, tecnico, costo, motor, aceite, litros,
       filtro_aire, filtro_aire_codigo, filtro_polen, filtro_polen_codigo,
       filtro_aceite, filtro_aceite_codigo, filtro_combustible, filtro_combustible_codigo,
       notas, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      vehiculoId,
      b.fecha,
      safeInt(b.km),
      b.tecnico || '',
      safeInt(b.costo),
      b.motor || '',
      b.aceite || '',
      b.litros || '',
      !!b.filtroAire, b.filtroAire ? b.filtroAireCodigo : null,
      !!b.filtroPolen, b.filtroPolen ? b.filtroPolenCodigo : null,
      !!b.filtroAceite, b.filtroAceite ? b.filtroAceiteCodigo : null,
      !!b.filtroCombustible, b.filtroCombustible ? b.filtroCombustibleCodigo : null,
      b.notas || '',
      req.usuario.id,
    ]
  );
  res.status(201).json(r.rows[0]);
});

module.exports = router;
