// Horario hábil del taller (hora de Chile): lun–jue 9:00–18:30, vie 9:00–18:00, sáb 10:00–14:00,
// domingo cerrado. El tiempo que un auto lleva "en el taller" cuenta SOLO dentro de este horario
// (un auto que entra el viernes en la tarde no suma la noche ni el domingo).
const VENTANAS = { 1: [540, 1110], 2: [540, 1110], 3: [540, 1110], 4: [540, 1110], 5: [540, 1080], 6: [600, 840] };

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// instante -> minutos de "reloj de pared" en Chile desde 1970 (días*1440 + minutos del día)
function minutosLocales(fecha) {
  const p = {};
  fmt.formatToParts(fecha).forEach((x) => { p[x.type] = x.value; });
  const dia = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
  return dia * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

function minutosHabiles(desde, hasta) {
  const a = minutosLocales(new Date(desde));
  const b = minutosLocales(new Date(hasta || Date.now()));
  if (!(b > a)) return 0;
  let total = 0;
  for (let d = Math.floor(a / 1440); d <= Math.floor(b / 1440); d++) {
    const v = VENTANAS[new Date(d * 86400000).getUTCDay()];
    if (!v) continue;
    const ini = Math.max(a, d * 1440 + v[0]);
    const fin = Math.min(b, d * 1440 + v[1]);
    if (fin > ini) total += fin - ini;
  }
  return total;
}

module.exports = { minutosHabiles };
