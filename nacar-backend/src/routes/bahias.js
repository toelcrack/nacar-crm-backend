const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
// Cualquier usuario logueado (admin o mecánico) puede ver y mover la agenda del taller —
// es organización del día a día del taller físico, no un dato sensible como Estadísticas.
router.use(requireAuth);

// "Ocupada ahora" ya NO es un estado propio de la bahía: se calcula en vivo a partir de
// citas.js — la misma tabla "citas" que alimenta el calendario de abajo. Así, asignar un
// auto "ahora" (walk-in, sin hora agendada) y una cita agendada que llega a su hora se ven
// exactamente igual arriba: ambas son, para efectos de esta consulta, "la cita de hoy que
// ya empezó y no ha terminado" en esa bahía (si hay más de una que califica, se toma la que
// empezó más tarde). Esto es justo lo que antes NO se cruzaba con el calendario.
const SQL_OCUPACION_ACTUAL = `
  SELECT b.id, b.nombre, b.tipo, b.orden,
         c.id AS cita_id, c.nota, c.atrasado, c.hora_inicio, c.hora_fin,
         v.id AS vehiculo_id, v.patente, v.marca, v.modelo, v.anio, v.cliente_nombre
  FROM bahias b
  LEFT JOIN LATERAL (
    SELECT * FROM citas c2
    WHERE c2.bahia_id = b.id AND c2.fecha = CURRENT_DATE
      AND c2.hora_inicio <= CURRENT_TIME
      AND (c2.hora_fin IS NULL OR c2.hora_fin > CURRENT_TIME)
    ORDER BY c2.hora_inicio DESC
    LIMIT 1
  ) c ON true
  LEFT JOIN vehiculos v ON v.id = c.vehiculo_id
  ORDER BY b.orden ASC, b.id ASC
`;

// GET /api/bahias -> estado de las bahías (elevadores + patio) AHORA MISMO, calculado desde
// el calendario (citas de hoy que ya empezaron y no han terminado).
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(SQL_OCUPACION_ACTUAL);
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar la agenda del taller.' });
  }
});

// POST /api/bahias/:id/asignar -> atajo rápido para un auto que llega SIN hora agendada
// ("walk-in"): crea una cita de hoy, desde ahora, sin hora de término (queda abierta hasta
// que se libere). Es, para todos los efectos, una cita más — aparece igual en el calendario.
router.post('/:id/asignar', async (req, res) => {
  const id = Number(req.params.id);
  const patente = String((req.body || {}).patente || '').trim().toUpperCase();
  const nota = String((req.body || {}).nota || '').trim();
  if (!patente) return res.status(400).json({ error: 'Escribe la patente del vehículo.' });
  try {
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    const ocupacion = await pool.query(
      `SELECT id FROM citas WHERE bahia_id = $1 AND fecha = CURRENT_DATE
         AND hora_inicio <= CURRENT_TIME AND (hora_fin IS NULL OR hora_fin > CURRENT_TIME)
       ORDER BY hora_inicio DESC LIMIT 1`,
      [id]
    );
    if (ocupacion.rows[0]) {
      return res.status(409).json({ error: 'Esta bahía ya está ocupada. Libérala primero.' });
    }

    const v = await pool.query('SELECT id FROM vehiculos WHERE patente = $1', [patente]);
    if (!v.rows[0]) {
      return res.status(404).json({
        error: 'Esa patente no está registrada todavía. Regístrala primero en la pestaña Vehículos y luego asígnala aquí.',
      });
    }

    const r = await pool.query(
      `INSERT INTO citas (bahia_id, vehiculo_id, fecha, hora_inicio, hora_fin, nota, creado_por)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_TIME, NULL, $3, $4) RETURNING id`,
      [id, v.rows[0].id, nota || null, req.usuario ? req.usuario.id : null]
    );
    res.json({ ok: true, cita_id: r.rows[0].id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo asignar el vehículo.' });
  }
});

// POST /api/bahias/:id/liberar -> cierra la cita en curso en esa bahía (le pone hora de
// término = ahora). No la borra: queda en el calendario de hoy como un bloque ya terminado,
// con su historial de comentarios intacto.
router.post('/:id/liberar', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE citas SET hora_fin = CURRENT_TIME, actualizado_en = now()
       WHERE id = (
         SELECT id FROM citas WHERE bahia_id = $1 AND fecha = CURRENT_DATE
           AND hora_inicio <= CURRENT_TIME AND (hora_fin IS NULL OR hora_fin > CURRENT_TIME)
         ORDER BY hora_inicio DESC LIMIT 1
       )
       RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Esta bahía ya estaba disponible.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo liberar la bahía.' });
  }
});

module.exports = router;
