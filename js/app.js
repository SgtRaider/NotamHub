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

  const state = {
    national: [],     // TSAs/NOTAMs nacionales (notamHub.convertTSAsToInternal)
    foreign:  [],     // NOTAMs extranjeros con geometría (convertForeignToInternal)
    selected: new Set(),
    filter: { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', tsaType: 'all', activeNow: false },
    mapReady: false,
    at: '',
    atTo: '',
  };

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
    const items = allItems();
    if (!tbody) return;
    tbody.innerHTML = '';
    const sf = scheduleFmt();
    const f = filters();
    items.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.uid = t._uid;
      const inFilter = f && f.matches ? safeMatches(f, t) : true;
      if (!inFilter) tr.classList.add('out-of-filter');
      const checked = state.selected.has(t._uid) ? 'checked' : '';
      const windows = t._isPermanent
        ? '<span class="badge">Permanente</span>'
        : ((t.schedules && sf && sf.listHTML) ? sf.listHTML(t.schedules) : '');
      const origin = t._foreign
        ? ('Ext.' + (t.country ? ' ' + esc(t.country) : '') + catBadgeHTML(t))
        : 'Nacional';
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="tsa-row-cb" ' + checked + '></td>' +
        '<td>' + esc(t.name || '—') + '</td>' +
        '<td>' + origin + '</td>' +
        '<td>' + esc((t.vertical && t.vertical.lowerLabel) || 'GND') + '</td>' +
        '<td>' + esc((t.vertical && t.vertical.upperLabel) || 'UNL') + '</td>' +
        '<td>' + ((t.polygon && t.polygon.length) || 0) + '</td>' +
        '<td class="col-windows">' + (windows || '<span class="dim">—</span>') + '</td>';
      tbody.appendChild(tr);
    });
    if (wrap) {
      wrap.classList.toggle('hidden', items.length === 0);
    }
    const countBadge = $('#tsa-count');
    if (countBadge) countBadge.textContent = items.length ? String(items.length) : '';
    updateSelectionSummary();
  }

  function safeMatches(f, t) { try { return f.matches(t, state.filter); } catch (_) { return true; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function catBadgeHTML(t) {
    const nh = notamHub();
    const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(t.category) : null;
    if (!meta) return '';
    return ' <span class="cat-badge" style="background:' + meta.color + '">' + esc(meta.label) + '</span>';
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
      // NOTAMs extranjeros (FIRs colindantes) por área visible del mapa.
      const wantForeign = $('#notamhub-foreign') && $('#notamhub-foreign').checked;
      if (wantForeign) { await loadForeign(false); }
      else { state.foreign = []; }
      assignUids();
      selectAll();
      setStatus(statusEl, state.national.length + ' áreas nacionales' +
        (state.foreign.length ? (' · ' + state.foreign.length + ' extranjeras') : '') + ' cargadas.', 'ok');
      renderAll();
      fitToData();
    } catch (err) {
      console.error('[app] carga NotamHub falló:', err);
      setStatus(statusEl, 'Error al consultar NotamHub: ' + (err && err.message || err), 'err');
    }
  }

  async function loadForeign(rerender) {
    const nh = notamHub();
    if (!nh || !nh.fetchForeignByBbox) return;
    const bbox = currentBbox();
    if (!bbox) return;
    try {
      const params = {};
      if (state.at) params.at = state.at;
      const apiList = await nh.fetchForeignByBbox(bbox, params);
      state.foreign = nh.convertForeignToInternal ? (nh.convertForeignToInternal(apiList, state.at ? new Date(state.at) : new Date()) || []) : [];
      assignUids();
      // Nuevos extranjeros entran seleccionados por defecto.
      state.foreign.forEach((t) => state.selected.add(t._uid));
      if (rerender) renderAll();
    } catch (err) { console.warn('[app] foreign bbox falló:', err); }
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
    // Recarga de NOTAMs extranjeros al mover el mapa (si está activado).
    const lmap = window._tsa_leaflet_map;
    if (lmap && lmap.on) {
      let t = null;
      lmap.on('moveend', () => {
        const want = $('#notamhub-foreign') && $('#notamhub-foreign').checked;
        if (!want) return;
        clearTimeout(t);
        t = setTimeout(() => { loadForeign(true); }, 500);
      });
    }
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
