// Página pública (sin login) para que el cliente responda Sí/No a su cita desde el enlace que
// recibe por WhatsApp: /c/<token>. El token es único por cita y no adivinable. La página
// muestra los datos y dos botones; la respuesta se envía con POST (no con un GET) para que la
// vista previa de enlaces de WhatsApp no confirme por accidente.
const express = require('express');
const { pool } = require('../db');
const { escaparHtml, formatearFecha, formatearHora } = require('../correo');

const router = express.Router();
const WHATSAPP = 'https://wa.me/56981836269';

function pagina(cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Tu cita — Taller Nacar Automotriz</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#FFF4EC;color:#1A1310;display:flex;justify-content:center;padding:24px 16px}
.card{background:#fff;border:1px solid rgba(217,100,46,.25);border-radius:16px;padding:24px;max-width:420px;width:100%;box-sizing:border-box}
h1{color:#D9642E;font-size:20px;margin:0 0 14px} p{line-height:1.5;margin:8px 0} ul{padding-left:18px;line-height:1.7}
button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;font-size:17px;font-weight:700;padding:14px;border-radius:12px;border:2px solid #D9642E;cursor:pointer;margin-top:12px;text-decoration:none}
.si{background:#D9642E;color:#fff} .no{background:#fff;color:#D9642E}
.ok{font-size:18px;font-weight:700}
</style></head><body><div class="card"><h1>Taller Nacar Automotriz</h1>${cuerpo}</div></body></html>`;
}

async function cargar(token) {
  const r = await pool.query(
    `SELECT c.id, c.fecha, c.hora_inicio, c.nota, c.respuesta_cliente, c.no_show,
            v.patente, v.marca, v.modelo
     FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id
     WHERE c.token_confirmacion = $1`,
    [String(token || '')]
  );
  return r.rows[0] || null;
}

function detalle(c) {
  const auto = [c.marca, c.modelo].filter(Boolean).join(' ') || 'tu vehículo';
  return `<p>Tu hora para <strong>${escaparHtml(auto)}</strong> (patente <strong>${escaparHtml(c.patente)}</strong>):</p>
<ul><li><strong>Fecha:</strong> ${escaparHtml(formatearFecha(c.fecha))}</li>
<li><strong>Hora:</strong> ${escaparHtml(formatearHora(c.hora_inicio))}</li>
${c.nota ? `<li><strong>Trabajo:</strong> ${escaparHtml(c.nota)}</li>` : ''}</ul>`;
}

function resultado(c, resp) {
  if (resp === 'si') return `${detalle(c)}<p class="ok">✓ ¡Listo! Tu hora quedó confirmada. Te esperamos.</p>`;
  return `${detalle(c)}<p class="ok">Gracias por avisar. Registramos que no puedes en ese horario.</p>
<p>Escríbenos para coordinar una nueva hora:</p><a class="btn si" href="${WHATSAPP}">Abrir WhatsApp del taller</a>`;
}

router.get('/:token', async (req, res) => {
  try {
    const c = await cargar(req.params.token);
    if (!c) return res.status(404).send(pagina('<p>Este enlace no es válido. Escríbenos por WhatsApp y te ayudamos.</p>'));
    if (c.respuesta_cliente === 'si' || c.respuesta_cliente === 'no') {
      return res.send(pagina(resultado(c, c.respuesta_cliente) + '<p style="font-size:13px;color:#8A8078;margin-top:18px">¿Te equivocaste? Avísanos por WhatsApp.</p>'));
    }
    res.send(pagina(`${detalle(c)}<p>¿Nos confirmas que puedes venir?</p>
<form method="post"><button class="si" name="r" value="si">Sí, confirmo</button><button class="no" name="r" value="no">No puedo</button></form>`));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).send(pagina('<p>Ocurrió un error. Escríbenos por WhatsApp y te ayudamos.</p>'));
  }
});

router.post('/:token', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const c = await cargar(req.params.token);
    if (!c) return res.status(404).send(pagina('<p>Este enlace no es válido.</p>'));
    const resp = req.body && req.body.r === 'no' ? 'no' : 'si';
    await pool.query(
      'UPDATE citas SET respuesta_cliente = $1, confirmada_cliente = $2, actualizado_en = now() WHERE id = $3',
      [resp, resp === 'si', c.id]
    );
    res.send(pagina(resultado(c, resp)));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).send(pagina('<p>Ocurrió un error. Escríbenos por WhatsApp y te ayudamos.</p>'));
  }
});

module.exports = router;
