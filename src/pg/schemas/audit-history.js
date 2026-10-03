// Schematy OpenAPI dla modułu `audit-history` (src/pg/routes/audit-history.js, #181), #160 etap 13: historia jednego
// obiektu finansowego albo kampanii e-mail dla zarządu i skarbnika. Pisane ręcznie na podstawie `entityHistory`
// i `auditEventForView` (src/pg/routes/admin.js, wariant `withEntity: false`); trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * macierz tras ma cztery operacje — rodzaj obiektu jest stałą częścią ścieżki (`payment_entry`, `ledger_entry`,
//     `reconciliation`, `email_campaign`); trasa przyjmuje dowolny segment rodzaju, ale nieznany daje 400
//     `invalid_entity_type` poza tymi operacjami (nie ma go w specyfikacji);
//   * dostęp: zarząd i skarbnik z MFA, przydział bez klasy na rok OBIEKTU (wariant zachowawczy D-08/D-09); admin
//     (ma własną trasę w module `admin`), Komisja Rewizyjna, dyrekcja, przedstawiciel i przydział klasowy → 403
//     `forbidden` (trasa sama nie rozróżnia powodu MFA — `mfa_required`/`mfa_enrollment_required` daje bramka routera);
//   * obiekt nieistniejący albo z roku bez przydziału → 404 `not_found` (nieodróżnialne, SR-07); zły identyfikator
//     w ścieżce → 400 `invalid_request` (po sprawdzeniu roli);
//   * zdarzenia wyłącznie z domeny obiektu (`finance` albo `email`), od najstarszego; metadane bez wolnego tekstu,
//     e-maili i imion (auditMetadataForView), `redactedFields` wskazuje pominięte pola. Odczyt sam zapisuje
//     `audit.viewed` i ma `Cache-Control: no-store`.
import { nullable, ref, strictObject } from './common.js';

export const name = 'audit-history';

const STRING = { type: 'string' };
const ENTITY_TYPES = ['payment_entry', 'ledger_entry', 'reconciliation', 'email_campaign'];

export const components = {
  AuditHistoryEvent: strictObject({
    id: ref('EntityId'),
    actorId: nullable({ ...ref('EntityId'), description: 'Członek Rady; null — zdarzenie systemowe (worker, webhook).' }),
    action: STRING,
    domain: { type: 'string', enum: ['finance', 'email'], description: 'Domena obiektu: `finance` (wpłata, wpis księgi, uzgodnienie) albo `email` (kampania).' },
    actorKind: { type: 'string', enum: ['user', 'system', 'anonymous'] },
    source: nullable({
      type: 'string', enum: ['email_worker', 'brevo_webhook', 'unsubscribe_link', 'login', 'bootstrap', 'system'],
      description: 'Pochodzenie zdarzenia bez aktora; null dla zdarzeń użytkownika.',
    }),
    occurredAt: ref('IsoDateTime'),
    metadata: {
      type: 'object',
      description: 'Metadane bez wolnego tekstu i danych osobowych (auditMetadataForView): liczby, wartości logiczne i napisy '
        + 'w kształcie identyfikatora/kodu/daty.',
    },
    redactedFields: { type: 'array', items: STRING, description: 'Ścieżki pominiętych pól metadanych (bez wartości).' },
  }, [], { description: 'Zdarzenie dziennika w historii obiektu (#181): bez rodzaju i identyfikatora obiektu (są w odpowiedzi).' }),
};

const history = (entityType) => strictObject({
  entityType: { const: entityType },
  entityId: ref('EntityId'),
  events: { type: 'array', items: ref('AuditHistoryEvent'), description: 'Zdarzenia obiektu i powiązane (korekta, przypisanie, dopasowanie …), od najstarszego.' },
});

const ERRORS = {
  400: ['invalid_request'],
  403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'],
  404: ['not_found'],
};

const LABELS = {
  payment_entry: 'wpłaty',
  ledger_entry: 'wpisu księgi',
  reconciliation: 'uzgodnienia wyciągu',
  email_campaign: 'kampanii e-mail',
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = Object.fromEntries(ENTITY_TYPES.map((entityType) => [
  `GET /api/audit/entity/${entityType}/{id}`,
  {
    responses: { 200: { description: `Historia ${LABELS[entityType]} (zdarzenia domeny obiektu, od najstarszego).`, schema: history(entityType) } },
    errors: ERRORS,
  },
]));
