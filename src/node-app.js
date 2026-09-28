import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { checkReadiness } from './health.js';
import { describeError, log, sanitizePath } from './log.js';

const MAX_BODY_BYTES = 1024 * 1024;
// Jedyne źródło listy paneli statycznych (issue #119): smoke test i inne
// narzędzia mają importować ten eksport zamiast wpisywać listę na sztywno.
export const STATIC_PREFIXES = new Set(['import', 'panel', 'ledger', 'print', 'events', 'documents', 'site', 'meetings', 'admin', 'families', 'login']);
// Nagłówek z adresem klienta dla limitów logowania (src/pg/login.js). Zawsze
// nadpisywany przez serwer — wartość wysłana przez klienta jest ignorowana.
export const CLIENT_IP_HEADER = 'x-rd-client-ip';
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

async function requestBody(request, limit = MAX_BODY_BYTES) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(length) && length > limit) throw new RangeError('request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publicUrl(request, publicBaseUrl) {
  // Tylko ścieżka i zapytanie z linii żądania. Forma absolutna
  // („POST http://inny.host/api/…”) albo „//inny.host/…” nie może podmienić
  // originu ustalonego przez PUBLIC_BASE_URL (od niego zależy kontrola Origin).
  const target = new URL(request.url || '/', 'http://request.invalid');
  const url = publicBaseUrl ? new URL(publicBaseUrl) : new URL(`http://${request.headers.host || '127.0.0.1'}`);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = '';
  return url;
}

// Adres klienta. Za zaufanym proxy (Railway: TRUST_PROXY=1) — ostatni wpis
// X-Forwarded-For, czyli adres widziany przez proxy; wcześniejsze wpisy może
// podrobić klient. Bez proxy — adres gniazda.
export function clientAddress(request, trustProxy = false) {
  if (trustProxy) {
    const header = request.headers?.['x-forwarded-for'];
    const parts = String(Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return String(request.socket?.remoteAddress ?? '').slice(0, 64);
}

function staticTarget(pathname, distRoot) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.endsWith('.map')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (!STATIC_PREFIXES.has(parts[0])) return null;
  if (parts.some((part) => part.startsWith('.'))) return null;
  const root = resolve(distRoot, parts[0]);
  const relative = parts.length === 1 ? 'index.html' : parts.slice(1).join('/');
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  return path;
}

function writeHeaders(response, headers) {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

async function serveStatic(request, response, url, distRoot) {
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (STATIC_PREFIXES.has(first) && url.pathname === `/${first}`) {
    response.writeHead(308, { Location: `/${first}/`, 'Cache-Control': 'no-store' });
    response.end();
    return true;
  }
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const path = staticTarget(url.pathname, distRoot);
  if (!path) return false;
  let info;
  try { info = await stat(path); } catch { return false; }
  if (!info.isFile()) return false;
  const extension = extname(path).toLowerCase();
  const type = MIME_TYPES.get(extension);
  if (!type) return false;
  writeHeaders(response, {
    ...STATIC_SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  response.statusCode = 200;
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
  return true;
}

async function writeFetchResponse(nodeResponse, webResponse, apiRequest) {
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() !== 'set-cookie') nodeResponse.setHeader(name, value);
  }
  const cookies = webResponse.headers.getSetCookie?.() ?? [];
  if (cookies.length) nodeResponse.setHeader('Set-Cookie', cookies);
  if (apiRequest) nodeResponse.setHeader('Cache-Control', 'no-store');
  nodeResponse.statusCode = webResponse.status;
  if (!webResponse.body) return nodeResponse.end();
  const data = Buffer.from(await webResponse.arrayBuffer());
  nodeResponse.end(data);
}

const LOGGED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Log żądania: metoda, ścieżka bez query stringu z identyfikatorami zastąpionymi
// `:id`, status i czas. Bez nagłówków, cookies i ciał. Sondy /health na poziomie debug.
function logRequest(logger, metrics, request, response, started) {
  // 0 = klient przerwał połączenie przed końcem odpowiedzi.
  const status = response.writableFinished ? response.statusCode : 0;
  const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  metrics?.record(status, durationMs);
  const path = sanitizePath(request.url);
  const method = LOGGED_METHODS.has(request.method) ? request.method : 'OTHER';
  const fields = { method, path, status, duration_ms: durationMs };
  if (path === '/health' || path === '/health/ready') logger.debug('http_request', fields);
  else if (status >= 500) logger.error('http_request', fields);
  else if (status === 0) logger.warn('http_request', fields);
  else logger.info('http_request', fields);
}

async function serveReadiness(response, env, readiness) {
  const { ready, body } = await readiness(env);
  response.writeHead(ready ? 200 : 503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

// bodyLimit(url, method) -> bajty; pozwala podnieść limit wyłącznie dla
// wskazanych tras (np. POST /api/documents). Domyślnie 1 MiB dla wszystkich.
export function createNodeHandler({
  distRoot, env = {}, fetchHandler, publicBaseUrl, bodyLimit, logger = log, metrics = null, readiness = checkReadiness,
  trustProxy = false,
} = {}) {
  if (!distRoot) throw new Error('distRoot is required');
  if (typeof fetchHandler !== 'function') throw new Error('fetchHandler is required');
  const limitFor = (url, method) => {
    const value = typeof bodyLimit === 'function' ? Number(bodyLimit(url, method)) : MAX_BODY_BYTES;
    return Number.isInteger(value) && value > 0 ? value : MAX_BODY_BYTES;
  };
  return async (request, response) => {
    const started = process.hrtime.bigint();
    response.once('close', () => logRequest(logger, metrics, request, response, started));
    try {
      const url = publicUrl(request, publicBaseUrl);
      if (url.pathname === '/health/ready' && ['GET', 'HEAD'].includes(request.method)) {
        await serveReadiness(response, env, readiness);
        return;
      }
      // Strona startowa: osoby bez sesji trafiają na logowanie; strona publiczna jest pod /site/.
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(308, { Location: '/login/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (await serveStatic(request, response, url, distRoot)) return;
      const method = request.method || 'GET';
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await requestBody(request, limitFor(url, method));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === CLIENT_IP_HEADER) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set(CLIENT_IP_HEADER, clientAddress(request, trustProxy));
      const webRequest = new Request(url, { method, headers, body });
      const webResponse = await fetchHandler(webRequest, env);
      await writeFetchResponse(response, webResponse, url.pathname.startsWith('/api/'));
    } catch (error) {
      const tooLarge = error instanceof RangeError && error.message === 'request_too_large';
      if (!tooLarge) logger.error('http_handler_error', describeError(error));
      response.writeHead(tooLarge ? 413 : 500, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify({ error: tooLarge ? 'request_too_large' : 'service_unavailable' }));
    }
  };
}
