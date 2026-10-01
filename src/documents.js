// Walidacja prywatnych dokumentów (issue #39). Czyste funkcje bez bazy.
// Moduł jest ładowany wyłącznie przez serwer Node (src/server.js, src/node-app.js,
// src/pg/**), nie przez Worker — stąd dozwolony node:zlib (strumienie obiektów PDF, #89).

import { constants as zlibConstants, inflateSync } from 'node:zlib';
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

// Wersja reguł kontroli struktury (issue #89, migracja 0161). Zapisywana w
// `documents.validation_version` przy przesłaniu. Podgląd pliku sprawdzonego
// BIEŻĄCĄ wersją (i o zgodnym SHA-256) nie przeszukuje bajtów ponownie; plik
// sprawdzony starszą wersją albo bez wersji (NULL) — tak, przy każdym podglądzie.
//
// KAŻDA zmiana reguł między znacznikami „reguły kontroli struktury” niżej
// (lista kluczy, limity, heurystyki PDF/PNG/JPEG) wymaga podbicia tej stałej —
// inaczej podgląd pominąłby nowe reguły dla plików przyjętych po staremu.
// Pilnuje tego odcisk kodu reguł w tests/documents-validation-version.test.js.
export const DOCUMENT_VALIDATION_VERSION = 2;

// --- reguły kontroli struktury: początek (odcisk: tests/documents-validation-version.test.js) ---
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
// `/SubmitForm` i `/ImportData` (#89, druga część): akcje formularza wysyłające dane
// z dokumentu pod dowolny adres albo wczytujące je z zewnątrz — w fakturach i wyciągach
// niepotrzebne. Ryzyko fałszywego odrzucenia formularza z banku opisuje DOCUMENTS.md.
const PDF_DANGEROUS_KEYS = [
  '/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia', '/XFA', '/Encrypt', '/SubmitForm', '/ImportData',
];
// Nazwy PDF mogą zawierać zapis szesnastkowy (`/J#61vaScript` = `/JavaScript`), więc
// samo szukanie surowego napisu dawałoby trywialne obejście. Przed porównaniem
// dekodujemy `#XX` wyłącznie wewnątrz nazw (token zaczynający się od `/`).
const PDF_NAME_WITH_ESCAPE = /\/[^\s/<>[\](){}%]*#[0-9A-Fa-f]{2}[^\s/<>[\](){}%]*/g;
// `/OpenAction << … >>` to akcja wpisana w miejscu; prawidłowy cel (strona) to tablica
// `[ … ]` albo odnośnik `n 0 R`. Odnośnik do akcji ze skryptem/Launch wychwytują
// słowa kluczowe powyżej, dlatego samego `/OpenAction` nie odrzucamy (ryzyko
// fałszywych odrzuceń PDF z banku).
const PDF_INLINE_OPEN_ACTION = /\/OpenAction\s*<</;
// Jeden bajt = jeden znak (bez dekodowania UTF-8); stała, bo test katalogu błędów
// (tests/pg-api-errors-catalog.test.js) traktuje literał w `new X('…')` jak kod błędu.
const PDF_TEXT_ENCODING = 'latin1';
const PDF_EOF = asciiBytes('%%EOF');
const PNG_SIGNATURE_LENGTH = 8;
const PNG_IEND = asciiBytes('IEND');
const PNG_IHDR = asciiBytes('IHDR');

