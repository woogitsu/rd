// Wspólne elementy schematów OpenAPI (#160, etap 2). Schematy są pisane ręcznie na
// podstawie kodu tras i ich testów (JSON Schema 2020-12 w dialekcie OpenAPI 3.1);
// nie zmieniają zachowania tras. Generator scripts/build-openapi.js dołącza je do
// operacji, a tests/openapi-contract.test.js sprawdza je na rzeczywistych odpowiedziach.
//
// Konwencje:
//   * schematy ŻĄDAŃ nie ustawiają `additionalProperties: false` (trasy ignorują
//     nieznane pola) i opisują wymagania serwera przybliżeniem (np. długość po
//     przycięciu spacji jest opisana w `description`);
//   * schematy ODPOWIEDZI są ścisłe (`additionalProperties: false`, wszystkie pola
//     `required`, poza jawnie opcjonalnymi): nowe pole w odpowiedzi trasy wymaga
//     świadomej zmiany schematu, więc kontrakt nie rozjeżdża się po cichu;
//   * kwoty to całkowite eurocenty (EUR), bez liczb zmiennoprzecinkowych;
//   * żadnych danych osobowych w przykładach ani opisach.

export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
export const IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$';

/** Odwołanie do schematu w `components.schemas` wygenerowanej specyfikacji. */
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** Wartość albo `null`. */
export const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * Obiekt odpowiedzi: ścisły, wszystkie pola wymagane poza `optional`.
 * @param {Record<string, object>} properties
 * @param {string[]} [optional] nazwy pól, które mogą nie wystąpić
 */
export function strictObject(properties, optional = [], extra = {}) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
    ...extra,
  };
}

/**
 * Obiekt żądania: wskazane pola wymagane, nieznane pola dozwolone (trasy je ignorują).
 * @param {Record<string, object>} properties
 * @param {string[]} required
 */
export function requestObject(properties, required, extra = {}) {
  return { type: 'object', properties, required, ...extra };
}

export const COMMON_COMPONENTS = {
  Id: {
    type: 'string', pattern: ID_PATTERN,
    description: 'Identyfikator przekazywany w żądaniu (walidowany po stronie serwera: litery, cyfry, `_ . : -`, do 128 znaków).',
  },
  EntityId: {
    type: 'string', minLength: 1,
    description: 'Identyfikator obiektu w odpowiedzi (UUID nadany przez serwer albo identyfikator z importu).',
  },
  IsoDate: { type: 'string', format: 'date', description: 'Data kalendarzowa RRRR-MM-DD.' },
  IsoDateTime: { type: 'string', format: 'date-time', description: 'Znacznik czasu ISO 8601 (UTC).' },
  AmountCents: {
    type: 'integer', minimum: 1, maximum: 100000000,
    description: 'Kwota dodatnia w eurocentach (EUR); do 1 000 000,00 EUR.',
  },
  NonNegativeCents: { type: 'integer', minimum: 0, description: 'Kwota nieujemna w eurocentach (EUR).' },
  Count: { type: 'integer', minimum: 0, description: 'Liczba (zero lub więcej).' },
  SignedCents: { type: 'integer', description: 'Kwota ze znakiem w eurocentach (EUR); saldo może być ujemne.' },
  IdempotencyKey: {
    type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN,
    description: 'Klucz idempotencji (8-128 znaków). Ten sam klucz z tą samą treścią odtwarza zapis (200, `Idempotency-Replayed: true`); '
      + 'z inną treścią daje 409 `idempotency_conflict`.',
  },
};

/** Wspólna lista błędów zapisu (kody z docs/API_ERRORS.md). */
export const WRITE_ERRORS = {
  400: ['invalid_idempotency_key', 'invalid_json', 'invalid_request'],
  403: ['forbidden', 'invalid_origin'],
  409: ['idempotency_conflict', 'school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
};

/** Wspólna lista błędów odczytu. */
export const READ_ERRORS = {
  400: ['invalid_request'],
  403: ['forbidden'],
};

/** Zakazy bramki pól wolnego tekstu (#152). */
export const PII_ERRORS = { 422: ['personal_data_forbidden', 'possible_personal_data'] };

/** Scala listy kodów per status (suma, bez powtórzeń, posortowane). */
export function mergeErrors(...sets) {
  const merged = {};
  for (const set of sets) {
    for (const [status, codes] of Object.entries(set ?? {})) {
      merged[status] = [...new Set([...(merged[status] ?? []), ...codes])].sort();
    }
  }
  return merged;
}

export const OCTET_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** Odpowiedź plikowa (eksport CSV/XLSX): treść nie jest JSON-em, kształt opisuje kolumny w kodzie trasy. */
export function fileResponse(description, contentType) {
  return {
    description,
    contentType,
    schema: contentType === CSV_CONTENT_TYPE ? { type: 'string' } : { type: 'string', format: 'binary' },
  };
}

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * Odpowiedź w kilku formatach jednej trasy (parametr `format`, #160 etap 4): mapa
 * `typ treści → schemat`. Klient kontraktu wybiera schemat po rzeczywistym Content-Type.
 * @param {string} description
 * @param {Record<string, object>} content
 */
export const formatsResponse = (description, content) => ({ description, content });

/** Odpowiedź JSON z nagłówkiem `Idempotency-Replayed` (`'true'` dla 200 odtworzenia, `'false'` dla 201). */
export const replayed = (value, description, schema) => ({ description, schema, replayed: value });

/**
 * Odpowiedź zapisu bez klucza idempotencji (#160 etap 6): pierwsze wykonanie nie wysyła nagłówka
 * `Idempotency-Replayed`, a ponowienie (podwójne kliknięcie rozpoznane po stanie obiektu) wysyła `true`
 * z tym samym statusem i kształtem.
 */
export const replayedOnRetry = (description, schema) => ({ description, schema, replayed: 'true', replayedOptional: true });
