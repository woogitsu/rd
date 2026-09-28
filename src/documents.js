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

// Kontrola struktury pliku (issue #89): heurystyka, NIE zastępuje skanu
// antywirusowego. Sprawdzamy surowe bajty pliku — strumienie PDF mogą być
// skompresowane (FlateDecode), więc słowo kluczowe wewnątrz skompresowanego
// strumienia nie zostanie wykryte. To znana granica tej kontroli (DOCUMENTS.md).
//
// Zwraca { ok: true } albo { ok: false, code: 'document_active_content' | 'document_malformed' }.

function bytesIndexOf(haystack, needle, fromEnd) {
  const start = fromEnd == null ? 0 : Math.max(0, haystack.length - fromEnd);
  outer: for (let i = start; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function asciiBytes(text) {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

// Klucze PDF, których obecność (nawet nieskompresowana) traktujemy jako
// potencjalnie aktywną treść albo szyfrowanie uniemożliwiające dalszą kontrolę.
// Lista do przeglądu (issue #89) — heurystyka, nie parser PDF.
const PDF_DANGEROUS_KEYS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia', '/XFA', '/Encrypt']
  .map(asciiBytes);
const PDF_EOF = asciiBytes('%%EOF');
const PNG_SIGNATURE_LENGTH = 8;
const PNG_IEND = asciiBytes('IEND');

function validatePdfStructure(bytes) {
  for (const key of PDF_DANGEROUS_KEYS) {
    if (bytesIndexOf(bytes, key) !== -1) return { ok: false, code: 'document_active_content' };
  }
  // %%EOF musi wystąpić blisko końca pliku; jego brak (albo dane doklejone
  // dalej, np. poliglota PDF+ZIP) traktujemy jako uszkodzoną/podejrzaną strukturę.
  if (bytesIndexOf(bytes, PDF_EOF, 1024) === -1) return { ok: false, code: 'document_malformed' };
  return { ok: true };
}

function validatePngStructure(bytes) {
  let offset = PNG_SIGNATURE_LENGTH;
  for (;;) {
    if (offset + 8 > bytes.length) return { ok: false, code: 'document_malformed' };
    const length = (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
    const typeOffset = offset + 4;
    const isIend = PNG_IEND.every((byte, index) => bytes[typeOffset + index] === byte);
    const chunkEnd = typeOffset + 4 + length + 4; // typ + dane + CRC
    if (chunkEnd > bytes.length) return { ok: false, code: 'document_malformed' };
    if (isIend) return chunkEnd === bytes.length ? { ok: true } : { ok: false, code: 'document_malformed' };
    offset = chunkEnd;
  }
}

function validateJpegStructure(bytes) {
  // Tolerancja na dopełnienie zerami na końcu pliku, ale nie na inne dołożone dane.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end -= 1;
  if (end < 2 || bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return { ok: false, code: 'document_malformed' };
  return { ok: true };
}

export function validateStructure(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'document_malformed' };
  if (mime === 'application/pdf') return validatePdfStructure(bytes);
  if (mime === 'image/png') return validatePngStructure(bytes);
  if (mime === 'image/jpeg') return validateJpegStructure(bytes);
  return { ok: false, code: 'document_malformed' };
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
