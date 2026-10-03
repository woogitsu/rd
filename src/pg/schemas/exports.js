// Schematy OpenAPI dla modułu `exports` (src/pg/routes/exports.js, src/pg/export.js; #9, #132, #133, #150, #195, #216),
// #160 etap 13: eksport roczny (paczka JSON z manifestem) i lista klasy (JSON, CSV, XLSX). Pisane ręcznie na podstawie
// `buildYearlyExport` i `buildClassRoster`; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * obie odpowiedzi są ZAŁĄCZNIKAMI (`Content-Disposition: attachment`, `Cache-Control: no-store`) z nagłówkami
//     `X-Export-Run-Id` i `X-Export-Manifest-Sha256`; każdy przebieg zapisuje `export_runs`, zdarzenie `export.created`
//     i wpis dziennika odczytu (bez treści);
//   * eksport roczny: admin i zarząd z przydziałem bez klasy w roku (zamknięty rok — także zarząd roku następnego, #195),
//     krok w górę MFA (403 `mfa_stale` po 15 min); skarbnik, Komisja Rewizyjna, dyrekcja, przedstawiciel → 403 `forbidden`
//     (trasa nie rozróżnia powodu MFA — `mfa_required`/`mfa_enrollment_required` daje bramka routera). Paczka zawiera
//     PEŁNE dane rodzin i finansów roku (tabele JSONL), więc schemat opisuje ją ogólnie: `files` (ścieżka → treść JSONL)
//     i `manifest` (tabele, kolumny, liczby wierszy, sumy kwot, skróty). Drugi równoczesny eksport roku → 409;
//   * lista klasy: przedstawiciel tej klasy, zarząd z przydziałem klasy i admin/zarząd szkolny roku klasy, z MFA (#161:
//     przy pasującej roli i klasie 403 `mfa_required`/`mfa_enrollment_required`). Tylko uczniowie i opiekunowie klasy:
//     e-mail opiekuna wyłącznie przy zgodzie (opiekuna i relacji), bez wpłat i identyfikatorów rodzin. Klasa innego roku
//     niż przydział → 403 jak brak przydziału;
//   * walidacja parametrów i ciała poprzedza sprawdzenie sesji (400 przed 401 — rozbieżność w docs/API.md).
import { CSV_CONTENT_TYPE, OCTET_XLSX, formatsResponse, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'exports';

const STRING = { type: 'string' };

export const components = {
  ExportManifestFile: strictObject({
    path: { type: 'string', pattern: '^[a-z0-9_]+\\.jsonl$', description: 'Ścieżka pliku w `files` (`<tabela>.jsonl`).' },
    table: STRING,
    columns: { type: 'array', items: STRING, description: 'Kolumny w kolejności alfabetycznej.' },
    rows: ref('Count'),
    sha256: { ...ref('Sha256Hex'), description: 'Skrót treści pliku JSONL.' },
    sums: {
      type: 'object', additionalProperties: { type: 'integer' },
      description: 'Sumy kolumn `*_cents` (eurocenty) do kontroli odtworzenia.',
    },
  }),
  ExportYearlyBundle: strictObject({
    files: {
      type: 'object', additionalProperties: STRING,
      description: 'Treść tabel: ścieżka `<tabela>.jsonl` → wiersze JSON (jeden na linię, klucze posortowane). Zawiera dane osobowe.',
    },
    format: { const: 'rd-yearly-export' },
    formatVersion: { const: 2 },
    manifest: strictObject({
      format: { const: 'rd-yearly-export' },
      formatVersion: { const: 2 },
      schoolYearId: ref('EntityId'),
      schema: strictObject({ migrations: nullable({ type: 'array', items: STRING, description: 'Zastosowane migracje bazy (nazwy plików).' }) }),
      files: { type: 'array', items: ref('ExportManifestFile') },
      totals: strictObject({
        payments: strictObject({ recordedNetCents: ref('SignedCents'), recordedCount: ref('Count') }),
        ledger: strictObject({
          openingBalanceCents: ref('SignedCents'), incomeCents: ref('SignedCents'), expenseCents: ref('SignedCents'), closingBalanceCents: ref('SignedCents'),
        }),
      }, ['payments', 'ledger']),
    }),
    manifestSha256: { ...ref('Sha256Hex'), description: 'Skrót kanonicznego JSON manifestu; ten sam co w nagłówku `X-Export-Manifest-Sha256`.' },
  }, [], { description: 'Paczka eksportu rocznego (docs/EXPORT.md): deterministyczna, weryfikowalna manifestem (`npm run db:verify-export`).' }),
  ClassRosterGuardian: strictObject({
    id: ref('EntityId'),
    firstName: STRING,
    lastName: STRING,
    email: nullable({ type: 'string', description: 'Tylko przy zgodzie na kontakt opiekuna i relacji z dzieckiem; inaczej null.' }),
    primaryContact: { type: 'boolean' },
  }),
  ClassRoster: strictObject({
    class: strictObject({ id: ref('EntityId'), name: STRING, schoolYearId: ref('EntityId') }),
    format: { const: 'rd-class-roster' },
    formatVersion: { const: 1 },
    sha256: { ...ref('Sha256Hex'), description: 'Skrót listy (bez tego pola); ten sam co w nagłówku `X-Export-Manifest-Sha256`.' },
    students: {
      type: 'array',
      description: 'Bieżący skład klasy (bez uczniów po odejściu), z opiekunami w aktywnych relacjach.',
      items: strictObject({
        id: ref('EntityId'), firstName: STRING, lastName: STRING, guardians: { type: 'array', items: ref('ClassRosterGuardian') },
      }),
    },
  }, [], { description: 'Lista klasy (#9): uczniowie i opiekunowie, bez wpłat i identyfikatorów rodzin. Zawiera dane osobowe.' }),
  YearlyExportRequest: requestObject({ schoolYearId: ref('Id') }, ['schoolYearId']),
};

const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'POST /api/exports': {
    body: ref('YearlyExportRequest'),
    responses: {
      200: {
        description: 'Paczka eksportu rocznego jako załącznik `rd-eksport-<rok>-v2.json` (nagłówki `X-Export-Run-Id`, `X-Export-Manifest-Sha256`).',
        schema: ref('ExportYearlyBundle'),
      },
    },
    errors: mergeErrors(GATE, {
      400: ['invalid_json', 'invalid_school_year'],
      403: ['invalid_origin', 'mfa_stale'],
      404: ['school_year_not_found'],
      409: ['export_in_progress'],
      413: ['request_too_large'],
      415: ['invalid_content_type'],
    }),
  },
  'GET /api/exports/class-roster': {
    query: {
      classId: { required: true, schema: ref('Id') },
      format: { schema: { type: 'string', enum: ['json', 'csv', 'xlsx'], default: 'json' }, description: 'Ten sam zakres i te same dane w każdym formacie (#132).' },
    },
    responses: {
      200: formatsResponse('Lista klasy jako załącznik: JSON (domyślnie, z sumą SHA-256), CSV UTF-8 z BOM albo arkusz XLSX (sortowanie polskie, stopka o danych osobowych).', {
        'application/json': ref('ClassRoster'),
        [CSV_CONTENT_TYPE]: { type: 'string' },
        [OCTET_XLSX]: { type: 'string', format: 'binary' },
      }),
    },
    errors: mergeErrors(GATE, { 400: ['invalid_class', 'invalid_format'], 404: ['class_not_found'] }),
  },
};
