require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const vehiculosRoutes = require('./routes/vehiculos');
const mantencionesRoutes = require('./routes/mantenciones');
const usuariosRoutes = require('./routes/usuarios');
const avisosRoutes = require('./routes/avisos');
const resumenRoutes = require('./routes/resumen');
const estadisticasRoutes = require('./routes/estadisticas');
const configuracionRoutes = require('./routes/configuracion');
const bahiasRoutes = require('./routes/bahias');
const citasRoutes = require('./routes/citas');
const clientesRoutes = require('./routes/clientes');
const confirmarRoutes = require('./routes/confirmar');

const app = express();

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use('/api/auth', authRoutes);
app.use('/api/vehiculos', vehiculosRoutes);
app.use('/api/mantenciones', mantencionesRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/avisos', avisosRoutes);
app.use('/api/resumen', resumenRoutes);
app.use('/api/estadisticas', estadisticasRoutes);
app.use('/api/configuracion', configuracionRoutes);
app.use('/api/bahias', bahiasRoutes);
app.use('/api/citas', citasRoutes);
app.use('/api/clientes', clientesRoutes);

app.use('/c', confirmarRoutes);

app.get('/api/salud', (req, res) => res.json({ ok: true }));

// app.js e index.html siempre se revalidan (no-cache): así, cuando se publica un cambio, el equipo
// lo ve de inmediato en vez de seguir con una copia vieja guardada en el navegador.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, file) {
    if (/\.(js|html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// Página pública con el link fácil, el QR y los pasos para dejar el CRM como app en el celular.
app.get('/instalar', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'instalar.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`CRM Nacar escuchando en el puerto ${PORT}`);
  require('./recordatorios').iniciar();
});
