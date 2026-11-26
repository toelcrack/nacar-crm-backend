// Deja anotado quién hizo cada paso de una cita (para el Resumen del día). Es "lo mejor que se
// pueda": si la columna aún no existe o falla, se ignora — nunca debe frenar la acción real.
const { pool } = require('./db');

const CAMPOS = ['ingresado_por', 'listo_por', 'salida_por'];

async function marcarActor(citaId, campo, usuarioId) {
  try {
    if (!CAMPOS.includes(campo) || !citaId || !usuarioId) return;
    await pool.query(`UPDATE citas SET ${campo} = $1 WHERE id = $2`, [usuarioId, citaId]);
  } catch (e) { /* silencioso a propósito */ }
}

async function marcarRespuesta(citaId) {
  try {
    await pool.query('UPDATE citas SET respondida_en = now() WHERE id = $1', [citaId]);
  } catch (e) { /* silencioso a propósito */ }
}

module.exports = { marcarActor, marcarRespuesta };
