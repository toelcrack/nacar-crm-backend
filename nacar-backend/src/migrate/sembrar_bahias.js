// Siembra las bahías fijas del taller: 3 elevadores + 1 patio (espera).
// Se puede correr muchas veces sin duplicar (ON CONFLICT DO NOTHING).
// Uso: node src/migrate/sembrar_bahias.js
require('dotenv').config();
const { pool } = require('../db');

const BAHIAS = [
  { nombre: 'Elevador 1', tipo: 'elevador', orden: 1 },
  { nombre: 'Elevador 2', tipo: 'elevador', orden: 2 },
  { nombre: 'Elevador 3', tipo: 'elevador', orden: 3 },
  { nombre: 'Patio', tipo: 'patio', orden: 4 },
];

async function main() {
  let agregadas = 0;
  for (const b of BAHIAS) {
    const r = await pool.query(
      'INSERT INTO bahias (nombre, tipo, orden) VALUES ($1,$2,$3) ON CONFLICT (nombre) DO NOTHING RETURNING id',
      [b.nombre, b.tipo, b.orden]
    );
    if (r.rows[0]) agregadas += 1;
  }
  console.log(`Listo: ${agregadas} bahías nuevas agregadas (de ${BAHIAS.length} revisadas).`);
  await pool.end();
}

main().catch((e) => {
  console.error('Error sembrando bahías:', e);
  process.exit(1);
});
