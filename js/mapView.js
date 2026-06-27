// Vista de mapa Leaflet OFFLINE: usa el dataset bundled en offlineGeo.js
// (Iberia + islas + costas + ciudades + retícula lat/lon) en lugar de tiles
// OSM. Los polígonos TSA se siguen pintando encima en render(tsas).

// Banner se mantiene actualizado leyendo el ?v=NN del propio script tag
// para que el numero coincida con el CACHE_VERSION del SW sin tener que
// editarlo a mano cada vez.
(function () {
  let v = '';
  const scripts = document.getElementsByTagName('script');
  for (const s of scripts) {
    if (s.src && /mapView\.js\?v=/.test(s.src)) {
      v = (s.src.match(/[?&]v=(\d+)/) || [])[1] || '';
      break;
    }
  }
  console.warn(
    `%c[mapView] v${v || '?'} cargado — filtrado JS por zoom (tier-2≥6, tier-3≥8, NAVAID≥7, RNAV≥8). Llama window.NotamHub_zoomDebug() para diagnostico.`,
    'background:#0ea5e9;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold'
  );
})();

// Diagnostico global: imprime estado actual del filtrado por zoom.
window.NotamHub_zoomDebug = function () {
  const mv = window.NotamHub && window.NotamHub.mapView;
  if (!mv) { console.log('mapView no cargado'); return; }
  if (typeof mv._debugZoom === 'function') return mv._debugZoom();
  console.log('Funcion de debug no expuesta');
};

