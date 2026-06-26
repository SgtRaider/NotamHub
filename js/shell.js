// shell.js — Shell "B1" de NotamHub (versión civil, reducida).
//
// Adaptado del b1Layout.js de TSAgestor. Construye el armazón de la UI:
// cabecera con stepper de iconos, panel lateral redimensionable, mapa a
// pantalla completa (#map vive siempre en .b1-map-zone) y un cajón inferior
// para tablas (la tabla de TSAs). Reducido a 4 secciones civiles:
//   Inicio · Datos (cargar NOTAMs/TSAs) · Briefing (NOTAMs + meteo) · Ajustes
//
// El mapa nunca se oculta: las secciones del stepper mueven el contenido de
// cada <section id="tab-*"> al panel lateral. Reutiliza el CSS .b1-* de
// styles.css (mismas clases que TSAgestor).
(function () {
  'use strict';

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/>' +
      '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 18l9 5 9-5"/></svg>',
    briefing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 18a5 5 0 0 1 0-10 7 7 0 0 1 13 4 4 4 0 0 1-2 7H7z"/>' +
      '<path d="M13 11l-3 5h4l-2 4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>',
  };

  // Secciones del stepper. tabId = <section id> a relocar en el panel.
  const SECTIONS = [
    { id: 'home',     icon: ICONS.home,     label: 'Inicio',   tabId: 'tab-home',     drawer: [] },
    { id: 'datos',    icon: ICONS.data,     label: 'Datos',    tabId: 'tab-upload',   drawer: [
      { id: 'tsa-table-wrap', label: 'NOTAMs / TSAs cargadas' },
    ]},
    { id: 'briefing', icon: ICONS.briefing, label: 'Briefing', tabId: 'tab-notams',   drawer: [] },
    { id: 'settings', icon: ICONS.settings, label: 'Ajustes',  tabId: 'tab-settings', drawer: [] },
  ];

  const STORAGE_KEY = 'notamhub_shell_layout';
  const DEFAULTS = {
    section:     'home',
    panelState:  'open',      // open | collapsed | hidden
    drawerState: 'closed',    // closed | open | collapsed
    drawerItem:  null,
    panelW:      480,
    drawerH:     0.42,
  };

  let state = Object.assign({}, DEFAULTS);
  let _shell, _panel, _panelBody, _panelRail, _drawer, _drawerBody, _mapZone;
  const _drawerItemOrigin = new Map();

  function isEnabled() { return document.body.classList.contains('b1'); }
  function _app() { return (window.NotamHub && window.NotamHub.app) || {}; }

  function _loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (_) {}
  }
  function _saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function init() {
    if (!isEnabled()) return;
    _loadState();
    _buildShell();
    _wireStepper();
    _wireResize();
    _wireKeyboard();
    _wireDrawerControls();
    _adoptFilterBar();
    _moveMap();
    try { if (_app().ensureMap) _app().ensureMap(); }
    catch (err) { console.warn('[shell] ensureMap falló:', err); }
    _moveSection(state.section);
    _applyPanelState();
    _wireNetStatus();
    _wirePwaInstall();
    setTimeout(_invalidateMapSize, 60);
    console.info('[shell] activado, sección=', state.section);
  }

  // ── Construye la estructura B1 e inyecta al principio del body ─────
  function _buildShell() {
    _shell = document.createElement('div');
    _shell.className = 'b1-shell';
    _shell.setAttribute('data-panel-state', state.panelState);
    _shell.setAttribute('data-drawer-state', state.drawerState);
    _shell.innerHTML = `
      <header class="b1-header">
        <div class="b1-brand">
          <img src="assets/icon.svg" alt="" aria-hidden="true" width="28" height="28">
          <span class="b1-brand-name">NotamHub</span>
        </div>
        <nav class="b1-stepper" role="tablist" aria-label="Secciones de la aplicación"></nav>
        <div class="b1-actions">
          <span id="b1-net-status" class="b1-net-status" role="status" aria-live="polite" title="Estado de conexión"></span>
          <button class="b1-icon-btn" id="b1-pwa-install" title="Instalar como aplicación" aria-label="Instalar app" style="display:none">⤵</button>
          <button class="b1-icon-btn" id="b1-toggle-panel" title="Tecla M: alterna panel" aria-label="Alternar panel">⇔</button>
        </div>
      </header>
      <div class="b1-main">
        <aside class="b1-panel" id="b1-panel">
          <div class="b1-panel-rail" id="b1-panel-rail"></div>
          <div class="b1-panel-body" id="b1-panel-body"></div>
          <div class="b1-panel-resize" id="b1-panel-resize" role="separator" aria-orientation="vertical" aria-label="Redimensionar panel"></div>
        </aside>
        <main class="b1-map-zone" id="b1-map-zone"></main>
        <section class="b1-drawer" id="b1-drawer" aria-label="Cajón inferior con tablas">
          <div class="b1-drawer-resize" id="b1-drawer-resize" role="separator" aria-orientation="horizontal" aria-label="Redimensionar drawer"></div>
          <div class="b1-drawer-head">
            <div class="b1-drawer-tabs" id="b1-drawer-tabs"></div>
            <button class="b1-icon-btn" id="b1-drawer-collapse" title="Colapsar" aria-label="Colapsar drawer">↧</button>
            <button class="b1-icon-btn" id="b1-drawer-close" title="Cerrar" aria-label="Cerrar drawer">✕</button>
          </div>
          <div class="b1-drawer-body" id="b1-drawer-body"></div>
        </section>
      </div>
    `;
    document.body.insertBefore(_shell, document.body.firstChild);
    if (state.panelW > 200) _shell.style.setProperty('--b1-panel-w', state.panelW + 'px');
    if (state.drawerH > 0.1 && state.drawerH < 0.9) _shell.style.setProperty('--b1-drawer-h', (state.drawerH * 100) + 'vh');

    const stepperEl = _shell.querySelector('.b1-stepper');
    const railEl    = _shell.querySelector('.b1-panel-rail');
    for (const sec of SECTIONS) {
      const btn = document.createElement('button');
      btn.className = 'b1-step';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-section', sec.id);
      btn.innerHTML = `<span class="b1-step-icon">${sec.icon}</span><span class="b1-step-label">${sec.label}</span>`;
      stepperEl.appendChild(btn);
      const railBtn = btn.cloneNode(true);
      railBtn.title = sec.label;
      railEl.appendChild(railBtn);
    }
    _panel     = _shell.querySelector('#b1-panel');
    _panelBody = _shell.querySelector('#b1-panel-body');
    _panelRail = _shell.querySelector('#b1-panel-rail');
    _drawer    = _shell.querySelector('#b1-drawer');
    _drawerBody = _shell.querySelector('#b1-drawer-body');
    _mapZone   = _shell.querySelector('#b1-map-zone');
  }

  // ── Stepper ───────────────────────────────────────────────────────
  function _wireStepper() {
    _shell.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.b1-step');
      if (!btn) return;
      e.preventDefault();
      const id = btn.dataset.section;
      if (id && id !== state.section) _moveSection(id);
    });
  }

  function _oldMain() {
    return document.querySelector('#app > main') || document.querySelector('main');
  }

  function _moveSection(newId) {
    // Devuelve la sección anterior a su sitio original.
    const prev = SECTIONS.find(s => s.id === state.section);
    if (prev) {
      const prevTab = document.getElementById(prev.tabId);
      if (prevTab && prevTab.parentElement === _panelBody) {
        const om = _oldMain();
        if (om) om.appendChild(prevTab);
        prevTab.classList.remove('active');
        prevTab.style.display = '';
      }
      _returnDrawerItems(prev);
    }
    // Trae la nueva sección al panel.
    const sec = SECTIONS.find(s => s.id === newId);
    if (!sec) return;
    const tab = document.getElementById(sec.tabId);
    if (tab) {
      _panelBody.appendChild(tab);
      tab.classList.add('active');
      tab.style.display = 'flex';
    }
    state.section = newId;
    _shell.querySelectorAll('.b1-step').forEach(b => {
      const on = b.dataset.section === newId;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected');
    });
    _renderDrawerTabs(sec);
    // Hooks de inicialización por sección (bridge con app.js).
    try {
      const app = _app();
      if (newId === 'settings' && app.initSettingsTab) app.initSettingsTab();
      if (newId === 'datos'    && app.onDatosOpen)     app.onDatosOpen();
      const nv = window.NotamHub && window.NotamHub.notamView;
      if (newId === 'briefing' && nv && nv.onTabOpen) nv.onTabOpen();
    } catch (err) { console.warn('[shell] init de sección falló:', err); }
    _saveState();
    setTimeout(_invalidateMapSize, 250);
  }

  function _returnDrawerItems(sec) {
    const om = _oldMain();
    for (const it of (sec.drawer || [])) {
      const el = document.getElementById(it.id);
      if (el && el.parentElement === _drawerBody) {
        const origin = _drawerItemOrigin.get(it.id);
        const parentTab = document.getElementById(sec.tabId);
        const target = origin || parentTab || om;
        if (target) { target.appendChild(el); el.style.display = ''; }
      }
    }
  }

  function _renderDrawerTabs(sec) {
    const tabsEl = _shell.querySelector('#b1-drawer-tabs');
    tabsEl.innerHTML = '';
    const items = sec.drawer || [];
    if (!items.length) {
      if (state.drawerState !== 'closed') {
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
      }
      return;
    }
    items.forEach((it, i) => {
      const el = document.getElementById(it.id);
      if (el && !_drawerItemOrigin.has(it.id)) _drawerItemOrigin.set(it.id, el.parentElement);
      const btn = document.createElement('button');
      btn.className = 'b1-drawer-tab';
      btn.dataset.drawerItem = it.id;
      btn.textContent = it.label;
      tabsEl.appendChild(btn);
      if (i === 0 && !state.drawerItem) state.drawerItem = it.id;
    });
    _activateDrawerItem(state.drawerItem || items[0].id);
  }

  function _activateDrawerItem(itemId) {
    let any = false;
    _shell.querySelectorAll('.b1-drawer-tab').forEach(b => {
      const on = b.dataset.drawerItem === itemId;
      b.classList.toggle('is-active', on);
      if (on) any = true;
    });
    // Mueve sólo el item activo al drawer-body; el resto vuelve a su origen.
    const sec = SECTIONS.find(s => s.id === state.section);
    for (const it of (sec ? sec.drawer : [])) {
      const el = document.getElementById(it.id);
      if (!el) continue;
      if (it.id === itemId) {
        _drawerBody.appendChild(el);
        el.style.display = '';
        el.classList.remove('hidden');
      } else if (el.parentElement === _drawerBody) {
        const origin = _drawerItemOrigin.get(it.id);
        if (origin) origin.appendChild(el);
      }
    }
    state.drawerItem = itemId;
    if (any && state.drawerState === 'closed') {
      state.drawerState = 'open';
      _shell.setAttribute('data-drawer-state', 'open');
    }
    _saveState();
    setTimeout(_invalidateMapSize, 200);
  }

  function _wireDrawerControls() {
    _shell.addEventListener('click', (e) => {
      const tab = e.target.closest && e.target.closest('.b1-drawer-tab');
      if (tab) { _activateDrawerItem(tab.dataset.drawerItem); return; }
      if (e.target.id === 'b1-drawer-collapse') {
        state.drawerState = state.drawerState === 'collapsed' ? 'open' : 'collapsed';
        _shell.setAttribute('data-drawer-state', state.drawerState);
        _saveState(); setTimeout(_invalidateMapSize, 200);
      }
      if (e.target.id === 'b1-drawer-close') {
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
        _saveState(); setTimeout(_invalidateMapSize, 200);
      }
    });
  }

  // ── Filtro de TSAs: se adopta dentro de la sección Datos ──────────
  function _adoptFilterBar() {
    const bar = document.getElementById('filter-bar');
    const host = document.getElementById('tab-upload');
    if (bar && host && bar.parentElement !== host) {
      host.insertBefore(bar, host.firstChild);
      bar.classList.remove('hidden');
    }
  }

  // ── Mueve #map + toolbar a la zona de mapa (siempre visible) ──────
  function _moveMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) { console.warn('[shell] no se encontró #map'); return; }
    if (mapEl.parentElement === _mapZone) return;
    const mapTab = document.getElementById('tab-map');
    const toolbar = mapTab ? mapTab.querySelector('.toolbar') : null;
    _mapZone.appendChild(mapEl);
    if (toolbar) { toolbar.classList.add('b1-map-toolbar'); _mapZone.appendChild(toolbar); }
    _invalidateMapSize();
  }

  function _invalidateMapSize() {
    const lmap = window._tsa_leaflet_map;
    if (lmap && lmap.invalidateSize) { try { lmap.invalidateSize(); } catch (_) {} }
  }

  // ── Panel: redimensionar + colapsar ──────────────────────────────
  function _applyPanelState() {
    _shell.setAttribute('data-panel-state', state.panelState);
    setTimeout(_invalidateMapSize, 200);
  }
  function _cyclePanel() {
    state.panelState = state.panelState === 'open' ? 'collapsed'
      : state.panelState === 'collapsed' ? 'hidden' : 'open';
    _applyPanelState();
    _saveState();
  }
  function _wireResize() {
    const toggle = _shell.querySelector('#b1-toggle-panel');
    if (toggle) toggle.addEventListener('click', _cyclePanel);
    // Rail (modo colapsado): clic en un step expande y navega.
    _panelRail.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.b1-step');
      if (!btn) return;
      state.panelState = 'open';
      _applyPanelState();
      const id = btn.dataset.section;
      if (id && id !== state.section) _moveSection(id);
      _saveState();
    });
    _dragResize(_shell.querySelector('#b1-panel-resize'), 'x');
    _dragResize(_shell.querySelector('#b1-drawer-resize'), 'y');
  }
  function _dragResize(handle, axis) {
    if (!handle) return;
    let active = false;
    const onMove = (ev) => {
      if (!active) return;
      const pt = ev.touches ? ev.touches[0] : ev;
      if (axis === 'x') {
        const w = Math.max(300, Math.min(760, pt.clientX - _shell.getBoundingClientRect().left));
        state.panelW = w;
        _shell.style.setProperty('--b1-panel-w', w + 'px');
      } else {
        const h = Math.max(0.18, Math.min(0.8, (window.innerHeight - pt.clientY) / window.innerHeight));
        state.drawerH = h;
        _shell.style.setProperty('--b1-drawer-h', (h * 100) + 'vh');
      }
      _invalidateMapSize();
    };
    const onUp = () => { active = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); _saveState(); };
    handle.addEventListener('mousedown', () => { active = true; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); });
  }
  function _wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'm' || e.key === 'M') _cyclePanel();
      if (e.key === 'Escape' && state.drawerState !== 'closed') {
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
        _saveState(); setTimeout(_invalidateMapSize, 200);
      }
    });
  }

  // ── Chip de estado de red ─────────────────────────────────────────
  function _wireNetStatus() {
    const el = document.getElementById('b1-net-status');
    if (!el) return;
    const paint = () => {
      const on = navigator.onLine;
      el.textContent = on ? '● Online' : '○ Offline';
      el.classList.toggle('is-offline', !on);
      el.title = on ? 'Conectado' : 'Sin conexión — sólo funciones offline';
    };
    window.addEventListener('online', paint);
    window.addEventListener('offline', paint);
    paint();
  }

  // ── Instalación PWA ───────────────────────────────────────────────
  function _wirePwaInstall() {
    const btn = document.getElementById('b1-pwa-install');
    if (!btn) return;
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferred = e; btn.style.display = '';
    });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) {}
      deferred = null; btn.style.display = 'none';
    });
    window.addEventListener('appinstalled', () => { btn.style.display = 'none'; });
  }

  window.NotamHub = window.NotamHub || {};
  window.NotamHub.shell = { init, isEnabled };
})();

// Auto-init en DOMContentLoaded si el body tiene .b1.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.NotamHub && window.NotamHub.shell) window.NotamHub.shell.init();
  });
} else {
  if (window.NotamHub && window.NotamHub.shell) window.NotamHub.shell.init();
}
