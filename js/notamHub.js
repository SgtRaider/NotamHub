// Cliente para la API ICARO NOTAM/TSA hospedada en notamhub.duckdns.org.
//
// Endpoints relevantes:
//   GET /health
//   GET /tsas/active                 ? at, bbox, vmin, vmax
//   GET /notams/aerodrome/{icao}     ? at, include_refs
//   GET /notams/fir/{icao}           ? at, include_refs
//   GET /bulletins
//
// Autenticacion: cabecera x-user-token. En produccion (Pages) la inyecta
// la Pages Function /api/notamhub/... desde env var NOTAMHUB_USER_TOKEN
// o default; en local (file://) el navegador no puede llegar a la API
// sin token, asi que tambien aceptamos un override client-side guardado
// en localStorage por si el usuario quiere usar otra cuenta.

window.NotamHub = window.NotamHub || {};
window.NotamHub.notamHub = (function () {
  'use strict';

  // Llamada DIRECTA a la API duckdns. Requiere CORS habilitado en el FastAPI
  // (allow_origins con el dominio de la web + allow_headers x-user-token /
  // x-admin-token). El token de usuario viaja en la cabecera desde el cliente.
  const BASE = 'https://notamhub.duckdns.org';

  // Token de usuario (scope user) por defecto — el mismo que ya es público en
  // el repo. El usuario puede sobreescribirlo por localStorage. NOTA: en modo
  // directo el token de usuario viaja al navegador (es de unidad, no personal).
  const DEFAULT_USER_TOKEN = 'FPIy1bgWG5gGRviMKSxeLInxZvjD1KYhILgof0WVgfg';

  const TOKEN_KEY = 'notamhub_notamhub_user_token';
  const ADMIN_TOKEN_KEY = 'notamhub_admin_token';

  function getStoredToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; }
  }
  function setStoredToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token || ''); } catch (_) {}
  }
  function clearStoredToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }
  function getStoredAdminToken() {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || null; } catch (_) { return null; }
  }
  function setStoredAdminToken(token) {
    try { localStorage.setItem(ADMIN_TOKEN_KEY, token || ''); } catch (_) {}
  }

  function buildHeaders() {
    const h = { 'Accept': 'application/json' };
    h['x-user-token'] = getStoredToken() || DEFAULT_USER_TOKEN;
    const admin = getStoredAdminToken();
    if (admin) h['x-admin-token'] = admin;
    return h;
  }

  function buildUrl(path, qs) {
    const url = new URL(BASE + path);
    if (qs) {
      for (const [k, v] of Object.entries(qs)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  // Patron de las respuestas de error del edge de Cloudflare. Cuando
  // CF no puede llegar al upstream, o tiene una caida transitoria, o
  // hay DNS error puntual, devuelve un body MUY corto tipo "error
  // code: 1016" con status 403/520/525/530. No es nuestro upstream
  // diciendo "prohibido", es CF antes de que llegue la Pages Function.
  // Son SIEMPRE transitorios y se reintentan.
  const CF_EDGE_ERR_RE = /^\s*error code:\s*\d{3,4}\s*$/i;

  async function _fetchJSON(path, qs, opts) {
    const url = buildUrl(path, qs);
    console.debug('[notamHub] GET', url);
    // Retry para 5xx, errores de red, Y errores transitorios del edge
    // de Cloudflare (codigos 1xxx, llegan como 403/520-525/530 con
    // body "error code: NNNN"). Backoff exponencial empezando en 800ms.
    // 4xx "reales" (400/401/403 con JSON detail, 404, 422, etc.) NO se
    // reintentan: son fallos del cliente, malgastan tiempo.
    const MAX_ATTEMPTS = 4;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await fetch(url, Object.assign({ headers: buildHeaders() }, opts || {}));
      } catch (e) {
        lastErr = new Error('Red caida o CORS: ' + e.message);
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = 800 * Math.pow(2, attempt - 1);
          console.warn('[notamHub] network error, retry ' + attempt + '/' + (MAX_ATTEMPTS - 1) +
            ' en ' + backoffMs + 'ms:', e.message);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        console.error('[notamHub] network error final:', e);
        throw lastErr;
      }
      if (res.ok) {
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) {
          console.error('[notamHub] respuesta no es JSON:', text.slice(0, 500));
          throw new Error('Respuesta no JSON del API: ' + text.slice(0, 100));
        }
        console.debug('[notamHub] response:', Array.isArray(data) ? `array(${data.length})` : typeof data, data);
        return data;
      }
      let body = '';
      try { body = await res.text(); } catch (_) {}
      const status = res.status;
      const is5xx = status >= 500 && status < 600;
      const isCfEdge = CF_EDGE_ERR_RE.test(body);
      // Cloudflare a veces devuelve 520-525 (origin unreachable) o
      // 530 (origin error) sin tocar nuestro upstream. Reintentables.
      const isCfStatus = status === 520 || status === 521 || status === 522 ||
                         status === 523 || status === 524 || status === 525 || status === 530;
      const isRetryable = is5xx || isCfEdge || isCfStatus;
      if (isRetryable && attempt < MAX_ATTEMPTS) {
        const backoffMs = 800 * Math.pow(2, attempt - 1);
        const tag = isCfEdge ? 'CF edge ' + body.trim() : 'HTTP ' + status;
        console.warn('[notamHub] ' + tag + ', retry ' + attempt + '/' + (MAX_ATTEMPTS - 1) +
          ' en ' + backoffMs + 'ms');
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      console.error('[notamHub] HTTP', status, body.slice(0, 500));
      let detail = '';
      try { const j = JSON.parse(body); detail = j.detail || j.error || JSON.stringify(j).slice(0, 200); }
      catch (_) { detail = body.slice(0, 200); }
      // Mensaje user-friendly cuando es claro que el problema es de CF.
      if (isCfEdge) {
        throw new Error('Cloudflare ' + body.trim() + ' tras ' + MAX_ATTEMPTS +
          ' intentos. Suele ser un fallo transitorio en el edge de Cloudflare ' +
          'o en el DNS upstream — vuelve a intentar en 30-60 segundos.');
      }
      throw new Error(`HTTP ${status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
    }
    throw lastErr || new Error('Fetch fallo sin razon clara');
  }

  // ── Helpers de parsing ─────────────────────────────────────────────

  // Parsea un token de altitud aeronautica a { ft:Number, label:String }.
  // Self-contained: antes delegaba en window.NotamHub.parser.parseAltitudeToken
  // (parser.js ya no existe). Casos:
  //   - "GND" / "SFC" / "ASFC"      -> { ft: 0, label: 'GND' }
  //   - "UNL" / "UNLIM" / "UNLTD"   -> { ft: 99999, label: 'UNL' }
  //   - "FL245" / "FL 95"           -> { ft: nivel*100, label: 'FLxxx' }
  //   - "2500FT AMSL" / "2500 FT"   -> { ft: numero, label: token tal cual }
  //     "2500FT AGL"                   (mantenemos el label original)
  //   - numerico suelto "2500"      -> { ft: 2500, label: token }
  // Ante token vacio o no reconocible devuelve { ft: 0, label: token||'GND' }.
  function parseAltitudeToken(token) {
    if (token == null) return { ft: 0, label: 'GND' };
    const raw = String(token).trim();
    if (!raw) return { ft: 0, label: 'GND' };
    const up = raw.toUpperCase();

    // Suelo: GND / SFC / ASFC (above surface).
    if (/\b(?:GND|SFC|ASFC)\b/.test(up) || up === 'GND' || up === 'SFC' || up === 'ASFC') {
      return { ft: 0, label: 'GND' };
    }
    // Ilimitado: UNL / UNLIM / UNLTD / UNLIMITED.
    if (/\bUNL/.test(up)) {
      return { ft: 99999, label: 'UNL' };
    }
    // Flight level: "FL245", "FL 95".
    const fl = up.match(/\bFL\s*0*(\d{1,3})\b/);
    if (fl) {
      const lvl = parseInt(fl[1], 10);
      return { ft: lvl * 100, label: 'FL' + fl[1] };
    }
    // Pies: "2500FT AMSL", "2500 FT", "2500FT AGL", o numerico suelto.
    const ftMatch = up.match(/(\d{1,6})\s*FT\b/);
    if (ftMatch) {
      return { ft: parseInt(ftMatch[1], 10), label: raw };
    }
    const num = up.match(/^(\d{1,6})$/);
    if (num) {
      return { ft: parseInt(num[1], 10), label: raw };
    }
    // No reconocido: devolvemos 0 ft pero conservamos el label original.
    return { ft: 0, label: raw };
  }

  // ── Endpoints ──────────────────────────────────────────────────────

  // /tsas/active — TSAs activas. Modos:
  //   - Punto en el tiempo: pasar solo `at` (default API = ahora).
  //   - Rango: pasar `at` + `atTo`. Devuelve TSAs con al menos una
  //     ventana solapando el periodo [at, atTo].
  // bbox = "min_lat,max_lat,min_lon,max_lon"; vmin/vmax = filtro
  // altitud (ft).
  function fetchActiveTSAs(params) {
    params = params || {};
    const qs = {};
    if (params.at)   qs.at    = params.at   instanceof Date ? params.at.toISOString()   : params.at;
    if (params.atTo) qs.at_to = params.atTo instanceof Date ? params.atTo.toISOString() : params.atTo;
    if (params.bbox) qs.bbox = Array.isArray(params.bbox) ? params.bbox.join(',') : params.bbox;
    if (params.vmin != null) qs.vmin = params.vmin;
    if (params.vmax != null) qs.vmax = params.vmax;
    return _fetchJSON('/tsas/active', qs);
  }

  function fetchNotamsByFIR(icao, params) {
    params = params || {};
    // Si params.at es Date, lo serializamos como ISO 8601 UTC. Si no
    // (string ISO ya valido o null), lo pasamos tal cual. El default
    // de Date.toString() produce algo tipo "Wed Jun 03 ..." que el
    // backend rechaza con 422 (datetime_from_date_parsing).
    const at = params.at instanceof Date ? params.at.toISOString() : params.at;
    return _fetchJSON('/notams/fir/' + encodeURIComponent(icao), {
      at,
      include_refs: params.includeRefs ? 'true' : undefined,
    });
  }

  function fetchNotamsByAerodrome(icao, params) {
    params = params || {};
    const at = params.at instanceof Date ? params.at.toISOString() : params.at;
    return _fetchJSON('/notams/aerodrome/' + encodeURIComponent(icao), {
      at,
      include_refs: params.includeRefs ? 'true' : undefined,
    });
  }

  function fetchBulletins() {
    return _fetchJSON('/bulletins', null);
  }

  // Normaliza un NotamOut del API al shape que consume notamView/UI:
  //   notamId, icaoLocation, fromDate, toDate, text/raw, fir/aerodrome
  // El API entrega: notam_id, section, fir, aerodrome, area, valid_from,
  // valid_to, is_estimate, is_permanent, body. Mapeamos:
  //   icaoLocation <- aerodrome || fir || area
  //   text/raw     <- body (puede ser null en NOTAMs sin cuerpo)
  function normalizeNotam(n) {
    if (!n) return null;
    const icao = n.aerodrome || n.fir || n.area || '';
    return {
      notamId:      n.notam_id || '',
      icaoLocation: String(icao).toUpperCase(),
      fromDate:     n.valid_from || null,
      toDate:       n.valid_to   || null,
      text:         n.body || '',
      raw:          n.body || '',
      _source:      'notamhub',
      _section:     n.section || '',
      _isEstimate:  !!n.is_estimate,
      _isPermanent: !!n.is_permanent,
    };
  }

  // Pide a NotamHub todos los NOTAMs relevantes para una lista de
  // ICAOs. La API es punto-a-punto: /notams/aerodrome/{icao} y
  // /notams/fir/{icao}, asi que disparamos N requests en paralelo y
  // unimos los resultados.
  // Distingue aerodromos (LE??, GC??) de FIRs (LECM, LECB, GCCC,
  // LPPC, ...). Si una request falla (404, timeout) la trata como
  // vacia y sigue con el resto, asi nunca rompe el resto.
  async function fetchAllNotamsFor(icaos, opts) {
    if (!Array.isArray(icaos) || !icaos.length) return [];
    opts = opts || {};
    const at = opts.at instanceof Date ? opts.at.toISOString() : opts.at;
    const FIR_RE = /^(LECM|LECB|LPPC|GCCC|GMMM|LFFF|LFMM|EGTT|DAAA)$/;
    const calls = icaos.map(icao => {
      const code = String(icao || '').trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return Promise.resolve([]);
      const isFir = FIR_RE.test(code);
      const p = isFir
        ? fetchNotamsByFIR(code, { at })
        : fetchNotamsByAerodrome(code, { at });
      return p.catch(e => {
        console.warn('[notamHub] fetchNotams', code, 'fallo:', e && e.message || e);
        return [];
      });
    });
    const results = await Promise.all(calls);
    const out = [];
    for (const arr of results) {
      if (!Array.isArray(arr)) continue;
      for (const n of arr) {
        const norm = normalizeNotam(n);
        if (norm) out.push(norm);
      }
    }
    console.info(`[notamHub] fetchAllNotamsFor: ${icaos.length} ICAOs -> ${out.length} NOTAMs`);
    return out;
  }

  function ping() {
    return _fetchJSON('/health', null).catch(() => false);
  }

  // ── Conversion al shape interno (state.tsas) ───────────────────────
  // El parser PDF devuelve TSAs con:
  //   { id, name, vertical: {lowerFt, upperFt, lowerLabel, upperLabel},
  //     polygon: [[lat,lng], ...], schedules: [{startUTC, endUTC}], rawBlock }
  //
  // La API entrega:
  //   { name, parent_notam_id, is_circle, bbox, vertical_lower_label,
  //     vertical_upper_label, polygon_geojson, n_schedules }
  //
  // No incluye schedules individuales — solo el count. Como solo
  // consultamos /tsas/active con un `at` concreto, sintetizamos una
  // ventana de 24h alrededor de `at` para que el resto del flujo
  // (tabla, filtros, mapa) siga funcionando.
  function convertTSAsToInternal(apiList, atDate) {
    if (!Array.isArray(apiList)) {
      console.warn('[notamHub] convertTSAs recibido NO-array:', apiList);
      return [];
    }
    const parseAlt = parseAltitudeToken;
    const out = [];
    const skipped = { noName: 0, badPolygon: 0, noSchedules: 0 };
    let synthCount = 0;

    // Diagnostico is_work_area: cuenta true/false/undefined/otros y
    // decide si el campo es fiable.
    //   - Si hay >=1 false -> el campo discrimina, lo usamos como API dice.
    //   - Si TODAS son true (y count > 0) -> el API tiene un default fijo
    //     y el campo no discrimina. Activamos heuristica por nombre
    //     (PASILLO/CORREDOR -> transito, resto -> trabajo).
    //   - Si todas undefined -> mismo fallback heuristico.
    let useNameHeuristic = false;
    if (apiList.length > 0) {
      const wHist = { true: 0, false: 0, undefined: 0 };
      for (const t of apiList) {
        if (typeof t.is_work_area === 'boolean') wHist[String(t.is_work_area)]++;
        else wHist.undefined++;
      }
      const fieldDiscriminates = wHist.true > 0 && wHist.false > 0;
      useNameHeuristic = !fieldDiscriminates;
      console.info('[notamHub] is_work_area distribucion: ' + JSON.stringify(wHist) +
        (useNameHeuristic
          ? ' · campo no discrimina, usando heuristica nombre (CORREDOR/PASILLO -> transito)'
          : ' · campo OK del API'));
    }
    for (let i = 0; i < apiList.length; i++) {
      const t = apiList[i];
      if (!t || !t.name) { skipped.noName++; continue; }

      // Altitudes: la API entrega numericos (vertical_lower_ft /
      // vertical_upper_ft) ademas de los labels. Preferimos numericos;
      // fallback a parsing del label por si vienen vacios.
      let lowerFt, upperFt, lowerLabel, upperLabel;
      if (Number.isFinite(t.vertical_lower_ft)) {
        lowerFt = t.vertical_lower_ft;
        lowerLabel = t.vertical_lower_label || (lowerFt === 0 ? 'GND' : `${lowerFt}FT`);
      } else {
        const p = parseAlt ? parseAlt(t.vertical_lower_label || 'GND') : { ft: 0, label: 'GND' };
        lowerFt = p.ft; lowerLabel = p.label;
      }
      if (Number.isFinite(t.vertical_upper_ft)) {
        upperFt = t.vertical_upper_ft;
        upperLabel = t.vertical_upper_label || (upperFt >= 60000 ? 'UNL' : `${upperFt}FT`);
      } else {
        const p = parseAlt ? parseAlt(t.vertical_upper_label || 'UNL') : { ft: 99999, label: 'UNL' };
        upperFt = p.ft; upperLabel = p.label;
      }

      // Poligono: preferimos polygon_geojson; si la TSA es circular y
      // viene con circle_center_*/circle_radius_nm, generamos el anillo.
      let polygon = geojsonToLatLngArray(t.polygon_geojson);
      if ((!polygon || polygon.length < 3) && t.is_circle &&
          Number.isFinite(t.circle_center_lat) &&
          Number.isFinite(t.circle_center_lon) &&
          Number.isFinite(t.circle_radius_nm)) {
        polygon = circleToPolygon(t.circle_center_lat, t.circle_center_lon, t.circle_radius_nm);
      }
      if (!polygon || polygon.length < 3) {
        skipped.badPolygon++;
        if (skipped.badPolygon <= 3) {
          console.warn('[notamHub] TSA con poligono no parseable:', t.name,
            'polygon_geojson:', t.polygon_geojson, 'is_circle:', t.is_circle);
        }
        continue;
      }

      // Schedules: la API entrega ahora un array de TsaWindow con
      // start/end (ISO UTC) + raw. Convertimos a Date. Si por lo que
      // sea viene vacio, sintetizamos una ventana de 24h alrededor de
      // `atDate` como fallback para que la tabla y filtros no rompan.
      // Dedup INTRA-array por start+end por si la API repite ventanas
      // (visto en ICARO XXI: a veces la misma ventana aparece varias
      // veces si vino en >1 NOTAM padre).
      let schedules = [];
      if (Array.isArray(t.schedules) && t.schedules.length > 0) {
        const seenInner = new Set();
        schedules = t.schedules
          .map(w => ({
            startUTC: _toUTCDate(w.start),
            endUTC:   _toUTCDate(w.end),
            raw:      w.raw || `${w.start} / ${w.end}`,
          }))
          .filter(w => w.startUTC && w.endUTC && !isNaN(w.startUTC.getTime()) && !isNaN(w.endUTC.getTime()))
          .filter(w => {
            const sig = w.startUTC.getTime() + '-' + w.endUTC.getTime();
            if (seenInner.has(sig)) return false;
            seenInner.add(sig);
            return true;
          });
      }
      if (!schedules.length) {
        synthCount++;
        const ref = atDate ? new Date(atDate) : new Date();
        const startUTC = new Date(Math.floor(ref.getTime() / 3600000) * 3600000);
        const endUTC   = new Date(startUTC.getTime() + 24 * 3600 * 1000);
        schedules = [{ startUTC, endUTC, raw: 'sintético 24h (API sin schedules)' }];
      }

      out.push({
        id: 'NH_' + (t.parent_notam_id || i) + '_' + i,
        name: t.name,
        format: 'NOTAMHUB',
        vertical: { lowerFt, upperFt, lowerLabel, upperLabel },
        polygon,
        // El parser PDF rellena centroid via geom.centroid(polygon). El
        // corte transversal (chooseExtremes -> greatCircleDistance) lo
        // necesita; sin centroid crashea con "Cannot read properties of
        // undefined".
        centroid: polygonCentroid(polygon),
        schedules,
        rawBlock: `TSA ${t.name}\nNOTAM ${t.parent_notam_id || '?'}\n` +
                  `${lowerLabel} / ${upperLabel}\n` +
                  `${schedules.length} ventana(s) horaria(s).`,
        // Vigencia REAL del NOTAM/TSA (span total, no recortado a la búsqueda).
        validFrom: _toUTCDate(t.schedule_min_start),
        validTo:   _toUTCDate(t.schedule_max_end),
        _source: 'notamhub',
        _parentNotam: t.parent_notam_id,
        _nSchedules: schedules.length,
        _isCircle: !!t.is_circle,
        _circleRadiusNm: Number.isFinite(t.circle_radius_nm) ? t.circle_radius_nm : null,
        _largeCircle: !!t.is_circle && Number.isFinite(t.circle_radius_nm) && t.circle_radius_nm > 75,
        // is_work_area:
        //   - Si el API lo discrimina (mix de true/false) -> lo usamos.
        //   - Si el API manda todo true o todo undefined ->
        //     heuristica por nombre: PASILLO/CORREDOR -> transito,
        //     resto -> trabajo. Coincide con la convencion del
        //     boletin ICARO XXI verificada con el PDF.
        _isWorkArea: useNameHeuristic
          ? !/\b(PASILLO|CORREDOR|CORRIDOR|TRANSITO|TRANSIT)\b/i.test(t.name || '')
          : (t.is_work_area === true),
      });
    }

    // Dedup por (name + vertical). La API a veces devuelve la misma TSA
    // varias veces (uno por cada NOTAM padre que la publica con ventana
    // distinta). Las fusionamos en una sola TSA con la UNION de
    // schedules. Asi quedan filas unicas en la tabla en vez de
    // "TSA CORREDOR SUR 1 LOW" repetida x2.
    const dedupMap = new Map();
    let mergedCount = 0;
    for (const t of out) {
      // Si lowerLabel/upperLabel son null o '', usamos los ft numericos
      // como discriminador. Sin esto, dos TSAs distintas con labels
      // ausentes (raro pero posible si el API entrega vertical sin
      // labels) se mergeaban en una sola por colision de key
      // "NAME||null||null".
      const lo = t.vertical.lowerLabel || ('L' + (t.vertical.lowerFt | 0));
      const up = t.vertical.upperLabel || ('U' + (t.vertical.upperFt | 0));
      const key = t.name + '||' + lo + '||' + up;
      if (!dedupMap.has(key)) {
        dedupMap.set(key, Object.assign({}, t, { schedules: t.schedules.slice() }));
        continue;
      }
      const ex = dedupMap.get(key);
      // Set de schedules ya vistos (start+end ms) para no duplicar.
      const seen = new Set(ex.schedules.map(s =>
        (s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC)) + '-' +
        (s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC))
      ));
      for (const s of t.schedules) {
        const sa = s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC);
        const sb = s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC);
        const sig = sa + '-' + sb;
        if (!seen.has(sig)) { ex.schedules.push(s); seen.add(sig); }
      }
      // Lista de parent_notam_ids acumulados para diagnostico.
      if (t._parentNotam) {
        const cur = String(ex._parentNotam || '').split(',').filter(Boolean);
        if (!cur.includes(t._parentNotam)) cur.push(t._parentNotam);
        ex._parentNotam = cur.join(',');
      }
      // is_work_area: si CUALQUIERA de las entradas fusionadas (mismo
      // name+vertical) tiene wa=false, la TSA es de transito. Razon:
      // algunos NOTAM padre marcan por error TSAs de transito como
      // work (visto en D1610/26 que pone wa=true a TODAS sus TSAs,
      // incluidos PASILLO HUELVA, PASILLO ZAFRA, ESTRECHO 1E/1W,
      // ANDEVALO, etc., que el resto de NOTAMs publican como
      // transito). Cualquier NOTAM que la marque como transito tiene
      // prioridad.
      if (t._isWorkArea === false) ex._isWorkArea = false;
      ex._nSchedules = ex.schedules.length;
      mergedCount++;
    }
    // Ordena las schedules de cada TSA por start asc.
    const dedupedOut = [];
    for (const t of dedupMap.values()) {
      t.schedules.sort((a, b) => {
        const sa = a.startUTC instanceof Date ? a.startUTC.getTime() : Date.parse(a.startUTC);
        const sb = b.startUTC instanceof Date ? b.startUTC.getTime() : Date.parse(b.startUTC);
        return sa - sb;
      });
      // Vigencia real: que cubra todas las ventanas tras la fusión.
      if (t.schedules.length) {
        const ms = (d) => d instanceof Date ? d.getTime() : Date.parse(d);
        const minS = new Date(Math.min.apply(null, t.schedules.map(s => ms(s.startUTC))));
        const maxE = new Date(Math.max.apply(null, t.schedules.map(s => ms(s.endUTC))));
        if (!(t.validFrom instanceof Date) || isNaN(t.validFrom.getTime()) || minS < t.validFrom) t.validFrom = minS;
        if (!(t.validTo instanceof Date) || isNaN(t.validTo.getTime()) || maxE > t.validTo) t.validTo = maxE;
      }
      dedupedOut.push(t);
    }
    console.info(`[notamHub] convertTSAs: ${apiList.length} entrada(s) → ${dedupedOut.length} TSAs ` +
                 `(${mergedCount} fusionadas por name+vertical) · ${skipped.noName} sin nombre · ` +
                 `${skipped.badPolygon} sin poligono · ${synthCount} con schedules sintetizados`);
    return dedupedOut;
  }

  // Convierte un circulo (centro lat/lon, radio NM) en un anillo de N
  // puntos para visualizar el poligono. Aproximacion plana suficiente
  // para radios tipicos de TSA (<100 NM): 1 NM ≈ 1/60° latitud, y la
  // longitud se compensa con cos(lat).
  function circleToPolygon(lat, lon, radiusNM, points) {
    const n = Math.max(8, points || 32);
    // Para latitudes muy altas (cerca de los polos), cos(lat) tiende
    // a 0 y dLon -> Infinity. Clamp a un valor que corresponde a
    // ~88.5 grados (cos(88.5°) ≈ 0.026) — suficiente para todas las
    // TSAs operacionales reales en el planeta. Sin esto, una TSA
    // erronea o un parser bug que diese lat=89.99 generaria
    // poligonos con dLon enorme que romperia el render del mapa.
    const COS_MIN = 0.026;
    const cosLat = Math.max(COS_MIN, Math.cos(lat * Math.PI / 180));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const dLat = (radiusNM / 60) * Math.cos(a);
      const dLon = (radiusNM / 60) * Math.sin(a) / cosLat;
      out.push([lat + dLat, lon + dLon]);
    }
    out.push(out[0]);   // cierra el anillo
    return out;
  }

  // Centroide barato del poligono (media aritmetica de lat/lon). Suficiente
  // para anclar el corte transversal y la leyenda. Si el modulo geom esta
  // cargado, lo delegamos para coherencia con las TSAs del parser PDF.
  function polygonCentroid(polygon) {
    const geomMod = window.NotamHub && window.NotamHub.geom;
    if (geomMod && typeof geomMod.centroid === 'function') {
      return geomMod.centroid(polygon);
    }
    if (!polygon || !polygon.length) return [0, 0];
    let lat = 0, lon = 0;
    for (const [a, b] of polygon) { lat += a; lon += b; }
    return [lat / polygon.length, lon / polygon.length];
  }

  // Acepta varios shapes posibles:
  //   { type: "Polygon", coordinates: [[[lng,lat], ...]] }   (GeoJSON spec)
  //   { type: "MultiPolygon", coordinates: [ [[[lng,lat],...]] ] }
  //   array bruto de [lng,lat] o [lat,lng] (heuristico)
  function geojsonToLatLngArray(g) {
    if (!g) return null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0]) {
      return g.coordinates[0].map(p => [Number(p[1]), Number(p[0])]);
    }
    if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates[0] && g.coordinates[0][0]) {
      // Concatenamos todos los anillos exteriores en una sola lista de puntos
      // (suficiente para visualizar TSAs multiparte como bbox combinado).
      const pts = [];
      for (const poly of g.coordinates) {
        if (poly && poly[0]) for (const p of poly[0]) pts.push([Number(p[1]), Number(p[0])]);
      }
      return pts;
    }
    if (Array.isArray(g) && g.length >= 3) {
      // Heuristica: si valores absolutos del primer "x" > 90 asume [lng,lat].
      const a = g[0];
      if (Array.isArray(a) && a.length >= 2) {
        const swap = Math.abs(Number(a[0])) > 90;
        return g.map(p => swap ? [Number(p[1]), Number(p[0])] : [Number(p[0]), Number(p[1])]);
      }
    }
    return null;
  }

  // Extrae el sub-bloque de body correspondiente a una TSA. Cada NOTAM
  // padre concatena varias TSAs separadas por una linea "TSA <NAME>";
  // tomamos desde esa linea hasta la siguiente cabecera "TSA " o EOF.
  // Devuelve null si no se encuentra el nombre.
  function findTsaBlockInBody(body, name) {
    if (!body || !name) return null;
    const escName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Cabecera "TSA NAME" al inicio de linea, seguida de salto o whitespace.
    const re = new RegExp('(^|\\n)' + escName + '\\s*\\r?\\n', 'i');
    const m = re.exec(body);
    if (!m) return null;
    const startIdx = m.index + (m[1] ? 1 : 0);
    const after = startIdx + name.length;
    const next = body.indexOf('\nTSA ', after);
    return body.slice(startIdx, next > 0 ? next : body.length);
  }

  function blockHasRmk(block) {
    if (!block) return false;
    return /\bRMK\s*:/i.test(block);
  }

  // Re-clasifica work/transit consultando el texto de los NOTAM padre.
  // La API NotamHub publica is_work_area=true para TSAs que el boletin
  // PDF marca como transito (con RMK de coordinacion ECAO/APP). Para
  // alinear API con PDF, traemos el body del NOTAM padre, localizamos
  // el sub-bloque de la TSA y, si tiene "RMK:", forzamos
  // _isWorkArea=false. La regla es "any-false wins" cruzando todos los
  // parents (igual que la dedup): basta con que UN parent traiga la
  // TSA con RMK para marcarla transito.
  //
  // Hace fetch en paralelo de las 3 FIRs espanolas (LECM/LECB/GCCC).
  // Si alguna falla, sigue con las que respondieron. No crashea el
  // flujo principal: ante cualquier error devuelve las TSAs sin tocar.
  async function refineWorkAreaByParentRmk(tsas, params) {
    if (!Array.isArray(tsas) || !tsas.length) return tsas;
    params = params || {};
    const firs = ['LECM', 'LECB', 'GCCC'];
    const bodyByNotam = new Map();
    const results = await Promise.all(firs.map(fir =>
      fetchNotamsByFIR(fir, { at: params.at, includeRefs: false })
        .catch((e) => {
          console.warn('[notamHub] refine: fallo fetch FIR ' + fir + ':', e.message);
          return null;
        })
    ));
    for (const arr of results) {
      if (!Array.isArray(arr)) continue;
      for (const n of arr) {
        if (n && n.notam_id && typeof n.body === 'string') {
          bodyByNotam.set(n.notam_id, n.body);
        }
      }
    }
    if (!bodyByNotam.size) {
      console.warn('[notamHub] refine: 0 NOTAMs disponibles, sin override');
      return tsas;
    }
    let overrideCount = 0;
    let parentsNotFound = 0;
    let workChecked = 0;
    for (const t of tsas) {
      if (t._isWorkArea !== true) continue; // solo intentamos bajar de work->transito
      workChecked++;
      const parents = String(t._parentNotam || '').split(',').filter(Boolean);
      let anyRmk = false;
      let anyFound = false;
      for (const pid of parents) {
        const body = bodyByNotam.get(pid);
        if (!body) continue;
        anyFound = true;
        const block = findTsaBlockInBody(body, t.name);
        if (blockHasRmk(block)) { anyRmk = true; break; }
      }
      if (!anyFound) parentsNotFound++;
      if (anyRmk) {
        t._isWorkArea = false;
        t._workAreaOverride = 'parent-rmk';
        overrideCount++;
      }
    }
    console.info('[notamHub] refine: ' + workChecked + ' TSAs eran work segun API · ' +
      overrideCount + ' bajadas a transito por RMK en NOTAM padre · ' +
      parentsNotFound + ' TSAs cuyo parent no estaba en FIRs cacheadas');
    return tsas;
  }

  // ── NOTAMs extranjeros (FIRs fuera de Espana) ──────────────────────
  // La feature estrella de NotamHub: traer NOTAMs de las FIRs adyacentes
  // (Francia, Portugal, Marruecos, Argelia, UK...) que afectan al espacio
  // aereo proximo. Endpoints /notams/foreign/* del backend.

  // Normaliza opts {at, limit, offset} a query-string. `at` puede ser
  // Date o string ISO. limit/offset enteros.
  function _foreignQS(opts) {
    opts = opts || {};
    const qs = {};
    if (opts.at != null && opts.at !== '') {
      qs.at = opts.at instanceof Date ? opts.at.toISOString() : opts.at;
    }
    if (opts.limit != null) qs.limit = opts.limit;
    if (opts.offset != null) qs.offset = opts.offset;
    return qs;
  }

  // GET /notams/foreign/firs — FIRs adyacentes con counts almacenados.
  function fetchForeignFirs() {
    return _fetchJSON('/notams/foreign/firs', null);
  }

  // GET /notams/foreign/fir/{icao} — NOTAMs de una FIR adyacente.
  // opts: { at:ISO|Date, limit:int, offset:int }.
  function fetchForeignByFIR(icao, opts) {
    return _fetchJSON('/notams/foreign/fir/' + encodeURIComponent(icao), _foreignQS(opts));
  }

  // GET /notams/foreign/bbox — NOTAMs cuya geometria solapa el bbox.
  // bbox puede ser string "min_lat,max_lat,min_lon,max_lon" o array
  // [minLat,maxLat,minLon,maxLon].
  function fetchForeignByBbox(bbox, opts) {
    const qs = _foreignQS(opts);
    qs.bbox = Array.isArray(bbox) ? bbox.join(',') : bbox;
    return _fetchJSON('/notams/foreign/bbox', qs);
  }

  // GET /notams/foreign/new — NOTAMs extranjeros vistos en las ultimas
  // `hours` horas. opts: { hours:int=24, limit:int, offset:int }.
  function fetchForeignNew(opts) {
    opts = opts || {};
    const qs = _foreignQS(opts);
    qs.hours = opts.hours != null ? opts.hours : 24;
    return _fetchJSON('/notams/foreign/new', qs);
  }

  // Carga TODOS los NOTAMs extranjeros recorriendo cada FIR soportada. Es
  // más completo que /foreign/bbox (que se deja los que están fuera del bbox
  // o no tienen geometría). NOTA: NO pasamos `limit` — el endpoint /fir
  // devuelve [] con limit alto (bug del backend); sin limit devuelve todos.
  const SUPPORTED_FIRS_FALLBACK = ['LPPC', 'LFBB', 'LFMM', 'DAAA', 'GMMM', 'LPPO', 'GVSC', 'GOOO'];
  async function fetchForeignAll(opts) {
    opts = opts || {};
    let firs = [], counts = {};
    try {
      const meta = await fetchForeignFirs();
      if (meta && Array.isArray(meta.supported)) firs = meta.supported.slice();
      if (meta && meta.counts) counts = meta.counts;
    } catch (_) {}
    if (!firs.length) firs = SUPPORTED_FIRS_FALLBACK.slice();
    const fetchOpts = {};
    if (opts.at != null && opts.at !== '') fetchOpts.at = opts.at;   // sin limit a propósito
    // El endpoint /foreign/fir FLUCTÚA: a veces devuelve 200 con lista vacía
    // (fallo transitorio de BBDD en el backend). Si un FIR viene vacío PERO el
    // catálogo /firs dice que tiene NOTAMs, reintentamos (hasta 3 intentos) en
    // vez de perderlos silenciosamente.
    const lists = await Promise.all(firs.map(async (f) => {
      let r = [];
      for (let i = 0; i < 3; i++) {
        try { r = await fetchForeignByFIR(f, fetchOpts); } catch (e) { r = null; }
        r = Array.isArray(r) ? r : [];
        if (r.length > 0 || !(counts[f] > 0)) return r;   // ok o catálogo vacío
        console.warn('[notamHub] foreign/fir ' + f + ' vacío (catálogo=' + counts[f] + '), reintento ' + (i + 1) + '/2');
        await new Promise((res) => setTimeout(res, 500 * (i + 1)));
      }
      return r;
    }));
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const n of (list || [])) {
        if (!n || !n.notam_number || seen.has(n.notam_number)) continue;
        seen.add(n.notam_number);
        out.push(n);
      }
    }
    console.info('[notamHub] fetchForeignAll: ' + firs.length + ' FIRs -> ' + out.length + ' NOTAMs (dedup)');
    return out;
  }

  // Radio efectivo (NM) de un polígono = distancia máx. del centroide a un
  // vértice. 1° lat = 60 NM. Sirve para detectar áreas grandes aunque el
  // geometry_type no sea 'circle'.
  function _polyEffRadiusNm(polygon) {
    if (!polygon || polygon.length < 3) return null;
    const c = polygonCentroid(polygon);
    if (!c) return null;
    const cosLat = Math.cos(c[0] * Math.PI / 180);
    let maxNm = 0;
    for (const p of polygon) {
      const dLatNm = (p[0] - c[0]) * 60;
      const dLonNm = (p[1] - c[1]) * 60 * cosLat;
      const nm = Math.sqrt(dLatNm * dLatNm + dLonNm * dLonNm);
      if (nm > maxNm) maxNm = nm;
    }
    return maxNm;
  }

  // Convierte fecha ISO/datetime a ISO string normalizado (o null).
  function _toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Las fechas del API vienen "naive" (sin zona, p.ej. "2026-05-25T07:00:00").
  // Las interpretamos como UTC (añadimos 'Z' si no traen indicador de zona).
  const FAR_PAST   = new Date(Date.UTC(2000, 0, 1));
  const FAR_FUTURE = new Date(Date.UTC(2099, 11, 31, 23, 59));
  // Radio (NM) a partir del cual un "círculo" se considera FIR-completo
  // (sentinela tipo 628/999 NM): no se dibuja, solo se lista.
  const FIRWIDE_NM = 150;
  function _toUTCDate(v, fallback) {
    if (!v) return fallback || null;
    let s = v;
    if (typeof s === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s + 'Z';
    const d = new Date(s);
    return isNaN(d.getTime()) ? (fallback || null) : d;
  }

  // Normaliza un ForeignNotamOut al shape de UI alineado con normalizeNotam.
  function normalizeForeignNotam(n) {
    if (!n) return null;
    return {
      notamId:      n.notam_number,
      country:      n.country,
      fir:          n.fir,
      qCode:        n.q_code,
      scope:        n.scope,
      traffic:      n.traffic,
      purpose:      n.purpose,
      fromDate:     _toDate(n.valid_from),
      toDate:       _toDate(n.valid_to),
      text:         n.body,
      raw:          n.body,
      airport:      n.airport_name,
      keyword:      n.keyword,
      _isPermanent: !!n.is_permanent,
      _isEstimate:  !!n.is_estimate,
      _foreign:     true,
    };
  }

  // ── Clasificación de NOTAMs extranjeros por Q-code ────────────────
  // El Q-code ICAO es Q + subject(2 letras) + condition(2 letras). El
  // "subject" (chars 2-3) determina la naturaleza. Mapeamos a categorías
  // con etiqueta y color para el mapa/leyenda/tabla. (El keyword del API
  // viene casi siempre "INTERNATIONAL", inservible para clasificar.)
  // Colores VIVOS y saturados para que resalten sobre la imagen de satélite.
  const FOREIGN_CATEGORY_META = {
    restricted: { label: 'Restringida / Prohibida', color: '#ff3b30' },
    danger:     { label: 'Zona de peligro (D)',     color: '#ff9500' },
    military:   { label: 'Militar / ejercicios',    color: '#ff2d55' },
    uas:        { label: 'UAS / drones',            color: '#ff5fd2' },
    activity:   { label: 'Actividad aérea',         color: '#ffd60a' },
    obstacle:   { label: 'Obstáculo',               color: '#ffae00' },
    navaid:     { label: 'Navegación / comms',      color: '#c77dff' },
    airspace:   { label: 'Espacio aéreo / ATS',     color: '#32d6e0' },
    other:      { label: 'Otros',                   color: '#d6deea' },
  };
  function getForeignCategoryMeta(key) {
    return FOREIGN_CATEGORY_META[key] || FOREIGN_CATEGORY_META.other;
  }
  function classifyForeignNotam(n) {
    const q = (n && n.q_code ? String(n.q_code).toUpperCase() : '');
    const subj = q.length >= 3 ? q.substring(1, 3) : '';   // chars 2-3
    const s0 = subj.charAt(0);
    const mil = !!(n && n.military);
    let cat;
    if (subj === 'RD') cat = 'danger';
    else if (subj === 'RM') cat = 'military';
    else if (s0 === 'R') cat = 'restricted';            // RA/RR/RP/RT/RO…
    else if (subj === 'WU') cat = 'uas';
    else if (subj === 'WM' || subj === 'WE' || subj === 'WD') cat = 'military';
    else if (s0 === 'W') cat = 'activity';              // WA/WB/WC/WG/WL/WP…
    else if (s0 === 'O') cat = 'obstacle';              // OB/OL
    else if (s0 === 'N' || s0 === 'C' || s0 === 'I' || s0 === 'G') cat = 'navaid';
    else if (s0 === 'A' || s0 === 'S' || s0 === 'P' || s0 === 'F' || s0 === 'L' || s0 === 'M') cat = 'airspace';
    else cat = 'other';
    // La bandera militar reclasifica las categorías genéricas a "militar".
    if (mil && (cat === 'restricted' || cat === 'activity' || cat === 'airspace' || cat === 'other')) cat = 'military';
    return cat;
  }

  // Convierte una lista de ForeignNotamOut en objetos internos. Incluye TODOS
  // (también los que no tienen geometría dibujable: se listan en la tabla con
  // _noGeometry, pero no se plotean). Los de radio > 75 NM se marcan
  // _largeCircle (ocultos del mapa por defecto).
  function convertForeignToInternal(apiList, atDate) {
    if (!Array.isArray(apiList)) {
      console.warn('[notamHub] convertForeign recibido NO-array:', apiList);
      return [];
    }
    const out = [];
    let withGeom = 0, noGeom = 0, large = 0;
    for (const n of apiList) {
      if (!n) continue;

      // Geometría dibujable: Polygon/MultiPolygon, o círculo (solo si
      // geometry_type==='circle' con centro+radio). 'none'/'point'/'line' NO
      // producen área dibujable -> se listan sin plotear.
      const radiusNm = Number.isFinite(n.radius_nm) ? n.radius_nm : null;
      // "FIR completo": círculo con radio gigante (sentinela ~628/999 NM) =
      // el NOTAM aplica a todo el FIR, sin área concreta. NO se dibuja (un
      // círculo enorme taparía el mapa); se lista como NOTAM informativo.
      let firWide = (n.geometry_type === 'circle') && radiusNm != null && radiusNm >= FIRWIDE_NM;
      let polygon = null;
      let isCircleGeom = (n.geometry_type === 'circle');
      let circleR = isCircleGeom ? radiusNm : null;
      if (!firWide) {
        if (n.geometry && (n.geometry.type === 'Polygon' || n.geometry.type === 'MultiPolygon')) {
          polygon = geojsonToLatLngArray(n.geometry);
        }
        if ((!polygon || polygon.length < 3) && n.geometry_type === 'circle' &&
            Number.isFinite(n.center_lat) && Number.isFinite(n.center_lon) && Number.isFinite(n.radius_nm)) {
          polygon = circleToPolygon(n.center_lat, n.center_lon, n.radius_nm);
        }
        // Fallback: el API a veces marca 'point'/'none' pero el CUERPO trae
        // coordenadas ("WI 5NM RADIUS OF …", "WI COORD …"). Las parseamos para
        // poder plotearlos (antes se perdían como "sin geometría").
        if (!polygon || polygon.length < 3) {
          const bodyGeo = parseSpanishNotamGeometry(n.body);
          if (bodyGeo && bodyGeo.kind === 'circle') {
            isCircleGeom = true; circleR = bodyGeo.radiusNm;
            if (bodyGeo.radiusNm >= FIRWIDE_NM) firWide = true;
            else polygon = circleToPolygon(bodyGeo.center[0], bodyGeo.center[1], bodyGeo.radiusNm);
          } else if (bodyGeo && bodyGeo.kind === 'poly') {
            polygon = bodyGeo.polygon;
          }
        }
      }
      const hasGeom = !!(polygon && polygon.length >= 3);

      const effR = hasGeom ? _polyEffRadiusNm(polygon) : null;
      // Círculo real grande (75–150 NM): oculto del mapa por defecto, pero
      // dibujable si el usuario lo activa.
      const isLargeCircle = isCircleGeom && circleR != null && circleR > 75 && circleR < FIRWIDE_NM;
      if (hasGeom) withGeom++; else noGeom++;
      if (hasGeom && isLargeCircle) large++;

      out.push({
        id: 'FN_' + (n.notam_number || ('idx' + out.length)),
        name: (n.notam_number || '') + ' ' + (n.country || ''),
        format: 'NOTAM',
        polygon: hasGeom ? polygon : null,
        centroid: hasGeom ? polygonCentroid(polygon) : null,
        vertical: {
          lowerFt: n.fl_lower != null ? n.fl_lower * 100 : 0,
          upperFt: n.fl_upper != null ? n.fl_upper * 100 : 99999,
          lowerLabel: n.lower_label || 'GND',
          upperLabel: n.upper_label || 'UNL',
        },
        schedules: [{
          startUTC: _toUTCDate(n.valid_from, FAR_PAST),
          endUTC:   _toUTCDate(n.valid_to, FAR_FUTURE),
          raw:      n.schedule_raw || (n.is_permanent ? 'PERM' : ''),
        }],
        // Vigencia REAL del NOTAM (no recortada a la búsqueda).
        validFrom: _toUTCDate(n.valid_from),
        validTo:   _toUTCDate(n.valid_to),
        remarks:   n.body,
        qCode:     n.q_code || '',
        category:  classifyForeignNotam(n),
        scope:     n.scope || '',
        traffic:   n.traffic || '',
        purpose:   n.purpose || '',
        fir:       n.fir || '',
        airport:   n.airport_name || '',
        geometryType: n.geometry_type || 'none',
        _isWorkArea: false,
        _isPermanent: !!n.is_permanent,
        _isEstimate: !!n.is_estimate,
        _military: !!n.military,
        _isCircle: isCircleGeom,
        _circleRadiusNm: circleR,
        _effRadiusNm: effR != null ? Math.round(effR) : null,
        _noGeometry: !hasGeom,
        _firWide: firWide,
        _largeCircle: hasGeom && isLargeCircle,
        _foreign: true,
        country: n.country,
      });
    }
    console.info('[notamHub] convertForeign: ' + apiList.length + ' entrada(s) -> ' +
      out.length + ' items (' + withGeom + ' con geometría · ' + large + ' grandes >75NM ocultas · ' +
      noGeom + ' sin geometría)');
    return out;
  }

  // ── NOTAMs nacionales (LECM/LECB/GCCC) ────────────────────────────
  // El API nacional (/notams/fir) NO trae geometría en campos, pero el
  // CUERPO suele incluir coordenadas ICAO. Las parseamos para poder
  // dibujarlos en el mapa.
  const NATIONAL_FIRS = ['LECM', 'LECB', 'GCCC'];

  // Extrae todas las coordenadas ICAO (DDMMSS[N/S] DDDMMSS[E/W], segundos
  // opcionales) de un texto. Devuelve [[lat,lon],…].
  function _icaoCoordsAll(text) {
    const re = /(\d{2})(\d{2})(\d{2})?(?:[.,]\d+)?\s*([NS])\s*(\d{3})(\d{2})(\d{2})?(?:[.,]\d+)?\s*([EW])/g;
    const pts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const lat = (+m[1]) + (+m[2]) / 60 + (m[3] ? +m[3] : 0) / 3600;
      const lon = (+m[5]) + (+m[6]) / 60 + (m[7] ? +m[7] : 0) / 3600;
      pts.push([m[4] === 'S' ? -lat : lat, m[8] === 'W' ? -lon : lon]);
    }
    return pts;
  }

  // Parsea la geometría del cuerpo de un NOTAM español:
  //  • polígono: ≥3 coordenadas ICAO ("WI COORD …").
  //  • círculo: 1 coordenada + radio ("400M RADIUS OF …", "5NM RADIUS …").
  //  • punto: 1 coordenada sin radio → círculo pequeño por defecto.
  function parseSpanishNotamGeometry(body) {
    if (!body) return null;
    const text = String(body).toUpperCase();
    const pts = _icaoCoordsAll(text);
    let radiusNm = null;
    const rm = text.match(/(\d+(?:[.,]\d+)?)\s*(M|KM|NM)\s+RADIUS/) ||
               text.match(/RADIUS\s+(?:OF\s+)?(\d+(?:[.,]\d+)?)\s*(M|KM|NM)/);
    if (rm) {
      const v = parseFloat(rm[1].replace(',', '.'));
      const u = rm[2];
      radiusNm = u === 'NM' ? v : (u === 'KM' ? v / 1.852 : v / 1852);
    }
    if (pts.length >= 3) {
      const poly = pts.slice();
      const a = poly[0], b = poly[poly.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) poly.push(a);
      return { kind: 'poly', polygon: poly };
    }
    if (pts.length >= 1 && radiusNm != null) {
      return { kind: 'circle', center: pts[0], radiusNm: radiusNm };
    }
    if (pts.length === 1) {
      return { kind: 'circle', center: pts[0], radiusNm: 0.5, point: true };
    }
    return null;
  }

  // Clasifica un NOTAM nacional por palabras clave del cuerpo/área.
  function classifyNationalNotam(n) {
    const b = ((n && n.body) || '') + ' ' + ((n && n.area) || '');
    const s = b.toUpperCase();
    if (/UNMANNED|\bUAS\b|RPAS|\bUAV\b|DRON/.test(s)) return 'uas';
    if (/FIRING|\bGUN\b|MISSILE|ROCKET|EXERCISE|EJERCICIO|MILITAR|MILITARY|\bTIRO\b|ARTILLER/.test(s)) return 'military';
    if (/PARACHUT|PARACAID|JUMP|\bSALTO/.test(s)) return 'activity';
    if (/AEROBATIC|ACROBA|AIR\s*DISPLAY|EXHIBIC|GLIDER|PLANEAD|BALLOON|GLOBO/.test(s)) return 'activity';
    if (/DANGER|PELIGRO|\bLED\b/.test(s)) return 'danger';
    if (/PROHIB|RESTRICT|RESTRING|\bLER\b|\bLEP\b/.test(s)) return 'restricted';
    if (/OBSTACLE|OBSTACUL|CRANE|\bGRUA\b|TOWER|TORRE/.test(s)) return 'obstacle';
    return 'other';
  }

  // Descarga los NOTAMs de los FIR nacionales (sin limit — el endpoint lo
  // ignora con valores altos). Dedup por notam_id.
  async function fetchNationalNotams(opts) {
    opts = opts || {};
    const at = opts.at != null && opts.at !== '' ? opts.at : undefined;
    // Reintento ante respuesta vacía transitoria (el backend a veces falla el
    // acceso a BBDD y devuelve []): LECM/LECB/GCCC siempre tienen NOTAMs, así
    // que un 0 casi seguro es transitorio -> reintentamos hasta 3 veces.
    const lists = await Promise.all(NATIONAL_FIRS.map(async (f) => {
      let r = [];
      for (let i = 0; i < 3; i++) {
        try { r = await fetchNotamsByFIR(f, { at: at }); } catch (e) { r = null; }
        r = Array.isArray(r) ? r : [];
        if (r.length > 0) return r;
        if (i < 2) { console.warn('[notamHub] notams/fir ' + f + ' vacío, reintento ' + (i + 1) + '/2'); await new Promise((res) => setTimeout(res, 500 * (i + 1))); }
      }
      return r;
    }));
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const n of (list || [])) {
        if (!n || !n.notam_id || seen.has(n.notam_id)) continue;
        seen.add(n.notam_id);
        out.push(n);
      }
    }
    console.info('[notamHub] fetchNationalNotams: ' + NATIONAL_FIRS.length + ' FIRs -> ' + out.length + ' NOTAMs');
    return out;
  }

  // Convierte NOTAMs nacionales a objetos internos dibujables. SOLO incluye
  // los que tienen geometría parseable en el cuerpo (los operacionales sin
  // coordenadas se omiten).
  function convertNationalNotamsToInternal(list, atDate) {
    if (!Array.isArray(list)) return [];
    const out = [];
    let withGeom = 0, skipped = 0;
    for (const n of list) {
      if (!n) continue;
      const geo = parseSpanishNotamGeometry(n.body);
      if (!geo) { skipped++; continue; }
      let polygon = null, isCircle = false, radiusNm = null, firWide = false;
      if (geo.kind === 'circle') {
        isCircle = true; radiusNm = geo.radiusNm;
        if (radiusNm >= FIRWIDE_NM) firWide = true;                 // FIR completo: no se dibuja
        else polygon = circleToPolygon(geo.center[0], geo.center[1], geo.radiusNm);
      } else if (geo.kind === 'poly') {
        polygon = geo.polygon;
      }
      const hasGeom = !!(polygon && polygon.length >= 3);
      if (!hasGeom && !firWide) { skipped++; continue; }            // sin geometría útil -> omitir
      if (hasGeom) withGeom++;
      const validFrom = _toUTCDate(n.valid_from), validTo = _toUTCDate(n.valid_to);
      out.push({
        id: 'NN_' + (n.notam_id || ('idx' + out.length)),
        name: (n.notam_id || '') + (n.area ? ' · ' + n.area : (n.aerodrome ? ' · ' + n.aerodrome : '')),
        format: 'NOTAM',
        polygon: hasGeom ? polygon : null,
        centroid: hasGeom ? polygonCentroid(polygon) : null,
        vertical: { lowerFt: 0, upperFt: 99999, lowerLabel: 'GND', upperLabel: 'UNL' },
        schedules: [{ startUTC: validFrom || FAR_PAST, endUTC: validTo || FAR_FUTURE, raw: '' }],
        validFrom: validFrom, validTo: validTo,
        remarks: n.body,
        qCode: '',
        category: classifyNationalNotam(n),
        fir: n.fir || 'ES',
        aerodrome: n.aerodrome || '',
        section: n.section || '',
        _isWorkArea: false,
        _isPermanent: !!n.is_permanent,
        _isEstimate: !!n.is_estimate,
        _isCircle: isCircle,
        _circleRadiusNm: radiusNm != null ? Math.round(radiusNm * 10) / 10 : null,
        _noGeometry: !hasGeom,
        _firWide: firWide,
        _largeCircle: hasGeom && isCircle && radiusNm != null && radiusNm > 75 && radiusNm < FIRWIDE_NM,
        _foreign: false,
        _national: true,
        country: 'ES',
      });
    }
    console.info('[notamHub] convertNational: ' + (list.length) + ' -> ' + withGeom + ' con geometría · ' + skipped + ' sin coords (omitidos)');
    return out;
  }

  return {
    BASE,
    ping,
    fetchActiveTSAs,
    fetchNotamsByFIR,
    fetchNotamsByAerodrome,
    fetchBulletins,
    convertTSAsToInternal,
    refineWorkAreaByParentRmk,
    fetchAllNotamsFor, normalizeNotam,
    fetchForeignFirs,
    fetchForeignByFIR,
    fetchForeignByBbox,
    fetchForeignNew,
    fetchForeignAll,
    fetchNationalNotams,
    convertNationalNotamsToInternal,
    parseSpanishNotamGeometry,
    classifyNationalNotam,
    normalizeForeignNotam,
    convertForeignToInternal,
    classifyForeignNotam,
    getForeignCategoryMeta,
    FOREIGN_CATEGORY_META,
    getStoredToken, setStoredToken, clearStoredToken,
    getStoredAdminToken, setStoredAdminToken,
  };
})();
