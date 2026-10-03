// Schematy OpenAPI dla modułu `news` (src/pg/routes/news.js → src/pg/news.js; #14, #96, #106, #116, #124, #150,
// #152, #159, #185), #160 etap 10: aktualności (szkic → zgłoszenie → zatwierdzenie → publikacja, wycofanie), historia
// wersji, rejestr zdjęć z prawami i odwołaniami do zgód na wizerunek (weryfikacja przez drugą osobę, cofnięcie praw,
// wycofanie jednej zgody), plik zdjęcia (warianty `web`/`thumb`) oraz widok publiczny: lista z kursorem, stały adres
// wpisu, lata z treściami publicznymi i publiczny odczyt pliku zdjęcia. Pisane ręcznie na podstawie maperów
// `internalPost`, `internalPhoto`, `publicPost`, `internalPhotoFile` w src/pg/news.js, widoku `public_news`
// (postgres/migrations/0083_news_photo_consent_scope.sql) i testów tests/pg-news*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * `Idempotency-Key` (wymagany) mają: szkic wpisu, rejestracja zdjęcia i przesłanie pliku zdjęcia — 201 z
//     `Idempotency-Replayed: false`, ponowienie 200 z `true`. Odwołanie do zgody (`…/consents`) nie ma klucza ani
//     nagłówka: 201 `{ replayed: false }`, ten sam wpis ponownie 200 `{ replayed: true }`. `PATCH`, kroki przebiegu,
//     weryfikacja, cofnięcie praw i wycofanie zgody odpowiadają zawsze 200 bez nagłówka, z polem `replayed`;
//   * `PATCH` i kroki przebiegu wymagają `revision` (400 `invalid_revision`, 409 `revision_conflict`);
//   * wpis spoza zakresu (przedstawiciel innej klasy, Komisja Rewizyjna, dyrekcja, skarbnik, zarząd z przydziałem
//     klasy) → 404 `post_not_found` jak nieznany (SR-07); 403 `forbidden` — lista roku, szkic poza zakresem i krok bez
//     prawa przy widocznym wpisie. Rejestr zdjęć: wyłącznie admin i zarząd z przydziałem bez klasy, inni → 403;
//   * widok publiczny czyta wyłącznie widok `public_news` (opublikowana wersja niewycofanego wpisu): zdjęcie trafia do
//     `photos[]` tylko zweryfikowane, z każdą zgodą obejmującą `rada_website`, niewygasłą i niewycofaną (0083/0112);
//     szkic, wpis nieopublikowany, wycofany i nieznany dają identyczne 404 `post_not_found`;
//   * tekst alternatywny (#124): przy rejestracji `altText` albo `decorative: true` (inaczej 422 `alt_text_required`);
//     na stronie publicznej zdjęcie dekoracyjne ma `altText: ""`;
//   * bramka danych osobowych (#152, src/pg/pii-gate.js): tytuł i treść wpisu (ze znanymi imionami i nazwiskami roku),
//     powód wycofania, pola tekstowe zdjęcia i powód cofnięcia praw — 422 `personal_data_forbidden` (bez obejścia)
//     albo `possible_personal_data` (ponowienie z `confirmPersonalData: true`), odpowiedź z `categories`.
import {
  PII_ERRORS, fileResponse, mergeErrors, nullable, ref, replayed, requestObject, strictObject,
} from './common.js';

export const name = 'news';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const BINARY = { type: 'string', format: 'binary' };
const PHOTO_SOURCES = ['own_work', 'school_provided', 'parent_provided', 'licensed_third_party', 'public_website_copy'];
const CONSENT_SCOPES = ['rada_website', 'print', 'social_media'];
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const nullableString = (description) => nullable(description ? { type: 'string', description } : STRING);
const nullableRevision = (description) => nullable({ type: 'integer', minimum: 1, ...(description ? { description } : {}) });

