// Schematy OpenAPI dla modułu `import` (src/pg/routes/import.js; #36, #88, #98, #145, #166, #184, #248), #160 etap 13:
// opcje importu (lata i klasy w zakresie importującego), podgląd planu (walidacja i różnica względem bazy, NIC nie
// zapisuje) i zapis planu w jednej transakcji. Pisane ręcznie na podstawie `parseImportPayload`, `buildPlan`,
// `batchResult` i testów tests/pg-import.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * serwer NIE przyjmuje pliku (ani multipart, ani CSV/XLSX): przeglądarka parsuje plik (import/core.js) i wysyła
//     znormalizowane wiersze w JSON `{ version: 1, schoolYearId, columns, rows }`. Typ treści sprawdzany wzorcem
//     `^application/json` na CAŁYM nagłówku — inny typ → 415 `unsupported_media_type` (nie `invalid_content_type`
//     jak w innych modułach); limit ciała 1 MiB (także deklarowany `Content-Length`) → 413 `request_too_large`; najwyżej
//     5000 wierszy → 413 `too_many_rows`; komórka: tekst do 1000 znaków, liczba albo null (400 `invalid_cell`);
//   * admin i zarząd z MFA, przydział BEZ klasy obejmujący rok importu (rok spoza przydziału → 403 `forbidden`, po
//     odczycie ciała); poza APP_ENV development/test/staging import wymaga `IMPORT_ENABLED=true` (403 `import_disabled`);
//   * zapis wymaga nagłówka `Idempotency-Key` (wzorzec trasy `^[A-Za-z0-9_-]{8,128}$`, 400 `idempotency_key_required`),
//     `fingerprint` i `planDigest` z podglądu (400 `preview_required`), opublikowanej informacji o przetwarzaniu danych
//     (409 `privacy_notice_missing`, D-06) i planu bez konfliktów (422 `import_has_conflicts`, chyba że
//     `options.skipConflicts`). Ponowienie tym samym kluczem (albo te same dane bez nowych zapisów) → 200 z polem
//     `replayed: true` w treści, BEZ nagłówka `Idempotency-Replayed`; ten sam klucz z innymi danymi → 409
//     `idempotency_key_reused`;
//   * odpowiedzi nie zawierają imion, nazwisk ani adresów — tylko numery wierszy, komunikaty, liczniki i identyfikatory
//     ze źródła (`missingFromFile.refs`). Zapis w zamkniętym roku odrzuca trigger zamrożenia (`enrollments`), a router
//     tłumaczy go na 409 `school_year_closed`.
import { mergeErrors, ref, requestObject, strictObject } from './common.js';

export const name = 'import';

const STRING = { type: 'string' };
const COUNT = ref('Count');
const arrayOf = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const IMPORT_COLUMNS = ['studentId', 'firstName', 'lastName', 'className', 'householdId', 'guardian1', 'email1', 'guardian2', 'email2'];
const ROW_NUMBER = { type: 'integer', minimum: 1, description: 'Numer wiersza w pliku źródłowym (z `rowNumbers`, inaczej pozycja + 1).' };
const COUNT_NAMES = [
  'rowsTotal', 'rowsAdded', 'rowsUpdated', 'rowsUnchanged', 'rowsConflict', 'rowsSkipped',
  'householdsCreated', 'guardiansCreated', 'studentsCreated', 'enrollmentsCreated', 'linksCreated',
];
const CELL = {
  anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'number' }, { type: 'null' }],
  description: 'Tekst do 1000 znaków, liczba skończona albo null (inaczej 400 `invalid_cell`).',
};

const PAYLOAD = {
  version: { const: 1, description: 'Wersja formatu (inna → 400 `unsupported_version`).' },
  schoolYearId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Rok importu (400 `invalid_school_year`; nieznany → 422 `unknown_school_year`).' },
  columns: { const: IMPORT_COLUMNS, description: 'Dokładnie te kolumny w tej kolejności (400 `invalid_columns`).' },
  rows: {
    type: 'array', minItems: 1, maxItems: 5000,
    items: { type: 'array', minItems: IMPORT_COLUMNS.length, maxItems: IMPORT_COLUMNS.length, items: CELL },
    description: 'Wiersze danych (pusta lista albo wiersz o innej długości → 400 `invalid_rows`; ponad 5000 → 413 `too_many_rows`).',
  },
  rowNumbers: {
    type: 'array', items: { type: 'integer', minimum: 1, maximum: 1000000 },
    description: 'Numery wierszy w pliku, po jednym na wiersz (400 `invalid_row_numbers`).',
  },
  options: requestObject({
    allowNewHouseholds: { type: 'boolean', description: 'Wiersz bez ID rodziny tworzy osobną rodzinę (domyślnie false — konflikt).' },
    skipConflicts: { type: 'boolean', description: 'Zapis z pominięciem wierszy w konflikcie i błędnych (domyślnie false).' },
  }, [], { description: 'Inny typ → 400 `invalid_options`.' }),
};

