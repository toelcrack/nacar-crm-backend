// Importa el historico real del taller (datos_historicos.json, generado a partir de
// "Mantenciones Nacar 21 ago.xlsx") a las tablas vehiculos + mantenciones.
// Uso: node src/migrate/importar_historico.js correo-del-admin@dominio.com
//
// - Los 14 registros sin patente NO se importan (se dejaron fuera a propósito, ver
//   el archivo Mantenciones_Nacar_migracion.xlsx, hoja "Sin patente").
// - Si dos filas del histórico comparten patente, se crea UN vehículo con VARIAS
//   mantenciones (una por fila) — así queda su historial real, no solo el último dato.
// - Los registros con confianza media/baja en el combustible quedan marcados en la
//   nota de esa mantención para que el admin los revise cuando quiera.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

function parseKm(valor) {
  // La planilla original a veces tenía texto donde debía ir el kilometraje
  // (ej. "COTIZACION", una patente escrita por error, o una fecha). Si no es
  // un número limpio, no lo forzamos — lo guardamos como nota en vez de romper.
  var s = String(valor == null ? '' : valor).trim();
  if (!s) return { km: null, nota: null };
  if (/^\d+(\.\d+)?$/.test(s)) return { km: Math.round(Number(s)), nota: null };
  return { km: null, nota: 'KM original (no numérico): ' + s };
}

async function main() {
  const correoAdmin = process.argv[2];
  if (!correoAdmin) {
    console.error('Uso: node src/migrate/importar_historico.js correo-del-admin@dominio.com');
    process.exit(1);
  }
  const admin = await pool.query('SELECT id FROM usuarios WHERE correo=$1', [correoAdmin.trim().toLowerCase()]);
  if (!admin.rows[0]) {
    console.error('No existe ninguna cuenta con ese correo. Crea el admin primero con crear_admin.js.');
    process.exit(1);
  }
  const creadoPor = admin.rows[0].id;

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos_historicos.json'), 'utf8'));
  const registros = data.migrados;

  let vehiculosCreados = 0;
  let vehiculosReusados = 0;
  let mantencionesCreadas = 0;
  let omitidos = 0;

  for (const reg of registros) {
    const patente = String(reg.patente || '').trim().toUpperCase();
    if (!patente) { omitidos++; continue; }

    let vehiculoId;
    const existente = await pool.query('SELECT id FROM vehiculos WHERE patente=$1', [patente]);
    if (existente.rows[0]) {
      vehiculoId = existente.rows[0].id;
      vehiculosReusados++;
    } else {
      const r = await pool.query(
        `INSERT INTO vehiculos (patente, marca, modelo, anio, combustible, cliente_nombre, cliente_correo, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [patente, reg.marca || '', reg.modelo || '', reg.anio || '', reg.combustible || 'bencina', '', '', creadoPor]
      );
      vehiculoId = r.rows[0].id;
      vehiculosCreados++;
    }

    const filtroAire = !!reg.filtro_aire_codigo;
    const filtroPolen = !!reg.filtro_polen_codigo;
    const filtroAceite = !!reg.filtro_aceite_codigo;
    const filtroCombustible = !!reg.filtro_combustible_codigo;

    const kmInfo = parseKm(reg.km);

    let notas = reg.notas || '';
    if (kmInfo.nota) notas = notas ? `${kmInfo.nota}; ${notas}` : kmInfo.nota;
    if (reg.combustible_confianza && !reg.combustible_confianza.startsWith('alta')) {
      const marca = `[Revisar combustible: ${reg.combustible_confianza}]`;
      notas = notas ? `${marca} ${notas}` : marca;
    }
    notas = notas ? `${notas} (migrado de planilla, hoja ${reg.hoja_origen})` : `Migrado de planilla histórica, hoja ${reg.hoja_origen}`;

    await pool.query(
      `INSERT INTO mantenciones
        (vehiculo_id, fecha, km, tecnico, costo, motor, aceite, litros,
         filtro_aire, filtro_aire_codigo, filtro_polen, filtro_polen_codigo,
         filtro_aceite, filtro_aceite_codigo, filtro_combustible, filtro_combustible_codigo,
         notas, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        vehiculoId,
        reg.fecha || null,
        kmInfo.km,
        '',
        null,
        reg.motor || '',
        reg.aceite || '',
        reg.litros_aceite || '',
        filtroAire, filtroAire ? reg.filtro_aire_codigo : null,
        filtroPolen, filtroPolen ? reg.filtro_polen_codigo : null,
        filtroAceite, filtroAceite ? reg.filtro_aceite_codigo : null,
        filtroCombustible, filtroCombustible ? reg.filtro_combustible_codigo : null,
        notas,
        creadoPor,
      ]
    );
    mantencionesCreadas++;
  }

  console.log('Importación terminada.');
  console.log('  Vehículos nuevos creados:', vehiculosCreados);
  console.log('  Vehículos ya existentes (se les sumó otra mantención):', vehiculosReusados);
  console.log('  Mantenciones creadas en total:', mantencionesCreadas);
  console.log('  Filas omitidas (sin patente):', omitidos);
  await pool.end();
}

main().catch((e) => {
  console.error('Error importando el histórico:', e);
  process.exit(1);
});
