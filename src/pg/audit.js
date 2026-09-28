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
// AUDIT_SCOPE) przypisuje je do roku wg daty zapisu zamiast roku obiektu
// (wpłata/korekta zapisana po zamknięciu roku trafia do eksportu złego roku).
// Zakres przedrostków ograniczony świadomie do tras finansowych i uzgodnień
// (#174, część S z propozycji issue) — e-mail/zebrania/wydarzenia/aktualności
// zostają poza tym sprawdzeniem, do osobnego PR.
const SCHOOL_YEAR_REQUIRED_PREFIXES = ['payment.', 'ledger.', 'reconciliation.'];

function requiresSchoolYearId(action) {
  return SCHOOL_YEAR_REQUIRED_PREFIXES.some((prefix) => action.startsWith(prefix));
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
