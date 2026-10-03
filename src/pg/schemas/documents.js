// Schematy OpenAPI dla modułu `documents` (src/pg/routes/documents.js; #39, #76, #82, #89, #137, #167, #168, #185),
// #160 etap 8: prywatne dokumenty Rady i dowody finansowe — przesłanie pliku (surowe bajty), lista z kursorem,
// metadane z historią opisu, pobranie i podgląd treści po autoryzacji, nowa wersja opisu (tytuł, kategoria, data),
// zastąpienie i unieważnienie oraz odczyt Komisji Rewizyjnej za flagą `AUDIT_LEDGER_READ` (D-09). Pisane ręcznie na
// podstawie maperów `toDocument`, `toDescription`, `toStatusEvent` i testów tests/pg-documents*.test.js,
// tests/documents-*.test.js i tests/pg-audit-ledger-read.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * macierz tras (tests/helpers/route-matrix.js) rozdziela trasy dokumentu na cztery rodzaje (`financial`, `board`,
//     `class`, `council_shared`) z osobnym parametrem ścieżki (`{financialDocumentId}` …), choć serwer ma JEDNĄ trasę
//     `/api/documents/{id}` i rodzaj odczytuje z bazy. Schemat ma więc po wpisie na rodzaj (te same kształty), a odczyt
//     metadanych dodatkowo przypina `document.kind` do rodzaju ścieżki;
//   * przesłanie: ciało to surowe bajty pliku (`application/pdf`, `image/png`, `image/jpeg`; typ ustalany po sygnaturze
//     i zgodny z nagłówkiem), nie JSON ani multipart; rodzaj, rok, klasa i powiązanie są w zapytaniu;
//   * zapisy wymagają `Idempotency-Key` (8-128 znaków; brak → 400 `idempotency_key_required`, nie
//     `invalid_idempotency_key`), ale NIE wysyłają nagłówka `Idempotency-Replayed`: zapis daje 201, a ponowienie
//     (ten sam klucz i treść albo ta sama zmiana stanu innym kluczem) — 200 z polem `replayed: true` w treści;
//   * brak dostępu, brak MFA dla `financial` i nieznany identyfikator dają to samo 404 `not_found` (brak wyroczni
//     istnienia); 403 przy odczycie dokumentu to wyłącznie bramka MFA routera (zarząd/skarbnik bez czynnika);
//   * treść pliku wydaje serwer (proxy z prywatnego bucketu) dopiero po autoryzacji każdego żądania; nie ma adresu
//     z tokenem ani podpisanego linku. Odpowiedź binarna ma typ pliku z bazy (bez schematu JSON);
//   * Komisja Rewizyjna (`audit`, flaga `AUDIT_LEDGER_READ`, MFA) czyta wyłącznie dowody `financial` z kategorii bez
//     danych płatników; wolny tekst opisu dostaje jako `null`, zapisu nie ma żadnego.
import {
  PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, requestObject, strictObject,
} from './common.js';

export const name = 'documents';

const STRING = { type: 'string' };
const KINDS = ['financial', 'board', 'class', 'council_shared'];
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
// Lista zamknięta DOCUMENT_CATEGORIES w src/pg/routes/documents.js (założenie do zatwierdzenia, #76).
const CATEGORIES = [
  'faktura', 'potwierdzenie_przelewu', 'wyciag', 'protokol', 'uchwala', 'umowa', 'regulamin', 'sprawozdanie_rewizyjne', 'inne',
];
const BINARY = { type: 'string', format: 'binary' };
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji); wewnętrzny, nie trafia do dziennika. Bramka danych osobowych (#152); '
    + 'inna długość → 400 `invalid_reason`.',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};

