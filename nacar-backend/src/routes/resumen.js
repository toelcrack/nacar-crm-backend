// Resumen del día para administradores: qué está pasando hoy en el taller, de un vistazo.
// Todo se calcula en el momento desde las citas (no hay nada que mantener aparte).
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const TZ = "'America/Santiago'";
const HOY = `((now() AT TIME ZONE ${TZ})::date)`;
const INICIO_HOY = `(${HOY}::timestamp AT TIME ZONE ${TZ})`;
const HM = (col) => `to_char(${col} AT TIME ZONE ${TZ}, 'HH24:MI')`;

// Umbrales de "Requiere atención" (en minutos)
const MIN_ELEVADOR_LARGO = 150; // un auto lleva 2 h 30 min o más en el elevador sin terminar
const MIN_CITA_ATRASADA = 15;   // la hora de la cita pasó hace 15 min o más y el auto no llega
const MIN_LISTO_SIN_ENTREGAR = 30; // terminado hace 30 min o más y nadie lo ha entregado

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function duracion(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h + ' h' + (r ? ' ' + r + ' min' : '');
}
const auto = (r) => [r.marca, r.modelo].filter(Boolean).join(' ');
const tareasInfo = (t) => {
  const l = Array.isArray(t) ? t : [];
  return { hechas: l.filter((x) => x && x.estado === 'realizado').length, total: l.length };
};

