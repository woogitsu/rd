// Wspólny odczyt plików CSV w przeglądarce (#77): kodowanie i separator.
// Czyste funkcje bez DOM i sieci — używane przez import/ i print/, testowane w tests/csv-decode.test.js.
// TextDecoder z etykietą windows-1250/1252 jest dostępny natywnie w przeglądarkach i w Node (pełne ICU).

export const ENCODINGS = Object.freeze({
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1250': 'Windows-1250 (Excel PL)',
  'windows-1252': 'Windows-1252 (Excel BE/FR)',
});

export const DELIMITERS = Object.freeze({ ';': 'średnik', ',': 'przecinek', '\t': 'tabulator' });

const UNKNOWN_ENCODING = 'Plik ma nieznane kodowanie — zapisz go jako „CSV UTF-8” albo wybierz kodowanie ręcznie.';

// Znaki, które po odczycie jako Windows-1250 zdradzają inne kodowanie źródła:
// ISO-8859-2 (ą→±, ś→¶, ź→Ľ, Ą→ˇ, Ś→¦, Ź→¬) oraz Windows-1252 (è→č, à→ŕ, ì→ě, ò→ň, ø→ř, ù→ů, å→ĺ).
const ISO_8859_2_HINT = /[±¶Ľˇ¦¬]/u;
const WINDOWS_1252_HINT = /[čŕěňřůĺČŔĚŇŘŮĹ]/u;
// U+FFFD (znak zastępczy), NUL (np. UTF-16 bez BOM) albo znaki sterujące C1 — bajty,
// których wybrane kodowanie nie opisuje.
const BROKEN = /[\u0000\uFFFD\u0080-\u009F]/u;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('Nie udało się odczytać pliku.');
}

function decodeWith(encoding, bytes, fatal) {
  try {
    return new TextDecoder(encoding, { fatal, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    if (error instanceof RangeError) throw new Error('Ta przeglądarka nie obsługuje wybranego kodowania.');
    throw error;
  }
}

// decodeCsvBytes(bytes, { encoding }) → { text, encoding, label, bom, warnings }
// encoding: 'auto' (domyślnie) albo klucz z ENCODINGS (ręczny wybór użytkownika).
// Tryb automatyczny: BOM UTF-8 / UTF-16 → odpowiedni dekoder; bez BOM próba UTF-8 z fatal: true,
// przy błędzie Windows-1250. Wynik z U+FFFD lub znakami C1 zawsze kończy się błędem.
export function decodeCsvBytes(input, options = {}) {
  const bytes = toBytes(input);
  const requested = options.encoding ?? 'auto';
  if (requested !== 'auto' && !Object.hasOwn(ENCODINGS, requested)) throw new Error('Nieznane kodowanie pliku.');
  let encoding = requested, bom = false;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) { bom = true; if (requested === 'auto') encoding = 'utf-8'; }
  else if (bytes[0] === 0xFF && bytes[1] === 0xFE) { bom = true; if (requested === 'auto') encoding = 'utf-16le'; }
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { bom = true; if (requested === 'auto') encoding = 'utf-16be'; }

  let text;
  if (encoding === 'auto') {
    try {
      text = decodeWith('utf-8', bytes, true);
      encoding = 'utf-8';
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      encoding = 'windows-1250';
      text = decodeWith(encoding, bytes, false);
    }
  } else {
    try {
      text = decodeWith(encoding, bytes, encoding.startsWith('utf-'));
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Plik nie jest zapisany w kodowaniu ${ENCODINGS[encoding]}. Wybierz inne kodowanie.`);
      throw error;
    }
  }
  // TextDecoder usuwa BOM zgodnego kodowania; BOM innego kodowania (ręczny wybór) usuwamy tutaj.
  text = text.replace(/^\uFEFF/, '');
  if (BROKEN.test(text)) throw new Error(UNKNOWN_ENCODING);

  const warnings = [];
  if (encoding === 'windows-1250') {
    if (ISO_8859_2_HINT.test(text)) warnings.push('W pliku są znaki ±, ¶ lub Ľ — plik może być zapisany w ISO-8859-2. Sprawdź nazwiska w podglądzie.');
    if (WINDOWS_1252_HINT.test(text)) warnings.push('W pliku są znaki typu č, ŕ, ř — plik może być zapisany w Windows-1252 (Excel BE/FR). Sprawdź nazwiska w podglądzie lub wybierz kodowanie ręcznie.');
  }
  return { text, encoding, label: ENCODINGS[encoding], bom, warnings };
}

// detectDelimiter(text) → { delimiter, label, tie }
// Liczy ;  ,  i tabulator w pierwszej niepustej linii poza cudzysłowami. Przy remisie
// zwraca pierwszy z kolejności ; , tab i tie: true — interfejs powinien poprosić o sprawdzenie.
export function detectDelimiter(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false, seenContent = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') i++;
      else quoted = !quoted;
      seenContent = true;
    } else if (!quoted) {
      if (char === '\n' || char === '\r') {
        if (seenContent) break;
        continue;
      }
      if (Object.hasOwn(counts, char)) counts[char]++;
      if (char.trim()) seenContent = true;
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [best, bestCount] = ranked[0];
  if (!bestCount) return { delimiter: ',', label: DELIMITERS[','], tie: false };
  return { delimiter: best, label: DELIMITERS[best], tie: ranked[1][1] === bestCount };
}

// Krótki opis do komunikatu statusu, np. „Windows-1250 (Excel PL), średnik”.
export function describeSource({ label, bom } = {}, delimiter) {
  const parts = [];
  if (label) parts.push(bom ? `${label} z BOM` : label);
  if (delimiter?.label) parts.push(delimiter.tie ? `${delimiter.label} (niejednoznaczny separator — sprawdź kolumny)` : delimiter.label);
  return parts.join(', ');
}
