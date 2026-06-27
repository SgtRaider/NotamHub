// app.js — Orquestador de NotamHub (versión civil).
//
// Reescritura ligera del controlador de TSAgestor, centrada en el subset
// civil: carga de TSAs/NOTAMs (nacionales y de FIRs colindantes) desde la
// API NotamHub, filtros, tabla, render sobre el mapa Leaflet, capas meteo y
// ajustes. Expone window.NotamHub.app como "bridge" para shell.js.
(function () {
  'use strict';

  const NH = (window.NotamHub = window.NotamHub || {});
  const mapView    = () => NH.mapView;
  const notamHub   = () => NH.notamHub;
  const notamView  = () => NH.notamView;
  const filters    = () => NH.filters;
  const settings   = () => NH.settings;
  const scheduleFmt = () => NH.scheduleFmt;
  const i18n       = () => NH.i18n;

  const LS_WELCOME = 'notamhub_welcome_ack';
  // Región amplia para cargar los NOTAMs extranjeros de UNA sola vez (FIRs
  // colindantes: Iberia + Francia S + Portugal + Marruecos + Argelia + Med).
  // Formato API: [min_lat, max_lat, min_lon, max_lon]. Cargamos todo el área
  // una vez (no por bbox visible) para que el mapa se mueva libre y se pinten
  // todos los NOTAMs sin recargar al desplazar.
  const FOREIGN_BBOX = [20, 55, -30, 25];

  const state = {
    national: [],     // TSAs/NOTAMs nacionales (notamHub.convertTSAsToInternal)
    foreign:  [],     // NOTAMs extranjeros con geometría (convertForeignToInternal)
    selected: new Set(),
    filter: { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', tsaType: 'all', activeNow: false },
    firFilter: null,   // null = todos los FIR; Set(...) = solo esos FIR
    catFilter: null,   // null = todas las categorías; Set(...) = solo esas (foreign)
    search: '',        // texto libre (nombre/país/FIR/Q-code/cuerpo)
    sort: { key: 'validFrom', dir: 1 },   // dir 1=asc, -1=desc
    mapReady: false,
    at: '',
    atTo: '',
  };
  // FIR de un item: su código FIR (LECM/LECB/GCCC para nacionales con NOTAM,
  // o el FIR extranjero); 'ES' para TSAs nacionales sin FIR concreto.
  function firOf(t) { return t.fir || (t._foreign ? '—' : 'ES'); }

  // ── Utilidades ────────────────────────────────────────────────────
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function allItems() { return state.national.concat(state.foreign); }
  function assignUids() {
    state.national.forEach((t, i) => { t._uid = 'N:' + (t.id != null ? t.id : i); });
    state.foreign.forEach((t, i) => { t._uid = 'F:' + (t.id != null ? t.id : i); });
  }
  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' status-' + kind : '');
  }

  // ── Mapa ──────────────────────────────────────────────────────────
  function ensureMap() {
    if (state.mapReady) return;
    const mv = mapView();
    if (!mv || !mv.init) return;
    try { mv.init('map'); state.mapReady = true; }
    catch (err) { console.error('[app] init mapa falló:', err); }
  }

  function getVisible() {
    const f = filters();
    return allItems().filter((t) => {
      if (!state.selected.has(t._uid)) return false;
      if (state.firFilter && !state.firFilter.has(firOf(t))) return false;
      if (state.catFilter && t.category && !state.catFilter.has(t.category)) return false;
      if (f && f.matches) { try { return f.matches(t, state.filter); } catch (_) { return true; } }
      return true;
    });
  }

  function renderViews() {
    const mv = mapView();
    const visible = getVisible();
    if (mv && mv.render && state.mapReady) {
      try { mv.render(visible); } catch (err) { console.error('[app] render mapa:', err); }
      if (mv.updateLegend) { try { mv.updateLegend(visible); } catch (_) {} }
    }
    const cnt = $('#map-count');
    if (cnt) cnt.textContent = visible.length ? (visible.length + ' áreas') : '';
  }

  function renderAll() { renderTable(); renderViews(); updateFilterCounts(); }

  // ── Tabla de NOTAMs/TSAs ──────────────────────────────────────────
  function renderTable() {
    const wrap = $('#tsa-table-wrap');
    const tbody = $('#tsa-table tbody');
    const all = allItems();
    if (!tbody) return;
    tbody.innerHTML = '';
    const sf = scheduleFmt();
    const f = filters();
    // Filtra (FIR + categoría + búsqueda) y ordena por la columna elegida.
    const list = sortItems(all.filter(passesRowFilters));
    const shown = list.length;
    list.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.uid = t._uid;
      tr.className = 'tsa-row';
      if (t._largeCircle) tr.classList.add('is-largecircle');
      if (t._firWide) tr.classList.add('is-firwide');
      else if (t._noGeometry) tr.classList.add('is-nogeo');
      const inFilter = f && f.matches ? safeMatches(f, t) : true;
      if (!inFilter) tr.classList.add('out-of-filter');
      const checked = state.selected.has(t._uid) ? 'checked' : '';
      // Columna de fechas = vigencia REAL del NOTAM (no recortada a la búsqueda).
      const validity = t._isPermanent
        ? '<span class="badge">Permanente</span>'
        : (esc(fmtDate(t.validFrom)) + ' → ' + esc(fmtDate(t.validTo)));
      const nWin = (t.schedules && t.schedules.length) || 0;
      const winHint = (!t._isPermanent && nWin > 1) ? ' <span class="dim">(' + nWin + ' vent.)</span>' : '';
      const radNm = (t._circleRadiusNm != null) ? Math.round(t._circleRadiusNm) : (t._effRadiusNm != null ? t._effRadiusNm : '?');
      const lcNote = t._largeCircle
        ? ' <span class="badge badge-lc" title="Radio &gt; 75 NM: oculto del mapa por defecto">⊘ ' + radNm + ' NM</span>'
        : '';
      const geomNote = t._firWide
        ? ' <span class="badge badge-firwide" title="El NOTAM aplica a todo el FIR (sin área concreta)">FIR completo</span>'
        : (t._noGeometry
          ? ' <span class="badge badge-nogeo" title="Sin geometría: el API no da coordenadas dibujables">sin geo</span>'
          : '');
      const timeNote = t._upcoming
        ? ' <span class="badge badge-upcoming" title="Aún no vigente: su ventana empieza en el futuro">Próximo</span>'
        : (t._expired ? ' <span class="badge badge-expired" title="Su validez ya terminó">Expirado</span>' : '');
      const origin = t._foreign
        ? (esc(t.fir || t.country || 'Ext.') + catBadgeHTML(t))
        : 'Nacional';
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="tsa-row-cb" ' + checked + '></td>' +
        '<td class="col-name"><span class="row-caret">▸</span>' + esc(t.name || '—') + lcNote + geomNote + timeNote + '</td>' +
        '<td>' + origin + '</td>' +
        '<td>' + esc((t.vertical && t.vertical.lowerLabel) || 'GND') + '</td>' +
        '<td>' + esc((t.vertical && t.vertical.upperLabel) || 'UNL') + '</td>' +
        '<td>' + ((t.polygon && t.polygon.length) || 0) + '</td>' +
        '<td class="col-windows">' + validity + winHint + '</td>';
      tbody.appendChild(tr);
      // Fila de detalle (colapsada) con TODA la información del NOTAM.
      const dr = document.createElement('tr');
      dr.className = 'tsa-detail-row';
      dr.style.display = 'none';
      dr.innerHTML = '<td colspan="7">' + buildDetailHTML(t) + '</td>';
      tbody.appendChild(dr);
    });
    if (wrap) {
      wrap.classList.toggle('hidden', all.length === 0);
    }
    const countBadge = $('#tsa-count');
    if (countBadge) {
      countBadge.textContent = !all.length ? '' : (shown < all.length ? (shown + ' / ' + all.length) : String(all.length));
    }
    updateSelectionSummary();
  }

  // Filtro de fila (FIR + categoría + búsqueda de texto). El filtro de
  // fecha/tipo se aplica aparte (atenúa filas vía .out-of-filter).
  function passesRowFilters(t) {
    if (state.firFilter && !state.firFilter.has(firOf(t))) return false;
    if (state.catFilter && t.category && !state.catFilter.has(t.category)) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = ((t.name || '') + ' ' + (t.country || '') + ' ' + (t.fir || '') + ' ' +
        (t.qCode || '') + ' ' + (t.remarks || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function sortKeyVal(t) {
    switch (state.sort.key) {
      case 'name': return (t.name || '').toLowerCase();
      case 'fir': return firOf(t);
      case 'lowerFt': return (t.vertical && t.vertical.lowerFt) || 0;
      case 'upperFt': return (t.vertical && t.vertical.upperFt) || 0;
      case 'vertices': return (t.polygon && t.polygon.length) || 0;
      case 'validFrom': return t.validFrom instanceof Date ? t.validFrom.getTime() : (t._isPermanent ? 8.64e15 : 0);
      case 'validTo': return t.validTo instanceof Date ? t.validTo.getTime() : (t._isPermanent ? 8.64e15 : 0);
      default: return 0;
    }
  }
  function sortItems(list) {
    const d = state.sort.dir;
    return list.slice().sort((a, b) => {
      const va = sortKeyVal(a), vb = sortKeyVal(b);
      if (va < vb) return -d;
      if (va > vb) return d;
      return 0;
    });
  }

  function safeMatches(f, t) { try { return f.matches(t, state.filter); } catch (_) { return true; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function catBadgeHTML(t) {
    const nh = notamHub();
    const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(t.category) : null;
    if (!meta) return '';
    return ' <span class="cat-badge" style="background:' + meta.color + '">' + esc(meta.label) + '</span>';
  }
  function catLabel(t) {
    const nh = notamHub();
    const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(t.category) : null;
    return meta ? meta.label : '';
  }
  const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getUTCDate()) + ' ' + MONTHS_ES[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function fmtDateTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return fmtDate(d) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z';
  }
  function realValidity(t) {
    if (t._isPermanent) return 'Permanente';
    return esc(fmtDateTime(t.validFrom)) + ' → ' + esc(fmtDateTime(t.validTo));
  }
  // Panel de detalle con TODA la información disponible del NOTAM.
  function buildDetailHTML(t) {
    const sf = scheduleFmt();
    const rows = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push('<div class="d-k">' + esc(k) + '</div><div class="d-v">' + v + '</div>'); };
    if (t._foreign) {
      const nd = NH.notamDecode;
      add('Categoría', esc(catLabel(t)));
      add('País / FIR', esc([t.country, t.fir].filter(Boolean).join(' / ')));
      if (t.qCode) {
        const q = nd ? nd.decodeQ(t.qCode) : null;
        add('Q-code', '<b>' + esc(t.qCode) + '</b>' + (q && q.text ? ' — ' + esc(q.text) : ''));
      }
      if (t.scope)   add('Ámbito (scope)', esc(t.scope) + (nd ? ' — ' + esc(nd.decodeScope(t.scope)) : ''));
      if (t.traffic) add('Tráfico', esc(t.traffic) + (nd ? ' — ' + esc(nd.decodeTraffic(t.traffic)) : ''));
      if (t.purpose) add('Propósito', esc(t.purpose) + (nd ? ' — ' + esc(nd.decodePurpose(t.purpose)) : ''));
      add('Aeropuerto', esc(t.airport));
      if (t._military) add('Militar', 'Sí');
    } else {
      add('Tipo', t._isWorkArea ? 'Área de trabajo' : 'Área de tránsito');
      add('NOTAM(s) padre', esc(t._parentNotam));
    }
    add('Altitud', esc((t.vertical && t.vertical.lowerLabel) || 'GND') + ' → ' + esc((t.vertical && t.vertical.upperLabel) || 'UNL'));
    add('Vértices', (t.polygon && t.polygon.length) || 0);
    if (t._isCircle) add('Círculo', (t._circleRadiusNm != null ? Math.round(t._circleRadiusNm) + ' NM de radio' : 'sí') + (t._largeCircle ? ' · <b class="lc-warn">oculto del mapa (&gt;75 NM)</b>' : ''));
    add('Vigencia real', realValidity(t));
    if (!t._isPermanent && t.schedules && sf && sf.listHTML) add('Ventanas horarias', sf.listHTML(t.schedules));
    if (t._isEstimate) add('Estimado', 'Sí (EST)');
    if (t._foreign && t.remarks) rows.push('<div class="d-k">Texto NOTAM</div><div class="d-v"><pre class="d-body">' + esc(t.remarks) + '</pre></div>');
    return '<div class="tsa-detail">' + rows.join('') + '</div>';
  }

  function updateSelectionSummary() {
    const el = $('#selection-summary');
    if (el) el.textContent = state.selected.size + ' / ' + allItems().length + ' seleccionadas';
  }

  // ── Carga desde NotamHub ──────────────────────────────────────────
  async function handleNotamHubLoad() {
    const nh = notamHub();
    const statusEl = $('#notamhub-status');
    if (!nh || !nh.fetchActiveTSAs) { setStatus(statusEl, 'Cliente NotamHub no disponible.', 'err'); return; }
    const atIn = $('#notamhub-at');
    const atToIn = $('#notamhub-at-to');
    const at = atIn && atIn.value ? new Date(atIn.value).toISOString() : '';
    const atTo = atToIn && atToIn.value ? new Date(atToIn.value).toISOString() : '';
    state.at = at; state.atTo = atTo;
    setStatus(statusEl, 'Consultando TSAs activas…', 'info');
    ensureMap();
    try {
      const params = {};
      if (at) params.at = at;
      if (atTo) params.atTo = atTo;
      const apiList = await nh.fetchActiveTSAs(params);
      let internal = nh.convertTSAsToInternal ? nh.convertTSAsToInternal(apiList, at ? new Date(at) : new Date()) : (apiList || []);
      if (nh.refineWorkAreaByParentRmk) {
        try { internal = await nh.refineWorkAreaByParentRmk(internal, params) || internal; } catch (_) {}
      }
      state.national = internal || [];
      // NOTAMs nacionales (LECM/LECB/GCCC): el API no da geometría en campos,
      // pero la parseamos del cuerpo del NOTAM y la añadimos a "national".
      try {
        if (nh.fetchNationalNotams && nh.convertNationalNotamsToInternal) {
          const natList = await nh.fetchNationalNotams({ at: at });
          const natInternal = nh.convertNationalNotamsToInternal(natList, at ? new Date(at) : new Date()) || [];
          state.national = state.national.concat(natInternal);
        }
      } catch (e) { console.warn('[app] NOTAMs nacionales fallaron:', e); }
      // NOTAMs extranjeros (FIRs colindantes) por área visible del mapa.
      const wantForeign = $('#notamhub-foreign') && $('#notamhub-foreign').checked;
      if (wantForeign) { await loadForeign(false); }
      else { state.foreign = []; }
      assignUids();
      selectDefault();
      rebuildFirFilter();
      rebuildCatFilter();
      const hidden = allItems().filter((t) => t._largeCircle).length;
      setStatus(statusEl, state.national.length + ' nacionales · ' + state.foreign.length + ' extranjeras cargadas' +
        (hidden ? ' · ' + hidden + ' círculos >75 NM ocultos (visibles en la tabla)' : '') + '.', 'ok');
      renderAll();
      fitToData();
    } catch (err) {
      console.error('[app] carga NotamHub falló:', err);
      setStatus(statusEl, 'Error al consultar NotamHub: ' + (err && err.message || err), 'err');
    }
  }

  async function loadForeign(rerender) {
    const nh = notamHub();
    if (!nh || !nh.fetchForeignAll) return;
    try {
      const params = {};
      if (state.at) params.at = state.at;
      const apiList = await nh.fetchForeignAll(params);
      state.foreign = nh.convertForeignToInternal ? (nh.convertForeignToInternal(apiList, state.at ? new Date(state.at) : new Date()) || []) : [];
      assignUids();
      // Selecciona los extranjeros plotteables (con geometría y radio ≤ 75 NM).
      // Los grandes (>75 NM) o sin geometría quedan deseleccionados.
      state.foreign.forEach((t) => { if (!t._largeCircle && !t._noGeometry && !t._expired) state.selected.add(t._uid); });
      rebuildFirFilter();
      rebuildCatFilter();
      if (rerender) renderAll();
    } catch (err) { console.warn('[app] carga foreign falló:', err); }
  }

  function currentBbox() {
    const lmap = window._tsa_leaflet_map;
    if (!lmap || !lmap.getBounds) return null;
    const b = lmap.getBounds();
    // "min_lat,max_lat,min_lon,max_lon"
    return [b.getSouth(), b.getNorth(), b.getWest(), b.getEast()];
  }

  function fitToData() {
    const mv = mapView();
    if (!mv) return;
    const vis = getVisible();
    try {
      if (vis.length && mv.fitBounds) mv.fitBounds();
      else if (mv.fitToDefault) mv.fitToDefault();
    } catch (_) {}
  }

  // ── Selección ─────────────────────────────────────────────────────
  function selectAll() { state.selected = new Set(allItems().map((t) => t._uid)); }
  function selectNone() { state.selected = new Set(); }
  // Selección por defecto al cargar: todo MENOS los círculos > 75 NM y los que
  // no tienen geometría (no plotteables). Quedan accesibles/visibles en la tabla.
  function selectDefault() { state.selected = new Set(allItems().filter((t) => !t._largeCircle && !t._noGeometry && !t._expired).map((t) => t._uid)); }

  function wireSelection() {
    const tbody = $('#tsa-table tbody');
    if (tbody) {
      tbody.addEventListener('change', (e) => {
        const cb = e.target.closest && e.target.closest('.tsa-row-cb');
        if (!cb) return;
        const tr = cb.closest('tr');
        const uid = tr && tr.dataset.uid;
        if (!uid) return;
        if (cb.checked) state.selected.add(uid); else state.selected.delete(uid);
        updateSelectionSummary();
        renderViews();
        updateFilterCounts();
      });
      // Click en la fila (fuera del checkbox) despliega/oculta el detalle.
      tbody.addEventListener('click', (e) => {
        if (e.target.closest('.col-check')) return;
        const row = e.target.closest('tr.tsa-row');
        if (!row) return;
        const dr = row.nextElementSibling;
        if (dr && dr.classList.contains('tsa-detail-row')) {
          const isOpen = dr.style.display !== 'none';
          dr.style.display = isOpen ? 'none' : '';
          row.classList.toggle('expanded', !isOpen);
        }
      });
    }
    const allBtn = $('#btn-select-all');
    const noneBtn = $('#btn-select-none');
    const headCb = $('#tsa-select-all-cb');
    if (allBtn) allBtn.addEventListener('click', () => { selectAll(); renderAll(); });
    if (noneBtn) noneBtn.addEventListener('click', () => { selectNone(); renderAll(); });
    if (headCb) headCb.addEventListener('change', () => { headCb.checked ? selectAll() : selectNone(); renderAll(); });
  }

  // ── Filtro ────────────────────────────────────────────────────────
  function readFilter() {
    state.filter.dateFrom = ($('#filter-date-from') || {}).value || '';
    state.filter.dateTo   = ($('#filter-date-to') || {}).value || '';
    state.filter.timeFrom = ($('#filter-time-from') || {}).value || '';
    state.filter.timeTo   = ($('#filter-time-to') || {}).value || '';
  }

  function wireFilter() {
    const apply = $('#btn-filter-apply');
    const clear = $('#btn-filter-clear');
    if (apply) apply.addEventListener('click', () => { readFilter(); renderAll(); updateFilterSummary(); });
    if (clear) clear.addEventListener('click', () => {
      ['#filter-date-from', '#filter-date-to', '#filter-time-from', '#filter-time-to'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
      state.filter = { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', tsaType: 'all', activeNow: false };
      setChip('all');
      renderAll(); updateFilterSummary();
    });
    $$('#tsa-filter-chips .tsa-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const f = chip.dataset.tsaFilter;
        if (f === 'active-now') { state.filter.activeNow = !state.filter.activeNow; chip.classList.toggle('is-active'); }
        else { state.filter.tsaType = f; state.filter.activeNow = false; setChip(f); }
        renderAll(); updateFilterSummary();
      });
    });
    // Filtro por FIR (chips dinámicos, delegación de eventos). Modelo "aislar":
    //  - "Todos" -> muestra todos los FIR (firFilter = null).
    //  - pulsar un FIR estando en "todos" -> aísla SOLO ese FIR.
    //  - pulsar más FIRs -> los añade al conjunto visible.
    //  - re-pulsar un FIR activo -> lo quita (si queda vacío, vuelve a todos).
    const firHost = $('#fir-filter-chips');
    if (firHost) firHost.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('.fir-chip');
      if (!chip) return;
      if (chip.dataset.firAll) { state.firFilter = null; rebuildFirFilter(); renderAll(); return; }
      const fir = chip.dataset.fir;
      if (!fir) return;
      if (state.firFilter === null) {
        state.firFilter = new Set([fir]);                       // aísla el pulsado
      } else if (state.firFilter.has(fir)) {
        state.firFilter.delete(fir);
        if (state.firFilter.size === 0) state.firFilter = null; // vacío -> todos
      } else {
        state.firFilter.add(fir);                               // añade al conjunto
      }
      rebuildFirFilter(); renderAll();
    });
    // Filtro por categoría (mismo modelo "aislar" que FIR).
    const catHost = $('#cat-filter-chips');
    if (catHost) catHost.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('.fir-chip');
      if (!chip) return;
      if (chip.dataset.catAll) { state.catFilter = null; rebuildCatFilter(); renderAll(); return; }
      const k = chip.dataset.cat;
      if (!k) return;
      if (state.catFilter === null) state.catFilter = new Set([k]);
      else if (state.catFilter.has(k)) { state.catFilter.delete(k); if (state.catFilter.size === 0) state.catFilter = null; }
      else state.catFilter.add(k);
      rebuildCatFilter(); renderAll();
    });
    // Búsqueda de texto (solo afecta a la lista).
    const search = $('#tsa-search');
    if (search) search.addEventListener('input', () => { state.search = search.value.trim(); renderTable(); });
  }

  // Ordenación por columnas: clic en cabecera con data-sort.
  function wireSortHeaders() {
    const thead = document.querySelector('#tsa-table thead');
    if (!thead) return;
    thead.addEventListener('click', (e) => {
      const th = e.target.closest && e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = -state.sort.dir;
      else { state.sort.key = key; state.sort.dir = 1; }
      updateSortIndicators();
      renderTable();
    });
  }
  function updateSortIndicators() {
    $$('#tsa-table thead th[data-sort]').forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === state.sort.key) th.classList.add(state.sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    });
  }

  // Reconstruye los chips de filtro por categoría (NOTAMs extranjeros).
  function rebuildCatFilter() {
    const host = $('#cat-filter-chips');
    if (!host) return;
    const nh = notamHub();
    const counts = new Map();
    allItems().forEach((t) => {
      if (!t.category) return;
      const k = t.category;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const cats = Array.from(counts.keys()).sort((a, b) => counts.get(b) - counts.get(a));
    host.innerHTML = '';
    if (!cats.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const lbl = document.createElement('span');
    lbl.className = 'fir-chips-label';
    lbl.textContent = 'Tipo:';
    host.appendChild(lbl);
    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'fir-chip fir-chip-all' + (!state.catFilter ? ' is-active' : '');
    allChip.dataset.catAll = '1';
    allChip.textContent = 'Todas';
    host.appendChild(allChip);
    cats.forEach((k) => {
      const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(k) : { label: k, color: '#888' };
      const on = !state.catFilter || state.catFilter.has(k);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fir-chip cat-chip' + (on ? ' is-active' : '');
      btn.dataset.cat = k;
      btn.innerHTML = '<span class="cat-dot" style="background:' + meta.color + '"></span>' + esc(meta.label) +
        ' <span class="fir-chip-count">' + counts.get(k) + '</span>';
      host.appendChild(btn);
    });
  }

  // Reconstruye los chips de filtro por FIR según los datos cargados.
  function rebuildFirFilter() {
    const host = $('#fir-filter-chips');
    if (!host) return;
    const counts = new Map();
    allItems().forEach((t) => {
      const fir = firOf(t);
      counts.set(fir, (counts.get(fir) || 0) + 1);
    });
    const firs = Array.from(counts.keys()).sort((a, b) => {
      if (a === 'ES') return -1; if (b === 'ES') return 1;
      return a.localeCompare(b);
    });
    host.innerHTML = '';
    if (!firs.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const lbl = document.createElement('span');
    lbl.className = 'fir-chips-label';
    lbl.textContent = 'FIR:';
    host.appendChild(lbl);
    // Chip "Todos" (muestra todos los FIR).
    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'fir-chip fir-chip-all' + (!state.firFilter ? ' is-active' : '');
    allChip.dataset.firAll = '1';
    allChip.textContent = 'Todos';
    host.appendChild(allChip);
    firs.forEach((fir) => {
      const on = !state.firFilter || state.firFilter.has(fir);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fir-chip' + (on ? ' is-active' : '');
      btn.dataset.fir = fir;
      btn.innerHTML = (fir === 'ES' ? 'Nacional' : esc(fir)) + ' <span class="fir-chip-count">' + counts.get(fir) + '</span>';
      host.appendChild(btn);
    });
  }
  function setChip(f) {
    $$('#tsa-filter-chips .tsa-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.tsaFilter === f));
  }
  function updateFilterSummary() {
    const el = $('#filter-summary');
    const f = filters();
    if (el && f && f.summaryText) { try { el.textContent = f.summaryText(state.filter); } catch (_) {} }
  }
  function updateFilterCounts() {
    const counts = { all: 0, work: 0, transit: 0, 'active-now': 0 };
    const f = filters();
    const now = { activeNow: true };
    allItems().forEach((t) => {
      counts.all++;
      if (t._isWorkArea) counts.work++; else if (t._foreign) {} else counts.transit++;
      if (f && f.matches) { try { if (f.matches(t, Object.assign({}, state.filter, now))) counts['active-now']++; } catch (_) {} }
    });
    Object.keys(counts).forEach((k) => {
      const el = document.querySelector('#tsa-filter-chips [data-count="' + k + '"]');
      if (el) el.textContent = String(counts[k]);
    });
  }

  // ── Toolbar del mapa ──────────────────────────────────────────────
  function wireMapToolbar() {
    const fit = $('#btn-fit-bounds');
    const legend = $('#btn-map-legend');
    const layers = $('#btn-map-layers');
    if (fit) fit.addEventListener('click', () => { ensureMap(); fitToData(); });
    if (legend) legend.addEventListener('click', () => {
      const mv = mapView(); if (!mv || !mv.setLegendVisible) return;
      const on = mv.isLegendVisible ? !mv.isLegendVisible() : true;
      mv.setLegendVisible(on, getVisible());
      legend.classList.toggle('is-active', on);
      legend.setAttribute('aria-pressed', String(on));
    });
    if (layers) layers.addEventListener('click', () => {
      const mv = mapView(); if (!mv || !mv.setLayersControlVisible) return;
      const on = mv.isLayersControlVisible ? !mv.isLayersControlVisible() : true;
      mv.setLayersControlVisible(on);
      layers.classList.toggle('is-active', on);
      layers.setAttribute('aria-pressed', String(on));
    });
    // (Sin recarga en moveend: los NOTAMs extranjeros se cargan una vez para
    //  toda la región — ver FOREIGN_BBOX — para no recentrar/recargar al
    //  desplazar el mapa.)
  }

  // ── Carga NotamHub: wiring de inputs/presets ──────────────────────
  function wireUpload() {
    const btn = $('#btn-notamhub-load');
    if (btn) btn.addEventListener('click', handleNotamHubLoad);
    $$('[data-notamhub-preset]').forEach((b) => {
      b.addEventListener('click', () => applyPreset(b.dataset.notamhubPreset));
    });
    const fc = $('#notamhub-foreign');
    if (fc) fc.addEventListener('change', () => {
      if (fc.checked && state.national.length) { ensureMap(); loadForeign(true); }
      else if (!fc.checked) { state.foreign = []; assignUids(); renderAll(); }
    });
  }
  function applyPreset(p) {
    const at = $('#notamhub-at');
    const atTo = $('#notamhub-at-to');
    const fmt = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
    const now = new Date();
    if (p === 'clear') { if (at) at.value = ''; if (atTo) atTo.value = ''; return; }
    if (at) at.value = fmt(now);
    const hours = { now: 0, next6: 6, next24: 24, next48: 48, next7d: 168 }[p];
    if (atTo) atTo.value = hours ? fmt(new Date(now.getTime() + hours * 3600000)) : '';
  }

  // ── Ajustes ───────────────────────────────────────────────────────
  let _settingsInit = false;
  function initSettingsTab() {
    const s = settings();
    if (!s) return;
    // Sincroniza inputs [data-setting] <-> store.
    $$('#tab-settings [data-setting]').forEach((input) => {
      const path = input.dataset.setting;
      const val = s.get(path);
      if (input.type === 'range' || input.type === 'number') {
        const num = path.indexOf('opacity.') === 0 ? Math.round((val == null ? 1 : val) * 100) : (val == null ? '' : val);
        input.value = num;
        const out = input.parentElement && input.parentElement.querySelector('.settings-value');
        if (out) out.textContent = (path.indexOf('opacity.') === 0) ? (num + '%') : num;
      } else if (input.type === 'checkbox') {
        input.checked = !!val;
      } else {
        input.value = val == null ? '' : val;
      }
      if (!_settingsInit) {
        input.addEventListener('input', () => {
          let v = input.value;
          if (path.indexOf('opacity.') === 0) {
            v = Math.max(0, Math.min(100, parseInt(input.value, 10) || 0)) / 100;
            const out = input.parentElement && input.parentElement.querySelector('.settings-value');
            if (out) out.textContent = Math.round(v * 100) + '%';
          } else if (input.type === 'number') { v = input.value === '' ? '' : Number(input.value); }
          s.set(path, v);
          const mv = mapView();
          if (path.indexOf('opacity.') === 0 && mv && mv.applyOpacities) { try { mv.applyOpacities(); } catch (_) {} }
        });
      }
    });
    // Idioma
    const lang = i18n() && i18n().getLang ? i18n().getLang() : 'es';
    $$('input[name="i18n-lang"]').forEach((r) => {
      r.checked = r.value === lang;
      if (!_settingsInit) r.addEventListener('change', () => {
        if (r.checked && i18n() && i18n().setLang) { i18n().setLang(r.value); }
      });
    });
    if (!_settingsInit) {
      const reset = $('#btn-settings-reset');
      if (reset) reset.addEventListener('click', () => {
        if (!confirm('¿Restaurar todos los ajustes a los valores de fábrica?')) return;
        s.reset(); _settingsInit = false; initSettingsTab();
        const mv = mapView(); if (mv && mv.applyOpacities) { try { mv.applyOpacities(); } catch (_) {} }
      });
      const showW = $('#btn-settings-show-welcome');
      if (showW) showW.addEventListener('click', () => {
        try { localStorage.removeItem(LS_WELCOME); } catch (_) {}
        showWelcome(true);
      });
    }
    _settingsInit = true;
  }

  // ── Modal de bienvenida ───────────────────────────────────────────
  function showWelcome(force) {
    const modal = $('#welcome-modal');
    if (!modal) return;
    let acked = false;
    try { acked = localStorage.getItem(LS_WELCOME) === '1'; } catch (_) {}
    if (acked && !force) { modal.style.display = 'none'; return; }
    modal.style.display = 'flex';
  }
  function wireWelcome() {
    const modal = $('#welcome-modal');
    if (!modal) return;
    const check = $('#welcome-check');
    const accept = $('#welcome-accept');
    if (check && accept) check.addEventListener('change', () => { accept.disabled = !check.checked; });
    if (accept) accept.addEventListener('click', () => {
      try { localStorage.setItem(LS_WELCOME, '1'); } catch (_) {}
      modal.style.display = 'none';
    });
  }

  // ── Bridge para shell.js ──────────────────────────────────────────
  NH.app = {
    ensureMap,
    initSettingsTab,
    getTsas: () => allItems(),
    onDatosOpen: () => { renderTable(); updateFilterCounts(); },
    refreshExportUI: function () {},
  };

  // ── Bootstrap ─────────────────────────────────────────────────────
  function boot() {
    const s = settings();
    if (s && s.load) s.load();
    wireWelcome();
    showWelcome(false);
    wireUpload();
    wireFilter();
    wireSelection();
    wireSortHeaders();
    updateSortIndicators();
    // El mapa lo inicializa shell.js (mueve #map y llama ensureMap); cuando
    // ya esté listo, cableamos su toolbar. Reintentamos por si shell tarda.
    const tryToolbar = () => { if (window._tsa_leaflet_map) { wireMapToolbar(); } else { setTimeout(tryToolbar, 120); } };
    tryToolbar();
    if (i18n() && i18n().applyToDOM) { try { i18n().applyToDOM(); } catch (_) {} }
    if (s && s.onChange) s.onChange(() => { const mv = mapView(); if (mv && mv.applyOpacities) { try { mv.applyOpacities(); } catch (_) {} } });
    console.info('[app] NotamHub listo.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
