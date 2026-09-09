-- Esquema del CRM de Nácar Service.
-- Se puede correr muchas veces sin romper nada (todo con IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','mecanico')),
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehiculos (
  id SERIAL PRIMARY KEY,
  patente TEXT NOT NULL UNIQUE,
  marca TEXT,
  modelo TEXT,
  anio TEXT,
  combustible TEXT NOT NULL DEFAULT 'bencina' CHECK (combustible IN ('bencina','diesel')),
  cliente_nombre TEXT,
  cliente_correo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS mantenciones (
  id SERIAL PRIMARY KEY,
  vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  fecha DATE,
  km INTEGER,
  tecnico TEXT,
  costo INTEGER,
  motor TEXT,
  aceite TEXT,
  litros TEXT,
  filtro_aire BOOLEAN NOT NULL DEFAULT false,
  filtro_aire_codigo TEXT,
  filtro_polen BOOLEAN NOT NULL DEFAULT false,
  filtro_polen_codigo TEXT,
  filtro_aceite BOOLEAN NOT NULL DEFAULT false,
  filtro_aceite_codigo TEXT,
  filtro_combustible BOOLEAN NOT NULL DEFAULT false,
  filtro_combustible_codigo TEXT,
  notas TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por INTEGER REFERENCES usuarios(id),
  editado_en TIMESTAMPTZ,
  editado_por INTEGER REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_vehiculos_patente ON vehiculos (patente);
CREATE INDEX IF NOT EXISTS idx_vehiculos_marca_modelo ON vehiculos (marca, modelo);
CREATE INDEX IF NOT EXISTS idx_mantenciones_vehiculo ON mantenciones (vehiculo_id);

-- Listas configurables para los selectores de "Marca" y "Técnico" (no son llaves foráneas:
-- vehiculos.marca y mantenciones.tecnico siguen siendo texto libre, esto es solo la lista de sugerencias).
CREATE TABLE IF NOT EXISTS marcas (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tecnicos (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agenda del taller: bahías fijas (3 elevadores + 1 patio de espera) para saber, de un vistazo,
-- qué auto está en cada una y qué se le está haciendo. vehiculo_id usa ON DELETE SET NULL (no
-- CASCADE) para que si algún día se elimina el vehículo, la bahía quede libre en vez de romperse.
CREATE TABLE IF NOT EXISTS bahias (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL DEFAULT 'elevador' CHECK (tipo IN ('elevador','patio')),
  orden INTEGER NOT NULL DEFAULT 0,
  vehiculo_id INTEGER REFERENCES vehiculos(id) ON DELETE SET NULL,
  nota TEXT,
  ocupado_desde TIMESTAMPTZ
);

-- Calendario de mantenciones futuras por bahía (agregado 09-sep-2026): permite agendar, con
-- fecha y horas, qué auto va a ocupar cada elevador/patio los próximos días, no solo saber
-- quién está ahí ahora. "atrasado" es una bandera visual (borde/alerta) para marcar atrasos o
-- problemas con el auto asignado a esa cita, sin perder la nota original del trabajo.
-- No reemplaza "bahias" (que sigue siendo "quién está ahí ahora mismo" para autos sin cita
-- previa) — es aditivo, así que no afecta nada de lo ya desplegado y probado.
CREATE TABLE IF NOT EXISTS citas (
  id SERIAL PRIMARY KEY,
  bahia_id INTEGER NOT NULL REFERENCES bahias(id) ON DELETE CASCADE,
  vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin TIME,
  nota TEXT,
  atrasado BOOLEAN NOT NULL DEFAULT false,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por INTEGER REFERENCES usuarios(id),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_citas_bahia_fecha ON citas (bahia_id, fecha);
CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas (fecha);
