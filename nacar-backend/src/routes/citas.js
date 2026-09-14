const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { resolverClienteId } = require('../clientes');
const { enviarCorreoCitaAgendada } = require('../correo');

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
              v.id AS vehiculo_id, v.patente, v.marca, v.modelo,
              COALESCE(cl.nombre, v.cliente_nombre) AS cliente_nombre
       FROM citas c
       JOIN bahias b ON b.id = c.bahia_id
       JOIN vehiculos v ON v.id = c.vehiculo_id
       LEFT JOIN clientes cl ON cl.id = v.cliente_id
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

// POST /api/citas -> agenda un vehículo en una bahía, en una fecha y hora futura (o de hoy).
//
// La patente puede ser de un vehículo YA registrado (como antes), o una patente nueva — en ese
// caso, si vienen datos de marca/modelo/cliente en el mismo body, el vehículo (y su cliente,
// nuevo o reusando uno existente por correo — ver resolverClienteId) se crea en el momento, sin
// tener que ir primero a la pestaña Vehículos (agregado 14-sep-2026, a pedido del usuario). Si
// la patente no existe y tampoco vienen esos datos, se sigue pidiendo registrarla primero.
//
// Si el vehículo queda con un cliente con correo, se le manda un correo de confirmación desde
// taller@nacarautomotriz.cl (ver src/correo.js) — nunca bloquea ni hace fallar el agendamiento
// si el correo no está configurado o falla el envío.
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
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    let vehiculoId;
    const v = await pool.query('SELECT id FROM vehiculos WHERE patente = $1', [patente]);
    if (v.rows[0]) {
      vehiculoId = v.rows[0].id;
    } else {
      const { marca, modelo, anio, combustible, motor, clienteId, clienteNombre, clienteCorreo } = body;
      const trajoDatosVehiculo = marca || modelo || clienteId || clienteNombre || clienteCorreo;
      if (!trajoDatosVehiculo) {
        return res.status(404).json({
          error: 'Esa patente no está registrada todavía. Complétala aquí mismo (marca, modelo y cliente) o regístrala primero en la pestaña Vehículos.',
        });
      }
      const clienteIdResuelto = await resolverClienteId({ clienteId, clienteNombre, clienteCorreo });
      const comb = combustible === 'diesel' ? 'diesel' : 'bencina';
      const nuevoVehiculo = await pool.query(
        `INSERT INTO vehiculos (patente, marca, modelo, anio, combustible, motor, cliente_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [patente, (marca || '').trim(), (modelo || '').trim(), String(anio || ''), comb, (motor || '').trim(), clienteIdResuelto, req.usuario ? req.usuario.id : null]
      );
      vehiculoId = nuevoVehiculo.rows[0].id;
    }

    const r = await pool.query(
      `INSERT INTO citas (bahia_id, vehiculo_id, fecha, hora_inicio, hora_fin, nota, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [bahiaId, vehiculoId, fecha, horaInicio, horaFin || null, nota || null, req.usuario ? req.usuario.id : null]
    );

    let correo = { enviado: false, motivo: 'No se pudo determinar el correo del cliente.' };
    try {
      const detalle = await pool.query(
        `SELECT v.patente, v.marca, v.modelo, b.nombre AS bahia_nombre,
                COALESCE(cl.correo, v.cliente_correo) AS correo, COALESCE(cl.nombre, v.cliente_nombre) AS nombre
         FROM vehiculos v
         JOIN bahias b ON b.id = $1
         LEFT JOIN clientes cl ON cl.id = v.cliente_id
         WHERE v.id = $2`,
        [bahiaId, vehiculoId]
      );
      if (detalle.rows[0]) {
        correo = await enviarCorreoCitaAgendada({
          correoCliente: detalle.rows[0].correo,
          nombreCliente: detalle.rows[0].nombre,
          patente: detalle.rows[0].patente,
          marca: detalle.rows[0].marca,
          modelo: detalle.rows[0].modelo,
          fecha,
          horaInicio,
          bahiaNombre: detalle.rows[0].bahia_nombre,
          nota,
        });
      }
    } catch (eCorreo) {
      // eslint-disable-next-line no-console
      console.error('Error preparando el correo de la cita:', eCorreo.message);
      correo = { enviado: false, motivo: 'Error interno preparando el correo.' };
    }

    res.json({ ok: true, id: r.rows[0].id, correo });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo agendar la cita.' });
  }
});

// PUT /api/citas/:id -> edita fecha/hora/bahía/nota (el estado de atraso/problema ya NO se
// toca aquí — se maneja posteando un comentario en el chat de la cita, ver más abajo).
// No permite cambiar el vehículo: si se agendó con la patente equivocada, cancela y crea otra.
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const bahiaId = Number(body.bahia_id);
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const nota = String(body.nota || '').trim();

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
           actualizado_en = now()
       WHERE id = $6 RETURNING id`,
      [bahiaId, fecha, horaInicio, horaFin || null, nota || null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo actualizar la cita.' });
  }
});

// ---------- Chat de comentarios de la cita (atrasos, problemas, avisos) ----------

// GET /api/citas/:id/comentarios -> historial completo del chat de esa cita, más antiguo
// primero (como cualquier chat).
router.get('/:id/comentarios', async (req, res) => {
  const citaId = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT id, cita_id, usuario_id, autor_nombre, mensaje, atrasado, creado_en
       FROM cita_comentarios WHERE cita_id = $1 ORDER BY creado_en ASC, id ASC`,
      [citaId]
    );
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudieron cargar los comentarios.' });
  }
});

// POST /api/citas/:id/comentarios -> agrega un mensaje al chat de la cita. Si se marca
// "atrasado", ese pasa a ser el estado vigente de la cita (se ve como ⚠️ en el calendario) —
// para "limpiar" la alerta, basta postear un mensaje nuevo sin marcarlo (ej. "Resuelto").
router.post('/:id/comentarios', async (req, res) => {
  const citaId = Number(req.params.id);
  const mensaje = String((req.body || {}).mensaje || '').trim();
  const atrasado = Boolean((req.body || {}).atrasado);
  if (!mensaje) return res.status(400).json({ error: 'Escribe un mensaje.' });

  try {
    const c = await pool.query('SELECT id FROM citas WHERE id = $1', [citaId]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });

    const autorNombre = (req.usuario && req.usuario.nombre) || 'Alguien del equipo';
    const r = await pool.query(
      `INSERT INTO cita_comentarios (cita_id, usuario_id, autor_nombre, mensaje, atrasado)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, cita_id, usuario_id, autor_nombre, mensaje, atrasado, creado_en`,
      [citaId, req.usuario ? req.usuario.id : null, autorNombre, mensaje, atrasado]
    );
    await pool.query('UPDATE citas SET atrasado = $1, actualizado_en = now() WHERE id = $2', [atrasado, citaId]);
    res.json(r.rows[0]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo enviar el comentario.' });
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
