// Cliente de APIs meteorológicas:
//   • NOAA Aviation Weather Center (AWC) — METAR / TAF, sin key.
//     https://aviationweather.gov/data/api/
//   • RainViewer — capa de satélite IR (nubes), sin key.
//   • EUMETView WMS — RGB natural color de Meteosat, requiere token.
//
// Las peticiones cruzan CORS (las tres APIs lo permiten desde navegadores
// modernos abriendo el index.html con file://).

window.NotamHub = window.NotamHub || {};
window.NotamHub.meteoApi = (function () {
  'use strict';

  const MODULE_BUILD = 'meteoApi v17 (fork civil: METAR/TAF/SIGMET + capas EUMETSAT)';
  console.info('[NotamHub]', MODULE_BUILD);

  // Detección de entorno: en deploy HTTPS no-local asumimos que tenemos
  // disponibles las Cloudflare Pages Functions /api/awc/* como proxies del
  // MISMO ORIGEN (sin CORS). En local (file:// o localhost/127.0.0.1)
  // llamamos directo y caemos a un proxy CORS público si el navegador
  // bloquea.
  const ON_REMOTE = typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    !/^(localhost|127\.|192\.168\.|10\.)/i.test(location.hostname);

  const AWC_BASE = ON_REMOTE
    ? '/api/awc'
    : 'https://aviationweather.gov/api/data';
  const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';

  // EUMETVIEW — Cloud Top Height MSG 0 degree (MeteoSat). Cobertura
  // Europa/África/Atlántico cada 15 min. Requiere access_token en query.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:MSG:CTH
  // Capabilities verificadas: layer "cth", time dimension hasta el último
  // mosaico publicado (default = más reciente).
  const EUMET_WMS = 'https://view.eumetsat.int/geoserver/msg_fes/cth/ows';
  const EUMET_TOKEN = '5fa55ec9-2aa7-38f9-861b-660bd9845672';
  const EUMET_LAYER = 'cth';
  const EUMET_TITLE = 'Cloud Top Height (MSG 0° · EUMETSAT)';

  // EUMETVIEW — LI Accumulated Flash Area (MTG, 0°). Mosaico de actividad
  // electrica acumulada por el Lightning Imager. Refresco ~15 min.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:0687
  //
  // CTH usa el endpoint especifico /geoserver/msg_fes/cth/ows porque
  // EUMETSAT lo publica asi. Pero LI AFA y RGB Convection solo se sirven
  // desde el endpoint GLOBAL /geoserver/ows con el nombre de capa
  // prefijado por workspace (mtg_fd:li_afa, msg_fes:rgb_convection),
  // tal como aparece en los GetCapabilities oficiales que el usuario
  // adjunto. Las rutas /geoserver/<workspace>/<layer>/ows devuelven 404
  // para estos productos. Por eso ese 404 causaba el "tileerror" del SW.
  const EUMET_GLOBAL_WMS = 'https://view.eumetsat.int/geoserver/ows';

  const EUMET_LI_WMS   = EUMET_GLOBAL_WMS;
  const EUMET_LI_LAYER = 'mtg_fd:li_afa';
  const EUMET_LI_TITLE = 'Tormentas eléctricas (MTG · LI AFA)';

  // EUMETVIEW — RGB Convection (MSG / SEVIRI, 0°). Composite RGB que
  // resalta tormentas convectivas severas (top frio + sobreimpulsos). 15 min.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:MSG:CON
  const EUMET_CON_WMS   = EUMET_GLOBAL_WMS;
  const EUMET_CON_LAYER = 'msg_fes:rgb_convection';
  const EUMET_CON_TITLE = 'RGB Convección (MSG · SEVIRI)';

  // Proxy CORS público, sólo se usa en local cuando el navegador bloquea
  // (en producción usamos las Cloudflare Pages Functions del mismo origen,
  // ver AWC_BASE arriba). corsproxy.io ha empezado a devolver 403
  // desde dominios *.pages.dev, allorigins.win es alternativa estable.
  const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

  // ── Helpers de fetch ────────────────────────────────────────────────

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  // Envuelve fetch con tres comportamientos:
  //  • Si el sitio está abierto con file://, falla rápido con mensaje claro.
  //  • Si el fetch directo falla (CORS / red), reintenta vía proxy CORS público.
  //  • F2.3: timeout opcional via AbortController (default 12s) para evitar
  //    que un endpoint colgado (Open-Meteo en hora punta, etc.) bloquee
  //    flujos como el refetch de viento en vuelo.
  async function safeFetch(url, label, opts) {
    opts = opts || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12000;
    if (isFileProtocol()) {
      throw new Error(
        'Las APIs externas (' + label + ') no funcionan abriendo el HTML directamente (file://). ' +
        'Ejecuta start.bat o "python serve.py" y abre http://127.0.0.1:8000/index.html.'
      );
    }
    function fetchWithTimeout(targetUrl) {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const tid = (ctrl && timeoutMs > 0)
        ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs)
        : null;
      const opt = ctrl ? { signal: ctrl.signal } : {};
      return fetch(targetUrl, opt).finally(() => { if (tid) clearTimeout(tid); });
    }
    // Intento directo
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return res;
      // Algunos endpoints devuelven 403/blocked sin cabeceras CORS — caemos al proxy.
      if (res.status === 403 || res.status === 0) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      // Si fue AbortError por timeout, propagar con mensaje claro y NO
      // reintentar via proxy (el proxy normalmente lo agravara).
      if (e && e.name === 'AbortError') {
        throw new Error(`${label}: timeout (${timeoutMs} ms). Endpoint no responde.`);
      }
      // TypeError "Failed to fetch" → casi siempre CORS bloqueado. Reintenta vía proxy.
      console.warn('[meteo] Fetch directo falló para', label, '— reintentando vía CORS proxy.');
      try {
        const proxied = CORS_PROXY + encodeURIComponent(url);
        const res2 = await fetchWithTimeout(proxied);
        if (!res2.ok) throw new Error('HTTP ' + res2.status);
        return res2;
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') {
          throw new Error(`${label}: timeout via proxy (${timeoutMs} ms).`);
        }
        throw new Error(
          `${label}: bloqueado por CORS y el proxy también falló (${e2.message || e2}). ` +
          `Revisa la conexión o desactiva extensiones que bloqueen tráfico.`
        );
      }
    }
  }

  // ── METAR / TAF ─────────────────────────────────────────────────────

  async function fetchMETAR(icaoList) {
    if (!icaoList || !icaoList.length) return {};
    const ids = icaoList.join(',');
    // AWC acepta la coma sin codificar y devuelve el último METAR por defecto.
    const url = `${AWC_BASE}/metar?ids=${ids}&format=json`;
    const res = await safeFetch(url, 'METAR (AWC)');
    if (!res.ok) throw new Error(`METAR HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const m of data) {
      if (out[m.icaoId]) continue;          // sólo el más reciente
      out[m.icaoId] = {
        raw: m.rawOb,
        category: m.fltCat || null,
        obsTime: m.obsTime || null,
        temp: m.temp,
        dewp: m.dewp,
        wdir: m.wdir,
        wspd: m.wspd,
        wgst: m.wgst,
        visib: m.visib,
        altim: m.altim,
        wxString: m.wxString,
        clouds: m.clouds || [],
        name: m.name || null,
        lat: m.lat,
        lon: m.lon,
      };
    }
    return out;
  }

  async function fetchTAF(icaoList) {
    if (!icaoList || !icaoList.length) return {};
    const ids = icaoList.join(',');
    const url = `${AWC_BASE}/taf?ids=${ids}&format=json`;
    const res = await safeFetch(url, 'TAF (AWC)');
    if (!res.ok) throw new Error(`TAF HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const t of data) {
      if (out[t.icaoId]) continue;
      out[t.icaoId] = {
        raw: t.rawTAF,
        issueTime: t.issueTime || null,
        validFrom: t.validTimeFrom,
        validTo: t.validTimeTo,
      };
    }
    return out;
  }

  async function fetchWeatherForAirports(icaoList) {
    if (!icaoList || !icaoList.length) {
      return { airports: {}, errors: {} };
    }
    const errors = {};
    const [metars, tafs] = await Promise.all([
      fetchMETAR(icaoList).catch(e => { errors.metar = e.message; return {}; }),
      fetchTAF(icaoList).catch(e => { errors.taf = e.message; return {}; }),
    ]);
    const airports = {};
    for (const icao of icaoList) {
      airports[icao] = {
        metar: metars[icao] || null,
        taf:   tafs[icao]   || null,
      };
    }
    return { airports, errors };
  }

  // ── Capa de nubosidad ───────────────────────────────────────────────

  // RainViewer: el endpoint devuelve los timestamps disponibles. Intenta
  // primero satélite IR (nubes); si no hay, cae a radar (precipitación).
  // Devuelve { url, kind } donde kind = 'satellite' | 'radar'.
  let _rvCache = null;
  let _rvCacheTime = 0;
  async function getRainviewerCloudUrl() {
    const now = Date.now();
    if (_rvCache && now - _rvCacheTime < 5 * 60 * 1000) return _rvCache;
    const res = await safeFetch(RAINVIEWER_INDEX, 'RainViewer');
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    const data = await res.json();

    const sat = (data.satellite && data.satellite.infrared) || [];
    if (sat.length) {
      const latest = sat[sat.length - 1];
      _rvCache = {
        url: `${data.host}${latest.path}/512/{z}/{x}/{y}/0/0_0.png`,
        kind: 'satellite',
      };
      _rvCacheTime = now;
      return _rvCache;
    }

    // Fallback: radar (precipitación) — el más reciente entre past y nowcast.
    const past = (data.radar && data.radar.past) || [];
    const now2 = (data.radar && data.radar.nowcast) || [];
    const allRadar = past.concat(now2);
    if (allRadar.length) {
      const latest = allRadar[allRadar.length - 1];
      _rvCache = {
        url: `${data.host}${latest.path}/512/{z}/{x}/{y}/2/1_1.png`,
        kind: 'radar',
      };
      _rvCacheTime = now;
      return _rvCache;
    }

    throw new Error('RainViewer no devolvió ni satélite ni radar.');
  }

  // Calcula el TIME mas reciente disponible para CTH MSG. EumetSat publica
  // un mosaico nuevo cada 15 min (HH:00, HH:15, HH:30, HH:45) con un retraso
  // Cache-bust por slot de 15 minutos: parametro `cb` ignorado por el
  // servidor WMS pero que invalida la cache del navegador / SW cada vez
  // que cambia. Reemplaza al antiguo `time=ISO`: pasar un TIME explicito
  // hacia que EUMETSAT devolviese 5xx cuando el reloj del cliente caia
  // fuera de la ventana de datos publicados (caso del usuario con la
  // fecha del sistema en el futuro). Sin TIME, EUMETSAT sirve siempre
  // el mosaico mas reciente disponible — comportamiento por defecto.
  function eumetCacheBust(slotsBack) {
    const n = Math.max(1, Number(slotsBack) || 1);
    const slotMs = 15 * 60 * 1000;
    return Math.floor(Date.now() / slotMs) - n;
  }

  // EUMETVIEW MSG CTH WMS — devuelve { url, options, title, legendUrl }
  // para L.tileLayer.wms. Sin parametro TIME: el WMS devuelve el ultimo
  // mosaico publicado. cb=<slot> rota cada 15 min para forzar refresh
  // sin depender del reloj del cliente.
  function getEumetCthWMS() {
    const cb = eumetCacheBust(1);
    const legendUrl = `${EUMET_WMS}?service=WMS&version=1.3.0` +
      `&request=GetLegendGraphic&format=image/png&width=640&height=80` +
      `&layer=${EUMET_LAYER}&access_token=${EUMET_TOKEN}`;
    return {
      url: EUMET_WMS,
      title: EUMET_TITLE,
      legendUrl,
      options: {
        layers: EUMET_LAYER,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        attribution: '© EUMETSAT · MSG CTH',
        access_token: EUMET_TOKEN,
        cb,
      },
    };
  }

  // Genera la config WMS para los otros dos productos EUMETVIEW (LI AFA y
  // RGB Convection). Misma mecanica que getEumetCthWMS: cb para cache-
  // bust + access_token requerido. LI AFA y Convection usan slotsBack=2
  // porque su publicacion suele tardar mas que CTH.
  function buildEumetWmsCfg({ url, layer, title, attribution, format, transparent, slotsBack }) {
    const cb = eumetCacheBust(slotsBack || 1);
    const legendUrl = `${url}?service=WMS&version=1.3.0` +
      `&request=GetLegendGraphic&format=image/png&width=400&height=200` +
      `&layer=${layer}&access_token=${EUMET_TOKEN}`;
    return {
      url, title, legendUrl,
      options: {
        layers: layer,
        format: format || 'image/png',
        transparent: transparent !== false,
        version: '1.3.0',
        attribution,
        access_token: EUMET_TOKEN,
        cb,
      },
    };
  }

  function getEumetLightningWMS() {
    return buildEumetWmsCfg({
      url: EUMET_LI_WMS, layer: EUMET_LI_LAYER, title: EUMET_LI_TITLE,
      attribution: '© EUMETSAT · MTG LI Accumulated Flash Area',
      slotsBack: 2,
    });
  }

  function getEumetConvectionWMS() {
    // RGB Convection es un composite raster (no transparente).
    return buildEumetWmsCfg({
      url: EUMET_CON_WMS, layer: EUMET_CON_LAYER, title: EUMET_CON_TITLE,
      attribution: '© EUMETSAT · MSG/SEVIRI RGB Convection',
      format: 'image/png', transparent: true,
      slotsBack: 2,
    });
  }

  // ── SIGMETs internacionales (AWC iSIGMET) ───────────────────────────
  // Usamos format=json (NO geojson) porque el geojson de AWC simplifica
  // los poligonos: nos devuelve el campo `coords` como string "lat lng,
  // lat lng, ..." que parseamos manualmente para tener la geometria
  // exacta. Tambien soportamos geom=CIRCLE leyendo del raw el centro y
  // el radio en NM.
  // Doc: https://aviationweather.gov/data/api/
  async function fetchSigmets() {
    const url = AWC_BASE + '/isigmet?format=json';
    const res = await safeFetch(url, 'SIGMET (AWC)');
    if (!res.ok) throw new Error('SIGMET HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data;
  }

  // ── Decodificador SIGMET ───────────────────────────────────────────
  // Convierte un SIGMET crudo en campos legibles en espanyol.

  function decodePhenomenon(hazard, qualifier) {
    const HAZ = {
      TS: 'Tormenta',
      TURB: 'Turbulencia',
      ICE: 'Engelamiento',
      MTW: 'Ondas de montaña',
      VA: 'Ceniza volcánica',
      DS: 'Tormenta de polvo',
      SS: 'Tormenta de arena',
      TC: 'Ciclón tropical',
      RDOACT: 'Nube radiactiva',
    };
    const QUAL = {
      OBSC: 'oscurecida',
      EMBD: 'embebida',
      FRQ:  'frecuente',
      SQL:  'línea de turbonada',
      ISOL: 'aislada',
      OCNL: 'ocasional',
      SEV:  'severo/a',
      MOD:  'moderado/a',
      HVY:  'fuerte',
    };
    const base = HAZ[String(hazard || '').toUpperCase()] || (hazard || '—');
    const q = QUAL[String(qualifier || '').toUpperCase()];
    return q ? `${base} ${q}` : base;
  }

  function decodeLevels(base, top, raw) {
    if (base != null && top != null) return `FL${pad3(base)} – FL${pad3(top)}`;
    if (top  != null) return `Hasta FL${pad3(top)}`;
    if (base != null) return `Desde FL${pad3(base)}`;
    // Fallback al raw: TOP FL400, BLW FL100, FL200/350
    if (!raw) return '—';
    let m = raw.match(/\bFL(\d{2,3})\s*\/\s*FL?(\d{2,3})\b/);
    if (m) return `FL${pad3(m[1])} – FL${pad3(m[2])}`;
    m = raw.match(/\bTOP\s+FL(\d{2,3})\b/);
    if (m) return `Hasta FL${pad3(m[1])}`;
    m = raw.match(/\bBLW\s+FL(\d{2,3})\b/);
    if (m) return `Por debajo de FL${pad3(m[1])}`;
    m = raw.match(/\bABV\s+FL(\d{2,3})\b/);
    if (m) return `Por encima de FL${pad3(m[1])}`;
    return '—';
  }
  function pad3(n) { return String(n).padStart(3, '0'); }

  function decodeMotion(dir, spd, chng) {
    const DIR = {
      N: 'norte', NE: 'noreste', E: 'este', SE: 'sureste',
      S: 'sur',   SW: 'suroeste', W: 'oeste', NW: 'noroeste',
    };
    const CHNG = { NC: 'sin cambio', INTSF: 'intensificándose', WKN: 'debilitándose' };
    const parts = [];
    if (!dir && !spd) parts.push('Estacionario');
    else if (dir && spd) parts.push(`Moviéndose hacia ${DIR[String(dir).toUpperCase()] || dir} a ${spd} kt`);
    else if (spd) parts.push(`Movimiento ${spd} kt`);
    else parts.push(`Movimiento hacia ${DIR[String(dir).toUpperCase()] || dir}`);
    if (chng && CHNG[String(chng).toUpperCase()]) {
      parts.push(CHNG[String(chng).toUpperCase()]);
    }
    return parts.join(' · ');
  }

  // Convierte el campo validTimeFrom/To de AWC a Date. AWC los devuelve
  // como EPOCH EN SEGUNDOS (no milisegundos), asi que pasarlos directos
  // a new Date() daba fechas de enero del 70. Detectamos por tamanyo:
  // valores < 1e12 son segundos, >= 1e12 son ms.
  function toDateSafe(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) {
        const n = parseInt(v, 10);
        const ms = n < 1e12 ? n * 1000 : n;
        return new Date(ms);
      }
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  // Fallback: parsea "VALID DDhhmm/DDhhmm" del texto crudo. Usa la fecha
  // de emision o "hoy" como referencia para inferir mes/anyo (los SIGMETs
  // solo dan dia+hora). Si el dia final es menor que el inicial, asume
  // cambio de mes.
  function parseSigmetValidityFromRaw(raw, refDate) {
    if (!raw) return null;
    const m = String(raw).match(/\bVALID\s+(\d{2})(\d{2})(\d{2})\s*\/\s*(\d{2})(\d{2})(\d{2})\b/);
    if (!m) return null;
    const ref = refDate || new Date();
    let year  = ref.getUTCFullYear();
    let month = ref.getUTCMonth();
    const d1 = parseInt(m[1], 10), h1 = parseInt(m[2], 10), mn1 = parseInt(m[3], 10);
    const d2 = parseInt(m[4], 10), h2 = parseInt(m[5], 10), mn2 = parseInt(m[6], 10);
    // Si el dia inicial es muy posterior al actual, probablemente mes anterior.
    if (d1 - ref.getUTCDate() > 20) {
      month--;
      if (month < 0) { month = 11; year--; }
    }
    const from = new Date(Date.UTC(year, month, d1, h1, mn1));
    // Si d2 < d1, cruza fin de mes.
    let yearTo = year, monthTo = month;
    if (d2 < d1) {
      monthTo++;
      if (monthTo > 11) { monthTo = 0; yearTo++; }
    }
    const to = new Date(Date.UTC(yearTo, monthTo, d2, h2, mn2));
    return { from, to };
  }

  function fmtUtcDayHour(d) {
    if (!d || isNaN(d.getTime())) return '?';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  }

  function decodeValidity(sig) {
    // 1) Intentar campos estructurados de AWC (epoch segundos).
    let from = toDateSafe(sig.validTimeFrom);
    let to   = toDateSafe(sig.validTimeTo);
    // 2) Si alguno falta o esta corrupto, parsear del raw.
    if (!from || !to) {
      const issued = toDateSafe(sig.issueTime) || new Date();
      const parsed = parseSigmetValidityFromRaw(sig.rawSigmet, issued);
      if (parsed) {
        from = from || parsed.from;
        to   = to   || parsed.to;
      }
    }
    if (!from && !to) return '—';
    return `${fmtUtcDayHour(from)} → ${fmtUtcDayHour(to)}`;
  }

  function decodeSigmet(sig) {
    return {
      phenomenon: decodePhenomenon(sig.hazard, sig.qualifier),
      levels:     decodeLevels(sig.base, sig.top, sig.rawSigmet),
      validity:   decodeValidity(sig),
      motion:     decodeMotion(sig.dir, sig.spd, sig.chng),
      firId:      sig.firId   || '',
      firName:    sig.firName || '',
      issuer:     sig.icaoId  || '',
      seriesId:   sig.seriesId|| '',
    };
  }

  // ── Geometria del SIGMET ───────────────────────────────────────────
  // AWC entrega el poligono en `coords` como "lat lng,lat lng,..." (sin
  // cierre del anillo). Para CIRCLE, leemos centro + radio del raw.

  function parseSigmetGeometry(sig) {
    // Caso poligono: cadena "lat lon, lat lon, ..."
    if (sig.coords && typeof sig.coords === 'string') {
      const pts = parseCoordPairs(sig.coords);
      if (pts.length >= 3) {
        // Cerramos el anillo si no esta cerrado.
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    // Caso poligono via array de objetos.
    if (Array.isArray(sig.coords) && sig.coords.length >= 3) {
      const pts = sig.coords
        .map(c => c && (Array.isArray(c) ? c : [c.lat, c.lon || c.lng]))
        .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length >= 3) {
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    // Caso CIRCLE: parsear del raw "WI CIRCLE 100NM CENTRE N4040 E00310"
    const raw = String(sig.rawSigmet || '');
    const mCircle = raw.match(/\bCIRCLE\s+(\d+)\s*NM\s+(?:CENTR?E\s+)?([NS])(\d{2,4})\s*([EW])(\d{3,5})\b/i);
    if (mCircle) {
      const radiusNM = Number(mCircle[1]);
      const lat = ddm(mCircle[2], mCircle[3]);
      const lng = ddm(mCircle[4], mCircle[5]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusNM)) {
        return { kind: 'circle', center: [lat, lng], radiusM: radiusNM * 1852 };
      }
    }
    // Caso poligono en raw "WI N4040 E00310 - N4205 E00420 - ..."
    const mPoly = raw.match(/\bWI(?:THIN)?\s+((?:[NS]\d{2,4}\s*[EW]\d{3,5}\s*-?\s*)+)/i);
    if (mPoly) {
      const pts = [...mPoly[1].matchAll(/([NS])(\d{2,4})\s*([EW])(\d{3,5})/g)].map(m => {
        const lat = ddm(m[1], m[2]);
        const lng = ddm(m[3], m[4]);
        return [lat, lng];
      }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length >= 3) {
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    return null;
  }

  // Parsea "lat lng,lat lng,..." (formato AWC). Soporta lat lng separados
  // por espacio o coma, separados entre pares por coma.
  function parseCoordPairs(s) {
    if (!s) return [];
    return s.split(/[,;]+/).map(pair => {
      const m = pair.trim().match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2])];
    }).filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  // Convierte un identificador ICAO de coordenada (N4040 = 40°40') a
  // grados decimales. Acepta NDDMM, NDDMMMM (4-5 digitos lat) y EDDDMM,
  // EDDDMMMM (5-6 digitos lng).
  function ddm(hemi, digits) {
    const d = String(digits);
    let deg, min;
    if (d.length === 4 || d.length === 5) {
      const cut = d.length - 2;
      deg = Number(d.slice(0, cut));
      min = Number(d.slice(cut));
    } else if (d.length === 6 || d.length === 7) {
      // segundos incluidos (raro en SIGMET, pero por si acaso)
      const cut = d.length - 4;
      deg = Number(d.slice(0, cut));
      min = Number(d.slice(cut, cut + 2)) + Number(d.slice(cut + 2)) / 100;
    } else {
      return NaN;
    }
    let v = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') v = -v;
    return v;
  }

  // Extrae poligono o circulo del cuerpo de un NOTAM en formato ICAO.
  // Estrategias en orden de fiabilidad:
  //   1) CIRCLE explicito en el cuerpo:
  //      "RADIUS N NM CENTR(ED|E) (ON) DDDD[NS]DDDDD[EW]"
  //   2) Poligono explicito en el cuerpo:
  //      secuencia >=3 puntos "DDDD[NS]DDDDD[EW]" o "[NS]DDDD [EW]DDDDD"
  //   3) FALLBACK: Q-line con centro+radio en formato ICAO compacto:
  //      "Q) FIR/QCODE/.../<DDDD[NS]DDDDD[EW]<radius3>"
  //      Esto es CLAVE para NOTAMs militares LPPC y similares que no
  //      meten coords en el body (solo nombran el area por su id, p.ej.
  //      "LPR1 ACTIVATED"). El Q-line SI lleva centroide y radio NM.
  // Devuelve { kind:'poly', latlngs } | { kind:'circle', center, radiusM }
  // | null si no se puede parsear.
  function parseNotamGeometry(rawText) {
    if (!rawText) return null;
    const text = String(rawText);

    // Caso 1: CIRCLE explicito en cuerpo (mas especifico).
    const mC = text.match(
      /RADIUS\s+(\d+(?:\.\d+)?)\s*(NM|KM)\s+(?:CENTR(?:E|ED)\s+)?(?:ON\s+)?(\S+\s*\S*)/i
    );
    if (mC) {
      const radius = Number(mC[1]);
      const unit = mC[2].toUpperCase();
      const radiusM = unit === 'KM' ? radius * 1000 : radius * 1852;
      const pt = parseSingleICAOCoord(mC[3]);
      if (pt && Number.isFinite(radiusM)) {
        return { kind: 'circle', center: pt, radiusM, source: 'body-circle' };
      }
    }

    // Caso 2: POLY en cuerpo. Buscamos puntos ICAO PERO ignorando el
    // Q-line del header (esa coord es el centroide del area, no un
    // vertice). El Q-line tiene la forma "Q) FIR/Q.../..." asi que
    // troceamos en el primer "A) " que marca el inicio del cuerpo.
    const bodyStart = text.indexOf('A)');
    const body = bodyStart >= 0 ? text.slice(bodyStart) : text;
    // Variante A: DDDD[NS]DDDDD[EW]   (digitos primero)
    const rxA = /\b(\d{4,6})\s*([NS])\s*(\d{5,7})\s*([EW])\b/g;
    // Variante B: [NS]DDDD [EW]DDDDD  (hemisferio primero)
    const rxB = /\b([NS])\s*(\d{4,6})\s*([EW])\s*(\d{5,7})\b/g;
    const pts = [];
    let m;
    while ((m = rxA.exec(body)) !== null) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
    }
    if (pts.length < 3) {
      pts.length = 0;
      while ((m = rxB.exec(body)) !== null) {
        const lat = ddm(m[1], m[2]);
        const lng = ddm(m[3], m[4]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
      }
    }
    if (pts.length >= 3) {
      const closed = (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
        ? pts : pts.concat([pts[0]]);
      return { kind: 'poly', latlngs: closed, source: 'body-poly' };
    }

    // Caso 3 FALLBACK: extraer centroide y radio del Q-line.
    const q = parseNotamQLineGeometry(text);
    if (q) return q;

    return null;
  }

  // Parsea el centroide y radio del Q-line ICAO. Formato:
  //   Q) FIR/QCODE/T/P/S/L/U/<coordenada+radio>
  // donde la coordenada+radio es DDDD[NS]DDDDD[EW]<NNN> (NN NM).
  // Algunos NOTAMs no traen el radio (acaba en .../000/999/) y otros
  // omiten el campo entero, asi que probamos con y sin radio.
  function parseNotamQLineGeometry(rawText) {
    if (!rawText) return null;
    // Intenta primero con radio explicito (3 digitos al final).
    let m = String(rawText).match(
      /Q\)\s*[A-Z]{4}\/Q[A-Z]{4}\/[^\/]+\/[^\/]+\/[^\/]+\/\d{3}\/\d{3,4}\/(\d{2,4})([NS])(\d{3,5})([EW])(\d{3})\b/
    );
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      const radiusNM = parseInt(m[5], 10);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusNM) && radiusNM > 0) {
        return { kind: 'circle', center: [lat, lng], radiusM: radiusNM * 1852, source: 'q-line' };
      }
    }
    // Sin radio: el Q-line acaba en la coordenada. Como fallback dibujamos
    // un circulo de 10 NM al rededor del centroide para que el piloto vea
    // donde esta el area aunque sea aproximado.
    m = String(rawText).match(
      /Q\)\s*[A-Z]{4}\/Q[A-Z]{4}\/[^\/]+\/[^\/]+\/[^\/]+\/\d{3}\/\d{3,4}\/(\d{2,4})([NS])(\d{3,5})([EW])\b/
    );
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { kind: 'circle', center: [lat, lng], radiusM: 10 * 1852, source: 'q-line-noradius' };
      }
    }
    return null;
  }

  function parseSingleICAOCoord(s) {
    if (!s) return null;
    let m = String(s).match(/\b(\d{4,6})\s*([NS])\s*(\d{5,7})\s*([EW])\b/);
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    }
    m = String(s).match(/\b([NS])\s*(\d{4,6})\s*([EW])\s*(\d{5,7})\b/);
    if (m) {
      const lat = ddm(m[1], m[2]);
      const lng = ddm(m[3], m[4]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    }
    return null;
  }

  return {
    fetchMETAR, fetchTAF, fetchWeatherForAirports,
    getRainviewerCloudUrl, getEumetCthWMS,
    getEumetLightningWMS, getEumetConvectionWMS,
    fetchSigmets, decodeSigmet, parseSigmetGeometry,
    parseNotamGeometry,
    // alias retro-compatible para código que aún usa el nombre antiguo
    getGibsCloudWMS: getEumetCthWMS,
  };
})();
