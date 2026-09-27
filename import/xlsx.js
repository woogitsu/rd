// Odczyt XLSX bez Web Workera z adresu blob: (#188).
// read-excel-file rozpakowuje archiwum asynchronicznym unzip() z fflate, który pozycje
// większe niż 512 KiB (np. sheet1.xml albo sharedStrings.xml listy całej szkoły) oddaje
// do new Worker(URL.createObjectURL(...)). CSP serwera Node (script-src 'self', bez
// worker-src) blokuje taki worker, a strona zostaje na „Odczyt pliku…”.
// Dlatego plik jest najpierw rozpakowany synchronicznie w głównym wątku i przepakowany
// bez kompresji (metoda „stored”). Pozycje stored fflate zwraca od razu, bez workera,
// a parser biblioteki dostaje te same pliki XML co wcześniej. CSP pozostaje bez zmian.
import { unzipSync, zipSync } from 'fflate';
import { readSheet } from 'read-excel-file/browser';

// Te same pozycje, które czyta read-excel-file (filterZipArchiveEntry): XML i relacje.
const isSheetPart = (name) => name.endsWith('.xml') || name.endsWith('.xml.rels');

export class XlsxReadError extends Error {}

export function repackXlsxStored(arrayBuffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(arrayBuffer), { filter: (file) => isSheetPart(file.name) });
  } catch {
    throw new XlsxReadError('Plik nie jest poprawnym arkuszem .xlsx. Zapisz go ponownie w Excelu albo jako CSV.');
  }
  const stored = zipSync(files, { level: 0 });
  return stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
}

// Zwraca wiersze pierwszego arkusza (tablica tablic), jak readSheet(file).
export async function readXlsxRows(arrayBuffer, read = readSheet) {
  const stored = repackXlsxStored(arrayBuffer);
  try {
    return await read(stored);
  } catch {
    throw new XlsxReadError('Nie udało się odczytać arkusza .xlsx. Zapisz go ponownie w Excelu albo jako CSV.');
  }
}
