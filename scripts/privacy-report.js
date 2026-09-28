#!/usr/bin/env node
// Generuje docs/PRIVACY_INVENTORY.md z privacy/data-inventory.json.
//
// To jest PROJEKT MATERIAŁU dla rejestru czynności przetwarzania (D-01), a nie
// sam rejestr — rejestr i DPIA prowadzi administrator danych poza repozytorium.
//
// Użycie: node scripts/privacy-report.js [--check]
//   --check   nie zapisuje pliku; kończy z kodem 1, jeśli wygenerowana treść
//             różni się od docs/PRIVACY_INVENTORY.md (do CI).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const inventoryPath = new URL('../privacy/data-inventory.json', import.meta.url);
const outPath = new URL('../docs/PRIVACY_INVENTORY.md', import.meta.url);

const SUBJECT_LABELS = {
  student: 'Uczeń',
  guardian: 'Opiekun',
  board_member: 'Członek Rady',
  third_party: 'Osoba trzecia',
};

export function loadInventory() {
  return JSON.parse(readFileSync(inventoryPath, 'utf8'));
}

export function renderReport(inventory) {
  const lines = [];
  lines.push('# Projekt inwentarza danych osobowych (nie jest rejestrem czynności)');
  lines.push('');
  lines.push('> Ten dokument jest **wygenerowany** ze `privacy/data-inventory.json` (`node scripts/privacy-report.js`).');
  lines.push('> To jest materiał techniczny dla administratora danych (D-01) — nie zastępuje rejestru czynności');
  lines.push('> przetwarzania ani oceny skutków (DPIA), które prowadzi administrator poza repozytorium.');
  lines.push('> Retencja (D-04) i odbiorcy (D-08/D-09) są w większości pól „nieustalone” — wypełnia zarząd/IOD.');
  lines.push('');
  lines.push('Zobacz też: [`docs/PROCESSORS.md`](./PROCESSORS.md), [`docs/DPIA_CHECKLIST.md`](./DPIA_CHECKLIST.md),');
  lines.push('[`docs/DECISIONS.md`](./DECISIONS.md) (D-01, D-02, D-04, D-05, D-08, D-09).');
  lines.push('');

  const tableNames = Object.keys(inventory).sort();
  let totalPersonal = 0;
  let totalFreeText = 0;

  lines.push('## Kategorie osób × kategorie danych (tylko kolumny z danymi osobowymi)');
  lines.push('');
  lines.push('| Tabela | Kolumna | Podmiot | Rodzaj | Kategoria | Cel | Retencja (kategoria) | Wolny tekst | Eksport roczny |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const table of tableNames) {
    const columns = inventory[table];
    for (const column of Object.keys(columns).sort()) {
      const entry = columns[column];
      if (entry.personal === 'none') continue;
      totalPersonal += 1;
      if (entry.free_text) totalFreeText += 1;
      lines.push([
        '', `\`${table}\``, `\`${column}\``,
        SUBJECT_LABELS[entry.subject] ?? (entry.subject ?? '—'),
        entry.personal,
        entry.category ?? '—',
        entry.purpose ?? '—',
        entry.retention_category ?? 'nieustalona (D-04)',
        entry.free_text ? 'tak' : 'nie',
        entry.exportable ? 'tak' : 'nie',
        '',
      ].join('|'));
    }
  }
  lines.push('');
  lines.push(`Łącznie kolumn z danymi osobowymi: **${totalPersonal}**, w tym wolnego tekstu: **${totalFreeText}** (patrz #152).`);
  lines.push('');

  lines.push('## Wszystkie tabele i kolumny (pełny spis)');
  lines.push('');
  for (const table of tableNames) {
    lines.push(`### \`${table}\``);
    lines.push('');
    lines.push('| Kolumna | Dane osobowe | Podmiot | Eksport roczny |');
    lines.push('|---|---|---|---|');
    const columns = inventory[table];
    for (const column of Object.keys(columns).sort()) {
      const entry = columns[column];
      lines.push(`| \`${column}\` | ${entry.personal} | ${entry.subject ?? '—'} | ${entry.exportable ? 'tak' : 'nie'} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function main() {
  const inventory = loadInventory();
  const rendered = renderReport(inventory);
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    let current = '';
    try { current = readFileSync(outPath, 'utf8'); } catch { /* brak pliku = niezgodne */ }
    if (current !== rendered) {
      console.error('docs/PRIVACY_INVENTORY.md jest nieaktualny względem privacy/data-inventory.json. Uruchom: node scripts/privacy-report.js');
      process.exit(1);
    }
    console.log('docs/PRIVACY_INVENTORY.md jest aktualny.');
    return;
  }
  writeFileSync(outPath, rendered);
  console.log(`Zapisano ${outPath.pathname.replace(root, '')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
