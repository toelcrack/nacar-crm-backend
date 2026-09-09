const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
// Igual que Bahías: cualquier usuario logueado (admin o mecánico) puede ver y agendar el
// calendario del taller — es organización del día a día, no un dato sensible como Estadísticas.
router.use(requireAuth);

function esFechaValida(f) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
}
function esHoraValida(h) {
  return /^\d{2}:\d{2}(:\d{2})?$/.test(String(h || ''));
}

// GET /api/citas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD -> citas agendadas en ese rango de fechas
// (por defecto, si no se manda rango, se usa desde 7 días atrás hasta 60 días adelante).
router.get('/', async (req, res) => {
  try {
    let { desde, hasta } = req.query;
    if (!esFechaValida(desde) || !esFechaValida(hasta)) {
      const hoy = new Date();
      const d = new Date(hoy);
      d.setDate(d.getDate() - 7);
      const h = new Date(hoy);
      h.setDate(h.getDate() + 60);
      desde = d.toISOString().slice(0, 10);
      hasta = h.toISOString().slice(0, 10);
    }
    const r = await pool.query(
      `SELECT c.id, c.bahia_id, c.fecha, c.hora_inicio, c.hora_fin, c.nota, c.atrasado,
              b.nombre AS bahia_nombre,
              v.id AS vehiculo_id, v.patente, v.marca, v.modelo, v.cliente_nombre
       FROM citas c
       JOIN bahias b ON b.id = c.bahia_id
       JOIN vehiculos v ON v.id = c.vehiculo_id
       WHERE c.fecha BETWEEN $1 AND $2
       ORDER BY c.fecha ASC, c.hora_inicio ASC, c.id ASC`,
      [desde, hasta]
    );
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar el calendario del taller.' });
  }
});

// POST /api/citas -> agenda un vehículo (por patente, ya registrado en Vehículos) en una
// bahía, en una fecha y hora futura (o de hoy).
router.post('/', async (req, res) => {
  const body = req.body || {};
  const bahiaId = Number(body.bahia_id);
  const patente = String(body.patente || '').trim().toUpperCase();
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const nota = String(body.nota || '').trim();

  if (!bahiaId) return res.status(400).json({ error: 'Falta indicar la bahía.' });
  if (!patente) return res.status(400).json({ error: 'Escribe la patente del vehículo.' });
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'Falta o es inválida la fecha.' });
  if (!esHoraValida(horaInicio)) return res.status(400).json({ error: 'Falta o es inválida la hora de inicio.' });
  if (horaFin && !esHoraValida(horaFin)) {
    return res.status(400).json({ error: 'La hora de término no es válida.' });
  }

  try {
    const v = await pool.query('SELECT id FROM vehiculos WHERE patente = $1', [patente]);
    if (!v.rows[0]) {
      return res.status(404).json({
        error: 'Esa patente no está registrada todavía. Regístrala primero en la pestaña Vehículos y luego agéndala aquí.',
      });
    }
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    const r = await pool.query(
      `INSERT INTO citas (bahia_id, vehiculo_id, fecha, hora_inicio, hora_fin, nota, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [bahiaId, v.rows[0].id, fecha, horaInicio, horaFin || null, nota || null, req.usuario ? req.usuario.id : null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo agendar la cita.' });
  }
});

// PUT /api/citas/:id -> edita fecha/hora/bahía/nota, o marca "atrasado/problema" (⚠️).
// No permite cambiar el vehículo: si se agendó con la patente equivocada, cancela y crea otra.
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const bahiaId = Number(body.bahia_id);
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const nota = String(body.nota || '').trim();
  const atrasado = Boolean(body.atrasado);

  if (!bahiaId) return res.status(400).json({ error: 'Falta indicar la bahía.' });
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'Falta o es inválida la fecha.' });
  if (!esHoraValida(horaInicio)) return res.status(400).json({ error: 'Falta o es inválida la hora de inicio.' });
  if (horaFin && !esHoraValida(horaFin)) {
    return res.status(400).json({ error: 'La hora de término no es válida.' });
  }

  try {
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    const r = await pool.query(
      `UPDATE citas
       SET bahia_id = $1, fecha = $2, hora_inicio = $3, hora_fin = $4, nota = $5,
           atrasado = $6, actualizado_en = now()
       WHERE id = $7 RETURNING id`,
      [bahiaId, fecha, horaInicio, horaFin || null, nota || null, atrasado, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo actualizar la cita.' });
  }
});

// DELETE /api/citas/:id -> cancela la cita agendada (no borra nada del historial del auto,
// esto es solo el calendario del taller).
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query('DELETE FROM citas WHERE id = $1 RETURNING id', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cancelar la cita.' });
  }
});

module.exports = router;
