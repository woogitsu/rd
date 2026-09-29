import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { checkReadiness } from './health.js';
import { checkJobsHealth, tokensMatch } from './pg/jobs-health.js';
import { describeError, log, sanitizePath } from './log.js';
import { UPLOAD_PATH } from './documents.js';
import { createRateLimiter } from './rate-limit.js';

const MAX_BODY_BYTES = 1024 * 1024;
// Jedyne źródło listy paneli statycznych (issue #119): smoke test i inne
// narzędzia mają importować ten eksport zamiast wpisywać listę na sztywno.
export const STATIC_PREFIXES = new Set(['import', 'panel', 'ledger', 'print', 'events', 'documents', 'site', 'meetings', 'admin', 'families', 'login', 'email', 'reconciliation', 'year-close', 'audit', 'news']);
// Jedyny prefiks przeznaczony do indeksowania przez wyszukiwarki (#116).
// Wszystkie pozostałe prefiksy z STATIC_PREFIXES i cały /api/ poza /api/public/
// wymagają logowania do danych, więc dostają `X-Robots-Tag: noindex, nofollow`.
const PUBLIC_STATIC_PREFIX = 'site';
const ROBOTS_NOINDEX = 'noindex, nofollow';
// Blokuje wszystkie prefiksy paneli i całe /api/ poza /api/public/ — to samo
// rozróżnienie co X-Robots-Tag powyżej, na wypadek czytników, które nie patrzą
// na nagłówki odpowiedzi (#116).
const ROBOTS_TXT_BODY = `User-agent: *\n${['import', 'panel', 'ledger', 'print', 'events', 'documents', 'meetings', 'admin', 'families', 'login', 'email', 'reconciliation', 'year-close', 'audit', 'news']
  .map((prefix) => `Disallow: /${prefix}/`).join('\n')}\nDisallow: /api/\nAllow: /api/public/\nAllow: /${PUBLIC_STATIC_PREFIX}/\n`;
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

// #114 (SR-12): przed tą zmianą tylko pliki statyczne miały nosniff/frame-ancestors/
// referrer-policy — odpowiedzi API (JSON_HEADERS, src/pg/http.js), przekierowania 308,
// /health/ready i błędy 413/500 miały co najwyżej Cache-Control i nosniff. HSTS nie było
// nigdzie. `baselineSecurityHeaders` daje te same podstawowe nagłówki KAŻDEJ odpowiedzi
// serwera Node; HSTS tylko gdy PUBLIC_BASE_URL zaczyna się od `https://` (na stagingu za
// TLS proxy Railway; lokalnie/w testach zwykle `http://` albo brak — bez HSTS). Bez
// `preload` — to decyzja właściciela domeny (docs/AUTH.md).
export function baselineSecurityHeaders(publicBaseUrl) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  if (/^https:\/\//i.test(String(publicBaseUrl ?? '').trim())) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

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

async function serveStatic(request, response, url, distRoot, baseline) {
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (STATIC_PREFIXES.has(first) && url.pathname === `/${first}`) {
    response.writeHead(308, { ...baseline, Location: `/${first}/`, 'Cache-Control': 'no-store' });
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
    ...baseline,
    ...STATIC_SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600',
    ...(first === PUBLIC_STATIC_PREFIX ? {} : { 'X-Robots-Tag': ROBOTS_NOINDEX }),
  });
  response.statusCode = 200;
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
  return true;
}

async function writeFetchResponse(nodeResponse, webResponse, apiRequest, baseline, indexable, streamedRequestBody = false) {
  // Bazowe nagłówki najpierw: trasa (webResponse) może świadomie nadpisać
  // którykolwiek z nich (dziś żadna tego nie robi).
  for (const [name, value] of Object.entries(baseline)) nodeResponse.setHeader(name, value);
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() !== 'set-cookie') nodeResponse.setHeader(name, value);
  }
  const cookies = webResponse.headers.getSetCookie?.() ?? [];
  if (cookies.length) nodeResponse.setHeader('Set-Cookie', cookies);
  if (apiRequest) nodeResponse.setHeader('Cache-Control', 'no-store');
  // Cała reszta API wymaga zalogowania — `/api/public/` jest jedynym wyjątkiem
  // przeznaczonym do indeksowania (#116).
  if (apiRequest && !indexable) nodeResponse.setHeader('X-Robots-Tag', ROBOTS_NOINDEX);
  if (streamedRequestBody) {
    // #185: trasa mogła zwrócić odpowiedź (np. 401/403/400) bez przeczytania
    // strumienia ciała (celowo — patrz wyżej). Node nie wznowi obsługi
    // kolejnego żądania na tym samym gnieździe keep-alive, dopóki ciało nie
    // zostanie odebrane albo połączenie zamknięte — więc zamykamy je jawnie
    // zamiast czekać, aż klient sam doślizgnie resztę bajtów.
    nodeResponse.setHeader('Connection', 'close');
  }
  nodeResponse.statusCode = webResponse.status;
  // `finish`, nie zaraz po `end()`: destroy przed pełnym zapisaniem odpowiedzi
  // do gniazda mógłby uciąć jej ostatnie bajty u klienta.
  if (streamedRequestBody) nodeResponse.once('finish', () => nodeResponse.socket?.destroy());
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

