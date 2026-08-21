const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

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
  const { patente, marca, modelo, anio, combustible, clienteNombre, clienteCorreo } = req.body || {};
  const patenteLimpia = String(patente || '').trim().toUpperCase();
  if (!patenteLimpia) return res.status(400).json({ error: 'La patente es obligatoria.' });
  if (!clienteNombre || !String(clienteNombre).trim()) {
    return res.status(400).json({ error: 'El nombre del cliente es obligatorio.' });
  }
  const comb = combustible === 'diesel' ? 'diesel' : 'bencina';
  try {
    const r = await pool.query(
      `INSERT INTO vehiculos (patente, marca, modelo, anio, combustible, cliente_nombre, cliente_correo, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [patenteLimpia, marca || '', modelo || '', String(anio || ''), comb, clienteNombre, clienteCorreo || '', req.usuario.id]
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
