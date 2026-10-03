// Schematy OpenAPI dla modułu `privacy-notice` (src/pg/routes/privacy-notice.js; #145, D-06), #160 etap 14: publiczna
// obowiązująca wersja informacji o przetwarzaniu danych, lista wersji, szkic, zatwierdzenie (cztery oczy) i publikacja.
// Pisane ręcznie na podstawie `noticeView`, `loadPublicNotice` i testów tests/pg-privacy-notice.test.js; trasy się nie
// zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * zarządzanie: admin i zarząd z MFA (przydział bez klasy); inne role → 403 `forbidden`. Zatwierdza inna osoba niż
//     autor (autor → 403 `forbidden`, ograniczenie `privacy_notice_four_eyes` w bazie); publikować można wyłącznie wersję
//     zatwierdzoną (409 `privacy_notice_not_approved`), publikacja przenosi poprzednią do `superseded`;
//   * moduł nie dostarcza treści: `bodyText` i `decisionRef` wpisuje zarząd/administrator (D-06). Wersja jest niezmienna;
//   * zatwierdzenie i publikacja nie czytają ciała żądania; ponowienie (wersja już zatwierdzona albo opublikowana/
//     zastąpiona) → 200 z nagłówkiem `Idempotency-Replayed: true`, bez nowego zdarzenia (pierwszy zapis — bez nagłówka);
//   * publiczna trasa (bez sesji) pokazuje wyłącznie obowiązującą wersję — bez identyfikatorów kont i statusu.
import { mergeErrors, nullable, ref, replayedOnRetry, requestObject, strictObject } from './common.js';

export const name = 'privacy-notice';

const STRING = { type: 'string' };
const nullableId = () => nullable(ref('EntityId'));
const nullableTime = () => nullable(ref('IsoDateTime'));

export const components = {
  PrivacyNotice: strictObject({
    id: ref('EntityId'),
    version: { type: 'integer', minimum: 1, description: 'Numer wersji (rośnie; podawany w stopce e-maila i na kartce).' },
    schoolYearId: nullableId(),
    bodyText: STRING,
    contentHash: ref('Sha256Hex'),
    decisionRef: { type: 'string', description: 'Odwołanie do decyzji zarządu/szkoły (D-06).' },
    status: { type: 'string', enum: ['draft', 'approved', 'published', 'superseded'] },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    approvedBy: nullableId(),
    approvedAt: nullableTime(),
    publishedBy: nullableId(),
    publishedAt: nullableTime(),
  }, [], { description: 'Wersja informacji o przetwarzaniu danych (niezmienna po zapisie poza przejściami stanu).' }),
  PrivacyNoticePublic: strictObject({
    version: { type: 'integer', minimum: 1 },
    bodyText: STRING,
    publishedAt: nullableTime(),
  }, [], { description: 'Obowiązująca wersja dla strony publicznej — bez identyfikatorów kont.' }),

  PrivacyNoticeCreateRequest: requestObject({
    bodyText: { type: 'string', maxLength: 20000, description: 'Niepusta po przycięciu, do 20 000 znaków (400 `invalid_body_text`).' },
    decisionRef: { type: 'string', maxLength: 200, description: 'Niepusty po przycięciu, do 200 znaków (400 `invalid_decision_ref`).' },
    schoolYearId: nullable({
      ...ref('Id'),
      description: 'Opcjonalny rok (zły format → 400 `invalid_school_year`; nieistniejący → 400 `invalid_reference` z routera).',
    }),
  }, ['bodyText', 'decisionRef']),
};

// ---------- kody błędów ----------

// Rola z MFA (requireAccess) i bramka MFA routera.
const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const POST = mergeErrors(GATE, { 403: ['invalid_origin'] });
const PATH = { 400: ['invalid_id'], 404: ['privacy_notice_not_found'] };
const noticeOnly = strictObject({ notice: ref('PrivacyNotice') });

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/public/privacy-notice': {
    responses: {
      200: {
        description: 'Obowiązująca (opublikowana) wersja, bez sesji; `Cache-Control: public, max-age=60`.',
        schema: ref('PrivacyNoticePublic'),
      },
    },
    errors: { 404: ['privacy_notice_not_found'] },
  },
  'GET /api/admin/privacy-notices': {
    responses: {
      200: {
        description: 'Wszystkie wersje od najnowszej (bez stronicowania).',
        schema: strictObject({ notices: { type: 'array', items: ref('PrivacyNotice') } }),
      },
    },
    errors: GATE,
  },
  'POST /api/admin/privacy-notices': {
    body: ref('PrivacyNoticeCreateRequest'),
    responses: { 201: { description: 'Nowy szkic (`draft`); zdarzenie `privacy_notice.created`.', schema: noticeOnly } },
    errors: mergeErrors(POST, {
      400: ['invalid_body_text', 'invalid_decision_ref', 'invalid_json', 'invalid_reference', 'invalid_school_year'],
      413: ['request_too_large'],
      415: ['invalid_content_type'],
    }),
  },
  'POST /api/admin/privacy-notices/{id}/approve': {
    responses: {
      200: replayedOnRetry(
        'Zatwierdzenie szkicu przez inną osobę niż autor; wersja już zatwierdzona/opublikowana → ten sam stan z nagłówkiem '
          + '`Idempotency-Replayed: true`.',
        noticeOnly,
      ),
    },
    errors: mergeErrors(POST, PATH, { 409: ['privacy_notice_not_draft'] }),
    errorDescriptions: { 403: 'Brak roli, MFA albo zatwierdzenie przez autora wersji (cztery oczy) — `forbidden`.' },
  },
  'POST /api/admin/privacy-notices/{id}/publish': {
    responses: {
      200: replayedOnRetry(
        'Publikacja zatwierdzonej wersji (poprzednia → `superseded`); wersja opublikowana albo zastąpiona → ten sam stan z nagłówkiem '
          + '`Idempotency-Replayed: true`.',
        noticeOnly,
      ),
    },
    errors: mergeErrors(POST, PATH, { 409: ['privacy_notice_not_approved'] }),
  },
};
