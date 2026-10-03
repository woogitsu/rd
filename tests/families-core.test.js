import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContactPatch,
  buildEndRequest,
  canEndGuardianHousehold,
  endResultMessages,
  isValidDate,
  canEditFamilies,
  filterStudentsByName,
  formatPercent,
  groupClassesByYear,
  guardianEmailText,
  hasRepresentativeGrant,
  hasPaymentColumn,
  overviewRows,
  boardOverviewExportUrl,
  exportFilename,
  overviewRow,
  parseRoute,
  sortStudentsByName,
} from '../families/core.js';

test('trasy widoku rodzin i odrzucenie niepoprawnych identyfikatorów', () => {
  assert.deepEqual(parseRoute('#/classes/c-1a'), { view: 'class', id: 'c-1a' });
  assert.deepEqual(parseRoute('#/households/h-1'), { view: 'household', id: 'h-1' });
  assert.deepEqual(parseRoute('#/households/..%2F..'), { view: 'classes' });
  assert.deepEqual(parseRoute(''), { view: 'classes' });
});

test('grupowanie klas po roku i przyciski edycji tylko dla admina/zarządu', () => {
  const groups = groupClassesByYear([
    { id: 'a', schoolYearId: 'y2', schoolYearLabel: '2027/28' },
    { id: 'b', schoolYearId: 'y1', schoolYearLabel: '2026/27' },
    { id: 'c', schoolYearId: 'y2', schoolYearLabel: '2027/28' },
  ]);
  assert.deepEqual(groups.map((g) => [g.schoolYearId, g.classes.map((c) => c.id)]), [['y2', ['a', 'c']], ['y1', ['b']]]);
  assert.equal(canEditFamilies([{ role: 'representative', classId: 'c' }]), false);
  assert.equal(canEditFamilies([{ role: 'board' }]), true);
});

test('formularz kontaktu wysyła tylko zmienione pola z powodem', () => {
  const current = { email: 'a@example.invalid', contactAllowed: false };
  assert.deepEqual(buildContactPatch({ email: ' A@example.invalid ', contactAllowed: true, reason: 'Prośba' }, current),
    { patch: { reason: 'Prośba', contactAllowed: true } });
  assert.ok(buildContactPatch({ email: 'zly', contactAllowed: false, reason: 'Prośba' }, current).error);
  assert.ok(buildContactPatch({ email: 'a@example.invalid', contactAllowed: false, reason: 'Prośba' }, current).error);
  assert.ok(buildContactPatch({ email: '', contactAllowed: false, reason: 'x' }, current).error);
  assert.deepEqual(buildContactPatch({ email: '', contactAllowed: false, reason: 'Brak adresu' }, current),
    { patch: { reason: 'Brak adresu', email: null } });
});

// issue #128: wyszukiwanie i sortowanie na już wczytanej liście uczniów klasy.
test('filterStudentsByName: puste zapytanie zwraca całą listę bez kopiowania kolejności', () => {
  const students = [{ firstName: 'Anna', lastName: 'Kowalska' }, { firstName: 'Jan', lastName: 'Nowak' }];
  assert.deepEqual(filterStudentsByName(students, ''), students);
  assert.deepEqual(filterStudentsByName(students, '   '), students);
  assert.deepEqual(filterStudentsByName(undefined, 'a'), []);
});

test('filterStudentsByName: dopasowanie bez rozróżniania wielkości liter i polskich znaków diakrytycznych', () => {
  const students = [
    { firstName: 'Łukasz', lastName: 'Zięba' },
    { firstName: 'Ola', lastName: 'Kowalska' },
    { firstName: 'Piotr', lastName: 'Nowicki' },
  ];
  assert.deepEqual(filterStudentsByName(students, 'zieba').map((s) => s.lastName), ['Zięba']);
  assert.deepEqual(filterStudentsByName(students, 'KOWAL').map((s) => s.lastName), ['Kowalska']);
  assert.deepEqual(filterStudentsByName(students, 'nowic').map((s) => s.lastName), ['Nowicki']);
  // „ł” nie rozkłada się w NFD: wpisanie bez kreski i z kreską znajduje to samo imię.
  assert.deepEqual(filterStudentsByName(students, 'lukasz').map((s) => s.firstName), ['Łukasz']);
  assert.deepEqual(filterStudentsByName(students, 'ŁUKASZ').map((s) => s.firstName), ['Łukasz']);
});

test('filterStudentsByName: znaki % i _ nie mają specjalnego znaczenia (brak wstrzyknięcia w filtrze klienta)', () => {
  const students = [{ firstName: 'A', lastName: '100%' }, { firstName: 'B', lastName: 'Zwykły' }];
  assert.deepEqual(filterStudentsByName(students, '%').map((s) => s.lastName), ['100%']);
  assert.deepEqual(filterStudentsByName(students, '_').length, 0);
});

