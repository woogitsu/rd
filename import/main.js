import { readXlsxRows } from './xlsx.js';
import { FIELDS, guessMapping, parseCsv, toServerPayload, validateRows } from './core.js';
import { decodeCsvBytes, describeSource, detectDelimiter } from './csv.js';
import { api as apiRequest, errorMessage } from '../shared/api.js';
import { buildErrorReportCsv, unusedColumns } from './report.js';
import { mountShell } from '../shared/shell.js';
import '../shared/shell.css';

mountShell();
const fileInput = document.querySelector('#file');
const unusedColumnsBox = document.querySelector('#unused-columns');
const downloadReportButton = document.querySelector('#download-report');
const encodingSelect = document.querySelector('#encoding');
const status = document.querySelector('#file-status');
const mappingSection = document.querySelector('#mapping-section');
const resultSection = document.querySelector('#result-section');
const mapArea = document.querySelector('#mapping');
const serverSection = document.querySelector('#server-section');
const serverYear = document.querySelector('#server-year');
const serverStatus = document.querySelector('#server-status');
const serverReport = document.querySelector('#server-report');
const previewButton = document.querySelector('#server-preview');
const commitButton = document.querySelector('#server-commit');
const allowHouseholds = document.querySelector('#allow-households');
const skipConflicts = document.querySelector('#skip-conflicts');
// Stan kroku 4. Klucz idempotencji jest nowy dla każdego podglądu i ten sam przy ponowieniu zatwierdzenia.
let serverPreview = null, serverPayload = null, idempotencyKey = null, busy = false;
let matrix = null;
let lastResult = null;
// #109: raport do pobrania — wszystkie komunikaty z walidacji lokalnej i (jeśli
// wysłano) podglądu serwera. Tylko numer wiersza, etap, rodzaj i komunikat —
// bez imion, nazwisk i e-maili.
let reportEntries = [];
function updateReportButton() { downloadReportButton.disabled = reportEntries.length === 0; }
function showError(message) { status.className = 'status error'; status.textContent = message; fileInput.setAttribute('aria-invalid', 'true'); }
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
async function readSelectedFile() {
  matrix = null; lastResult = null; resetServer(); mapArea.replaceChildren(); mappingSection.hidden = true; resultSection.hidden = true; serverSection.hidden = true;
  const file = fileInput.files?.[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) return showError('Plik przekracza 5 MB.');
  if (!/\.(csv|xlsx)$/i.test(file.name)) return showError('Wybierz plik .csv lub .xlsx.');
  status.className = 'status muted'; status.textContent = 'Odczyt pliku…'; fileInput.removeAttribute('aria-invalid');
  let source = '', warnings = [];
  try {
    if (/\.csv$/i.test(file.name)) {
      // #77: wykrycie kodowania (UTF-8/BOM, Windows-1250) i separatora; ręczny wybór nadpisuje wykrycie.
      const decoded = decodeCsvBytes(await file.arrayBuffer(), { encoding: encodingSelect.value });
      source = describeSource(decoded, detectDelimiter(decoded.text)); warnings = decoded.warnings;
      matrix = parseCsv(decoded.text);
    } else matrix = await readXlsxRows(await file.arrayBuffer());
    if (matrix.length < 2 || matrix.length > 5001) throw new Error('Plik musi zawierać od 1 do 5000 wierszy danych.');
    if (!Array.isArray(matrix[0]) || matrix[0].length > 60) throw new Error('Nagłówek ma więcej niż 60 kolumn.');
    const headers = matrix[0].map(v => String(v ?? '').trim());
    const suggested = guessMapping(headers);
    for (const [field, label] of FIELDS) {
      const wrapper = document.createElement('label'); wrapper.textContent = label;
      const select = document.createElement('select'); select.dataset.field = field;
      const empty = new Option('— pomiń —', ''); select.add(empty);
      headers.forEach((header, index) => select.add(new Option(`${index + 1}. ${header || '(bez nazwy)'}`, String(index))));
      if (suggested[field] !== undefined) select.value = String(suggested[field]);
      wrapper.append(select); mapArea.append(wrapper);
    }
    mappingSection.hidden = false;
    status.textContent = `Odczytano ${matrix.length - 1} wierszy z pliku ${file.name}${source ? ` (${source})` : ''}.${warnings.length ? ` Uwaga: ${warnings.join(' ')}` : ''}`;
  } catch (error) { matrix = null; showError(`Nie udało się odczytać pliku: ${error.message}`); }
}
fileInput.addEventListener('change', readSelectedFile);
encodingSelect.addEventListener('change', readSelectedFile);
document.querySelector('#preview').addEventListener('click', () => {
  if (!matrix) return;
  const mapping = Object.fromEntries(Array.from(mapArea.querySelectorAll('select')).map(el => [el.dataset.field, el.value]));
  try {
    const result = validateRows(matrix, mapping);
    lastResult = result; resetServer(); serverSection.hidden = false;
    // #109: raport per wiersz (bez danych osobowych) i wykaz kolumn, których mapowanie nie użyje.
    reportEntries = [
      ...result.errors.map((e) => ({ ...e, stage: 'file', kind: 'error' })),
      ...result.warnings.map((w) => ({ ...w, stage: 'file', kind: 'warning' })),
    ];
    updateReportButton();
    const headers = matrix[0].map((v) => String(v ?? '').trim());
    const unused = unusedColumns(headers, mapping);
    unusedColumnsBox.replaceChildren();
    if (unused.length) {
      const heading = document.createElement('h3'); heading.textContent = `Kolumny, które nie zostaną użyte: ${unused.length}`;
      const list = document.createElement('ul');
      unused.forEach((col) => {
        const li = document.createElement('li');
        li.textContent = col.excluded
          ? `„${col.header}” — wygląda na ${col.excluded}. Ten plik zawiera dane, których nie importujemy. Poproś szkołę o plik bez tej kolumny.`
          : `„${col.header}”`;
        if (col.excluded) li.className = 'bad';
        list.append(li);
      });
      unusedColumnsBox.append(heading, list);
    }
    const summary = document.querySelector('#summary'); summary.replaceChildren();
    const report = document.createElement('div'); report.className = 'report';
    for (const [title, amount] of [['Poprawne wiersze', result.validCount],['Błędy', result.errors.length],['Uwagi do sprawdzenia', result.warnings.length]]) {
      const box = document.createElement('div'); const value = document.createElement('strong'); value.textContent = amount;
      box.append(value, document.createTextNode(title)); report.append(box);
    }
    summary.append(report);
    const messages = document.querySelector('#messages'); messages.replaceChildren();
    for (const [title, entries] of [['Błędy',result.errors],['Uwagi',result.warnings]]) {
      if (!entries.length) continue; const heading = document.createElement('h3'); heading.textContent = title;
      const list = document.createElement('ul');
      entries.slice(0,40).forEach(entry => { const li = document.createElement('li'); li.textContent = `Wiersz ${entry.row}: ${entry.message}`; list.append(li); });
      messages.append(heading,list);
      if (entries.length > 40) { const p = document.createElement('p'); p.textContent = `Pokazano 40 z ${entries.length} komunikatów.`; messages.append(p); }
    }
    const body = document.querySelector('#preview-body'); body.replaceChildren();
    result.records.slice(0,100).forEach(record => {
      const tr = document.createElement('tr'); if (!record.valid) tr.className = 'bad';
      for (const text of [record.row,`${record.firstName} ${record.lastName}`,record.className,record.guardian1,record.email1,record.guardian2,record.email2,record.valid?'Poprawny':'Błąd']) {
        const td = document.createElement('td'); td.textContent = text; tr.append(td);
      } body.append(tr);
    });
    resultSection.hidden = false; resultSection.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
    document.querySelector('#result-title').focus({ preventScroll: true });
  } catch (error) { lastResult = null; reportEntries = []; updateReportButton(); resetServer(); resultSection.hidden = true; serverSection.hidden = true; showError(error.message); }
});
downloadReportButton.addEventListener('click', () => {
  if (!reportEntries.length) return;
  const csv = buildErrorReportCsv(reportEntries);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'raport-importu.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// --- Krok 4: podgląd i zapis na serwerze (issue #36) -------------------------
// Wysyłamy wyłącznie znormalizowane wiersze (toServerPayload), nie plik.
// Serwer powtarza walidację i sam sprawdza sesję, rolę i MFA.
const ERRORS = {
  unauthenticated: 'Zaloguj się w panelu, a następnie spróbuj ponownie.',
  forbidden: 'Brak uprawnień: wymagana rola administratora lub zarządu z MFA i przydziałem dla wszystkich klas tego roku.',
  invalid_origin: 'Żądanie odrzucone: niezgodne pochodzenie strony.',
  import_disabled: 'Import jest wyłączony na tym środowisku.',
  request_too_large: 'Za dużo danych w jednym żądaniu. Podziel plik, np. na klasy.',
  too_many_rows: 'Za dużo wierszy w jednym żądaniu.',
  unknown_school_year: 'Nie znaleziono roku szkolnego.',
  no_classes_in_school_year: 'Rok szkolny nie ma zdefiniowanych klas.',
  preview_stale: 'Dane w bazie zmieniły się od podglądu. Wyślij podgląd ponownie.',
  fingerprint_mismatch: 'Dane różnią się od podglądu. Wyślij podgląd ponownie.',
  import_has_conflicts: 'Import zawiera konflikty lub błędy. Popraw plik albo zaznacz pominięcie tych wierszy.',
  idempotency_key_reused: 'Ten podgląd był już użyty dla innych danych. Wyślij podgląd ponownie.',
  service_unavailable: 'Serwer jest chwilowo niedostępny. Nic nie zostało zapisane; można ponowić.',
};
const ACTIONS = { add: 'Nowy', update: 'Aktualizacja', unchanged: 'Bez zmian', conflict: 'Konflikt', skipped: 'Pominięty' };
function serverMessage(status, data) {
  const code = data?.error;
  const base = errorMessage(code, status, ERRORS);
  return data?.message ? `${base} ${data.message}` : base;
}
function setServerStatus(text, error = false) { serverStatus.className = error ? 'status error' : 'status muted'; serverStatus.textContent = text; }
function updateButtons() {
  previewButton.disabled = busy || !lastResult || !serverYear.value;
  commitButton.disabled = busy || !serverPreview || (!serverPreview.commitAllowed && !skipConflicts.checked);
}
function resetServer() {
  serverPreview = null; serverPayload = null; idempotencyKey = null;
  serverReport.replaceChildren(); setServerStatus('');
  // #109: podgląd serwera nieaktualny — raport wraca do samej walidacji lokalnej.
  reportEntries = reportEntries.filter((entry) => entry.stage !== 'server');
  updateReportButton();
  updateButtons();
}
// Wspólny klient (#99): 401/403 MFA → /login/ z powrotem. Błąd sieci rzuca wyjątek jak dotąd.
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  try {
    return { status: 200, ok: true, data: await apiRequest(path, { method, body, headers }) };
  } catch (error) {
    if (error.network) throw error;
    return { status: error.status, ok: false, data: error.data };
  }
}
function reportBoxes(entries) {
  const report = document.createElement('div'); report.className = 'report wide';
  for (const [title, amount] of entries) {
    const box = document.createElement('div'); const value = document.createElement('strong'); value.textContent = amount;
    box.append(value, document.createTextNode(title)); report.append(box);
  }
  return report;
}
function messageList(title, entries) {
  const nodes = [];
  if (!entries.length) return nodes;
  const heading = document.createElement('h3'); heading.textContent = title;
  const list = document.createElement('ul');
  entries.slice(0, 40).forEach(([row, text]) => { const li = document.createElement('li'); li.textContent = `Wiersz ${row}: ${text}`; list.append(li); });
  nodes.push(heading, list);
  if (entries.length > 40) { const p = document.createElement('p'); p.textContent = `Pokazano 40 z ${entries.length} komunikatów.`; nodes.push(p); }
  return nodes;
}
function renderServerPreview(data) {
  const c = data.counts;
  const info = document.createElement('p'); info.className = 'muted';
  info.textContent = `Do utworzenia: rodziny ${c.householdsCreated}, opiekunowie ${c.guardiansCreated}, uczniowie ${c.studentsCreated}, zapisy do klas ${c.enrollmentsCreated}, powiązania uczeń–opiekun ${c.linksCreated}. Zgoda na kontakt nie jest ustawiana przez import.`;
  const problems = data.rows.filter(row => row.action === 'conflict' || row.action === 'skipped')
    .map(row => [row.row, `${ACTIONS[row.action]} — ${(row.messages ?? []).join(' ')}`]);
  serverReport.replaceChildren(
    reportBoxes([['Nowe', c.rowsAdded], ['Aktualizacje', c.rowsUpdated], ['Bez zmian', c.rowsUnchanged], ['Konflikty', c.rowsConflict], ['Pominięte (błędy)', c.rowsSkipped]]),
    info,
    ...messageList('Wymaga ręcznej decyzji', problems),
    ...messageList('Uwagi serwera', data.warnings.map(w => [w.row, w.message])),
  );
  // #109: dołącz komunikaty podglądu serwera do raportu do pobrania.
  reportEntries = [
    ...reportEntries.filter((entry) => entry.stage !== 'server'),
    ...data.rows.filter((row) => row.action === 'conflict' || row.action === 'skipped').flatMap((row) =>
      (row.messages ?? []).map((message) => ({ row: row.row, stage: 'server', kind: row.action, message }))),
    ...data.warnings.map((w) => ({ row: w.row, stage: 'server', kind: 'warning', message: w.message })),
  ];
  updateReportButton();
}
document.querySelector('#server-connect').addEventListener('click', async () => {
  busy = true; updateButtons(); setServerStatus('Pobieranie lat szkolnych…');
  try {
    const { ok, status, data } = await api('/api/import/options');
    if (!ok) return setServerStatus(serverMessage(status, data), true);
    serverYear.replaceChildren(new Option('— wybierz rok —', ''));
    for (const year of data.schoolYears) serverYear.add(new Option(`${year.label} (klasy: ${year.classes.join(', ') || 'brak'})`, year.id));
    serverYear.disabled = false;
    setServerStatus(data.schoolYears.length ? 'Wybierz rok szkolny.' : 'Brak dostępnych lat szkolnych.');
  } catch { setServerStatus('Nie udało się połączyć z serwerem.', true); }
  finally { busy = false; updateButtons(); }
});
serverYear.addEventListener('change', resetServer);
allowHouseholds.addEventListener('change', resetServer);
skipConflicts.addEventListener('change', updateButtons);
previewButton.addEventListener('click', async () => {
  if (!lastResult || !serverYear.value) return;
  resetServer(); busy = true; updateButtons(); setServerStatus('Serwer sprawdza dane…');
  const payload = toServerPayload(lastResult, serverYear.value, { allowNewHouseholds: allowHouseholds.checked });
  try {
    const { ok, status, data } = await api('/api/import/preview', { method: 'POST', body: payload });
    if (!ok) return setServerStatus(serverMessage(status, data), true);
    serverPreview = data; serverPayload = payload; idempotencyKey = crypto.randomUUID();
    renderServerPreview(data);
    setServerStatus(data.commitAllowed ? 'Podgląd serwera gotowy. Nic nie zostało zapisane.' : 'Podgląd serwera zawiera konflikty lub błędy. Nic nie zostało zapisane.');
  } catch { setServerStatus('Nie udało się połączyć z serwerem. Nic nie zostało zapisane.', true); }
  finally { busy = false; updateButtons(); }
});
commitButton.addEventListener('click', async () => {
  if (!serverPreview || busy) return;
  const c = serverPreview.counts;
  if (!window.confirm(`Zapisać w bazie: nowe ${c.rowsAdded}, aktualizacje ${c.rowsUpdated}? Pominięte wiersze: ${c.rowsConflict + c.rowsSkipped}.`)) return;
  busy = true; updateButtons(); setServerStatus('Zapisywanie w jednej transakcji…');
  const body = { ...serverPayload, fingerprint: serverPreview.fingerprint, planDigest: serverPreview.planDigest,
    options: { ...serverPayload.options, skipConflicts: skipConflicts.checked } };
  try {
    const { ok, status, data } = await api('/api/import/commit', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } });
    if (!ok) return setServerStatus(serverMessage(status, data), true);
    serverPreview = null; serverPayload = null;
    setServerStatus(data.replayed
      ? `Ten import był już zapisany wcześniej (partia ${data.batchId}). Nic nie zostało zdublowane.`
      : `Zapisano partię ${data.batchId}: nowe ${data.counts.rowsAdded}, aktualizacje ${data.counts.rowsUpdated}, pominięte ${data.counts.rowsConflict + data.counts.rowsSkipped}.`);
  } catch { setServerStatus('Brak odpowiedzi serwera. Ponowne kliknięcie użyje tego samego klucza i nie zdubluje danych.', true); }
  finally { busy = false; updateButtons(); }
});
