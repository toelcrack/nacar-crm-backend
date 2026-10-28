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
  motor TEXT,
  vin TEXT,
  cliente_nombre TEXT,
  cliente_correo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por INTEGER REFERENCES usuarios(id)
);

-- "motor" y "vin" se agregaron el 11-sep-2026 (ver "Simulador de mantención" más abajo) a una
-- tabla que ya existía desde el inicio — ALTER TABLE porque CREATE TABLE IF NOT EXISTS no
-- agrega columnas nuevas a una tabla que ya existe en producción.
ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS motor TEXT;
ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS vin TEXT;

-- Cliente como entidad propia (agregado 14-sep-2026): antes el "cliente" era solo texto suelto
-- (cliente_nombre/cliente_correo) pegado a cada vehículo — eso no permite saber que dos autos
-- son del mismo dueño, ni reasignar un auto a otro dueño cuando se vende sin perder su historial
-- de mantenciones. cliente_nombre/cliente_correo NO se borran (quedan de respaldo para lo ya
-- migrado y por si algún vehículo todavía no tiene cliente_id) — el dato "vivo" pasa a vivir en
-- clientes + vehiculos.cliente_id. Ver src/migrate/migrar_clientes.js para la migración de datos.
CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_correo ON clientes (LOWER(correo));
CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes (LOWER(nombre));

ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id);
CREATE INDEX IF NOT EXISTS idx_vehiculos_cliente ON vehiculos (cliente_id);

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
--
-- bahia_id es NULLABLE (cambiado 28-oct-2026): Andy (asesor) agenda la cita con fecha/hora pero
-- SIN elegir elevador — queda "pendiente" hasta que el mecánico la ingresa físicamente a un
-- elevador/patio disponible (ver POST /api/citas/:id/ingresar en src/routes/citas.js). Antes
-- bahia_id era obligatorio desde que se creaba la cita.
CREATE TABLE IF NOT EXISTS citas (
  id SERIAL PRIMARY KEY,
  bahia_id INTEGER REFERENCES bahias(id) ON DELETE CASCADE,
  vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin TIME,
  nota TEXT,
  atrasado BOOLEAN NOT NULL DEFAULT false,
  -- Ingreso físico al elevador/patio (agregado 28-oct-2026, segunda ronda): bahia_id es solo la
  -- SUGERENCIA de Andy al agendar — el ingreso real a una bahía siempre es una acción manual del
  -- mecánico (ver POST /api/citas/:id/ingresar), marcada aquí. TIMESTAMPTZ para que "ahora" sea
  -- el instante real sin depender de en qué zona horaria esté configurado el servidor.
  ingresado_en TIMESTAMPTZ,
  -- El cliente agendó pero nunca llegó — distinto de cancelar por error: el registro queda
  -- (útil a futuro para medir inasistencia), solo deja de contar como "pendiente".
  no_show BOOLEAN NOT NULL DEFAULT false,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por INTEGER REFERENCES usuarios(id),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_citas_bahia_fecha ON citas (bahia_id, fecha);
CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas (fecha);

-- Chat de comentarios por cita (agregado 09-sep-2026): reemplaza el casillero único de
-- "atrasado" por una conversación real — cualquiera puede ir dejando mensajes con fecha/hora
-- y autor (ej. "9:40 llegó el auto", "10:15 atraso: falta repuesto", "11:00 resuelto, listo").
-- "atrasado" en cada mensaje es opcional: si se marca, ese mensaje pasa a ser el estado vigente
-- de la cita (citas.atrasado se actualiza solo al postear un comentario nuevo).
CREATE TABLE IF NOT EXISTS cita_comentarios (
  id SERIAL PRIMARY KEY,
  cita_id INTEGER NOT NULL REFERENCES citas(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  autor_nombre TEXT NOT NULL,
  mensaje TEXT NOT NULL,
  atrasado BOOLEAN NOT NULL DEFAULT false,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cita_comentarios_cita ON cita_comentarios (cita_id);

-- Catálogo Mann Filter (agregado 11-sep-2026): referencia de qué filtro (código Mann) usa cada
-- combinación marca/modelo/motor/año, según el catálogo oficial del fabricante. Es tabla de
-- referencia pura (no depende de nuestros vehículos ni mantenciones) que se recarga completa
-- cada vez que se corre el importador (TRUNCATE + INSERT), porque no tiene una llave natural
-- única por fila y el archivo fuente (Excel de Mann) se reemplaza entero cuando cambia.
-- Se usa junto con "nuestra experiencia" (mantenciones) para sugerir filtros en el Simulador:
-- ver src/filtros.js para la lógica de matching de ambas fuentes.
CREATE TABLE IF NOT EXISTS catalogo_mann (
  id SERIAL PRIMARY KEY,
  marca TEXT NOT NULL,
  marca_norm TEXT NOT NULL,
  modelo TEXT NOT NULL,
  motor TEXT,
  anios_texto TEXT,
  anio_desde INTEGER,
  anio_hasta INTEGER,
  anio_wildcard BOOLEAN NOT NULL DEFAULT false,
  es_diesel BOOLEAN NOT NULL DEFAULT false,
  filtro_aire_codigo TEXT,
  filtro_aceite_codigo TEXT,
  filtro_combustible_codigo TEXT,
  filtro_polen_codigo TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalogo_mann_marca_norm ON catalogo_mann (marca_norm);

-- Estado del auto en el taller (agregado 23-oct-2026): lo que el mecánico va completando
-- mientras el vehículo está en la bahía — estado de frenos/discos y el checklist de tareas que
-- pidió el asesor al recibir el auto (con diagnóstico y fotos opcionales para las tareas que lo
-- requieren, ej. Simulador de camino). Vive en "citas" porque es estado de la VISITA actual, no
-- del vehículo en general — cada vez que el auto vuelve con una cita nueva, parte en blanco.
-- "tareas" es JSONB: arreglo de {nombre, estado, visibilidad, diagnostico, fotos:[dataURL,...]}.
-- Las fotos se guardan como data URL (base64) directo en la fila — simple para partir; si el
-- volumen de fotos crece mucho más adelante, se puede migrar a un storage externo (ej. S3) sin
-- perder los datos ya cargados.
ALTER TABLE citas ADD COLUMN IF NOT EXISTS kilometraje TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS pastillas_del TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS pastillas_tra TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS discos_del TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS discos_tra TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS pastillas_tra_tipo TEXT NOT NULL DEFAULT 'pastillas';
ALTER TABLE citas ADD COLUMN IF NOT EXISTS pastillas_tra_bloqueada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS discos_del_rectificar BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS discos_tra_rectificar BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS estado_general TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS nota_estado TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS tareas JSONB NOT NULL DEFAULT '[]'::jsonb;

-- bahia_id pasa a ser opcional (28-oct-2026): para una tabla "citas" que YA existe en
-- producción con bahia_id NOT NULL, el ADD COLUMN de arriba no alcanza — hay que soltar
-- explícitamente la restricción NOT NULL. Es seguro correrlo muchas veces (si ya está
-- nullable, no hace nada).
ALTER TABLE citas ALTER COLUMN bahia_id DROP NOT NULL;

-- Ingreso físico al elevador/patio, separado de la hora agendada (28-oct-2026, segunda ronda):
-- se descubrió en producción que "pendiente = bahia_id IS NULL" no sirve, porque Andy a veces
-- sí sugiere un elevador al agendar (o la cita es de antes de este cambio) y el auto de todas
-- formas no ha entrado físicamente todavía — y porque el auto-ocupado por hora (hora_inicio <=
-- ahora) podía marcar "Ocupada" sola antes de que el mecánico confirmara que el auto llegó, o
-- no reflejar que terminó entrando en OTRA bahía porque la sugerida se liberó después. Ahora el
-- ingreso SIEMPRE es una acción manual (columna ingresado_en arriba) y "pendiente" es
-- "ingresado_en IS NULL", sin importar qué bahía sugirió Andy.
ALTER TABLE citas ADD COLUMN IF NOT EXISTS ingresado_en TIMESTAMPTZ;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS no_show BOOLEAN NOT NULL DEFAULT false;

-- Índice de "pendientes": antes filtraba por bahia_id IS NULL. CREATE INDEX IF NOT EXISTS con
-- el mismo nombre NO actualiza la condición de un índice que ya exista con otra — hay que
-- dropearlo primero para que quede con la condición correcta.
DROP INDEX IF EXISTS idx_citas_pendientes;
CREATE INDEX IF NOT EXISTS idx_citas_pendientes ON citas (fecha) WHERE ingresado_en IS NULL AND NOT no_show;
