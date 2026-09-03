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