// Strumienie obiektów (`/Type /ObjStm`, PDF 1.5+) przechowują słowniki w postaci
// skompresowanej — `/JavaScript` albo `/OpenAction << … >>` wewnątrz takiego strumienia
// nie są widoczne w surowych bajtach, więc sama kontrola surowego tekstu dawała
// trywialne obejście. Rozpakowujemy WYŁĄCZNIE strumienie obiektów (słowniki mogą leżeć
// tylko w treści pliku albo w ObjStm); strumieni treści stron i obrazów nie
// przeszukujemy, bo przypadkowe bajty skompresowanego obrazu dawałyby fałszywe
// odrzucenia. Strumień obiektów, którego nie umiemy odczytać (inny filtr niż
// FlateDecode, uszkodzone dane, przekroczony limit rozpakowania), traktujemy jak
// uszkodzoną strukturę — nie możemy go sprawdzić, więc go nie przyjmujemy.
// Słownik strumienia szukamy wstecz od słowa `stream` (liniowo, bez wyrażenia
// regularnego z nawrotami — plik 25 MiB z tysiącami obiektów nie może zająć procesu).
// Słownik dłuższy niż limit albo niedomknięty: nie umiemy go ocenić — plik odrzucamy.
const PDF_STREAM_DICT_MAX_CHARS = 64 * 1024;
// Limit rozpakowania (ochrona przed „bombą” zlib): na jeden strumień i na cały plik.
export const PDF_OBJECT_STREAM_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_OBJECT_STREAMS_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

function decodePdfNames(text) {
  return text.replace(PDF_NAME_WITH_ESCAPE, (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}

function hasPdfActiveContent(text) {
  return PDF_DANGEROUS_KEYS.some((key) => text.includes(key)) || PDF_INLINE_OPEN_ACTION.test(text);
}

// Filtr słownika strumienia: `/Filter /FlateDecode` albo `/Filter [/FlateDecode]` -> 'flate';
// brak filtra -> 'none'; cokolwiek innego (łańcuch filtrów, LZW, ASCIIHex…) -> 'other'.
function pdfStreamFilter(dict) {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!match) return 'none';
  const names = match[1].match(/\/[A-Za-z0-9]+/g) ?? [];
  if (names.length === 1 && (names[0] === '/FlateDecode' || names[0] === '/Fl')) return 'flate';
  return names.length === 0 ? 'none' : 'other';
}

function isPdfWhitespace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
}

// Początek słownika `<< … >>` kończącego się na pozycji `end` (drugi znak `>`),
// z uwzględnieniem zagnieżdżeń; -1 = nie znaleziono w limicie.
function pdfDictStart(text, end, budget) {
  let depth = 0;
  const limit = Math.max(0, end - PDF_STREAM_DICT_MAX_CHARS);
  for (let k = end; k > limit; ) {
    // Łączny budżet kroków na plik: nakładające się słowniki nie dają pracy kwadratowej.
    budget.steps -= 1;
    if (budget.steps < 0) return -1;
    if (text[k] === '>' && text[k - 1] === '>') { depth += 1; k -= 2; continue; }
    if (text[k] === '<' && text[k - 1] === '<') {
      depth -= 1;
      if (depth === 0) return k - 1;
      k -= 2;
      continue;
    }
    k -= 1;
  }
  return -1;
}

