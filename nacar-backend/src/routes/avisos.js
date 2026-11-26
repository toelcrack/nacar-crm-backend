const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { clavePublica } = require('../push');

const router = express.Router();
router.use(requireAuth);

// GET /api/avisos/clave -> llave pública para suscribir este celular
router.get('/clave', async (req, res) => {
  try { res.json({ clave: await clavePublica() }); } catch (e) { res.status(500).json({ error: 'No se pudo preparar las notificaciones.' }); }
});

// GET /api/avisos/mios -> qué avisos tiene activados mi cuenta (los define el administrador en Equipo)
router.get('/mios', async (req, res) => {
  try {
    const r = await pool.query('SELECT avisos FROM usuarios WHERE id = $1', [req.usuario.id]);
    res.json({ avisos: (r.rows[0] && r.rows[0].avisos) || [] });
  } catch (e) { res.json({ avisos: [] }); }
});

// POST /api/avisos/suscribir { endpoint, keys:{p256dh,auth} }
router.post('/suscribir', async (req, res) => {
  const s = req.body || {};
  const k = s.keys || {};
  if (!s.endpoint || !k.p256dh || !k.auth) return res.status(400).json({ error: 'Suscripción inválida.' });
  try {
    await pool.query(
      `INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.usuario.id, s.endpoint, k.p256dh, k.auth]
    );
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: 'No se pudo activar las notificaciones.' });
  }
});

// POST /api/avisos/desuscribir { endpoint }
router.post('/desuscribir', async (req, res) => {
  try {
    await pool.query('DELETE FROM push_suscripciones WHERE endpoint = $1 AND usuario_id = $2', [String((req.body || {}).endpoint || ''), req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo apagar las notificaciones.' }); }
});

// POST /api/avisos/prueba -> te manda un aviso de prueba a ti (si tienes algún aviso activado no importa)
router.post('/prueba', async (req, res) => {
  try {
    const r = await pool.query('SELECT s.endpoint, s.p256dh, s.auth FROM push_suscripciones s WHERE s.usuario_id = $1', [req.usuario.id]);
    if (!r.rows.length) return res.status(400).json({ error: 'Este celular no tiene las notificaciones activadas.' });
    const webpush = require('web-push');
    await clavePublica();
    await Promise.all(r.rows.map((s) => webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title: 'Nacar Automotriz', body: 'Las notificaciones funcionan.', url: '/', tag: 'prueba' })
    ).catch(() => {})));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo enviar la prueba.' }); }
});

module.exports = router;
