// Prywatny magazyn obiektów dla dokumentów (issue #39).
//
// Kontrakt (wspólny dla pamięci i S3):
//   storage.putObject(key, bytes, contentType) -> Promise<void>
//   storage.getObject(key)                     -> Promise<{ body: Uint8Array, contentType, size }>
//   storage.headObject(key)                    -> Promise<boolean>  // czy obiekt istnieje, bez treści (#168)
//   storage.deleteObject(key)                  -> Promise<void>  // wyłącznie sprzątanie obiektu,
//                                                               // do którego nie powstał wpis w bazie,
//                                                               // i test smoke; dokumentów nie usuwamy (D-04)
//   storage.listObjects(prefix, continuationToken) -> Promise<{ keys, nextContinuationToken, isTruncated }>
//                                                               // do kontroli zgodności bez dostępu do bazy (#103)
//
// Implementacja S3 podpisuje żądania AWS Signature V4 (node:crypto + fetch),
// bez dodatkowych zależności. Railway Storage Bucket jest zawsze prywatny;
// aplikacja pobiera obiekt po autoryzacji i przekazuje go przez serwer
// (proxy). Nie generujemy publicznych ani długo ważnych adresów.
//
// Klucz obiektu jest losowy (docs/<uuid>) i nie zawiera nazwy pliku,
// danych ucznia ani rodziny. Błędy nie zawierają odpowiedzi dostawcy.

import { createHash, createHmac } from 'node:crypto';

const OBJECT_KEY = /^[a-z]+\/[A-Za-z0-9-]{8,64}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const LIST_PAGE_SIZE = 1000;

function storageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function assertObjectKey(key) {
  if (typeof key !== 'string' || !OBJECT_KEY.test(key)) throw storageError('storage_invalid_key');
  return key;
}

// --- Pamięć (testy) ----------------------------------------------------------

export function createMemoryStorage() {
  const objects = new Map();
  return {
    kind: 'memory',
    async putObject(key, bytes, contentType) {
      assertObjectKey(key);
      objects.set(key, { body: Uint8Array.from(bytes), contentType: String(contentType) });
    },
    async getObject(key) {
      assertObjectKey(key);
      const object = objects.get(key);
      if (!object) throw storageError('storage_object_not_found');
      return { body: Uint8Array.from(object.body), contentType: object.contentType, size: object.body.length };
    },
    // Czy obiekt istnieje, bez pobierania treści (#168: potwierdzenie przed
    // usunięciem osieroconego obiektu albo przed zwrotem replayed:true).
    async headObject(key) {
      assertObjectKey(key);
      return objects.has(key);
    },
    async deleteObject(key) {
      assertObjectKey(key);
      objects.delete(key);
    },
    // Strona kluczy w porządku leksykograficznym (jak ListObjectsV2), po
    // maks. 1000 na stronę. `continuationToken` to indeks strony (nieprzezroczysty
    // dla wywołującego — jak prawdziwy token S3, nie zakładać formatu).
    async listObjects(prefix = '', continuationToken) {
      const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = continuationToken ? Number(continuationToken) : 0;
      const page = all.slice(start, start + LIST_PAGE_SIZE);
      const isTruncated = start + LIST_PAGE_SIZE < all.length;
      return { keys: page, isTruncated, nextContinuationToken: isTruncated ? String(start + LIST_PAGE_SIZE) : null };
    },
    // Tylko do testów: lista kluczy i bezpośredni dostęp do zawartości.
    keys: () => [...objects.keys()],
    raw: (key) => objects.get(key),
  };
}

// --- AWS Signature V4 --------------------------------------------------------

