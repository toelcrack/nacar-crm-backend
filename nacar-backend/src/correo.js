// Envío de correos al cliente cuando se agenda una cita en el taller (agregado 14-sep-2026, a
// pedido del usuario: "cuando lo agreguemos al calendario le llegue un correo al cliente desde
// mi correo taller@nacarautomotriz.cl").
//
// Se manda vía Resend (resend.com) por HTTPS — NO por SMTP (agregado 15-sep-2026, reemplazando
// el envío anterior por Gmail SMTP). Se cambió porque, desplegado en Railway, nunca se pudo
// conectar a smtp.gmail.com — daba "Connection timeout" tanto en el plan Hobby como en el plan
// Pro (Railway bloquea SMTP saliente en Hobby, y aun subiendo a Pro seguía fallando: parece ser
// Google bloqueando conexiones SMTP entrantes desde rangos de IP de proveedores cloud como
// Railway/GCP, algo fuera de nuestro control). Resend usa HTTPS normal para todo — igual que la
// consulta a GetAPI (ver src/getapi.js), que nunca ha tenido este problema — así que se cambió
// el transporte completo en vez de seguir peleando con SMTP.
//
// Variables de entorno (Railway → Variables), nunca hardcodeadas en el código:
//   RESEND_API_KEY         — la API key de tu cuenta de Resend (Resend → API Keys).
//   CORREO_TALLER_REMITENTE — opcional. El remitente que verás en el correo, ej.
//                             'Taller Nácar Automotriz <taller@nacarautomotriz.cl>'. La parte
//                             después de la @ tiene que ser un dominio ya VERIFICADO en Resend
//                             (Resend → Domains → agregar nacarautomotriz.cl y los registros DNS
//                             que te pida). Si no se configura esta variable, se manda desde una
//                             dirección de prueba de Resend — sirve para probar, pero conviene
//                             dejarla con el dominio real antes de que la vean los clientes.
//
// Si RESEND_API_KEY todavía no está configurada, enviarCorreoCitaAgendada() no hace nada raro —
// devuelve { enviado: false, motivo: '...' } en vez de lanzar un error — así agendar, editar o
// cancelar una cita sigue funcionando igual aunque el correo no esté configurado todavía (misma
// filosofía que GetAPI y el catálogo Mann: nada de esto puede bloquear al mecánico).

const http = require('http');
const https = require('https');

// Se puede pisar con RESEND_API_BASE_URL SOLO para pruebas locales contra un servidor de prueba
// (mismo mecanismo que GETAPI_BASE_URL en src/getapi.js) — en producción nunca se configura esa
// variable, así que siempre apunta al servicio real de Resend.
const BASE_URL = process.env.RESEND_API_BASE_URL || 'https://api.resend.com/emails';

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

// POST a la API de Resend. Timeout corto (igual filosofía que el transporter de nodemailer que
// reemplaza: preferimos fallar rápido y dejar agendada la cita igual, en vez de dejar al
// mecánico esperando el aviso de "cita agendada" por mucho rato — ver conLimiteDeEspera en
// src/routes/citas.js, que además tiene su propio límite de espera independiente de este).
function llamarResend(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL);
    // Normalmente siempre es https (Resend real) — el módulo http solo se usa si alguien pisa
    // RESEND_API_BASE_URL con un servidor de prueba local (mismo mecanismo que GETAPI_BASE_URL
    // en src/getapi.js), nunca en producción.
    const mod = url.protocol === 'http:' ? http : https;
    const cuerpo = JSON.stringify(payload);
    let terminado = false;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(cuerpo),
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (terminado) return;
          terminado = true;
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(new Error(`Resend respondió ${res.statusCode}: ${body.slice(0, 300)}`));
        });
      }
    );
    req.on('timeout', () => {
      if (terminado) return;
      terminado = true;
      req.destroy();
      reject(new Error('Resend no respondió a tiempo (timeout).'));
    });
    req.on('error', (e) => {
      if (terminado) return;
      terminado = true;
      reject(e);
    });
    req.write(cuerpo);
    req.end();
  });
}

// datos: { correoCliente, nombreCliente, patente, marca, modelo, fecha, horaInicio, bahiaNombre, nota }
async function enviarCorreoCitaAgendada(datos) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { enviado: false, motivo: 'El correo del taller todavía no está configurado (falta RESEND_API_KEY).' };
  }
  const correoCliente = String(datos.correoCliente || '').trim();
  if (!correoCliente) {
    return { enviado: false, motivo: 'El cliente no tiene correo registrado.' };
  }

  const remitente = process.env.CORREO_TALLER_REMITENTE || 'Taller Nácar Automotriz <onboarding@resend.dev>';
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
    await llamarResend({
      from: remitente,
      to: [correoCliente],
      subject: asunto,
      html,
    }, apiKey);
    return { enviado: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Error enviando correo de cita a', correoCliente, '-', e.message);
    return { enviado: false, motivo: 'Error enviando el correo: ' + e.message };
  }
}

module.exports = { enviarCorreoCitaAgendada };
