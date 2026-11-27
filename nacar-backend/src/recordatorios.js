// Recordatorio automático al asesor: citas de otro día (mañana o los próximos días) que el
// cliente todavía NO confirma por WhatsApp. Se avisa a quienes tienen activado el aviso de
// "confirmaciones" (Equipo), dos veces al día, para que el asesor se encargue de conseguirlo.
const { pool } = require('./db');
const { avisar } = require('./push');

const HORAS = [10, 16];     // hora de Chile a la que se manda el recordatorio
const DIAS_ADELANTE = 3;    // cuántos días hacia adelante se revisan

const SQL_SIN_CONFIRMAR = `
  c.fecha > (now() AT TIME ZONE 'America/Santiago')::date
  AND c.fecha <= (now() AT TIME ZONE 'America/Santiago')::date + ${DIAS_ADELANTE}
  AND c.ingresado_en IS NULL AND COALESCE(c.no_show, false) = false
  AND COALESCE(c.confirmada_cliente, false) = false
  AND c.respuesta_cliente IS DISTINCT FROM 'no'`;

async function listarSinConfirmar() {
  const r = await pool.query(
    `SELECT v.patente, c.fecha,
            (c.fecha = (now() AT TIME ZONE 'America/Santiago')::date + 1) AS manana,
            to_char(c.fecha, 'DD/MM') AS dia
     FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id
     WHERE ${SQL_SIN_CONFIRMAR}
     ORDER BY c.fecha, c.hora_inicio`
  );
  return r.rows;
}

async function revisar() {
  try {
    const t = await pool.query(
      `SELECT extract(hour FROM now() AT TIME ZONE 'America/Santiago')::int AS h,
              ((now() AT TIME ZONE 'America/Santiago')::date)::text AS hoy`
    );
    const { h, hoy } = t.rows[0];
    if (HORAS.indexOf(h) === -1) return;
    // "Reclamar" este horario: si otro proceso/arranque ya lo mandó, no se repite.
    const clave = 'recordatorio_confirmar_' + hoy + '_' + h;
    const claim = await pool.query('INSERT INTO app_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING RETURNING clave', [clave, '1']);
    if (!claim.rows[0]) return;
    const lista = await listarSinConfirmar();
    if (!lista.length) return;
    const manana = lista.filter((x) => x.manana);
    const placas = (arr) => arr.slice(0, 5).map((x) => x.patente).join(', ') + (arr.length > 5 ? '…' : '');
    const cuerpo = manana.length
      ? `Mañana: ${manana.length} sin confirmar (${placas(manana)}).` + (lista.length > manana.length ? ` Y ${lista.length - manana.length} más para los próximos días.` : '')
      : `${lista.length} cita${lista.length === 1 ? '' : 's'} de los próximos días sin confirmar (${placas(lista)}).`;
    await avisar('confirmacion', { titulo: 'Citas sin confirmar', cuerpo: cuerpo + ' Avísales por WhatsApp.', url: '/#agenda', tag: 'sinconfirmar' }, null);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Recordatorio de confirmaciones falló:', e.message);
  }
}

function iniciar() {
  setInterval(revisar, 5 * 60 * 1000);
  setTimeout(revisar, 30 * 1000);
}

module.exports = { iniciar, listarSinConfirmar };
