const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { resolverClienteId } = require('../clientes');
const { enviarCorreoCitaAgendada } = require('../correo');

const router = express.Router();

// Al agendar, esperamos el envío del correo un rato corto para poder avisar de inmediato si
// salió o no — pero NUNCA más que esto. Es un límite propio de la aplicación, con un
// setTimeout normal de Node, que no depende de red/DNS/Gmail para nada: así, aunque algo en el
// camino del correo se cuelgue de una forma que los timeouts internos de nodemailer (src/correo.js)
// no lleguen a cubrir (ej. una resolución DNS que nunca vuelve), agendar una cita JAMÁS puede
// quedarse "pegado" esperando el correo — a los 5 segundos se responde igual, y si el correo
// termina llegando más tarde, simplemente no se avisa en el momento (queda solo en los logs).
function conLimiteDeEspera(promesa, ms, siExpira) {
  return new Promise((resolve) => {
    let resuelto = false;
    const temporizador = setTimeout(() => {
      if (resuelto) return;
      resuelto = true;
      resolve(siExpira);
    }, ms);
    promesa.then((valor) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      resolve(valor);
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Error enviando correo de cita (después de agendar):', e.message);
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      resolve(siExpira);
    });
  });
}
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
              c.ingresado_en, c.no_show,
              b.nombre AS bahia_nombre,
              v.id AS vehiculo_id, v.patente, v.marca, v.modelo,
              COALESCE(cl.nombre, v.cliente_nombre) AS cliente_nombre
       FROM citas c
       LEFT JOIN bahias b ON b.id = c.bahia_id
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

// POST /api/citas -> agenda un vehículo, en una fecha y hora futura (o de hoy) — la bahía
// (elevador/patio) es OPCIONAL: Andy (asesor) agenda sin elegir elevador, y la cita queda
// "pendiente" hasta que el mecánico la ingresa a un elevador disponible (ver
// POST /:id/ingresar más abajo). Si se manda bahia_id de todas formas (ej. agendando desde el
// propio elevador), se respeta igual que antes.
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
  const bahiaId = body.bahia_id ? Number(body.bahia_id) : null;
  const patente = String(body.patente || '').trim().toUpperCase();
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const nota = String(body.nota || '').trim();

  if (!patente) return res.status(400).json({ error: 'Escribe la patente del vehículo.' });
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'Falta o es inválida la fecha.' });
  if (!esHoraValida(horaInicio)) return res.status(400).json({ error: 'Falta o es inválida la hora de inicio.' });
  if (horaFin && !esHoraValida(horaFin)) {
    return res.status(400).json({ error: 'La hora de término no es válida.' });
  }

  try {
    if (bahiaId) {
      const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
      if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });
    }

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
         LEFT JOIN bahias b ON b.id = $1
         LEFT JOIN clientes cl ON cl.id = v.cliente_id
         WHERE v.id = $2`,
        [bahiaId, vehiculoId]
      );
      if (detalle.rows[0]) {
        correo = await conLimiteDeEspera(
          enviarCorreoCitaAgendada({
            correoCliente: detalle.rows[0].correo,
            nombreCliente: detalle.rows[0].nombre,
            patente: detalle.rows[0].patente,
            marca: detalle.rows[0].marca,
            modelo: detalle.rows[0].modelo,
            fecha,
            horaInicio,
            bahiaNombre: detalle.rows[0].bahia_nombre,
            nota,
          }),
          5000,
          { enviado: false, motivo: 'El correo se está demorando más de lo normal — la cita quedó agendada igual; revisa más tarde si le llegó al cliente.' }
        );
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

// GET /api/citas/pendientes -> citas de HOY que todavía no han ENTRADO FÍSICAMENTE
// (ingresado_en IS NULL) y que no fueron marcadas como "cliente no llegó" — esta es la lista
// que ve el mecánico en el selector de CUALQUIER tarjeta de elevador/patio para elegir qué auto
// va a entrar ahí. No filtra por bahia_id: aunque Andy haya sugerido un elevador al agendar (o
// la cita sea de antes de este cambio y ya tenga uno asignado), el auto puede entrar en
// cualquier bahía disponible — por eso se incluye el nombre de la bahía sugerida (si hay) para
// que el mecánico la vea como referencia, no como algo obligatorio. Debe ir ANTES de "GET /:id"
// para que Express no la confunda con un id.
router.get('/pendientes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.fecha, c.hora_inicio, c.hora_fin, c.nota, c.bahia_id,
              b.nombre AS bahia_sugerida,
              v.id AS vehiculo_id, v.patente, v.marca, v.modelo,
              COALESCE(cl.nombre, v.cliente_nombre) AS cliente_nombre
       FROM citas c
       JOIN vehiculos v ON v.id = c.vehiculo_id
       LEFT JOIN clientes cl ON cl.id = v.cliente_id
       LEFT JOIN bahias b ON b.id = c.bahia_id
       WHERE c.ingresado_en IS NULL AND NOT c.no_show
         AND c.fecha = (now() AT TIME ZONE 'America/Santiago')::date
       ORDER BY c.hora_inicio ASC, c.id ASC`
    );
    res.json(r.rows);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudieron cargar las citas pendientes de elevador.' });
  }
});

