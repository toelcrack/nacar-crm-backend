// Notificaciones push del CRM. Las llaves VAPID se generan solas la primera vez y quedan en la
// tabla app_config (o se toman de VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY si existen en el entorno).
// Enviar un aviso NUNCA debe romper la acción que lo origina: todo va con try/catch.
const webpush = require('web-push');
const { pool } = require('./db');
const { pendienteDeCita } = require('./pendientes');

const EVENTOS = {
  agendado: 'Agendó un auto',
  ingresado: 'Tomó un auto en el taller',
  listo: 'Terminó un auto (listo para entregar)',
  entregado: 'Entregó un auto',
  confirmacion: 'El cliente respondió la confirmación',
};

let llaves = null;
async function obtenerLlaves() {
  if (llaves) return llaves;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    llaves = { publica: process.env.VAPID_PUBLIC_KEY, privada: process.env.VAPID_PRIVATE_KEY };
  } else {
    const r = await pool.query("SELECT clave, valor FROM app_config WHERE clave IN ('vapid_publica','vapid_privada')");
    const m = {};
    r.rows.forEach((x) => { m[x.clave] = x.valor; });
    if (!m.vapid_publica || !m.vapid_privada) {
      const nuevas = webpush.generateVAPIDKeys();
      await pool.query(
        `INSERT INTO app_config (clave, valor) VALUES ('vapid_publica',$1),('vapid_privada',$2)
         ON CONFLICT (clave) DO NOTHING`,
        [nuevas.publicKey, nuevas.privateKey]
      );
      const r2 = await pool.query("SELECT clave, valor FROM app_config WHERE clave IN ('vapid_publica','vapid_privada')");
      r2.rows.forEach((x) => { m[x.clave] = x.valor; });
    }
    llaves = { publica: m.vapid_publica, privada: m.vapid_privada };
  }
  webpush.setVapidDetails('mailto:taller@nacarautomotriz.cl', llaves.publica, llaves.privada);
  return llaves;
}

async function clavePublica() {
  return (await obtenerLlaves()).publica;
}

