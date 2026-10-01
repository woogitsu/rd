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
// #184 pkt 3: pola wolnego tekstu są zakazane w metadanych niezależnie od
// wartości (taka wartość nie musi wyglądać jak e-mail ani imię). Decyduje
// ostatni człon nazwy klucza (camelCase/snake_case): `correctionNote` i
// `NOTE` odpadają, `contentHash`, `subjectType` i `context` przechodzą.
// Liczba/wartość logiczna/null pod takim kluczem przechodzi: eksport zapisuje
// liczniki wierszy pod nazwami tabel (np. `audit_review_notes`).
const FREE_TEXT_KEY_WORDS = new Set([
  'note', 'notes', 'title', 'body', 'description', 'subject', 'author', 'comment', 'message', 'content', 'text',
]);
function isFreeTextKey(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && FREE_TEXT_KEY_WORDS.has(words[words.length - 1]);
}

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
  'year_close.', 'report.', 'audit_review.',
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
        // Licznik pod nazwą tabeli (np. rowCounts.audit_review_notes = 3) nie jest tekstem.
        if (isFreeTextKey(key) && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) throw new Error(`audit_metadata_pii:${path}.${key}`);
        if (CODE_ONLY_KEYS.has(key) && typeof item === 'string' && !CODE_PATTERN.test(item)) {
          throw new Error(`audit_metadata_pii:${path}.${key}`);
        }
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(metadata, 'metadata');
}

export async function insertAuditEvent(executor, { actorId = null, action, entityType, entityId, metadata = /** @type {Record<string, any>} */ ({}) }) {
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

// #181: metadane zdarzenia w widoku dziennika (GET /api/admin/audit*). Zapis
// już odrzuca e-maile i klucze z danymi osobowymi (assertNoPii), ale dziennik
// jest trwały — starsze wiersze (sprzed #184) i przyszłe pomyłki nie mogą
// wyciec przez widok. Widok przepuszcza wyłącznie liczby, wartości logiczne,
// null oraz napisy w kształcie identyfikatora/kodu/daty (bez spacji, bez „@”).
// Wolny tekst (np. powód korekty, notatka, tytuł) i klucze z listy danych
// osobowych są pomijane; `redactedFields` podaje same ścieżki kluczy (bez
// wartości), żeby było widać, że coś ukryto.
const FREE_TEXT_KEY = /(note|notes|description|title|body|text|message|comment|subject|name|label|author|details?)$/i;
const VIEW_SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9_.:+\-/]{0,127}$/;

export function auditMetadataForView(raw) {
  let metadata = raw;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { return { metadata: {}, redactedFields: ['metadata'] }; }
  }
  const redactedFields = [];
  const visit = (value, path) => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return { keep: true, value };
    if (typeof value === 'string') return VIEW_SAFE_STRING.test(value) ? { keep: true, value } : { keep: false };
    if (Array.isArray(value)) {
      const items = [];
      value.forEach((item, index) => {
        const result = visit(item, `${path}[${index}]`);
        if (result.keep) items.push(result.value); else redactedFields.push(`${path}[${index}]`);
      });
      return { keep: true, value: items };
    }
    if (typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const keyPath = path ? `${path}.${key}` : key;
        if (!VIEW_SAFE_STRING.test(key) || FORBIDDEN_KEY.test(key) || FREE_TEXT_KEY.test(key)) {
          redactedFields.push(VIEW_SAFE_STRING.test(key) ? keyPath : `${path || 'metadata'}.?`);
          continue;
        }
        const result = visit(item, keyPath);
        if (result.keep) out[key] = result.value; else redactedFields.push(keyPath);
      }
      return { keep: true, value: out };
    }
    return { keep: false };
  };
  const result = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? visit(metadata, '') : { value: {} };
  return { metadata: result.value ?? {}, redactedFields };
}
