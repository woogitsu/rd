// Strumieniowy odczyt paczki eksportu rocznego (#216). Prototyp — opis w docs/EXPORT.md.
//
// Paczka to jeden obiekt JSON: { files: { "<tabela>.jsonl": "<JSONL jako string>" },
// format, formatVersion, manifest, manifestSha256 }. Dotąd weryfikacja i
// odtworzenie wczytywały ją jednym JSON.parse (kilka kopii rozmiaru pliku w
// pamięci). Tu czytamy tekst fragmentami: stringi plików są dekodowane w
// locie i dzielone na linie, SHA-256, liczność, zestaw kolumn i sumy *_cents
// liczą się przyrostowo, a w pamięci jest najwyżej jedna linia pliku (jeden
// wiersz) i jeden fragment wejścia. Pozostałe klucze (manifest — mały) są
// parsowane w całości, z limitem rozmiaru.
//
// Moduł nie zna reguł manifestu — te są w src/pg/export.js (verifyParsedBundle),
// wspólne dla paczki w pamięci i czytanej z pliku.

import { createHash } from 'node:crypto';
// Import cykliczny z export.js jest bezpieczny: używany dopiero w czasie wywołania.
import { canonicalJson as canonical, ExportError } from './export.js';

// Kody błędów paczki (jak w export.js: tylko skrypt operatora, nie odpowiedzi API).
function bad(code) {
  throw new ExportError(code ?? 'invalid_bundle_json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Przyrostowa analiza pliku JSONL: tekst podawany kawałkami (`add`), na końcu
 * `end()`. Skrót liczony jest po całych liniach, więc para surogatów UTF-16
 * nigdy nie zostaje rozdzielona między dwa wywołania `update`.
 * Wynik (`stats()`): sha256, rows (liczba znaków nowej linii), error (pierwszy
 * błąd formatu w kolejności jak parseJsonLines), signature (posortowane klucze
 * pierwszego rekordu), signatureMismatch, cents (sumy kluczy *_cents),
 * invalidCents. Z `keepRecords` rekordy trafiają do `records` (odbiera je
 * wywołujący, np. partiami INSERT przy odtworzeniu).
 */
export class JsonLinesScanner {
  constructor(path, { keepRecords = false } = {}) {
    this.path = path;
    this.keepRecords = keepRecords;
    this.hash = createHash('sha256');
    this.line = '';
    this.rows = 0;
    this.lineError = null;
    this.unterminated = false;
    this.signature = null;
    this.signatureMismatch = false;
    this.cents = new Map();
    this.invalidCents = false;
    this.records = [];
    this.digest = null;
  }

  add(text) {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) {
        if (start < text.length) this.line += text.slice(start);
        return;
      }
      this.line += text.slice(start, newline);
      this.#finishLine();
      start = newline + 1;
    }
  }

  #finishLine() {
    const line = this.line;
    this.line = '';
    this.hash.update(`${line}\n`, 'utf8');
    this.rows += 1;
    if (this.lineError) return;
    let record;
    try { record = JSON.parse(line); } catch { this.lineError = `invalid_json_line:${this.path}:${this.rows}`; return; }
    if (!isPlainObject(record)) { this.lineError = `invalid_json_line:${this.path}:${this.rows}`; return; }
    if (canonical(record) !== line) { this.lineError = `non_canonical_line:${this.path}:${this.rows}`; return; }
    const signature = canonical(Object.keys(record).sort());
    if (this.signature === null) this.signature = signature;
    else if (signature !== this.signature) this.signatureMismatch = true;
    for (const key of Object.keys(record)) {
      if (!key.endsWith('_cents')) continue;
      const value = record[key];
      if (value === null || value === undefined) continue;
      if (!Number.isSafeInteger(value)) { this.invalidCents = true; continue; }
      this.cents.set(key, (this.cents.get(key) ?? 0) + value);
    }
    if (this.keepRecords) this.records.push(record);
  }

  end() {
    if (this.digest !== null) return this;
    if (this.line !== '') {
      this.hash.update(this.line, 'utf8');
      this.unterminated = true;
      this.line = '';
    }
    this.digest = this.hash.digest('hex');
    return this;
  }

  stats() {
    this.end();
    return {
      sha256: this.digest,
      rows: this.rows,
      error: this.unterminated ? `file_not_terminated:${this.path}` : this.lineError,
      signature: this.signature,
      signatureMismatch: this.signatureMismatch,
      cents: this.cents,
      invalidCents: this.invalidCents,
    };
  }
}