// Zwraca null, gdy strumienie obiektów są czyste, albo kod błędu.
function inspectPdfObjectStreams(bytes, text) {
  let total = 0;
  const budget = { steps: 4 * text.length + PDF_STREAM_DICT_MAX_CHARS };
  for (let at = text.indexOf('stream'); at !== -1; at = text.indexOf('stream', at + 6)) {
    if (at >= 3 && text.startsWith('end', at - 3)) continue;
    let start = at + 6;
    if (text[start] === '\r' && text[start + 1] === '\n') start += 2;
    else if (text[start] === '\n' || text[start] === '\r') start += 1;
    else continue;
    let dictEnd = at - 1;
    while (dictEnd >= 0 && isPdfWhitespace(text[dictEnd])) dictEnd -= 1;
    if (text[dictEnd] !== '>' || text[dictEnd - 1] !== '>') continue;
    const dictStart = pdfDictStart(text, dictEnd, budget);
    if (dictStart === -1) return 'document_malformed';
    // Nazwy w słowniku też mogą być zapisane szesnastkowo (`/Obj#53tm`, `/Fl#61teDecode`).
    const dict = decodePdfNames(text.slice(dictStart, dictEnd + 1));
    // Strumień obiektów rozpoznajemy po `/Type /ObjStm` ALBO po kluczu `/First`
    // (obowiązkowy w ObjStm; czytniki, np. pdf.js, nie wymagają `/Type`).
    if (!/\/Type\s*\/ObjStm\b/.test(dict) && !/\/First\b/.test(dict)) continue;
    // Predyktor (`/DecodeParms << /Predictor 12 … >>`) przeplata dane bajtami filtra
    // wierszy i rozbiłby słowa kluczowe po rozpakowaniu — takiego strumienia nie sprawdzimy.
    const predictor = /\/Predictor\s+(\d+)/.exec(dict);
    if (predictor && Number(predictor[1]) > 1) return 'document_malformed';
    const length = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
    let end = length && !length[2] ? start + Number(length[1]) : -1;
    if (end < start || end > bytes.length) {
      // Długość pośrednia (`n 0 R`) albo błędna: dane do słowa `endstream`.
      end = text.indexOf('endstream', start);
      if (end === -1) return 'document_malformed';
    }
    const filter = pdfStreamFilter(dict);
    let inflated;
    if (filter === 'none') {
      inflated = bytes.subarray(start, end);
    } else if (filter === 'flate') {
      const remaining = PDF_OBJECT_STREAMS_TOTAL_MAX_BYTES - total;
      try {
        inflated = inflateSync(bytes.subarray(start, end), {
          maxOutputLength: Math.max(1, Math.min(PDF_OBJECT_STREAM_MAX_BYTES, remaining)),
          // Tolerancja na brak sumy Adler-32 na końcu (spotykane w generatorach PDF).
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        });
      } catch {
        return 'document_malformed';
      }
    } else {
      return 'document_malformed';
    }
    total += inflated.length;
    if (total > PDF_OBJECT_STREAMS_TOTAL_MAX_BYTES) return 'document_malformed';
    if (hasPdfActiveContent(decodePdfNames(new TextDecoder(PDF_TEXT_ENCODING).decode(inflated)))) {
      return 'document_active_content';
    }
  }
  return null;
}

function validatePdfStructure(bytes) {
  const raw = new TextDecoder(PDF_TEXT_ENCODING).decode(bytes);
  if (hasPdfActiveContent(decodePdfNames(raw))) return { ok: false, code: 'document_active_content' };
  const objectStreams = inspectPdfObjectStreams(bytes, raw);
  if (objectStreams) return { ok: false, code: objectStreams };
  // %%EOF musi wystąpić blisko końca pliku; jego brak (albo dane doklejone
  // dalej, np. poliglota PDF+ZIP) traktujemy jako uszkodzoną/podejrzaną strukturę.
  if (bytesIndexOf(bytes, PDF_EOF, 1024) === -1) return { ok: false, code: 'document_malformed' };
  return { ok: true };
}

// Typ chunku PNG to cztery litery ASCII (A-Z, a-z); pierwszy chunk musi być IHDR.
function isPngChunkType(bytes, offset) {
  for (let i = 0; i < 4; i += 1) {
    const byte = bytes[offset + i];
    if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) return false;
  }
  return true;
}

// Zgodność struktury obrazu z jego nagłówkiem (#89, wersja reguł 2): wymiary w IHDR/SOF
// muszą być dodatnie i rozsądne (limit liczby pikseli chroni przed „bombą dekompresyjną”
// w czytniku przeglądarki), PNG ma poprawne sumy CRC chunków i dane obrazu (IDAT),
// JPEG ma nagłówek ramki (SOF) przed danymi skanu. To nadal heurystyka — obrazu nie dekodujemy.
const IMAGE_MAX_DIMENSION = 30000;
const IMAGE_MAX_PIXELS = 100_000_000;
const PNG_IHDR_DATA_LENGTH = 13;
const PNG_IDAT = asciiBytes('IDAT');
// Dozwolone głębie bitowe dla typu koloru PNG (0 skala szarości, 2 RGB, 3 paleta, 4 szarość+alfa, 6 RGBA).
const PNG_BIT_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let crc = 0xffffffff;
  for (let i = from; i < to; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes, offset) {
  return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}

function imageSizeOk(width, height) {
  return width >= 1 && height >= 1 && width <= IMAGE_MAX_DIMENSION && height <= IMAGE_MAX_DIMENSION
    && width * height <= IMAGE_MAX_PIXELS;
}

