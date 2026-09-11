// Importa el catálogo de filtros Mann Filter (catalogo_mann.json, generado una vez a partir del
// Excel que entregó el usuario) a la tabla catalogo_mann.
//
// Es tabla de referencia pura: no depende de nuestros vehículos ni mantenciones, así que cada
// vez que se corre este script se BORRA TODO y se vuelve a insertar desde el JSON (TRUNCATE +
// INSERT) — no tiene una llave natural única por fila para hacer upsert, y si el usuario entrega
// un Excel más nuevo, lo más simple y seguro es recargar el catálogo completo.
//
// Uso: node src/migrate/importar_catalogo_mann.js
//
// catalogo_mann.json se generó a partir del Excel original con estas reglas (por si hay que
// regenerarlo con un Excel nuevo del usuario):
//   - Hoja usada: "Hoja1" (las otras dos hojas del Excel son un volcado desordenado de PDF y una
//     hoja chica/parcial — Hoja1 es la única con "Marca" completo en todas las filas).
//   - Encabezado real está en la fila 3 (índice 2), los datos empiezan en la fila 4.
//   - Se usan las columnas "motores" y "años" (NO "Motor" ni "año" — esas dos tienen huecos
//     donde la fila dice "motor unico" / "cualquier otro año" en las columnas buenas).
//   - Se ignoran las 5 columnas "...Filtec" (están vacías en más del 99% de las filas — no es
//     una marca que el taller use).
//   - Se descartan las 43 filas sin "Modelo" (encabezados de sección duplicados en el Excel).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { normalizarMarca, parseAnios, esDiesel } = require('../catalogoMannUtils');

async function main() {
  const filas = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogo_mann.json'), 'utf8'));

  await pool.query('BEGIN');
  try {
    await pool.query('TRUNCATE TABLE catalogo_mann RESTART IDENTITY');

    let insertadas = 0;
    for (const f of filas) {
      const { desde, hasta, wildcard } = parseAnios(f.anios);
      await pool.query(
        `INSERT INTO catalogo_mann
          (marca, marca_norm, modelo, motor, anios_texto, anio_desde, anio_hasta, anio_wildcard,
           es_diesel, filtro_aire_codigo, filtro_aceite_codigo, filtro_combustible_codigo, filtro_polen_codigo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          f.marca || '',
          normalizarMarca(f.marca),
          f.modelo || '',
          f.motor || null,
          f.anios || null,
          desde,
          hasta,
          wildcard,
          esDiesel(f.motor),
          f.filtro_aire_codigo || null,
          f.filtro_aceite_codigo || null,
          f.filtro_combustible_codigo || null,
          f.filtro_polen_codigo || null,
        ]
      );
      insertadas++;
    }

    await pool.query('COMMIT');
    console.log(`Catálogo Mann importado: ${insertadas} filas.`);
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
  await pool.end();
}

main().catch((e) => {
  console.error('Error importando el catálogo Mann:', e);
  process.exit(1);
});
