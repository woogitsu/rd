import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeApprovalChecklist } from '../meetings/core.js';

test('describeApprovalChecklist rozdziela blokady od ostrzeżeń i pomija nieznane kody', () => {
  const result = describeApprovalChecklist({ items: [
    { code: 'open_resolutions', blocking: true, count: 2 },
    { code: 'stale_quorum_check', blocking: false },
    { code: 'resolutions_on_stale_check', blocking: false, count: 1 },
    { code: 'kod_z_przyszlosci', blocking: true },
  ] });
  assert.equal(result.blocking.length, 1);
  assert.match(result.blocking[0].text, /Otwarte projekty uchwał: 2/);
  assert.deepEqual(result.warnings.map((item) => item.code), ['stale_quorum_check', 'resolutions_on_stale_check']);
  assert.deepEqual(describeApprovalChecklist(null), { blocking: [], warnings: [] });
});

test('okno Zatwierdź wczytuje listę kontrolną z approval-checklist i nie zastępuje kontroli serwera', () => {
  const main = readFileSync(new URL('../meetings/main.js', import.meta.url), 'utf8');
  assert.match(main, /meetingUrl\(meetingId, "approval-checklist"\)/);
  assert.match(main, /Zatwierdzenie i tak sprawdza serwer/);
  const html = readFileSync(new URL('../meetings/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="approve-checklist-blocking"/);
});
