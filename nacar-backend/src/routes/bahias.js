const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
// Cualquier usuario logueado (admin o mecánico) puede ver y mover la agenda del taller —
// es organización del día a día del taller físico, no un dato sensible como Estadísticas.
router.use(requireAuth);

// "Ocupada ahora" ya NO es un estado propio de la bahía: se calcula en vivo a partir de
// citas.js — la misma tabla "citas" que alimenta el calendario de abajo. Y, desde el
// 28-oct-2026 (segunda ronda), ya NO depende de la hora agendada (hora_inicio <= ahora): una
// bahía está "ocupada" si y solo si alguien confirmó manualmente el ingreso de un auto
// (ingresado_en) y todavía no se liberó. "Todavía no se liberó" se mide con la columna
// salida_en (agregada 28-oct-2026, tercera ronda) — NO con hora_fin, que es solo la hora de
// término AGENDADA por Andy y puede venir no-NULL desde que se creó la cita (ej. "10:00-11:00"),
// mucho antes de que el auto siquiera entrara. Usar hora_fin acá era un bug real: una cita con
// hora_fin agendada nunca se mostraba como ocupada aunque ya estuviera ingresada. Esto evita
// que una cita agendada "se ocupe sola" antes de que el auto haya llegado de verdad, y permite
// que el mecánico la ingrese en CUALQUIER bahía disponible, no solo en la sugerida.
const SQL_OCUPACION_ACTUAL = `
  SELECT b.id, b.nombre, b.tipo, b.orden,
         c.id AS cita_id, c.fecha, c.nota, c.atrasado, c.hora_inicio, c.hora_fin, c.ingresado_en,
         c.pastillas_del, c.pastillas_tra, c.discos_del, c.discos_tra,
         c.pastillas_tra_tipo, c.pastillas_tra_bloqueada,
         c.discos_del_rectificar, c.discos_tra_rectificar,
         c.estado_general, c.tareas,
         v.id AS vehiculo_id, v.patente, v.marca, v.modelo, v.anio, v.cliente_nombre
  FROM bahias b
  LEFT JOIN LATERAL (
    SELECT * FROM citas c2
    WHERE c2.bahia_id = b.id AND c2.ingresado_en IS NOT NULL AND c2.salida_en IS NULL
    ORDER BY c2.ingresado_en DESC
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
// ("walk-in"): crea una cita de hoy, ya ingresada desde ahora, sin hora de término (queda
// abierta hasta que se libere). Es, para todos los efectos, una cita más — aparece igual en el
// calendario. "Hoy" y "ahora" se calculan en hora de Chile explícitamente (en vez de
// CURRENT_DATE/CURRENT_TIME, que dependen de en qué zona horaria esté configurado el servidor
// de Postgres — en Railway suele ser UTC, lo que corría la fecha/hora casi 3 horas) — así un
// walk-in a última hora de la noche queda fechado en el día correcto para el taller.
router.post('/:id/asignar', async (req, res) => {
  const id = Number(req.params.id);
  const patente = String((req.body || {}).patente || '').trim().toUpperCase();
  const nota = String((req.body || {}).nota || '').trim();
  if (!patente) return res.status(400).json({ error: 'Escribe la patente del vehículo.' });
  try {
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    const ocupacion = await pool.query(
      `SELECT id FROM citas WHERE bahia_id = $1 AND ingresado_en IS NOT NULL AND salida_en IS NULL
       ORDER BY ingresado_en DESC LIMIT 1`,
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
      `INSERT INTO citas (bahia_id, vehiculo_id, fecha, hora_inicio, hora_fin, ingresado_en, nota, creado_por)
       VALUES (
         $1, $2,
         (now() AT TIME ZONE 'America/Santiago')::date,
         (now() AT TIME ZONE 'America/Santiago')::time,
         NULL, now(), $3, $4
       ) RETURNING id`,
      [id, v.rows[0].id, nota || null, req.usuario ? req.usuario.id : null]
    );
    res.json({ ok: true, cita_id: r.rows[0].id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo asignar el vehículo.' });
  }
});

// POST /api/bahias/:id/liberar -> cierra la cita en curso en esa bahía (le pone salida_en =
// ahora). No la borra: queda en el calendario de hoy como un bloque ya terminado, con su
// historial de comentarios intacto. OJO: NO toca hora_fin — esa columna sigue siendo solo la
// hora de término AGENDADA por Andy (dato informativo), nunca la hora real de salida.
router.post('/:id/liberar', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE citas SET salida_en = now(), actualizado_en = now()
       WHERE id = (
         SELECT id FROM citas WHERE bahia_id = $1 AND ingresado_en IS NOT NULL AND salida_en IS NULL
         ORDER BY ingresado_en DESC LIMIT 1
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
