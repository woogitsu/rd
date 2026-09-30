// #82/#594: aktualna wersja dokumentu wg łańcucha zastąpień — JEDNA reguła
// dla listy księgi (GET /api/ledger, pole `attachments`), raportu Komisji
// Rewizyjnej (sekcja „Dowody wydatków”) i ostrzeżenia zamknięcia roku
// `expenses_without_evidence`. Nie kopiuj tego zapytania — użyj
// documentChainCtes() albo documentStatuses().
//
// Powiązanie dokumentu z wpisem (source_document_id, documents.linked_entity_*)
// zostaje przy pierwotnym dokumencie — to historia; aktualną wersję wyznacza
// łańcuch zastąpień (document_status_events.replacement_document_id) aż do
// dokumentu bez zdarzenia (aktualny) albo unieważnionego (brak aktualnej
// wersji → NULL). Zastępca ma zawsze ten sam rodzaj, rok i klasę
// (routes/documents.js), więc łańcuch nie wychodzi poza rok, do którego
// sprawdzono uprawnienia. Łańcuch jest acykliczny (guard 0066: zastępca musi
// być aktywny, co najwyżej jedno zdarzenie na dokument); limit głębokości to
// tylko bezpiecznik.
export const DOCUMENT_CHAIN_LIMIT = 50;

// Fragment listy CTE (do użycia po `WITH RECURSIVE`, może stać po innych CTE
// tej samej listy). `startSql` to zapytanie zwracające JEDNĄ kolumnę
// z identyfikatorami dokumentów (bez powtórzeń nie jest wymagane). Wynik:
// CTE `document_current(start_id, start_status, current_document_id)`, gdzie
// start_status ∈ active | superseded | voided, a current_document_id to koniec
// łańcucha, gdy jest aktywny, albo NULL. Pośrednie CTE: document_chain.
export function documentChainCtes(startSql) {
  return `document_chain(start_id, doc_id, depth) AS (
       SELECT start_ids.id, start_ids.id, 0 FROM (${startSql}) AS start_ids(id)
       UNION ALL
       SELECT document_chain.start_id, chain_event.replacement_document_id, document_chain.depth + 1
         FROM document_chain
         JOIN document_status_events chain_event
           ON chain_event.document_id = document_chain.doc_id AND chain_event.action = 'superseded'
        WHERE document_chain.depth < ${DOCUMENT_CHAIN_LIMIT}
     ), document_current AS (
       SELECT DISTINCT ON (document_chain.start_id)
              document_chain.start_id,
              COALESCE(start_event.action, 'active') AS start_status,
              CASE WHEN last_event.action IS NULL THEN document_chain.doc_id END AS current_document_id
         FROM document_chain
         LEFT JOIN document_status_events last_event ON last_event.document_id = document_chain.doc_id
         LEFT JOIN document_status_events start_event ON start_event.document_id = document_chain.start_id
        ORDER BY document_chain.start_id, document_chain.depth DESC
     )`;
}

// Stan każdego dokumentu z listy i jego aktualna wersja:
// Map<id, { documentId, status, currentDocumentId }>. Jedno zapytanie.
export async function documentStatuses(db, ids) {
  const unique = [...new Set(ids)];
  const result = new Map();
  if (!unique.length) return result;
  const { rows } = await db.query(
    `WITH RECURSIVE ${documentChainCtes('SELECT unnest($1::text[])')}
     SELECT start_id, start_status, current_document_id FROM document_current`,
    [unique],
  );
  for (const row of rows) {
    result.set(row.start_id, {
      documentId: row.start_id,
      status: row.start_status,
      currentDocumentId: row.current_document_id ?? null,
    });
  }
  return result;
}
