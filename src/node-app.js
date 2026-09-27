import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_PREFIXES = new Set(['import', 'panel', 'ledger']);
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

async function requestBody(request) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new RangeError('request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publicUrl(request, publicBaseUrl) {
  if (publicBaseUrl) return new URL(request.url, publicBaseUrl);
  const host = request.headers.host || '127.0.0.1';
  return new URL(request.url, `http://${host}`);
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

export function createNodeHandler({ distRoot, env = {}, fetchHandler, publicBaseUrl } = {}) {
  if (!distRoot) throw new Error('distRoot is required');
  if (typeof fetchHandler !== 'function') throw new Error('fetchHandler is required');
  return async (request, response) => {
    try {
      const url = publicUrl(request, publicBaseUrl);
      if (await serveStatic(request, response, url, distRoot)) return;
      const method = request.method || 'GET';
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await requestBody(request);
      const webRequest = new Request(url, { method, headers: request.headers, body });
      const webResponse = await fetchHandler(webRequest, env);
      await writeFetchResponse(response, webResponse, url.pathname.startsWith('/api/'));
    } catch (error) {
      const tooLarge = error instanceof RangeError && error.message === 'request_too_large';
      response.writeHead(tooLarge ? 413 : 500, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify({ error: tooLarge ? 'request_too_large' : 'service_unavailable' }));
    }
  };
}
