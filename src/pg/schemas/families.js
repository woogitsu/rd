// Schematy OpenAPI dla modułu `families` (src/pg/routes/families.js, #5, #86, #95, #100, #190, #200).
// #160 etap 3. Pisane ręcznie na podstawie parserów (`parseContactInput`, `parseIdentityInput`,
// `parseEnrollmentInput` …) i obiektów odpowiedzi tras; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje:
//   * zapisy NIE używają nagłówka Idempotency-Key: ponowienie tej samej zmiany (podwójne
//     kliknięcie) zwraca 200 z `changed: false` i nie tworzy drugiego wpisu historii;
//   * listy (klasy, uczniowie klasy) nie są stronicowane — bez kursora;
//   * zakres klasowy (przedstawiciel, zarząd z przydziałem klasy) dostaje węższy kształt karty:
//     bez `isPrimaryHousehold`, bez `isPrimary` przy gospodarstwach i bez `paymentTotals` —
//     te pola są więc opcjonalne; obiekt poza zakresem = 404 `not_found` jak nieistniejący;
//   * karta gospodarstwa nie zawiera należności ani statusu „dłużnik” (składka dobrowolna);
//     `paymentTotals` (suma netto zapisanych wpłat) widzą wyłącznie role finansowe z MFA.
import { PII_ERRORS, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'families';

const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód zmiany (3-500 znaków po przycięciu spacji). Trafia do niezmiennej historii; bramka danych osobowych (#152).',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const PERSON_NAME = {
  type: 'string', minLength: 1, maxLength: 100, pattern: '^[^@]*$',
  description: 'Imię albo nazwisko (1-100 znaków po normalizacji NFC i scaleniu spacji); bez `@` i znaków sterujących.',
};
const HOUSEHOLD_LINK = strictObject({
  householdId: ref('EntityId'),
  isPrimary: { type: 'boolean', description: 'Gospodarstwo główne ucznia; pole tylko dla zakresu szerokiego.' },
}, ['isPrimary'], {
  description: 'Bieżące członkostwo ucznia w gospodarstwie. Zakres klasowy widzi tylko gospodarstwa kontaktowe (#95), bez `isPrimary`.',
});

export const components = {
  FamilyClass: strictObject({
    id: ref('EntityId'),
    name: { type: 'string' },
    schoolYearId: ref('EntityId'),
    schoolYearLabel: { type: 'string' },
    studentCount: { ...ref('Count'), description: 'Liczba bieżących przypisań do klasy (bez uczniów po odejściu).' },
  }),
  FamilyClassRef: strictObject({
    id: ref('EntityId'), name: { type: 'string' }, schoolYearId: ref('EntityId'), schoolYearLabel: { type: 'string' },
  }),
  FamilyHouseholdLink: HOUSEHOLD_LINK,
  FamilyClassStudent: strictObject({
    id: ref('EntityId'),
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    households: { type: 'array', items: ref('FamilyHouseholdLink') },
  }),
  HouseholdStudent: strictObject({
    id: ref('EntityId'),
    membershipId: { ...ref('EntityId'), description: 'Członkostwo ucznia w tym gospodarstwie (do zakończenia: .../households/{membershipId}/end).' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    isPrimaryHousehold: { type: 'boolean', description: 'Czy to gospodarstwo główne ucznia; pole tylko dla zakresu szerokiego.' },
    classes: {
      type: 'array',
      description: 'Bieżące przypisania ucznia do klas w zakresie wywołującego (rodzeństwo w innej klasie ma własny wpis).',
      items: strictObject({
        classId: ref('EntityId'), className: { type: 'string' }, schoolYearId: ref('EntityId'), enrollmentId: ref('EntityId'),
      }),
    },
    otherHouseholds: {
      type: 'array', items: ref('FamilyHouseholdLink'),
      description: 'Pozostałe bieżące gospodarstwa ucznia (opieka dzielona).',
    },
  }, ['isPrimaryHousehold']),
  HouseholdGuardian: strictObject({
    id: ref('EntityId'),
    membershipId: { ...ref('EntityId'), description: 'Członkostwo opiekuna w tym gospodarstwie.' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: {
      ...nullable({ type: 'string' }),
      description: 'Zakres klasowy: tylko przy zgodzie opiekuna i zgodzie relacji z widocznym dzieckiem, inaczej null (założenie D-08).',
    },
    contactAllowed: { type: 'boolean' },
    relations: {
      type: 'array',
      description: 'Aktywne relacje opiekuna z uczniami widocznymi na karcie.',
      items: strictObject({ studentId: ref('EntityId'), contactAllowed: { type: 'boolean' }, isPrimaryContact: { type: 'boolean' } }),
    },
  }),
  HouseholdPaymentTotal: strictObject({
    schoolYearId: ref('EntityId'),
    netAmountCents: { ...ref('NonNegativeCents'), description: 'Suma netto zapisanych wpłat (po korektach i zwrotach); nie jest należnością.' },
    paymentCount: ref('Count'),
  }),
  HouseholdCard: strictObject({
    household: strictObject({ id: ref('EntityId'), archived: { type: 'boolean' } }),
    students: { type: 'array', minItems: 1, items: ref('HouseholdStudent') },
    guardians: { type: 'array', items: ref('HouseholdGuardian') },
    paymentTotals: {
      type: 'array', items: ref('HouseholdPaymentTotal'),
      description: 'Tylko role finansowe (admin, zarząd, skarbnik) z przydziałem bez klasy i potwierdzonym MFA.',
    },
  }, ['paymentTotals'], { description: 'Karta gospodarstwa: uczniowie w zakresie wywołującego, opiekunowie i relacje. Bez pól zadłużenia.' }),

  Enrollment: strictObject({
    id: ref('EntityId'), studentId: ref('EntityId'), schoolYearId: ref('EntityId'), classId: ref('EntityId'),
  }),
  StudentHouseholdMembership: strictObject({
    id: ref('EntityId'), studentId: ref('EntityId'), householdId: ref('EntityId'), isPrimary: { type: 'boolean' }, startsOn: ref('IsoDate'),
  }),

  GuardianContactRequest: requestObject({
    email: {
      anyOf: [{ type: 'string', maxLength: 254 }, { type: 'null' }],
      description: 'Nowy e-mail (normalizowany do małych liter); null albo pusty tekst usuwa adres.',
    },
    contactAllowed: { type: 'boolean' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['reason'], { anyOf: [{ required: ['email'] }, { required: ['contactAllowed'] }] }),
  IdentityRequest: requestObject({
    firstName: PERSON_NAME,
    lastName: PERSON_NAME,
    reason: REASON,
    dataRequestId: {
      anyOf: [{ type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }, { type: 'null' }],
      description: 'Żądanie sprostowania z rejestru (UUID, małe litery); wyłącznie admin (D-07).',
    },
    confirmPersonalData: CONFIRM,
  }, ['reason'], { anyOf: [{ required: ['firstName'] }, { required: ['lastName'] }] }),
  RelationContactRequest: requestObject({
    contactAllowed: { type: 'boolean' }, reason: REASON, confirmPersonalData: CONFIRM,
  }, ['contactAllowed', 'reason']),
  EnrollmentRequest: requestObject({
    schoolYearId: ref('Id'),
    classId: { ...ref('Id'), description: 'Klasa w zakresie wywołującego, z tego samego roku.' },
    effectiveOn: { ...ref('IsoDate'), description: 'Data zmiany zapisywana w historii przypisań.' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'classId', 'effectiveOn', 'reason']),
  EnrollmentEndRequest: requestObject({
    endedOn: { ...ref('IsoDate'), description: 'Ostatni dzień w szkole; może być w przyszłości.' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['endedOn', 'reason']),
  MembershipEndRequest: requestObject({
    endsOn: { ...ref('IsoDate'), description: 'Data zakończenia; nie wcześniej niż początek i nie w zamkniętym roku szkolnym.' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['endsOn', 'reason']),
  StudentHouseholdAddRequest: requestObject({
    householdId: ref('Id'),
    isPrimary: { type: 'boolean', description: 'Domyślnie false; drugie główne gospodarstwo w tym samym czasie daje 409.' },
    startsOn: ref('IsoDate'),
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['householdId', 'startsOn', 'reason']),
};

const CHANGED = { type: 'boolean', description: 'false = stan już był taki (ponowienie, podwójne kliknięcie); bez nowego wpisu historii.' };
const ok = (description, schema) => ({ 200: { description, schema } });

// Wspólne błędy zapisu modułu (bez Idempotency-Key): JSON do 8 KiB, powód, zakres (404 jak nieistniejący).
const FAMILY_WRITE = mergeErrors({
  400: ['invalid_json', 'invalid_reason'],
  403: ['forbidden', 'invalid_origin'],
  404: ['not_found'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
}, PII_ERRORS);
const FAMILY_READ = { 403: ['forbidden'], 404: ['not_found'] };
// Daty zmian opieki i członkostwa sprawdzane względem zamkniętego roku (trigger, 409).
const YEAR_CLOSED = { 409: ['school_year_closed'] };

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/classes': {
    query: { schoolYearId: { schema: ref('Id'), description: 'Zawęża do roku; nie poszerza zakresu wywołującego.' } },
    responses: ok('Klasy widoczne dla wywołującego (od najnowszego roku).', strictObject({ classes: { type: 'array', items: ref('FamilyClass') } })),
    errors: { 400: ['invalid_request'], 403: ['forbidden'] },
  },
  'GET /api/classes/{classId}/students': {
    responses: ok('Uczniowie klasy (bieżące przypisania) z gospodarstwami.', strictObject({
      class: ref('FamilyClassRef'),
      students: { type: 'array', items: ref('FamilyClassStudent') },
    })),
    errors: FAMILY_READ,
  },
  'GET /api/households/{householdId}': {
    responses: ok('Karta gospodarstwa (rodzeństwo, opiekunowie, opieka dzielona).', ref('HouseholdCard')),
    errors: FAMILY_READ,
  },
  'PATCH /api/guardians/{guardianId}/contact': {
    body: ref('GuardianContactRequest'),
    responses: ok('Kontakt opiekuna po zmianie.', strictObject({
      guardian: strictObject({ id: ref('EntityId'), email: nullable({ type: 'string' }), contactAllowed: { type: 'boolean' } }),
      changed: CHANGED,
    })),
    errors: mergeErrors(FAMILY_WRITE, { 400: ['invalid_email', 'invalid_request'], 403: ['guardian_shared_outside_scope'] }),
  },
  'PATCH /api/students/{studentId}/identity': {
    body: ref('IdentityRequest'),
    responses: ok('Imię i nazwisko ucznia po sprostowaniu (historia w identity_changes).', strictObject({
      student: strictObject({ id: ref('EntityId'), firstName: { type: 'string' }, lastName: { type: 'string' } }),
      changed: CHANGED,
    })),
    errors: mergeErrors(FAMILY_WRITE, {
      400: ['invalid_data_request_id', 'invalid_person_name', 'invalid_request'],
      404: ['data_request_not_found'],
      409: ['data_request_closed', 'data_request_identity_not_verified', 'data_request_kind_not_rectification', 'data_request_subject_mismatch'],
    }),
  },
  'PATCH /api/guardians/{guardianId}/identity': {
    body: ref('IdentityRequest'),
    responses: ok('Imię i nazwisko opiekuna po sprostowaniu (historia w identity_changes).', strictObject({
      guardian: strictObject({ id: ref('EntityId'), firstName: { type: 'string' }, lastName: { type: 'string' } }),
      changed: CHANGED,
    })),
    errors: mergeErrors(FAMILY_WRITE, {
      400: ['invalid_data_request_id', 'invalid_person_name', 'invalid_request'],
      403: ['guardian_shared_outside_scope'],
      404: ['data_request_not_found'],
      409: ['data_request_closed', 'data_request_identity_not_verified', 'data_request_kind_not_rectification', 'data_request_subject_mismatch'],
    }),
  },
  'PATCH /api/guardians/{guardianId}/students/{studentId}': {
    body: ref('RelationContactRequest'),
    responses: ok('Zgoda na kontakt w relacji opiekun–dziecko (#190).', strictObject({
      relation: strictObject({ guardianId: ref('EntityId'), studentId: ref('EntityId'), contactAllowed: { type: 'boolean' } }),
      guardianContactAllowed: { type: 'boolean', description: 'Zgoda opiekuna; kampania wymaga obu zgód.' },
      changed: CHANGED,
    })),
    errors: mergeErrors(FAMILY_WRITE, { 400: ['invalid_request'], 409: ['relation_ended'] }),
  },
  'POST /api/students/{studentId}/enrollments': {
    body: ref('EnrollmentRequest'),
    responses: {
      201: {
        description: 'Nowe przypisanie ucznia do klasy w roku.',
        schema: strictObject({ enrollment: ref('Enrollment'), changed: { const: true } }),
      },
      200: { description: 'Zmiana klasy w roku albo ta sama klasa (`changed: false`).', schema: strictObject({ enrollment: ref('Enrollment'), changed: CHANGED }) },
    },
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, {
      400: ['class_year_mismatch', 'invalid_effective_on', 'invalid_request'],
      404: ['class_not_found'],
    }),
  },
  'POST /api/students/{studentId}/enrollments/{enrollmentId}/end': {
    body: ref('EnrollmentEndRequest'),
    responses: ok('Zakończone przypisanie (odejście ze szkoły, #86); ponowienie zwraca zapisaną datę.', strictObject({
      enrollment: strictObject({ id: ref('EntityId'), studentId: ref('EntityId'), endedOn: ref('IsoDate') }),
      changed: CHANGED,
    })),
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, { 400: ['invalid_ended_on'] }),
  },
  'POST /api/guardians/{guardianId}/students/{studentId}/end': {
    body: ref('MembershipEndRequest'),
    responses: ok('Zakończona relacja opiekun–dziecko; relacje z rodzeństwem i drugi opiekun bez zmian.', strictObject({
      relation: strictObject({ guardianId: ref('EntityId'), studentId: ref('EntityId'), endsOn: ref('IsoDate') }),
      changed: CHANGED,
      campaignsToReview: {
        type: 'array', items: ref('EntityId'),
        description: 'Kampanie zatwierdzone lub w wysyłce, w których opiekun jest adresatem (do przeglądu); puste przy `changed: false`.',
      },
    })),
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, { 400: ['invalid_ended_on'] }),
  },
  'POST /api/students/{studentId}/households/{membershipId}/end': {
    body: ref('MembershipEndRequest'),
    responses: ok('Zakończone członkostwo ucznia w gospodarstwie.', strictObject({
      membership: strictObject({ id: ref('EntityId'), studentId: ref('EntityId'), householdId: ref('EntityId'), endsOn: ref('IsoDate') }),
      changed: CHANGED,
      withoutPrimaryHousehold: { type: 'boolean', description: 'true: uczeń nie ma już bieżącego gospodarstwa głównego (wypada z kampanii i kartek).' },
    })),
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, { 400: ['invalid_ended_on'] }),
  },
  'POST /api/guardians/{guardianId}/households/{membershipId}/end': {
    body: ref('MembershipEndRequest'),
    responses: ok('Zakończone członkostwo opiekuna w gospodarstwie (tylko zakres szeroki).', strictObject({
      membership: strictObject({ id: ref('EntityId'), guardianId: ref('EntityId'), householdId: ref('EntityId'), endsOn: ref('IsoDate') }),
      changed: CHANGED,
      withoutHousehold: { type: 'boolean', description: 'true: opiekun nie ma już żadnego bieżącego gospodarstwa.' },
    })),
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, { 400: ['invalid_ended_on'] }),
  },
  'POST /api/students/{studentId}/households': {
    body: ref('StudentHouseholdAddRequest'),
    responses: {
      201: { description: 'Nowe członkostwo ucznia w gospodarstwie.', schema: strictObject({ membership: ref('StudentHouseholdMembership'), changed: { const: true } }) },
      200: {
        description: 'Ponowienie: to samo członkostwo już dodane przez API (`changed: false`, ten sam identyfikator).',
        schema: strictObject({ membership: ref('StudentHouseholdMembership'), changed: { const: false } }),
      },
    },
    errors: mergeErrors(FAMILY_WRITE, YEAR_CLOSED, {
      400: ['invalid_effective_on', 'invalid_request'],
      409: ['student_household_overlap'],
    }),
  },
};