const TITLE = { type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł (3-200 znaków po przycięciu, jedna linia; bramka danych osobowych, #152).' };
const BODY = {
  type: 'string', minLength: 1, maxLength: 20000,
  description: 'Treść (1-20000 znaków; tekst, nie HTML — interfejs wstawia ją jako tekst; bramka danych osobowych, #152).',
};
const PHOTO_IDS = {
  type: 'array', items: ref('Id'), maxItems: 20,
  description: 'Zdjęcia wpisu w kolejności wyświetlania (do 20, bez powtórzeń → 400 `duplicate_photo`). Tylko admin i zarząd z '
    + 'przydziałem bez klasy (przedstawiciel → 403 `photos_require_school_wide_role`); nieznane zdjęcie → 422 `photo_not_found`, '
    + 'cofnięte → 409 `photo_revoked`. Zatwierdzenie i publikacja wymagają zdjęć zweryfikowanych.',
};
const REVISION = {
  type: 'integer', minimum: 1,
  description: 'Numer wersji widziany przez użytkownika; brak → 400 `invalid_revision`, niezgodny → 409 `revision_conflict`.',
};
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji); wewnętrzny, nie trafia na stronę publiczną ani do dziennika. '
    + 'Bramka danych osobowych (#152); inna długość → 400 `invalid_reason`.',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const CONSENT_SCOPE = {
  type: 'array', items: { type: 'string', enum: CONSENT_SCOPES }, minItems: 1, maxItems: 3,
  description: 'Zakres zgody (#106; bez powtórzeń). Pominięty → `["rada_website"]`. Zdjęcie trafia na stronę Rady tylko, gdy '
    + 'KAŻDA jego zgoda obejmuje `rada_website`.',
};
const VALID_UNTIL = nullable({ ...ref('IsoDate'), description: 'Ostatni dzień ważności zgody (Europe/Brussels); null — bez terminu.' });
const CONSENT_FIELDS = {
  subjectKind: { type: 'string', enum: ['child', 'adult'] },
  consentDocumentRef: {
    ...ref('Id'),
    description: 'Wyłącznie identyfikator dokumentu zgody (np. `consent-doc-0001`) — bez imion, nazwisk i klas osób na zdjęciu.',
  },
  scope: CONSENT_SCOPE,
  validUntil: VALID_UNTIL,
};

const PHOTO_PROPERTIES = {
  id: ref('EntityId'),
  documentId: { ...ref('EntityId'), description: 'Prywatny dokument źródłowy zdjęcia (zarządu); nie jest plikiem galerii.' },
  author: STRING,
  source: { type: 'string', enum: PHOTO_SOURCES },
  sourceDetail: nullableString('Opis źródła (np. przybliżona data zdjęcia archiwalnego).'),
  takenOn: ref('IsoDate'),
  licenseText: { type: 'string', description: 'Tekst licencji/zgody na publikację (publiczny podpis zdjęcia).' },
  explicitLicenseGranted: BOOLEAN,
  licenseDocumentRef: nullableString('Odwołanie do dokumentu licencji (wymagane dla `public_website_copy`).'),
  rightsNote: nullableString('Wewnętrzna notatka o prawach (niepubliczna).'),
  altText: nullableString('Tekst alternatywny; null — zdjęcie dekoracyjne albo sprzed migracji 0071 (#124).'),
  decorative: { type: 'boolean', description: 'true: zdjęcie czysto dekoracyjne (na stronie publicznej `alt=""`).' },
  depictsChildren: BOOLEAN,
  identifiableChildren: { type: 'integer', minimum: 0, maximum: 100 },
  identifiableAdults: { type: 'integer', minimum: 0, maximum: 100 },
  uploadedBy: ref('EntityId'),
  uploadedAt: ref('IsoDateTime'),
  rightsStatus: {
    type: 'string', enum: ['pending', 'verified', 'revoked'],
    description: '`pending` → `verified` (inna osoba niż rejestrująca) → `revoked` (stan końcowy; zdjęcie znika z widoku publicznego).',
  },
  rightsVerifiedBy: nullableId(),
  rightsVerifiedAt: nullableTime(),
  revokedAt: nullableTime(),
  revocationReason: nullableString('Powód cofnięcia praw (wewnętrzny).'),
};

export const components = {
  NewsPostStatus: {
    type: 'string', enum: ['draft', 'submitted', 'approved', 'published', 'withdrawn'],
    description: 'Zmiana treści wraca do `draft` (opublikowana wersja zostaje publiczna do następnej publikacji); `withdrawn` — stan końcowy.',
  },
  NewsPost: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    classId: nullableId('Klasa wpisu klasowego; null — ogólnoszkolny. Ustalone przy tworzeniu (niezmienne).'),
    status: ref('NewsPostStatus'),
    revision: { type: 'integer', minimum: 1, description: 'Bieżąca wersja treści (każda zmiana treści = nowa, niezmienna wersja).' },
    title: STRING,
    body: STRING,
    photoIds: { type: 'array', items: ref('EntityId') },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    updatedBy: ref('EntityId'),
    updatedAt: ref('IsoDateTime'),
    submittedRevision: nullableRevision(),
    approvedRevision: nullableRevision(),
    approvedBy: nullableId('Zatwierdzający (inna osoba niż autor wpisu i autor wersji — cztery oczy).'),
    approvedAt: nullableTime(),
    publishedRevision: nullableRevision('Wersja widoczna publicznie; null — nigdy nie opublikowany.'),
    publishedAt: nullableTime(),
    withdrawnAt: nullableTime(),
    withdrawalReason: nullableString('Powód wycofania (tylko wewnętrznie).'),
  }, [], { description: 'Wpis w widoku wewnętrznym (osoby z prawem do szkicu lub zatwierdzenia wpisu).' }),
  NewsPostRevision: strictObject({
    revision: { type: 'integer', minimum: 1 },
    title: STRING,
    body: STRING,
    photoIds: { type: 'array', items: ref('EntityId') },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Niezmienna wersja treści wpisu (historii nie można nadpisać ani usunąć).' }),
  NewsPublicPhoto: strictObject({
    id: { ...ref('EntityId'), description: 'Plik: `/api/public/news-photos/{id}/web|thumb`.' },
    author: STRING,
    source: { type: 'string', enum: PHOTO_SOURCES },
    license: { type: 'string', description: 'Tekst licencji/zgody (podpis).' },
    takenOn: ref('IsoDate'),
    altText: nullableString('Tekst alternatywny; `""` dla zdjęcia dekoracyjnego; null tylko dla zdjęcia sprzed 0071 bez opisu (strona je pomija).'),
    decorative: BOOLEAN,
  }, [], { description: 'Zdjęcie zweryfikowane, ze zgodami obejmującymi stronę Rady (bez dokumentów, zgód, notatek i osób).' }),
  NewsPublicPost: strictObject({
    id: ref('EntityId'),
    title: STRING,
    body: STRING,
    publishedAt: ref('IsoDateTime'),
    photos: { type: 'array', items: ref('NewsPublicPhoto') },
  }, [], { description: 'Opublikowana wersja wpisu — bez identyfikatorów użytkowników, klas, wersji i powodów.' }),
  NewsPhotoConsent: strictObject({
    subjectNo: { type: 'integer', minimum: 1, maximum: 200, description: 'Numer osoby na zdjęciu (nie dane osoby).' },
    ...CONSENT_FIELDS,
    scope: { type: 'array', items: { type: 'string', enum: CONSENT_SCOPES }, description: 'Pusty dla zgód sprzed 0083 (wymagają potwierdzenia zakresu).' },
    validUntil: nullable(ref('IsoDate')),
    recordedBy: ref('EntityId'),
    recordedAt: ref('IsoDateTime'),
  }, [], { description: 'Odwołanie do dokumentu zgody na wizerunek (niezmienne).' }),
  NewsPhoto: strictObject(PHOTO_PROPERTIES, [], { description: 'Metadane zdjęcia (niezmienne poza stanem praw; korekta = nowe zdjęcie).' }),
  NewsPhotoWithConsents: strictObject({
    ...PHOTO_PROPERTIES,
    consents: { type: 'array', items: ref('NewsPhotoConsent'), description: 'Odwołania do zgód, od numeru 1.' },
  }, [], { description: 'Zdjęcie z odwołaniami do zgód (tylko odczyt jednego zdjęcia).' }),
  NewsPhotoFile: strictObject({
    variant: { type: 'string', enum: ['web', 'thumb'], description: '`web` — do 1600 px, `thumb` — do 400 px (dłuższy bok).' },
    mimeType: { const: 'image/jpeg' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    byteSize: { type: 'integer', minimum: 1 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    createdAt: nullableTime('Zapis wariantu; null wyłącznie przy odtworzeniu po przegranym wyścigu dwóch przesłań (odczyt bez tej kolumny).'),
  }, [], { description: 'Wariant pliku zdjęcia: ponownie zakodowany JPEG bez EXIF/GPS/XMP (oryginał nie jest przechowywany).' }),

  NewsPostCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    classId: nullable({ ...ref('Id'), description: 'Klasa wpisu; pominięte/null — ogólnoszkolny (tylko admin i zarząd). Przedstawiciel: tylko własna klasa.' }),
    title: TITLE,
    body: BODY,
    photoIds: PHOTO_IDS,
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'title', 'body'], { description: 'Nowy szkic wpisu (pierwsza wersja treści).' }),
  NewsPostUpdateRequest: requestObject({
    revision: REVISION,
    title: TITLE,
    body: BODY,
    photoIds: PHOTO_IDS,
    confirmPersonalData: CONFIRM,
  }, ['revision'], {
    description: 'Nowa wersja treści (pominięte pola bez zmian). Ta sama treść = odtworzenie (`replayed: true`); ponowienie tej samej '
      + 'zmiany przez jej autora po nowszym numerze wersji — też.',
  }),
  NewsPostTransitionRequest: requestObject({ revision: REVISION }, ['revision'], {
    description: 'Krok przebiegu dla wskazanej wersji (zgłoszenie, zatwierdzenie, publikacja).',
  }),
  NewsPostWithdrawRequest: requestObject({ revision: REVISION, reason: REASON, confirmPersonalData: CONFIRM }, ['revision', 'reason'], {
    description: 'Wycofanie (stan końcowy, natychmiast znika z widoku publicznego); wpis kiedykolwiek opublikowany wycofuje tylko zarząd.',
  }),
  NewsPhotoConsentInput: requestObject({
    subjectNo: { type: 'integer', minimum: 1, maximum: 200, description: 'Domyślnie kolejny numer na liście; numery bez powtórzeń.' },
    ...CONSENT_FIELDS,
  }, ['subjectKind', 'consentDocumentRef']),
  NewsPhotoRegisterRequest: {
    ...requestObject({
      documentId: { ...ref('Id'), description: 'Istniejący dokument zarządu z plikiem źródłowym (inaczej 400 `invalid_document_id`).' },
      author: { type: 'string', minLength: 2, maxLength: 200 },
      source: { type: 'string', enum: PHOTO_SOURCES, description: '`public_website_copy` wymaga `explicitLicenseGranted` i `licenseDocumentRef` (422 `public_copy_requires_license`).' },
      sourceDetail: nullable({ type: 'string', minLength: 3, maxLength: 500 }),
      takenOn: ref('IsoDate'),
      licenseText: { type: 'string', minLength: 10, maxLength: 1000 },
      explicitLicenseGranted: BOOLEAN,
      licenseDocumentRef: nullable(ref('Id')),
      rightsNote: nullable({ type: 'string', minLength: 3, maxLength: 1000 }),
      altText: nullable({ type: 'string', minLength: 3, maxLength: 300, description: 'Opis sceny bez imion i nazwisk dzieci (WCAG 1.1.1, #124).' }),
      decorative: BOOLEAN,
      depictsChildren: { type: 'boolean', description: 'true wymaga przed weryfikacją co najmniej jednej zgody `child` (409 `child_consent_required`).' },
      identifiableChildren: { type: 'integer', minimum: 0, maximum: 100, description: '> 0 wymaga `depictsChildren: true`; zgody muszą pokryć liczbę (409 `consent_missing`).' },
      identifiableAdults: { type: 'integer', minimum: 0, maximum: 100 },
      consents: { type: 'array', items: ref('NewsPhotoConsentInput'), description: 'Odwołania do zgód; można je dopisywać do weryfikacji.' },
      confirmPersonalData: CONFIRM,
    }, ['documentId', 'author', 'source', 'takenOn', 'licenseText', 'depictsChildren']),
    anyOf: [
      { required: ['altText'], properties: { altText: { type: 'string', minLength: 3 } } },
      { required: ['decorative'], properties: { decorative: { const: true } } },
    ],
    description: 'Rejestracja metadanych zdjęcia (niezmiennych). `altText` albo `decorative: true` jest wymagane — inaczej 422 '
      + '`alt_text_required` (#124).',
  },
  NewsPhotoConsentRequest: requestObject({
    subjectNo: { type: 'integer', minimum: 1, maximum: 200 },
    ...CONSENT_FIELDS,
  }, ['subjectNo', 'subjectKind', 'consentDocumentRef'], {
    description: 'Odwołanie do zgody (tylko przed weryfikacją). Ten sam wpis ponownie = odtworzenie; inny pod tym samym numerem → 409 `consent_conflict`.',
  }),
  NewsPhotoVerifyRequest: requestObject({}, [], { description: 'Puste ciało JSON `{}` (trasa czyta ciało jak każdy zapis).' }),
  NewsPhotoRevokeRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason'], {
    description: 'Cofnięcie praw (stan końcowy): zdjęcie natychmiast znika z widoku publicznego i z publicznego odczytu pliku.',
  }),
};

