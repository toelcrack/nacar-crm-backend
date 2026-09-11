// Lógica de "qué filtro sugerir" para el Simulador de mantención (agregado 11-sep-2026).
//
// Cuando el Simulador identifica un vehículo (venga de nuestra base o del registro nacional vía
// GetAPI), esta función mira DOS fuentes y devuelve las dos sin elegir una por sobre la otra
// (así lo pidió el usuario):
//   1) "historial": nuestra propia experiencia — qué código de filtro le hemos puesto a autos
//      parecidos en mantenciones anteriores.
//   2) "mann": el catálogo del fabricante Mann Filter (Excel que entregó el usuario, importado
//      a la tabla catalogo_mann con src/migrate/importar_catalogo_mann.js).
//
// Para "historial" se agrupa por Marca + modelo + motor (elegido por el usuario, más preciso),
// y si no hay ningún dato con esa combinación exacta, se repite la búsqueda solo por Marca +
// modelo (más autos entran, aunque el motor no calce) — se indica cuál de los dos tiers encontró
// el resultado para que el mecánico sepa qué tan parecido es el dato.
//
// Para "mann" el catálogo trae, para un mismo modelo, varias filas que a veces se solapan de
// verdad (mismo modelo con 2-3 motorizaciones distintas en años parecidos) — en vez de adivinar
// cuál de esas filas es la correcta, se devuelven TODAS las que sobrevivan el filtrado por
// marca/modelo/motor/combustible/año, con su texto original (motor, años) para que el mecánico
// las compare a simple vista y elija. Nunca se inventa un único código cuando hay ambigüedad real.
const { pool } = require('./db');
const { normalizarMarca } = require('./catalogoMannUtils');

const TIPOS = ['aceite', 'aire', 'polen', 'combustible'];

const COLUMNAS_HISTORIAL = {
  aceite: { marcado: 'filtro_aceite', codigo: 'filtro_aceite_codigo' },
  aire: { marcado: 'filtro_aire', codigo: 'filtro_aire_codigo' },
  polen: { marcado: 'filtro_polen', codigo: 'filtro_polen_codigo' },
  combustible: { marcado: 'filtro_combustible', codigo: 'filtro_combustible_codigo' },
};

const COLUMNAS_MANN = {
  aceite: 'filtro_aceite_codigo',
  aire: 'filtro_aire_codigo',
  polen: 'filtro_polen_codigo',
  combustible: 'filtro_combustible_codigo',
};

function normalizarTexto(valor) {
  let s = String(valor || '').toUpperCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^A-Z0-9]+/g, ' ').trim();
  return s;
}

// -------------------- Historial propio (mantenciones ya cargadas) --------------------

async function consultarHistorialTier(marca, modelo, motor, combustible, requiereCombustible) {
  const resultado = {};
  for (const tipo of TIPOS) {
    const { marcado, codigo } = COLUMNAS_HISTORIAL[tipo];
    const params = [`%${marca}%`, `%${modelo}%`];
    let sql = `
      SELECT m.${codigo} AS codigo, COUNT(*)::int AS veces
      FROM mantenciones m
      JOIN vehiculos v ON v.id = m.vehiculo_id
      WHERE v.marca ILIKE $1 AND v.modelo ILIKE $2
        AND m.${marcado} = true AND m.${codigo} IS NOT NULL AND TRIM(m.${codigo}) <> ''`;
    if (motor) {
      params.push(motor.trim().toLowerCase());
      sql += ` AND TRIM(LOWER(COALESCE(v.motor,''))) = $${params.length}`;
    }
    if (requiereCombustible && combustible) {
      params.push(combustible);
      sql += ` AND v.combustible = $${params.length}`;
    }
    sql += ` GROUP BY m.${codigo} ORDER BY veces DESC`;
    const r = await pool.query(sql, params);
    resultado[tipo] = r.rows;
  }
  return resultado;
}

async function sugerirDesdeHistorial(vehiculo) {
  const marca = String(vehiculo.marca || '').trim();
  const modelo = String(vehiculo.modelo || '').trim();
  const motor = String(vehiculo.motor || '').trim();
  const combustible = vehiculo.combustible;
  const salida = { aceite: null, aire: null, polen: null, combustible: null };
  if (!marca || !modelo) return salida;

  let tier1 = null;
  if (motor) {
    tier1 = await consultarHistorialTier(marca, modelo, motor, combustible, true);
  }
  const tier2 = await consultarHistorialTier(marca, modelo, null, combustible, true);

  for (const tipo of TIPOS) {
    if (tier1 && tier1[tipo].length) {
      salida[tipo] = { tier: 'marca_modelo_motor', candidatos: tier1[tipo] };
    } else if (tier2[tipo].length) {
      salida[tipo] = { tier: 'marca_modelo', candidatos: tier2[tipo] };
    } else {
      salida[tipo] = null;
    }
  }
  return salida;
}

// -------------------- Catálogo Mann Filter --------------------

