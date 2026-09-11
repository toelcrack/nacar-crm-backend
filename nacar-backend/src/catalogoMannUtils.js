// Funciones compartidas para el catálogo Mann Filter: se usan TANTO al importar el catálogo
// (src/migrate/importar_catalogo_mann.js, para calcular marca_norm/año/diesel de cada fila del
// Excel) COMO al consultar en tiempo real qué filtro sugerir (src/filtros.js, para calcular el
// marca_norm del vehículo que se está buscando). Tienen que ser las MISMAS funciones en ambos
// lados — si no, "Mercedes-Benz" del vehículo nunca haría match con "MERCEDES BENZ" del catálogo.

// Grupos de nombres de marca que en la práctica son la misma marca pero se escriben distinto
// entre el catálogo Mann (a veces usa el nombre "oficial" o antiguo) y lo que usamos nosotros
// (selector del CRM, o lo que devuelve el registro nacional de vehículos). El primer elemento
// de cada grupo es arbitrario, solo se usa como "nombre canónico" interno.
const GRUPOS_ALIAS_MARCA = [
  ['KIA', 'KIA MOTORS'],
  ['GWM', 'GREAT WALL', 'GWM HAVAL', 'GREAT WALL MOTORS', 'HAVAL'],
  ['JAECOO OMODA', 'OMODA', 'JAECOO'],
  ['SSANGYONG', 'SSANG YONG'],
  ['DS', 'DS AUTOMOBILES'],
];

const ALIAS_MARCA = {};
for (const grupo of GRUPOS_ALIAS_MARCA) {
  for (const variante of grupo) ALIAS_MARCA[variante] = grupo[0];
}

// Deja la marca en mayúsculas, sin tildes, sin guiones/slashes/puntuación (todo eso pasa a
// espacio), con espacios simples — y aplica los alias de arriba. Aplicar exactamente esto mismo
// en el import y en la consulta es lo que hace que el match funcione.
function normalizarMarca(valor) {
  let s = String(valor || '').toUpperCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // saca tildes: Ë -> E, Ñ -> N, etc.
  s = s.replace(/[^A-Z0-9]+/g, ' ').trim(); // guiones, "/", puntos, etc. -> espacio
  s = s.replace(/\s+/g, ' ');
  return ALIAS_MARCA[s] || s;
}

// El Excel de Mann trae los años de cobertura de cada fila en texto libre, con varios formatos
// vistos en la práctica (revisado fila por fila antes de escribir esto):
//   "84->"              -> desde 1984, sin tope (auto sigue vigente)
//   "->99"              -> hasta 1999, sin piso
//   "00-01" / "91-94"   -> rango de años (2 dígitos)
//   "->9/72" / "->02/07"-> "mes/año", nos quedamos solo con el año
//   "1998" / "72"       -> año exacto (4 o 2 dígitos)
//   "cualquier otro año"-> comodín explícito (fila sin año en la columna original, Mann la usa
//                          para motores que se mantuvieron igual "para cualquier año")
// Con años de 2 dígitos hay que adivinar el siglo: en todo el catálogo el rango real observado
// es ~1968-2024, así que "<=30" se interpreta como 20XX y el resto como 19XX.
function anioCompleto(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (t.length >= 4) return n;
  return n <= 30 ? 2000 + n : 1900 + n;
}

// Si el token es "mes/año" (ej. "9/72"), nos quedamos con la última parte (el año).
function extraerToken(pedazo) {
  const partes = String(pedazo || '').trim().split('/');
  return anioCompleto(partes[partes.length - 1]);
}

function parseAnios(raw) {
  const texto = String(raw || '').trim();
  if (!texto) return { desde: null, hasta: null, wildcard: false };
  if (texto.toLowerCase().indexOf('cualquier') !== -1) {
    return { desde: null, hasta: null, wildcard: true };
  }
  if (texto.indexOf('->') !== -1) {
    const [izq, der] = texto.split('->');
    return {
      desde: izq.trim() ? extraerToken(izq) : null,
      hasta: der.trim() ? extraerToken(der) : null,
      wildcard: false,
    };
  }
  if (/^\d{1,4}\s*-\s*\d{1,4}$/.test(texto)) {
    const [a, b] = texto.split('-').map((s) => s.trim());
    return { desde: extraerToken(a), hasta: extraerToken(b), wildcard: false };
  }
  const y = extraerToken(texto);
  if (y != null) return { desde: y, hasta: y, wildcard: false };
  return { desde: null, hasta: null, wildcard: false };
}

// Detecta si el texto de motor corresponde a un motor diésel, por las siglas típicas que usan
// las marcas para sus versiones diésel (CRDI = Hyundai/Kia, TDI = VW/Audi, HDI = Peugeot/Citroën,
// D-4D = Toyota, DCI = Renault/Nissan, CDTI = Opel/Chevrolet, DTEC = Honda, TDCI = Ford).
const RE_DIESEL = /diesel|di[eé]sel|\bcrdi\b|\btdi\b|\btdci\b|\bdci\b|\bhdi\b|\bdtec\b|d-4d|\bcdti\b/i;
function esDiesel(motorTexto) {
  return RE_DIESEL.test(String(motorTexto || ''));
}

module.exports = { normalizarMarca, parseAnios, esDiesel };