function validatePngStructure(bytes) {
  let offset = PNG_SIGNATURE_LENGTH;
  let sawIdat = false;
  for (;;) {
    if (offset + 8 > bytes.length) return { ok: false, code: 'document_malformed' };
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    if (!isPngChunkType(bytes, typeOffset)) return { ok: false, code: 'document_malformed' };
    const first = offset === PNG_SIGNATURE_LENGTH;
    if (first && !PNG_IHDR.every((byte, index) => bytes[typeOffset + index] === byte)) {
      return { ok: false, code: 'document_malformed' };
    }
    const isIend = PNG_IEND.every((byte, index) => bytes[typeOffset + index] === byte);
    const chunkEnd = typeOffset + 4 + length + 4; // typ + dane + CRC
    if (chunkEnd > bytes.length) return { ok: false, code: 'document_malformed' };
    if (crc32(bytes, typeOffset, chunkEnd - 4) !== readUint32(bytes, chunkEnd - 4)) {
      return { ok: false, code: 'document_malformed' };
    }
    if (first) {
      const data = typeOffset + 4;
      const depths = PNG_BIT_DEPTHS[bytes[data + 9]];
      if (length !== PNG_IHDR_DATA_LENGTH || !imageSizeOk(readUint32(bytes, data), readUint32(bytes, data + 4))
        || !depths || !depths.includes(bytes[data + 8])) {
        return { ok: false, code: 'document_malformed' };
      }
    }
    if (PNG_IDAT.every((byte, index) => bytes[typeOffset + index] === byte)) sawIdat = true;
    if (isIend) return chunkEnd === bytes.length && sawIdat ? { ok: true } : { ok: false, code: 'document_malformed' };
    offset = chunkEnd;
  }
}

// Znaczniki ramki JPEG (SOF0–SOF15 poza DHT 0xC4, JPG 0xC8 i DAC 0xCC).
function isJpegFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function validateJpegStructure(bytes) {
  // Tolerancja na dopełnienie zerami na końcu pliku, ale nie na inne dołożone dane.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end -= 1;
  if (end < 2 || bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return { ok: false, code: 'document_malformed' };
  // Segmenty nagłówkowe od SOI do SOS: każdy musi się mieścić w pliku, a przed SOS
  // musi wystąpić nagłówek ramki z dodatnimi wymiarami.
  let offset = 2;
  let sawFrame = false;
  for (;;) {
    if (offset + 2 > end || bytes[offset] !== 0xff) return { ok: false, code: 'document_malformed' };
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; } // bajty dopełnienia FF
    if (marker === 0xda) return sawFrame ? { ok: true } : { ok: false, code: 'document_malformed' };
    if (marker === 0xd9 || marker === 0xd8) return { ok: false, code: 'document_malformed' };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; } // bez długości
    if (offset + 4 > end) return { ok: false, code: 'document_malformed' };
    const length = bytes[offset + 2] << 8 | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > end) return { ok: false, code: 'document_malformed' };
    if (isJpegFrameMarker(marker)) {
      if (length < 8 || sawFrame) return { ok: false, code: 'document_malformed' };
      const height = bytes[offset + 5] << 8 | bytes[offset + 6];
      const width = bytes[offset + 7] << 8 | bytes[offset + 8];
      const precision = bytes[offset + 4];
      if (!imageSizeOk(width, height) || precision < 2 || precision > 16 || bytes[offset + 9] === 0) return { ok: false, code: 'document_malformed' };
      sawFrame = true;
    }
    offset += 2 + length;
  }
}

export function validateStructure(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'document_malformed' };
  if (mime === 'application/pdf') return validatePdfStructure(bytes);
  if (mime === 'image/png') return validatePngStructure(bytes);
  if (mime === 'image/jpeg') return validateJpegStructure(bytes);
  return { ok: false, code: 'document_malformed' };
}
// --- reguły kontroli struktury: koniec ---