test('sortStudentsByName: sortuje po nazwisku, potem imieniu, wg polskiego alfabetu', () => {
  const students = [
    { firstName: 'Ola', lastName: 'Żurek' },
    { firstName: 'Jan', lastName: 'Adamski' },
    { firstName: 'Ala', lastName: 'Adamski' },
  ];
  const sorted = sortStudentsByName(students).map((s) => `${s.lastName} ${s.firstName}`);
  assert.deepEqual(sorted, ['Adamski Ala', 'Adamski Jan', 'Żurek Ola']);
});

test('pulpit zarządu (#131): trasa, wiersze bez sortowania, „—” zamiast brakującego odsetka, bez słów o długu', () => {
  assert.deepEqual(parseRoute('#/overview'), { view: 'overview' });
  const entry = (name, rate) => ({
    name, studentCount: 3, householdCount: 2, representative: { active: 1, pendingInvites: 0 },
    contactEmailCount: 2, noContactCount: 1, ...(rate === undefined ? {} : { paymentEntryRatePercent: rate }),
  });
  const withPayments = { classes: [entry('1B', 40), entry('1A', null)], totals: { ...entry('Razem', 33), unmatchedPaymentsCount: 1 } };
  const view = overviewRows(withPayments);
  assert.equal(view.withPayments, true);
  assert.deepEqual(view.rows.map((row) => row[0]), ['1B', '1A'], 'kolejność serwera, bez sortowania po odsetku');
  assert.deepEqual(view.rows[0].slice(-1), ['40%']);
  assert.deepEqual(view.rows[1].slice(-1), ['—'], 'klasa poniżej progu');
  assert.deepEqual(view.total.slice(0, 2), ['Razem', '3']);
  const without = overviewRows({ classes: [entry('1A')], totals: entry('Razem') });
  assert.equal(without.withPayments, false);
  assert.equal(without.rows[0].length, 7, 'brak kolumny wpłat bez dostępu');
  assert.equal(hasPaymentColumn({ classes: [], totals: entry('Razem') }), false);
  assert.equal(formatPercent(undefined), '—');
  assert.doesNotMatch(JSON.stringify(view), /dłużnik|zaległoś/i);
});

test('pulpit przedstawiciela: wiersz tabeli bez słów o zaległościach', () => {
  const row = overviewRow({
    id: 'c-1a', name: '1A', studentCount: 20, needsPaperCardCount: 3,
    cards: { lastPrintedAt: null }, events: { draftCount: 1, submittedCount: 2 },
    nextMeeting: null, documents: { activeCount: 0, latestAt: null },
  });
  assert.equal(row.paperCards, '3 z 20');
  assert.equal(row.meeting, 'brak zaplanowanego');
  assert.doesNotMatch(JSON.stringify(row), /dłużnik|zaległoś|brak wpłaty/i);
});

test('pulpit przedstawiciela jest wołany tylko z przydziałem representative (bez 403 dla zarządu)', async () => {
  assert.equal(hasRepresentativeGrant([{ role: 'representative', classId: 'c-1' }]), true);
  assert.equal(hasRepresentativeGrant([{ role: 'board' }, { role: 'treasurer' }, { role: 'admin' }]), false);
  assert.equal(hasRepresentativeGrant([]), false);
  assert.equal(hasRepresentativeGrant(undefined), false);
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../families/main.js', import.meta.url), 'utf8');
  assert.match(main, /state\.isRepresentative \? groups : \[\]/);
});

test('adres eksportu statystyk klas (#131) jest kodowany i walidowany', () => {
  assert.equal(boardOverviewExportUrl('y-2026', 'csv'), '/api/board/overview/export.csv?schoolYearId=y-2026');
  assert.equal(boardOverviewExportUrl('y-2026', 'xlsx'), '/api/board/overview/export.xlsx?schoolYearId=y-2026');
  assert.throws(() => boardOverviewExportUrl('', 'csv'));
  assert.throws(() => boardOverviewExportUrl('../x', 'csv'));
  assert.throws(() => boardOverviewExportUrl('y-2026', 'json'));
  assert.equal(exportFilename('attachment; filename="statystyki-klas-y-2026-20260929.csv"', 'x.csv'), 'statystyki-klas-y-2026-20260929.csv');
  assert.equal(exportFilename('attachment; filename="../../etc"', 'x.csv'), 'x.csv');
  assert.equal(exportFilename(null, 'x.csv'), 'x.csv');
});