function extraerCilindrada(texto) {
  const m = String(texto || '').match(/(\d+)[.,](\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

function filtrarPorModelo(filas, modeloNorm) {
  if (!modeloNorm) return filas;
  const exactos = filas.filter((f) => normalizarTexto(f.modelo) === modeloNorm);
  if (exactos.length) return exactos;
  const contiene = filas.filter((f) => {
    const fm = normalizarTexto(f.modelo);
    return fm.indexOf(modeloNorm) !== -1 || modeloNorm.indexOf(fm) !== -1;
  });
  if (contiene.length) return contiene;
  const primerToken = modeloNorm.split(' ')[0];
  if (primerToken) {
    const porToken = filas.filter((f) => normalizarTexto(f.modelo).split(' ')[0] === primerToken);
    if (porToken.length) return porToken;
  }
  return [];
}

function filtrarPorMotorDieselAnio(filas, motorTxt, combustible, anioTxt) {
  let candidatos = filas;

  const cilVeh = extraerCilindrada(motorTxt);
  if (cilVeh) {
    const porCil = candidatos.filter((f) => {
      const cilRow = extraerCilindrada(f.motor);
      return !cilRow || cilRow === cilVeh;
    });
    if (porCil.length) candidatos = porCil;
  }

  if (combustible) {
    const quiereDiesel = combustible === 'diesel';
    const porDiesel = candidatos.filter((f) => f.es_diesel === quiereDiesel);
    if (porDiesel.length) candidatos = porDiesel;
  }

  const anio = parseInt(String(anioTxt || '').trim(), 10);
  if (Number.isFinite(anio)) {
    const especificos = candidatos.filter(
      (f) => !f.anio_wildcard && (f.anio_desde == null || anio >= f.anio_desde) && (f.anio_hasta == null || anio <= f.anio_hasta)
    );
    if (especificos.length) {
      candidatos = especificos;
    } else {
      const wild = candidatos.filter((f) => f.anio_wildcard);
      if (wild.length) candidatos = wild;
    }
  }

  return candidatos;
}

async function buscarFilasPorMarca(marcaNorm) {
  let r = await pool.query('SELECT * FROM catalogo_mann WHERE marca_norm = $1', [marcaNorm]);
  if (r.rows.length) return r.rows;

  // La marca puede venir escrita distinto a como está en el catálogo (ej. una marca que no
  // esté en nuestra lista de alias). Antes de rendirse, se prueba por contención contra las
  // marcas normalizadas que sí existen en el catálogo.
  const distintos = await pool.query('SELECT DISTINCT marca_norm FROM catalogo_mann');
  let mejor = null;
  for (const { marca_norm: d } of distintos.rows) {
    if (!d || d.length < 3) continue;
    if (marcaNorm.indexOf(d) !== -1 || d.indexOf(marcaNorm) !== -1) {
      if (!mejor || d.length > mejor.length) mejor = d;
    }
  }
  if (!mejor) return [];
  r = await pool.query('SELECT * FROM catalogo_mann WHERE marca_norm = $1', [mejor]);
  return r.rows;
}

async function sugerirDesdeMann(vehiculo) {
  const salida = { aceite: null, aire: null, polen: null, combustible: null };
  const marca = String(vehiculo.marca || '').trim();
  if (!marca) return salida;

  const filasMarca = await buscarFilasPorMarca(normalizarMarca(marca));
  if (!filasMarca.length) return salida;

  const modeloNorm = normalizarTexto(vehiculo.modelo);
  const candidatosModelo = filtrarPorModelo(filasMarca, modeloNorm);
  if (!candidatosModelo.length) return salida;

  const finales = filtrarPorMotorDieselAnio(candidatosModelo, vehiculo.motor, vehiculo.combustible, vehiculo.anio);

  for (const tipo of TIPOS) {
    const col = COLUMNAS_MANN[tipo];
    const vistos = new Map();
    for (const f of finales) {
      const cod = f[col];
      if (!cod) continue;
      if (!vistos.has(cod)) {
        vistos.set(cod, { codigo: cod, motor: f.motor || null, anios: f.anios_texto || null });
      }
    }
    salida[tipo] = vistos.size ? Array.from(vistos.values()) : null;
  }
  return salida;
}

// -------------------- Combinado --------------------

// vehiculo: { marca, modelo, motor, anio, combustible } — funciona igual para un vehículo que
// viene de nuestra base (_origen: 'base') o del registro nacional (_origen: 'api_nacional'),
// porque ambos exponen los mismos 5 campos (ver src/getapi.js y src/routes/vehiculos.js).
async function sugerirFiltros(vehiculo) {
  const [historial, mann] = await Promise.all([sugerirDesdeHistorial(vehiculo), sugerirDesdeMann(vehiculo)]);
  const resultado = {};
  for (const tipo of TIPOS) {
    resultado[tipo] = { historial: historial[tipo], mann: mann[tipo] };
  }
  return resultado;
}

module.exports = { sugerirFiltros };
