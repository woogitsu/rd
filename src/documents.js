// Walidacja prywatnych dokumentów (issue #39). Czyste funkcje bez bazy.
//
// Typ pliku ustalamy po sygnaturze (magic bytes), nie po nazwie ani samym
// nagłówku Content-Type. Zadeklarowany typ musi zgadzać się z wykrytym.
// CSV nie jest dopuszczony: nie ma sygnatury i zwykle zawiera listy osób.

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
export const UPLOAD_PATH = '/api/documents';

export const ALLOWED_TYPES = Object.freeze({
  'application/pdf': { extension: 'pdf', signature: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  'image/png': { extension: 'png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { extension: 'jpg', signature: [0xff, 0xd8, 0xff] },
});

export function detectType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  for (const [mime, { signature }] of Object.entries(ALLOWED_TYPES)) {
    if (bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)) return mime;
  }
  return null;
}

// "application/pdf; charset=binary" -> "application/pdf"; "image/jpg" traktujemy jak image/jpeg.
export function declaredType(header) {
  const value = String(header ?? '').split(';')[0].trim().toLowerCase();
  return value === 'image/jpg' ? 'image/jpeg' : value;
}

export function maxUploadBytes(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.min(number, HARD_MAX_UPLOAD_BYTES);
}

// Losowy, nieprzezroczysty klucz obiektu. Bez nazwy pliku, roku, klasy ani osoby.
export function newObjectKey() {
  return `docs/${crypto.randomUUID()}`;
}

export function downloadFilename(id, mime) {
  return `dokument-${id}.${ALLOWED_TYPES[mime]?.extension ?? 'bin'}`;
}

// Limit ciała żądania dla serwera Node: wyższy tylko dla POST /api/documents.
export function bodyLimitFor(uploadLimit = DEFAULT_MAX_UPLOAD_BYTES) {
  const limit = maxUploadBytes(uploadLimit);
  return (url, method) => (method === 'POST' && url.pathname === UPLOAD_PATH ? limit : DEFAULT_BODY_LIMIT_BYTES);
}

// Czyta ciało Web Request z twardym limitem (niezależnie od Content-Length).
export async function readLimited(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new RangeError('document_too_large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new RangeError('document_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
