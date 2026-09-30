// #82/#594: adnotacja przy wydatku „bez dowodu” w raporcie Komisji Rewizyjnej
// (HTML, XLSX, panel audit/). `evidenceStatus: 'voided'` = wydatek miał
// dokumenty, ale żaden nie ma aktualnej wersji (unieważniony sam albo na
// końcu łańcucha zastąpień). Brak pola = wydatek bez żadnego dokumentu.
export function evidenceNote(item) {
  return item?.evidenceStatus === 'voided' ? 'dowód unieważniony' : '';
}