window.NotamHub = window.NotamHub || {};
window.NotamHub.mapView = (function () {
  'use strict';

  const geom = window.NotamHub.geom;

  const BAND_COLORS = {
    low:  '#22c55e',
    mid:  '#f59e0b',
    high: '#ef4444',
  };

  // Colores por tipo de area (NotamHub is_work_area):
  //   - work    = area de trabajo activo -> verde
  //   - transit = area de transito       -> rojo
  // TSAs sin el flag (parser PDF, p.ej.) caen al esquema antiguo
  // BAND_COLORS basado en la banda vertical.
  const AREA_COLORS = {
    work:    '#22c55e',
    transit: '#ef4444',
  };

  // Trazo distintivo para NOTAMs extranjeros (llegan como objetos
  // TSA-shaped con _foreign:true por el mismo render(tsas)). Cian/teal
  // para separarlos visualmente de las TSAs nacionales.
  const FOREIGN_COLOR = '#06b6d4';

  // Decide el color de una TSA: los NOTAMs extranjeros (_foreign) usan un
  // color cian distintivo. Si tiene el flag _isWorkArea (NotamHub), usa
  // AREA_COLORS. Si no, fallback a la banda vertical.
  function tsaColor(tsa) {
    // NOTAM con categoría (nacional o extranjero) -> color de su categoría.
    if (tsa && tsa.category) {
      const nh = window.NotamHub.notamHub;
      const meta = nh && nh.getForeignCategoryMeta ? nh.getForeignCategoryMeta(tsa.category) : null;
      if (meta && meta.color) return meta.color;
    }
    if (tsa && typeof tsa._isWorkArea === 'boolean') {
      return tsa._isWorkArea ? AREA_COLORS.work : AREA_COLORS.transit;
    }
    const band = geom.altitudeBand((tsa && tsa.vertical && tsa.vertical.upperFt) || 0);
    return BAND_COLORS[band];
  }

  // Área aproximada del polígono en grados² (bbox) — para ordenar el render
  // (grandes debajo, pequeñas encima) y aligerar el relleno de áreas enormes.
  function _approxAreaDeg(polygon) {
    if (!polygon || !polygon.length) return 0;
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    for (const p of polygon) {
      if (p[0] < minLa) minLa = p[0]; if (p[0] > maxLa) maxLa = p[0];
      if (p[1] < minLo) minLo = p[1]; if (p[1] > maxLo) maxLo = p[1];
    }
    return Math.max(0, (maxLa - minLa)) * Math.max(0, (maxLo - minLo));
  }

  const SEA_COLOR  = '#cce4f6';
  const LAND_FILL  = '#f3e6c4';
  const LAND_LINE  = '#7d6843';

  let map = null;
  let layerGroup = null;
  let _layersControl = null;
  let legend = null;
  let countryLayer = null;

  function settingsGet(path, fallback) {
    const s = window.NotamHub && window.NotamHub.settings;
    return s ? s.get(path, fallback) : fallback;
  }

  // Bounding box que enmarca España peninsular + Baleares + sur de Francia,
  // pensado para ser la vista por defecto cuando no hay TSAs ni ruta.
  const DEFAULT_BOUNDS = [[35.5, -10], [44, 5]];

  // Países colindantes con España (a efectos del mapa). Marruecos esta al
  // otro lado del Estrecho pero comparte espacio aereo cercano (Gibraltar).
  // Argelia se incluye por proximidad a Baleares aunque no sea fronterizo
  // terrestre. Sus capitales se muestran siempre; el resto del mundo solo
  // aparece al hacer zoom.
  const BORDERING_COUNTRIES = new Set([
    'Spain', 'Portugal', 'France', 'Andorra', 'Morocco',
    'United Kingdom', // Gibraltar aparece bajo UK en el dataset.
    'Algeria',
  ]);

  // Filtrado por zoom basado en JS (mas robusto que CSS: anyade/quita el
  // marcador del mapa o de su grupo segun el zoom actual).
  //
  // _cityItems: [{marker, tooltip, tier}]  - tier 1=siempre, 2=zoom>=6, 3=zoom>=8
  // _wpItems:   [{marker, tooltip, type, group}]
  //               type='NAVAID' -> zoom>=7
  //               type='RNAV'   -> zoom>=8
  const _cityItems = [];
  const _wpItems   = [];
  const _aeroItems = [];   // aeródromos: { marker, tooltip, tier(2=large,3=medium), group }
  const ZOOM_TIER_2_CITY = 6;
  const ZOOM_TIER_3_CITY = 8;
  const ZOOM_NAVAID      = 7;
  const ZOOM_RNAV        = 8;

  function _applyZoomVisibility() {
    if (!map) return;
    const z = map.getZoom();
    // Ciudades: anyadir/quitar directamente del mapa.
    for (const it of _cityItems) {
      const thresh = it.tier === 1 ? 0
                   : it.tier === 2 ? ZOOM_TIER_2_CITY
                   : ZOOM_TIER_3_CITY;
      const show = z >= thresh;
      if (show) {
        if (!map.hasLayer(it.marker))  it.marker.addTo(map);
        if (!map.hasLayer(it.tooltip)) it.tooltip.addTo(map);
      } else {
        if (map.hasLayer(it.marker))  map.removeLayer(it.marker);
        if (map.hasLayer(it.tooltip)) map.removeLayer(it.tooltip);
      }
    }
    // Waypoints: anyadir/quitar del grupo (el grupo lo controla el toggle
    // de capas. Si el grupo esta en el mapa, anyadir al grupo lo muestra).
    for (const it of _wpItems) {
      const thresh = it.type === 'NAVAID' ? ZOOM_NAVAID : ZOOM_RNAV;
      const show = z >= thresh;
      if (show) {
        if (!it.group.hasLayer(it.marker))  it.group.addLayer(it.marker);
        if (!it.group.hasLayer(it.tooltip)) it.group.addLayer(it.tooltip);
      } else {
        if (it.group.hasLayer(it.marker))  it.group.removeLayer(it.marker);
        if (it.group.hasLayer(it.tooltip)) it.group.removeLayer(it.tooltip);
      }
    }
    // Aeródromos: gating por zoom (large z>=6, medium z>=8) dentro de su
    // grupo (toggle). Igual patrón que waypoints.
    for (const it of _aeroItems) {
      const thresh = it.tier === 2 ? ZOOM_AERO_LARGE : ZOOM_AERO_MEDIUM;
      const show = z >= thresh;
      if (show) {
        if (!it.group.hasLayer(it.marker)) it.group.addLayer(it.marker);  // su tooltip (bound) le sigue
      } else if (it.group.hasLayer(it.marker)) {
        it.group.removeLayer(it.marker);
      }
    }
    console.info('[mapView] zoom=' + z + ' visibles -> ciudades:'
      + _cityItems.filter(i => map.hasLayer(i.marker)).length + '/' + _cityItems.length
      + ' waypoints:' + _wpItems.filter(i => i.group.hasLayer(i.marker)).length + '/' + _wpItems.length
      + ' aeródromos:' + _aeroItems.filter(i => i.group.hasLayer(i.marker)).length + '/' + _aeroItems.length);
  }

  let _baseSat = null, _baseStreet = null;

  function init(elId) {
    if (map) {
      window._tsa_leaflet_map = map;
      return map;
    }
    map = L.map(elId, {
      zoomControl: true,
      worldCopyJump: false,
      minZoom: 3,
      maxZoom: 18,
      attributionControl: true,
    });
    map.setView([40, -4], 5);

    const container = document.getElementById(elId);
    if (container) container.style.background = SEA_COLOR;

    // Base SATÉLITE (Esri World Imagery, sin API key) + alternativa callejero
    // (OpenStreetMap). Se eligen desde el control de capas.
    // crossOrigin: los tiles se piden con CORS (Esri y OSM responden
    // Access-Control-Allow-Origin:*). Necesario para poder volcar el mapa a
    // un <canvas> sin "contaminarlo" al exportar el PDF (captureForPdf).
    _baseSat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, crossOrigin: 'anonymous', attribution: 'Imagery © Esri · Maxar · Earthstar Geographics' });
    _baseStreet = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, crossOrigin: 'anonymous', attribution: '© OpenStreetMap contributors' });
    _baseSat.addTo(map);

    // Etiquetas de ciudades para orientación (la base offline de países y la
    // retícula se sustituyen por la imagen de satélite).
    drawCities();

    layerGroup = L.layerGroup().addTo(map);
    addLegend();
    setupMeteoPane();
    addAirwayLayers();
    _initSettingsHook();
    _applyZoomVisibility();
    map.on('zoomend', _applyZoomVisibility);
    // Expone el mapa para modulos externos (trafficLayer, etc.) que
    // necesitan una referencia al objeto Leaflet sin tener que repetir
    // toda la init.
    window._tsa_leaflet_map = map;
    return map;
  }

  // Apilamiento de paneles (de abajo arriba):
  //   overlayPane (400)    → fondo de países, retícula
  //   meteoTiles (410)     → tiles RainViewer / EUMETView CTH
  //   tsaPane (440)        → TSAs y polígonos NOTAM
  //   markerPane (600)     → marcadores METAR/TAF y ciudades
  //   tooltipPane (650)
  //   popupPane (700)
  function setupMeteoPane() {
    const ensure = (name, z, transparent) => {
      if (!map.getPane(name)) {
        map.createPane(name);
        map.getPane(name).style.zIndex = String(z);
        if (transparent) map.getPane(name).style.pointerEvents = 'none';
      }
    };
    // Tiles meteo no deben capturar clics (transparentes a eventos).
    ensure('meteoTiles',      410, true);
    // Límites de países (contornos) por encima de la meteo, bajo las TSAs.
    ensure('bordersPane',     425, true);
    // TSAs / NOTAMs sí son clicables (popup, tooltip).
    ensure('tsaPane',         440, false);
  }

  // Capa de LÍMITES DE PAÍSES (solo contornos, sin relleno) a partir de los
  // datos offline (offlineGeo.countries, Natural Earth 1:50m en la región).
  // Para que las divisiones se vean nítidas SOBRE el satélite usamos doble
  // trazo: un "casing" oscuro ancho debajo + una línea clara fina encima.
  function buildCountryBordersLayer() {
    const geo = window.NotamHub.offlineGeo;
    const data = geo && (geo.borders || geo.countries);
    if (!data || !L.geoJSON) return null;
    const grp = L.layerGroup();
    L.geoJSON(data, { pane: 'bordersPane', interactive: false,
      style: { color: '#0b1020', weight: 4.2, opacity: 0.6, fill: false, lineCap: 'round', lineJoin: 'round' } }).addTo(grp);
    L.geoJSON(data, { pane: 'bordersPane', interactive: false,
      style: { color: '#ffffff', weight: 1.7, opacity: 1, fill: false, lineCap: 'round', lineJoin: 'round' } }).addTo(grp);
    return grp;
  }

  // Capa de AERÓDROMOS (offlineGeo.aerodromes, OurAirports). Marcadores con
  // etiqueta ICAO, filtrados por zoom: large desde z>=6, medium desde z>=8.
  // Es un toggle del control de capas (apagado por defecto). El gating por
  // zoom lo aplica _applyZoomVisibility leyendo _aeroItems.
  let _aeroGroup = null;
  const ZOOM_AERO_LARGE = 6;
  const ZOOM_AERO_MEDIUM = 8;
  function buildAerodromeLayer() {
    const geo = window.NotamHub.offlineGeo;
    if (!geo || !Array.isArray(geo.aerodromes) || !geo.aerodromes.length) return null;
    _aeroGroup = L.layerGroup();
    for (const a of geo.aerodromes) {
      if (!Number.isFinite(a.la) || !Number.isFinite(a.lo)) continue;
      const isLarge = a.t === 0;
      const marker = L.circleMarker([a.la, a.lo], {
        radius: isLarge ? 4.5 : 3.2,
        color: '#0b1020', weight: 1.2,
        fillColor: '#22d3ee', fillOpacity: 1,
        pane: 'markerPane',
      });
      // Etiqueta ICAO: PERMANENTE solo en los grandes (evita centenares de
      // tooltips en el DOM); en los medianos aparece al pasar el cursor.
      marker.bindTooltip(a.i, {
        permanent: isLarge, direction: 'right', offset: [5, 0],
        className: 'aero-label' + (isLarge ? ' aero-label-large' : ''),
      });
      marker.bindPopup(
        '<div class="aero-popup"><b>' + escapeHTML(a.i) + '</b>' +
        (a.iata ? ' <span class="aero-iata">' + escapeHTML(a.iata) + '</span>' : '') +
        '<br>' + escapeHTML(a.n || '') +
        '<br><span class="dim">' + (isLarge ? 'Aeropuerto principal' : 'Aeródromo') +
        (a.c ? ' · ' + escapeHTML(a.c) : '') + '</span></div>',
        { maxWidth: 260 });
      _aeroItems.push({ marker, tier: isLarge ? 2 : 3, group: _aeroGroup });
    }
    // Al activar el toggle, refresca la visibilidad por zoom inmediatamente.
    _aeroGroup.on('add', () => { try { _applyZoomVisibility(); } catch (_) {} });
    console.info('[mapView] aeródromos cargados:', _aeroItems.length);
    return _aeroGroup;
  }

  // Construye el control de capas SOLO con overlays meteorológicos. Las
  // capas de aerovías y airspace (modulos airways/airspace) fueron
  // eliminadas en NotamHub: aqui ya no se construyen.
  function addAirwayLayers() {
    const overlays = {};
    // Límites de países (contornos sobre el satélite). Encendido por defecto.
    const borders = buildCountryBordersLayer();
    if (borders) { borders.addTo(map); overlays['Límites de países'] = borders; }
    // Aeródromos (OurAirports): encendido por defecto pero filtrado por zoom
    // (large z>=6, medium z>=8), así que a zoom bajo no satura. Toggle propio.
    const aero = buildAerodromeLayer();
    if (aero) { aero.addTo(map); overlays['Aeródromos'] = aero; }
    // Capas meteorológicas — sólo se añaden si el módulo meteoApi está cargado.
    const mapi = window.NotamHub.meteoApi;
    if (mapi) {
      overlays['Nubosidad (RainViewer IR)'] = buildRainviewerLayer();
      // Orden de los toggles EUMETSAT en la lista: CTH, luego LI (rayos),
      // luego RGB Convección. Tres productos via.eumetsat.int con el mismo
      // patron WMS + access_token.
      const cthCfg = mapi.getEumetCthWMS && mapi.getEumetCthWMS();
      const cthTitle = cthCfg && cthCfg.title ? cthCfg.title : 'Cloud Top Height';
      overlays[cthTitle] = buildCthLayer();
      if (mapi.getEumetLightningWMS) {
        const liCfg = mapi.getEumetLightningWMS();
        overlays[(liCfg && liCfg.title) || 'Tormentas eléctricas (MTG · LI)'] =
          buildEumetWmsToggle(mapi.getEumetLightningWMS, 'lightning');
      }
      if (mapi.getEumetConvectionWMS) {
        const conCfg = mapi.getEumetConvectionWMS();
        overlays[(conCfg && conCfg.title) || 'RGB Convección (MSG)'] =
          buildEumetWmsToggle(mapi.getEumetConvectionWMS, 'convection');
      }
      if (mapi.fetchSigmets) {
        overlays['SIGMETs (Iberia + Europa O. + N-África)'] = buildSigmetLayer();
      }
      overlays['METAR / TAF'] = buildMetarLayer();
    }
    const baseLayers = {};
    if (_baseSat) baseLayers['Satélite (Esri)'] = _baseSat;
    if (_baseStreet) baseLayers['Callejero (OSM)'] = _baseStreet;
    if (Object.keys(overlays).length === 0 && Object.keys(baseLayers).length === 0) return;
    _layersControl = L.control.layers(baseLayers, overlays, { position: 'topleft', collapsed: false }).addTo(map);
  }

  // Toggle del control de capas (boton "Capas" en la toolbar del mapa).
  // Al ocultar, conserva el control con sus checkboxes para no perder el
  // estado seleccionado por el usuario.
  function setLayersControlVisible(visible) {
    if (!_layersControl || !_layersControl.getContainer) return;
    const el = _layersControl.getContainer();
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  }
  function isLayersControlVisible() {
    if (!_layersControl || !_layersControl.getContainer) return false;
    const el = _layersControl.getContainer();
    return !!el && el.style.display !== 'none';
  }

  // ── Capas meteorológicas ───────────────────────────────────────────

  let cloudRVTile = null;
  function buildRainviewerLayer() {
    const grp = L.layerGroup();
    grp.on('add', async function () {
      if (cloudRVTile) return;
      // Defensivo: en B1 el contenedor del mapa cambia de tamano cuando
      // el usuario abre/cierra/redimensiona el drawer o el panel sin
      // notificar a Leaflet. Si activa esta capa con el getSize() viejo,
      // L.tileLayer pide tiles para una grid fuera del viewport real
      // y la capa parece no aparecer. Forzamos refresh ANTES de
      // instanciar el tileLayer.
      try { if (map) map.invalidateSize({ pan: false }); } catch (_) {}
      try {
        const data = await window.NotamHub.meteoApi.getRainviewerCloudUrl();
        const attr = data.kind === 'satellite'
          ? '© RainViewer · satélite IR'
          : '© RainViewer · radar (precipitación)';
        cloudRVTile = L.tileLayer(data.url, {
          opacity: settingsGet('opacity.cloudRV', 0.6),
          attribution: attr, maxZoom: 11,
          pane: 'meteoTiles',
          // CORS: si el servidor responde con Access-Control-Allow-Origin,
          // el SW puede cachear los tiles en RUNTIME_CACHE (res.ok pasa
          // a true, deja de ser opaque). RainViewer admite CORS, asi que
          // tras la primera activacion los tiles son instant.
          crossOrigin: 'anonymous',
        });
        cloudRVTile.on('tileerror', function (ev) {
          console.warn('[meteo] RainViewer tileerror:', ev.tile && ev.tile.src);
        });
        grp.addLayer(cloudRVTile);
      } catch (e) {
        console.warn('[meteo] RainViewer:', e.message);
        alert('RainViewer no se pudo cargar:\n' + e.message);
      }
    });
    grp.on('remove', function () {
      if (cloudRVTile) {
        grp.removeLayer(cloudRVTile);
        cloudRVTile = null;
      }
    });
    return grp;
  }

  let cloudCthTile = null;
  let cloudLegendCtl = null;
  function buildCthLayer() {
    const grp = L.layerGroup();
    grp.on('add', function () {
      if (cloudCthTile) return;
      // Defensivo: invalidateSize antes de instanciar el WMS para que
      // calcule la grid de tiles con el tamano real del contenedor en
      // el momento de activacion (ver buildRainviewerLayer).
      try { if (map) map.invalidateSize({ pan: false }); } catch (_) {}
      try {
        const cfg = window.NotamHub.meteoApi.getEumetCthWMS();
        cloudCthTile = L.tileLayer.wms(cfg.url, Object.assign(
          { opacity: settingsGet('opacity.cloudCTH', 0.7), maxZoom: 11, pane: 'meteoTiles',
            // detectRetina: pide tiles 512x512 al WMS y los pinta a su
            // densidad nativa en pantallas HiDPI. Sin esto, EUMETSAT
            // sirve 256x256 y Leaflet upscala (la capa se ve borrosa).
            detectRetina: true },
          cfg.options
        ));
        let firstError = true;
        cloudCthTile.on('tileerror', function (ev) {
          if (firstError) {
            firstError = false;
            console.warn('[meteo] EUMETVIEW CTH tileerror:', ev.tile && ev.tile.src);
          }
        });
        grp.addLayer(cloudCthTile);
        showCloudLegend(cfg);
      } catch (e) {
        console.warn('[meteo] EUMETVIEW CTH:', e.message);
        alert('Cloud Top Height (EUMETSAT) no se pudo cargar:\n' + e.message);
      }
    });
    grp.on('remove', function () {
      if (cloudCthTile) {
        grp.removeLayer(cloudCthTile);
        cloudCthTile = null;
      }
      hideCloudLegend();
    });
    return grp;
  }

  function showCloudLegend(cfg) {
    if (!map) return;
    if (cloudLegendCtl) return;
    cloudLegendCtl = L.control({ position: 'bottomleft' });
    cloudLegendCtl.onAdd = function () {
      const div = L.DomUtil.create('div', 'cloud-legend');
      // La imagen oficial de EUMETSAT etiqueta en metros (320, 4240, 8160,
      // 12080, 16000). Mostramos su gradiente de colores intacto pero
      // tapamos sus etiquetas con un overlay blanco y superponemos las
      // nuestras en FL (mismas posiciones convertidas a niveles de vuelo).
      const legendBlock = cfg.legendUrl
        ? `<div class="cth-legend-stack">
             <img src="${cfg.legendUrl}" alt="Escala de altura"
                  onerror="this.parentNode.outerHTML='<div class=&quot;cloud-legend-bar&quot;></div>'">
             <div class="cth-legend-mask"></div>
             <div class="cth-legend-fl">
               <span style="left:20.4%">FL010</span>
               <span style="left:40.1%">FL140</span>
               <span style="left:59.8%">FL270</span>
               <span style="left:79.5%">FL400</span>
               <span style="left:97%">FL525</span>
             </div>
           </div>`
        : `<div class="cloud-legend-bar"></div>
           <div class="cloud-legend-ticks">
             <span><b>FL030</b><br><i>1 km</i></span>
             <span><b>FL165</b><br><i>5 km</i></span>
             <span><b>FL330</b><br><i>10 km</i></span>
             <span><b>FL490</b><br><i>15 km</i></span>
           </div>`;
      div.innerHTML = `
        <div class="cloud-legend-title">${cfg.title || 'Cloud Top Height'}</div>
        ${legendBlock}
        <div class="cloud-legend-help">altura del tope de nube · niveles de vuelo</div>
        <div class="cloud-legend-attr">${cfg.options.attribution || '© EUMETSAT'}</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    cloudLegendCtl.addTo(map);
  }
  function hideCloudLegend() {
    if (cloudLegendCtl) {
      cloudLegendCtl.remove();
      cloudLegendCtl = null;
    }
  }

  // Construye un toggle generico para los otros productos EUMETSAT (LI AFA
  // y RGB Convection). Mismo patron que buildCthLayer pero sin leyenda CTH
  // especifica: usa una leyenda generica con la imagen del GetLegendGraphic.
  // Cada toggle mantiene su propio state {tile, legend} para que ocultar
  // uno no afecte a los otros.
  const _eumetWmsLayers = {}; // key -> { tile, legendCtl }
  // Mapeo del key del toggle EUMETSAT a la clave de settings para opacidad.
  function _eumetOpacityKey(key) {
    if (key === 'lightning')  return 'opacity.cloudLI';
    if (key === 'convection') return 'opacity.cloudConv';
    return 'opacity.eumetWMS.' + key;
  }
  function buildEumetWmsToggle(getCfg, key) {
    const grp = L.layerGroup();
    grp.on('add', function () {
      const slot = _eumetWmsLayers[key] || (_eumetWmsLayers[key] = { tile: null, legendCtl: null });
      if (slot.tile) return;
      // Defensivo (igual que buildRainviewerLayer / buildCthLayer): el
      // mismo factory cubre LI AFA y RGB Convection.
      try { if (map) map.invalidateSize({ pan: false }); } catch (_) {}
      try {
        const cfg = getCfg();
        slot.tile = L.tileLayer.wms(cfg.url, Object.assign(
          { opacity: settingsGet(_eumetOpacityKey(key), 0.7), maxZoom: 11, pane: 'meteoTiles',
            crossOrigin: 'anonymous',
            detectRetina: true },
          cfg.options
        ));
        // Tileerror suele ser inocuo: tiles en el borde del disco MSG /
        // MTG (cobertura geoestacionaria limitada) devuelven 404. Solo
        // avisamos si hay un patron sistematico (>=10 fallos en una
        // activacion) que sugiere un problema real (servidor caido,
        // capa retirada, TIME invalido, etc.).
        let errorCount = 0;
        const ERR_THRESHOLD = 10;
        slot.tile.on('tileerror', function (ev) {
          errorCount++;
          if (errorCount === ERR_THRESHOLD) {
            console.warn(`[meteo] EUMETVIEW ${key}: >=${ERR_THRESHOLD} tileerrors. ` +
              `Posible capa no disponible. Ultimo URL fallido:`,
              (ev && ev.tile && ev.tile.src) || '');
          }
        });
        grp.addLayer(slot.tile);
        showGenericCloudLegend(cfg, key);
      } catch (e) {
        console.warn('[meteo] EUMETVIEW ' + key + ':', e.message);
        alert((cfg && cfg.title || key) + ' no se pudo cargar:\n' + e.message);
      }
    });
    grp.on('remove', function () {
      const slot = _eumetWmsLayers[key];
      if (!slot) return;
      if (slot.tile) {
        grp.removeLayer(slot.tile);
        slot.tile = null;
      }
      hideGenericCloudLegend(key);
    });
    return grp;
  }

  // Leyenda flotante simple (sin overlay de FL) — para los productos que no
  // miden altitud. Una por capa para que coexistan sin tapar la CTH.
  // Por capa:
  //   - convection -> SIN leyenda (la imagen GetLegendGraphic del RGB no
  //     aporta nada util visualmente)
  //   - lightning  -> leyenda custom con gradiente densidad de rayos
  //   - resto      -> imagen GetLegendGraphic estandar
  function showGenericCloudLegend(cfg, key) {
    if (!map) return;
    if (key === 'convection') return;       // sin leyenda por decision UX
    const slot = _eumetWmsLayers[key] || (_eumetWmsLayers[key] = { tile: null, legendCtl: null });
    if (slot.legendCtl) return;
    slot.legendCtl = L.control({ position: 'bottomleft' });
    slot.legendCtl.onAdd = function () {
      const div = L.DomUtil.create('div', 'cloud-legend cloud-legend-generic');
      let body;
      if (key === 'lightning') {
        // Paleta real EUMETSAT LI AFA: crema (1 flash) -> amarillo (3) ->
        // naranja (10) -> rojo (20+). Ticks alineados con la imagen
        // oficial del GetLegendGraphic.
        body = `
          <div class="li-legend-label">Count / 5 min</div>
          <div class="li-legend-bar"></div>
          <div class="li-legend-ticks">
            <span style="left:0%">1</span>
            <span style="left:50%">10</span>
            <span style="left:100%">20+</span>
          </div>
          <div class="li-legend-help">accumulated flash area · MTG Lightning Imager</div>`;
      } else {
        body = cfg.legendUrl
          ? `<img class="cloud-legend-image" src="${cfg.legendUrl}" alt="Escala"
                  onerror="this.style.display='none'">`
          : '';
      }
      div.innerHTML = `
        <div class="cloud-legend-title">${cfg.title || ''}</div>
        ${body}
        <div class="cloud-legend-attr">${(cfg.options && cfg.options.attribution) || '© EUMETSAT'}</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    slot.legendCtl.addTo(map);
  }
  function hideGenericCloudLegend(key) {
    const slot = _eumetWmsLayers[key];
    if (slot && slot.legendCtl) {
      slot.legendCtl.remove();
      slot.legendCtl = null;
    }
  }

  // ── SIGMETs internacionales (AWC) ──────────────────────────────────
  // Fetch JSON crudo de aviationweather.gov y construimos cada poligono
  // a mano desde el campo `coords` (formato AWC: "lat lng, lat lng, ...")
  // o desde el raw text para SIGMETs tipo CIRCLE. Con format=geojson AWC
  // generaba poligonos simplificados (no fieles) — por eso parseamos aqui.
  let _sigmetState = { fetched: 0, layers: [], timer: null };
  const SIGMET_REFRESH_MS = 10 * 60 * 1000;
  // Solo cargamos SIGMETs cuya geometria intersecta este bbox (Iberia +
  // Baleares + Canarias + N-Africa + Europa occidental). Asi evitamos
  // pintar el de Tokio o el de Honolulu, que no aportan al usuario EA.
  // Ajusta los limites aqui si quieres mas/menos cobertura.
  const SIGMET_REGION = {
    minLat: 20, maxLat: 60,
    minLng: -30, maxLng: 30,
  };
  const SIGMET_COLORS = {
    TS:   '#dc2626',  // tormenta convectiva
    TURB: '#f97316',  // turbulencia
    ICE:  '#0ea5e9',  // engelamiento
    MTW:  '#92400e',  // ondas de montanya
    VA:   '#7c3aed',  // ceniza volcanica
    OTHER:'#475569',
  };

  // Comprueba si el bounding box de una geometria SIGMET (poly o circle)
  // intersecta con la region operativa. Bbox-bbox es suficiente para el
  // filtro: si no se solapan los rectangulos contenedores, los poligonos
  // tampoco. Y nos ahorra el coste de un test poligono-poligono real.
  function sigmetNearRegion(geom) {
    if (!geom) return false;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    if (geom.kind === 'poly') {
      for (const [lat, lng] of geom.latlngs) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    } else if (geom.kind === 'circle') {
      const [lat, lng] = geom.center;
      // radio en metros -> grados (aprox 111 km/deg lat, escalado lng por cos).
      const radDegLat = geom.radiusM / 111000;
      const cosLat    = Math.max(0.01, Math.cos(lat * Math.PI / 180));
      const radDegLng = radDegLat / cosLat;
      minLat = lat - radDegLat; maxLat = lat + radDegLat;
      minLng = lng - radDegLng; maxLng = lng + radDegLng;
    } else {
      return false;
    }
    // Bbox overlap (axis-aligned).
    return !(maxLat < SIGMET_REGION.minLat || minLat > SIGMET_REGION.maxLat ||
             maxLng < SIGMET_REGION.minLng || minLng > SIGMET_REGION.maxLng);
  }
  function sigmetClassKey(hz) {
    const h = String(hz || '').toUpperCase();
    if (h.includes('TS')   || h.includes('CONVECTIVE')) return 'TS';
    if (h.includes('TURB'))                              return 'TURB';
    if (h.includes('ICE'))                               return 'ICE';
    if (h.includes('MTW')  || h.includes('MOUNTAIN'))    return 'MTW';
    if (h.includes('VA')   || h.includes('VOLCANIC'))    return 'VA';
    return 'OTHER';
  }
  function buildSigmetLayer() {
    const grp = L.layerGroup();
    const startPolling = () => {
      if (_sigmetState.timer) clearInterval(_sigmetState.timer);
      _sigmetState.timer = setInterval(() => loadSigmets(grp), SIGMET_REFRESH_MS);
    };
    const stopPolling = () => {
      if (_sigmetState.timer) { clearInterval(_sigmetState.timer); _sigmetState.timer = null; }
    };
    grp.on('add', async function () {
      try { await loadSigmets(grp); } catch (e) {
        console.warn('[sigmet]', e);
      }
      // Auto-refresco cada 10 min mientras la capa esta activa Y la
      // pestania esta visible. Si el usuario cambia de tab, pausamos
      // el polling para no malgastar red/CPU. visibilitychange recupera
      // automaticamente cuando vuelve.
      startPolling();
      if (!grp._visibilityHook) {
        grp._visibilityHook = () => {
          // !== 'visible' cubre hidden / prerender / unloaded; solo
          // reanudamos en estado 'visible' real.
          if (document.visibilityState !== 'visible') stopPolling();
          else if (map && map.hasLayer(grp)) {
            startPolling();
            loadSigmets(grp).catch(e => console.warn('[sigmet]', e));
          }
        };
        document.addEventListener('visibilitychange', grp._visibilityHook);
      }
    });
    grp.on('remove', function () {
      stopPolling();
      if (grp._visibilityHook) {
        document.removeEventListener('visibilitychange', grp._visibilityHook);
        grp._visibilityHook = null;
      }
      clearSigmetLayers(grp);
    });
    return grp;
  }
  function clearSigmetLayers(grp) {
    for (const l of _sigmetState.layers) {
      try { grp.removeLayer(l); } catch (_) {}
    }
    _sigmetState.layers = [];
  }
  // _sigmetEntries: array de { layer, sig, geom, cls } que mantenemos
  // para resolver hit-tests poligono-poligono al hacer click y mostrar
  // todos los SIGMETs que contienen el punto en un popup combinado.
  let _sigmetEntries = [];

  async function loadSigmets(grp) {
    const mapi = window.NotamHub.meteoApi;
    if (!mapi || !mapi.fetchSigmets) return;
    const list = await mapi.fetchSigmets();
    clearSigmetLayers(grp);
    _sigmetEntries = [];
    if (!Array.isArray(list) || !list.length) {
      _sigmetState.fetched = Date.now();
      return;
    }
    let kept = 0, skipped = 0;
    for (const sig of list) {
      const sigGeom = mapi.parseSigmetGeometry(sig);
      if (!sigGeom) { skipped++; continue; }
      if (!sigmetNearRegion(sigGeom)) { skipped++; continue; }
      kept++;
      const cls = sigmetClassKey(sig.hazard || sig.qualifier);
      const color = SIGMET_COLORS[cls];
      const fillOp = settingsGet('opacity.sigmet', 0.35);
      const style = {
        color, weight: 2, opacity: 0.9,
        fillColor: color, fillOpacity: fillOp,
        dashArray: '6 3',
        pane: 'tsaPane',
      };
      let layer;
      if (sigGeom.kind === 'poly') {
        layer = L.polygon(sigGeom.latlngs, style);
      } else if (sigGeom.kind === 'circle') {
        layer = L.circle(sigGeom.center, Object.assign({ radius: sigGeom.radiusM }, style));
      } else {
        continue;
      }
      const entry = { layer, sig, geom: sigGeom, cls };
      _sigmetEntries.push(entry);
      // Click: recolectamos TODOS los SIGMETs cuya geometria contiene el
      // punto y abrimos un popup combinado (igual que TSAs). Si solo
      // uno match-ea, el popup combinado tiene una sola tarjeta.
      layer.on('click', (e) => {
        const matches = _sigmetEntries.filter(en => sigmetGeomContains(en.geom, en.layer, e.latlng));
        // Si el hit-test no detecta el propio layer clicado (por
        // imprecisiones de punto-en-poligono cerca del borde), lo
        // anyadimos al frente para no perder el target del click.
        if (!matches.includes(entry)) matches.unshift(entry);
        L.popup({ maxWidth: 460, minWidth: 320, autoPan: true, className: 'sigmet-leaflet-popup' })
          .setLatLng(e.latlng)
          .setContent(buildCombinedSigmetPopup(matches))
          .openOn(map);
      });
      layer.addTo(grp);
      _sigmetState.layers.push(layer);
    }
    console.info(`[sigmet] ${list.length} totales · ${kept} en area operativa · ${skipped} fuera de zona`);
    _sigmetState.fetched = Date.now();
  }

  // Test point-in-geometry para SIGMETs (poligono o circulo).
  function sigmetGeomContains(geom, layer, latlng) {
    if (!geom) return false;
    if (geom.kind === 'poly') {
      return pointInPoly([latlng.lat, latlng.lng], geom.latlngs);
    }
    if (geom.kind === 'circle' && layer && typeof layer.getLatLng === 'function') {
      return layer.getLatLng().distanceTo(latlng) <= (layer.getRadius() || 0);
    }
    return false;
  }

  function buildSigmetCard(sig, cls) {
    const mapi = window.NotamHub.meteoApi;
    const dec = mapi && mapi.decodeSigmet ? mapi.decodeSigmet(sig) : null;
    const fir = sig.firId || sig.firName || '';
    const firLine = (sig.firName && sig.firId)
      ? `${escapeHTMLLocal(sig.firId)} · ${escapeHTMLLocal(sig.firName)}`
      : (escapeHTMLLocal(fir));
    const rows = [];
    if (dec) {
      if (firLine)     rows.push(`<div class="sigmet-row"><span class="sigmet-k">FIR</span><span class="sigmet-v">${firLine}</span></div>`);
      if (dec.levels && dec.levels !== '—')
        rows.push(`<div class="sigmet-row"><span class="sigmet-k">Niveles</span><span class="sigmet-v">${escapeHTMLLocal(dec.levels)}</span></div>`);
      if (dec.motion)  rows.push(`<div class="sigmet-row"><span class="sigmet-k">Movimiento</span><span class="sigmet-v">${escapeHTMLLocal(dec.motion)}</span></div>`);
      if (dec.validity && dec.validity !== '—')
        rows.push(`<div class="sigmet-row"><span class="sigmet-k">Válido</span><span class="sigmet-v">${escapeHTMLLocal(dec.validity)}</span></div>`);
      if (dec.issuer)  rows.push(`<div class="sigmet-row"><span class="sigmet-k">MWO</span><span class="sigmet-v">${escapeHTMLLocal(dec.issuer)}${dec.seriesId ? ' · '+escapeHTMLLocal(dec.seriesId) : ''}</span></div>`);
    }
    const raw = sig.rawSigmet
      ? `<details class="sigmet-raw"><summary>Texto crudo</summary><pre>${escapeHTMLLocal(sig.rawSigmet)}</pre></details>`
      : '';
    return `
      <div class="sigmet-card">
        <div class="sigmet-haz ${cls.toLowerCase()}">${escapeHTMLLocal(dec ? dec.phenomenon : (sig.hazard || cls))}</div>
        <div class="sigmet-grid">${rows.join('')}</div>
        ${raw}
      </div>`;
  }

  function buildCombinedSigmetPopup(entries) {
    if (!entries.length) return '';
    if (entries.length === 1) {
      return `<div class="sigmet-popup">${buildSigmetCard(entries[0].sig, entries[0].cls)}</div>`;
    }
    // Orden: por FIR luego por hazard alfabetico.
    const sorted = entries.slice().sort((a, b) => {
      const af = a.sig.firId || a.sig.firName || '';
      const bf = b.sig.firId || b.sig.firName || '';
      if (af !== bf) return af.localeCompare(bf);
      return String(a.sig.hazard || '').localeCompare(String(b.sig.hazard || ''));
    });
    const head = `<div class="sigmet-popup-head"><b>${entries.length} SIGMETs en este punto</b></div>`;
    const cards = sorted.map(e => buildSigmetCard(e.sig, e.cls)).join(
      '<hr class="sigmet-divider">'
    );
    return `<div class="sigmet-popup sigmet-popup-multi">${head}${cards}</div>`;
  }

  // ── Leyenda flotante de TSAs activas ───────────────────────────────
  // Panel scrollable en la esquina top-right del mapa con la lista de
  // TSAs visibles (selección ∩ filtro), su rango vertical y el resumen
  // de horario. Es un toggle: al activar se anyade el control, al
  // desactivar se elimina. updateLegend() refresca el contenido sin
  // tocar el estado de visibilidad (lo llama app.js cuando cambia la
  // seleccion o el filtro).
  let tsaLegendCtl = null;
  let tsaLegendTSAs = [];

  // Ventana de TSAs visibles en la leyenda. Por defecto = 48h (hoy +
  // manyana). Si HOY es VIERNES (UTC), se amplia hasta el LUNES
  // incluido (4 dias: vie+sab+dom+lun) porque las operaciones de fin
  // de semana suelen consultar el bloque entero el viernes.
  function legendWindowUTC() {
    const now = new Date();
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // getUTCDay: 0=Dom, 1=Lun, 2=Mar, 3=Mie, 4=Jue, 5=Vie, 6=Sab
    const dow = now.getUTCDay();
    const isFriday = dow === 5;
    const days = isFriday ? 4 : 2;   // vie..lun (4) o hoy..manyana (2)
    return {
      startMs,
      endMs: startMs + days * 86400000,
      isFriday,
      days,
    };
  }

  // Filtra TSAs y sus schedules para mostrar solo lo que cae en la
  // ventana actual (2 o 4 dias segun sea viernes o no).
  function filterForTodayAndTomorrow(tsas) {
    const { startMs, endMs } = legendWindowUTC();
    const out = [];
    for (const t of tsas) {
      const inWindow = (t.schedules || []).filter(s =>
        s.startUTC.getTime() < endMs && s.endUTC.getTime() > startMs
      );
      if (inWindow.length) out.push(Object.assign({}, t, { schedules: inWindow }));
    }
    return out;
  }

  function buildTSALegendHTML(tsas) {
    const filtered = filterForTodayAndTomorrow(tsas);
    const win = legendWindowUTC();
    const winLabel = (() => {
      const a = new Date(win.startMs);
      const b = new Date(win.endMs - 86400000);  // ultimo dia inclusivo
      const fmtDate = d => `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      return `${fmtDate(a)} – ${fmtDate(b)} UTC`;
    })();
    // Titulo dinamico: en viernes muestra el bloque completo de fin
    // de semana incluido el lunes.
    const headTitle = win.isFriday
      ? 'TSAs activas viernes → lunes'
      : 'TSAs activas hoy &amp; mañana';
    const emptyMsg = win.isFriday
      ? 'Ninguna TSA activa de viernes a lunes'
      : 'Ninguna TSA activa hoy o mañana';
    if (!filtered.length) {
      return `
        <div class="tsa-legend-head">${headTitle} <span class="tsa-legend-count">0</span></div>
        <div class="tsa-legend-empty"><i>${emptyMsg}</i><br><span class="tsa-legend-window">${winLabel}</span></div>`;
    }
    const fmt = window.NotamHub.scheduleFmt;
    // Agrupamiento visual por prefijo de nombre + misma banda vertical +
    // mismo schedule (TSA CORREDOR SUR 4/5/6 -> "TSA CORREDOR SUR 4-6").
    const groups = groupTSAsForLegend(filtered);
    const groupCount = groups.length;
    const tsaCount = filtered.length;
    const rows = groups.map(g => {
      const t = g.tsas[0]; // representante (misma vertical y schedule)
      const color = tsaColor(t);
      const schedTxt = fmt ? fmt.listText(t.schedules).join(' · ') : '';
      const name = formatGroupNameLocal(g);
      const countBadge = g.tsas.length > 1
        ? `<span class="tsa-legend-group-count" title="${g.tsas.length} TSAs agrupadas">${g.tsas.length}</span>`
        : '';
      return `
        <div class="tsa-legend-row">
          <span class="tsa-legend-swatch" style="background:${color}"></span>
          <div class="tsa-legend-text">
            <div class="tsa-legend-name">${escapeHTMLLocal(name)} ${countBadge}</div>
            <div class="tsa-legend-alt">${escapeHTMLLocal(t.vertical.lowerLabel)} – ${escapeHTMLLocal(t.vertical.upperLabel)}</div>
            <div class="tsa-legend-sched">${escapeHTMLLocal(schedTxt)}</div>
          </div>
        </div>`;
    }).join('');
    const countTxt = (groupCount === tsaCount)
      ? `${tsaCount}`
      : `${tsaCount} TSAs · ${groupCount} grupos`;
    return `
      <div class="tsa-legend-head">${headTitle} <span class="tsa-legend-count">${countTxt}</span></div>
      <div class="tsa-legend-window-bar">${winLabel}</div>
      <div class="tsa-legend-body">${rows}</div>`;
  }

  // Helpers de agrupamiento local (mismos criterios que app.js):
  //   - mismo prefijo de nombre (sin el ultimo token)
  //   - misma banda vertical (lower/upper labels)
  //   - mismo schedule
  function groupTSAsForLegend(tsas) {
    const buckets = new Map();
    const order = [];
    for (const t of tsas) {
      const ls = t.name.lastIndexOf(' ');
      let prefix, suffix;
      if (ls < 0 || ls === t.name.length - 1) { prefix = t.name; suffix = null; }
      else { prefix = t.name.slice(0, ls); suffix = t.name.slice(ls + 1); }
      // Solo agrupamos si el prefijo tiene >=2 tokens (al menos "TSA NOMBRE").
      // Asi evitamos agrupar TSAs sin relacion que solo comparten "TSA".
      const prefixTokens = prefix.split(/\s+/).filter(Boolean);
      const canGroup = suffix != null && prefixTokens.length >= 2;
      const schedSig = (t.schedules || []).map(s =>
        (s.startUTC && s.startUTC.getTime ? s.startUTC.getTime() : 0) + '-' +
        (s.endUTC   && s.endUTC.getTime   ? s.endUTC.getTime()   : 0)
      ).join(',');
      const key = !canGroup
        ? '__single__|' + (t.id || t.name)
        : prefix + '||' + (t.vertical.lowerLabel || '') + '||' + (t.vertical.upperLabel || '') + '||' + schedSig;
      if (!buckets.has(key)) { buckets.set(key, { prefix, suffixes: [], tsas: [] }); order.push(key); }
      const g = buckets.get(key);
      g.tsas.push(t);
      if (canGroup) g.suffixes.push(suffix);
    }
    return order.map(k => buckets.get(k));
  }
  function formatGroupNameLocal(g) {
    if (g.tsas.length === 1) return g.tsas[0].name;
    if (!g.suffixes.length) return g.prefix;
    const sorted = g.suffixes.slice().sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const allNum = sorted.every(s => /^\d+$/.test(s));
    const allLet = sorted.every(s => /^[A-Z]$/.test(s));
    let consecutive = false;
    if (allNum && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || Number(s) === Number(sorted[i - 1]) + 1);
    } else if (allLet && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || s.charCodeAt(0) === sorted[i - 1].charCodeAt(0) + 1);
    }
    if (consecutive) return `${g.prefix} ${sorted[0]}–${sorted[sorted.length - 1]}`;
    return `${g.prefix} ${sorted.join(', ')}`;
  }

  // Ajusta dinamicamente max-height del panel a la PORCION VISIBLE del
  // mapa dentro del viewport (no a map.getSize().y, que devuelve la altura
  // del div del mapa: si el #map tiene min-height fijo y el viewport es
  // pequenyo, el div se sale del viewport y la leyenda lo seguia, dejando
  // filas inferiores inalcanzables). Restamos margen para la attribution
  // de Leaflet y aire visual.
  // En B1 el max-height lo controla la regla CSS
  // (.b1-shell .b1-map-zone .tsa-legend) usando los tokens
  // --b1-header-h, --b1-toolbar-h y --b1-drawer-effective-h. Pisar
  // max-height con un inline-style aqui hacia que la leyenda NO se
  // acortara al abrir el drawer (el inline gana al CSS) y se saliera
  // por debajo del viewport. Por compat con vistas legacy (no-B1):
  // si NO estamos en body.b1, mantenemos el calculo viejo; si SI lo
  // estamos, limpiamos cualquier max-height inline residual y dejamos
  // mandar al CSS.
  function fitLegendToMap() {
    if (!tsaLegendCtl || !map) return;
    const cont = tsaLegendCtl.getContainer();
    if (!cont) return;
    if (document.body.classList.contains('b1')) {
      cont.style.removeProperty('max-height');
      return;
    }
    const r = map.getContainer().getBoundingClientRect();
    const top = Math.max(0, r.top);
    const bottom = Math.min(window.innerHeight, r.bottom);
    const visible = Math.max(0, bottom - top);
    const margin = 30;
    cont.style.maxHeight = Math.max(120, visible - margin) + 'px';
  }

  // Calcula el ancho inicial del panel de leyenda en funcion del numero de
  // grupos visibles: pocas TSAs -> menos columnas -> panel mas estrecho,
  // dejando mas mapa visible. El usuario puede ampliar/reducir despues
  // arrastrando la esquina inferior derecha (CSS resize:both).
  // 240 px aproxima una celda; cada nueva columna anyade ese ancho.
  // En B1 queremos SIEMPRE 3 columnas (panel a 720px) para mostrar todas
  // las TSAs activas hoy/manyana sin scrollear. El usuario puede seguir
  // reduciendolo arrastrando la esquina (CSS resize:both). En layouts
  // legacy mantenemos el escalonado por count.
  function pickInitialLegendWidth(groupCount) {
    if (document.body.classList.contains('b1')) return 720;
    if (groupCount <= 5)  return 240;   // 1 col
    if (groupCount <= 12) return 480;   // 2 cols
    return 720;                          // 3 cols (limite)
  }

  function setLegendVisible(visible, tsas) {
    tsaLegendTSAs = tsas || [];
    if (!visible) {
      if (tsaLegendCtl && map) tsaLegendCtl.remove();
      tsaLegendCtl = null;
      if (map) map.off('resize', fitLegendToMap);
      window.removeEventListener('resize', fitLegendToMap);
      return;
    }
    if (!map) return;
    if (tsaLegendCtl) {
      // Refresh contenido. NO tocamos el width: respetamos el resize que
      // el usuario haya podido aplicar manualmente.
      const cont = tsaLegendCtl.getContainer();
      if (cont) cont.innerHTML = buildTSALegendHTML(tsaLegendTSAs);
      fitLegendToMap();
      return;
    }
    tsaLegendCtl = L.control({ position: 'topright' });
    tsaLegendCtl.onAdd = function () {
      const div = L.DomUtil.create('div', 'tsa-legend');
      div.innerHTML = buildTSALegendHTML(tsaLegendTSAs);
      // Ancho inicial proporcional al numero de grupos (1/2/3 cols).
      const groupCount = groupTSAsForLegend(filterForTodayAndTomorrow(tsaLegendTSAs)).length;
      div.style.width = pickInitialLegendWidth(groupCount) + 'px';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    tsaLegendCtl.addTo(map);
    fitLegendToMap();
    // Si el usuario redimensiona la ventana o cambia de pestana, recalc.
    map.on('resize', fitLegendToMap);
    window.addEventListener('resize', fitLegendToMap);
  }

  function updateLegend(tsas) {
    if (!tsaLegendCtl) { tsaLegendTSAs = tsas || []; return; }
    setLegendVisible(true, tsas);
  }

  function isLegendVisible() { return !!tsaLegendCtl; }

  let meteoLayer = null;
  let meteoLoadedAll = false;     // ya se cargaron todos los aeropuertos
  let meteoBoundLoad = false;     // listener add/remove ya enganchado
  function ensureMeteoLayer() {
    if (meteoLayer) return meteoLayer;
    meteoLayer = L.layerGroup();
    return meteoLayer;
  }

  // ── METAR por bounding box (AWC) ──────────────────────────────────
  // El modulo airways fue eliminado: ya no iteramos su lista de
  // aeropuertos. En su lugar consultamos NOAA AWC por el bbox del mapa
  // visible. Al activar la capa (y en cada moveend mientras este activa)
  // pedimos los METAR del recuadro actual y pintamos un marcador por
  // estacion. Se debouncea el moveend y se limita el numero de marcadores.
  const METAR_MOVE_DEBOUNCE_MS = 400;
  const METAR_MAX_MARKERS = 250;
  let _metarMoveTimer = null;
  let _metarMoveHandler = null;
  // AWC directo (no es nuestro servidor; no envía CORS), con fallback a proxy
  // CORS público cuando el navegador bloquea la llamada directa.
  const AWC_METAR_BASE = 'https://aviationweather.gov/api/data/metar';
  const AWC_CORS_PROXY = 'https://api.allorigins.win/raw?url=';

  // Capa controlable desde el panel: al activarla descarga los METAR del
  // bbox visible y los refresca al mover/zoomear el mapa.
  function buildMetarLayer() {
    const grp = ensureMeteoLayer();
    if (meteoBoundLoad) return grp;
    meteoBoundLoad = true;
    grp.on('add', function () {
      loadMetarsForBounds(grp);
      if (map && !_metarMoveHandler) {
        _metarMoveHandler = function () {
          if (_metarMoveTimer) clearTimeout(_metarMoveTimer);
          _metarMoveTimer = setTimeout(() => loadMetarsForBounds(grp), METAR_MOVE_DEBOUNCE_MS);
        };
        map.on('moveend', _metarMoveHandler);
      }
    });
    grp.on('remove', function () {
      if (_metarMoveTimer) { clearTimeout(_metarMoveTimer); _metarMoveTimer = null; }
      if (map && _metarMoveHandler) {
        map.off('moveend', _metarMoveHandler);
        _metarMoveHandler = null;
      }
    });
    return grp;
  }

  // Fetch de METARs por bbox del mapa visible. AWC espera el bbox en orden
  // minLat,minLon,maxLat,maxLon.
  async function loadMetarsForBounds(grp) {
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;
    const minLat = b.getSouth().toFixed(3);
    const minLon = b.getWest().toFixed(3);
    const maxLat = b.getNorth().toFixed(3);
    const maxLon = b.getEast().toFixed(3);
    const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
    const url = `${AWC_METAR_BASE}?bbox=${bbox}&format=json`;

    // Banner provisional mientras carga.
    const loadingMsg = L.control({ position: 'topright' });
    loadingMsg.onAdd = function () {
      const d = L.DomUtil.create('div', 'meteo-loading');
      d.textContent = 'Cargando METAR del área visible…';
      return d;
    };
    loadingMsg.addTo(map);

    try {
      let res;
      try {
        res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch (corsErr) {
        // CORS / red: reintenta vía proxy público.
        res = await fetch(AWC_CORS_PROXY + encodeURIComponent(url));
        if (!res.ok) throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      // Deduplicamos por ICAO (AWC puede devolver varias obs) quedandonos
      // con la primera (mas reciente) y cap al maximo de marcadores.
      const seen = new Set();
      const items = [];
      for (const st of list) {
        const icao = st.icaoId;
        if (!icao || seen.has(icao)) continue;
        if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
        seen.add(icao);
        // Adaptamos los campos AWC al shape que espera addWeatherMarkersTo:
        // { icao, lat, lon, name, metar:{category, raw, ...}, taf }.
        items.push({
          icao,
          lat: st.lat,
          lon: st.lon,
          name: st.name || null,
          metar: {
            raw: st.rawOb || null,
            category: st.fltCat || null,
            temp: st.temp, dewp: st.dewp,
            wdir: st.wdir, wspd: st.wspd,
            visib: st.visib, altim: st.altim,
          },
          taf: null,
        });
        if (items.length >= METAR_MAX_MARKERS) break;
      }
      grp.clearLayers();
      addWeatherMarkersTo(grp, items);
      meteoLoadedAll = true;
    } catch (e) {
      console.warn('[meteo] METAR bbox falló:', e);
      // Solo avisamos si no hay nada pintado todavia (evita spam en moveend).
      if (!grp.getLayers || grp.getLayers().length === 0) {
        alert('No se pudo descargar METAR del área visible:\n' + (e.message || e));
      }
    } finally {
      loadingMsg.remove();
    }
  }

  function addWeatherMarkersTo(layer, items) {
    if (!items || !items.length) return;
    for (const it of items) {
      const cat = (it.metar && it.metar.category) || 'UNK';
      const hasData = !!(it.metar || it.taf);
      const color = hasData ? metarFlightCatColor(cat) : '#6b7280';
      const marker = L.circleMarker([it.lat, it.lon], {
        radius: hasData ? 8 : 4,
        weight: 1.5,
        color: '#0f172a',
        fillColor: color,
        fillOpacity: hasData ? 0.9 : 0.4,
        pane: 'markerPane',
      });
      const metarRaw = it.metar && it.metar.raw ? it.metar.raw : '— sin METAR —';
      const tafRaw   = it.taf   && it.taf.raw   ? it.taf.raw   : '— sin TAF —';
      const dec = window.NotamHub.metarDecode;
      const metarHTML = dec && it.metar && it.metar.raw
        ? dec.toHtmlList(dec.decodeMETAR(it.metar.raw))
        : '';
      const tafHTML = dec && it.taf && it.taf.raw
        ? dec.toHtmlList(dec.decodeTAF(it.taf.raw))
        : '';
      const html = `
        <div class="meteo-popup">
          <div class="meteo-popup-head">
            <b>${it.icao}</b>${it.name ? ` · ${escapeHTMLLocal(it.name)}` : ''}
            <span class="meteo-cat cat-${cat}">${cat}</span>
          </div>
          <div class="meteo-section">
            <b>METAR</b><pre>${escapeHTMLLocal(metarRaw)}</pre>
            ${metarHTML}
          </div>
          <div class="meteo-section">
            <b>TAF</b><pre>${escapeHTMLLocal(tafRaw)}</pre>
            ${tafHTML}
          </div>
        </div>`;
      marker.bindPopup(html, { maxWidth: 520 });
      marker.bindTooltip(`${it.icao}${hasData ? ' · ' + cat : ''}`, { direction: 'top' });
      layer.addLayer(marker);
    }
  }

  function metarFlightCatColor(cat) {
    switch ((cat || '').toUpperCase()) {
      case 'VFR':  return '#22c55e';
      case 'MVFR': return '#3b82f6';
      case 'IFR':  return '#ef4444';
      case 'LIFR': return '#a855f7';
      default:     return '#9ca3af';
    }
  }

  // Reemplaza los marcadores con un subconjunto concreto (botón del plan).
  function setWeatherMarkers(items) {
    if (!map) return;
    const layer = ensureMeteoLayer();
    layer.clearLayers();
    addWeatherMarkersTo(layer, items);
    meteoLoadedAll = false;     // ya no es la lista completa
    if (!map.hasLayer(layer)) layer.addTo(map);
  }

  function clearWeatherMarkers() {
    if (meteoLayer) meteoLayer.clearLayers();
    meteoLoadedAll = false;
  }

  function escapeHTMLLocal(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function drawOfflineBackground() {
    const geo = window.NotamHub.offlineGeo;
    if (!geo || !geo.countries) return;
    countryLayer = L.geoJSON(geo.countries, {
      style: {
        color: LAND_LINE,
        weight: 0.8,
        fillColor: LAND_FILL,
        fillOpacity: settingsGet('opacity.country', 1.0),
      },
      interactive: false,
    }).addTo(map);
  }

  function drawGraticule() {
    const opts = {
      color: '#94a3b8', weight: 0.5, opacity: 0.45,
      interactive: false, dashArray: '2 4',
    };
    // Mundo entero cada 10°.
    for (let lat = -80; lat <= 80; lat += 10) {
      L.polyline([[lat, -180], [lat, 180]], opts).addTo(map);
    }
    for (let lon = -180; lon <= 180; lon += 10) {
      L.polyline([[-80, lon], [80, lon]], opts).addTo(map);
    }
  }

  function drawCities() {
    const geo = window.NotamHub.offlineGeo;
    if (!geo || !geo.cities) return;
    for (const city of geo.cities) {
      const isCap = city.capital === true || city.type === 'capital';
      // tier-1 = capital de pais limitrofe (siempre visible)
      // tier-2 = capital de pais lejano (visible desde zoom 6)
      // tier-3 = ciudad no capital, cualquier pais (visible desde zoom 8)
      let tier;
      if (!isCap) tier = 3;
      else if (BORDERING_COUNTRIES.has(city.country)) tier = 1;
      else tier = 2;
      const marker = L.circleMarker([city.lat, city.lon], {
        radius: isCap ? 4 : 2.5,
        color: '#1f2937',
        fillColor: isCap ? '#dc2626' : '#374151',
        fillOpacity: 1,
        weight: 1,
        interactive: false,
        pane: 'markerPane',
      });
      const tooltip = L.tooltip({
        permanent: true,
        direction: 'right',
        offset: [4, 0],
        className: 'city-label' + (isCap ? ' capital' : ''),
      }).setLatLng([city.lat, city.lon]).setContent(city.name);
      _cityItems.push({ marker, tooltip, tier });
    }
    console.info('[mapView] drawCities: ' + _cityItems.length + ' ciudades registradas (filtrado por zoom).');
  }

  function addLegend() {
    if (legend) return;
    legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'map-legend');
      div.innerHTML =
        '<b>Áreas</b><br>' +
        `<span class="swatch" style="background:${AREA_COLORS.work}"></span>Trabajo<br>` +
        `<span class="swatch" style="background:${AREA_COLORS.transit}"></span>Tránsito`;
      return div;
    };
    legend.addTo(map);
    // Si arrancamos sin TSAs, la leyenda no aporta nada — la
    // ocultamos hasta que render() reciba una lista no vacia.
    _setAreasLegendVisible(false);
  }

  // Muestra/oculta la leyenda "Areas" sin destruir el control para
  // preservar su posicion y no provocar reflows del map.
  function _setAreasLegendVisible(visible) {
    if (!legend || !legend.getContainer) return;
    const el = legend.getContainer();
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  }

  // Reconstruye la leyenda "Áreas" según lo que hay en el mapa: TSAs
  // nacionales (Trabajo/Tránsito) + NOTAMs extranjeros por categoría, con
  // su color y recuento. Solo muestra lo que está presente.
  function _renderAreasLegend(tsas) {
    if (!legend || !legend.getContainer) return;
    const el = legend.getContainer();
    if (!el) return;
    let work = 0, transit = 0, natOther = 0;
    const foreignCats = new Map();
    for (const t of (tsas || [])) {
      if (t._foreign === true) {
        const k = t.category || 'other';
        foreignCats.set(k, (foreignCats.get(k) || 0) + 1);
      } else if (t._isWorkArea === true) work++;
      else if (t._isWorkArea === false) transit++;
      else natOther++;
    }
    const sw = (color) => `<span class="swatch" style="background:${color}"></span>`;
    const rows = [];
    // Solo categorías de NOTAMs extranjeros (la leyenda "Nacional" se omite).
    if (foreignCats.size) {
      const nh = window.NotamHub.notamHub;
      Array.from(foreignCats.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, c]) => {
        const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(k) : { label: k, color: FOREIGN_COLOR };
        rows.push(sw(meta.color) + escapeHTML(meta.label) + ' (' + c + ')');
      });
    }
    el.innerHTML = '<b>Leyenda</b><br>' + (rows.length ? rows.join('<br>') : '<span class="dim">sin áreas</span>');
  }

  function formatSchedule(sch) {
    const fmt = d => d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    return `${fmt(sch.startUTC)} → ${fmt(sch.endUTC)}`;
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Badge "Work Area" / "Transit Area" basado en _isWorkArea.
  // Verde para work, rojo para transit, gris si no se conoce (TSAs sin
  // origen NotamHub/PDF parsed que no expusieron el flag).
  function buildAreaBadge(tsa) {
    if (tsa && tsa._foreign === true) {
      const nh = window.NotamHub.notamHub;
      const meta = (nh && nh.getForeignCategoryMeta) ? nh.getForeignCategoryMeta(tsa.category) : null;
      const color = (meta && meta.color) || FOREIGN_COLOR;
      const label = (meta && meta.label) || 'NOTAM';
      return `<span class="tsa-flag" style="background:${color};color:#fff;border-color:${color}">${escapeHTML(label)}</span>`;
    }
    if (!tsa || typeof tsa._isWorkArea !== 'boolean') {
      return `<span class="tsa-flag tsa-flag-unknown">Área TSA</span>`;
    }
    const isWork = tsa._isWorkArea === true;
    const cls = isWork ? 'tsa-flag-work' : 'tsa-flag-transit';
    const txt = isWork ? 'Work Area' : 'Transit Area';
    return `<span class="tsa-flag ${cls}">${txt}</span>`;
  }

  function buildPopup(tsa) {
    const fmt = window.NotamHub.scheduleFmt;
    const isForeign = tsa._foreign === true;

    // Línea de metadatos: país + Q-code (extranjeros) o formato (nacionales).
    let metaLine;
    if (isForeign) {
      const parts = [];
      if (tsa.country) parts.push(`País: <b>${escapeHTML(tsa.country)}</b>`);
      if (tsa.qCode)   parts.push(`Q: <b>${escapeHTML(tsa.qCode)}</b>`);
      metaLine = parts.length ? parts.join(' · ') + '<br>' : '';
    } else {
      metaLine = `<i>${escapeHTML(tsa.format || '')}</i><br>`;
    }

    // Vigencia: "Permanente" o las ventanas horarias.
    let timeLine;
    if (tsa._isPermanent) {
      timeLine = '<b>Vigencia:</b> Permanente';
    } else {
      const lines = fmt
        ? fmt.listText(tsa.schedules).slice(0, 8).map(l => `• ${escapeHTML(l)}`).join('<br>')
        : tsa.schedules.slice(0, 6).map(s => `• ${formatSchedule(s)}`).join('<br>');
      const totalGroups = fmt ? fmt.listText(tsa.schedules).length : tsa.schedules.length;
      const more = totalGroups > 8 ? `<br><i>…y ${totalGroups - 8} grupos más</i>` : '';
      timeLine = `<b>Ventanas:</b><br>${lines}${more}`;
    }

    // Cuerpo del NOTAM (extranjeros) recortado.
    const body = (isForeign && tsa.remarks)
      ? `<div class="tsa-popup-body">${escapeHTML(String(tsa.remarks).slice(0, 400))}</div>`
      : '';

    return `
      <div class="tsa-popup-title-row">
        <b>${escapeHTML(tsa.name)}</b>${buildAreaBadge(tsa)}
      </div>
      ${metaLine}
      Altitud: <b>${escapeHTML(tsa.vertical.lowerLabel)}</b> → <b>${escapeHTML(tsa.vertical.upperLabel)}</b><br>
      ${timeLine}
      ${body}
    `;
  }

  // Cuando varias TSAs solapan en un punto, Leaflet solo dispara el click
  // en una (la de encima). Aqui combinamos todas las TSAs cuyo poligono
  // contiene la coordenada del click para mostrarlas en un solo popup.
  function buildCombinedPopup(tsas) {
    if (tsas.length === 1) return buildPopup(tsas[0]);
    const head = `<div class="tsa-popup-head"><b>${tsas.length} TSAs en este punto</b></div>`;
    // Ordena por banda altitudinal (lower asc) para que se lean apiladas.
    const sorted = tsas.slice().sort((a, b) => {
      if (a.vertical.lowerFt !== b.vertical.lowerFt) return a.vertical.lowerFt - b.vertical.lowerFt;
      return a.name.localeCompare(b.name);
    });
    const blocks = sorted.map(buildPopup).join(
      '<hr style="margin:6px 0;border:0;border-top:1px dashed #94a3b8">'
    );
    return `<div class="tsa-popup-multi">${head}${blocks}</div>`;
  }

  // Anillos a dibujar de un item: sus partes (MultiPolygon) o su único polígono.
  function _ringsOf(t) {
    if (t.parts && t.parts.length) return t.parts;
    return t.polygon ? [t.polygon] : [];
  }
  // ¿El punto cae dentro de ALGUNA parte del item? (para el click combinado).
  function _pointInTsa(latlon, t) {
    const rings = _ringsOf(t);
    for (const r of rings) { if (r && r.length >= 3 && pointInPoly(latlon, r)) return true; }
    return false;
  }

  function render(tsas) {
    if (!map) return;
    layerGroup.clearLayers();
    if (!tsas || tsas.length === 0) {
      // Sin TSAs visibles, la leyenda "Areas" Trabajo/Transito no
      // aporta info — la ocultamos.
      _setAreasLegendVisible(false);
      return;
    }
    // Hay TSAs en el mapa: muestra la leyenda (dinámica por categoría).
    _setAreasLegendVisible(true);
    _renderAreasLegend(tsas);

    const tsaOpacity = settingsGet('opacity.tsaFill', 0.40);
    // Snapshot del listado para el handler de click (cierra sobre tsas).
    const tsaList = tsas.slice();
    // Render: áreas grandes primero (debajo) y pequeñas después (encima),
    // para que las zonas pequeñas no queden ocultas por FIRs enormes.
    const ordered = tsas.slice().sort((a, b) => _approxAreaDeg(b.polygon) - _approxAreaDeg(a.polygon));
    const onClick = (e) => {
      const latlon = [e.latlng.lat, e.latlng.lng];
      const containing = tsaList.filter(t => _pointInTsa(latlon, t));
      if (!containing.length) return;
      L.popup({ maxWidth: 520, minWidth: 280, autoPan: true })
        .setLatLng(e.latlng)
        .setContent(buildCombinedPopup(containing))
        .openOn(map);
    };
    for (const tsa of ordered) {
      const rings = _ringsOf(tsa);
      if (!rings.length) continue;
      const color = tsaColor(tsa);
      const area = _approxAreaDeg(tsa.polygon);
      // Relleno por el slider (default 0.40); áreas enormes algo más
      // translúcidas. Trazo grueso y opaco para resaltar sobre el satélite.
      const fill = area > 6 ? Math.min(tsaOpacity, 0.20) : tsaOpacity;
      // Cada PARTE (MultiPolygon) se dibuja por separado: dibujarlas como un
      // único polígono concatenado generaba líneas que unían zonas separadas.
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        const poly = L.polygon(ring, {
          color, weight: 2.5, opacity: 1,
          fillColor: color,
          fillOpacity: fill,
          pane: 'tsaPane',
        });
        poly.on('click', onClick);
        poly.bindTooltip(tsa.name, { direction: 'center', className: 'tsa-tooltip' });
        poly.addTo(layerGroup);
      }
    }
    // NOTA: NO autocentramos aquí. Hacerlo en cada render provocaba un bucle
    // moveend → recarga foreign → render → fitBounds → moveend que recentraba
    // el mapa sin parar e impedía moverlo. El centrado es solo bajo demanda
    // (botón "Centrar" → fitBounds()) y una vez tras cargar (app.fitToData).
  }

  function fitBounds() {
    if (!map) return;
    // 1) TSAs / NOTAMs visibles
    if (layerGroup) {
      const pts = [];
      layerGroup.eachLayer(l => {
        if (l.getLatLngs) {
          const arr = l.getLatLngs()[0] || [];
          arr.forEach(p => pts.push(p));
        }
      });
      if (pts.length) {
        map.fitBounds(L.latLngBounds(pts), _safeBoundsPadding(30));
        return;
      }
    }
    // 2) Vista por defecto: Iberia + Baleares
    map.fitBounds(DEFAULT_BOUNDS, _safeBoundsPadding(10));
  }

  function invalidateSize() { if (map) map.invalidateSize(); }

  // ── Padding seguro para fitBounds ────────────────────────────────────
  // La .b1-map-toolbar (position:fixed, top-right, z-index 9100) y la
  // tsa-legend (tambien top-right, debajo del toolbar) tapan parte del
  // mapa. Leaflet no las "ve" — calcula los bounds contra el centro
  // geometrico del div del mapa, asi que cuando el toolbar esta visible
  // la ruta/TSAs quedan visualmente descentradas hacia la izquierda
  // (el operador no ve el extremo derecho).
  //
  // Esta helper devuelve { paddingTopLeft, paddingBottomRight } con
  // insets calculados runtime para que el contenido quede centrado en
  // el AREA VISIBLE (no la geometrica). Llamada por todas las rutas de
  // fitBounds del modulo.
  function _safeBoundsPadding(basePad) {
    const p = Number.isFinite(basePad) ? basePad : 30;
    const topLeft     = [p, p];
    const bottomRight = [p, p];
    if (!map) return { paddingTopLeft: topLeft, paddingBottomRight: bottomRight };
    const mapEl = map.getContainer();
    if (!mapEl) return { paddingTopLeft: topLeft, paddingBottomRight: bottomRight };
    const mr = mapEl.getBoundingClientRect();
    const overlaps = (r) => r && r.width > 0 && r.height > 0 &&
                            r.right > mr.left && r.left < mr.right &&
                            r.bottom > mr.top && r.top < mr.bottom;
    // Helper que extiende paddingTopLeft/paddingBottomRight para que
    // el rect dado quede FUERA del area visible interior. `r` esta en
    // coordenadas de viewport (getBoundingClientRect).
    function reserveFor(r) {
      if (!overlaps(r)) return;
      // ¿Esta pegado al lado derecho? (toolbars top-right + legends)
      const rightSide = (mr.right - r.right) < (r.left - mr.left);
      // ¿Esta pegado al lado superior? (toolbar)
      const topSide   = (r.top - mr.top) < (mr.bottom - r.bottom);
      const margin = 8;
      if (rightSide) {
        const inset = Math.max(0, mr.right - r.left) + margin;
        if (inset > bottomRight[0]) bottomRight[0] = inset;
      } else {
        // Izquierda — raro en B1 pero defensivo
        const inset = Math.max(0, r.right - mr.left) + margin;
        if (inset > topLeft[0]) topLeft[0] = inset;
      }
      if (topSide) {
        const inset = Math.max(0, r.bottom - mr.top) + margin;
        if (inset > topLeft[1]) topLeft[1] = inset;
      } else {
        const inset = Math.max(0, mr.bottom - r.top) + margin;
        if (inset > bottomRight[1]) bottomRight[1] = inset;
      }
    }
    // Toolbar superior fija top-right
    document.querySelectorAll('.b1-map-toolbar').forEach(el => {
      if (el.offsetParent !== null) reserveFor(el.getBoundingClientRect());
    });
    // Leyenda TSAs (tambien anchored top-right, debajo del toolbar)
    document.querySelectorAll('.tsa-legend').forEach(el => {
      if (el.offsetParent !== null && !el.classList.contains('hidden')) {
        reserveFor(el.getBoundingClientRect());
      }
    });
    return { paddingTopLeft: topLeft, paddingBottomRight: bottomRight };
  }

  function fitToDefault() {
    if (!map) return;
    map.fitBounds(DEFAULT_BOUNDS, _safeBoundsPadding(10));
  }

  // Aplica las opacidades actuales de settings a TODAS las capas vivas.
  // Llamada al cambiar cualquier ajuste de opacidad.
  function applyOpacities() {
    if (!map) return;
    if (countryLayer) {
      countryLayer.setStyle({ fillOpacity: settingsGet('opacity.country', 1.0) });
    }
    const tsaOp = settingsGet('opacity.tsaFill', 0.30);
    if (layerGroup) {
      layerGroup.eachLayer(l => { if (l.setStyle) l.setStyle({ fillOpacity: tsaOp }); });
    }
    if (cloudRVTile && cloudRVTile.setOpacity) cloudRVTile.setOpacity(settingsGet('opacity.cloudRV', 0.6));
    if (cloudCthTile && cloudCthTile.setOpacity) cloudCthTile.setOpacity(settingsGet('opacity.cloudCTH', 0.7));
    // Toggles EUMETSAT extra (LI, Convection): cada uno tiene su slot tile.
    const liSlot   = _eumetWmsLayers.lightning;
    const conSlot  = _eumetWmsLayers.convection;
    if (liSlot  && liSlot.tile  && liSlot.tile.setOpacity)  liSlot.tile.setOpacity(settingsGet('opacity.cloudLI',   0.8));
    if (conSlot && conSlot.tile && conSlot.tile.setOpacity) conSlot.tile.setOpacity(settingsGet('opacity.cloudConv',0.65));
    // SIGMETs: rellenar todos los poligonos / circulos con la nueva
    // fillOpacity sin recargar la capa.
    const sigOp = settingsGet('opacity.sigmet', 0.35);
    for (const en of _sigmetEntries) {
      if (en.layer && en.layer.setStyle) en.layer.setStyle({ fillOpacity: sigOp });
    }
  }

  function _initSettingsHook() {
    const s = window.NotamHub && window.NotamHub.settings;
    if (s && s.onChange) {
      s.onChange((path) => {
        if (typeof path === 'string' && (path.startsWith('opacity.') || path === '*')) {
          applyOpacities();
        }
      });
    }
  }

  // ── Exportación: volcado del mapa satélite a imagen (para el PDF) ──────
  // Construye un mapa Leaflet OFFSCREEN del tamaño deseado, encuadra los
  // items, espera a que carguen los tiles y los vuelca (junto a los
  // polígonos NOTAM + etiquetas con su nombre) a un <canvas>, devolviendo
  // un dataURL JPEG. No toca el mapa visible del usuario.
  function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function _waitTiles(host, timeoutMs) {
    const start = (window.performance && performance.now) ? performance.now() : 0;
    const elapsed = () => ((window.performance && performance.now) ? performance.now() : timeoutMs) - start;
    while (elapsed() < timeoutMs) {
      const imgs = host.querySelectorAll('img.leaflet-tile');
      if (imgs.length) {
        let allDone = true;
        imgs.forEach((im) => { if (!(im.complete && im.naturalWidth > 0)) allDone = false; });
        if (allDone) { await _sleep(220); return; }
      }
      await _sleep(150);
    }
  }

  function _hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(6,182,212,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  // ── Geometría en PÍXELES (para colocar etiquetas fuera de las áreas) ──
  // Todas operan sobre puntos [x, y] en coordenadas de canvas.
  function _segInt(p1, p2, p3, p4) {
    const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2), d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function _pip(pt, ring) {                       // punto en polígono (px)
    let inside = false; const x = pt[0], y = pt[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function _rectPolyHit(rect, ring) {             // ¿el rectángulo solapa el polígono?
    const { x, y, w, h } = rect;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    for (const c of corners) if (_pip(c, ring)) return true;
    for (const v of ring) if (v[0] >= x && v[0] <= x + w && v[1] >= y && v[1] <= y + h) return true;
    const re = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      for (const e of re) if (_segInt(ring[j], ring[i], e[0], e[1])) return true;
    }
    return false;
  }
  function _segPolyHit(a, b, ring) {              // ¿el segmento toca el polígono?
    if (_pip(a, ring) || _pip(b, ring)) return true;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (_segInt(a, b, ring[j], ring[i])) return true;
    }
    return false;
  }
  function _nearestOnSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  }
  function _nearestOnRings(p, rings) {            // punto del borde más cercano a p
    let best = null, bd = Infinity;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const q = _nearestOnSeg(p, ring[j], ring[i]);
        const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best;
  }
  function _nearestRectPointTo(rect, p) {         // punto del rect más cercano a p
    return [Math.max(rect.x, Math.min(p[0], rect.x + rect.w)),
            Math.max(rect.y, Math.min(p[1], rect.y + rect.h))];
  }
  function _screenArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(a / 2);
  }
  function _screenCentroid(ring) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) < 1e-9) {
      let sx = 0, sy = 0; ring.forEach((p) => { sx += p[0]; sy += p[1]; });
      return [sx / ring.length, sy / ring.length];
    }
    a *= 0.5; return [cx / (6 * a), cy / (6 * a)];
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function _drawBordersToCanvas(ctx, m, scale) {
    scale = scale || 1;
    const geo = window.NotamHub.offlineGeo;
    const data = geo && (geo.borders || geo.countries);
    if (!data || !data.features) return;
    const tracePath = () => {
      for (const f of data.features) {
        const g = f && f.geometry; if (!g) continue;
        const drawRing = (ring) => {
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const q = m.latLngToContainerPoint([ring[i][1], ring[i][0]]);  // geojson = [lon,lat]
            if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        };
        if (g.type === 'Polygon') g.coordinates.forEach(drawRing);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(drawRing));
      }
    };
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Casing oscuro debajo + línea clara encima -> divisiones nítidas.
    ctx.strokeStyle = 'rgba(11,16,32,0.6)'; ctx.lineWidth = 4.2 * scale; tracePath();
    ctx.strokeStyle = 'rgba(255,255,255,1)'; ctx.lineWidth = 1.7 * scale; tracePath();
    ctx.restore();
  }

  // Dibuja los AERÓDROMOS visibles en el PDF: marcador + etiqueta ICAO, con
  // el mismo gating por zoom que la capa viva (large z>=6, medium z>=8). Se
  // dibuja ANTES de las etiquetas NOTAM para que éstas queden por encima.
  function _drawAerodromes(ctx, m, W, H, scale) {
    const geo = window.NotamHub.offlineGeo;
    if (!geo || !Array.isArray(geo.aerodromes)) return;
    const z = m.getZoom();
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const a of geo.aerodromes) {
      if (!Number.isFinite(a.la) || !Number.isFinite(a.lo)) continue;
      const isLarge = a.t === 0;
      if (z < (isLarge ? ZOOM_AERO_LARGE : ZOOM_AERO_MEDIUM)) continue;
      const q = m.latLngToContainerPoint([a.la, a.lo]);
      if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) continue;
      ctx.font = '700 ' + ((isLarge ? 12.5 : 11) * scale) + 'px system-ui, "Segoe UI", Arial, sans-serif';
      const r = (isLarge ? 5 : 3.4) * scale;
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee'; ctx.fill();
      ctx.lineWidth = 1.4 * scale; ctx.strokeStyle = 'rgba(11,16,32,0.9)'; ctx.stroke();
      const tx = q.x + r + 3 * scale;
      ctx.lineWidth = 3 * scale; ctx.strokeStyle = 'rgba(11,16,32,0.85)'; ctx.strokeText(a.i, tx, q.y);
      ctx.fillStyle = '#e6fbff'; ctx.fillText(a.i, tx, q.y);
    }
    ctx.restore();
  }

  // Calcula la colocación de las etiquetas: cada TAG se sitúa FUERA de todas
  // las áreas (no tapa ningún polígono NOTAM) y FUERA de las demás etiquetas;
  // el conector (leader) va del borde de la caja al punto del borde del área
  // más cercano, SIN cruzar otras áreas. Devuelve la lista de etiquetas
  // resueltas con su rect, ancla (punto del área) y arranque del leader.
  //   measure(texto) -> ancho en px (ctx.measureText).
  // Constantes de etiqueta en px LÓGICOS (se multiplican por `scale`).
  const _LABEL = { padX: 6, h: 19, gap: 9, font: 13.5, minLeader: 10 };
  function _computeLabelLayout(m, items, W, H, measure, scale) {
    scale = scale || 1;
    const padX = _LABEL.padX * scale, BH = _LABEL.h * scale, GAP = _LABEL.gap * scale;
    const MARGIN = 4 * scale, MINLEAD = _LABEL.minLeader * scale;
    // Proyecta cada item a anillos en píxeles.
    const entries = [];
    for (const t of (items || [])) {
      const rings = _ringsOf(t);
      if (!rings.length) continue;
      const sr = [];
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        sr.push(ring.map((p) => { const q = m.latLngToContainerPoint([p[0], p[1]]); return [q.x, q.y]; }));
      }
      if (!sr.length) continue;
      const label = String(t.name || t.id || '').trim();
      if (!label) continue;
      const largest = sr.reduce((a, b) => (_screenArea(b) > _screenArea(a) ? b : a), sr[0]);
      entries.push({ rings: sr, label, center: _screenCentroid(largest), area: _screenArea(largest), color: tsaColor(t) });
    }
    const allRings = [];
    entries.forEach((e, ei) => e.rings.forEach((r) => allRings.push({ ring: r, owner: ei })));
    const rectOverArea = (rect) => { for (const o of allRings) if (_rectPolyHit(rect, o.ring)) return true; return false; };

    const placed = [];                     // rects de etiquetas ya colocadas
    const rectOverPlaced = (rect) => {
      for (const pr of placed) if (!(rect.x + rect.w < pr.x || rect.x > pr.x + pr.w || rect.y + rect.h < pr.y || rect.y > pr.y + pr.h)) return true;
      return false;
    };
    const results = new Array(entries.length).fill(null);
    // Áreas grandes primero: fijan su etiqueta cerca antes de que las
    // pequeñas ocupen el hueco.
    const order = entries.map((e, i) => i).sort((a, b) => entries[b].area - entries[a].area);

    const angles = [];
    for (let k = 0; k < 32; k++) angles.push((k / 32) * 2 * Math.PI);
    const maxReach = Math.max(W, H) * 0.6;
    const distStep = 11 * scale;

    for (const ei of order) {
      const e = entries[ei];
      const bw = measure(e.label) + padX * 2, bh = BH;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      e.rings.forEach((r) => r.forEach((p) => {
        if (p[0] < bx0) bx0 = p[0]; if (p[1] < by0) by0 = p[1];
        if (p[0] > bx1) bx1 = p[0]; if (p[1] > by1) by1 = p[1];
      }));
      const halfDiag = 0.5 * Math.hypot(bx1 - bx0, by1 - by0);
      let chosen = null;
      // Búsqueda radial: distancia creciente; en cada radio prueba 32 ángulos
      // y se queda con el leader más corto que cumpla TODO.
      for (let dd = GAP; dd <= maxReach && !chosen; dd += distStep) {
        const dist = halfDiag + dd + bh / 2;
        let best = null, bestScore = Infinity;
        for (const ang of angles) {
          const cx = e.center[0] + Math.cos(ang) * dist;
          const cy = e.center[1] + Math.sin(ang) * dist;
          const rect = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
          if (rect.x < MARGIN || rect.y < MARGIN || rect.x + bw > W - MARGIN || rect.y + bh > H - MARGIN) continue;
          if (rectOverArea(rect)) continue;            // no tapa ningún área
          if (rectOverPlaced(rect)) continue;          // no tapa otra etiqueta
          const anchor = _nearestOnRings([cx, cy], e.rings);
          if (!anchor) continue;
          const ls = _nearestRectPointTo(rect, anchor);
          const leadLen = Math.hypot(ls[0] - anchor[0], ls[1] - anchor[1]);
          if (leadLen < MINLEAD) continue;             // deja sitio a la flecha
          let leaderBad = false;                       // leader no cruza otra área
          for (const o of allRings) { if (o.owner === ei) continue; if (_segPolyHit(ls, anchor, o.ring)) { leaderBad = true; break; } }
          if (leaderBad) continue;
          if (leadLen < bestScore) { bestScore = leadLen; best = { rect, anchor, ls }; }
        }
        if (best) chosen = best;
      }
      if (!chosen) chosen = _gridFallback(e, bw, bh, W, H, MARGIN, scale, rectOverArea, rectOverPlaced);
      placed.push(chosen.rect);
      results[ei] = {
        label: e.label, color: e.color, owner: ei,
        rect: chosen.rect, anchor: chosen.anchor, leaderStart: chosen.ls, fallback: !!chosen.fallback,
      };
    }
    return { labels: results.filter(Boolean), allRings };
  }

  // Fallback cuando la búsqueda radial no encuentra sitio: rejilla sobre todo
  // el canvas, eligiendo el hueco LIBRE (sin área ni etiqueta) más cercano al
  // área. Garantiza que la etiqueta NO se solape con otra ni tape un área
  // (aunque su leader pueda quedar largo). Solo si el canvas está realmente
  // lleno cae a un último recurso recortado.
  function _gridFallback(e, bw, bh, W, H, MARGIN, scale, rectOverArea, rectOverPlaced) {
    const step = Math.max(14 * scale, bh * 0.8);
    let best = null, bestD = Infinity;
    for (let gy = MARGIN; gy <= H - MARGIN - bh; gy += step) {
      for (let gx = MARGIN; gx <= W - MARGIN - bw; gx += step) {
        const rect = { x: gx, y: gy, w: bw, h: bh };
        if (rectOverArea(rect) || rectOverPlaced(rect)) continue;
        const cx = gx + bw / 2, cy = gy + bh / 2;
        const d = (cx - e.center[0]) * (cx - e.center[0]) + (cy - e.center[1]) * (cy - e.center[1]);
        if (d < bestD) {
          const anchor = _nearestOnRings([cx, cy], e.rings) || e.center;
          bestD = d; best = { rect, anchor, ls: _nearestRectPointTo(rect, anchor), fallback: true };
        }
      }
    }
    if (best) return best;
    const rx = Math.max(MARGIN, Math.min(e.center[0] - bw / 2, W - MARGIN - bw));
    const ry = Math.max(MARGIN, Math.min(e.center[1] - bh / 2, H - MARGIN - bh));
    const rect = { x: rx, y: ry, w: bw, h: bh };
    const anchor = _nearestOnRings([rx + bw / 2, ry + bh / 2], e.rings) || e.center;
    return { rect, anchor, ls: _nearestRectPointTo(rect, anchor), fallback: true };
  }

  // Flecha clara: punta (tip) en el borde del área apuntando HACIA dentro; el
  // cuerpo queda FUERA del área (no la tapa). Tamaño/realce escalados.
  function _drawArrowHead(ctx, from, to, color, scale) {
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const size = Math.max(9 * scale, Math.min(15 * scale, len - 1));
    const spread = 0.42;
    const a1 = [to[0] - size * Math.cos(ang - spread), to[1] - size * Math.sin(ang - spread)];
    const a2 = [to[0] - size * Math.cos(ang + spread), to[1] - size * Math.sin(ang + spread)];
    ctx.beginPath(); ctx.moveTo(to[0], to[1]); ctx.lineTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2 * scale; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();  // realce blanco
    ctx.fillStyle = color; ctx.fill();
  }

  // Dibuja las etiquetas (TAG) según el layout calculado: leader con realce
  // blanco + flecha apuntando al área + caja con el nombre.
  function _drawLabels(ctx, m, items, W, H, scale) {
    scale = scale || 1;
    ctx.save();
    ctx.font = '600 ' + (_LABEL.font * scale) + 'px system-ui, "Segoe UI", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const layout = _computeLabelLayout(m, items, W, H, (s) => ctx.measureText(s).width, scale);
    const rad = 4 * scale;
    for (const L of layout.labels) {
      const r = L.rect, anchor = L.anchor, ls = L.leaderStart, color = L.color;
      // Leader: realce blanco debajo + línea de color encima (visible sobre satélite).
      ctx.beginPath(); ctx.moveTo(ls[0], ls[1]); ctx.lineTo(anchor[0], anchor[1]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 5 * scale; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ls[0], ls[1]); ctx.lineTo(anchor[0], anchor[1]);
      ctx.strokeStyle = color; ctx.lineWidth = 2.4 * scale; ctx.stroke();
      _drawArrowHead(ctx, ls, anchor, color, scale);
      // Caja.
      _roundRect(ctx, r.x, r.y, r.w, r.h, rad);
      ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fill();
      ctx.lineWidth = 1.8 * scale; ctx.strokeStyle = color;
      _roundRect(ctx, r.x, r.y, r.w, r.h, rad); ctx.stroke();
      // Texto.
      ctx.fillStyle = '#0f172a';
      ctx.fillText(L.label, r.x + _LABEL.padX * scale, r.y + r.h / 2 + 0.5 * scale);
    }
    ctx.restore();
  }

  // Crea un mapa Leaflet OFFSCREEN del tamaño dado y lo encuadra a los items.
  // No añade tiles (lo hace quien lo necesite). Devuelve { host, m }.
  function _newExportMap(items, W, H, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;
    const pad = Math.round(46 * scale);
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-100000px;top:0;width:' + W + 'px;height:' + H +
      'px;background:' + SEA_COLOR + ';';
    document.body.appendChild(host);
    const m = L.map(host, {
      zoomControl: false, attributionControl: false,
      fadeAnimation: false, zoomAnimation: false,
      markerZoomAnimation: false, preferCanvas: false,
    });
    const pts = [];
    (items || []).forEach((t) => { _ringsOf(t).forEach((r) => { if (r) r.forEach((p) => pts.push(p)); }); });
    if (pts.length) {
      // maxZoom alto: con el viewport ampliado (scale) Leaflet elige un zoom
      // mayor para los mismos límites -> imagen de satélite más nítida.
      try { m.fitBounds(L.latLngBounds(pts), { padding: [pad, pad], maxZoom: opts.maxZoom || 13 }); }
      catch (_) { m.setView([40, -4], 5); }
    } else {
      m.fitBounds(DEFAULT_BOUNDS);
    }
    return { host, m };
  }

  // TEST/diagnóstico: calcula el layout de etiquetas y devuelve métricas de
  // calidad (cuántas TAGs tapan un área, leaders que cruzan otra área,
  // etiquetas fuera del canvas, solapes entre etiquetas, fallbacks). Sin
  // tiles ni dibujado. Usado por la suite de validación headless.
  async function _auditLabelLayout(items, Wl, Hl, opts) {
    opts = opts || {};
    const scale = opts.scale || 2;
    const W = (Wl || 1240) * scale, H = (Hl || 900) * scale;
    const { host, m } = _newExportMap(items, W, H, { scale: scale, maxZoom: opts.maxZoom });
    let res = null;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '600 ' + (_LABEL.font * scale) + 'px system-ui, "Segoe UI", Arial, sans-serif';
      const layout = _computeLabelLayout(m, items, W, H, (s) => ctx.measureText(s).width, scale);
      const labels = layout.labels, allRings = layout.allRings;
      let labelOverArea = 0, leaderOverArea = 0, offCanvas = 0, labelOverlap = 0, fallbacks = 0;
      for (const Lb of labels) {
        if (Lb.fallback) fallbacks++;
        if (allRings.some((o) => _rectPolyHit(Lb.rect, o.ring))) labelOverArea++;
        if (allRings.some((o) => o.owner !== Lb.owner && _segPolyHit(Lb.leaderStart, Lb.anchor, o.ring))) leaderOverArea++;
        if (Lb.rect.x < 0 || Lb.rect.y < 0 || Lb.rect.x + Lb.rect.w > W || Lb.rect.y + Lb.rect.h > H) offCanvas++;
      }
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i].rect, b = labels[j].rect;
          if (!(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h)) labelOverlap++;
        }
      }
      res = { n: labels.length, labelOverArea, leaderOverArea, offCanvas, labelOverlap, fallbacks };
    } finally {
      try { m.remove(); } catch (_) {}
      try { host.remove(); } catch (_) {}
    }
    return res;
  }

  // Captura el mapa satélite (con polígonos NOTAM + etiquetas) a un dataURL.
  // items: lista de NOTAMs/TSAs a encuadrar y etiquetar. Devuelve
  // { dataUrl, width, height } o { dataUrl:null } si falla.
  async function captureForPdf(items, opts) {
    opts = opts || {};
    // Resolución: el lienzo se renderiza a `scale`× para que la imagen del PDF
    // sea nítida (tiles de satélite a mayor zoom + texto/flechas afiladas).
    const SCALE = opts.scale || 2;
    const W = (opts.width || 1240) * SCALE, H = (opts.height || 900) * SCALE;
    const useStreet = !!(map && _baseStreet && map.hasLayer(_baseStreet));
    const built = _newExportMap(items, W, H, { scale: SCALE, maxZoom: opts.maxZoom });
    const host = built.host;
    let m = built.m, dataUrl = null;
    try {
      const url = useStreet
        ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
        : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
      L.tileLayer(url, { crossOrigin: 'anonymous', maxZoom: 19 }).addTo(m);
      await _waitTiles(host, 12000);

      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = SEA_COLOR; ctx.fillRect(0, 0, W, H);
      // Tiles ya renderizados en el DOM offscreen -> al canvas (posición vía
      // getBoundingClientRect relativa al host, robusta ante transforms).
      const hostRect = host.getBoundingClientRect();
      host.querySelectorAll('img.leaflet-tile').forEach((im) => {
        if (!(im.complete && im.naturalWidth > 0)) return;
        const r = im.getBoundingClientRect();
        try {
          ctx.drawImage(im, Math.round(r.left - hostRect.left), Math.round(r.top - hostRect.top),
            Math.ceil(r.width), Math.ceil(r.height));
        } catch (_) { /* tile contaminado: se omite */ }
      });
      _drawBordersToCanvas(ctx, m, SCALE);
      // Polígonos NOTAM (cada parte por separado).
      for (const t of (items || [])) {
        const rings = _ringsOf(t); if (!rings.length) continue;
        const color = tsaColor(t);
        ctx.lineWidth = 2 * SCALE; ctx.strokeStyle = color; ctx.fillStyle = _hexToRgba(color, 0.25);
        for (const ring of rings) {
          if (!ring || ring.length < 3) continue;
          ctx.beginPath();
          ring.forEach((p, i) => {
            const q = m.latLngToContainerPoint([p[0], p[1]]);
            if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
          });
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
      }
      _drawAerodromes(ctx, m, W, H, SCALE);
      _drawLabels(ctx, m, items, W, H, SCALE);
      try { dataUrl = canvas.toDataURL('image/jpeg', 0.95); }
      catch (e) { console.warn('[mapView] toDataURL falló (canvas contaminado?):', e); dataUrl = null; }
    } catch (e) {
      console.warn('[mapView] captureForPdf falló:', e);
    } finally {
      try { if (m) m.remove(); } catch (_) {}
      try { host.remove(); } catch (_) {}
    }
    return { dataUrl: dataUrl, width: W, height: H };
  }

  function pointInPoly(pt, poly) {
    let inside = false;
    const x = pt[1], y = pt[0];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][1], yi = poly[i][0];
      const xj = poly[j][1], yj = poly[j][0];
      const cond = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (cond) inside = !inside;
    }
    return inside;
  }

  return {
    init, render, fitBounds, invalidateSize, fitToDefault,
    setWeatherMarkers, clearWeatherMarkers,
    captureForPdf, _auditLabelLayout,
    applyOpacities,
    setLegendVisible, updateLegend, isLegendVisible,
    setLayersControlVisible, isLayersControlVisible,
    _debugZoom: function () {
      if (!map) { console.log('mapa no inicializado'); return; }
      const z = map.getZoom();
      const onMap = _cityItems.filter(i => map.hasLayer(i.marker));
      const byTier = [1, 2, 3].map(t => ({
        tier: t,
        total: _cityItems.filter(i => i.tier === t).length,
        visibles: _cityItems.filter(i => i.tier === t && map.hasLayer(i.marker)).length,
      }));
      const wpByType = ['NAVAID', 'RNAV'].map(t => ({
        type: t,
        total: _wpItems.filter(i => i.type === t).length,
        enGrupo: _wpItems.filter(i => i.type === t && i.group.hasLayer(i.marker)).length,
      }));
      console.log('=== NotamHub zoom debug ===');
      console.log('Zoom actual:', z);
      console.log('Ciudades por tier:', byTier);
      console.log('Waypoints por tipo:', wpByType);
      console.log('Total ciudades en mapa:', onMap.length, '/', _cityItems.length);
      console.log('Umbrales: tier-2 ≥', ZOOM_TIER_2_CITY, '· tier-3 ≥', ZOOM_TIER_3_CITY,
                  '· NAVAID ≥', ZOOM_NAVAID, '· RNAV ≥', ZOOM_RNAV);
    },
  };
})();
