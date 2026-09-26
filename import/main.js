import { readSheet } from 'read-excel-file/browser';
import { FIELDS, guessMapping, parseCsv, validateRows } from './core.js';
const fileInput = document.querySelector('#file');
const status = document.querySelector('#file-status');
const mappingSection = document.querySelector('#mapping-section');
const resultSection = document.querySelector('#result-section');
const mapArea = document.querySelector('#mapping');
let matrix = null;
function showError(message) { status.className = 'status error'; status.textContent = message; }
fileInput.addEventListener('change', async () => {
  matrix = null; mapArea.replaceChildren(); mappingSection.hidden = true; resultSection.hidden = true;
  const file = fileInput.files?.[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) return showError('Plik przekracza 5 MB.');
  if (!/\.(csv|xlsx)$/i.test(file.name)) return showError('Wybierz plik .csv lub .xlsx.');
  status.className = 'status muted'; status.textContent = 'Odczyt pliku…';
  try {
    if (/\.csv$/i.test(file.name)) {
      const bytes = await file.arrayBuffer();
      matrix = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else matrix = await readSheet(file);
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
    mappingSection.hidden = false; status.textContent = `Odczytano ${matrix.length - 1} wierszy z pliku ${file.name}.`;
  } catch (error) { matrix = null; showError(`Nie udało się odczytać pliku: ${error.message}`); }
});
document.querySelector('#preview').addEventListener('click', () => {
  if (!matrix) return;
  const mapping = Object.fromEntries(Array.from(mapArea.querySelectorAll('select')).map(el => [el.dataset.field, el.value]));
  try {
    const result = validateRows(matrix, mapping);
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
    resultSection.hidden = false; resultSection.scrollIntoView({behavior:'smooth'});
  } catch (error) { resultSection.hidden = true; showError(error.message); }
});
