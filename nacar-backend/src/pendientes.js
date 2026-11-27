// Mantenciones "por registrar": un auto que vino a mantención (trabajo "Mantención…"/"Filtro…" en
// la orden, o la palabra "mantención" en la nota de la cita) queda en el historial del taller al
// ingresar, pero el asesor debe REGISTRAR después la mantención (aceite, filtros y sus códigos)
// en Vehículos. Mientras no exista una mantención registrada desde que el auto ingresó, queda
// como pendiente. Así no se olvida y después se sabe qué filtros usa cada auto.
const { pool } = require('./db');

// Solo cuentan los ingresos desde esta fecha (así no aparece todo el historial anterior).
const DESDE = '2026-11-27 00:00:00-03';

const CONDICION = `
  c.ingresado_en >= '${DESDE}'::timestamptz
  AND COALESCE(c.no_show, false) = false
  AND (
    c.nota ILIKE '%mantenci%'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.tareas) = 'array' THEN c.tareas ELSE '[]'::jsonb END) t
      WHERE t->>'nombre' ILIKE 'Mantenci%' OR t->>'nombre' ILIKE 'Filtro%'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM mantenciones m WHERE m.vehiculo_id = c.vehiculo_id AND m.creado_en >= c.ingresado_en
  )`;

// Lista (un registro por vehículo, el ingreso más reciente).
async function listarPendientes() {
  const r = await pool.query(
    `SELECT DISTINCT ON (c.vehiculo_id)
            c.id AS cita_id, c.vehiculo_id, v.patente, v.marca, v.modelo,
            to_char(c.ingresado_en AT TIME ZONE 'America/Santiago', 'DD/MM') AS dia,
            (c.salida_en IS NOT NULL) AS entregado
     FROM citas c JOIN vehiculos v ON v.id = c.vehiculo_id
     WHERE ${CONDICION}
     ORDER BY c.vehiculo_id, c.ingresado_en DESC`
  );
  return r.rows;
}

async function pendienteDeCita(citaId) {
  const r = await pool.query(`SELECT 1 FROM citas c WHERE c.id = $1 AND ${CONDICION}`, [citaId]);
  return !!r.rows[0];
}

module.exports = { listarPendientes, pendienteDeCita };
