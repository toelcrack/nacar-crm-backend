# CRM Nácar — backend real

Este es el sistema real: base de datos compartida, login con contraseña para ti y tu equipo, y roles (administrador vs. mecánico/recepción) aplicados de verdad en el servidor — no solo escondiendo botones como en el prototipo.

Ya se probó de punta a punta en el entorno de Claude: login, crear vehículo, agregar mantención, editar/eliminar solo como administrador, y la importación completa de tu planilla histórica (336 mantenciones, 302 vehículos).

## Qué incluye

- `src/server.js` — el servidor (Node.js + Express).
- `src/routes/` — las rutas de la API (login, vehículos, mantenciones, usuarios).
- `src/migrate/esquema.sql` — la estructura de la base de datos.
- `src/migrate/crear_admin.js` — crea tu cuenta de administrador.
- `src/migrate/importar_historico.js` + `datos_historicos.json` — importa tu planilla histórica ya procesada.
- `public/` — la pantalla del CRM (login + la app), con tu marca aplicada.

## Paso 1 — Crear la cuenta y la base de datos en Railway

1. Ve a [railway.app](https://railway.app) y crea una cuenta (puedes entrar con tu correo o con GitHub).
2. Dentro de un proyecto nuevo, click **"+ New" → "Database" → "Add PostgreSQL"**. Railway crea la base de datos sola.
3. Click en el servicio de Postgres → pestaña **"Variables"** → copia el valor de `DATABASE_URL` (lo vas a necesitar en el paso 3).

*(Render funciona muy parecido: creas un "PostgreSQL" y un "Web Service" desde su panel — si prefieres Render en vez de Railway, avísame y te paso los pasos equivalentes.)*

## Paso 2 — Subir este código

La forma más simple es subir esta carpeta a un repositorio de GitHub (puedes arrastrarla directo en github.com/new, sin usar la terminal) y luego, en Railway, **"+ New" → "GitHub Repo"** y elegir ese repositorio. Railway detecta que es un proyecto Node.js y lo instala solo.

## Paso 3 — Configurar las variables de entorno

En el servicio de la app (no el de la base de datos) dentro de Railway, pestaña **"Variables"**, agrega:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | El que copiaste en el Paso 1 |
| `PGSSL` | `true` |
| `JWT_SECRET` | Una clave larga y al azar (pídeme que te genere una si no tienes cómo) |
| `NODE_ENV` | `production` |

Railway reinicia la app solo cuando guardas las variables.

## Paso 4 — Crear las tablas, tu cuenta y cargar tu historial

Con el proyecto ya desplegado, corre estos tres comandos **una sola vez** (Railway tiene un botón "Shell" o `railway run` desde su CLI; si no sabes cómo, dime y lo hacemos juntos paso a paso):

```bash
npm run migrar:esquema
node src/migrate/crear_admin.js "Tu Nombre" tu@correo.com "una-contraseña-segura"
node src/migrate/importar_historico.js tu@correo.com
```

El último comando carga tus 336 mantenciones reales. Después de esto, entra a la URL que te dio Railway (algo como `nacar-crm.up.railway.app`), inicia sesión con el correo y contraseña que usaste en `crear_admin.js`, y ya está — vas a ver tu historial real.

## Paso 5 — Crear cuentas para tus mecánicos/recepción

Ya logueado como administrador, en el botón **"Gestionar equipo"** (arriba a la derecha) puedes crear una cuenta por cada persona, con su propio correo y contraseña. Ellos van a poder agregar vehículos y mantenciones, pero no van a poder editar ni eliminar nada — eso queda solo para administradores.

## Notas de seguridad

- Las contraseñas nunca se guardan en texto plano (se guardan con `bcrypt`, un hash de un solo sentido).
- La sesión de cada persona se guarda en una cookie firmada (`JWT_SECRET`) — por eso esa clave tiene que ser larga y no compartirse.
- El control de "solo administrador puede editar/eliminar" se aplica en el servidor (`requireAdmin` en `src/auth.js`), no solo escondiendo un botón — a diferencia del prototipo anterior, esto sí es seguridad real.

## Desarrollo local (si quieres seguir iterando aquí mismo antes de desplegar)

```bash
npm install
cp .env.example .env   # y completa DATABASE_URL apuntando a un Postgres local o de prueba
npm run migrar:esquema
node src/migrate/crear_admin.js "Tu Nombre" tu@correo.com "contraseña"
npm start
```