// Limit ciała żądania dla serwera Node: wyższy tylko dla POST /api/documents.
export function bodyLimitFor(uploadLimit = DEFAULT_MAX_UPLOAD_BYTES) {
  const limit = maxUploadBytes(uploadLimit);
  return (url, method) => (method === 'POST' && url.pathname === UPLOAD_PATH ? limit : DEFAULT_BODY_LIMIT_BYTES);
}

// #185 pkt 3: limit równoczesnych uploadów NA PROCES (nie na klaster Railway —
// z kilkoma instancjami trzeba by dzielić stan, poza zakresem tego prototypu).
// Semafor liczący — bez kolejki: piąte i kolejne równoczesne żądanie dostaje
// od razu `503 upload_busy`, zamiast czekać na zwolnienie miejsca. Licznik
// żyje przez cały czas życia procesu (moduł ładowany raz), nie per-żądanie.
//
// Dodatkowo limit NA UŻYTKOWNIKA (`key` = identyfikator użytkownika z sesji):
// jedno konto (np. przejęta sesja albo skrypt) nie może zająć wszystkich
// miejsc procesu i zablokować uploadów innym osobom. Panele wysyłają pliki
// pojedynczo, więc 2 wystarcza także na podwójne kliknięcie (drugie żądanie
// i tak rozstrzyga klucz idempotencji). Wspólny dla POST /api/documents
// i POST /api/news-photos/:id/file — oba czytają do 10-25 MB do pamięci.
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
export const DEFAULT_MAX_CONCURRENT_UPLOADS_PER_USER = 2;
let activeUploads = 0;
const activeByKey = new Map();

export function tryAcquireUploadSlot(max = DEFAULT_MAX_CONCURRENT_UPLOADS, key = null, maxPerKey = DEFAULT_MAX_CONCURRENT_UPLOADS_PER_USER) {
  const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_CONCURRENT_UPLOADS;
  const perKey = Number.isInteger(maxPerKey) && maxPerKey > 0 ? maxPerKey : DEFAULT_MAX_CONCURRENT_UPLOADS_PER_USER;
  if (activeUploads >= limit) return null;
  if (key != null && (activeByKey.get(key) ?? 0) >= perKey) return null;
  activeUploads += 1;
  if (key != null) activeByKey.set(key, (activeByKey.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
    if (key != null) {
      const left = (activeByKey.get(key) ?? 1) - 1;
      if (left > 0) activeByKey.set(key, left); else activeByKey.delete(key);
    }
  };
}

// Stan semafora (do testów i diagnostyki): liczba zajętych miejsc.
export function activeUploadSlots() { return activeUploads; }

// Wyłącznie do testów (odtworzenie stanu między przebiegami w tym samym procesie).
export function resetUploadSlotsForTests() { activeUploads = 0; activeByKey.clear(); }

// Czyta ciało Web Request z twardym limitem (niezależnie od Content-Length).
// #185 pkt 2: przy deklarowanym Content-Length (<= limit) bajty trafiają od
// razu do jednej prealokowanej Uint8Array — bez listy chunków i drugiej kopii.
// Ciało dłuższe niż deklaracja rośnie skokowo (nadal z twardym limitem); bez
// Content-Length (chunked) zbieramy chunki i składamy je raz.
export async function readLimited(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  const hasDeclared = request.headers.get('content-length') != null && Number.isInteger(declared) && declared >= 0;
  if (hasDeclared && declared > limit) throw new RangeError('document_too_large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  let buffer = hasDeclared ? new Uint8Array(declared) : null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      await reader.cancel().catch(() => {});
      throw new RangeError('document_too_large');
    }
    if (buffer) {
      if (size + value.byteLength > buffer.byteLength) {
        // Ciało dłuższe niż deklaracja: powiększamy (rzadkie, klient łamie protokół).
        const grown = new Uint8Array(Math.min(limit, Math.max(buffer.byteLength * 2, size + value.byteLength)));
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(value, size);
    } else {
      chunks.push(value);
    }
    size += value.byteLength;
  }
  if (buffer) return size === buffer.byteLength ? buffer : buffer.subarray(0, size);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
