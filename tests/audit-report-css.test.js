// Przegląd demo 5: „Wersja do druku” raportu Komisji Rewizyjnej na telefonie
// (390 px) przewijała całą stronę w poziomie o ~450 px przez szerokie tabele.
// i przez nierozdzielny skrót SHA-256 w nagłówku. Na wąskim ekranie przewija
// się sama tabela, a skrót łamie się w dowolnym miejscu; wydruk bez zmian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_CSS } from '../src/pg/audit-report.js';

test('raport KR (HTML): szerokie tabele przewijają się w sobie na wąskim ekranie', () => {
  assert.match(REPORT_CSS, /@media screen and \(max-width: 640px\) \{ table \{ display: block; overflow-x: auto; \} \}/);
  assert.match(REPORT_CSS, /\.meta \{[^}]*overflow-wrap: anywhere;/);
  assert.match(REPORT_CSS, /@media print \{ body \{ padding: 0; max-width: none; \} \}/);
});