// Manda un aviso a todas las personas que tengan activado ese evento (menos a quien lo causó).
// datos: { titulo, cuerpo, url }
async function avisar(evento, datos, actorId) {
  try {
    if (!EVENTOS[evento]) return;
    await obtenerLlaves();
    const r = await pool.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM push_suscripciones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE u.activo AND $1 = ANY(u.avisos) AND ($2::int IS NULL OR u.id <> $2)`,
      [evento, actorId || null]
    );
    const carga = JSON.stringify({ title: datos.titulo, body: datos.cuerpo, url: datos.url || '/', tag: evento + '-' + (datos.tag || '') });
    await Promise.all(r.rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, carga, { TTL: 3600 });
      } catch (e) {
        // 404/410: el celular ya no recibe avisos (desinstaló la app o los apagó) -> se borra.
        if (e.statusCode === 404 || e.statusCode === 410) {
          await pool.query('DELETE FROM push_suscripciones WHERE id = $1', [s.id]).catch(() => {});
        } else {
          // eslint-disable-next-line no-console
          console.error('Push falló:', e.statusCode || e.message);
        }
      }
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Error enviando avisos:', e.message);
  }
}

// Datos legibles de una cita para armar el texto del aviso.
async function infoCita(citaId) {
  const r = await pool.query(
    `SELECT c.fecha, c.hora_inicio, c.nota, c.tareas, (c.fecha > (now() AT TIME ZONE 'America/Santiago')::date) AS futura, v.patente, v.marca, v.modelo, b.nombre AS bahia
     FROM citas c
     LEFT JOIN vehiculos v ON v.id = c.vehiculo_id
     LEFT JOIN bahias b ON b.id = c.bahia_id
     WHERE c.id = $1`,
    [citaId]
  );
  return r.rows[0] || null;
}

// "A qué viene" el auto, en pocas palabras (ej. "Mantención, alineación"): sale de los trabajos
// marcados en la orden; si aún no hay, de la nota de la cita.
function motivoCorto(c) {
  const tareas = Array.isArray(c.tareas) ? c.tareas.map((t) => String((t && t.nombre) || '')).filter(Boolean) : [];
  const out = [];
  let hayMantencion = false;
  tareas.forEach((n) => {
    const l = n.toLowerCase();
    let corto = n;
    if (l.indexOf('mantención') === 0 || l.indexOf('mantencion') === 0) { corto = 'Mantención'; hayMantencion = true; }
    else if (l.indexOf('filtro') === 0) corto = 'Filtros';
    else if (l.indexOf('revisión') === 0 || l.indexOf('revision') === 0) corto = 'Revisión';
    else if (l.indexOf('diagnóstico') === 0) corto = 'Diagnóstico';
    if (corto === 'Otro') return;
    if (out.indexOf(corto) === -1) out.push(corto);
  });
  const lista = hayMantencion ? out.filter((x) => x !== 'Filtros') : out;
  let txt = lista.slice(0, 3).join(', ');
  if (lista.length > 3) txt += '…';
  if (!txt && c.nota) {
    txt = String(c.nota).trim().replace(/\s+/g, ' ');
    if (txt.length > 40) txt = txt.slice(0, 38).trim() + '…';
  }
  return txt ? txt.charAt(0).toUpperCase() + txt.slice(1) : '';
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function cuandoTxt(fecha, hora) {
  const f = String(fecha instanceof Date ? fecha.toISOString() : fecha).slice(0, 10).split('-');
  if (f.length < 3) return '';
  const d = new Date(Number(f[0]), Number(f[1]) - 1, Number(f[2]));
  return DIAS[d.getDay()] + ' ' + Number(f[2]) + ' ' + MESES[Number(f[1]) - 1] + (hora ? ' a las ' + String(hora).slice(0, 5) : '');
}

// Arma y manda el aviso de un evento sobre una cita. quien = nombre de quien lo hizo.
async function avisarCita(evento, citaId, actor) {
  try {
    const c = await infoCita(citaId);
    if (!c) return;
    const quien = (actor && actor.nombre) || 'Alguien';
    const auto = [c.patente, [c.marca, c.modelo].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const donde = c.bahia ? ' (' + c.bahia + ')' : '';
    const motivo = motivoCorto(c);
    const conMotivo = motivo ? ' Viene por: ' + motivo + '.' : '';
    let falta = '';
    if (evento === 'entregado') { try { if (await pendienteDeCita(citaId)) falta = ' Falta registrar la mantención.'; } catch (e) { /* opcional */ } }
    const t = {
      agendado: { titulo: 'Auto agendado', cuerpo: quien + ' agendó ' + auto + ' para el ' + cuandoTxt(c.fecha, c.hora_inicio) + '.' + conMotivo + (c.futura ? ' Aún sin confirmar: el cliente debe confirmar por WhatsApp.' : ''), url: '/#agenda' },
      ingresado: { titulo: 'Auto en el taller', cuerpo: quien + ' tomó ' + auto + donde + '.' + conMotivo, url: '/#taller' },
      listo: { titulo: 'Auto listo', cuerpo: quien + ' terminó ' + auto + donde + '. Listo para entregar.' + conMotivo, url: '/#taller' },
      entregado: { titulo: 'Auto entregado', cuerpo: quien + ' entregó ' + auto + '.' + falta, url: '/#taller' },
    }[evento];
    if (!t) return;
    await avisar(evento, Object.assign({ tag: String(citaId) }, t), actor && actor.id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Error armando el aviso:', e.message);
  }
}

async function avisarConfirmacion(citaId, resp) {
  try {
    const c = await infoCita(citaId);
    if (!c) return;
    const auto = [c.patente, [c.marca, c.modelo].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    await avisar('confirmacion', {
      titulo: resp === 'si' ? 'Cliente confirmó' : 'Cliente no puede',
      cuerpo: resp === 'si'
        ? 'El cliente confirmó la cita de ' + auto + ' (' + cuandoTxt(c.fecha, c.hora_inicio) + ').'
        : 'El cliente dice que no puede ir: ' + auto + ' (' + cuandoTxt(c.fecha, c.hora_inicio) + ').',
      url: '/#agenda', tag: String(citaId),
    }, null);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Error armando el aviso de confirmación:', e.message);
  }
}

module.exports = { motivoCorto, avisar, avisarCita, avisarConfirmacion, clavePublica, EVENTOS };