export function sha256Hex(data) {
  return createHash('sha256').update(data ?? '').digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDates(now) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// Podpis nagłówkowy SigV4. `url` musi mieć już zakodowaną ścieżkę (RFC 3986).
// Dla usługi s3 podpisywany jest też nagłówek x-amz-content-sha256.
export function signRequest({
  method, url, headers = {}, payloadHash = sha256Hex(''),
  accessKeyId, secretAccessKey, region, service = 's3', now = new Date(),
}) {
  const target = new URL(url);
  const { amzDate, dateStamp } = amzDates(now);
  const all = {};
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = String(value);
  all.host = target.host;
  all['x-amz-date'] = amzDate;
  if (service === 's3') all['x-amz-content-sha256'] = payloadHash;

  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((name) => `${name}:${all[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = [...target.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [method, target.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: all, signature, canonicalRequest, stringToSign };
}

// --- S3 (Railway Storage Bucket) --------------------------------------------

export function createS3Storage({
  endpoint, region, bucket, accessKeyId, secretAccessKey,
  urlStyle = 'virtual', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date(),
}) {
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) throw storageError('storage_config_incomplete');
  const base = new URL(endpoint);
  if (base.protocol !== 'https:') throw storageError('storage_endpoint_must_be_https');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw storageError('storage_invalid_bucket');
  if (!['virtual', 'path'].includes(urlStyle)) throw storageError('storage_invalid_url_style');

  function objectUrl(key) {
    const path = assertObjectKey(key).split('/').map(encodeRfc3986).join('/');
    return urlStyle === 'path'
      ? `${base.protocol}//${base.host}/${bucket}/${path}`
      : `${base.protocol}//${bucket}.${base.host}/${path}`;
  }

  function bucketUrl() {
    return urlStyle === 'path'
      ? `${base.protocol}//${base.host}/${bucket}`
      : `${base.protocol}//${bucket}.${base.host}/`;
  }

  async function send(method, key, { body, contentType } = {}) {
    const url = objectUrl(key);
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');
    const extra = contentType ? { 'content-type': contentType } : {};
    const { headers } = signRequest({ method, url, headers: extra, payloadHash, accessKeyId, secretAccessKey, region, now: now() });
    delete headers.host; // fetch ustawia Host z adresu URL (ta sama wartość)
    try {
      return await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw storageError('storage_unreachable');
    }
  }

  return {
    kind: 's3',
    async putObject(key, bytes, contentType) {
      const response = await send('PUT', key, { body: bytes, contentType });
      await response.arrayBuffer().catch(() => {});
      if (!response.ok) throw storageError(`storage_put_${response.status}`);
    },
    async getObject(key) {
      const response = await send('GET', key);
      if (response.status === 404) { await response.arrayBuffer().catch(() => {}); throw storageError('storage_object_not_found'); }
      if (!response.ok) { await response.arrayBuffer().catch(() => {}); throw storageError(`storage_get_${response.status}`); }
      const body = new Uint8Array(await response.arrayBuffer());
      return { body, contentType: response.headers.get('content-type'), size: body.length };
    },
    async headObject(key) {
      const response = await send('HEAD', key);
      await response.arrayBuffer().catch(() => {});
      if (response.status === 404) return false;
      if (!response.ok) throw storageError(`storage_head_${response.status}`);
      return true;
    },
    async deleteObject(key) {
      const response = await send('DELETE', key);
      await response.arrayBuffer().catch(() => {});
      if (!response.ok && response.status !== 404) throw storageError(`storage_delete_${response.status}`);
    },
    // ListObjectsV2 (#103). Bez zależności na parser XML — odpowiedź jest
    // wystarczająco prosta (elementy <Key>/<IsTruncated>/<NextContinuationToken>
    // nigdy nie zawierają zagnieżdżonych elementów o tej samej nazwie).
    async listObjects(prefix = '', continuationToken) {
      const url = new URL(bucketUrl());
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', String(LIST_PAGE_SIZE));
      if (prefix) url.searchParams.set('prefix', prefix);
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
      const payloadHash = sha256Hex('');
      const { headers } = signRequest({ method: 'GET', url: url.toString(), payloadHash, accessKeyId, secretAccessKey, region, now: now() });
      delete headers.host;
      let response;
      try {
        response = await fetchImpl(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw storageError('storage_unreachable');
      }
      const body = await response.text().catch(() => '');
      if (!response.ok) throw storageError(`storage_list_${response.status}`);
      return parseListObjectsV2(body);
    },
  };
}

function xmlTagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

function parseListObjectsV2(xml) {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1]);
  const isTruncated = xmlTagValue(xml, 'IsTruncated') === 'true';
  const nextContinuationToken = isTruncated ? xmlTagValue(xml, 'NextContinuationToken') : null;
  return { keys, isTruncated, nextContinuationToken };
}

// Konfiguracja wyłącznie ze zmiennych środowiskowych (sekrety Railway).
// Brak wszystkich zmiennych = brak magazynu (trasy dokumentów zwracają 503).
// Częściowa konfiguracja zatrzymuje start, by nie działać na złym buckecie.
export const BUCKET_ENV = Object.freeze(['BUCKET_ENDPOINT', 'BUCKET_REGION', 'BUCKET_NAME', 'BUCKET_ACCESS_KEY_ID', 'BUCKET_SECRET_ACCESS_KEY']);

export function storageFromEnv(processEnv = process.env, options = {}) {
  const present = BUCKET_ENV.filter((name) => processEnv[name]);
  if (!present.length) return null;
  if (present.length !== BUCKET_ENV.length) {
    throw storageError(`storage_config_incomplete:${BUCKET_ENV.filter((name) => !processEnv[name]).join(',')}`);
  }
  return createS3Storage({
    endpoint: processEnv.BUCKET_ENDPOINT,
    region: processEnv.BUCKET_REGION,
    bucket: processEnv.BUCKET_NAME,
    accessKeyId: processEnv.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: processEnv.BUCKET_SECRET_ACCESS_KEY,
    urlStyle: processEnv.BUCKET_URL_STYLE || 'virtual',
    ...options,
  });
}