/** Analiza pliku JSONL podanego w całości (paczka w pamięci). */
export function scanJsonLines(content, path) {
  const scanner = new JsonLinesScanner(path);
  scanner.add(content);
  return scanner.stats();
}

// ---------------------------------------------------------------------------
// Parser paczki: generator wznawiany po każdym fragmencie wejścia.

const MAX_VALUE_CHARS = 32 * 1024 * 1024; // manifest i inne klucze poza `files`
const MAX_KEY_CHARS = 1024;

function* need(src) {
  while (src.i >= src.buf.length) {
    if (src.eof) bad();
    yield;
  }
}

function* skipWs(src) {
  for (;;) {
    while (src.i < src.buf.length) {
      const code = src.buf.charCodeAt(src.i);
      if (code === 32 || code === 9 || code === 10 || code === 13) src.i += 1;
      else return;
    }
    if (src.eof) return;
    yield;
  }
}

function* peek(src) {
  yield* need(src);
  return src.buf[src.i];
}

function* expect(src, char) {
  yield* need(src);
  if (src.buf[src.i] !== char) bad();
  src.i += 1;
}

// Dowolna wartość JSON jako surowy tekst (śledzenie zagnieżdżenia i stringów), potem JSON.parse.
function* captureValue(src, limit) {
  let raw = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (;;) {
    if (src.i >= src.buf.length) {
      if (src.eof) {
        if (depth === 0 && !inString && raw) break;
        bad();
      }
      yield;
      continue;
    }
    const char = src.buf[src.i];
    if (inString) {
      src.i += 1;
      raw += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth === 0) break;
      }
    } else if (char === '"') {
      src.i += 1;
      raw += char;
      inString = true;
    } else if (char === '{' || char === '[') {
      src.i += 1;
      raw += char;
      depth += 1;
    } else if (char === '}' || char === ']') {
      if (depth === 0) break;
      src.i += 1;
      raw += char;
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 0 && (char === ',' || char === ' ' || char === '\n' || char === '\t' || char === '\r')) {
      break;
    } else {
      src.i += 1;
      raw += char;
    }
    if (raw.length > limit) bad('invalid_bundle');
  }
  try { return JSON.parse(raw); } catch { return bad(); }
}

function* readKey(src) {
  const value = yield* captureValue(src, MAX_KEY_CHARS);
  if (typeof value !== 'string') bad();
  return value;
}

