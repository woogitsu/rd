// D-09 (#137), wariant (b): odczyt i eksport księgi oraz dokumentów finansowych roku dla roli `audit`
// (Komisja Rewizyjna) — wyłącznie odczyt, za flagą konfiguracji AUDIT_LEDGER_READ (domyślnie wyłączona).
// Flaga włączona wartością `1` albo `true`; każda inna wartość (także brak) = stan dotychczasowy:
// `audit` czyta tylko raport KR (`GET /api/reports/audit`) i prowadzi uwagi (audit-reviews).
//
// Zakres przy włączonej fladze (kontrola po stronie serwera, w trasach):
//   * księga: GET /api/ledger (lista), /api/ledger/categories, /api/ledger/summary,
//     /api/ledger/export.csv, /api/ledger/export.xlsx;
//   * dokumenty `kind='financial'`: GET /api/documents (lista), /api/documents/{id}, /api/documents/{id}/content;
//   * wyłącznie przydział `audit` bez klasy, w roku danych, z potwierdzonym MFA (jak raport KR).
// Nie obejmuje: wpłat, kart gospodarstw, eksportu danych rodzin, historii obiektu ani żadnego zapisu.
//
// Dane rodzin: wpis księgi powiązany z wpłatą (`payment_entry_id`) pochodzi od gospodarstwa, a jego opis
// i źródło wpisuje skarbnik jako wolny tekst. Dla `audit` taki wpis zachowuje kwotę, datę, kategorię,
// kierunek i identyfikator wpisu, ale opis oraz źródło są zredagowane, a identyfikator wpłaty (klucz do
// gospodarstwa) jest ukryty — zostaje tylko znacznik `paymentLinked`.

export const AUDIT_LEDGER_READ_ROLES = Object.freeze(['audit']);

// Opis wpisu powiązanego z wpłatą, widoczny dla audit (zamiast wolnego tekstu skarbnika).
export const REDACTED_PAYMENT_DESCRIPTION = 'Wpłata rodziny (opis i źródło zredagowane)';
// Znacznik w kolumnie `id_wplaty` eksportu zamiast identyfikatora wpłaty.
export const REDACTED_PAYMENT_CELL = 'wplata';

// Dokumenty finansowe, które audit może czytać: tylko kategorie bez danych płatników (lista dozwolona).
// Potwierdzenia przelewów, wyciągi bankowe, dokumenty bez kategorii i „inne” zawierają albo mogą
// zawierać dane rodzin (nazwiska w tytule przelewu) — treść pliku nie podlega redakcji, więc są ukryte.
// Dokument powiązany z wpłatą (`linked_entity_type = 'payment_entry'`) jest ukryty niezależnie od kategorii.
export const AUDIT_READABLE_DOCUMENT_CATEGORIES = Object.freeze([
  'faktura', 'umowa', 'uchwala', 'protokol', 'sprawozdanie_rewizyjne',
]);

export function auditLedgerReadEnabled(env) {
  const raw = env && Object.hasOwn(env, 'AUDIT_LEDGER_READ') ? env.AUDIT_LEDGER_READ : process.env.AUDIT_LEDGER_READ;
  return raw === '1' || raw === 'true';
}
