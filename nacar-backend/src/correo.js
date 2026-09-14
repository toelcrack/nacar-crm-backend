// Envío de correos al cliente cuando se agenda una cita en el taller (agregado 14-sep-2026, a
// pedido del usuario: "cuando lo agreguemos al calendario le llegue un correo al cliente desde
// mi correo taller@nacarautomotriz.cl").
//
// Se manda vía Gmail/Google Workspace por SMTP, usando una "contraseña de aplicación" (NO la
// contraseña normal de la cuenta de correo) — ver el LEEME de esta entrega para el paso a paso
// exacto de cómo generarla. Las credenciales viven SOLO en variables de entorno (Railway →
// Variables), nunca en el código ni en ningún archivo del repo:
//   CORREO_TALLER_USUARIO=taller@nacarautomotriz.cl
//   CORREO_TALLER_APP_PASSWORD=xxxxxxxxxxxxxxxx   (16 caracteres, sin espacios)
//
// Si esas variables todavía no están configuradas, enviarCorreoCitaAgendada() no hace nada raro
// — devuelve { enviado: false, motivo: '...' } en vez de lanzar un error — así agendar, editar o
// cancelar una cita sigue funcionando igual aunque el correo no esté configurado todavía (misma
// filosofía que GetAPI y el catálogo Mann: nada de esto puede bloquear al mecánico).
const nodemailer = require('nodemailer');

let transporterCache = null;
function obtenerTransporter() {
  const usuario = process.env.CORREO_TALLER_USUARIO;
  const appPassword = process.env.CORREO_TALLER_APP_PASSWORD;
  if (!usuario || !appPassword) return null;
  if (transporterCache) return transporterCache;
  transporterCache = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: usuario, pass: appPassword },
    // Timeouts cortos (por defecto nodemailer espera hasta 2 minutos): si Gmail no responde
    // (problema de red, credenciales por revisar, etc.) preferimos fallar rápido y dejar
    // agendada la cita igual, en vez de dejar al mecánico esperando el aviso de "cita agendada"
    // por minutos — misma filosofía de "nunca bloquear al mecánico" del resto del módulo.
    // (Nota: quien LLAMA a enviarCorreoCitaAgendada tiene además su propio límite de espera
    // independiente de esto — ver conLimiteDeEspera en src/routes/citas.js — por si una
    // resolución DNS colgada u otro problema de red no llegara a activar estos timeouts.)
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 4000,
  });
  return transporterCache;
}

function escaparHtml(valor) {
  return String(valor || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// La columna "fecha" es DATE en Postgres — según cómo llegue (string 'YYYY-MM-DD' u objeto
// Date), se muestra siempre como DD-MM-AAAA para que se lea como fecha chilena.
function formatearFecha(fecha) {
  const s = fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha || '').slice(0, 10);
  const partes = s.split('-');
  if (partes.length !== 3) return s;
  const [anio, mes, dia] = partes;
  return `${dia}-${mes}-${anio}`;
}

function formatearHora(hora) {
  return String(hora || '').slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
}

// datos: { correoCliente, nombreCliente, patente, marca, modelo, fecha, horaInicio, bahiaNombre, nota }
async function enviarCorreoCitaAgendada(datos) {
  const t = obtenerTransporter();
  if (!t) {
    return { enviado: false, motivo: 'El correo del taller todavía no está configurado (faltan las variables de entorno).' };
  }
  const correoCliente = String(datos.correoCliente || '').trim();
  if (!correoCliente) {
    return { enviado: false, motivo: 'El cliente no tiene correo registrado.' };
  }

  const usuario = process.env.CORREO_TALLER_USUARIO;
  const autoTxt = [datos.marca, datos.modelo].filter((x) => x && String(x).trim()).join(' ') || 'tu vehículo';
  const asunto = `Cita agendada — ${datos.patente} — Taller Nácar Automotriz`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#241a14;max-width:480px;line-height:1.5">
      <h2 style="color:#D9642E;margin:0 0 14px;font-size:20px">Taller Nácar Automotriz</h2>
      <p>Hola${datos.nombreCliente ? ' ' + escaparHtml(datos.nombreCliente) : ''},</p>
      <p>Te confirmamos que agendamos una hora para <strong>${escaparHtml(autoTxt)}</strong>
         (patente <strong>${escaparHtml(datos.patente)}</strong>):</p>
      <ul style="padding-left:18px">
        <li><strong>Fecha:</strong> ${escaparHtml(formatearFecha(datos.fecha))}</li>
        <li><strong>Hora:</strong> ${escaparHtml(formatearHora(datos.horaInicio))}</li>
        ${datos.bahiaNombre ? `<li><strong>Lugar:</strong> ${escaparHtml(datos.bahiaNombre)}</li>` : ''}
        ${datos.nota ? `<li><strong>Detalle:</strong> ${escaparHtml(datos.nota)}</li>` : ''}
      </ul>
      <p>Si necesitas cambiar la hora, respóndenos a este correo o escríbenos al WhatsApp
         <a href="https://wa.me/56981836269" style="color:#D9642E">+56 9 8183 6269</a>.</p>
      <p style="color:#8A8078;font-size:12px;margin-top:26px">Taller Nácar Automotriz</p>
    </div>
  `;

  try {
    await t.sendMail({
      from: `"Taller Nácar Automotriz" <${usuario}>`,
      to: correoCliente,
      subject: asunto,
      html,
    });
    return { enviado: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Error enviando correo de cita a', correoCliente, '-', e.message);
    return { enviado: false, motivo: 'Error enviando el correo: ' + e.message };
  }
}

module.exports = { enviarCorreoCitaAgendada };