// ---------- kody błędów ----------

// Bramka MFA routera (każda trasa poza publicznymi).
const GATE = { 403: ['mfa_enrollment_required', 'mfa_required'] };
const JSON_WRITE = mergeErrors(GATE, {
  400: ['invalid_json'],
  403: ['invalid_origin'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});
const POST_PATH = { 400: ['invalid_post_id'], 404: ['post_not_found'] };
const PHOTO_PATH = { 400: ['invalid_photo_id'], 404: ['photo_not_found'] };
const CONTENT = {
  400: ['duplicate_photo', 'invalid_body', 'invalid_photos', 'invalid_title'],
  403: ['photos_require_school_wide_role'],
  409: ['photo_revoked'],
  422: ['photo_not_found'],
};
const STEP = mergeErrors(JSON_WRITE, POST_PATH, { 400: ['invalid_revision'], 409: ['post_withdrawn', 'revision_conflict'] });
const REVIEW = mergeErrors(STEP, {
  403: ['forbidden', 'mfa_required'],
  409: ['invalid_transition', 'photo_revoked', 'photo_rights_unverified'],
});

const replayedField = { type: 'boolean', description: 'true: ponowienie rozpoznane po stanie obiektu (bez nowego zapisu i wpisu w dzienniku).' };
const postResult = strictObject({ post: ref('NewsPost'), replayed: replayedField });
const photoResult = strictObject({ photo: ref('NewsPhoto'), replayed: replayedField });
const postOnly = strictObject({ post: ref('NewsPost') });
const photoOnly = strictObject({ photo: ref('NewsPhoto') });
const filesOnly = strictObject({ files: { type: 'array', items: ref('NewsPhotoFile'), minItems: 2, maxItems: 2 } });
const PUBLIC_CACHE = '`Cache-Control: public, max-age=60` (wycofanie i cofnięcie praw znikają najpóźniej po 60 s).';
const publicFile = (variant) => ({
  responses: {
    200: fileResponse(
      `Wariant \`${variant}\` (JPEG bez metadanych) wyłącznie dla zdjęcia zweryfikowanego, ze zgodami obejmującymi stronę Rady, `
        + `należącego do opublikowanej wersji niewycofanego wpisu (\`news_photo_is_public\`, 0112). ${PUBLIC_CACHE}`,
      'image/jpeg',
    ),
  },
  errors: {
    404: ['photo_not_found'],
    409: ['photo_file_integrity_mismatch'],
    503: ['service_unavailable'],
  },
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/public/news': {
    query: {
      schoolYearId: { schema: ref('Id'), description: 'Filtr roku szkolnego (400 `invalid_school_year`).' },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
      cursor: { schema: STRING, description: '`nextCursor` z poprzedniej strony tego samego filtru (inny filtr → 400 `invalid_cursor`).' },
    },
    responses: {
      200: {
        description: `Publiczne (bez logowania): opublikowane wpisy od najnowszego (\`published_at DESC, id\`), kursor keyset. ${PUBLIC_CACHE}`,
        schema: strictObject({
          posts: { type: 'array', items: ref('NewsPublicPost') },
          nextCursor: nullable({ type: 'string', description: 'Kursor następnej (starszej) strony; null na ostatniej.' }),
          truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        }),
      },
    },
    errors: { 400: ['invalid_cursor', 'invalid_limit', 'invalid_school_year'] },
  },
  'GET /api/public/news/{postId}': {
    responses: {
      200: { description: `Stały adres jednego opublikowanego wpisu (te same pola co lista). ${PUBLIC_CACHE}`, schema: strictObject({ post: ref('NewsPublicPost') }) },
    },
    errors: { 404: ['post_not_found'] },
  },
  'GET /api/public/school-years': {
    responses: {
      200: {
        description: 'Lata szkolne z treściami publicznymi (aktualności, wydarzenia, zawiadomienia, protokoły `public`), od najnowszego; '
          + `tylko identyfikatory. ${PUBLIC_CACHE}`,
        schema: strictObject({ schoolYears: { type: 'array', items: strictObject({ id: ref('EntityId') }) } }),
      },
    },
  },
  'GET /api/public/news-photos/{photoId}/web': publicFile('web'),
  'GET /api/public/news-photos/{photoId}/thumb': publicFile('thumb'),
  'GET /api/news': {
    query: { schoolYearId: { required: true, schema: ref('Id'), description: 'Brak albo zły → 400 `invalid_school_year`.' } },
    responses: {
      200: {
        description: 'Wpisy roku (bez stronicowania), od najnowszego; przedstawiciel widzi tylko wpisy swoich klas.',
        schema: strictObject({ posts: { type: 'array', items: ref('NewsPost') } }),
      },
    },
    errors: mergeErrors(GATE, { 400: ['invalid_school_year'], 403: ['forbidden'] }),
  },
  'POST /api/news': {
    idempotencyKey: true,
    body: ref('NewsPostCreateRequest'),
    responses: {
      201: replayed('false', 'Szkic wpisu utworzony (nic nie jest publikowane).', postOnly),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (ta sama osoba, zakres i treść; bez nowego zapisu).', postOnly),
    },
    errors: mergeErrors(JSON_WRITE, CONTENT, PII_ERRORS, {
      400: ['invalid_class', 'invalid_idempotency_key', 'invalid_reference', 'invalid_school_year'],
      403: ['forbidden'],
      // Zamknięty rok: trigger a0_year_freeze blokuje wyłącznie nowy wpis (INSERT, 0130).
      409: ['idempotency_conflict', 'school_year_closed'],
    }),
  },
  'GET /api/news/{postId}': {
    responses: {
      200: {
        description: 'Wpis z pełną historią wersji (od pierwszej).',
        schema: strictObject({ post: ref('NewsPost'), revisions: { type: 'array', items: ref('NewsPostRevision'), minItems: 1 } }),
      },
    },
    errors: mergeErrors(GATE, POST_PATH),
  },
  'PATCH /api/news/{postId}': {
    body: ref('NewsPostUpdateRequest'),
    responses: {
      200: { description: 'Nowa wersja treści (wpis wraca do szkicu) albo odtworzenie (`replayed: true`).', schema: postResult },
    },
    errors: mergeErrors(STEP, CONTENT, PII_ERRORS),
  },
  'POST /api/news/{postId}/submit': {
    body: ref('NewsPostTransitionRequest'),
    responses: { 200: { description: 'Zgłoszenie wersji do zatwierdzenia; ponowienie: `replayed: true`.', schema: postResult } },
    errors: STEP,
  },
  'POST /api/news/{postId}/approve': {
    body: ref('NewsPostTransitionRequest'),
    responses: {
      200: {
        description: 'Zatwierdzenie zgłoszonej wersji przez zarząd (MFA, cztery oczy, zdjęcia zweryfikowane); ponowienie: `replayed: true`.',
        schema: postResult,
      },
    },
    errors: mergeErrors(REVIEW, { 409: ['four_eyes_required'] }),
  },
  'POST /api/news/{postId}/publish': {
    body: ref('NewsPostTransitionRequest'),
    responses: {
      200: {
        description: 'Publikacja zatwierdzonej wersji przez zarząd (MFA; zdjęcia zweryfikowane); ponowienie: `replayed: true`.',
        schema: postResult,
      },
    },
    errors: REVIEW,
  },
  'POST /api/news/{postId}/withdraw': {
    body: ref('NewsPostWithdrawRequest'),
    responses: {
      200: { description: 'Wycofanie z powodem (stan końcowy, wpis znika z widoku publicznego); ponowienie: `replayed: true`.', schema: postResult },
    },
    errors: mergeErrors(JSON_WRITE, POST_PATH, PII_ERRORS, {
      400: ['invalid_reason', 'invalid_revision'],
      403: ['forbidden'],
      409: ['revision_conflict'],
    }),
  },
  'GET /api/news-photos': {
    query: {
      status: { schema: { type: 'string', enum: ['pending', 'verified', 'revoked'] }, description: 'Inna wartość → 400 `invalid_status`.' },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 } },
      cursor: { schema: STRING, description: '`nextCursor` z poprzedniej strony tego samego filtru `status` (inny → 400 `invalid_cursor`).' },
    },
    responses: {
      200: {
        description: 'Rejestr zdjęć od najnowszego (`uploaded_at DESC, id`), kursor keyset; bez odwołań do zgód.',
        schema: strictObject({
          photos: { type: 'array', items: ref('NewsPhoto') },
          nextCursor: nullable(STRING),
          truncated: BOOLEAN,
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        }),
      },
    },
    errors: mergeErrors(GATE, { 400: ['invalid_cursor', 'invalid_limit', 'invalid_status'], 403: ['forbidden'] }),
  },
  'POST /api/news-photos': {
    idempotencyKey: true,
    body: ref('NewsPhotoRegisterRequest'),
    responses: {
      201: replayed('false', 'Zdjęcie zarejestrowane (`pending`; publiczne dopiero po weryfikacji i publikacji wpisu).', photoOnly),
      200: replayed('true', 'Odtworzenie po tym samym kluczu (ta sama osoba, dokument, autor i źródło).', photoOnly),
    },
    errors: mergeErrors(JSON_WRITE, PII_ERRORS, {
      400: [
        'invalid_alt_text', 'invalid_author', 'invalid_consent', 'invalid_consent_scope', 'invalid_consent_valid_until', 'invalid_decorative',
        'invalid_depicts_children', 'invalid_document_id', 'invalid_explicit_license', 'invalid_identifiable_adults',
        'invalid_identifiable_children', 'invalid_idempotency_key', 'invalid_license_document_ref', 'invalid_license_text',
        'invalid_rights_note', 'invalid_source', 'invalid_source_detail', 'invalid_taken_on',
      ],
      403: ['forbidden'],
      409: ['idempotency_conflict'],
      422: ['alt_text_required', 'public_copy_requires_license'],
    }),
  },
  'GET /api/news-photos/{photoId}': {
    responses: { 200: { description: 'Zdjęcie z odwołaniami do zgód.', schema: strictObject({ photo: ref('NewsPhotoWithConsents') }) } },
    errors: mergeErrors(GATE, PHOTO_PATH, { 403: ['forbidden'] }),
  },
  'POST /api/news-photos/{photoId}/consents': {
    body: ref('NewsPhotoConsentRequest'),
    responses: {
      201: { description: 'Odwołanie do zgody zapisane (bez nagłówka `Idempotency-Replayed`).', schema: strictObject({ replayed: { const: false } }) },
      200: { description: 'Ten sam wpis pod tym numerem już istnieje (podwójne kliknięcie).', schema: strictObject({ replayed: { const: true } }) },
    },
    errors: mergeErrors(JSON_WRITE, PHOTO_PATH, {
      400: ['invalid_consent', 'invalid_consent_scope', 'invalid_consent_valid_until'],
      403: ['forbidden'],
      409: ['consent_conflict', 'consents_locked'],
    }),
  },
  'POST /api/news-photos/{photoId}/verify': {
    body: ref('NewsPhotoVerifyRequest'),
    responses: {
      200: {
        description: 'Prawa zweryfikowane przez zarząd (inna osoba niż rejestrująca; zgody pokrywają osoby); ponowienie: `replayed: true`.',
        schema: photoResult,
      },
    },
    errors: mergeErrors(JSON_WRITE, PHOTO_PATH, {
      403: ['forbidden'],
      409: ['child_consent_required', 'consent_missing', 'four_eyes_required', 'photo_revoked'],
      422: ['alt_text_required'],
    }),
  },
  'POST /api/news-photos/{photoId}/revoke': {
    body: ref('NewsPhotoRevokeRequest'),
    responses: {
      200: { description: 'Prawa cofnięte (stan końcowy); ponowienie: `replayed: true`.', schema: photoResult },
    },
    errors: mergeErrors(JSON_WRITE, PHOTO_PATH, PII_ERRORS, { 400: ['invalid_reason'], 403: ['forbidden'] }),
  },
  'POST /api/news-photos/{photoId}/file': {
    idempotencyKey: true,
    bodyDescription: 'Surowe bajty PNG albo JPEG (nie JSON ani multipart, do 10 MiB i 40 Mpx). `Content-Type` musi zgadzać się z sygnaturą; '
      + 'serwer ponownie koduje obraz do wariantów JPEG `web` i `thumb` bez EXIF/GPS/XMP i nie przechowuje oryginału.',
    bodyContent: { 'image/png': BINARY, 'image/jpeg': BINARY },
    responses: {
      201: replayed('false', 'Warianty zapisane w prywatnym magazynie (prefiks `photos/`).', filesOnly),
      200: replayed('true', 'Ten sam plik dla zdjęcia, które już ma warianty: zapisane wcześniej warianty.', filesOnly),
    },
    errors: mergeErrors(GATE, {
      400: ['empty_photo_file', 'invalid_idempotency_key', 'invalid_photo_id'],
      403: ['forbidden', 'invalid_origin'],
      404: ['photo_not_found'],
      409: ['photo_file_exists', 'photo_revoked'],
      413: ['photo_file_too_large'],
      415: ['photo_file_malformed', 'unsupported_media_type'],
      503: ['storage_unavailable', 'upload_busy'],
    }),
  },
  'POST /api/news-photo-consents/{consentDocumentRef}/withdraw': {
    responses: {
      200: {
        description: 'Wycofanie jednej zgody (po odwołaniu do dokumentu): ukrywa publicznie każde zdjęcie z tą zgodą (także rodzeństwo); '
          + 'ponowienie: `replayed: true`. Trasa nie czyta ciała.',
        schema: strictObject({
          replayed: replayedField,
          affectedPhotos: { type: 'integer', minimum: 1, description: 'Liczba zdjęć z wierszem tej zgody.' },
        }),
      },
    },
    errors: mergeErrors(GATE, { 400: ['invalid_consent'], 403: ['forbidden', 'invalid_origin'], 404: ['consent_not_found'] }),
  },
};