router.get('/', async (req, res) => {
  try {
    const [bahiasQ, citasQ, entregQ, actQ, horaQ] = await Promise.all([
      pool.query(
        `SELECT b.id, b.nombre, b.tipo,
                c.id AS cita_id, c.tareas, c.listo_en, c.nota,
                v.patente, v.marca, v.modelo,
                ${HM('c.ingresado_en')} AS desde, ${HM('c.listo_en')} AS listo_hora,
                EXTRACT(EPOCH FROM (now() - c.ingresado_en)) / 60 AS min_en_taller,
                EXTRACT(EPOCH FROM (now() - c.listo_en)) / 60 AS min_listo,
                u.nombre AS mecanico
         FROM bahias b
         LEFT JOIN LATERAL (
           SELECT * FROM citas c2
           WHERE c2.bahia_id = b.id AND c2.ingresado_en IS NOT NULL AND c2.salida_en IS NULL
           ORDER BY c2.ingresado_en DESC LIMIT 1
         ) c ON true
         LEFT JOIN vehiculos v ON v.id = c.vehiculo_id
         LEFT JOIN usuarios u ON u.id = c.ingresado_por
         ORDER BY b.orden ASC, b.id ASC`
      ),
      pool.query(
        `SELECT c.id, to_char(c.hora_inicio, 'HH24:MI') AS hora, c.ingresado_en, c.listo_en, c.salida_en, c.no_show,
                c.confirmada_cliente, c.respuesta_cliente,
                (c.hora_inicio < ((now() AT TIME ZONE ${TZ})::time - make_interval(mins => $1))) AS atrasada,
                v.patente, v.marca, v.modelo
         FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id
         WHERE c.fecha = ${HOY}
         ORDER BY c.hora_inicio ASC, c.id ASC`,
        [MIN_CITA_ATRASADA]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ingresado_en IS NOT NULL AND ingresado_en - creado_en < interval '2 minutes')::int AS sin_cita
         FROM citas WHERE salida_en >= ${INICIO_HOY}`
      ),
      pool.query(
        `SELECT ts, tipo, patente, bahia, actor, sin_cita, resp, fecha_txt FROM (
           SELECT c.creado_en AS ts, 'agendo' AS tipo, v.patente, NULL::text AS bahia, u.nombre AS actor, false AS sin_cita, NULL::text AS resp,
                  to_char(c.fecha, 'DD/MM') || ' ' || to_char(c.hora_inicio, 'HH24:MI') AS fecha_txt
           FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id LEFT JOIN usuarios u ON u.id = c.creado_por
           WHERE c.creado_en >= ${INICIO_HOY} AND NOT (c.ingresado_en IS NOT NULL AND c.ingresado_en - c.creado_en < interval '2 minutes')
           UNION ALL
           SELECT c.ingresado_en, 'ingreso', v.patente, b.nombre, u.nombre,
                  (c.ingresado_en - c.creado_en < interval '2 minutes'), NULL, NULL
           FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id LEFT JOIN bahias b ON b.id = c.bahia_id LEFT JOIN usuarios u ON u.id = c.ingresado_por
           WHERE c.ingresado_en >= ${INICIO_HOY}
           UNION ALL
           SELECT c.listo_en, 'listo', v.patente, b.nombre, u.nombre, false, NULL, NULL
           FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id LEFT JOIN bahias b ON b.id = c.bahia_id LEFT JOIN usuarios u ON u.id = c.listo_por
           WHERE c.listo_en >= ${INICIO_HOY}
           UNION ALL
           SELECT c.salida_en, 'entrega', v.patente, b.nombre, u.nombre, false, NULL, NULL
           FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id LEFT JOIN bahias b ON b.id = c.bahia_id LEFT JOIN usuarios u ON u.id = c.salida_por
           WHERE c.salida_en >= ${INICIO_HOY}
           UNION ALL
           SELECT c.respondida_en, 'respuesta', v.patente, NULL, NULL, false, c.respuesta_cliente, NULL
           FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id
           WHERE c.respondida_en >= ${INICIO_HOY}
         ) e ORDER BY ts DESC LIMIT 12`
      ),
      pool.query(`SELECT to_char(now() AT TIME ZONE ${TZ}, 'HH24:MI') AS hora, ${HOY}::text AS fecha`),
    ]);

    // ---- Taller ahora
    const bahias = bahiasQ.rows.map((b) => {
      if (!b.cita_id) return { nombre: b.nombre, tipo: b.tipo, ocupada: false };
      const t = tareasInfo(b.tareas);
      return {
        nombre: b.nombre, tipo: b.tipo, ocupada: true,
        patente: b.patente, auto: auto(b), mecanico: b.mecanico || null,
        desde: b.desde, listo: !!b.listo_en, listo_hora: b.listo_hora,
        tareas_hechas: t.hechas, tareas_total: t.total,
      };
    });

    // ---- Citas de hoy
    const citas = citasQ.rows.map((c) => {
      let estado;
      if (c.no_show) estado = 'no_llego';
      else if (c.salida_en) estado = 'entregado';
      else if (c.listo_en) estado = 'listo';
      else if (c.ingresado_en) estado = 'en_taller';
      else if (c.atrasada) estado = 'atrasado';
      else if (c.respuesta_cliente === 'no') estado = 'no_puede';
      else if (c.confirmada_cliente) estado = 'confirmo';
      else estado = 'sin_responder';
      return { hora: c.hora, patente: c.patente, auto: auto(c), estado };
    });
    const porLlegar = citasQ.rows.filter((c) => !c.ingresado_en && !c.no_show && !c.salida_en);

    // ---- Requiere atención
    const atencion = [];
    bahiasQ.rows.forEach((b) => {
      if (!b.cita_id) return;
      if (!b.listo_en && b.min_en_taller >= MIN_ELEVADOR_LARGO) {
        atencion.push({ texto: `<strong>${esc(b.patente)}</strong> lleva ${duracion(b.min_en_taller)} en ${esc(b.nombre)}.` });
      }
      if (b.listo_en && b.min_listo >= MIN_LISTO_SIN_ENTREGAR) {
        atencion.push({ texto: `<strong>${esc(b.patente)}</strong> está lista hace ${duracion(b.min_listo)} y nadie la ha entregado.` });
      }
    });
    citasQ.rows.forEach((c) => {
      if (c.ingresado_en || c.no_show || c.salida_en) return;
      if (c.atrasada) atencion.push({ texto: `<strong>${esc(c.patente)}</strong> estaba para las ${esc(c.hora)} y todavía no llega.` });
      else if (c.respuesta_cliente === 'no') atencion.push({ texto: `El cliente de <strong>${esc(c.patente)}</strong> dice que no puede ir hoy.` });
    });
    const sinConfirmar = porLlegar.filter((c) => !c.atrasada && !c.confirmada_cliente && c.respuesta_cliente !== 'no').length;
    if (sinConfirmar > 0) {
      atencion.push({ texto: sinConfirmar === 1 ? '1 cliente no ha confirmado su cita de hoy.' : `${sinConfirmar} clientes no han confirmado su cita de hoy.` });
    }

    // ---- Actividad
    const actividad = actQ.rows.map((e) => {
      const quien = e.actor ? `<strong>${esc(e.actor)}</strong> ` : '';
      let texto;
      if (e.tipo === 'agendo') texto = `${quien || '<strong>Alguien</strong> '}agendó <strong>${esc(e.patente)}</strong> para el ${esc(e.fecha_txt)}.`;
      else if (e.tipo === 'ingreso') texto = e.sin_cita
        ? `${quien || ''}${e.actor ? 'ingresó' : 'Ingresó'} <strong>${esc(e.patente)}</strong> sin cita${e.bahia ? ' en ' + esc(e.bahia) : ''}.`
        : `${quien || ''}${e.actor ? 'tomó' : 'Tomaron'} <strong>${esc(e.patente)}</strong>${e.bahia ? ' en ' + esc(e.bahia) : ''}.`;
      else if (e.tipo === 'listo') texto = `${quien || ''}${e.actor ? 'terminó' : 'Terminaron'} <strong>${esc(e.patente)}</strong>. Listo para entregar.`;
      else if (e.tipo === 'entrega') texto = `${quien || ''}${e.actor ? 'entregó' : 'Entregaron'} <strong>${esc(e.patente)}</strong>.`;
      else texto = e.resp === 'no' ? `El cliente de <strong>${esc(e.patente)}</strong> dice que no puede ir.` : `El cliente de <strong>${esc(e.patente)}</strong> confirmó su cita.`;
      return { ts: e.ts, tipo: e.tipo, texto };
    });
    const horas = await pool.query(
      `SELECT ${HM('x')} AS h FROM unnest($1::timestamptz[]) AS x`,
      [actQ.rows.map((e) => e.ts)]
    );
    actividad.forEach((a, i) => { a.hora = horas.rows[i].h; delete a.ts; });

    res.json({
      hora: horaQ.rows[0].hora,
      fecha: horaQ.rows[0].fecha,
      kpi: {
        ocupadas: bahias.filter((b) => b.ocupada).length,
        total_bahias: bahias.length,
        listos: bahias.filter((b) => b.ocupada && b.listo).length,
        citas_hoy: citas.length,
        por_llegar: porLlegar.length,
        entregados: entregQ.rows[0].total,
        entregados_sin_cita: entregQ.rows[0].sin_cita,
      },
      atencion, bahias, citas, actividad,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo cargar el resumen del día.' });
  }
});

module.exports = router;