export const components = {
  ImportCounts: strictObject(Object.fromEntries(COUNT_NAMES.map((key) => [key, COUNT])), [], {
    description: 'Liczniki planu (wierszy wg akcji i rekordów do utworzenia).',
  }),
  ImportPlanRow: {
    oneOf: [
      strictObject({
        row: ROW_NUMBER,
        action: { type: 'string', enum: ['add', 'update', 'unchanged'] },
        changes: arrayOf({ type: 'string', enum: ['household', 'student', 'enrollment', 'guardian', 'link'] }, 'Rekordy, które zapis utworzy.'),
      }),
      strictObject({
        row: ROW_NUMBER,
        action: { type: 'string', enum: ['conflict', 'skipped'] },
        messages: arrayOf(STRING, 'Powody konfliktu albo błędy walidacji wiersza (bez danych osobowych).'),
      }),
    ],
    description: 'Wynik planu dla wiersza: dopasowanie wyłącznie po identyfikatorach ze źródła, nigdy po nazwisku ani adresie.',
  },
  ImportRowMessage: strictObject({ row: ROW_NUMBER, message: STRING }),
  ImportPreview: strictObject({
    schoolYearId: ref('EntityId'),
    fingerprint: { ...ref('Sha256Hex'), description: 'Skrót znormalizowanych wierszy (do zapisu i rozpoznania ponowienia).' },
    planDigest: { ...ref('Sha256Hex'), description: 'Skrót planu; zmiana danych w bazie od podglądu → 409 `preview_stale` przy zapisie.' },
    counts: ref('ImportCounts'),
    commitAllowed: { type: 'boolean', description: 'true: brak wierszy w konflikcie i pominiętych (zapis bez `skipConflicts`).' },
    rows: arrayOf(ref('ImportPlanRow')),
    warnings: arrayOf(ref('ImportRowMessage'), 'Ostrzeżenia walidacji i planu (np. ten sam adres w innej rodzinie), wg numeru wiersza.'),
    missingFromFile: strictObject({
      count: COUNT,
      refs: arrayOf(STRING, 'Identyfikatory ze źródła uczniów zapisanych w roku, których nie ma w pliku (bez imion i nazwisk).'),
    }, [], { description: 'Informacyjnie (#98): nie wpływa na plan ani na `commitAllowed`.' }),
    written: { const: false },
  }, [], { description: 'Podgląd planu — nic nie jest zapisywane.' }),
  ImportBatch: strictObject({
    batchId: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    replayed: { type: 'boolean', description: 'true: zapisany wcześniej wynik (ten sam klucz albo te same dane bez nowych zapisów).' },
    counts: ref('ImportCounts'),
  }),

  ImportPreviewRequest: requestObject(PAYLOAD, ['version', 'schoolYearId', 'columns', 'rows'], {
    description: 'Znormalizowane wiersze z przeglądarki (plik nie trafia na serwer).',
  }),
  ImportCommitRequest: requestObject({
    ...PAYLOAD,
    fingerprint: { ...ref('Sha256Hex'), description: '`fingerprint` z podglądu (brak → 400 `preview_required`; inny niż dane → 409 `fingerprint_mismatch`).' },
    planDigest: { ...ref('Sha256Hex'), description: '`planDigest` z podglądu (brak → 400 `preview_required`; zmiana od podglądu → 409 `preview_stale`).' },
  }, ['version', 'schoolYearId', 'columns', 'rows', 'fingerprint', 'planDigest']),
};

// ---------- kody błędów ----------

// Rola z MFA (requireAccess) i bramka MFA routera; `import_disabled` poza środowiskami testowymi bez IMPORT_ENABLED=true.
const GATE = { 403: ['forbidden', 'import_disabled', 'mfa_enrollment_required', 'mfa_required'] };
const PAYLOAD_ERRORS = {
  400: [
    'invalid_cell', 'invalid_columns', 'invalid_json', 'invalid_options', 'invalid_payload', 'invalid_row_numbers', 'invalid_rows',
    'invalid_school_year', 'unsupported_version',
  ],
  403: ['invalid_origin'],
  413: ['request_too_large', 'too_many_rows'],
  415: ['unsupported_media_type'],
  422: ['invalid_import', 'no_classes_in_school_year', 'unknown_school_year'],
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/import/options': {
    responses: {
      200: {
        description: 'Lata szkolne w zakresie przydziału (od najnowszego) z nazwami klas — do mapowania kolumny „Klasa”.',
        schema: strictObject({
          schoolYears: arrayOf(strictObject({ id: ref('EntityId'), label: STRING, classes: arrayOf(STRING, 'Nazwy klas roku (alfabetycznie).') })),
        }),
      },
    },
    errors: GATE,
  },
  'POST /api/import/preview': {
    body: ref('ImportPreviewRequest'),
    responses: { 200: { description: 'Plan importu bez zapisu (`written: false`).', schema: ref('ImportPreview') } },
    errors: mergeErrors(GATE, PAYLOAD_ERRORS),
  },
  'POST /api/import/commit': {
    body: ref('ImportCommitRequest'),
    idempotencyKey: true,
    responses: {
      201: {
        description: 'Zapis planu w jednej transakcji (wszystko albo nic), partia z odwołaniem do opublikowanej informacji o '
          + 'przetwarzaniu danych; zdarzenie `import.committed` z licznikami (bez danych osobowych).',
        schema: { allOf: [ref('ImportBatch'), { properties: { replayed: { const: false } } }] },
      },
      200: {
        description: 'Ponowienie: ten sam klucz (podwójne kliknięcie) albo te same dane bez nowych zapisów — zapisany wynik, `replayed: true`.',
        schema: { allOf: [ref('ImportBatch'), { properties: { replayed: { const: true } } }] },
      },
    },
    errors: mergeErrors(GATE, PAYLOAD_ERRORS, {
      400: ['idempotency_key_required', 'preview_required'],
      409: ['fingerprint_mismatch', 'idempotency_key_reused', 'preview_stale', 'privacy_notice_missing', 'school_year_closed'],
      422: ['import_has_conflicts'],
    }),
  },
};
