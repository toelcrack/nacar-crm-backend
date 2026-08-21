const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function safeInt(v) {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) ? Math.round(n) : null;
}

// Solo administrador puede corregir o eliminar una mantención ya guardada.
// Mecánicos/recepción solo pueden AGREGAR (ver routes/vehiculos.js) — así el
// historial es append-only para cualquiera que no sea el dueño del taller.

router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  const FILTROS = [
    { marcado: 'filtroAire', codigo: 'filtroAireCodigo', nombre: 'filtro de aire' },
    { marcado: 'filtroPolen', codigo: 'filtroPolenCodigo', nombre: 'filtro de polen' },
    { marcado: 'filtroAceite', codigo: 'filtroAceiteCodigo', nombre: 'filtro de aceite' },
    { marcado: 'filtroCombustible', codigo: 'filtroCombustibleCodigo', nombre: 'filtro de combustible' },
  ];
  for (const f of FILTROS) {
    if (b[f.marcado] && !String(b[f.codigo] || '').trim()) {
      return res.status(400).json({ error: `Pusiste el ${f.nombre} — falta el código del repuesto.` });
    }
  }
  const hayAlgo = FILTROS.some((f) => b[f.marcado]) || (b.aceite && String(b.aceite).trim()) || (b.notas && String(b.notas).trim());
  if (!b.fecha || !hayAlgo) {
    return res.status(400).json({ error: 'Completa la fecha y al menos un repuesto, el aceite o una nota.' });
  }

  const r = await pool.query(
    `UPDATE mantenciones SET
       fecha=$1, km=$2, tecnico=$3, costo=$4, motor=$5, aceite=$6, litros=$7,
       filtro_aire=$8, filtro_aire_codigo=$9, filtro_polen=$10, filtro_polen_codigo=$11,
       filtro_aceite=$12, filtro_aceite_codigo=$13, filtro_combustible=$14, filtro_combustible_codigo=$15,
       notas=$16, editado_en=now(), editado_por=$17
     WHERE id=$18
     RETURNING *`,
    [
      b.fecha,
      safeInt(b.km),
      b.tecnico || '',
      safeInt(b.costo),
      b.motor || '',
      b.aceite || '',
      b.litros || '',
      !!b.filtroAire, b.filtroAire ? b.filtroAireCodigo : null,
      !!b.filtroPolen, b.filtroPolen ? b.filtroPolenCodigo : null,
      !!b.filtroAceite, b.filtroAceite ? b.filtroAceiteCodigo : null,
      !!b.filtroCombustible, b.filtroCombustible ? b.filtroCombustibleCodigo : null,
      b.notas || '',
      req.usuario.id,
      id,
    ]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Mantención no encontrada.' });
  res.json(r.rows[0]);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM mantenciones WHERE id=$1 RETURNING id', [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Mantención no encontrada.' });
  res.json({ ok: true });
});

module.exports = router;
