// Odczyt XLSX bez Web Workera z adresu blob: (#188).
// read-excel-file rozpakowuje archiwum asynchronicznym unzip() z fflate, który pozycje
// większe niż 512 KiB (np. sheet1.xml albo sharedStrings.xml listy całej szkoły) oddaje
// do new Worker(URL.createObjectURL(...)). CSP serwera Node (script-src 'self', bez
// worker-src) blokuje taki worker, a strona zostaje na „Odczyt pliku…”.
// Dlatego plik jest najpierw rozpakowany synchronicznie w głównym wątku i przepakowany
// bez kompresji (metoda „stored”). Pozycje stored fflate zwraca od razu, bez workera,
// a parser biblioteki dostaje te same pliki XML co wcześniej. CSP pozostaje bez zmian.
import { unzipSync, zipSync } from 'fflate';
import readXlsxFile, { readSheet } from 'read-excel-file/browser';

// Te same pozycje, które czyta read-excel-file (filterZipArchiveEntry): XML i relacje.
const isSheetPart = (name) => name.endsWith('.xml') || name.endsWith('.xml.rels');

export class XlsxReadError extends Error {}

// #88: ochrona przed „zip bomb”. Limity liczone na podstawie nagłówków archiwum PRZED
// rozpakowaniem (filter w unzipSync dostaje deklarowany rozmiar). fflate nie wypisze
// więcej bajtów niż zadeklarowano w nagłówku, więc kłamiący nagłówek nie omija limitu.
export const XLSX_LIMITS = Object.freeze({
  maxEntries: 1000,                    // wszystkie wpisy w archiwum
  maxTotalBytes: 50 * 1024 * 1024,     // suma rozpakowanych XML i relacji
  maxEntryBytes: 50 * 1024 * 1024,     // pojedynczy wpis (np. sheet1.xml)
});

export function repackXlsxStored(arrayBuffer, limits = XLSX_LIMITS) {
  let files;
  let entries = 0;
  let totalBytes = 0;
  let tooBig = false;
  try {
    files = unzipSync(new Uint8Array(arrayBuffer), {
      filter: (file) => {
        entries += 1;
        if (entries > limits.maxEntries) { tooBig = true; throw new XlsxReadError('limit'); }
        if (!isSheetPart(file.name)) return false;
        totalBytes += file.originalSize;
        if (file.originalSize > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) { tooBig = true; throw new XlsxReadError('limit'); }
        return true;
      },
    });
  } catch {
    if (tooBig) throw new XlsxReadError('Plik .xlsx jest zbyt duży po rozpakowaniu albo ma zbyt wiele elementów (limit 50 MB danych arkusza). Zapisz dane jako CSV.');
    throw new XlsxReadError('Plik nie jest poprawnym arkuszem .xlsx. Zapisz go ponownie w Excelu albo jako CSV.');
  }
  const stored = zipSync(files, { level: 0 });
  return stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
}

// Zwraca wiersze wskazanego arkusza (tablica tablic), domyślnie pierwszego —
// jak readSheet(file). `sheet` to nazwa albo numer od 1 (jak w read-excel-file).
export async function readXlsxRows(arrayBuffer, sheet, read = readSheet) {
  const stored = repackXlsxStored(arrayBuffer);
  try {
    return await read(stored, sheet);
  } catch {
    throw new XlsxReadError('Nie udało się odczytać arkusza .xlsx. Zapisz go ponownie w Excelu albo jako CSV.');
  }
}

// Lista arkuszy z danymi (#88: wybór arkusza przed mapowaniem — plik może mieć
// arkusz „Instrukcja” przed danymi uczniów). Czyta wszystkie arkusze naraz, w
// granicach tych samych limitów rozmiaru pliku (5 MB) co pojedynczy odczyt.
export async function readXlsxSheets(arrayBuffer, readAll = readXlsxFile) {
  const stored = repackXlsxStored(arrayBuffer);
  let sheets;
  try {
    sheets = await readAll(stored);
  } catch {
    throw new XlsxReadError('Nie udało się odczytać arkusza .xlsx. Zapisz go ponownie w Excelu albo jako CSV.');
  }
  if (!sheets.length) throw new XlsxReadError('Plik nie zawiera żadnego arkusza.');
  return sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data }));
}