// POST /api/citas/:id/ingresar -> el mecánico toma una cita pendiente (haya tenido o no una
// bahía sugerida por Andy) y la ingresa físicamente a la bahía que elija — puede ser distinta
// de la sugerida (ej. la sugerida se liberó más tarde de lo esperado y otra quedó libre antes).
// Reusa el mismo chequeo de ocupación que src/routes/bahias.js (POST /:id/asignar): si la bahía
// ya tiene un auto adentro ahora mismo, no se puede. "Ocupada" ya NO depende de la hora
// agendada — depende solo de que alguien haya confirmado el ingreso (ingresado_en) y todavía no
// se haya liberado (salida_en IS NULL — NO hora_fin, que es solo la hora agendada; usarla acá
// dejaba bloqueada una bahía ya liberada si antes había tenido un auto "directo" sin hora de
// término, bug corregido 30-oct-2026). La fecha/hora originalmente agendada por Andy se deja
// intacta (sirve de registro); ingresado_en guarda el momento real de entrada.
router.post('/:id/ingresar', async (req, res) => {
  const id = Number(req.params.id);
  const bahiaId = Number((req.body || {}).bahia_id);
  if (!bahiaId) return res.status(400).json({ error: 'Falta indicar a qué elevador o patio ingresarlo.' });

  try {
    const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });

    const c = await pool.query('SELECT id, ingresado_en, no_show FROM citas WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    if (c.rows[0].ingresado_en) {
      return res.status(409).json({ error: 'Este auto ya fue ingresado antes.' });
    }
    if (c.rows[0].no_show) {
      return res.status(409).json({ error: 'Esta cita quedó marcada como "cliente no llegó" — agenda una cita nueva si llegó después de todo.' });
    }

    const ocupacion = await pool.query(
      `SELECT id FROM citas WHERE bahia_id = $1 AND ingresado_en IS NOT NULL AND salida_en IS NULL
       ORDER BY ingresado_en DESC LIMIT 1`,
      [bahiaId]
    );
    if (ocupacion.rows[0]) {
      return res.status(409).json({ error: 'Esta bahía ya está ocupada. Libérala primero.' });
    }

    await pool.query(
      `UPDATE citas SET bahia_id = $1, ingresado_en = now(), actualizado_en = now()
       WHERE id = $2`,
      [bahiaId, id]
    );
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo ingresar el vehículo al elevador.' });
  }
});