export const components = {
  DocumentKind: {
    type: 'string', enum: KINDS,
    description: '`financial` — dowód finansowy (MFA), `board` — dokument zarządu, `class` — materiał jednej klasy (wymaga `classId`), '
      + '`council_shared` — dokument Rady dla przedstawicieli wszystkich klas roku (#167). Macierz dostępu: docs/DOCUMENTS.md (D-08/D-09).',
  },
  DocumentCategory: {
    type: 'string', enum: CATEGORIES,
    description: 'Kategoria z zamkniętej listy (założenie do zatwierdzenia przez zarząd i skarbnika, #76), niezależna od rodzaju.',
  },
  DocumentStatus: {
    type: 'string', enum: ['active', 'superseded', 'voided'],
    description: 'Stan dokumentu (#82): `active` bez zdarzenia stanu; zastąpienie i unieważnienie są ostateczne, plik zostaje w archiwum.',
  },
  Document: strictObject({
    id: ref('EntityId'),
    kind: ref('DocumentKind'),
    schoolYearId: { ...ref('EntityId'), description: 'Rok dokumentu (dokument bez roku jest niedostępny przez API).' },
    classId: nullable({ ...ref('EntityId'), description: 'Klasa dokumentu `class`; null dla pozostałych rodzajów.' }),
    mimeType: { type: 'string', enum: MIME_TYPES, description: 'Typ ustalony po sygnaturze pliku przy przesłaniu.' },
    byteSize: { type: 'integer', minimum: 1, description: 'Rozmiar pliku w bajtach.' },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'SHA-256 pliku (sprawdzany przy każdym odczycie treści).' },
    linkedEntityType: nullable({
      type: 'string', enum: ['ledger_entry', 'payment_entry'],
      description: 'Powiązanie dowodu `financial` z wpisem księgi albo wpłatą tego samego roku.',
    }),
    linkedEntityId: nullable(ref('EntityId')),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    status: ref('DocumentStatus'),
    replacementDocumentId: nullable({ ...ref('EntityId'), description: '„Zastąpiony przez” (dla `superseded`).' }),
    title: nullable({ type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł najnowszej wersji opisu; null = „Bez tytułu”.' }),
    category: nullable(ref('DocumentCategory')),
    documentDate: nullable(ref('IsoDate')),
    validationVersion: nullable({
      type: 'integer', minimum: 1,
      description: 'Wersja reguł kontroli struktury przy przesłaniu (0161); null = plik sprzed zapisu wersji.',
    }),
    validationCurrent: { type: 'boolean', description: 'true = sprawdzony bieżącą wersją reguł (`validation=outdated` pokazuje pozostałe).' },
  }, [], { description: 'Metadane dokumentu (wiersz niezmienny) ze stanem i najnowszą wersją opisu. Bez klucza obiektu i nazwy pliku.' }),
  DocumentDescription: strictObject({
    documentId: ref('EntityId'),
    revisionNo: { type: 'integer', minimum: 1, description: 'Numer wersji opisu (dopisywana, poprzednie zostają w historii).' },
    title: { type: 'string', minLength: 3, maxLength: 200 },
    category: ref('DocumentCategory'),
    documentDate: nullable(ref('IsoDate')),
    description: nullable({
      type: 'string', minLength: 1, maxLength: 1000,
      description: 'Wolny tekst opisu; null także w widoku Komisji Rewizyjnej (D-09, opis nie jest jej wydawany).',
    }),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Wersja opisu dokumentu (#76).' }),
  DocumentStatusEvent: strictObject({
    id: ref('EntityId'),
    documentId: ref('EntityId'),
    action: { type: 'string', enum: ['superseded', 'voided'] },
    replacementDocumentId: nullable({ ...ref('EntityId'), description: 'Dokument zastępujący (dla `superseded`).' }),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Zdarzenie stanu (#82), bez powodu (powód jest wewnętrzny).' }),
  DocumentMetadata: strictObject({
    document: ref('Document'),
    supersedes: nullable({ ...ref('EntityId'), description: '„Zastępuje”: dokument, którego zastępstwem jest ten.' }),
    descriptionHistory: {
      type: 'array', items: ref('DocumentDescription'),
      description: 'Wszystkie wersje opisu, najnowsza pierwsza.',
    },
  }),
  DocumentList: strictObject({
    documents: { type: 'array', items: ref('Document'), description: 'Strona dokumentów dostępnych użytkownikowi.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Zastosowana wielkość strony.' },
    offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Przestarzały `offset` (0 przy kursorze).' },
    nextCursor: nullable({
      type: 'string',
      description: 'Kursor następnej strony (tylko `sort=createdAt`); null na ostatniej stronie i zawsze przy `sort=documentDate`.',
    }),
    truncated: { type: 'boolean', description: 'true, gdy są kolejne wiersze (przy `sort=documentDate` stronicuje `offset`).' },
  }),
  DocumentDescriptionRequest: requestObject({
    title: { type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł (3-200 znaków po przycięciu); bez imion i nazwisk (bramka #152).' },
    category: ref('DocumentCategory'),
    documentDate: nullable({ ...ref('IsoDate'), description: 'Data dokumentu; pusta wartość = brak daty.' }),
    description: nullable({ type: 'string', minLength: 1, maxLength: 1000, description: 'Opis (do 1000 znaków po przycięciu).' }),
    confirmPersonalData: CONFIRM,
  }, ['title', 'category'], { description: 'Nowa wersja opisu (dopisywana; poprzednia zostaje w historii).' }),
  DocumentSupersedeRequest: requestObject({
    replacementDocumentId: {
      type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      description: 'Aktywny dokument tego samego rodzaju, roku i klasy (inaczej 400 `invalid_replacement_document` '
        + 'albo 409 `document_status_replacement_not_active`).',
    },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['replacementDocumentId', 'reason']),
  DocumentVoidRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason']),
};

// ---------- kody błędów ----------

// Bramka MFA routera: zarząd i skarbnik bez potwierdzonego MFA (także przy odczycie dokumentu, zanim trasa zwróci 404).
const GATE = { 403: ['mfa_enrollment_required', 'mfa_required'] };
const NOT_FOUND = { 404: ['not_found'] };
const KEY_REQUIRED = { 400: ['idempotency_key_required'] };
// Zapisy JSON (opis, zastąpienie, unieważnienie): zły typ treści to 400 `invalid_content_type` (nie 415, jak w innych modułach).
const JSON_WRITE = mergeErrors(GATE, NOT_FOUND, KEY_REQUIRED, {
  400: ['invalid_content_type', 'invalid_json'],
  403: ['invalid_origin'],
  409: ['idempotency_conflict'],
  413: ['request_too_large'],
}, PII_ERRORS);
const STATUS_WRITE = mergeErrors(JSON_WRITE, { 400: ['invalid_reason'], 409: ['document_status_conflict'] });

const KIND_LABEL = {
  financial: 'dowodu finansowego (`financial`, MFA)',
  board: 'dokumentu zarządu (`board`)',
  class: 'materiału klasy (`class`)',
  council_shared: 'dokumentu Rady dla przedstawicieli (`council_shared`)',
};

// Odpowiedź z polem `replayed` (bez nagłówka Idempotency-Replayed).
const replayedBody = (properties) => strictObject({
  ...properties,
  replayed: { const: true, description: 'Ponowienie: bez nowego zapisu, zwraca zapisany wcześniej obiekt.' },
});
const written = (createdText, replayText, properties) => ({
  201: { description: `${createdText} Bez nagłówka \`Idempotency-Replayed\`.`, schema: strictObject(properties) },
  200: { description: `${replayText} Pole \`replayed: true\` w treści, bez nagłówka.`, schema: replayedBody(properties) },
});

function documentRoutes(kind) {
  const base = `/api/documents/{${kind}DocumentId}`;
  const label = KIND_LABEL[kind];
  return {
    [`GET ${base}`]: {
      responses: {
        200: {
          description: `Metadane ${label}: stan, „zastąpiony przez”/„zastępuje” i pełna historia opisu. `
            + (kind === 'financial' ? 'Komisja Rewizyjna (flaga `AUDIT_LEDGER_READ`) dostaje `description: null` w historii (ślad `document.audit_read`).' : ''),
          schema: { allOf: [ref('DocumentMetadata'), { properties: { document: { properties: { kind: { const: kind } } } } }] },
        },
      },
      errors: mergeErrors(GATE, NOT_FOUND),
    },
    [`GET ${base}/content`]: {
      query: {
        disposition: {
          schema: { type: 'string', enum: ['attachment', 'inline'] },
          description: '`attachment` (domyślnie) — pobranie; `inline` — podgląd PNG/JPEG w panelu (PDF → 400 `pdf_inline_not_allowed`).',
        },
        purpose: {
          schema: { type: 'string', enum: ['preview'] },
          description: '`preview` — bajty do podglądu PDF.js (załącznik, ponowna kontrola struktury, `document.viewed`).',
        },
      },
      responses: {
        200: formatsResponse(
          `Treść ${label} wydana przez serwer po autoryzacji tego żądania (bez podpisanego adresu). Typ z bazy; `
            + 'nagłówki `Content-Disposition` (`dokument-<id>.<ext>`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, '
            + 'CSP `sandbox`. Rozmiar i SHA-256 obiektu są porównywane z bazą (niezgodność → 503).',
          Object.fromEntries(MIME_TYPES.map((type) => [type, BINARY])),
        ),
      },
      errors: mergeErrors(GATE, NOT_FOUND, {
        400: ['document_preview_unsupported', 'invalid_disposition', 'pdf_inline_not_allowed'],
        409: ['document_content_missing', 'document_preview_blocked'],
        503: ['service_unavailable', 'storage_unavailable'],
      }),
    },
    [`POST ${base}/description`]: {
      idempotencyKey: true,
      body: ref('DocumentDescriptionRequest'),
      responses: written(
        `Nowa wersja opisu ${label} (numer o 1 wyższy).`,
        'Ten sam klucz i ta sama treść: zapisana wcześniej wersja.',
        { description: ref('DocumentDescription') },
      ),
      errors: mergeErrors(JSON_WRITE, {
        400: ['invalid_category', 'invalid_description', 'invalid_document_date', 'invalid_request', 'invalid_title'],
        409: ['school_year_closed'],
      }),
    },
    [`POST ${base}/supersede`]: {
      idempotencyKey: true,
      body: ref('DocumentSupersedeRequest'),
      responses: written(
        `Zastąpienie ${label} innym dokumentem (zdarzenie stanu; plik i wpis zostają).`,
        'Ten sam klucz albo to samo zastąpienie innym kluczem: zapisane wcześniej zdarzenie.',
        { statusEvent: ref('DocumentStatusEvent') },
      ),
      errors: mergeErrors(STATUS_WRITE, {
        400: ['invalid_replacement_document'],
        // Zamknięty rok blokuje wyłącznie zastąpienie (school_year_assert_open); unieważnienie zostaje możliwe.
        409: ['document_status_replacement_not_active', 'school_year_closed'],
      }),
    },
    [`POST ${base}/void`]: {
      idempotencyKey: true,
      body: ref('DocumentVoidRequest'),
      responses: written(
        `Unieważnienie ${label} (zdarzenie stanu; możliwe także w zamkniętym roku, plik zostaje do pobrania).`,
        'Ten sam klucz albo kolejne unieważnienie już unieważnionego dokumentu: zapisane wcześniej zdarzenie.',
        { statusEvent: ref('DocumentStatusEvent') },
      ),
      errors: STATUS_WRITE,
    },
  };
}

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/documents': {
    query: {
      schoolYearId: { required: true, schema: ref('Id') },
      kind: { schema: ref('DocumentKind') },
      classId: { schema: ref('Id') },
      status: { schema: { type: 'string', enum: ['active', 'all'], default: 'active' }, description: '`all` pokazuje też zastąpione i unieważnione.' },
      category: { schema: ref('DocumentCategory') },
      q: { schema: { type: 'string', maxLength: 200 }, description: 'Fragment tytułu albo opisu (ILIKE, znaki wzorca uciekane).' },
      from: { schema: ref('IsoDate'), description: 'Data dokumentu od (najnowsza wersja opisu; dokument bez daty odpada).' },
      to: { schema: ref('IsoDate'), description: 'Data dokumentu do; `from` > `to` → 400 `invalid_request`.' },
      sort: { schema: { type: 'string', enum: ['createdAt', 'documentDate'], default: 'createdAt' } },
      validation: { schema: { type: 'string', enum: ['outdated'] }, description: 'Tylko sprawdzone starszą wersją reguł albo bez wersji (0161).' },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      cursor: { schema: STRING, description: '`nextCursor` z poprzedniej odpowiedzi z tymi samymi filtrami (tylko `sort=createdAt`).' },
      offset: { schema: { type: 'integer', minimum: 0, maximum: 10000 }, description: 'Przestarzały; działa tylko bez `cursor`.' },
    },
    responses: {
      200: {
        description: 'Lista metadanych dostępnych użytkownikowi (filtry przed LIMIT, autoryzacja każdego wiersza). Komisja '
          + 'Rewizyjna za flagą `AUDIT_LEDGER_READ` widzi tylko dowody `financial` z kategorii bez danych płatników.',
        schema: ref('DocumentList'),
      },
    },
    errors: mergeErrors(GATE, {
      400: [
        'invalid_category', 'invalid_class', 'invalid_cursor', 'invalid_document_date', 'invalid_kind', 'invalid_limit',
        'invalid_request', 'invalid_school_year', 'invalid_status',
      ],
      403: ['forbidden'],
    }),
  },
  'POST /api/documents': {
    idempotencyKey: true,
    bodyDescription: 'Surowe bajty pliku (nie JSON ani multipart). Nagłówek `Content-Type` musi zgadzać się z sygnaturą pliku '
      + '(`image/jpg` = `image/jpeg`); po sygnaturze serwer sprawdza strukturę (aktywna treść PDF, uszkodzony plik → 415). '
      + 'Limit `DOCUMENT_MAX_BYTES` (domyślnie 10 MiB, najwyżej 25 MiB).',
    bodyContent: Object.fromEntries(MIME_TYPES.map((type) => [type, BINARY])),
    query: {
      kind: { required: true, schema: ref('DocumentKind') },
      schoolYearId: { required: true, schema: ref('Id') },
      classId: { schema: ref('Id'), description: 'Wymagane wyłącznie dla `class` (inaczej 400 `invalid_class`).' },
      linkedEntityType: {
        schema: { type: 'string', enum: ['ledger_entry', 'payment_entry'] },
        description: 'Powiązanie dowodu `financial` z wpisem księgi albo wpłatą tego samego roku (razem z `linkedEntityId`).',
      },
      linkedEntityId: { schema: ref('Id') },
    },
    responses: written(
      'Dokument zapisany: obiekt w prywatnym buckecie pod losowym kluczem, metadane w bazie, `document.uploaded` w dzienniku.',
      'Ten sam klucz, ten sam plik i te same parametry: zapisany wcześniej dokument (bez drugiego obiektu).',
      { document: ref('Document') },
    ),
    errors: mergeErrors(GATE, KEY_REQUIRED, {
      400: ['empty_document', 'invalid_class', 'invalid_kind', 'invalid_link', 'invalid_school_year'],
      403: ['forbidden', 'invalid_origin'],
      409: ['document_content_missing', 'idempotency_conflict', 'school_year_closed'],
      413: ['document_too_large', 'request_too_large'],
      415: ['document_active_content', 'document_malformed', 'unsupported_media_type'],
      503: ['storage_unavailable', 'upload_busy'],
    }),
  },
  ...Object.fromEntries(KINDS.flatMap((kind) => Object.entries(documentRoutes(kind)))),
};
