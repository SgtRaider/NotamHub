// _worker.js — Entrada única de NotamHub para Cloudflare.
//
// Sirve los ficheros estáticos (env.ASSETS) y hace de PROXY same-origin de:
//   /api/notamhub/*  →  https://notamhub.duckdns.org/*   (inyecta x-user-token)
//   /api/awc/*       →  https://aviationweather.gov/api/data/*
//
// Necesario porque ni notamhub.duckdns.org ni aviationweather.gov envían
// cabeceras CORS, así que el navegador no puede llamarlos directamente.
//
// Funciona tanto en:
//   • Cloudflare Workers (Static Assets): wrangler.toml con main="_worker.js"
//     y [assets] binding="ASSETS".
//   • Cloudflare Pages (advanced mode): _worker.js en la raíz del output;
//     env.ASSETS lo provee Pages automáticamente.

const NOTAMHUB_UPSTREAM = 'https://notamhub.duckdns.org';
const AWC_UPSTREAM = 'https://aviationweather.gov/api/data';

// Token de la API NotamHub (scope user). Si la env var NOTAMHUB_USER_TOKEN
// está configurada en Cloudflare, prevalece. El cliente también puede pasar
// el suyo vía cabecera x-user-token.
const DEFAULT_NOTAMHUB_TOKEN = 'FPIy1bgWG5gGRviMKSxeLInxZvjD1KYhILgof0WVgfg';

// Token de admin (scope admin) para endpoints/datos protegidos (x-admin-token)
// de la API ICARO. Por seguridad NO se incluye un valor por defecto en el
// código: se toma de la env var/secreto NOTAMHUB_ADMIN_TOKEN (o de la cabecera
// x-admin-token que envíe el cliente). Configúralo con:
//   npx wrangler secret put NOTAMHUB_ADMIN_TOKEN

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-user-token, x-admin-token',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/notamhub/') || p === '/api/notamhub') {
        return await proxyNotamhub(request, env, url);
      }
      if (p.startsWith('/api/awc/') || p === '/api/awc') {
        return await proxyAwc(request, url);
      }
    } catch (err) {
      return jsonResp({ error: 'Worker crashed', detail: String(err && err.stack || err) }, 500);
    }
    // Estáticos.
    if (env && env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function proxyNotamhub(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }
  const path = url.pathname.replace(/^\/api\/notamhub\/?/, '');
  const target = `${NOTAMHUB_UPSTREAM}/${path}${url.search}`;

  const clientToken = request.headers.get('x-user-token');
  const token = clientToken || (env && env.NOTAMHUB_USER_TOKEN) || DEFAULT_NOTAMHUB_TOKEN;

  const clientAdmin = request.headers.get('x-admin-token');
  const adminToken = clientAdmin || (env && env.NOTAMHUB_ADMIN_TOKEN) || '';

  const headers = { 'User-Agent': 'NotamHub-Worker/1.0', 'Accept': 'application/json' };
  if (token) headers['x-user-token'] = token;
  if (adminToken) headers['x-admin-token'] = adminToken;

  const init = { method: request.method, headers };
  if (request.method === 'POST') {
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    init.body = await request.text();
  }

  let upstream;
  try { upstream = await fetch(target, init); }
  catch (e) { return jsonResp({ error: 'Upstream fetch failed', detail: String(e) }, 502); }

  const respHeaders = new Headers(CORS);
  const upCT = upstream.headers.get('Content-Type');
  if (upCT) respHeaders.set('Content-Type', upCT);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

async function proxyAwc(request, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: CORS });
  const path = url.pathname.replace(/^\/api\/awc\/?/, '');
  const target = `${AWC_UPSTREAM}/${path}${url.search}`;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': 'NotamHub-Worker/1.0', 'Accept': 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (e) { return jsonResp({ error: 'Upstream fetch failed', detail: String(e) }, 502); }

  const respHeaders = new Headers(CORS);
  const upCT = upstream.headers.get('Content-Type');
  if (upCT) respHeaders.set('Content-Type', upCT);
  respHeaders.set('Cache-Control', 'public, max-age=300');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
