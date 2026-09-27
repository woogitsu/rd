// Dziennik audytu w PostgreSQL. Tabela audit_events jest tylko do dopisywania
// (trigger z migracji 0004). Wywołuj insertAuditEvent w tej samej transakcji,
// co zmiana, której dotyczy zdarzenie.
//
// Metadane nie mogą zawierać danych osobowych: adresów e-mail, imion,
// nazwisk, telefonów, adresów ani numerów kont. Zapisuj identyfikatory.

const FORBIDDEN_KEY = /(e-?mail|first_?name|last_?name|display_?name|full_?name|phone|telefon|address|adres|iban|secret|password|haslo|^token$)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;

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
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(metadata, 'metadata');
}

export async function insertAuditEvent(executor, { actorId = null, action, entityType, entityId, metadata = {} }) {
  if (!action || !entityType || !entityId) throw new Error('audit_event_incomplete');
  assertNoPii(metadata);
  const id = crypto.randomUUID();
  await executor.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, actorId, action, entityType, String(entityId), JSON.stringify(metadata)],
  );
  return id;
}
