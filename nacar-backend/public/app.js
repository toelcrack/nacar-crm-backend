(function () {
  var usuarioActual = null;
  var detalleCache = {}; // id -> {vehiculo, mantenciones}
  var abiertoId = null;
  var timerBuscar = null;
  var marcasCache = [];
  var tecnicosCache = [];

  var FILTROS = [
    { chk: 'faire', cod: 'faire-cod', campo: 'filtroAire', campoCod: 'filtroAireCodigo', nombre: 'filtro de aire', etiqueta: 'Filtro de aire' },
    { chk: 'fpolen', cod: 'fpolen-cod', campo: 'filtroPolen', campoCod: 'filtroPolenCodigo', nombre: 'filtro de polen', etiqueta: 'Filtro de polen' },
    { chk: 'faceite', cod: 'faceite-cod', campo: 'filtroAceite', campoCod: 'filtroAceiteCodigo', nombre: 'filtro de aceite', etiqueta: 'Filtro de aceite' },
    { chk: 'fcombustible', cod: 'fcombustible-cod', campo: 'filtroCombustible', campoCod: 'filtroCombustibleCodigo', nombre: 'filtro de combustible', etiqueta: null },
  ];

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.credentials = 'include';
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch('/api' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || 'Error'); e.status = r.status; e.data = data; throw e; }
        return data;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fechaBonita(iso) {
    if (!iso) return '';
    var s = String(iso).slice(0, 10);
    var p = s.split('-');
    if (p.length !== 3) return s;
    return p[2] + '-' + p[1] + '-' + p[0];
  }
  function fechaHoraBonita(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // Para timestamps reales (ej. ingresado_en) — a diferencia de horaCorta (que recorta un
  // string "HH:MM:SS" de un campo TIME), esto parte de un instante real y muestra la hora en
  // el huso horario del navegador de quien lo mira (el equipo del taller, en Chile).
  function horaDeTimestamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function avisar(msg, esError) {
    var a = document.getElementById('aviso');
    a.textContent = msg;
    a.classList.toggle('ok', !esError);
    a.classList.add('activo');
    clearTimeout(avisar._t);
    avisar._t = setTimeout(function () { a.classList.remove('activo'); }, 4500);
  }
  function avisarLogin(msg) {
    var a = document.getElementById('aviso-login');
    a.textContent = msg;
    a.classList.add('activo');
  }

  function labelCombustible(combustible) {
    return combustible === 'diesel' ? 'Filtro de petróleo' : 'Filtro de bencina';
  }
  function conCodigo(nombre, codigo) {
    return nombre + (codigo ? ' (' + escapeHtml(codigo) + ')' : '');
  }

  // ---------- Listas configurables (marcas y técnicos) ----------
  // Se usan en el form de vehículo (marca) y en el de mantención (técnico): un <select> con
  // las opciones guardadas + "+ Agregar nueva...", que revela un input para escribirla al toque
  // y la deja guardada en el servidor para la próxima vez, sin tener que pedir ayuda para agregarla.
  function cargarListasConfig() {
    return Promise.all([
      api('/configuracion/marcas').then(function (l) { marcasCache = l; }),
      api('/configuracion/tecnicos').then(function (l) { tecnicosCache = l; }),
    ]);
  }

  function idNueva(selectId) {
    var m = selectId.match(/^(.*?)(\d+)$/);
    return m ? m[1] + 'nueva-' + m[2] : selectId + '-nueva';
  }

  function opcionesSelect(lista, valorActual, etiquetaNueva) {
    var html = '<option value="">Selecciona...</option>';
    var yaIncluido = false;
    lista.forEach(function (it) {
      var sel = it.nombre === valorActual ? ' selected' : '';
      if (it.nombre === valorActual) yaIncluido = true;
      html += '<option value="' + escapeHtml(it.nombre) + '"' + sel + '>' + escapeHtml(it.nombre) + '</option>';
    });
    if (valorActual && !yaIncluido) {
      html += '<option value="' + escapeHtml(valorActual) + '" selected>' + escapeHtml(valorActual) + ' (no está en la lista)</option>';
    }
    html += '<option value="__nueva__">' + etiquetaNueva + '</option>';
    return html;
  }

  function ligarSelectNuevo(selectId) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(idNueva(selectId));
    if (!sel || !inp) return;
    sel.onchange = function () {
      inp.hidden = sel.value !== '__nueva__';
      if (!inp.hidden) inp.focus();
    };
  }

  // Resuelve el valor final del select: si eligieron "+ Agregar nueva...", primero la guarda
  // en el servidor (y en la cache local) y devuelve su nombre; si no, devuelve lo ya seleccionado.
  function valorFinalDeSelect(selectId, tipo) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(idNueva(selectId));
    if (sel.value === '__nueva__') {
      var nombre = (inp && inp.value ? inp.value : '').trim();
      if (!nombre) return Promise.resolve('');
      return api('/configuracion/' + tipo, { method: 'POST', body: { nombre: nombre } }).then(function (row) {
        var cache = tipo === 'marcas' ? marcasCache : tecnicosCache;
        if (!cache.some(function (it) { return it.id === row.id; })) cache.push(row);
        return row.nombre;
      });
    }
    return Promise.resolve(sel.value);
  }

  // ---------- Login ----------
  function mostrarApp(usuario) {
    usuarioActual = usuario;
    document.getElementById('pantalla-login').hidden = true;
    document.getElementById('pantalla-app').hidden = false;
    document.getElementById('usuario-nombre').textContent = usuario.nombre;
    var chip = document.getElementById('usuario-rol-chip');
    chip.textContent = usuario.rol === 'admin' ? 'Administrador' : 'Mecánico / recepción';
    document.getElementById('btn-equipo').hidden = usuario.rol !== 'admin';
    document.getElementById('btn-estadisticas').hidden = usuario.rol !== 'admin';
    document.getElementById('btn-configuracion').hidden = usuario.rol !== 'admin';
    cargarListasConfig().catch(function () {}); // si falla, los selects igual permiten "+ Agregar nueva..."
    cargarVehiculos();
    mostrarVista('vehiculos');
  }
  function mostrarLogin() {
    usuarioActual = null;
    document.getElementById('pantalla-app').hidden = true;
    document.getElementById('pantalla-login').hidden = false;
  }

  // ---------- Navegación por pestañas (páginas separadas) ----------
  var VISTAS = ['vehiculos', 'taller', 'simulador', 'equipo', 'estadisticas', 'configuracion'];
  function mostrarVista(nombre) {
    VISTAS.forEach(function (v) {
      var sec = document.getElementById('vista-' + v);
      var btn = document.getElementById('btn-' + v);
      if (sec) sec.hidden = (v !== nombre);
      if (btn) btn.classList.toggle('activo', v === nombre);
    });
// Se agrega el refresco de "vehiculos" acá (15-sep-2026): antes solo se cargaba una vez al
    // iniciar sesión, así que un auto creado desde otra pantalla (ej. agendando con patente
    // nueva directo en el calendario) no aparecía hasta buscarlo a mano o recargar la página.
    if (nombre === 'vehiculos') cargarVehiculos();
    if (nombre === 'taller') { cargarBahias(); cargarCalendarioSemana(); }
    if (nombre === 'simulador') { document.getElementById('sim-patente').focus(); }
    if (nombre === 'equipo') cargarEquipo();
    if (nombre === 'estadisticas') cargarEstadisticas();
    if (nombre === 'configuracion') cargarPanelConfiguracion();
  }
  document.getElementById('btn-vehiculos').onclick = function () { mostrarVista('vehiculos'); };
  document.getElementById('btn-taller').onclick = function () { mostrarVista('taller'); };
  document.getElementById('btn-simulador').onclick = function () { mostrarVista('simulador'); };

  function intentarLogin() {
    var correo = document.getElementById('login-correo').value.trim();
    var password = document.getElementById('login-password').value;
    if (!correo || !password) { avisarLogin('Escribe tu correo y tu contraseña.'); return; }
    api('/auth/login', { method: 'POST', body: { correo: correo, password: password } })
      .then(function (u) { mostrarApp(u); })
      .catch(function (e) { avisarLogin(e.message || 'No se pudo iniciar sesión.'); });
  }

  document.getElementById('btn-login').onclick = intentarLogin;
  document.getElementById('login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') intentarLogin(); });

  document.getElementById('btn-logout').onclick = function () {
    api('/auth/logout', { method: 'POST' }).finally(mostrarLogin);
  };

  // ---------- Vehículos ----------
  function cargarVehiculos() {
    var q = document.getElementById('buscar').value.trim();
    api('/vehiculos' + (q ? '?q=' + encodeURIComponent(q) : ''))
      .then(function (lista) { renderLista(lista); })
      .catch(function (e) { avisar(e.message || 'No se pudo cargar la lista.', true); });
  }

  document.getElementById('buscar').addEventListener('input', function () {
    clearTimeout(timerBuscar);
    timerBuscar = setTimeout(cargarVehiculos, 300);
  });

  function renderLista(vehiculos) {
    var lista = document.getElementById('lista-vehiculos');
    var vacio = document.getElementById('vacio');
    if (!vehiculos.length) {
      lista.innerHTML = '';
      vacio.hidden = false;
      return;
    }
    vacio.hidden = true;
    lista.innerHTML = vehiculos.map(renderVehiculoColapsado).join('');
    vehiculos.forEach(function (v) {
      var el = document.getElementById('vcard-' + v.id);
      el.querySelector('.vcard-top').onclick = function () { toggleVehiculo(v.id); };
    });
    if (abiertoId && detalleCache[abiertoId]) {
      var elAbierto = document.getElementById('vcard-' + abiertoId);
      if (elAbierto) elAbierto.classList.add('abierta');
      pintarDetalle(abiertoId);
    }
  }

  function renderVehiculoColapsado(v) {
    var combustibleTxt = v.combustible === 'diesel' ? 'Petróleo' : 'Bencina';
    return '<article class="vcard" id="vcard-' + v.id + '">' +
      '<div class="vcard-top">' +
        '<div class="patente-badge">' + escapeHtml(v.patente) + '</div>' +
        '<div class="vcard-info">' +
          '<div class="vcard-modelo">' + escapeHtml(v.marca) + ' ' + escapeHtml(v.modelo) + (v.anio ? ' · ' + escapeHtml(v.anio) : '') + ' · ' + combustibleTxt + '</div>' +
          '<div class="vcard-cliente">' + escapeHtml(v.cliente_nombre || '') + (v.cliente_correo ? ' · ' + escapeHtml(v.cliente_correo) : '') + '</div>' +
        '</div>' +
        '<div class="vcard-count">' + v.mantenciones_count + ' mantención' + (v.mantenciones_count === 1 ? '' : 'es') + '</div>' +
      '</div>' +
      '<div class="vcard-detalle" id="vcard-detalle-' + v.id + '"></div>' +
    '</article>';
  }

  function toggleVehiculo(id) {
    var el = document.getElementById('vcard-' + id);
    if (abiertoId === id) {
      el.classList.remove('abierta');
      abiertoId = null;
      return;
    }
    if (abiertoId) {
      var prev = document.getElementById('vcard-' + abiertoId);
      if (prev) prev.classList.remove('abierta');
    }
    abiertoId = id;
    el.classList.add('abierta');
    if (detalleCache[id]) {
      pintarDetalle(id);
    } else {
      api('/vehiculos/' + id).then(function (data) {
        detalleCache[id] = data;
        pintarDetalle(id);
      }).catch(function (e) { avisar(e.message || 'No se pudo cargar el detalle.', true); });
    }
  }

  function pintarDetalle(id) {
    var cont = document.getElementById('vcard-detalle-' + id);
    if (!cont) return;
    var data = detalleCache[id];
    var v = data.vehiculo;
    var historial = data.mantenciones.length
      ? '<ul class="historial">' + data.mantenciones.map(function (m) { return renderMant(m, v.combustible); }).join('') + '</ul>'
      : '<p class="sin-mant">Sin mantenciones registradas todavía.</p>';

    var accionesVehiculo = usuarioActual.rol === 'admin'
      ? '<div class="mant-acciones">' +
          '<button class="btn-texto" id="btn-editar-vehiculo-' + id + '" type="button">Editar datos del vehículo</button>' +
          '<button class="btn-texto" id="btn-eliminar-vehiculo-' + id + '" type="button">Eliminar vehículo</button>' +
        '</div>' +
        '<div id="form-vehiculo-editar-' + id + '" class="panel" style="margin-top:10px" hidden>' + formVehiculoEditHtml(id, v) + '</div>'
      : '';

    cont.innerHTML =
      accionesVehiculo +
      '<div class="historial-label">Historial de mantenciones</div>' +
      historial +
      '<div style="margin-top:14px">' +
        '<button class="btn btn-secundario" id="btn-toggle-mant-' + id + '" type="button">+ Registrar mantención</button>' +
      '</div>' +
      '<div id="form-mant-' + id + '" class="panel" style="margin-top:12px" hidden>' + formMantHtml(id, v.combustible) + '</div>';

    document.getElementById('btn-toggle-mant-' + id).onclick = function () { mostrarFormMant(id); };
    ligarFiltros(id);
    ligarSelectNuevo('m-tecnico-' + id);
    document.getElementById('btn-guardar-mant-' + id).onclick = function () { guardarMantencion(id); };
    document.getElementById('btn-cancelar-mant-' + id).onclick = function () { limpiarFormMant(id); document.getElementById('form-mant-' + id).hidden = true; };

    if (usuarioActual.rol === 'admin') {
      cont.querySelectorAll('.btn-editar-mant').forEach(function (b) {
        b.onclick = function () { editarMantencion(id, Number(b.getAttribute('data-m'))); };
      });
      cont.querySelectorAll('.btn-eliminar-mant').forEach(function (b) {
        b.onclick = function () { eliminarMantencion(id, Number(b.getAttribute('data-m')), b); };
      });
      document.getElementById('btn-editar-vehiculo-' + id).onclick = function () {
        var f = document.getElementById('form-vehiculo-editar-' + id);
        f.hidden = !f.hidden;
        if (!f.hidden) f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      document.getElementById('btn-guardar-vehiculo-editar-' + id).onclick = function () { guardarVehiculoEditado(id); };
      document.getElementById('btn-cancelar-vehiculo-editar-' + id).onclick = function () {
        document.getElementById('form-vehiculo-editar-' + id).hidden = true;
      };
      document.getElementById('btn-eliminar-vehiculo-' + id).onclick = function (e) { eliminarVehiculo(id, e.currentTarget); };
      ligarSelectNuevo('fv-marca-' + id);
      document.getElementById('fv-toggle-dueno-' + id).onclick = function () {
        var el = document.getElementById('fv-dueno-nuevo-' + id);
        el.hidden = !el.hidden;
      };
      document.getElementById('fv-dueno-guardar-' + id).onclick = function () { guardarCambioDueno(id); };
    }
  }

  function formVehiculoEditHtml(vId, v) {
    return (
      '<div class="grid-3">' +
        '<div class="campo"><label>Patente</label><input id="fv-patente-' + vId + '" type="text" value="' + escapeHtml(v.patente) + '" /></div>' +
        '<div class="campo"><label>Marca</label>' +
          '<select id="fv-marca-' + vId + '">' + opcionesSelect(marcasCache, v.marca || '', '+ Agregar marca nueva...') + '</select>' +
          '<input id="fv-marca-nueva-' + vId + '" type="text" placeholder="Nombre de la marca nueva" hidden style="margin-top:6px" />' +
        '</div>' +
        '<div class="campo"><label>Modelo</label><input id="fv-modelo-' + vId + '" type="text" value="' + escapeHtml(v.modelo || '') + '" /></div>' +
      '</div>' +
      '<div class="grid-3">' +
        '<div class="campo"><label>Año</label><input id="fv-anio-' + vId + '" type="text" value="' + escapeHtml(v.anio || '') + '" /></div>' +
        '<div class="campo"><label>Combustible</label><select id="fv-combustible-' + vId + '">' +
          '<option value="bencina"' + (v.combustible !== 'diesel' ? ' selected' : '') + '>Bencina</option>' +
          '<option value="diesel"' + (v.combustible === 'diesel' ? ' selected' : '') + '>Petróleo (diésel)</option>' +
        '</select></div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="campo"><label>Nombre cliente (opcional)</label><input id="fv-cliente-' + vId + '" type="text" value="' + escapeHtml(v.cliente_nombre || '') + '" /></div>' +
        '<div class="campo"><label>Correo</label><input id="fv-correo-' + vId + '" type="email" value="' + escapeHtml(v.cliente_correo || '') + '" /></div>' +
      '</div>' +
      '<p class="campo-label-suelto" style="margin-top:-4px">Estos dos campos corrigen los datos del cliente actual (ej. arreglar un correo mal tipeado). Si el auto se vendió y ahora es de otra persona, usa "Cambiar dueño" en vez de escribir aquí.</p>' +
      '<button class="btn-texto" id="fv-toggle-dueno-' + vId + '" type="button" style="margin-bottom:8px">Cambiar dueño (se vendió a otra persona)</button>' +
      '<div id="fv-dueno-nuevo-' + vId + '" hidden>' +
        '<div class="grid-2">' +
          '<div class="campo"><label>Nombre del nuevo dueño</label><input id="fv-dueno-nombre-' + vId + '" type="text" placeholder="Juan Pérez" /></div>' +
          '<div class="campo"><label>Correo del nuevo dueño</label><input id="fv-dueno-correo-' + vId + '" type="email" placeholder="juan@correo.com" /></div>' +
        '</div>' +
        '<div class="acciones-form"><button class="btn btn-secundario" id="fv-dueno-guardar-' + vId + '" type="button">Guardar nuevo dueño</button></div>' +
      '</div>' +
      '<div class="acciones-form">' +
        '<button class="btn btn-primario" id="btn-guardar-vehiculo-editar-' + vId + '" type="button">Guardar cambios</button>' +
        '<button class="btn-texto" id="btn-cancelar-vehiculo-editar-' + vId + '" type="button">Cancelar</button>' +
      '</div>'
    );
  }

  // Reasigna el dueño de un vehículo (PUT /vehiculos/:id/cliente) sin tocar nada más del auto —
  // pensado para el caso real "este auto se vendió, ahora es de otra persona" (agregado
  // 14-sep-2026). A diferencia de los campos "Nombre cliente/Correo" de arriba (que corrigen al
  // MISMO cliente si ya tenía uno), esto siempre resuelve un cliente distinto: reusa uno
  // existente si el correo ya está registrado, o crea uno nuevo.
  function guardarCambioDueno(vId) {
    var nombre = document.getElementById('fv-dueno-nombre-' + vId).value.trim();
    var correo = document.getElementById('fv-dueno-correo-' + vId).value.trim();
    if (!nombre && !correo) { avisar('Escribe el nombre o correo del nuevo dueño.', true); return; }
    api('/vehiculos/' + vId + '/cliente', { method: 'PUT', body: { clienteNombre: nombre, clienteCorreo: correo } })
      .then(function () {
        delete detalleCache[vId];
        avisar('Dueño del vehículo actualizado.');
        return api('/vehiculos/' + vId).then(function (data) { detalleCache[vId] = data; pintarDetalle(vId); return cargarVehiculos(); });
      })
      .catch(function (e) { avisar(e.message || 'No se pudo cambiar el dueño.', true); });
  }

  function guardarVehiculoEditado(vId) {
    valorFinalDeSelect('fv-marca-' + vId, 'marcas').then(function (marca) {
      var body = {
        patente: document.getElementById('fv-patente-' + vId).value.trim().toUpperCase(),
        marca: marca,
        modelo: document.getElementById('fv-modelo-' + vId).value.trim(),
        anio: document.getElementById('fv-anio-' + vId).value.trim(),
        combustible: document.getElementById('fv-combustible-' + vId).value,
        clienteNombre: document.getElementById('fv-cliente-' + vId).value.trim(),
        clienteCorreo: document.getElementById('fv-correo-' + vId).value.trim(),
      };
      return api('/vehiculos/' + vId, { method: 'PUT', body: body }).then(function () {
        delete detalleCache[vId];
        avisar('Vehículo actualizado.');
        return api('/vehiculos/' + vId).then(function (data) { detalleCache[vId] = data; pintarDetalle(vId); return cargarVehiculos(); });
      });
    }).catch(function (e) { avisar(e.message || 'No se pudo actualizar el vehículo.', true); });
  }

  function eliminarVehiculo(vId, btn) {
    if (btn.getAttribute('data-confirmar') !== '1') {
      btn.setAttribute('data-confirmar', '1');
      btn.textContent = '¿Seguro? Se borra todo su historial. Sí, eliminar';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.removeAttribute('data-confirmar'); btn.textContent = 'Eliminar vehículo'; }, 4000);
      return;
    }
    api('/vehiculos/' + vId, { method: 'DELETE' }).then(function () {
      delete detalleCache[vId];
      if (abiertoId === vId) abiertoId = null;
      avisar('Vehículo eliminado.');
      cargarVehiculos();
    }).catch(function (e) { avisar(e.message || 'No se pudo eliminar el vehículo.', true); });
  }

  function renderMant(m, combustible) {
    var repuestos = [];
    if (m.filtro_aire) repuestos.push(conCodigo('Filtro aire', m.filtro_aire_codigo));
    if (m.filtro_polen) repuestos.push(conCodigo('Filtro polen', m.filtro_polen_codigo));
    if (m.filtro_aceite) repuestos.push(conCodigo('Filtro aceite', m.filtro_aceite_codigo));
    if (m.filtro_combustible) repuestos.push(conCodigo(labelCombustible(combustible), m.filtro_combustible_codigo));
    if (m.aceite) repuestos.push('Aceite ' + escapeHtml(m.aceite) + (m.litros ? ' (' + escapeHtml(m.litros) + ')' : ''));

    var linea1 = fechaBonita(m.fecha) + (repuestos.length ? ' — ' + repuestos.join(', ') : '');
    var linea2 = [];
    if (m.motor) linea2.push('Motor: ' + escapeHtml(m.motor));
    if (m.km) linea2.push(Number(m.km).toLocaleString('es-CL') + ' km');
    if (m.tecnico) linea2.push('Técnico: ' + escapeHtml(m.tecnico));
    if (m.costo) linea2.push('$' + Number(m.costo).toLocaleString('es-CL'));
    linea2.push('Registrado por ' + escapeHtml(m.creado_por_nombre || '—') + ' el ' + fechaHoraBonita(m.creado_en));
    if (m.editado_en) linea2.push('Editado por ' + escapeHtml(m.editado_por_nombre || '—') + ' el ' + fechaHoraBonita(m.editado_en));

    var acciones = usuarioActual.rol === 'admin'
      ? '<div class="mant-acciones">' +
          '<button class="btn-texto btn-editar-mant" type="button" data-m="' + m.id + '">Editar</button>' +
          '<button class="btn-texto btn-eliminar-mant" type="button" data-m="' + m.id + '">Eliminar</button>' +
        '</div>'
      : '';

    return '<li class="mant" id="mant-' + m.id + '">' +
      '<div class="mant-linea1">' + linea1 + '</div>' +
      '<div class="mant-linea2">' + linea2.join(' · ') + '</div>' +
      (m.notas ? '<div class="mant-linea2">' + escapeHtml(m.notas) + '</div>' : '') +
      acciones +
    '</li>';
  }

  function formMantHtml(vId, combustible) {
    var filas = FILTROS.map(function (f) {
      var etiqueta = f.etiqueta || labelCombustible(combustible);
      return '<div class="filtro-row">' +
        '<label class="check-item"><input type="checkbox" class="chk-filtro" data-cod="' + f.cod + '-' + vId + '" id="' + f.chk + '-' + vId + '" /> ' + etiqueta + '</label>' +
        '<input type="text" class="input-codigo" id="' + f.cod + '-' + vId + '" placeholder="Código" disabled />' +
      '</div>';
    }).join('');
    return (
      '<div class="grid-3">' +
        '<div class="campo"><label>Fecha</label><input id="m-fecha-' + vId + '" type="date" /></div>' +
        '<div class="campo"><label>Kilometraje</label><input id="m-km-' + vId + '" type="number" placeholder="45000" inputmode="numeric" /></div>' +
        '<div class="campo"><label>Técnico responsable</label>' +
          '<select id="m-tecnico-' + vId + '">' + opcionesSelect(tecnicosCache, '', '+ Agregar técnico nuevo...') + '</select>' +
          '<input id="m-tecnico-nueva-' + vId + '" type="text" placeholder="Nombre del técnico nuevo" hidden style="margin-top:6px" />' +
        '</div>' +
      '</div>' +
      '<p class="campo-label-suelto">Repuestos cambiados</p>' +
      '<div class="check-grid">' + filas + '</div>' +
      '<div class="grid-3">' +
        '<div class="campo"><label>Motor</label><input id="m-motor-' + vId + '" type="text" placeholder="1.4T" /></div>' +
        '<div class="campo"><label>Aceite utilizado</label><input id="m-aceite-' + vId + '" type="text" placeholder="5W-30 sintético" /></div>' +
        '<div class="campo"><label>Litros de aceite</label><input id="m-litros-' + vId + '" type="text" placeholder="4 Lt" /></div>' +
      '</div>' +
      '<div class="campo"><label>Costo (CLP, opcional)</label><input id="m-costo-' + vId + '" type="number" placeholder="35000" inputmode="numeric" /></div>' +
      '<div class="campo"><label>Otro trabajo / notas (opcional)</label><input id="m-notas-' + vId + '" type="text" placeholder="Ej: se revisaron pastillas de freno, sin cambio" /></div>' +
      '<div class="acciones-form">' +
        '<button class="btn btn-primario" id="btn-guardar-mant-' + vId + '" type="button">Guardar mantención</button>' +
        '<button class="btn-texto" id="btn-cancelar-mant-' + vId + '" type="button">Cancelar</button>' +
      '</div>'
    );
  }

  function ligarFiltros(vId) {
    FILTROS.forEach(function (f) {
      var chk = document.getElementById(f.chk + '-' + vId);
      var cod = document.getElementById(f.cod + '-' + vId);
      if (!chk || !cod) return;
      chk.onchange = function () {
        cod.disabled = !chk.checked;
        if (chk.checked) cod.focus(); else cod.value = '';
      };
    });
  }

  function limpiarFormMant(vId) {
    var form = document.getElementById('form-mant-' + vId);
    if (!form) return;
    form.removeAttribute('data-editando');
    ['m-fecha-', 'm-km-', 'm-costo-', 'm-motor-', 'm-aceite-', 'm-litros-', 'm-notas-'].forEach(function (pref) {
      var el = document.getElementById(pref + vId);
      if (el) el.value = '';
    });
    var selTec = document.getElementById('m-tecnico-' + vId);
    if (selTec) selTec.innerHTML = opcionesSelect(tecnicosCache, '', '+ Agregar técnico nuevo...');
    var inpTecNueva = document.getElementById('m-tecnico-nueva-' + vId);
    if (inpTecNueva) { inpTecNueva.value = ''; inpTecNueva.hidden = true; }
    FILTROS.forEach(function (f) {
      var chk = document.getElementById(f.chk + '-' + vId);
      var cod = document.getElementById(f.cod + '-' + vId);
      if (chk) chk.checked = false;
      if (cod) { cod.value = ''; cod.disabled = true; }
    });
    var btn = document.getElementById('btn-guardar-mant-' + vId);
    if (btn) btn.textContent = 'Guardar mantención';
  }

  function mostrarFormMant(vId) {
    limpiarFormMant(vId);
    var f = document.getElementById('form-mant-' + vId);
    f.hidden = false;
    var d = new Date();
    document.getElementById('m-fecha-' + vId).value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function leerFormMant(vId) {
    var b = {
      fecha: document.getElementById('m-fecha-' + vId).value,
      km: document.getElementById('m-km-' + vId).value.trim(),
      costo: document.getElementById('m-costo-' + vId).value.trim(),
      motor: document.getElementById('m-motor-' + vId).value.trim(),
      aceite: document.getElementById('m-aceite-' + vId).value.trim(),
      litros: document.getElementById('m-litros-' + vId).value.trim(),
      notas: document.getElementById('m-notas-' + vId).value.trim(),
    };
    FILTROS.forEach(function (f) {
      b[f.campo] = document.getElementById(f.chk + '-' + vId).checked;
      b[f.campoCod] = document.getElementById(f.cod + '-' + vId).value.trim();
    });
    return b;
  }

  function guardarMantencion(vId) {
    var form = document.getElementById('form-mant-' + vId);
    var editandoAttr = form.getAttribute('data-editando');
    valorFinalDeSelect('m-tecnico-' + vId, 'tecnicos').then(function (tecnico) {
      var body = leerFormMant(vId);
      body.tecnico = tecnico;
      var promesa = editandoAttr !== null
        ? api('/mantenciones/' + editandoAttr, { method: 'PUT', body: body })
        : api('/vehiculos/' + vId + '/mantenciones', { method: 'POST', body: body });

      return promesa.then(function () {
        delete detalleCache[vId];
        avisar(editandoAttr !== null ? 'Mantención corregida.' : 'Mantención guardada.');
        return api('/vehiculos/' + vId).then(function (data) { detalleCache[vId] = data; pintarDetalle(vId); return cargarVehiculos(); });
      });
    }).catch(function (e) {
      avisar(e.message || 'No se pudo guardar.', true);
    });
  }

  function editarMantencion(vId, mId) {
    var data = detalleCache[vId];
    var m = data.mantenciones.find(function (x) { return x.id === mId; });
    if (!m) return;
    mostrarFormMant(vId);
    var form = document.getElementById('form-mant-' + vId);
    form.setAttribute('data-editando', mId);
    document.getElementById('m-fecha-' + vId).value = m.fecha ? String(m.fecha).slice(0, 10) : '';
    document.getElementById('m-km-' + vId).value = m.km || '';
    document.getElementById('m-tecnico-' + vId).innerHTML = opcionesSelect(tecnicosCache, m.tecnico || '', '+ Agregar técnico nuevo...');
    document.getElementById('m-tecnico-nueva-' + vId).hidden = true;
    document.getElementById('m-costo-' + vId).value = m.costo || '';
    document.getElementById('m-motor-' + vId).value = m.motor || '';
    document.getElementById('m-aceite-' + vId).value = m.aceite || '';
    document.getElementById('m-litros-' + vId).value = m.litros || '';
    document.getElementById('m-notas-' + vId).value = m.notas || '';
    var mapaCampos = { filtroAire: 'filtro_aire', filtroPolen: 'filtro_polen', filtroAceite: 'filtro_aceite', filtroCombustible: 'filtro_combustible' };
    var mapaCodigos = { filtroAireCodigo: 'filtro_aire_codigo', filtroPolenCodigo: 'filtro_polen_codigo', filtroAceiteCodigo: 'filtro_aceite_codigo', filtroCombustibleCodigo: 'filtro_combustible_codigo' };
    FILTROS.forEach(function (f) {
      var marcado = !!m[mapaCampos[f.campo]];
      document.getElementById(f.chk + '-' + vId).checked = marcado;
      var cod = document.getElementById(f.cod + '-' + vId);
      cod.disabled = !marcado;
      cod.value = marcado ? (m[mapaCodigos[f.campoCod]] || '') : '';
    });
    document.getElementById('btn-guardar-mant-' + vId).textContent = 'Guardar cambios';
  }

  function eliminarMantencion(vId, mId, btn) {
    if (btn.getAttribute('data-confirmar') !== '1') {
      btn.setAttribute('data-confirmar', '1');
      btn.textContent = '¿Seguro? Sí, eliminar';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.removeAttribute('data-confirmar'); btn.textContent = 'Eliminar'; }, 3000);
      return;
    }
    api('/mantenciones/' + mId, { method: 'DELETE' }).then(function () {
      delete detalleCache[vId];
      avisar('Mantención eliminada.');
      return api('/vehiculos/' + vId).then(function (data) { detalleCache[vId] = data; pintarDetalle(vId); return cargarVehiculos(); });
    }).catch(function (e) { avisar(e.message || 'No se pudo eliminar.', true); });
  }

  // ---------- Nuevo vehículo ----------
  function resetSelectMarcaNueva() {
    document.getElementById('f-marca').innerHTML = opcionesSelect(marcasCache, '', '+ Agregar marca nueva...');
    document.getElementById('f-marca-nueva').hidden = true;
    document.getElementById('f-marca-nueva').value = '';
  }
  ligarSelectNuevo('f-marca');
  document.getElementById('btn-nuevo-vehiculo').onclick = function () {
    resetSelectMarcaNueva();
    document.getElementById('form-vehiculo-wrap').hidden = false;
    document.getElementById('f-patente').focus();
  };
  document.getElementById('btn-cancelar-vehiculo').onclick = ocultarFormVehiculo;
  function ocultarFormVehiculo() {
    document.getElementById('form-vehiculo-wrap').hidden = true;
    ['f-patente', 'f-modelo', 'f-anio', 'f-cliente', 'f-correo'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    resetSelectMarcaNueva();
    document.getElementById('f-combustible').value = 'bencina';
  }
  document.getElementById('btn-guardar-vehiculo').onclick = function () {
    valorFinalDeSelect('f-marca', 'marcas').then(function (marca) {
      var body = {
        patente: document.getElementById('f-patente').value.trim().toUpperCase(),
        marca: marca,
        modelo: document.getElementById('f-modelo').value.trim(),
        anio: document.getElementById('f-anio').value.trim(),
        combustible: document.getElementById('f-combustible').value,
        clienteNombre: document.getElementById('f-cliente').value.trim(),
        clienteCorreo: document.getElementById('f-correo').value.trim(),
      };
      return api('/vehiculos', { method: 'POST', body: body }).then(function (v) {
        ocultarFormVehiculo();
        avisar('Vehículo ' + v.patente + ' guardado.');
        cargarVehiculos();
      });
    }).catch(function (e) { avisar(e.message || 'No se pudo guardar el vehículo.', true); });
  };

  // ---------- Agenda del taller (bahías: elevadores + patio) ----------
  var timerBahiaPatente = {};

  function cargarBahias() {
    var cont = document.getElementById('grid-bahias');
    api('/bahias').then(function (lista) {
      cont.innerHTML = lista.map(renderBahiaCard).join('');
      lista.forEach(function (b) { ligarAccionesBahia(b); });
      // Las tarjetas recién se acaban de recrear (nuevos <select> vacíos) — si las citas
      // pendientes ya estaban cargadas de antes, hay que rellenarlas de nuevo ahora que los
      // elementos existen en el DOM (si todavía no habían cargado, cargarCitasPendientes()
      // de abajo las va a rellenar apenas lleguen).
      actualizarSelectoresPendientes();
    }).catch(function (e) {
      cont.innerHTML = '<p class="sin-mant">' + escapeHtml(e.message || 'No se pudo cargar la agenda del taller.') + '</p>';
    });
    cargarCitasPendientes();
  }

  // ---------- Citas pendientes de elevador (agendadas por Andy, sin bahía todavía) ----------
  // Ya no se muestran como una lista aparte (sobraba: cada tarjeta de elevador/patio
  // disponible ya tiene su propio selector "Entrar una cita pendiente de hoy") — esta función
  // solo mantiene el cache que alimenta esos selectores.
  var citasPendientesCache = [];

  function cargarCitasPendientes() {
    api('/citas/pendientes').then(function (lista) {
      citasPendientesCache = lista;
      actualizarSelectoresPendientes();
    }).catch(function () {
      citasPendientesCache = [];
    });
  }

  // Rellena el selector "Entrar una cita pendiente de hoy" dentro de cada tarjeta de elevador
  // disponible que ya esté en el DOM, con la lista de citas pendientes recién cargada.
  function actualizarSelectoresPendientes() {
    document.querySelectorAll('select[id^="bahia-pendiente-"]').forEach(function (sel) {
      var valorPrevio = sel.value;
      if (!citasPendientesCache.length) {
        sel.innerHTML = '<option value="">No hay citas pendientes</option>';
        return;
      }
      sel.innerHTML = '<option value="">Elegir cita pendiente...</option>' + citasPendientesCache.map(function (c) {
        var etiqueta = horaCorta(c.hora_inicio) + ' — ' + c.patente + ' ' + (c.marca || '') + ' ' + (c.modelo || '');
        if (c.bahia_sugerida) etiqueta += ' (sugerido: ' + c.bahia_sugerida + ')';
        return '<option value="' + c.id + '">' + escapeHtml(etiqueta.trim()) + '</option>';
      }).join('');
      if (valorPrevio && citasPendientesCache.some(function (c) { return String(c.id) === valorPrevio; })) {
        sel.value = valorPrevio;
      }
    });
  }

  function ingresarCitaPendiente(bId) {
    var sel = document.getElementById('bahia-pendiente-' + bId);
    var citaId = sel ? sel.value : '';
    if (!citaId) { avisar('Elige qué cita pendiente va a entrar.', true); return; }
    api('/citas/' + citaId + '/ingresar', { method: 'POST', body: { bahia_id: bId } })
      .then(function () {
        avisar('Auto ingresado.');
        cargarBahias();
        cargarCalendarioSemana();
      })
      .catch(function (e) { avisar(e.message || 'No se pudo ingresar el vehículo.', true); });
  }

  function renderBahiaCard(b) {
    var ocupada = !!b.vehiculo_id;
    var tipoTxt = b.tipo === 'patio' ? 'Patio de espera' : 'Elevador';
    var header =
      '<div class="bahia-header">' +
        '<div><span class="bahia-nombre">' + escapeHtml(b.nombre) + '</span><br><span class="bahia-tipo">' + tipoTxt + '</span></div>' +
        '<span class="bahia-estado-chip' + (ocupada ? ' ocupada' : '') + '">' + (ocupada ? 'Ocupada' : 'Disponible') + '</span>' +
      '</div>';

    if (!ocupada) {
      return '<div class="bahia-card" id="bahia-' + b.id + '">' + header +
        '<p class="bahia-disponible-txt">Sin auto asignado.</p>' +
        '<div class="bahia-pendiente-wrap">' +
          '<div class="campo"><label for="bahia-pendiente-' + b.id + '">Entrar una cita pendiente de hoy</label>' +
            '<select id="bahia-pendiente-' + b.id + '"><option value="">Cargando...</option></select>' +
          '</div>' +
          '<div class="acciones-form"><button class="btn btn-primario" id="bahia-ingresar-' + b.id + '" type="button">Ingresar al ' + (b.tipo === 'patio' ? 'patio' : 'elevador') + '</button></div>' +
        '</div>' +
        '<p class="bahia-o-separador">— o asigna un auto directo, sin cita previa —</p>' +
        '<div class="campo"><label for="bahia-patente-' + b.id + '">Patente</label>' +
          '<input id="bahia-patente-' + b.id + '" list="bahia-dl-' + b.id + '" type="text" placeholder="AB1234" style="text-transform:uppercase" />' +
          '<datalist id="bahia-dl-' + b.id + '"></datalist>' +
        '</div>' +
        '<div class="campo"><label for="bahia-nota-nueva-' + b.id + '">Nota (opcional)</label>' +
          '<input id="bahia-nota-nueva-' + b.id + '" type="text" placeholder="Qué se le va a hacer" />' +
        '</div>' +
        '<div class="acciones-form"><button class="btn btn-secundario" id="bahia-asignar-' + b.id + '" type="button">Asignar</button></div>' +
      '</div>';
    }

    var autoLinea = escapeHtml(b.marca || '') + ' ' + escapeHtml(b.modelo || '') + (b.anio ? ' · ' + escapeHtml(b.anio) : '');
    var notaHtml = b.nota
      ? '<div class="bahia-nota">' + escapeHtml(b.nota) + '</div>'
      : '<div class="bahia-nota vacia">Sin nota — no se especificó qué se le está haciendo.</div>';
    var atrasadoHtml = b.atrasado
      ? '<span class="bahia-estado-chip atrasado-chip">⚠️ Atraso / problema</span>' : '';

    return '<div class="bahia-card ocupada' + (b.atrasado ? ' atrasado' : '') + '" id="bahia-' + b.id + '">' + header +
      '<div class="patente-badge">' + escapeHtml(b.patente) + '</div>' +
      atrasadoHtml +
      '<div class="bahia-auto">' + autoLinea + '</div>' +
      (b.cliente_nombre ? '<div class="bahia-cliente">' + escapeHtml(b.cliente_nombre) + '</div>' : '') +
      '<div class="bahia-desde">Desde ' + horaDeTimestamp(b.ingresado_en) + '</div>' +
      notaHtml +
      '<div class="acciones-form">' +
        '<button class="btn-texto" id="bahia-detalle-' + b.id + '" type="button">Ver detalle y comentarios</button>' +
        '<button class="btn btn-secundario" id="bahia-liberar-' + b.id + '" type="button">Liberar</button>' +
      '</div>' +
    '</div>';
  }

  function ligarAccionesBahia(b) {
    if (!b.vehiculo_id) {
      var inp = document.getElementById('bahia-patente-' + b.id);
      inp.addEventListener('input', function () {
        clearTimeout(timerBahiaPatente[b.id]);
        timerBahiaPatente[b.id] = setTimeout(function () { llenarDatalistBahia(b.id, inp.value.trim()); }, 300);
      });
      document.getElementById('bahia-asignar-' + b.id).onclick = function () { asignarBahia(b.id); };
      document.getElementById('bahia-ingresar-' + b.id).onclick = function () { ingresarCitaPendiente(b.id); };
      return;
    }
    document.getElementById('bahia-liberar-' + b.id).onclick = function (e) { liberarBahia(b.id, e.currentTarget); };
    document.getElementById('bahia-detalle-' + b.id).onclick = function () {
      abrirModalCita('editar', {
        id: b.cita_id,
        bahia_id: b.id,
        bahia_nombre: b.nombre,
        ingresado_en: b.ingresado_en,
        hora_inicio: b.hora_inicio,
        hora_fin: b.hora_fin,
        nota: b.nota,
        atrasado: b.atrasado,
        patente: b.patente,
        marca: b.marca,
        modelo: b.modelo,
        cliente_nombre: b.cliente_nombre,
        fecha: b.fecha,
      });
    };
  }

  function llenarDatalistBahia(bId, q) {
    var dl = document.getElementById('bahia-dl-' + bId);
    if (!dl || !q) { if (dl) dl.innerHTML = ''; return; }
    api('/vehiculos?q=' + encodeURIComponent(q)).then(function (lista) {
      dl.innerHTML = lista.slice(0, 12).map(function (v) {
        var etiqueta = (v.marca || '') + ' ' + (v.modelo || '') + (v.cliente_nombre ? ' — ' + v.cliente_nombre : '');
        return '<option value="' + escapeHtml(v.patente) + '">' + escapeHtml(etiqueta.trim()) + '</option>';
      }).join('');
    }).catch(function () {});
  }

  function asignarBahia(bId) {
    var patente = document.getElementById('bahia-patente-' + bId).value.trim().toUpperCase();
    var nota = document.getElementById('bahia-nota-nueva-' + bId).value.trim();
    if (!patente) { avisar('Escribe la patente del vehículo.', true); return; }
    // Asignar "ahora" crea una cita de hoy sin hora de término — por eso, apenas se asigna,
    // ya aparece también en el calendario de más abajo (misma tabla, misma fuente de verdad).
    api('/bahias/' + bId + '/asignar', { method: 'POST', body: { patente: patente, nota: nota } })
      .then(function () { avisar('Auto asignado.'); cargarBahias(); cargarCalendarioSemana(); })
      .catch(function (e) { avisar(e.message || 'No se pudo asignar el vehículo.', true); });
  }

  function liberarBahia(bId, btn) {
    if (btn.getAttribute('data-confirmar') !== '1') {
      btn.setAttribute('data-confirmar', '1');
      btn.textContent = '¿Seguro? Sí, liberar';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.removeAttribute('data-confirmar'); btn.textContent = 'Liberar'; }, 3000);
      return;
    }
    // Liberar le pone hora de término a la cita en curso (no la borra) — queda en el
    // calendario de hoy como un bloque ya terminado.
    api('/bahias/' + bId + '/liberar', { method: 'POST' })
      .then(function () { avisar('Bahía liberada.'); cargarBahias(); cargarCalendarioSemana(); })
      .catch(function (e) { avisar(e.message || 'No se pudo liberar la bahía.', true); });
  }

  // ---------- Calendario de mantenciones futuras por bahía ----------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function lunesDeSemana(d) {
    var c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dow = c.getDay(); // 0=domingo..6=sábado
    var diff = (dow === 0) ? -6 : (1 - dow); // la semana empieza el lunes
    c.setDate(c.getDate() + diff);
    return c;
  }
  function horaCorta(h) {
    if (!h) return '';
    return String(h).slice(0, 5);
  }

  var calSemanaInicio = lunesDeSemana(new Date());
  var timerCitaPatente = null;
  var citaModoActual = 'nueva';
  // Si la cita actualmente abierta en el modal ya fue ingresada físicamente a una bahía — se
  // usa para decidir si "Terminar y generar informe" tiene que liberar esa bahía o no. No basta
  // con mirar si hay un bahia_id elegido: desde el 28-oct-2026 ese campo puede ser solo una
  // SUGERENCIA de Andy en una cita que todavía no entra a ningún lado.
  var citaActualIngresada = false;
  var calCitasCache = [];

  function cargarCalendarioSemana() {
    var lunes = calSemanaInicio;
    var domingo = new Date(lunes); domingo.setDate(lunes.getDate() + 6);
    var desde = ymd(lunes), hasta = ymd(domingo);
    document.getElementById('cal-rango-txt').textContent = fechaBonita(desde) + ' al ' + fechaBonita(hasta);

    var cont = document.getElementById('grid-calendario');
    Promise.all([api('/bahias'), api('/citas?desde=' + desde + '&hasta=' + hasta)]).then(function (r) {
      var bahiasList = r[0], citas = r[1];
      calCitasCache = citas;
      var hoyKey = ymd(new Date());
      var diasCorto = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
      var dias = [];
      for (var i = 0; i < 7; i++) {
        var d = new Date(lunes); d.setDate(lunes.getDate() + i);
        dias.push({ key: ymd(d), label: diasCorto[i], num: pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1), hoy: ymd(d) === hoyKey });
      }
      var porBahiaDia = {};
      citas.forEach(function (c) {
        var fkey = String(c.fecha).slice(0, 10);
        var k = c.bahia_id + '|' + fkey;
        (porBahiaDia[k] = porBahiaDia[k] || []).push(c);
      });

      var html = '<div class="cal-esquina"></div>';
      dias.forEach(function (d) {
        html += '<div class="cal-dia-header' + (d.hoy ? ' hoy' : '') + '">' + d.label +
          '<span class="cal-dia-num">' + d.num + '</span></div>';
      });

      bahiasList.forEach(function (b) {
        html += '<div class="cal-bahia-label">' + escapeHtml(b.nombre) + '</div>';
        dias.forEach(function (d) {
          var lista = porBahiaDia[b.id + '|' + d.key] || [];
          var chips = lista.map(function (c) {
            var notaPrev = c.nota ? escapeHtml(c.nota) : '';
            return '<button type="button" class="cita-chip' + (c.atrasado ? ' atrasado' : '') + (c.no_show ? ' no-show' : '') + '" data-cita-id="' + c.id + '">' +
              (c.atrasado ? '⚠️ ' : '') + (c.no_show ? '🚫 ' : '') +
              '<span class="cita-hora">' + horaCorta(c.hora_inicio) + (c.hora_fin ? '–' + horaCorta(c.hora_fin) : '') + '</span>' +
              '<span class="cita-patente">' + escapeHtml(c.patente) + '</span>' +
              (notaPrev ? '<span class="cita-nota-prev">' + notaPrev + '</span>' : '') +
              '</button>';
          }).join('');
          html += '<div class="cal-celda' + (d.hoy ? ' hoy-col' : '') + '">' +
            chips +
            '<button type="button" class="btn-cal-agregar" data-fecha="' + d.key + '" data-bahia-id="' + b.id + '" data-bahia-nombre="' + escapeHtml(b.nombre) + '">+ Agendar</button>' +
          '</div>';
        });
      });

      cont.innerHTML = html;
      cont.querySelectorAll('.cita-chip').forEach(function (btn) {
        btn.onclick = function () {
          var c = calCitasCache.find(function (x) { return String(x.id) === btn.getAttribute('data-cita-id'); });
          if (c) abrirModalCita('editar', c);
        };
      });
      cont.querySelectorAll('.btn-cal-agregar').forEach(function (btn) {
        btn.onclick = function () {
          // La bahía de esta columna queda como SUGERENCIA (igual que agendar con elevador
          // elegido siempre funcionó) — así la cita aparece de inmediato en esta misma columna
          // del calendario, donde se puede editar/cancelar. El ingreso real a la bahía sigue
          // siendo siempre una acción manual del mecánico, nunca automático por esto.
          abrirModalCita('nueva', {
            bahia_id: btn.getAttribute('data-bahia-id'),
            bahia_nombre: btn.getAttribute('data-bahia-nombre'),
            fecha: btn.getAttribute('data-fecha'),
          });
        };
      });
    }).catch(function (e) {
      cont.innerHTML = '<p class="sin-mant">' + escapeHtml(e.message || 'No se pudo cargar el calendario.') + '</p>';
    });
  }

  document.getElementById('cal-semana-ant').onclick = function () {
    calSemanaInicio.setDate(calSemanaInicio.getDate() - 7);
    cargarCalendarioSemana();
  };
  document.getElementById('cal-semana-sig').onclick = function () {
    calSemanaInicio.setDate(calSemanaInicio.getDate() + 7);
    cargarCalendarioSemana();
  };
  document.getElementById('cal-semana-hoy').onclick = function () {
    calSemanaInicio = lunesDeSemana(new Date());
    cargarCalendarioSemana();
  };

  // ---------- Estado del auto en el taller (frenos/discos + checklist de tareas) ----------
  var tallerEstado = null; // estado de la cita actualmente abierta en el modal, o null
  var tallerVehiculo = null; // datos del vehículo/cliente de esa cita, para el informe impreso

  var TAREAS_CATALOGO = [
    'Mantención de aceite', 'Filtro de aceite', 'Filtro de aire', 'Filtro de polen', 'Filtro de combustible',
    'Frenos',
    'Alineación', 'Balanceo',
    'Cambio neumáticos', 'Rotación de neumáticos',
    'Recarga A/C', 'Bujías',
    'Aceite caja', 'Aceite diferencial',
    'Scanner', 'Simulador de camino', 'Revisión tren delantero', 'Revisión tren trasero',
    'Otro',
  ];
  var TAREAS_DIAGNOSTICO = ['Simulador de camino', 'Revisión tren delantero', 'Revisión tren trasero'];
  function requiereDiagnostico(nombre) { return TAREAS_DIAGNOSTICO.indexOf(nombre) !== -1; }

  function labelPastillaPct(pct) {
    if (pct === '' || pct === null || pct === undefined) return 'Sin registrar';
    pct = Number(pct);
    if (pct >= 20) return 'Muy buen estado';
    return 'Cambiar ahora';
  }
  function claseChipPct(pct) {
    if (pct === '' || pct === null || pct === undefined) return '';
    pct = Number(pct);
    if (pct >= 20) return '';
    return 'chip-problema';
  }
  function rcmDePct(pct) {
    if (pct === '' || pct === null || pct === undefined) return '';
    pct = Number(pct);
    if (pct >= 20) return 'M';
    return 'C';
  }

  function renderBloqueFreno(inputId, pctId, labelId, titulo, valor, bloqueado, labelOverride, campo) {
    var val = (valor === '' || valor === null || valor === undefined) ? 100 : Number(valor);
    var labelTxt = bloqueado ? 'Bloqueado por defecto' : (labelOverride || labelPastillaPct(valor));
    return '<div class="freno-bloque">' +
      '<div class="freno-header"><span>' + escapeHtml(titulo) + '</span><span class="freno-pct" id="' + pctId + '">' + (bloqueado ? '—' : (val + '%')) + '</span></div>' +
      '<input type="range" min="0" max="100" step="10" id="' + inputId + '" value="' + val + '"' + (bloqueado ? ' disabled' : '') +
        ' data-pct-id="' + pctId + '" data-label-id="' + labelId + '" data-campo="' + campo + '" class="freno-slider" />' +
      '<p class="freno-label" id="' + labelId + '">' + escapeHtml(labelTxt) + '</p>' +
    '</div>';
  }
  function renderBotonRectificar(lado, activo) {
    return '<button type="button" class="btn-texto disco-rectificar-btn' + (activo ? ' disco-rectificar-activo' : '') + '" data-toggle-rectificar="' + lado + '">' +
      (activo ? '✓ Se rectifica (no se cambia)' : 'Rectificar en vez de cambiar') + '</button>';
  }

  function renderFrenosTaller() {
    var frenosSolicitados = (tallerEstado.tareas || []).some(function (t) { return t.nombre === 'Frenos'; });
    if (!frenosSolicitados) return '';
    var esTambor = tallerEstado.pastillasTraTipo === 'tambor';
    var nombreTrasero = esTambor ? 'Balatas traseras' : 'Pastillas traseras';
    // El segundo bloque trasero es "Discos traseros" con pastillas, o "Tambor trasero" con
    // balatas — en ambos casos se puede poner el % de vida útil normalmente (29-oct-2026,
    // corregido a pedido del usuario: antes, elegir "Balatas/tambor" bloqueaba por defecto el
    // % de ambos campos traseros y había que desbloquearlo aparte — ahora siempre se puede).
    var nombreDiscoTambor = esTambor ? 'Tambor trasero' : 'Discos traseros';
    var html = '<p class="campo-label-suelto">Estado de frenos</p>';
    html += renderBloqueFreno('taller-pastillas-del', 'taller-del-pct', 'taller-del-label', 'Pastillas delanteras', tallerEstado.pastillasDel, false, '', 'pastillasDel');
    html += renderBloqueFreno('taller-discos-del', 'taller-disco-del-pct', 'taller-disco-del-label', 'Discos delanteros', tallerEstado.discosDel, false, tallerEstado.discosDelRectificar ? 'Se rectifica (no se cambia)' : '', 'discosDel');
    html += renderBotonRectificar('del', tallerEstado.discosDelRectificar);
    html += '<p class="campo-label-suelto" style="margin-top:12px">Tipo de freno trasero</p>' +
      '<div class="toggle-grupo">' +
        '<button type="button" class="toggle-opt' + (!esTambor ? ' activo' : '') + '" data-tipo-tra="pastillas">Pastillas traseras</button>' +
        '<button type="button" class="toggle-opt' + (esTambor ? ' activo' : '') + '" data-tipo-tra="tambor">Balatas / tambor</button>' +
      '</div>';
    html += renderBloqueFreno('taller-pastillas-tra', 'taller-tra-pct', 'taller-tra-label', nombreTrasero, tallerEstado.pastillasTra, false, '', 'pastillasTra');
    html += renderBloqueFreno('taller-discos-tra', 'taller-disco-tra-pct', 'taller-disco-tra-label', nombreDiscoTambor, tallerEstado.discosTra, false, tallerEstado.discosTraRectificar ? 'Se rectifica (no se cambia)' : '', 'discosTra');
    html += renderBotonRectificar('tra', tallerEstado.discosTraRectificar);
    return html;
  }

  function renderTareasChipsTaller() {
    return TAREAS_CATALOGO.map(function (t) {
      var activa = (tallerEstado.tareas || []).some(function (x) { return x.nombre === t; });
      return '<button type="button" class="chip-tarea' + (activa ? ' chip-tarea-activo' : '') + '" data-agregar-tarea="' + escapeHtml(t) + '">' + (activa ? '✓ ' : '+ ') + escapeHtml(t) + '</button>';
    }).join('');
  }

  function renderTareaItemTaller(t, tIdx) {
    var necesitaDiag = requiereDiagnostico(t.nombre);
    var faltaDiag = necesitaDiag && !t.diagnostico;
    var bloque =
      '<div class="tarea-item">' +
        '<div class="tarea-nombre">' + escapeHtml(t.nombre) + (faltaDiag ? ' <span class="tarea-alerta">⚠ falta diagnóstico</span>' : '') + '</div>' +
        '<div class="tarea-acciones">' +
          '<button type="button" class="tarea-estado-btn' + (t.estado === 'realizado' ? ' tarea-estado-realizado' : '') + '" data-toggle-tarea-estado="1" data-tarea-idx="' + tIdx + '">' + (t.estado === 'realizado' ? '✓ Realizado' : 'Pendiente') + '</button>' +
          '<button type="button" class="tarea-vis-btn" data-toggle-tarea-vis="1" data-tarea-idx="' + tIdx + '">' + (t.visibilidad === 'cliente' ? 'Visible cliente' : 'Interno') + '</button>' +
          '<button type="button" class="btn-texto" data-eliminar-tarea="1" data-tarea-idx="' + tIdx + '">✕</button>' +
        '</div>' +
      '</div>';
    if (necesitaDiag) {
      var fotos = t.fotos || [];
      var miniaturas = fotos.map(function (src, fIdx) {
        return '<div class="foto-mini"><img src="' + src + '" alt="Foto ' + (fIdx + 1) + '" />' +
          '<button type="button" class="foto-mini-eliminar" data-eliminar-foto="1" data-tarea-idx="' + tIdx + '" data-foto-idx="' + fIdx + '">✕</button></div>';
      }).join('');
      bloque += '<div class="tarea-diagnostico">' +
        '<label>Diagnóstico de ' + escapeHtml(t.nombre) + '</label>' +
        '<textarea rows="2" placeholder="Qué se encontró y qué se recomienda..." data-diagnostico="1" data-tarea-idx="' + tIdx + '">' + escapeHtml(t.diagnostico || '') + '</textarea>' +
        '<label style="margin-top:8px">Fotos de lo que hay que cambiar (opcional)</label>' +
        '<div class="fotos-grid">' + miniaturas +
          '<label class="foto-agregar-btn">+ Agregar foto<input type="file" accept="image/*" multiple data-foto-input="1" data-tarea-idx="' + tIdx + '" hidden /></label>' +
        '</div>' +
      '</div>';
    }
    return bloque;
  }

  function renderTareasListaTaller() {
    var tareas = tallerEstado.tareas || [];
    if (!tareas.length) return '<p class="sin-mant">No se solicitó ninguna tarea al recibir este vehículo.</p>';
    return tareas.map(renderTareaItemTaller).join('');
  }

  function renderTallerEstado() {
    document.getElementById('taller-km').value = tallerEstado.kilometraje || '';
    document.getElementById('taller-tareas-chips').innerHTML = renderTareasChipsTaller();
    document.getElementById('taller-frenos-wrap').innerHTML = renderFrenosTaller();
    document.getElementById('taller-tareas-lista').innerHTML = renderTareasListaTaller();
    document.getElementById('taller-estado-general').value = tallerEstado.estadoGeneral || '';
    document.getElementById('taller-nota-estado').value = tallerEstado.notaEstado || '';
    ligarEventosTaller();
  }

  function ligarEventosTaller() {
    document.querySelectorAll('#taller-tareas-chips [data-agregar-tarea]').forEach(function (b) {
      b.onclick = function () {
        var nombre = b.getAttribute('data-agregar-tarea');
        tallerEstado.tareas = tallerEstado.tareas || [];
        var existe = tallerEstado.tareas.some(function (t) { return t.nombre === nombre; });
        if (!existe) {
          tallerEstado.tareas.push({ nombre: nombre, estado: 'pendiente', visibilidad: 'interno', diagnostico: '', fotos: [] });
          guardarEstadoTaller(true);
        }
      };
    });
    document.querySelectorAll('#taller-frenos-wrap .freno-slider').forEach(function (el) {
      el.oninput = function () {
        var pctEl = document.getElementById(el.getAttribute('data-pct-id'));
        var labelEl = document.getElementById(el.getAttribute('data-label-id'));
        if (pctEl) pctEl.textContent = el.value + '%';
        if (labelEl) labelEl.textContent = labelPastillaPct(el.value);
      };
      el.onchange = function () {
        var campo = el.getAttribute('data-campo');
        if (campo) tallerEstado[campo] = el.value;
        guardarEstadoTaller(false);
      };
    });
    document.querySelectorAll('#taller-frenos-wrap [data-tipo-tra]').forEach(function (b) {
      b.onclick = function () {
        tallerEstado.pastillasTraTipo = b.getAttribute('data-tipo-tra');
        guardarEstadoTaller(true);
      };
    });
    document.querySelectorAll('#taller-frenos-wrap [data-toggle-rectificar]').forEach(function (b) {
      b.onclick = function () {
        var lado = b.getAttribute('data-toggle-rectificar');
        if (lado === 'del') tallerEstado.discosDelRectificar = !tallerEstado.discosDelRectificar;
        else tallerEstado.discosTraRectificar = !tallerEstado.discosTraRectificar;
        guardarEstadoTaller(true);
      };
    });
    document.querySelectorAll('#taller-tareas-lista [data-toggle-tarea-estado]').forEach(function (b) {
      b.onclick = function () {
        var t = tallerEstado.tareas[Number(b.getAttribute('data-tarea-idx'))];
        if (!t) return;
        t.estado = (t.estado === 'realizado') ? 'pendiente' : 'realizado';
        guardarEstadoTaller(true);
      };
    });
    document.querySelectorAll('#taller-tareas-lista [data-toggle-tarea-vis]').forEach(function (b) {
      b.onclick = function () {
        var t = tallerEstado.tareas[Number(b.getAttribute('data-tarea-idx'))];
        if (!t) return;
        t.visibilidad = (t.visibilidad === 'cliente') ? 'interno' : 'cliente';
        guardarEstadoTaller(true);
      };
    });
    document.querySelectorAll('#taller-tareas-lista [data-eliminar-tarea]').forEach(function (b) {
      b.onclick = function () {
        tallerEstado.tareas.splice(Number(b.getAttribute('data-tarea-idx')), 1);
        guardarEstadoTaller(true);
      };
    });
    document.querySelectorAll('#taller-tareas-lista textarea[data-diagnostico]').forEach(function (el) {
      el.onblur = function () {
        var t = tallerEstado.tareas[Number(el.getAttribute('data-tarea-idx'))];
        if (!t) return;
        t.diagnostico = el.value.trim();
        guardarEstadoTaller(false);
      };
    });
    document.querySelectorAll('#taller-tareas-lista input[data-foto-input]').forEach(function (el) {
      el.onchange = function () {
        var tIdx = Number(el.getAttribute('data-tarea-idx'));
        var archivos = Array.prototype.slice.call(el.files || []);
        if (!archivos.length) return;
        Promise.all(archivos.map(function (archivo) {
          return new Promise(function (resolve) {
            var lector = new FileReader();
            lector.onload = function () { resolve(lector.result); };
            lector.onerror = function () { resolve(null); };
            lector.readAsDataURL(archivo);
          });
        })).then(function (resultados) {
          var t = tallerEstado.tareas[tIdx];
          if (!t) return;
          t.fotos = t.fotos || [];
          resultados.forEach(function (src) { if (src) t.fotos.push(src); });
          guardarEstadoTaller(true);
        });
      };
    });
    document.querySelectorAll('#taller-tareas-lista [data-eliminar-foto]').forEach(function (b) {
      b.onclick = function () {
        var t = tallerEstado.tareas[Number(b.getAttribute('data-tarea-idx'))];
        if (!t || !t.fotos) return;
        t.fotos.splice(Number(b.getAttribute('data-foto-idx')), 1);
        guardarEstadoTaller(true);
      };
    });
  }

  function guardarEstadoTaller(reRender) {
    if (!tallerEstado || !tallerEstado.citaId) return;
    tallerEstado.kilometraje = document.getElementById('taller-km').value.trim();
    tallerEstado.estadoGeneral = document.getElementById('taller-estado-general').value;
    tallerEstado.notaEstado = document.getElementById('taller-nota-estado').value.trim();
    var body = {
      kilometraje: tallerEstado.kilometraje,
      pastillasDel: tallerEstado.pastillasDel,
      pastillasTra: tallerEstado.pastillasTra,
      discosDel: tallerEstado.discosDel,
      discosTra: tallerEstado.discosTra,
      pastillasTraTipo: tallerEstado.pastillasTraTipo,
      pastillasTraBloqueada: tallerEstado.pastillasTraBloqueada,
      discosDelRectificar: tallerEstado.discosDelRectificar,
      discosTraRectificar: tallerEstado.discosTraRectificar,
      estadoGeneral: tallerEstado.estadoGeneral,
      notaEstado: tallerEstado.notaEstado,
      tareas: tallerEstado.tareas || [],
    };
    api('/citas/' + tallerEstado.citaId + '/estado-taller', { method: 'PATCH', body: body })
      .then(function () { if (reRender) renderTallerEstado(); })
      .catch(function (e) { avisar(e.message || 'No se pudo guardar el estado del auto.', true); });
  }

  function cargarEstadoTaller(citaId) {
    tallerEstado = null;
    tallerVehiculo = null;
    api('/citas/' + citaId).then(function (c) {
      tallerEstado = {
        citaId: c.id,
        kilometraje: c.kilometraje || '',
        pastillasDel: c.pastillas_del || '',
        pastillasTra: c.pastillas_tra || '',
        discosDel: c.discos_del || '',
        discosTra: c.discos_tra || '',
        pastillasTraTipo: c.pastillas_tra_tipo || 'pastillas',
        pastillasTraBloqueada: !!c.pastillas_tra_bloqueada,
        discosDelRectificar: !!c.discos_del_rectificar,
        discosTraRectificar: !!c.discos_tra_rectificar,
        estadoGeneral: c.estado_general || '',
        notaEstado: c.nota_estado || '',
        tareas: Array.isArray(c.tareas) ? c.tareas : [],
      };
      tallerVehiculo = {
        patente: c.patente, marca: c.marca, modelo: c.modelo, anio: c.anio,
        combustible: c.combustible, clienteNombre: c.cliente_nombre,
      };
      renderTallerEstado();
    }).catch(function (e) {
      avisar(e.message || 'No se pudo cargar el estado del auto.', true);
    });
  }

  function fechaInformeHoy() {
    var d = new Date();
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function construirInformeHtmlTaller(b, v) {
    var logoEl = document.getElementById('logo-header');
    var logoSrc = logoEl ? logoEl.src : '';
    var nombreCliente = v ? (v.clienteNombre || '—') : '—';
    var marca = v ? v.marca : '';
    var modelo = v ? v.modelo : '';
    var anio = v ? v.anio : '';
    var combustible = v ? (v.combustible === 'diesel' ? 'Petróleo (diésel)' : 'Bencina') : '';
    var km = b.kilometraje || '—';
    var nombreTrasero = b.pastillasTraTipo === 'tambor' ? 'Balatas de freno traseras' : 'Pastillas de freno traseras';
    var nombreDiscosTrasero = b.pastillasTraTipo === 'tambor' ? 'Discos/tambores traseros' : 'Discos de freno traseros';

    var PALABRA_RCM = { C: 'Cambiar', M: 'Mantener' };
    function filaFreno(nombre, pct, bloqueada, rectificar) {
      var estadoTxt;
      if (bloqueada) estadoTxt = '—';
      else if (rectificar) estadoTxt = 'Rectificar';
      else estadoTxt = PALABRA_RCM[rcmDePct(pct)] || '—';
      var pctTxt = bloqueada ? '—' : ((pct === '' || pct === null || pct === undefined) ? '—' : (pct + '%'));
      return '<tr><td>' + escapeHtml(nombre) + '</td><td class="celda-pct">' + pctTxt + '</td><td class="celda-estado-freno">' + escapeHtml(estadoTxt) + '</td></tr>';
    }
    var hayFrenos = (b.tareas || []).some(function (t) { return t.nombre === 'Frenos'; });
    var filasFrenos = !hayFrenos ? '' :
      filaFreno('Pastillas de freno delanteras', b.pastillasDel, false) +
      filaFreno('Discos de freno delanteros', b.discosDel, false, b.discosDelRectificar) +
      filaFreno(nombreTrasero, b.pastillasTra, false) +
      filaFreno(nombreDiscosTrasero, b.discosTra, false, b.discosTraRectificar);

    var filasTareas = (b.tareas || []).map(function (t) {
      var estadoTxt = (t.estado === 'realizado' ? 'Realizado' : 'Pendiente') + (t.visibilidad === 'cliente' ? ' · Visible al cliente' : '');
      var diagTxt = t.diagnostico ? ' — ' + escapeHtml(t.diagnostico) : '';
      return '<tr><td>' + escapeHtml(t.nombre) + '</td><td colspan="3" style="text-align:left;padding-left:10px;">' + escapeHtml(estadoTxt) + diagTxt + '</td></tr>';
    }).join('');

    var observaciones = [];
    if (hayFrenos) {
      if (b.pastillasDel !== '') observaciones.push('Pastillas de freno delanteras en ' + b.pastillasDel + '% de vida útil restante (' + labelPastillaPct(b.pastillasDel).toLowerCase() + ').');
      if (b.discosDel !== '') observaciones.push(b.discosDelRectificar
        ? 'Discos de freno delanteros en ' + b.discosDel + '% — se rectifican (rebarbado) en vez de cambiarlos.'
        : 'Discos de freno delanteros en ' + b.discosDel + '% de vida útil restante (' + labelPastillaPct(b.discosDel).toLowerCase() + ').');
      if (b.pastillasTra !== '') observaciones.push(nombreTrasero + ' en ' + b.pastillasTra + '% de vida útil restante (' + labelPastillaPct(b.pastillasTra).toLowerCase() + ').');
      if (b.discosTra !== '') observaciones.push(b.discosTraRectificar
        ? nombreDiscosTrasero + ' en ' + b.discosTra + '% — se rectifican (rebarbado) en vez de cambiarlos.'
        : nombreDiscosTrasero + ' en ' + b.discosTra + '% de vida útil restante (' + labelPastillaPct(b.discosTra).toLowerCase() + ').');
    }
    (b.tareas || []).forEach(function (t) {
      if (t.nombre === 'Frenos' && !t.diagnostico) return;
      var linea = t.nombre === 'Frenos' ? t.diagnostico : (t.nombre + ': ' + (t.estado === 'realizado' ? 'realizado.' : 'pendiente.'));
      if (t.nombre !== 'Frenos' && t.diagnostico) linea += ' Diagnóstico: ' + t.diagnostico;
      observaciones.push(linea);
    });
    if (b.notaEstado) observaciones.push(b.notaEstado);
    if (!observaciones.length) observaciones.push('Sin observaciones.');
    var liObs = observaciones.map(function (o) { return '<li>' + escapeHtml(o) + '</li>'; }).join('');

    return '<!doctype html><html><head><meta charset="utf-8"><title>Informe ' + escapeHtml(v ? v.patente : '') + '</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#141413;margin:40px;font-size:13px;}' +
      'h1{font-size:22px;margin:0 0 4px;}' +
      '.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;gap:20px;}' +
      '.marca-taller{text-align:right;font-size:12px;line-height:1.5;white-space:nowrap;}' +
      '.marca-taller img{height:46px;margin-bottom:6px;}' +
      '.marca-taller strong{font-size:14px;display:block;}' +
      '.datos-cliente{margin-bottom:14px;font-size:13px;}' +
      'table{border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px;}' +
      'td,th{border:1px solid #333;padding:5px 8px;}' +
      '.celda-pct{text-align:center;width:70px;font-weight:700;}' +
      '.celda-estado-freno{text-align:center;width:110px;font-weight:700;}' +
      '.obs-box{border:1px solid #333;padding:12px 16px;}' +
      '.obs-box h3{margin:0 0 8px;font-size:13px;}' +
      '.obs-box ol{margin:0;padding-left:20px;}' +
      '.acciones-no-print{margin-top:24px;}' +
      '.acciones-no-print button{font-family:inherit;font-size:14px;padding:10px 18px;border-radius:8px;border:none;cursor:pointer;background:#D9642E;color:#fff;}' +
      '@media print{ .acciones-no-print{display:none;} }' +
    '</style></head><body>' +
      '<div class="top">' +
        '<div><h1>INFORME DEL ESTADO DEL VEHÍCULO</h1></div>' +
        '<div class="marca-taller">' +
          (logoSrc ? '<img src="' + logoSrc + '" alt="Nácar">' : '') +
          '<strong>NACAR AUTOMOTRIZ</strong>' +
          'Camino San Alberto Hurtado 1630, Padre Hurtado<br>+56 9 8183 6269<br>tallernacarautomotriz.cl' +
        '</div>' +
      '</div>' +
      '<div class="datos-cliente"><strong>NOMBRE:</strong> ' + escapeHtml(nombreCliente) + ' &nbsp;&nbsp; <strong>FECHA:</strong> ' + fechaInformeHoy() + '</div>' +
      '<table>' +
        '<tr><td><strong>MARCA:</strong> ' + escapeHtml(marca) + '</td><td><strong>MODELO:</strong> ' + escapeHtml(modelo) + '</td><td><strong>AÑO:</strong> ' + escapeHtml(anio) + '</td></tr>' +
        '<tr><td><strong>COMBUSTIBLE:</strong> ' + escapeHtml(combustible) + '</td><td><strong>PATENTE:</strong> ' + escapeHtml(v ? v.patente : '') + '</td><td><strong>KILOMETRAJE:</strong> ' + escapeHtml(km) + '</td></tr>' +
      '</table>' +
      (hayFrenos ? '<table><tr><th>FRENOS</th><th>% VIDA ÚTIL</th><th>ESTADO</th></tr>' + filasFrenos + '</table>' : '') +
      (filasTareas ? '<table><tr><th>TRABAJOS SOLICITADOS</th><th colspan="3">ESTADO</th></tr>' + filasTareas + '</table>' : '') +
      '<div class="obs-box"><h3>OBSERVACIONES</h3><ol>' + liObs + '</ol></div>' +
      '<div class="acciones-no-print"><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>' +
    '</body></html>';
  }

  document.getElementById('taller-guardar').onclick = function () {
    guardarEstadoTaller(true);
    avisar('Estado del auto guardado.');
  };
  document.getElementById('taller-km').addEventListener('blur', function () { guardarEstadoTaller(false); });
  document.getElementById('taller-estado-general').addEventListener('change', function () { guardarEstadoTaller(false); });
  document.getElementById('taller-nota-estado').addEventListener('blur', function () { guardarEstadoTaller(false); });
  document.getElementById('taller-generar-informe').onclick = function () {
    if (!tallerEstado || !tallerVehiculo) return;
    guardarEstadoTaller(false);
    var bahiaId = document.getElementById('cita-bahia-id').value;
    var html = construirInformeHtmlTaller(tallerEstado, tallerVehiculo);
    var ventana = window.open('', '_blank');
    if (!ventana) { avisar('El navegador bloqueó la ventana del informe — permite ventanas emergentes para generarlo.', true); return; }
    ventana.document.open();
    ventana.document.write(html);
    ventana.document.close();
    // Solo hay bahía que liberar si el auto llegó a entrar físicamente de verdad — un bahia_id
    // "sugerido" en una cita que nunca se ingresó no ocupa nada.
    if (!bahiaId || !citaActualIngresada) {
      cerrarModalCita();
      cargarCitasPendientes();
      cargarCalendarioSemana();
      avisar('Informe generado.');
      return;
    }
    api('/bahias/' + bahiaId + '/liberar', { method: 'POST' }).then(function () {
      cerrarModalCita();
      cargarBahias();
      cargarCalendarioSemana();
      avisar('Informe generado — la bahía queda disponible.');
    }).catch(function (e) { avisar(e.message || 'No se pudo liberar la bahía.', true); });
  };

  function abrirModalCita(modo, datos) {
    citaModoActual = modo;
    var modal = document.getElementById('modal-cita');
    var btnGuardarCita = document.getElementById('cita-guardar');
    btnGuardarCita.disabled = false;
    btnGuardarCita.textContent = 'Guardar';
    document.getElementById('cita-id').value = modo === 'editar' ? datos.id : '';
    document.getElementById('cita-bahia-id').value = datos.bahia_id || '';
    citaActualIngresada = modo === 'editar' && !!datos.ingresado_en;
    document.getElementById('cita-bahia-nombre').value = datos.ingresado_en
      ? (datos.bahia_nombre || '') + ' — ya ingresado'
      : (datos.bahia_id ? 'Sugerido: ' + (datos.bahia_nombre || '') : 'Pendiente (sin elevador asignado)');
    document.getElementById('modal-cita-titulo').textContent = modo === 'editar' ? 'Editar cita' : 'Nueva cita';

    var campoPatente = document.getElementById('cita-campo-patente');
    var vehiculoTxt = document.getElementById('cita-vehiculo-txt');
    var btnEliminar = document.getElementById('cita-eliminar');
    var btnNoLlego = document.getElementById('cita-no-llego');
    var chatWrap = document.getElementById('cita-chat-wrap');
    var chatHint = document.getElementById('cita-chat-hint');
    var toggleNuevo = document.getElementById('cita-toggle-nuevo');
    var bloqueNuevo = document.getElementById('cita-vehiculo-nuevo');
    var tallerWrap = document.getElementById('taller-estado-wrap');
    var tallerHint = document.getElementById('taller-estado-hint');

    if (modo === 'nueva') {
      campoPatente.hidden = false;
      document.getElementById('cita-patente').value = '';
      document.getElementById('cita-dl-patente').innerHTML = '';
      vehiculoTxt.hidden = true;
      btnEliminar.hidden = true;
      btnNoLlego.hidden = true;
      chatWrap.hidden = true;
      chatHint.hidden = false;
      tallerWrap.hidden = true;
      tallerHint.hidden = false;
      tallerEstado = null;
      tallerVehiculo = null;
      document.getElementById('cita-fecha').value = datos.fecha || '';
      document.getElementById('cita-hora-inicio').value = '';
      document.getElementById('cita-hora-fin').value = '';
      document.getElementById('cita-nota').value = '';
      toggleNuevo.hidden = false;
      bloqueNuevo.hidden = true;
      document.getElementById('cita-nv-marca').innerHTML = opcionesSelect(marcasCache, '', '+ Agregar marca nueva...');
      ligarSelectNuevo('cita-nv-marca');
      document.getElementById('cita-nv-modelo').value = '';
      document.getElementById('cita-nv-anio').value = '';
      document.getElementById('cita-nv-combustible').value = 'bencina';
      document.getElementById('cita-nv-motor').value = '';
      document.getElementById('cita-nv-cliente').value = '';
      document.getElementById('cita-nv-correo').value = '';
    } else {
      toggleNuevo.hidden = true;
      bloqueNuevo.hidden = true;
      campoPatente.hidden = true;
      vehiculoTxt.hidden = false;
      var autoLinea = escapeHtml(datos.patente) + ' — ' + escapeHtml(datos.marca || '') + ' ' +
        escapeHtml(datos.modelo || '') + (datos.cliente_nombre ? ' · ' + escapeHtml(datos.cliente_nombre) : '');
      vehiculoTxt.innerHTML = autoLinea;
      btnEliminar.hidden = false;
      btnEliminar.removeAttribute('data-confirmar');
      btnEliminar.textContent = 'Cancelar cita';
      // "Cliente no llegó" solo tiene sentido mientras el auto todavía no entró físicamente.
      btnNoLlego.hidden = !!datos.ingresado_en;
      btnNoLlego.removeAttribute('data-confirmar');
      btnNoLlego.textContent = 'Cliente no llegó';
      document.getElementById('cita-fecha').value = String(datos.fecha).slice(0, 10);
      document.getElementById('cita-hora-inicio').value = horaCorta(datos.hora_inicio);
      document.getElementById('cita-hora-fin').value = horaCorta(datos.hora_fin);
      document.getElementById('cita-nota').value = datos.nota || '';
      chatHint.hidden = true;
      chatWrap.hidden = false;
      document.getElementById('cita-chat-mensaje').value = '';
      document.getElementById('cita-chat-atrasado').checked = false;
      cargarComentariosCita(datos.id);
      // "Estado del auto" (frenos, checklist, fotos) solo tiene sentido cuando el auto ya
      // entró físicamente al elevador/patio — en la agenda (lo que arma Andy) solo se dice a
      // qué viene, el mecánico recién completa el estado una vez que el auto está ahí.
      if (datos.ingresado_en) {
        tallerHint.hidden = true;
        tallerWrap.hidden = false;
        cargarEstadoTaller(datos.id);
      } else {
        tallerWrap.hidden = true;
        tallerHint.hidden = false;
        tallerEstado = null;
        tallerVehiculo = null;
      }
    }
    modal.hidden = false;
  }

  // ---------- Chat de comentarios de la cita (avisos, atrasos, problemas) ----------
  function cargarComentariosCita(citaId) {
    var cont = document.getElementById('cita-chat-lista');
    cont.innerHTML = '<p class="sin-mant">Cargando...</p>';
    api('/citas/' + citaId + '/comentarios').then(function (lista) {
      if (!lista.length) {
        cont.innerHTML = '<p class="cita-chat-vacio">Todavía no hay comentarios para este auto.</p>';
        return;
      }
      cont.innerHTML = lista.map(renderComentarioChat).join('');
      cont.scrollTop = cont.scrollHeight;
    }).catch(function () {
      cont.innerHTML = '<p class="cita-chat-vacio">No se pudieron cargar los comentarios.</p>';
    });
  }

  function renderComentarioChat(c) {
    return '<div class="cita-chat-msg' + (c.atrasado ? ' atrasado' : '') + '">' +
      '<span class="cita-chat-autor">' + (c.atrasado ? '⚠️ ' : '') + escapeHtml(c.autor_nombre) +
        '<span class="cita-chat-hora">' + fechaHoraBonita(c.creado_en) + '</span></span>' +
      '<p class="cita-chat-texto">' + escapeHtml(c.mensaje) + '</p>' +
    '</div>';
  }

  document.getElementById('cita-chat-enviar').onclick = function () {
    var citaId = document.getElementById('cita-id').value;
    var mensaje = document.getElementById('cita-chat-mensaje').value.trim();
    var atrasado = document.getElementById('cita-chat-atrasado').checked;
    if (!citaId) return;
    if (!mensaje) { avisar('Escribe un mensaje antes de enviar.', true); return; }
    api('/citas/' + citaId + '/comentarios', { method: 'POST', body: { mensaje: mensaje, atrasado: atrasado } })
      .then(function () {
        document.getElementById('cita-chat-mensaje').value = '';
        document.getElementById('cita-chat-atrasado').checked = false;
        cargarComentariosCita(citaId);
        // el estado de atraso de la cita pudo haber cambiado: refrescar tarjetas y calendario.
        cargarBahias();
        cargarCalendarioSemana();
      })
      .catch(function (e) { avisar(e.message || 'No se pudo enviar el comentario.', true); });
  };
  document.getElementById('cita-chat-mensaje').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cita-chat-enviar').click(); }
  });

  function cerrarModalCita() {
    document.getElementById('modal-cita').hidden = true;
  }

  document.getElementById('cita-cerrar').onclick = cerrarModalCita;
  document.getElementById('modal-cita').addEventListener('click', function (e) {
    if (e.target === this) cerrarModalCita();
  });

  // Al revelar el bloque de "patente nueva" (a mano, o automático tras el primer intento
  // fallido), intentamos reconocer el auto igual que lo hace el Simulador: primero en la base
  // del taller (si ya existiera, esto ni se llegaría a mostrar) y si no, en el registro
  // nacional de vehículos (GetAPI, si está contratado) — así no hay que escribir a mano
  // marca/modelo/año/combustible cuando la patente SÍ se puede identificar sola. Si no se puede
  // (patente muy nueva, GetAPI no configurado, o falla la consulta), no pasa nada: se completa
  // a mano como ya funcionaba, sin bloquear ni avisar de un error (agregado 15-sep-2026, a
  // pedido del usuario: "cuando pongo una patente nueva no se carga qué auto es").
  function intentarAutocompletarVehiculoNuevo(patente) {
    if (!patente) return;
    api('/vehiculos/buscar/' + encodeURIComponent(patente)).then(function (v) {
      if (v._origen !== 'api_nacional') return; // ya estaba en la base -> no debería pasar por aquí
      if (v.marca) {
        document.getElementById('cita-nv-marca').innerHTML = opcionesSelect(marcasCache, v.marca, '+ Agregar marca nueva...');
        ligarSelectNuevo('cita-nv-marca');
        document.getElementById('cita-nv-marca-nueva').hidden = true;
      }
      var modeloEl = document.getElementById('cita-nv-modelo');
      if (v.modelo && !modeloEl.value) modeloEl.value = v.modelo;
      var anioEl = document.getElementById('cita-nv-anio');
      if (v.anio && !anioEl.value) anioEl.value = v.anio;
      if (v.combustible) document.getElementById('cita-nv-combustible').value = v.combustible;
      var motorEl = document.getElementById('cita-nv-motor');
      if (v.motor && !motorEl.value) motorEl.value = v.motor;
      avisar('Auto identificado en el registro nacional — se completó marca/modelo solo. Revisa y corrige si algo no calza, y completa el cliente.');
    }).catch(function () {
      // No se pudo identificar sola (ni en la base ni en el registro nacional, o GetAPI no
      // está configurado) — se sigue completando a mano, tal como ya funcionaba antes.
    });
  }

  document.getElementById('cita-toggle-nuevo').onclick = function () {
    var bloque = document.getElementById('cita-vehiculo-nuevo');
    var seEstaMostrando = bloque.hidden; // antes de togglear
    bloque.hidden = !bloque.hidden;
    if (seEstaMostrando) {
      intentarAutocompletarVehiculoNuevo(document.getElementById('cita-patente').value.trim().toUpperCase());
    }
  };

  document.getElementById('cita-patente').addEventListener('input', function () {
    var inp = this;
    clearTimeout(timerCitaPatente);
    timerCitaPatente = setTimeout(function () { llenarDatalistCita(inp.value.trim()); }, 300);
  });

  function llenarDatalistCita(q) {
    var dl = document.getElementById('cita-dl-patente');
    if (!q) { dl.innerHTML = ''; return; }
    api('/vehiculos?q=' + encodeURIComponent(q)).then(function (lista) {
      dl.innerHTML = lista.slice(0, 12).map(function (v) {
        var etiqueta = (v.marca || '') + ' ' + (v.modelo || '') + (v.cliente_nombre ? ' — ' + v.cliente_nombre : '');
        return '<option value="' + escapeHtml(v.patente) + '">' + escapeHtml(etiqueta.trim()) + '</option>';
      }).join('');
    }).catch(function () {});
  }

  document.getElementById('cita-guardar').onclick = function () {
    var bahiaId = Number(document.getElementById('cita-bahia-id').value);
    var fecha = document.getElementById('cita-fecha').value;
    var horaInicio = document.getElementById('cita-hora-inicio').value;
    var horaFin = document.getElementById('cita-hora-fin').value;
    var nota = document.getElementById('cita-nota').value.trim();

    if (!fecha) { avisar('Escoge la fecha.', true); return; }
    if (!horaInicio) { avisar('Escoge la hora de inicio.', true); return; }

    // Mientras se guarda (puede tardar unos segundos si hay que mandar el correo de aviso), el
    // botón se deshabilita y avisa "Guardando..." — así nunca se ve "pegado" sin ninguna señal,
    // aunque la respuesta se demore lo que dura el intento de envío del correo.
    var btnGuardar = document.getElementById('cita-guardar');
    var textoOriginalBtn = btnGuardar.textContent;
    function terminarGuardado() {
      btnGuardar.disabled = false;
      btnGuardar.textContent = textoOriginalBtn;
    }
    btnGuardar.disabled = true;
    btnGuardar.textContent = 'Guardando...';

    if (citaModoActual === 'nueva') {
      var patente = document.getElementById('cita-patente').value.trim().toUpperCase();
      if (!patente) { avisar('Escribe la patente del vehículo.', true); terminarGuardado(); return; }
      var bloqueNuevo = document.getElementById('cita-vehiculo-nuevo');
      var incluyeDatosNuevos = !bloqueNuevo.hidden;

      var promesaBody = incluyeDatosNuevos
        ? valorFinalDeSelect('cita-nv-marca', 'marcas').then(function (marca) {
            return {
              bahia_id: bahiaId, patente: patente, fecha: fecha, hora_inicio: horaInicio, hora_fin: horaFin, nota: nota,
              marca: marca,
              modelo: document.getElementById('cita-nv-modelo').value.trim(),
              anio: document.getElementById('cita-nv-anio').value.trim(),
              combustible: document.getElementById('cita-nv-combustible').value,
              motor: document.getElementById('cita-nv-motor').value.trim(),
              clienteNombre: document.getElementById('cita-nv-cliente').value.trim(),
              clienteCorreo: document.getElementById('cita-nv-correo').value.trim(),
            };
          })
        : Promise.resolve({ bahia_id: bahiaId, patente: patente, fecha: fecha, hora_inicio: horaInicio, hora_fin: horaFin, nota: nota });

      promesaBody.then(function (body) {
        return api('/citas', { method: 'POST', body: body });
      }).then(function (r) {
        var msg = 'Cita agendada.';
        // Antes, si el correo no se enviaba, simplemente no se decía nada — el backend ya
        // manda un "motivo" (ej. "No se pudo determinar el correo del cliente.") pero se
        // descartaba en silencio. Ahora se muestra siempre, para que quede claro por qué no
        // llegó el aviso al cliente (agregado 15-sep-2026, a pedido del usuario).
        if (r && r.correo) {
          msg += r.correo.enviado
            ? ' Se le envió un correo al cliente avisándole.'
            : ' ' + (r.correo.motivo || 'No se pudo enviar el correo al cliente.');
        }
        avisar(msg);
        cerrarModalCita();
        cargarCalendarioSemana();
        cargarCitasPendientes();
      }).catch(function (e) {
        var mensajeError = e.message || 'No se pudo agendar la cita.';
        avisar(mensajeError, true);
        // Si el vehículo no estaba registrado y todavía no se mostraba el bloque para
        // completarlo, lo revelamos automáticamente para que el usuario no se quede perdido.
        if (!incluyeDatosNuevos && /no está registrada todavía/.test(mensajeError)) {
          bloqueNuevo.hidden = false;
          intentarAutocompletarVehiculoNuevo(patente);
        }
      }).then(terminarGuardado, terminarGuardado);
    } else {
      var id = document.getElementById('cita-id').value;
      api('/citas/' + id, {
        method: 'PUT',
        body: { bahia_id: bahiaId, fecha: fecha, hora_inicio: horaInicio, hora_fin: horaFin, nota: nota },
      })
        .then(function () { avisar('Cita actualizada.'); cerrarModalCita(); cargarBahias(); cargarCalendarioSemana(); })
        .catch(function (e) { avisar(e.message || 'No se pudo actualizar la cita.', true); })
        .then(terminarGuardado, terminarGuardado);
    }
  };

  document.getElementById('cita-eliminar').onclick = function (e) {
    var btn = e.currentTarget;
    if (btn.getAttribute('data-confirmar') !== '1') {
      btn.setAttribute('data-confirmar', '1');
      btn.textContent = '¿Seguro? Sí, cancelar cita';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.removeAttribute('data-confirmar'); btn.textContent = 'Cancelar cita'; }, 3000);
      return;
    }
    var id = document.getElementById('cita-id').value;
    api('/citas/' + id, { method: 'DELETE' })
      .then(function () { avisar('Cita cancelada.'); cerrarModalCita(); cargarBahias(); cargarCalendarioSemana(); })
      .catch(function (e2) { avisar(e2.message || 'No se pudo cancelar la cita.', true); });
  };

  document.getElementById('cita-no-llego').onclick = function (e) {
    var btn = e.currentTarget;
    if (btn.getAttribute('data-confirmar') !== '1') {
      btn.setAttribute('data-confirmar', '1');
      btn.textContent = '¿Seguro? Sí, no llegó';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.removeAttribute('data-confirmar'); btn.textContent = 'Cliente no llegó'; }, 3000);
      return;
    }
    var id = document.getElementById('cita-id').value;
    api('/citas/' + id + '/no-show', { method: 'POST' })
      .then(function () {
        avisar('Marcado: el cliente no llegó.');
        cerrarModalCita();
        cargarBahias();
        cargarCalendarioSemana();
      })
      .catch(function (e2) { avisar(e2.message || 'No se pudo marcar.', true); });
  };

  // ---------- Simulador de mantención ----------
  // Paso 1 (lo que se construyó ahora): reconocer un auto por su patente. Si ya está en la
  // base del taller, se identifica al instante (marca/modelo/año/combustible/motor). Si no,
  // todavía no hay una fuente GRATUITA para identificar cualquier patente de Chile — se le
  // explica eso al usuario y se le ofrece completarlo a mano una sola vez, quedando guardado
  // para la próxima. El plan de mantención sugerido (paso 2) se construye después de esto.

  function buscarSimulador() {
    var patente = document.getElementById('sim-patente').value.trim().toUpperCase();
    var cont = document.getElementById('sim-resultado');
    if (!patente) { avisar('Escribe una patente para identificar.', true); return; }
    cont.innerHTML = '<p class="sin-mant">Buscando...</p>';
    api('/vehiculos/buscar/' + encodeURIComponent(patente))
      .then(function (v) { renderSimEncontrado(v); })
      .catch(function (e) {
        if (e.status === 404) {
          var consultoNacional = !!(e.data && e.data.consultoRegistroNacional);
          renderSimNoEncontrado(patente, consultoNacional);
          return;
        }
        cont.innerHTML = '<p class="sin-mant">' + escapeHtml(e.message || 'No se pudo buscar la patente.') + '</p>';
      });
  }
  document.getElementById('btn-sim-buscar').onclick = buscarSimulador;
  document.getElementById('sim-patente').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); buscarSimulador(); }
  });

  // Filtros sugeridos (agregado 11-sep-2026): junto con reconocer el auto, el Simulador
  // muestra qué filtro de aceite/aire/polen/combustible le corresponde, según DOS fuentes que
  // se muestran una junto a la otra sin elegir una por sobre la otra (así lo pidió el usuario):
  //   - "Nuestra experiencia": qué código le hemos puesto nosotros a autos parecidos antes
  //     (agrupado por marca+modelo+motor si hay datos así, o marca+modelo si no).
  //   - "Catálogo Mann Filter": lo que dice el catálogo del fabricante. Si el catálogo tiene más
  //     de un código posible para ese modelo (motorizaciones distintas que se parecen), se
  //     muestran TODOS con su motor/año de referencia — nunca se adivina uno solo cuando hay
  //     ambigüedad real, así el mecánico compara y elige.
  var FILTROS_SUGERIDOS_TIPOS = [
    { key: 'aceite', label: 'Filtro de aceite' },
    { key: 'aire', label: 'Filtro de aire' },
    { key: 'polen', label: 'Filtro de polen / cabina' },
    { key: 'combustible', label: 'Filtro de combustible' },
  ];

  function renderHistorialFuente(h) {
    if (!h || !h.candidatos || !h.candidatos.length) {
      return '<span class="sin-mant">sin historial todavía</span>';
    }
    var tierTxt = h.tier === 'marca_modelo_motor'
      ? 'autos con esta misma marca, modelo y motor'
      : 'autos con esta misma marca y modelo (motor distinto o sin dato)';
    var codigos = h.candidatos.map(function (c) {
      return '<code>' + escapeHtml(c.codigo) + '</code> (' + c.veces + (c.veces === 1 ? ' vez' : ' veces') + ')';
    }).join(', ');
    return codigos + '<br><span class="filtro-sugerido-tier">según ' + tierTxt + '</span>';
  }

  function renderMannFuente(m) {
    if (!m || !m.length) return '<span class="sin-mant">sin dato en el catálogo</span>';
    return m.map(function (c) {
      var detalle = [];
      if (c.motor) detalle.push('motor ' + escapeHtml(c.motor));
      if (c.anios) detalle.push('años ' + escapeHtml(c.anios));
      return '<code>' + escapeHtml(c.codigo) + '</code>' +
        (detalle.length ? ' <span class="filtro-sugerido-tier">(' + detalle.join(', ') + ')</span>' : '');
    }).join('<br>');
  }

  function renderFiltrosSugeridos(fs) {
    if (!fs) return '';
    var filas = FILTROS_SUGERIDOS_TIPOS.map(function (t) {
      var d = fs[t.key] || {};
      return (
        '<div class="filtro-sugerido-fila">' +
          '<div class="filtro-sugerido-nombre">' + t.label + '</div>' +
          '<div class="filtro-sugerido-fuente"><span class="filtro-sugerido-etiqueta">Nuestra experiencia:</span> ' + renderHistorialFuente(d.historial) + '</div>' +
          '<div class="filtro-sugerido-fuente"><span class="filtro-sugerido-etiqueta">Catálogo Mann Filter:</span> ' + renderMannFuente(d.mann) + '</div>' +
        '</div>'
      );
    }).join('');
    return '<div class="panel filtros-sugeridos"><h3>Filtros sugeridos</h3><div class="filtros-sugeridos-lista">' + filas + '</div></div>';
  }

  function renderSimEncontrado(v) {
    var cont = document.getElementById('sim-resultado');
    var combustibleTxt = v.combustible === 'diesel' ? 'Petróleo (diésel)' : 'Bencina';
    var yaRegistrado = v._origen === 'base';
    var notaOrigen = yaRegistrado
      ? '✅ Reconocido al instante: ya estaba registrado en tu base del taller.'
      : '🌐 Identificado en el registro nacional de vehículos de Chile — todavía NO está registrado como vehículo del taller ni aparece en "Vehículos". Regístralo abajo recién cuando decidas darle un servicio.';
    var accionesHtml = yaRegistrado
      ? '<div class="acciones-form"><button class="btn btn-secundario" id="sim-ver-vehiculo" type="button">Ver su historial en Vehículos</button></div>'
      : (
          '<div class="grid-2" style="margin-top:14px">' +
            '<div class="campo"><label for="sim-reg-cliente">Nombre cliente (opcional)</label><input id="sim-reg-cliente" type="text" placeholder="Juan Pérez" /></div>' +
            '<div class="campo"><label for="sim-reg-correo">Correo (opcional)</label><input id="sim-reg-correo" type="email" placeholder="juan@correo.com" /></div>' +
          '</div>' +
          '<div class="acciones-form"><button class="btn btn-primario" id="btn-sim-registrar" type="button">Registrar este vehículo en el taller</button></div>'
        );
    cont.innerHTML =
      '<div class="panel">' +
        '<div class="patente-badge">' + escapeHtml(v.patente) + '</div>' +
        '<div class="sim-datos">' +
          '<div><strong>Marca y modelo:</strong> ' + escapeHtml((v.marca || '—') + ' ' + (v.modelo || '')) + '</div>' +
          '<div><strong>Año:</strong> ' + escapeHtml(v.anio || '—') + '</div>' +
          '<div><strong>Combustible:</strong> ' + combustibleTxt + '</div>' +
          '<div><strong>Motor:</strong> ' + escapeHtml(v.motor || 'No registrado todavía') + '</div>' +
          '<div><strong>VIN / chasis:</strong> ' + escapeHtml(v.vin || 'No registrado todavía') + '</div>' +
          (v.cliente_nombre ? '<div><strong>Cliente:</strong> ' + escapeHtml(v.cliente_nombre) + '</div>' : '') +
        '</div>' +
        '<p class="nota-registro">' + notaOrigen + '</p>' +
        accionesHtml +
      '</div>' +
      renderFiltrosSugeridos(v.filtrosSugeridos);

    if (yaRegistrado) {
      document.getElementById('sim-ver-vehiculo').onclick = function () {
        document.getElementById('buscar').value = v.patente;
        mostrarVista('vehiculos');
        cargarVehiculos();
      };
    } else {
      document.getElementById('btn-sim-registrar').onclick = function () { registrarVehiculoIdentificado(v); };
    }
  }

  // Guarda de verdad como vehículo del taller un auto que el Simulador identificó (vía la
  // base propia ya lo tendría con _origen 'base'; esto solo aplica a 'api_nacional_sin_registrar').
  // Es la acción explícita que el usuario pidió: que un auto NO se agregue solo porque alguien
  // lo buscó, sino recién cuando de verdad se decide darle servicio en el taller.
  function registrarVehiculoIdentificado(v) {
    var elCliente = document.getElementById('sim-reg-cliente');
    var elCorreo = document.getElementById('sim-reg-correo');
    var body = {
      patente: v.patente,
      marca: v.marca || '',
      modelo: v.modelo || '',
      anio: v.anio || '',
      combustible: v.combustible || 'bencina',
      motor: v.motor || '',
      vin: v.vin || '',
      clienteNombre: elCliente ? elCliente.value.trim() : '',
      clienteCorreo: elCorreo ? elCorreo.value.trim() : '',
    };
    api('/vehiculos', { method: 'POST', body: body }).then(function () {
      avisar('Vehículo registrado en el taller.');
      buscarSimulador(); // refresca -> ahora viene de la base real (_origen: 'base')
    }).catch(function (e) { avisar(e.message || 'No se pudo registrar el vehículo.', true); });
  }

  function renderSimNoEncontrado(patente, consultoRegistroNacional) {
    var cont = document.getElementById('sim-resultado');
    var explicacion = consultoRegistroNacional
      ? 'Se buscó en tu base del taller Y en el registro nacional de vehículos de Chile, y ninguno de los dos la tiene registrada — puede ser una patente muy nueva, provisoria, o de un tipo de vehículo que el registro no cubre. Complétala a mano esta vez y quedará guardada — la próxima vez que la escribas aquí, se reconocerá al instante.'
      : 'Identificar automáticamente CUALQUIER patente de Chile (no solo las que ya tienes) requiere el servicio externo contratado — todavía no quedó configurado en este servidor. Por ahora complétalo a mano esta vez y quedará guardado — la próxima vez que escribas esta patente aquí, se reconocerá al instante.';
    cont.innerHTML =
      '<div class="panel">' +
        '<p class="bahia-disponible-txt">No encontramos <strong>' + escapeHtml(patente) + '</strong>.</p>' +
        '<div class="bahia-nota">' + explicacion + '</div>' +
        '<div class="grid-3" style="margin-top:14px">' +
          '<div class="campo"><label for="sim-marca">Marca</label>' +
            '<select id="sim-marca"></select>' +
            '<input id="sim-marca-nueva" type="text" placeholder="Nombre de la marca nueva" hidden style="margin-top:6px" />' +
          '</div>' +
          '<div class="campo"><label for="sim-modelo">Modelo</label><input id="sim-modelo" type="text" placeholder="Corolla" /></div>' +
          '<div class="campo"><label for="sim-anio">Año</label><input id="sim-anio" type="text" placeholder="2020" inputmode="numeric" /></div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="campo"><label for="sim-combustible">Combustible</label>' +
            '<select id="sim-combustible"><option value="bencina">Bencina</option><option value="diesel">Petróleo (diésel)</option></select>' +
          '</div>' +
          '<div class="campo"><label for="sim-motor">Motor</label><input id="sim-motor" type="text" placeholder="Ej: 1.4T" /></div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="campo"><label for="sim-vin">VIN / chasis (opcional)</label><input id="sim-vin" type="text" placeholder="Ej: 9BWZZZ377VT004251" style="text-transform:uppercase" /></div>' +
        '</div>' +
        '<div class="acciones-form"><button class="btn btn-primario" id="btn-sim-guardar" type="button">Guardar e identificar</button></div>' +
      '</div>';

    document.getElementById('sim-marca').innerHTML = opcionesSelect(marcasCache, '', '+ Agregar marca nueva...');
    ligarSelectNuevo('sim-marca');
    document.getElementById('btn-sim-guardar').onclick = function () { guardarSimNuevo(patente); };
  }

  function guardarSimNuevo(patente) {
    valorFinalDeSelect('sim-marca', 'marcas').then(function (marca) {
      var body = {
        patente: patente,
        marca: marca,
        modelo: document.getElementById('sim-modelo').value.trim(),
        anio: document.getElementById('sim-anio').value.trim(),
        combustible: document.getElementById('sim-combustible').value,
        motor: document.getElementById('sim-motor').value.trim(),
        vin: document.getElementById('sim-vin').value.trim(),
      };
      return api('/vehiculos', { method: 'POST', body: body }).then(function () {
        avisar('Auto guardado e identificado.');
        renderSimEncontrado(Object.assign({ patente: patente }, body));
        buscarSimulador(); // refresca con el registro real ya guardado (incluye id, etc.)
      });
    }).catch(function (e) { avisar(e.message || 'No se pudo guardar el auto.', true); });
  }

  // ---------- Gestionar equipo (solo admin) ----------
  document.getElementById('btn-equipo').onclick = function () { mostrarVista('equipo'); };
  function cargarEquipo() {
    api('/usuarios').then(function (lista) {
      var filas = lista.map(function (u) {
        return '<tr>' +
          '<td>' + escapeHtml(u.nombre) + '</td>' +
          '<td>' + escapeHtml(u.correo) + '</td>' +
          '<td>' + (u.rol === 'admin' ? 'Administrador' : 'Mecánico / recepción') + '</td>' +
          '<td>' + (u.activo ? '' : '<span class="badge-inactivo">Desactivada</span>') +
            (u.id !== usuarioActual.id
              ? '<button class="btn-texto" data-id="' + u.id + '" data-activo="' + (u.activo ? '0' : '1') + '">' + (u.activo ? 'Desactivar' : 'Activar') + '</button>'
              : '') +
          '</td>' +
        '</tr>';
      }).join('');
      document.getElementById('tabla-equipo-wrap').innerHTML =
        '<table class="usuarios"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th></th></tr></thead><tbody>' + filas + '</tbody></table>';
      document.querySelectorAll('#tabla-equipo-wrap button[data-id]').forEach(function (b) {
        b.onclick = function () {
          api('/usuarios/' + b.getAttribute('data-id') + '/activo', { method: 'PUT', body: { activo: b.getAttribute('data-activo') === '1' } })
            .then(cargarEquipo)
            .catch(function (e) { avisar(e.message || 'No se pudo actualizar.', true); });
        };
      });
    }).catch(function (e) { avisar(e.message || 'No se pudo cargar el equipo.', true); });
  }
  document.getElementById('btn-crear-usuario').onclick = function () {
    var body = {
      nombre: document.getElementById('eq-nombre').value.trim(),
      correo: document.getElementById('eq-correo').value.trim(),
      rol: document.getElementById('eq-rol').value,
      password: document.getElementById('eq-password').value,
    };
    api('/usuarios', { method: 'POST', body: body }).then(function () {
      ['eq-nombre', 'eq-correo', 'eq-password'].forEach(function (id) { document.getElementById(id).value = ''; });
      avisar('Cuenta creada.');
      cargarEquipo();
    }).catch(function (e) { avisar(e.message || 'No se pudo crear la cuenta.', true); });
  };

  // ---------- Estadísticas (solo admin) ----------
  document.getElementById('btn-estadisticas').onclick = function () { mostrarVista('estadisticas'); };

  function kpiCard(valor, label, sub) {
    return '<div class="kpi-card"><div class="kpi-valor">' + valor + '</div>' +
      '<div class="kpi-label">' + escapeHtml(label) + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') +
    '</div>';
  }

  function rankingHtml(items) {
    if (!items.length) return '<p class="sin-mant">Sin datos todavía.</p>';
    var max = Math.max.apply(null, items.map(function (it) { return it.cantidad; })) || 1;
    return '<ul class="ranking">' + items.map(function (it) {
      var ancho = Math.max(4, Math.round((it.cantidad / max) * 100));
      var extra = it.porcentaje != null ? ' (' + it.porcentaje + '%)' : '';
      return '<li>' +
        '<span class="rk-nombre" title="' + escapeHtml(it.etiqueta) + '">' + escapeHtml(it.etiqueta) + '</span>' +
        '<span class="rk-barra-wrap"><span class="rk-barra" style="width:' + ancho + '%"></span></span>' +
        '<span class="rk-cantidad">' + it.cantidad + extra + '</span>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function mesBonito(mes) {
    var meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    var p = String(mes).split('-');
    if (p.length !== 2) return mes;
    var idx = Number(p[1]) - 1;
    return (meses[idx] || p[1]) + ' ' + p[0];
  }

  function cargarEstadisticas() {
    var cont = document.getElementById('estadisticas-contenido');
    cont.innerHTML = '<p class="sin-mant">Calculando...</p>';
    api('/estadisticas').then(function (d) {
      var html = '';

      html += '<div class="kpi-grid">' +
        kpiCard(d.totales.vehiculos, 'Vehículos registrados') +
        kpiCard(d.totales.mantenciones, 'Mantenciones registradas') +
        kpiCard(d.totales.promedio_mantenciones_por_vehiculo, 'Mantenciones promedio por vehículo') +
        kpiCard(
          d.clientes_recurrentes.porcentaje_sobre_total_vehiculos + '%',
          'Patentes con más de 1 mantención',
          d.clientes_recurrentes.vehiculos_con_mas_de_una + ' de ' + d.totales.vehiculos + ' patentes registradas'
        ) +
        kpiCard(
          d.clientes_recurrentes.porcentaje_sobre_atendidos + '%',
          'Tasa de repetición de clientes atendidos',
          d.clientes_recurrentes.vehiculos_con_mas_de_una + ' de ' + d.clientes_recurrentes.vehiculos_con_alguna_mantencion + ' con historial volvieron'
        ) +
        kpiCard(d.totales.vehiculos_sin_mantencion, 'Vehículos sin ninguna mantención aún') +
        kpiCard(Number(d.kilometraje_promedio).toLocaleString('es-CL') + ' km', 'Kilometraje promedio en mantenciones') +
      '</div>';

      html += '<div class="stat-bloque"><h4>Marca más repetida</h4>' +
        rankingHtml(d.marcas_top.map(function (m) { return { etiqueta: m.marca, cantidad: m.cantidad, porcentaje: m.porcentaje }; })) +
      '</div>';

      if (d.modelos_top.length) {
        html += '<div class="stat-bloque"><h4>Marca y modelo más repetidos</h4>' +
          rankingHtml(d.modelos_top.map(function (m) { return { etiqueta: m.marca + ' ' + m.modelo, cantidad: m.cantidad }; })) +
        '</div>';
      }

      html += '<div class="stat-bloque"><h4>Combustible de los vehículos</h4>' +
        rankingHtml(d.combustible.map(function (c) {
          return { etiqueta: c.combustible === 'diesel' ? 'Petróleo (diésel)' : 'Bencina', cantidad: c.cantidad, porcentaje: c.porcentaje };
        })) +
      '</div>';

      html += '<div class="stat-bloque"><h4>Filtros más cambiados</h4>' +
        rankingHtml(d.filtros_cambiados.map(function (f) { return { etiqueta: f.filtro, cantidad: f.cantidad }; })) +
      '</div>';

      if (d.codigos_repuesto_top.length) {
        html += '<div class="stat-bloque"><h4>Códigos de repuesto más usados</h4>' +
          rankingHtml(d.codigos_repuesto_top.map(function (c) { return { etiqueta: c.codigo, cantidad: c.cantidad }; })) +
        '</div>';
      }

      if (d.tecnicos_top.length) {
        html += '<div class="stat-bloque"><h4>Técnicos con más mantenciones registradas</h4>' +
          rankingHtml(d.tecnicos_top.map(function (t) { return { etiqueta: t.tecnico, cantidad: t.cantidad }; })) +
        '</div>';
      }

      html += '<div class="kpi-grid">' +
        kpiCard(
          '$' + Number(d.costos.total_clp).toLocaleString('es-CL'),
          'Total facturado registrado',
          d.costos.mantenciones_con_costo_registrado + ' mantenciones con costo ingresado'
        ) +
        kpiCard('$' + Number(d.costos.promedio_clp).toLocaleString('es-CL'), 'Ticket promedio por mantención') +
      '</div>';

      if (d.mantenciones_por_mes.length) {
        html += '<div class="stat-bloque"><h4>Mantenciones por mes (últimos 6 meses)</h4>' +
          rankingHtml(d.mantenciones_por_mes.map(function (m) { return { etiqueta: mesBonito(m.mes), cantidad: m.cantidad }; })) +
        '</div>';
      }

      cont.innerHTML = html;
    }).catch(function (e) {
      cont.innerHTML = '<p class="sin-mant">' + escapeHtml(e.message || 'No se pudieron cargar las estadísticas.') + '</p>';
    });
  }

  // ---------- Configuración: marcas y técnicos (solo admin gestiona/borra) ----------
  function renderListaConfig(contId, items, tipo) {
    var cont = document.getElementById(contId);
    if (!items.length) { cont.innerHTML = '<p class="sin-mant">Sin datos todavía.</p>'; return; }
    var ordenada = items.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    cont.innerHTML = '<div class="config-lista">' + ordenada.map(function (it) {
      return '<div class="config-item"><span>' + escapeHtml(it.nombre) + '</span>' +
        '<button class="btn-texto" data-id="' + it.id + '" data-tipo="' + tipo + '">Eliminar</button></div>';
    }).join('') + '</div>';
    cont.querySelectorAll('button[data-id]').forEach(function (b) {
      b.onclick = function () { eliminarDeConfig(b.getAttribute('data-tipo'), Number(b.getAttribute('data-id'))); };
    });
  }

  function cargarPanelConfiguracion() {
    cargarListasConfig().then(function () {
      renderListaConfig('lista-marcas-config', marcasCache, 'marcas');
      renderListaConfig('lista-tecnicos-config', tecnicosCache, 'tecnicos');
    }).catch(function (e) { avisar(e.message || 'No se pudieron cargar las listas.', true); });
  }

  function eliminarDeConfig(tipo, id) {
    api('/configuracion/' + tipo + '/' + id, { method: 'DELETE' }).then(function () {
      cargarPanelConfiguracion();
    }).catch(function (e) { avisar(e.message || 'No se pudo eliminar.', true); });
  }

  document.getElementById('btn-configuracion').onclick = function () { mostrarVista('configuracion'); };
  document.getElementById('btn-agregar-marca').onclick = function () {
    var inp = document.getElementById('config-marca-nueva');
    var nombre = inp.value.trim();
    if (!nombre) return;
    api('/configuracion/marcas', { method: 'POST', body: { nombre: nombre } }).then(function () {
      inp.value = '';
      cargarPanelConfiguracion();
    }).catch(function (e) { avisar(e.message || 'No se pudo agregar.', true); });
  };
  document.getElementById('btn-agregar-tecnico').onclick = function () {
    var inp = document.getElementById('config-tecnico-nuevo');
    var nombre = inp.value.trim();
    if (!nombre) return;
    api('/configuracion/tecnicos', { method: 'POST', body: { nombre: nombre } }).then(function () {
      inp.value = '';
      cargarPanelConfiguracion();
    }).catch(function (e) { avisar(e.message || 'No se pudo agregar.', true); });
  };

  // ---------- Arranque ----------
  api('/auth/me').then(mostrarApp).catch(mostrarLogin);
})();
