// Dziennik audytu w PostgreSQL. Tabela audit_events jest tylko do dopisywania
// (trigger z migracji 0004). Wywołuj insertAuditEvent w tej samej transakcji,
// co zmiana, której dotyczy zdarzenie.
//
// Metadane nie mogą zawierać danych osobowych: adresów e-mail, imion,
// nazwisk, telefonów, adresów ani numerów kont. Zapisuj identyfikatory.

const FORBIDDEN_KEY = /(e-?mail|first_?name|last_?name|display_?name|full_?name|phone|telefon|address|adres|iban|secret|password|haslo|^token$)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
// #184 pkt 3: pola, które w praktyce zawsze niosą kod, nigdy dowolny tekst
// (np. powód zdarzenia workera/loginu — nie treść wpisaną przez człowieka).
// Wolny tekst (np. powód korekty zapisany przez skarbnika) należy trzymać
// wyłącznie w tabeli biznesowej, nie w metadanych audytu.
const CODE_ONLY_KEYS = new Set(['reason', 'code', 'status', 'event']);
const CODE_PATTERN = /^[a-z0-9_]{1,60}$/;

// #174: zdarzenia dotyczące obiektów przypisanych do roku szkolnego muszą
// nieść metadata.schoolYearId, inaczej eksport roczny (src/pg/export.js,
// auditScope) przypisuje je do roku wg daty zapisu zamiast roku obiektu
// (wpłata/korekta zapisana po zamknięciu roku trafia do eksportu złego roku).
// Część 1 (#174) ograniczyła to do tras finansowych i uzgodnień; część 2
// dokłada e-mail (kampanie i zdarzenia workera), zebrania/uchwały i wydarzenia
// — wszystkie oparte na obiekcie ze szkoły z kolumną school_year_id — oraz
// aktualności, ale wyłącznie 'news_post.' (news_photo NIE ma school_year_id
// w schemacie: biblioteka zdjęć nie jest przypisana do roku, więc zdarzenia
// 'news_photo.*' zostają bez wymogu, jak sesje/MFA/konta).
// Część 3 (#174): rodziny finansowe z podkreśleniem (np. 'ledger_opening_balance.'
// z bilansu otwarcia, 'ledger_category.', 'payment_reference.',
// 'payment_instructions.') oraz zamknięcie roku i raporty roczne — wszystkie
// dotyczą obiektu jednego roku i już niosły rok, ale nic tego nie wymuszało.
// FINANCIAL_FAMILY obejmuje także przyszłe rodziny 'payment_*.'/'ledger_*.'/
// 'reconciliation_*.' — nowa trasa nie ominie wymogu nową nazwą akcji.
const SCHOOL_YEAR_REQUIRED_PREFIXES = [
  'payment.', 'ledger.', 'reconciliation.', 'email.', 'meeting.', 'resolution.', 'event.', 'news_post.',
  'year_close.', 'report.',
];
export const FINANCIAL_FAMILY = /^(payment|ledger|reconciliation)(_[a-z_]+)?\./;
// 'email.address_suppressed' dotyczy ADRESU (email_suppressions, bez
// school_year_id — obowiązuje niezależnie od roku), nie jednej kampanii:
// webhook dostawcy może przyjść dla adresu bez żadnej pasującej wysyłki w
// toku. Zapisujemy schoolYearId, gdy dało się je odnaleźć przez powiązany
// wiersz kolejki, ale świadomie tego nie wymagamy (patrz src/pg/routes/email.js).
// 'email.webhook.previous_secret_used' dotyczy ROTACJI SEKRETU webhooka
// (bezpieczeństwo integracji Brevo), nie jednej kampanii ani jednego roku —
// nie ma tu żadnego obiektu ze szkoły, z którego dałoby się wziąć rok.
const SCHOOL_YEAR_EXEMPT_ACTIONS = new Set(['email.address_suppressed', 'email.webhook.previous_secret_used']);

export function requiresSchoolYearId(action) {
  return (FINANCIAL_FAMILY.test(action) || SCHOOL_YEAR_REQUIRED_PREFIXES.some((prefix) => action.startsWith(prefix)))
    && !SCHOOL_YEAR_EXEMPT_ACTIONS.has(action);
}

export function assertNoPii(metadata) {
  const visit = (value, path) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (EMAIL_LIKE.test(value)) throw new Error(`audit_metadata_pii:${path}`);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEY.test(key)) throw new Error(`audit_metadata_pii:${path}.${key}`);
        if (CODE_ONLY_KEYS.has(key) && typeof item === 'string' && !CODE_PATTERN.test(item)) {
          throw new Error(`audit_metadata_pii:${path}.${key}`);
        }
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(metadata, 'metadata');
}

export async function insertAuditEvent(executor, { actorId = null, action, entityType, entityId, metadata = {} }) {
  if (!action || !entityType || !entityId) throw new Error('audit_event_incomplete');
  if (requiresSchoolYearId(action) && !metadata?.schoolYearId) {
    // Błąd programisty (brak roku w metadanych zdarzenia finansowego/uzgodnienia)
    // ma wyjść w testach, nie po cichu popsuć eksport roczny — patrz #174.
    throw new Error(`audit_event_missing_school_year:${action}`);
  }
  assertNoPii(metadata);
  const id = crypto.randomUUID();
  await executor.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, actorId, action, entityType, String(entityId), JSON.stringify(metadata)],
  );
  return id;
}
