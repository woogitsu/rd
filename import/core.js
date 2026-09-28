import { detectDelimiter } from './csv.js';
export const FIELDS = [
  ['studentId', 'ID ucznia (jeśli jest)'], ['firstName', 'Imię ucznia *'],
  ['lastName', 'Nazwisko ucznia *'], ['className', 'Klasa *'],
  ['householdId', 'ID rodziny (opcjonalnie)'], ['guardian1', 'Opiekun 1 — imię i nazwisko'],
  ['email1', 'E-mail opiekuna 1'], ['guardian2', 'Opiekun 2 — imię i nazwisko'],
  ['email2', 'E-mail opiekuna 2'],
];
const ALIASES = {
  studentId: ['id ucznia', 'identyfikator ucznia', 'student id', 'student_id'],
  firstName: ['imię ucznia', 'imie ucznia', 'imię', 'imie', 'first name', 'first_name'],
  lastName: ['nazwisko ucznia', 'nazwisko', 'last name', 'last_name'],
  className: ['klasa', 'oddział', 'oddzial', 'class', 'class_name'],
  householdId: ['id rodziny', 'identyfikator rodziny', 'household_id'],
  guardian1: ['opiekun 1', 'rodzic 1', 'imię i nazwisko opiekuna 1', 'guardian_1'],
  email1: ['email opiekuna 1', 'e-mail opiekuna 1', 'email 1', 'e-mail 1', 'email', 'e-mail'],
  guardian2: ['opiekun 2', 'rodzic 2', 'imię i nazwisko opiekuna 2', 'guardian_2'],
  email2: ['email opiekuna 2', 'e-mail opiekuna 2', 'email 2', 'e-mail 2'],
};
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
const normalizeClass = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('pl-PL');
const FIELD_LABELS = Object.fromEntries(FIELDS);
// Kolumny identyfikatorów: komórka XLSX sformatowana jako liczba traci zera wiodące (#88).
const ID_FIELD_KEYS = new Set(['studentId', 'householdId']);
export function guessMapping(headers) {
  const mapping = {};
  for (const [key] of FIELDS) {
    const index = headers.findIndex(h => ALIASES[key].includes(normalize(h)));
    if (index >= 0) mapping[key] = index;
  }
  return mapping;
}
export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Plik CSV jest pusty.');
  const input = text.replace(/^\uFEFF/, '');
  // Separator liczony w nagłówku poza cudzysłowami: ; , albo tabulator (import/csv.js).
  const { delimiter } = detectDelimiter(input);
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (afterQuote) {
      if (char === delimiter) { row.push(cell); cell = ''; afterQuote = false; }
      else if (char === '\r' || char === '\n') {
        row.push(cell); rows.push(row); row = []; cell = ''; afterQuote = false;
        if (char === '\r' && input[i + 1] === '\n') i++;
      } else if (char !== ' ' && char !== '\t') throw new Error(`Niepoprawny cudzysłów w CSV przy znaku ${i + 1}.`);
    } else if (char === '"') {
      if (cell.trim()) throw new Error(`Niepoprawny cudzysłów w CSV przy znaku ${i + 1}.`);
      cell = ''; quoted = true;
    } else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\r' || char === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      if (char === '\r' && input[i + 1] === '\n') i++;
    } else cell += char;
    if (rows.length > 5001) throw new Error('Limit wynosi 5000 wierszy danych.');
  }
  if (quoted) throw new Error('Nie zamknięto cudzysłowu w CSV.');
  if (cell !== '' || row.length || afterQuote) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(value => String(value).trim()));
}
export function validateRows(matrix, mapping, options = {}) {
  const { allowedClasses = [] } = options;
  if (!Array.isArray(matrix) || matrix.length < 2) throw new Error('Plik musi zawierać nagłówek i co najmniej jeden wiersz danych.');
  if (matrix.length > 5001) throw new Error('Limit wynosi 5000 wierszy danych.');
  if (!Array.isArray(matrix[0]) || matrix[0].length > 60) throw new Error('Nieprawidłowy nagłówek lub więcej niż 60 kolumn.');
  const headers = matrix[0].map(v => String(v ?? '').trim());
  const indexes = Object.values(mapping).filter(v => v !== '' && v !== undefined).map(Number);
  if (indexes.some(index => !Number.isInteger(index) || index < 0 || index >= headers.length)) throw new Error('Mapowanie zawiera nieprawidłową kolumnę.');
  if (new Set(indexes).size !== indexes.length) throw new Error('Jedna kolumna nie może być przypisana do dwóch pól.');
  for (const required of ['firstName', 'lastName', 'className']) {
    if (!Number.isInteger(Number(mapping[required])) || mapping[required] === '' || Number(mapping[required]) < 0 || Number(mapping[required]) >= headers.length) throw new Error(`Brakuje mapowania: ${required}.`);
  }
  // Klasy z bazy: dopasowanie bez rozróżniania wielkości liter i spacji (#88); nazwa
  // niejednoznaczna po normalizacji (dwie różne klasy dają ten sam klucz) jest błędem.
  const classCanonical = new Map();
  const ambiguousClassKeys = new Set();
  for (const name of allowedClasses) {
    const key = normalizeClass(name);
    if (classCanonical.has(key) && classCanonical.get(key) !== name) ambiguousClassKeys.add(key);
    else classCanonical.set(key, name);
  }
  const seenId = new Map(), seenName = new Map(), seenHousehold = new Map(), records = [], errors = [], warnings = [];
  const rawCell = (row, key) => (mapping[key] === undefined || mapping[key] === '' ? undefined : row[Number(mapping[key])]);
  const asText = raw => String(raw ?? '').trim().replace(/\s+/g, ' ');
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!Array.isArray(row) || !row.some(v => String(v ?? '').trim())) continue;
    const number = i + 1;
    if (row.length > 60) { errors.push({ row: number, message: 'Za dużo kolumn.' }); continue; }
    const record = {};
    const issues = [];
    for (const [key] of FIELDS) {
      const raw = rawCell(row, key);
      // #88: Excel zamienia niektóre wpisy (np. "1-2") na datę — String(Date) daje
      // nieczytelny tekst (np. w polu klasy). Traktujemy to jako błąd wiersza.
      if (raw instanceof Date) {
        issues.push(`${FIELD_LABELS[key] ?? key}: Excel zamienił wartość na datę — zmień format kolumny na Tekst.`);
        record[key] = '';
        continue;
      }
      if (ID_FIELD_KEYS.has(key) && typeof raw === 'number') {
        if (!Number.isSafeInteger(raw)) {
          issues.push(`${FIELD_LABELS[key] ?? key}: liczba jest zbyt duża do bezpiecznego odczytu — zapisz kolumnę jako Tekst.`);
          record[key] = '';
          continue;
        }
        record[key] = String(raw);
        warnings.push({ row: number, message: `${FIELD_LABELS[key] ?? key} zapisany jako liczba (${raw}) — sprawdź zera wiodące; w Excelu ustaw format kolumny na Tekst.` });
        continue;
      }
      record[key] = asText(raw);
    }
    for (const key of ['firstName', 'lastName', 'className']) if (!record[key]) issues.push(`Brak: ${key}.`);
    for (const key of ['firstName', 'lastName', 'className', 'guardian1', 'guardian2']) if (record[key].length > 120) issues.push(`Za długa wartość: ${key}.`);
    for (const key of ['email1', 'email2']) {
      if (record[key].length > 254 || (record[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record[key]))) issues.push(`Niepoprawny adres: ${key}.`);
    }
    if (record.email1 && !record.guardian1) issues.push('E-mail opiekuna 1 bez nazwiska opiekuna.');
    if (record.email2 && !record.guardian2) issues.push('E-mail opiekuna 2 bez nazwiska opiekuna.');
    if (record.householdId.length > 80 || record.studentId.length > 80) issues.push('Identyfikator ma ponad 80 znaków.');
    if (allowedClasses.length && record.className) {
      const classKey = normalizeClass(record.className);
      if (ambiguousClassKeys.has(classKey)) issues.push('Niejednoznaczna nazwa klasy po normalizacji wielkości liter/spacji — popraw nazwy klas w bazie.');
      else if (classCanonical.has(classKey)) record.className = classCanonical.get(classKey);
      else issues.push('Nieznana klasa.');
    }
    const idKey = normalize(record.studentId);
    const nameKey = [record.firstName, record.lastName, record.className].map(normalize).join('|');
    if (idKey && seenId.has(idKey)) issues.push(`Powtórzone ID ucznia z wiersza ${seenId.get(idKey)}.`);
    if (nameKey && seenName.has(nameKey)) warnings.push({ row: number, message: `Możliwy duplikat imienia, nazwiska i klasy (wiersz ${seenName.get(nameKey)}). Sprawdź ręcznie.` });
    const householdKey = normalize(record.householdId);
    const contacts = [[record.guardian1, record.email1], [record.guardian2, record.email2]]
      .map(pair => pair.map(normalize).join('|')).sort().join(';');
    if (householdKey && seenHousehold.has(householdKey)) {
      const first = seenHousehold.get(householdKey);
      if (first.contacts !== contacts) warnings.push({ row: number, message: `ID rodziny ma inne dane opiekunów niż wiersz ${first.row}. Sprawdź ręcznie.` });
    } else if (householdKey) seenHousehold.set(householdKey, { row: number, contacts });
    if (idKey && !seenId.has(idKey)) seenId.set(idKey, number);
    if (nameKey && !seenName.has(nameKey)) seenName.set(nameKey, number);
    if (issues.length) errors.push(...issues.map(message => ({ row: number, message })));
    if (!record.guardian1 && !record.guardian2) warnings.push({ row: number, message: 'Brak opiekuna: nie będzie możliwy kontakt e-mail.' });
    // #98: jedna kolumna "Imię i nazwisko" nie rozróżnia przedrostków ani drugich imion —
    // przy więcej niż dwóch wyrazach prosimy o ręczne sprawdzenie podziału.
    for (const [key, label] of [['guardian1', 'Opiekun 1'], ['guardian2', 'Opiekun 2']]) {
      const words = record[key] ? record[key].split(/\s+/).filter(Boolean) : [];
      if (words.length > 2) warnings.push({ row: number, message: `${label}: więcej niż dwa wyrazy w imieniu i nazwisku — sprawdź podział na imię i nazwisko.` });
    }
    records.push({ row: number, ...record, valid: !issues.length });
  }
  if (!records.length) throw new Error('Brak wierszy uczniów.');
  return { headers, records, errors, warnings, validCount: records.filter(x => x.valid).length };
}
export const FIELD_KEYS = FIELDS.map(([key]) => key);
// Dane wysyłane do POST /api/import/preview i /commit: znormalizowane wiersze,
// bez pliku źródłowego. Numery wierszy służą tylko do raportu.
export function toServerPayload(result, schoolYearId, { allowNewHouseholds = false, skipConflicts = false } = {}) {
  return {
    version: 1,
    schoolYearId,
    columns: FIELD_KEYS,
    rows: result.records.map(record => FIELD_KEYS.map(key => record[key])),
    rowNumbers: result.records.map(record => record.row),
    options: { allowNewHouseholds: Boolean(allowNewHouseholds), skipConflicts: Boolean(skipConflicts) },
  };
}
