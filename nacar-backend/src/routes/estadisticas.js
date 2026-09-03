const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}
function pct(parte, total) {
  if (!total) return 0;
  return Math.round((parte / total) * 1000) / 10; // 1 decimal
}

// GET /api/estadisticas  -> KPIs del taller (solo administrador)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [
      totales,
      porVehiculo,
      marcas,
      modelos,
      combustible,
      filtros,
      codigos,
      costos,
      km,
      tecnicos,
      porMes,
    ] = await Promise.all([
      pool.query(
        `SELECT (SELECT COUNT(*) FROM vehiculos)::int AS vehiculos,
                (SELECT COUNT(*) FROM mantenciones)::int AS mantenciones`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE cnt > 0)::int AS con_alguna,
           COUNT(*) FILTER (WHERE cnt > 1)::int AS con_mas_de_una,
           COUNT(*) FILTER (WHERE cnt = 0)::int AS sin_ninguna
         FROM (
           SELECT v.id, COUNT(m.id) AS cnt
           FROM vehiculos v LEFT JOIN mantenciones m ON m.vehiculo_id = v.id
           GROUP BY v.id
         ) t`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(marca), ''), '(sin marca)') AS marca, COUNT(*)::int AS cantidad
         FROM vehiculos GROUP BY 1 ORDER BY cantidad DESC LIMIT 6`
      ),
      pool.query(
        `SELECT marca, modelo, COUNT(*)::int AS cantidad
         FROM vehiculos
         WHERE TRIM(COALESCE(marca, '')) <> '' AND TRIM(COALESCE(modelo, '')) <> ''
         GROUP BY marca, modelo ORDER BY cantidad DESC LIMIT 5`
      ),
      pool.query('SELECT combustible, COUNT(*)::int AS cantidad FROM vehiculos GROUP BY combustible'),
      pool.query(
        `SELECT
           SUM(CASE WHEN filtro_aire THEN 1 ELSE 0 END)::int AS aire,
           SUM(CASE WHEN filtro_polen THEN 1 ELSE 0 END)::int AS polen,
           SUM(CASE WHEN filtro_aceite THEN 1 ELSE 0 END)::int AS aceite,
           SUM(CASE WHEN filtro_combustible THEN 1 ELSE 0 END)::int AS combustible
         FROM mantenciones`
      ),
      pool.query(
        `SELECT codigo, COUNT(*)::int AS cantidad FROM (
           SELECT TRIM(filtro_aire_codigo) AS codigo FROM mantenciones
             WHERE filtro_aire AND TRIM(COALESCE(filtro_aire_codigo, '')) <> ''
           UNION ALL
           SELECT TRIM(filtro_polen_codigo) FROM mantenciones
             WHERE filtro_polen AND TRIM(COALESCE(filtro_polen_codigo, '')) <> ''
           UNION ALL
           SELECT TRIM(filtro_aceite_codigo) FROM mantenciones
             WHERE filtro_aceite AND TRIM(COALESCE(filtro_aceite_codigo, '')) <> ''
           UNION ALL
           SELECT TRIM(filtro_combustible_codigo) FROM mantenciones
             WHERE filtro_combustible AND TRIM(COALESCE(filtro_combustible_codigo, '')) <> ''
         ) t
         GROUP BY codigo ORDER BY cantidad DESC LIMIT 6`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE costo IS NOT NULL AND costo > 0)::int AS con_costo,
           COALESCE(SUM(costo) FILTER (WHERE costo IS NOT NULL AND costo > 0), 0)::bigint AS total,
           COALESCE(AVG(costo) FILTER (WHERE costo IS NOT NULL AND costo > 0), 0)::int AS promedio
         FROM mantenciones`
      ),
      pool.query(
        "SELECT COALESCE(AVG(km) FILTER (WHERE km IS NOT NULL AND km > 0), 0)::int AS promedio FROM mantenciones"
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(tecnico), ''), '(sin especificar)') AS tecnico, COUNT(*)::int AS cantidad
         FROM mantenciones GROUP BY 1 ORDER BY cantidad DESC LIMIT 5`
      ),
      pool.query(
        `SELECT to_char(mes, 'YYYY-MM') AS mes, COUNT(m.id)::int AS cantidad
         FROM generate_series(
                date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
                date_trunc('month', CURRENT_DATE),
                INTERVAL '1 month'
              ) AS mes
         LEFT JOIN mantenciones m ON date_trunc('month', m.fecha) = mes
         GROUP BY mes ORDER BY mes`
      ),
    ]);

    const totalVehiculos = totales.rows[0].vehiculos;
    const totalMantenciones = totales.rows[0].mantenciones;
    const conAlguna = porVehiculo.rows[0].con_alguna;
    const conMasDeUna = porVehiculo.rows[0].con_mas_de_una;
    const sinNinguna = porVehiculo.rows[0].sin_ninguna;

    res.json({
      totales: {
        vehiculos: totalVehiculos,
        mantenciones: totalMantenciones,
        promedio_mantenciones_por_vehiculo: totalVehiculos
          ? Math.round((totalMantenciones / totalVehiculos) * 10) / 10
          : 0,
        vehiculos_sin_mantencion: sinNinguna,
      },
      clientes_recurrentes: {
        vehiculos_con_alguna_mantencion: conAlguna,
        vehiculos_con_mas_de_una: conMasDeUna,
        // % sobre el total de patentes registradas (responde directo "qué % de patentes ha vuelto más de una vez")
        porcentaje_sobre_total_vehiculos: pct(conMasDeUna, totalVehiculos),
        // % sobre las patentes que ya tienen al menos 1 mantención (tasa de repetición de clientes ya atendidos)
        porcentaje_sobre_atendidos: pct(conMasDeUna, conAlguna),
      },
      marcas_top: marcas.rows.map((r) => ({
        marca: r.marca,
        cantidad: r.cantidad,
        porcentaje: pct(r.cantidad, totalVehiculos),
      })),
      modelos_top: modelos.rows.map((r) => ({ marca: r.marca, modelo: r.modelo, cantidad: r.cantidad })),
      combustible: combustible.rows.map((r) => ({
        combustible: r.combustible,
        cantidad: r.cantidad,
        porcentaje: pct(r.cantidad, totalVehiculos),
      })),
      filtros_cambiados: [
        { filtro: 'Filtro de aire', cantidad: num(filtros.rows[0].aire) },
        { filtro: 'Filtro de polen', cantidad: num(filtros.rows[0].polen) },
        { filtro: 'Filtro de aceite', cantidad: num(filtros.rows[0].aceite) },
        { filtro: 'Filtro de combustible', cantidad: num(filtros.rows[0].combustible) },
      ].sort((a, b) => b.cantidad - a.cantidad),
      codigos_repuesto_top: codigos.rows,
      costos: {
        mantenciones_con_costo_registrado: costos.rows[0].con_costo,
        total_clp: num(costos.rows[0].total),
        promedio_clp: num(costos.rows[0].promedio),
      },
      kilometraje_promedio: km.rows[0].promedio,
      tecnicos_top: tecnicos.rows,
      mantenciones_por_mes: porMes.rows,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudieron calcular las estadísticas.' });
  }
});

module.exports = router;