async function serveReadiness(response, env, readiness, baseline) {
  const { ready, body } = await readiness(env);
  response.writeHead(ready ? 200 : 503, {
    ...baseline,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

// Heartbeat zadań (#149): chroniony tokenem (Authorization: Bearer <token>),
// osobny od /health/ready — dla monitora zewnętrznego, nie dla Railway.
// Brak konfiguracji tokenu = punkt wyłączony (401), żeby nie ujawnić stanu
// zadań bez jawnej decyzji operacyjnej.
async function serveJobsHealth(request, response, env, jobsHealth) {
  const expected = env.HEALTH_JOBS_TOKEN;
  const header = request.headers.authorization;
  const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!expected || !tokensMatch(provided, expected)) {
    response.writeHead(401, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'unauthorized' }));
    return;
  }
  const { ok, failedThresholds } = await jobsHealth(env);
  response.writeHead(ok ? 200 : 503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify({ status: ok ? 'ok' : 'threshold_exceeded', failedThresholds }));
}

// bodyLimit(url, method) -> bajty; pozwala podnieść limit wyłącznie dla
// wskazanych tras (np. POST /api/documents). Domyślnie 1 MiB dla wszystkich.
export function createNodeHandler({
  distRoot, env = {}, fetchHandler, publicBaseUrl, bodyLimit, logger = log, metrics = null, readiness = checkReadiness,
  jobsHealth = checkJobsHealth, trustProxy = false, rateLimiter = createRateLimiter({ env: globalThis.process?.env }),
} = {}) {
  if (!distRoot) throw new Error('distRoot is required');
  if (typeof fetchHandler !== 'function') throw new Error('fetchHandler is required');
  const limitFor = (url, method) => {
    const value = typeof bodyLimit === 'function' ? Number(bodyLimit(url, method)) : MAX_BODY_BYTES;
    return Number.isInteger(value) && value > 0 ? value : MAX_BODY_BYTES;
  };
  const baseline = baselineSecurityHeaders(publicBaseUrl);
  return async (request, response) => {
    const started = process.hrtime.bigint();
    response.once('close', () => logRequest(logger, metrics, request, response, started));
    try {
      const url = publicUrl(request, publicBaseUrl);
      if (url.pathname === '/health/ready' && ['GET', 'HEAD'].includes(request.method)) {
        await serveReadiness(response, env, readiness, baseline);
        return;
      }
      if (url.pathname === '/health/jobs' && ['GET', 'HEAD'].includes(request.method)) {
        await serveJobsHealth(request, response, env, jobsHealth);
        return;
      }
      // Strona startowa: osoby bez sesji trafiają na logowanie; strona publiczna jest pod /site/.
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(308, { ...baseline, Location: '/login/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (url.pathname === '/robots.txt' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, {
          ...baseline,
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        response.end(request.method === 'HEAD' ? undefined : ROBOTS_TXT_BODY);
        return;
      }
      if (await serveStatic(request, response, url, distRoot, baseline)) return;
      const method = request.method || 'GET';
      // #126 (SR-13): ogólny limiter PRZED odczytem ciała i zapytaniem do bazy.
      const slot = rateLimiter.acquire({
        pathname: url.pathname, cookieHeader: request.headers.cookie, address: clientAddress(request, trustProxy),
      });
      if (!slot.ok) {
        response.writeHead(429, {
          ...baseline,
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': String(slot.retryAfter),
        });
        response.end(JSON.stringify({ error: 'rate_limited' }));
        return;
      }
      response.once('close', slot.release);
      // #185: POST /api/documents buforowało całe ciało (do 25 MB) w pamięci
      // PRZED sprawdzeniem sesji/roli w documents.js — anonimowe żądanie z
      // dużym Content-Length kosztowało tyle samo pamięci co upload
      // skarbnika. Dla tej jednej trasy ciało trafia do Request jako
      // strumień (bez buforowania tutaj); dopiero readLimited (documents.js,
      // wywoływane PO auth/autoryzacji/walidacji kind) czyta go pod limitem.
      // Bez ważnej sesji handler kończy się wcześniej i strumień nigdy nie
      // jest czytany — połączenie jest wtedy zamykane niżej (writeFetchResponse),
      // żeby nieprzeczytane bajty nie zawisły na współdzielonym gnieździe keep-alive.
      const streamBody = method === 'POST' && url.pathname === UPLOAD_PATH;
      let body;
      if (['GET', 'HEAD'].includes(method)) {
        body = undefined;
      } else if (streamBody) {
        const declared = Number(request.headers['content-length']);
        const limit = limitFor(url, method);
        if (Number.isFinite(declared) && declared > limit) throw new RangeError('request_too_large');
        body = Readable.toWeb(request);
      } else {
        body = await requestBody(request, limitFor(url, method));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === CLIENT_IP_HEADER) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set(CLIENT_IP_HEADER, clientAddress(request, trustProxy));
      const webRequest = new Request(url, { method, headers, body, ...(streamBody ? { duplex: 'half' } : {}) });
      const webResponse = await fetchHandler(webRequest, env);
      const indexable = url.pathname.startsWith('/api/public/');
      await writeFetchResponse(response, webResponse, url.pathname.startsWith('/api/'), baseline, indexable, streamBody);
    } catch (error) {
      const tooLarge = error instanceof RangeError && error.message === 'request_too_large';
      if (!tooLarge) logger.error('http_handler_error', describeError(error));
      response.writeHead(tooLarge ? 413 : 500, {
        ...baseline,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ error: tooLarge ? 'request_too_large' : 'service_unavailable' }));
    }
  };
}
