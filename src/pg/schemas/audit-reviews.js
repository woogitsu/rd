// Schematy OpenAPI dla modułu `audit-reviews` (src/pg/routes/audit-reviews.js i src/pg/audit-reviews.js, #137, migracja
// 0176), #160 etap 13: ścieżka kontroli Komisji Rewizyjnej — wątki uwag (pytanie/ustalenie → odpowiedź → zamknięcie)
// i wnioski końcowe roku. Pisane ręcznie na podstawie `present`, `listReviews` i `appendNote`; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * odczyt: Komisja Rewizyjna, zarząd i skarbnik; pytanie/ustalenie, zamknięcie i wniosek — wyłącznie `audit`;
//     odpowiedź — wyłącznie zarząd i skarbnik. Zawsze przydział bez klasy w roku ze ścieżki i MFA (D-09, wariant
//     zachowawczy); admin, dyrekcja, przedstawiciel i przydział klasowy → 403. Gdy rola i rok pasują, a przeszkodą jest
//     tylko MFA sesji: 403 `mfa_required`/`mfa_enrollment_required` (#161). Rola jest sprawdzana PRZED walidacją ciała;
//   * zły identyfikator roku w ścieżce → 400 `invalid_school_year_id` jeszcze przed sesją; zły identyfikator uwagi →
//     400 `audit_review_not_found` (kod „nie znaleziono” ze statusem 400 — rozbieżność opisana w docs/API.md);
//   * każdy zapis wymaga nagłówka Idempotency-Key i jest niezmienny; odpowiedź ma pole `replayed` (201 `false`, ponowienie
//     tym samym kluczem i treścią 200 `true`), BEZ nagłówka `Idempotency-Replayed`; ten sam klucz z inną treścią → 409;
//   * treść uwagi (3-2000 znaków po przycięciu) przechodzi bramkę danych osobowych (422); zamknięcie przyjmuje żądanie
//     bez treści (puste ciało bez Content-Type), a wtedy `body` zapisu jest null;
//   * zamknięty rok odrzuca zapisy (409 `school_year_closed`); odczyt pozostaje.
import { PII_ERRORS, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'audit-reviews';

const NOTE_KINDS = ['question', 'finding', 'answer', 'closed', 'conclusion'];
const TARGET_TYPES = ['ledger_entry', 'reconciliation', 'year'];
const BODY = {
  type: 'string', minLength: 3, maxLength: 2000,
  description: 'Treść (3-2000 znaków po przycięciu spacji). Wolny tekst za bramką danych osobowych (#152); nie trafia do dziennika zdarzeń.',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};

const NOTE_PROPERTIES = {
  id: ref('EntityId'),
  kind: { type: 'string', enum: NOTE_KINDS, description: 'question/finding — korzeń wątku; answer, closed — wpisy wątku; conclusion — wniosek końcowy roku.' },
  targetType: { type: 'string', enum: TARGET_TYPES },
  targetId: { ...ref('EntityId'), description: 'Wpis księgi, uzgodnienie albo rok (wtedy identyfikator roku ze ścieżki).' },
  parentId: nullable({ ...ref('EntityId'), description: 'Korzeń wątku (odpowiedź, zamknięcie); null dla korzenia i wniosku.' }),
  body: nullable({ type: 'string', description: 'Treść; null tylko przy zamknięciu bez treści.' }),
  createdBy: { ...ref('EntityId'), description: 'Autor (identyfikator konta, bez imienia i e-maila).' },
  createdAt: ref('IsoDateTime'),
};

export const components = {
  AuditReviewNote: strictObject(NOTE_PROPERTIES, [], { description: 'Niezmienny zapis ścieżki kontroli KR (korekta = nowy zapis).' }),
  AuditReviewThread: strictObject({
    ...NOTE_PROPERTIES,
    kind: { type: 'string', enum: ['question', 'finding'] },
    parentId: { type: 'null' },
    body: { type: 'string', description: 'Treść pytania albo ustalenia.' },
    status: { type: 'string', enum: ['open', 'answered', 'closed'], description: 'open — bez odpowiedzi; answered — z odpowiedzią; closed — zamknięty przez KR.' },
    answers: { type: 'array', items: ref('AuditReviewNote'), description: 'Odpowiedzi zarządu/skarbnika w kolejności zapisu.' },
    closed: nullable(ref('AuditReviewNote')),
  }, [], { description: 'Wątek: pytanie albo ustalenie KR z odpowiedziami i zamknięciem.' }),
  AuditReviewNoteRequest: requestObject({
    kind: { type: 'string', enum: ['question', 'finding'] },
    targetType: { type: 'string', enum: TARGET_TYPES },
    targetId: {
      ...ref('Id'),
      description: 'Wpis księgi albo uzgodnienie z roku ze ścieżki (inaczej 404 `audit_review_target_not_found`); dla `year` — identyfikator roku ze ścieżki.',
    },
    body: BODY,
    confirmPersonalData: CONFIRM,
  }, ['kind', 'targetType', 'targetId', 'body']),
  AuditReviewBodyRequest: requestObject({ body: BODY, confirmPersonalData: CONFIRM }, ['body']),
  AuditReviewClosureRequest: requestObject({
    body: { anyOf: [BODY, { type: 'null' }, { const: '' }], description: 'Opcjonalne uzasadnienie zamknięcia (3-2000 znaków); null, pusty tekst albo brak pola — zamknięcie bez treści.' },
    confirmPersonalData: CONFIRM,
  }, []),
};

const noteResult = (replayed) => strictObject({ note: ref('AuditReviewNote'), replayed: { const: replayed } });
const writeResponses = (what) => ({
  201: { description: `${what} zapisane (\`replayed: false\`).`, schema: noteResult(false) },
  200: { description: 'Ponowienie tym samym kluczem i tą samą treścią: ten sam zapis (`replayed: true`), bez nowego wiersza.', schema: noteResult(true) },
});

const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const YEAR_ID = { 400: ['invalid_school_year_id'] };
const WRITE = mergeErrors(GATE, YEAR_ID, PII_ERRORS, {
  400: ['invalid_audit_review_body', 'invalid_idempotency_key', 'invalid_json'],
  403: ['invalid_origin'],
  409: ['idempotency_conflict', 'school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});
const THREAD_WRITE = mergeErrors(WRITE, { 400: ['audit_review_not_found'], 404: ['audit_review_not_found'], 409: ['audit_review_closed'] });

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/audit-reviews/{year}': {
    responses: {
      200: {
        description: 'Wątki uwag i wnioski końcowe roku w kolejności zapisu; obowiązuje najnowszy wniosek.',
        schema: strictObject({
          schoolYearId: ref('EntityId'),
          threads: { type: 'array', items: ref('AuditReviewThread') },
          conclusions: { type: 'array', items: ref('AuditReviewNote'), description: 'Wszystkie wnioski końcowe (kolejny wniosek to nowy zapis).' },
          currentConclusion: nullable(ref('AuditReviewNote')),
          counts: strictObject({ open: ref('Count'), answered: ref('Count'), closed: ref('Count') }),
        }),
      },
    },
    errors: mergeErrors(GATE, YEAR_ID, { 404: ['school_year_not_found'] }),
  },
  'POST /api/audit-reviews/{year}/notes': {
    body: ref('AuditReviewNoteRequest'),
    idempotencyKey: true,
    responses: writeResponses('Pytanie albo ustalenie KR'),
    errors: mergeErrors(WRITE, { 400: ['invalid_request'], 404: ['audit_review_target_not_found', 'school_year_not_found'] }),
  },
  'POST /api/audit-reviews/{year}/notes/{id}/answers': {
    body: ref('AuditReviewBodyRequest'),
    idempotencyKey: true,
    responses: writeResponses('Odpowiedź zarządu albo skarbnika'),
    errors: mergeErrors(THREAD_WRITE, { 403: ['four_eyes_required'] }),
    errorDescriptions: { 403: 'Brak uprawnień, MFA albo ta sama osoba co autor pytania (`four_eyes_required`).' },
  },
  'POST /api/audit-reviews/{year}/notes/{id}/closure': {
    body: ref('AuditReviewClosureRequest'),
    bodyOptional: true,
    idempotencyKey: true,
    responses: writeResponses('Zamknięcie wątku przez KR'),
    errors: THREAD_WRITE,
  },
  'POST /api/audit-reviews/{year}/conclusion': {
    body: ref('AuditReviewBodyRequest'),
    idempotencyKey: true,
    responses: writeResponses('Wniosek końcowy roku'),
    errors: mergeErrors(WRITE, { 404: ['school_year_not_found'] }),
  },
};