test('zakończenie opieki: adresy tras, ciała żądań i walidacja (#86)', () => {
  const ok = { date: '2026-10-01', reason: '  Przeprowadzka rodziny  ' };
  assert.deepEqual(buildEndRequest({ kind: 'enrollment', studentId: 's-1', enrollmentId: 'e-1' }, ok), {
    url: '/api/students/s-1/enrollments/e-1/end', method: 'POST', body: { endedOn: '2026-10-01', reason: 'Przeprowadzka rodziny' },
  });
  const relation = { kind: 'relation', guardianId: 'g-1', studentId: 's-1' };
  assert.deepEqual(buildEndRequest(relation, ok).body, { endsOn: '2026-10-01', reason: 'Przeprowadzka rodziny' });
  assert.equal(buildEndRequest(relation, ok).url, '/api/guardians/g-1/students/s-1/end');
  assert.equal(buildEndRequest({ kind: 'studentHousehold', studentId: 's-1', membershipId: 'm-1' }, ok).url, '/api/students/s-1/households/m-1/end');
  assert.equal(buildEndRequest({ kind: 'guardianHousehold', guardianId: 'g-1', membershipId: 'm-2' }, ok).url, '/api/guardians/g-1/households/m-2/end');
  assert.equal(buildEndRequest(relation, { ...ok, confirmPersonalData: true }).body.confirmPersonalData, true);
  // Błędne dane: brak identyfikatora, ścieżka w id, data, krótki i zbyt długi powód.
  assert.ok(buildEndRequest({ kind: 'enrollment', studentId: 's-1' }, ok).error);
  assert.ok(buildEndRequest({ kind: 'enrollment', studentId: '../x', enrollmentId: 'e-1' }, ok).error);
  assert.ok(buildEndRequest({ kind: 'nieznany' }, ok).error);
  assert.ok(buildEndRequest(relation, { ...ok, date: '2026-02-30' }).error);
  assert.ok(buildEndRequest(relation, { ...ok, reason: 'ab' }).error);
  assert.ok(buildEndRequest(relation, { ...ok, reason: 'x'.repeat(501) }).error);
  assert.equal(isValidDate('2026-10-01'), true);
  assert.equal(isValidDate('01-10-2026'), false);
});

test('zakończenie opieki: komunikaty i ostrzeżenia z odpowiedzi serwera (#86)', () => {
  assert.deepEqual(endResultMessages('enrollment', { changed: true }), ['Zapisano odejście ucznia ze szkoły.']);
  assert.match(endResultMessages('relation', { changed: false })[0], /już zapisana/);
  const withCampaigns = endResultMessages('relation', { changed: true, campaignsToReview: ['k-1', 'k-2'] });
  assert.equal(withCampaigns.length, 2);
  assert.match(withCampaigns[1], /k-1, k-2/);
  assert.match(endResultMessages('studentHousehold', { changed: true, withoutPrimaryHousehold: true })[1], /głównego gospodarstwa/);
  assert.match(endResultMessages('guardianHousehold', { changed: true, withoutHousehold: true })[1], /żadnego bieżącego gospodarstwa/);
  assert.equal(endResultMessages('relation', { changed: true, campaignsToReview: [] }).length, 1);
});

test('zakończenie członkostwa opiekuna: przycisk tylko dla zakresu szerokiego (UX, decyduje serwer)', () => {
  assert.equal(canEndGuardianHousehold([{ role: 'admin', classId: null }]), true);
  assert.equal(canEndGuardianHousehold([{ role: 'board' }]), true);
  assert.equal(canEndGuardianHousehold([{ role: 'board', classId: 'c-1' }]), false);
  assert.equal(canEndGuardianHousehold([{ role: 'treasurer' }, { role: 'representative', classId: 'c' }]), false);
  assert.equal(canEndGuardianHousehold(null), false);
});

test('guardianEmailText: brak pola email (sesja bez MFA, #751) to „ukryty — wymaga MFA”, nie „brak adresu”', () => {
  assert.equal(guardianEmailText({ id: 'g-1', contactAllowed: true }), 'ukryty — wymaga MFA');
  assert.equal(guardianEmailText({ id: 'g-1', contactAllowed: false }), 'ukryty — wymaga MFA');
  assert.equal(guardianEmailText({ id: 'g-1', contactAllowed: true, email: 'opiekun@example.invalid' }), 'opiekun@example.invalid');
  assert.equal(guardianEmailText({ id: 'g-1', contactAllowed: true, email: null }), '—');
  assert.equal(guardianEmailText({ id: 'g-1', contactAllowed: false, email: null }), 'ukryty');
});