// POST /api/citas/:id/no-show -> marca que el cliente agendó pero nunca llegó. Distinto de
// "Cancelar cita" (que borra el registro por completo, para corregir un error): esto deja la
// cita guardada con no_show=true, solo deja de contar como "pendiente" (útil a futuro para
// medir inasistencia). Solo tiene sentido para una cita que todavía no había entrado.
router.post('/:id/no-show', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE citas SET no_show = true, actualizado_en = now()
       WHERE id = $1 AND ingresado_en IS NULL RETURNING id`,
      [id]
    );
    if (!r.rows[0]) {
      return res.status(409).json({ error: 'No se pudo marcar — revisa si esta cita ya fue ingresada.' });
    }
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo marcar como "cliente no llegó".' });
  }
});

// PUT /api/citas/:id -> edita fecha/hora/bahía/nota (el estado de atraso/problema ya NO se
// toca aquí — se maneja posteando un comentario en el chat de la cita, ver más abajo).
// No permite cambiar el vehículo: si se agendó con la patente equivocada, cancela y crea otra.
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const bahiaId = body.bahia_id ? Number(body.bahia_id) : null;
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const nota = String(body.nota || '').trim();

  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'Falta o es inválida la fecha.' });
  if (!esHoraValida(horaInicio)) return res.status(400).json({ error: 'Falta o es inválida la hora de inicio.' });
  if (horaFin && !esHoraValida(horaFin)) {
    return res.status(400).json({ error: 'La hora de término no es válida.' });
  }

  try {
    if (bahiaId) {
      const b = await pool.query('SELECT id FROM bahias WHERE id = $1', [bahiaId]);
      if (!b.rows[0]) return res.status(404).json({ error: 'Bahía no encontrada.' });
    }

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

// ---------- Estado del auto en el taller (frenos/discos + checklist de tareas) ----------

// GET /api/citas/:id -> detalle completo de una cita, con los datos del vehículo/cliente que
// necesita el informe impreso (marca, modelo, año, combustible, patente, nombre del cliente).
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT c.id, c.bahia_id, c.vehiculo_id, c.fecha, c.hora_inicio, c.hora_fin, c.nota, c.atrasado,
              c.ingresado_en, c.no_show,
              c.kilometraje, c.pastillas_del, c.pastillas_tra, c.discos_del, c.discos_tra,
              c.pastillas_tra_tipo, c.pastillas_tra_bloqueada, c.discos_del_rectificar, c.discos_tra_rectificar,
              c.pastillas_del_sensor, c.pastillas_del_reemplazar, c.pastillas_tra_sensor, c.pastillas_tra_reemplazar,
              c.estado_general, c.nota_estado, c.tareas,
              b.nombre AS bahia_nombre,
              v.patente, v.marca, v.modelo, v.anio, v.combustible,
              COALESCE(cl.nombre, v.cliente_nombre) AS cliente_nombre
       FROM citas c
       LEFT JOIN bahias b ON b.id = c.bahia_id
       JOIN vehiculos v ON v.id = c.vehiculo_id
       LEFT JOIN clientes cl ON cl.id = v.cliente_id
       WHERE c.id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar el detalle de la cita.' });
  }
});

// PATCH /api/citas/:id/estado-taller -> el mecánico/asesor va guardando acá el estado de
// frenos/discos, el kilometraje, el estado general y el checklist de tareas (con diagnóstico y
// fotos). Cualquier usuario logueado puede guardar — es trabajo del día a día del taller, igual
// que el resto de "citas"/"bahías" (ver nota al inicio del archivo).
//
// Solo se puede completar mientras el auto está físicamente en un elevador/patio (ingresado_en
// seteado) — en la agenda (lo que arma Andy) solo se especifica a qué viene, el estado real del
// auto lo completa el mecánico una vez que lo tiene ahí. La UI ya oculta esta sección mientras
// la cita está pendiente, pero el chequeo se repite acá como resguardo.
router.patch('/:id/estado-taller', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const tareas = Array.isArray(body.tareas) ? body.tareas : [];
  try {
    const c = await pool.query('SELECT ingresado_en FROM citas WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    if (!c.rows[0].ingresado_en) {
      return res.status(409).json({ error: 'El auto todavía no entró al elevador o patio — el estado se completa recién ahí.' });
    }

    const r = await pool.query(
      `UPDATE citas SET
         kilometraje = $1, pastillas_del = $2, pastillas_tra = $3, discos_del = $4, discos_tra = $5,
         pastillas_tra_tipo = $6, pastillas_tra_bloqueada = $7,
         discos_del_rectificar = $8, discos_tra_rectificar = $9,
         pastillas_del_sensor = $10, pastillas_del_reemplazar = $11,
         pastillas_tra_sensor = $12, pastillas_tra_reemplazar = $13,
         estado_general = $14, nota_estado = $15, tareas = $16::jsonb,
         actualizado_en = now()
       WHERE id = $17 RETURNING id`,
      [
        String(body.kilometraje || '').trim() || null,
        body.pastillasDel === '' || body.pastillasDel == null ? null : String(body.pastillasDel),
        body.pastillasTra === '' || body.pastillasTra == null ? null : String(body.pastillasTra),
        body.discosDel === '' || body.discosDel == null ? null : String(body.discosDel),
        body.discosTra === '' || body.discosTra == null ? null : String(body.discosTra),
        body.pastillasTraTipo === 'tambor' ? 'tambor' : 'pastillas',
        Boolean(body.pastillasTraBloqueada),
        Boolean(body.discosDelRectificar),
        Boolean(body.discosTraRectificar),
        Boolean(body.pastillasDelSensor),
        Boolean(body.pastillasDelReemplazar),
        Boolean(body.pastillasTraSensor),
        Boolean(body.pastillasTraReemplazar),
        String(body.estadoGeneral || '').trim() || null,
        String(body.notaEstado || '').trim() || null,
        JSON.stringify(tareas),
        id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada.' });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar el estado del auto.' });
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