// String JSON dekodowany w locie; `onText` dostaje zdekodowane kawałki. Otwierający cudzysłów już zjedzony.
function* streamString(src, onText) {
  for (;;) {
    yield* need(src);
    const { buf } = src;
    let j = src.i;
    while (j < buf.length) {
      const code = buf.charCodeAt(j);
      if (code === 34 || code === 92 || code < 32) break;
      j += 1;
    }
    if (j > src.i) onText(buf.slice(src.i, j));
    src.i = j;
    if (j >= buf.length) continue;
    const code = buf.charCodeAt(j);
    src.i += 1;
    if (code === 34) return;
    if (code < 32) bad();
    yield* need(src);
    const escape = src.buf[src.i];
    src.i += 1;
    switch (escape) {
      case '"': onText('"'); break;
      case '\\': onText('\\'); break;
      case '/': onText('/'); break;
      case 'b': onText('\b'); break;
      case 'f': onText('\f'); break;
      case 'n': onText('\n'); break;
      case 'r': onText('\r'); break;
      case 't': onText('\t'); break;
      case 'u': {
        let hex = '';
        while (hex.length < 4) {
          yield* need(src);
          hex += src.buf[src.i];
          src.i += 1;
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad();
        onText(String.fromCharCode(Number.parseInt(hex, 16)));
        break;
      }
      default: bad();
    }
  }
}

function* parseFiles(src, handlers, shell) {
  yield* expect(src, '{');
  shell.files = { paths: [] };
  const seen = new Set();
  yield* skipWs(src);
  if ((yield* peek(src)) === '}') { src.i += 1; return; }
  for (;;) {
    yield* skipWs(src);
    const path = yield* readKey(src);
    if (seen.has(path)) bad(`duplicate_file:${path}`);
    seen.add(path);
    shell.files.paths.push(path);
    yield* skipWs(src);
    yield* expect(src, ':');
    yield* skipWs(src);
    if ((yield* peek(src)) === '"') {
      src.i += 1;
      const target = handlers.file(path);
      yield* streamString(src, target ? (text) => target.add(text) : () => {});
      if (target) target.end();
    } else {
      yield* captureValue(src, MAX_VALUE_CHARS);
      handlers.nonString(path);
    }
    yield* skipWs(src);
    const next = yield* peek(src);
    src.i += 1;
    if (next === '}') return;
    if (next !== ',') bad();
  }
}

function* parseBundle(src, handlers, shell) {
  yield* skipWs(src);
  if ((yield* peek(src)) !== '{') bad('invalid_bundle');
  src.i += 1;
  yield* skipWs(src);
  if ((yield* peek(src)) === '}') {
    src.i += 1;
  } else {
    for (;;) {
      yield* skipWs(src);
      const key = yield* readKey(src);
      yield* skipWs(src);
      yield* expect(src, ':');
      yield* skipWs(src);
      if (key === 'files' && (yield* peek(src)) === '{') {
        if (shell.files !== null) bad('invalid_bundle');
        yield* parseFiles(src, handlers, shell);
      } else {
        const value = yield* captureValue(src, MAX_VALUE_CHARS);
        if (key === 'files') shell.files = { invalid: true, value };
        else shell.fields[key] = value;
      }
      yield* skipWs(src);
      const next = yield* peek(src);
      src.i += 1;
      if (next === '}') break;
      if (next !== ',') bad();
    }
  }
  // Po obiekcie wolno tylko białe znaki (skipWs wraca przy innym znaku albo na końcu wejścia).
  yield* skipWs(src);
  if (src.i < src.buf.length) bad();
}

/**
 * Czyta paczkę z asynchronicznego źródła tekstu (np. fs.createReadStream z
 * encoding 'utf8'). `handlers.file(path)` zwraca JsonLinesScanner (albo null,
 * gdy plik ma być pominięty); `handlers.nonString(path)` odnotowuje wartość,
 * która nie jest stringiem; `handlers.drain()` (opcjonalnie, async) jest
 * wywoływane po każdym fragmencie wejścia — tu odtworzenie zapisuje rekordy.
 * Zwraca { fields: { format, formatVersion, manifest, manifestSha256, … }, files }
 * gdzie `files` to { paths } dla obiektu, { invalid: true } dla innej wartości, null gdy brak.
 * Źródło może dawać Buffery (dekodowane jako UTF-8, błędne bajty to invalid_bundle_json) albo stringi.
 */
export async function readBundleStream(source, handlers) {
  const shell = { fields: Object.create(null), files: null };
  const src = { buf: '', i: 0, eof: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = parseBundle(src, handlers, shell);
  let done = parser.next().done;
  for await (const chunk of source) {
    let text;
    try { text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }); } catch { bad(); }
    src.buf = src.i < src.buf.length ? src.buf.slice(src.i) + text : text;
    src.i = 0;
    if (!done) done = parser.next().done;
    else if (text.trim()) bad();
    if (handlers.drain) await handlers.drain();
  }
  try {
    const rest = decoder.decode();
    if (rest && done && rest.trim()) bad();
    if (rest) { src.buf = src.buf.slice(src.i) + rest; src.i = 0; }
  } catch { bad(); }
  src.eof = true;
  if (!done) done = parser.next().done;
  if (!done) bad();
  if (handlers.drain) await handlers.drain();
  return shell;
}
