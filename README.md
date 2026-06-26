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
functions/api/
  notamhub/[[path]].js  Proxy → https://notamhub.duckdns.org (inyecta token)
  awc/[[path]].js       Proxy → https://aviationweather.gov (METAR/TAF/SIGMET)
```

Todo cuelga del namespace global `window.NotamHub`. Cada módulo es un IIFE que
registra un sub-objeto; no hay paso de *build*.

## Ejecución local

Necesita servirse por HTTP (no `file://`) para evitar problemas de CORS:

```sh
python serve.py        # http://127.0.0.1:8000
# o, en Windows:
start.bat
# o:
npx http-server -p 8000
```

En local, el cliente llama directamente a las APIs externas (puede fallar por
CORS según el navegador). En producción usa los *proxies* same-origin `/api/*`.

## Despliegue (Cloudflare Pages)

1. Conecta el repositorio a Cloudflare Pages (framework preset: *None*; sin
   comando de build; directorio de salida: la raíz).
2. Las funciones de `functions/api/*` se despliegan automáticamente.
3. Configura la variable de entorno (Settings → Environment Variables,
   marcando **Encrypt**):
   - `NOTAMHUB_USER_TOKEN` — token de la API NotamHub. Si no se define, el proxy
     usa un valor por defecto incluido en el código (suficiente para arrancar,
     recomendable rotarlo y moverlo a la variable de entorno).

## Fuentes de datos y atribución

- NOTAMs / TSAs: **NotamHub API** (`notamhub.duckdns.org`, datos ICARO/ENAIRE).
- METAR / TAF / SIGMET: **NOAA Aviation Weather Center**.
- Nubosidad: **RainViewer**.
- Satélite (CTH / LI AFA / RGB Convección): **EUMETSAT**.
- Cartografía base: **Natural Earth** (dominio público).
- Mapas: **Leaflet**.

## Créditos

Derivado de **TSAgestor**. Reescrito para uso civil (mapa + meteo + NOTAMs).
