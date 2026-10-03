// Schematy OpenAPI dla modułu `session` (src/pg/routes/session.js): stan sesji, przydziały
// ról i wylogowanie. #160 etap 3. Logowanie hasłem (`login`) i MFA (`mfa`) to osobne moduły
// macierzy tras — tu nie są opisane.
//
// Kształt odpowiedzi wynika z `loadSession` (src/pg/auth.js; `mfaVerifiedAt` jest celowo
// pomijane w odpowiedzi, #150) i `loadActiveGrants` (src/pg/authorization.js).
import { ROLES } from '../auth.js';
import { nullable, ref, strictObject } from './common.js';

export const name = 'session';

export const components = {
  Role: {
    type: 'string', enum: [...ROLES],
    description: 'Rola przydziału. Zakres uprawnień ról to założenie D-08/D-09 (docs/AUTHORIZATION.md), do zatwierdzenia.',
  },
  SessionUser: strictObject({
    id: ref('EntityId'),
    email: { type: 'string', minLength: 1, description: 'Adres konta (małe litery).' },
    displayName: { type: 'string' },
  }),
  Session: strictObject({
    sessionId: ref('EntityId'),
    expiresAt: ref('IsoDateTime'),
    mfaVerified: { type: 'boolean', description: 'true, gdy w tej sesji potwierdzono drugi składnik.' },
    user: ref('SessionUser'),
    writeMode: {
      type: 'string', enum: ['normal', 'read_only'],
      description: 'read_only = okno serwisowe (#143); panele wyłączają przyciski zapisu, a serwer i tak odrzuca zapis.',
    },
    capabilities: strictObject({ auditLedgerRead: { const: true } }, [], {
      description: 'Wyłącznie konto z rolą `audit` (MFA, przydział bez klasy) przy włączonej fladze AUDIT_LEDGER_READ (D-09, #137). '
        + 'W pozostałych przypadkach pola nie ma wcale.',
    }),
  }, ['capabilities']),
  RoleGrant: strictObject({
    role: ref('Role'),
    classId: nullable(ref('EntityId')),
    schoolYearId: nullable(ref('EntityId')),
    expiresAt: nullable(ref('IsoDateTime')),
  }, [], { description: 'Aktywny przydział (bez cofniętych i wygasłych).' }),
  AccessState: strictObject({
    grants: { type: 'array', items: ref('RoleGrant') },
    hasActiveRole: { type: 'boolean', description: 'true, gdy co najmniej jeden przydział ma rolę z działającymi trasami (#176).' },
    mfaRequired: {
      const: true,
      description: 'Obecne tylko, gdy bramka MFA zatrzymałaby sesję (#189): wtedy `grants` jest puste, a `hasActiveRole` = false.',
    },
  }, ['mfaRequired']),
};

// Macierz tras przypisuje GET /api/session i /api/access status odmowy 403 (`deny: 403`), ale trasy
// są dostępne dla każdego zalogowanego i zwolnione z bramki MFA — 403 nie występuje. Pusta lista kodów
// dokumentuje to jawnie (klient kontraktu oblałby każdą odpowiedź 403).
const NEVER_403 = { 403: [] };

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/session': {
    responses: {
      200: { description: 'Stan bieżącej sesji (bez `mfaVerifiedAt`).', schema: ref('Session') },
    },
    errors: NEVER_403,
  },
  'GET /api/access': {
    responses: {
      200: {
        description: 'Aktywne przydziały ról konta. Sesja zatrzymana przez bramkę MFA dostaje pustą listę i `mfaRequired: true`.',
        schema: ref('AccessState'),
      },
    },
    errors: NEVER_403,
  },
  'POST /api/logout': {
    responses: {
      204: { description: 'Sesja (jeśli była) cofnięta, cookie wyczyszczone; bez treści. Bez sesji też 204.' },
    },
    errors: { 403: ['invalid_origin'] },
  },
};
