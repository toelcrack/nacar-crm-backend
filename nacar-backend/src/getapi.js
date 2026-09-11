// Integración con GetAPI (chile.getapi.cl) para identificar automáticamente CUALQUIER patente
// de Chile, no solo las que ya están en la base del taller. Contratado por el usuario a partir
// del 11-sep-2026 (plan Starter, 10.000 consultas/día).
//
// La API key vive en la variable de entorno GETAPI_API_KEY (se configura en Railway ->
// Variables), NUNCA hardcodeada aquí ni en ningún archivo que se sube a GitHub — así el
// repo se puede compartir/respaldar sin exponer la key.
//
// Si la variable de entorno todavía no está configurada, consultarPatenteNacional() devuelve
// null de inmediato (como si el registro nacional no tuviera esa patente) para que el resto
// del CRM sigua funcionando igual que antes de contratar la API — nunca revienta por falta
// de configuración.

const http = require('http');
const https = require('https');

// Se puede pisar con la variable de entorno GETAPI_BASE_URL SOLO para pruebas locales contra
// un servidor de prueba (ver /tmp de la sesión de verificación) — en producción nunca se
// configura esa variable, así que siempre apunta al servicio real.
const ENDPOINT_BASE = process.env.GETAPI_BASE_URL || 'https://chile.getapi.cl/v1/vehicles/plate/';

function normalizarCombustible(valor) {
  const v = String(valor || '').toLowerCase();
  if (v.indexOf('dies') !== -1 || v.indexOf('petrol') !== -1 || v.indexOf('petró') !== -1) return 'diesel';
  return 'bencina';
}

// Mapea el JSON de respuesta de GetAPI (o null) a nuestro modelo interno. Separado como
// función pura para poder probarlo directo, sin tener que levantar un servidor.
function mapearRespuesta(json) {
  const d = json && json.data ? json.data : json;
  if (!d) return null;
  const marca = d.model && d.model.brand && d.model.brand.name ? d.model.brand.name : '';
  const modelo = d.model && d.model.name ? d.model.name : '';
  return {
    marca: marca,
    modelo: modelo,
    anio: d.year != null ? String(d.year) : '',
    combustible: normalizarCombustible(d.fuel),
    motor: d.engine ? String(d.engine) : '',
    vin: d.vinNumber ? String(d.vinNumber) : '',
  };
}

// Devuelve { marca, modelo, anio, combustible, motor, vin } si GetAPI encontró la patente en
// el registro nacional, o null si no la encontró (404 real de GetAPI, o key no configurada).
// Lanza un Error solo ante un problema de conexión/autenticación/formato de respuesta — quien
// llama a esta función debe capturarlo, loguearlo, y de todas formas caer al flujo manual sin
// bloquear nunca al mecánico (ver src/routes/vehiculos.js).
function consultarPatenteNacional(patente) {
  const apiKey = process.env.GETAPI_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const url = ENDPOINT_BASE + encodeURIComponent(patente);
    const mod = url.indexOf('https:') === 0 ? https : http;
    let terminado = false;
    const req = mod.get(
      url,
      { headers: { 'X-Api-Key': apiKey }, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (terminado) return;
          terminado = true;
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode !== 200) {
            return reject(new Error(`GetAPI respondió ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            resolve(mapearRespuesta(JSON.parse(body)));
          } catch (e) {
            reject(new Error('No se pudo interpretar la respuesta de GetAPI: ' + e.message));
          }
        });
      }
    );
    req.on('timeout', () => {
      if (terminado) return;
      terminado = true;
      req.destroy();
      reject(new Error('GetAPI no respondió a tiempo (timeout).'));
    });
    req.on('error', (e) => {
      if (terminado) return;
      terminado = true;
      reject(e);
    });
  });
}

module.exports = { consultarPatenteNacional, mapearRespuesta };
