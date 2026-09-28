// Wspólny moduł wejścia HTTP dla tras PostgreSQL (issue #154).
//
// Cel: jedno miejsce dla parsowania ciała JSON, klasy błędu żądania,
// klucza idempotencji, identyfikatora ścieżki i kursora — zamiast 13 kopii
// z rozbieżnym zachowaniem (patrz tabela w issue #154). Moduł nie zależy od
// domeny (bez importów z authorization.js/audit.js), by dało się go
// bezpiecznie użyć w każdej trasie.
//
// Migracja istniejących modułów (families.js, payments.js, ledger.js, …) na
// ten moduł zostaje do kolejnych PR — każdy moduł osobno, z macierzą
// autoryzacji (tests/pg-authz-matrix.test.js) jako siatką bezpieczeństwa,
// zgodnie z opisem w issue #154. Ten PR naprawia tylko konkretny brak
// (exports.js nie sprawdzał deklarowanego Content-Length) i dodaje moduł
// gotowy do dalszej migracji.

/** Jedna klasa błędu żądania dla całego `src/pg/**`. */
export class ApiError extends Error {
  /**
   * @param {string} code kod błędu zwracany klientowi (`{ error: code }`)
   * @param {number} [status] status HTTP, domyślnie 400
   * @param {Record<string,string>} [headers] dodatkowe nagłówki odpowiedzi
   */
  constructor(code, status = 400, headers) {
    super(code);
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Odczyt i parsowanie ciała JSON w ustalonej kolejności: Content-Type →
 * deklarowany Content-Length → odczyt → rzeczywisty rozmiar → JSON.parse →
 * musi być obiektem (nie tablicą, nie null).
 *
 * @param {Request} request
 * @param {object} [options]
 * @param {number} [options.maxBytes] limit rozmiaru ciała (domyślnie 8 KiB)
 * @param {boolean} [options.allowEmpty] czy puste ciało zwraca `{}` zamiast 400
 * @returns {Promise<object>}
 */
export async function readJsonObject(request, { maxBytes = 8 * 1024, allowEmpty = false } = {}) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ApiError('request_too_large', 413);

  if (!type) {
    if (allowEmpty) {
      const text = await request.text();
      if (text.trim() === '') return {};
    }
    throw new ApiError('invalid_content_type', 415);
  }
  if (type !== 'application/json') throw new ApiError('invalid_content_type', 415);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiError('request_too_large', 413);
  if (text.trim() === '') {
    if (allowEmpty) return {};
    throw new ApiError('invalid_json');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('invalid_json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_json');
  return data;
}

/**
 * Klucz idempotencji z nagłówka `Idempotency-Key`, zwalidowany wzorcem.
 * @param {Request} request
 * @param {RegExp} [pattern]
 * @returns {string}
 */
export function readIdempotencyKey(request, pattern = /^[A-Za-z0-9_.:-]{8,128}$/) {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !pattern.test(key)) throw new ApiError('invalid_idempotency_key');
  return key;
}

const DEFAULT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Dekoduje identyfikator z fragmentu ścieżki (`decodeURIComponent` + wzorzec).
 * @param {string} raw
 * @param {object} [options]
 * @param {RegExp} [options.pattern]
 * @param {() => ApiError} [options.notFound] błąd zwracany zamiast domyślnego 404 not_found
 * @returns {string}
 */
export function decodePathId(raw, { pattern = DEFAULT_ID_PATTERN, notFound } = {}) {
  const fail = () => { throw notFound ? notFound() : new ApiError('not_found', 404); };
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fail();
  }
  if (!pattern.test(decoded)) return fail();
  return decoded;
}

/** @param {unknown} value @returns {boolean} czy `value` to poprawna data ISO `YYYY-MM-DD` */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Kursor keyset zakodowany jako base64url JSON. `schema` to lista pól, w
 * ustalonej kolejności, użyta do zbudowania stabilnego kształtu — kursor z
 * innego modułu (inna lista pól) jest odrzucany jako `invalid_cursor`, a nie
 * błędem 500/503.
 * @param {string[]} schema
 */
export function encodeCursor(schema, values) {
  const payload = schema.map((key) => values[key] ?? null);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * @param {string[]} schema
 * @param {string|null|undefined} raw
 * @returns {object|null} `null` gdy brak kursora; rzuca `ApiError('invalid_cursor')` gdy niepoprawny
 */
export function decodeCursor(schema, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('invalid_cursor');
  }
  if (!Array.isArray(payload) || payload.length !== schema.length) throw new ApiError('invalid_cursor');
  const values = {};
  schema.forEach((key, index) => { values[key] = payload[index]; });
  return values;
}
