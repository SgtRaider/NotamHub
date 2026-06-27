# NotamHub

Visor **civil** de **NOTAMs**, **TSAs** y **meteorología aeronáutica** sobre un
mapa offline. PWA estática (HTML + CSS + JavaScript vanilla, sin build) con un
backend ligero de *proxies* en Cloudflare Pages Functions.

Es una derivación civil de [TSAgestor](https://github.com/SgtRaider/TSAgestor):
conserva únicamente el **mapa**, la **meteorología** y la **carga/visualización
de NOTAMs y TSAs**, eliminando la planificación de vuelo, el seguimiento en vivo,
la flota y la exportación PDF.

> ⚠️ **Uso informativo, no operacional.** Los datos provienen de fuentes
> públicas de terceros y pueden contener errores o retrasos. NotamHub **no
> sustituye al briefing oficial** ni a las publicaciones aeronáuticas (AIP,
> NOTAM-PIB). La decisión final del vuelo es siempre del piloto.

## Funcionalidades

- **NOTAMs / TSAs** desde la [API NotamHub](https://notamhub.duckdns.org/docs)
  (ICARO / ENAIRE):
  - TSAs activas a una hora o rango de fechas.
  - NOTAMs por aeródromo y por FIR.
  - **NOTAMs de FIRs colindantes (fuera de España)** por área visible del mapa
    (`/notams/foreign/bbox`).
- **Mapa offline** (Leaflet + cartografía Natural Earth integrada, sin tiles
  online) con los polígonos de TSAs/NOTAMs coloreados por tipo/altitud y leyenda
  de TSAs activas.
- **Meteorología**: METAR/TAF decodificados al español, SIGMETs (AWC), nubosidad
  RainViewer IR, Cloud Top Height / tormentas (MTG LI AFA) / RGB Convección
  (EUMETSAT) como capas activables.
- **Briefing del aeródromo**: tablero *Weather Hold* (clasifica METAR/TAF frente
  a tus mínimos en verde / amarillo / rojo) + lista de NOTAMs operativos.
- **PWA** instalable, funciona offline tras la primera carga.

## Arquitectura

```
index.html              Shell de la página + carga de módulos
css/styles.css          Estilos (tema oscuro teal/ámbar)
js/
  shell.js              Armazón de UI "B1" (stepper + panel + mapa + cajón)
  app.js                Orquestador (estado, carga, filtros, render)
  mapView.js            Mapa Leaflet (base offline, TSAs/NOTAMs, capas meteo)
  meteoApi.js           Cliente METAR/TAF/SIGMET/RainViewer/EUMETSAT
  metarDecode.js        Decodificador METAR/TAF a español
  notamHub.js           Cliente de la API NotamHub (TSAs + NOTAMs + foreign)
  notamView.js          Pestaña Briefing (Weather Hold + lista de NOTAMs)
  filters.js            Filtro de TSAs por fecha/hora/tipo
  scheduleFmt.js        Formateo de ventanas horarias
  settings.js           Preferencias (opacidades + mínimos meteo)
  i18n.js               Internacionalización (es/en)
  geom.js               Utilidades geométricas
  offlineGeo.js         Cartografía Natural Earth embebida
_worker.js              (opcional) Worker proxy /api/* — no usado en modo directo
wrangler.toml           (opcional) Config de Worker + Static Assets
```

> **Modo directo (actual):** la web llama a `notamhub.duckdns.org` directamente
> para NOTAMs/TSAs (requiere CORS habilitado en esa API, ver más abajo). La
> meteo de AWC (`aviationweather.gov`, que no es nuestra y no tiene CORS) usa un
> proxy CORS público como *fallback*. RainViewer/EUMETSAT van directas.

Todo cuelga del namespace global `window.NotamHub`. Cada módulo es un IIFE que
registra un sub-objeto; no hay paso de *build*.

## Ejecución local

Sírvelo por HTTP (no `file://`):

```sh
python serve.py        # http://127.0.0.1:8000
start.bat              # Windows
# o:  npx http-server -p 8000
```

En modo directo la web llama a duckdns/AWC sin proxy propio, así que basta con
servir los estáticos. La carga de NOTAMs requiere que tu API duckdns tenga CORS
habilitado para el origen desde el que sirves (p. ej. `http://127.0.0.1:8000`).

## Habilitar CORS en la API (duckdns) — IMPRESCINDIBLE

Como la web llama a `notamhub.duckdns.org` directamente, tu FastAPI debe permitir
el origen de la web y las cabeceras de token:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://notamhub.asraelus.workers.dev",
        "http://127.0.0.1:8000",   # desarrollo local
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["x-user-token", "x-admin-token", "Content-Type"],
)
```

(`allow_origins=["*"]` también vale; con tokens en cabecera y sin cookies es
aceptable.) Sin esto, el navegador bloqueará las llamadas y verás errores CORS/401.

## Despliegue (web estática)

La web es 100% estática: sirve con cualquier hosting (Cloudflare Workers Static
Assets, Pages, etc.). Tu deploy actual en `workers.dev` ya vale — vuelve a
publicar los ficheros tras `git pull`.

El token de usuario va en el cliente (`DEFAULT_USER_TOKEN` en `notamHub.js`, ya
público). Para usar el scope **admin** sin exponerlo en el código, define el
token en el navegador:

```js
localStorage.setItem('notamhub_admin_token', '<tu-token-admin>')
```

> Alternativa: si prefieres NO exponer el token ni depender de CORS en duckdns,
> el repo incluye `_worker.js` (proxy `/api/*`). Para usarlo, cambia las bases de
> `notamHub.js`/`meteoApi.js`/`mapView.js` de las URLs directas a `/api/...` y
> despliega con `npx wrangler deploy`.

## Fuentes de datos y atribución

- NOTAMs / TSAs: **NotamHub API** (`notamhub.duckdns.org`, datos ICARO/ENAIRE).
- METAR / TAF / SIGMET: **NOAA Aviation Weather Center**.
- Nubosidad: **RainViewer**.
- Satélite (CTH / LI AFA / RGB Convección): **EUMETSAT**.
- Cartografía base: **Natural Earth** (dominio público).
- Mapas: **Leaflet**.

## Créditos

Derivado de **TSAgestor**. Reescrito para uso civil (mapa + meteo + NOTAMs).
