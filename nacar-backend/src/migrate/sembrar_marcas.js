// Siembra la lista inicial de marcas de auto para el selector del CRM.
// Se puede correr muchas veces sin duplicar (ON CONFLICT DO NOTHING).
// Uso: node src/migrate/sembrar_marcas.js
require('dotenv').config();
const { pool } = require('../db');

// Lista base: las 39 marcas del cotizador de la página web (ranking real de ventas en Chile,
// fuente RutaMotor) más las marcas que ya aparecían en el historial real de mantenciones del taller.
const MARCAS = [
  'Audi', 'BAIC', 'BMW', 'BYD', 'Changan', 'Chery', 'Chevrolet', 'Citroën', 'Cupra', 'DFSK',
  'DongFeng', 'Fiat', 'Ford', 'Foton', 'GAC', 'Geely', 'GWM/Haval', 'Honda', 'Hyundai', 'JAC',
  'Jaecoo/Omoda', 'Jeep', 'Jetour', 'JMC', 'Kia', 'Land Rover', 'Lexus', 'Maxus', 'Mazda',
  'Mercedes-Benz', 'MG', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Porsche', 'RAM', 'Renault',
  'Samsung', 'Skoda', 'SsangYong', 'Subaru', 'Suzuki', 'Toyota', 'Volkswagen', 'Volvo',
];

async function main() {
  let agregadas = 0;
  for (const nombre of MARCAS) {
    const r = await pool.query(
      'INSERT INTO marcas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING id',
      [nombre]
    );
    if (r.rows[0]) agregadas += 1;
  }
  console.log(`Listo: ${agregadas} marcas nuevas agregadas (de ${MARCAS.length} revisadas).`);
  await pool.end();
}

main().catch((e) => {
  console.error('Error sembrando marcas:', e);
  process.exit(1);
});
