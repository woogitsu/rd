// Test integracyjny cyklu roku szkolnego (issue #207, część 2). Jeden plik,
// jedna instancja PGlite, wyłącznie `handlePgRequest` — poza dwoma krokami,
// które dziś w ogóle nie mają API (oznaczone niżej `// SQL: brak API`).
// Dane wyłącznie syntetyczne (`@example.invalid`), bez wysyłki e-mail
// (kampania jest tylko zatwierdzana i kolejkowana, nie ma testowego transportu —
// #207 zakres nie obejmuje wysyłki).
//
// Scenariusz idzie krok po kroku przez tabelę z opisu issue #207 i sprawdza
// asercje MIĘDZY modułami (kryteria akceptacji):
//   - liczba rodzin z importu = liczba kartek roku = recipientsCount + exclusions kampanii,
//   - suma netto wpłat recorded = przychód z kategorii składek w księdze,
//   - saldo zamknięcia roku = bilans otwarcia roku następnego (przeniesiony),
//   - raport KR i zestawienie przekazania podają te same sumy co księga,
//   - po odtworzeniu paczki eksportu kroki 3–5 i 13 dają ten sam wynik.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { guessMapping, parseCsv, toServerPayload, validateRows } from '../import/core.js';
import {
  createMeeting,
  createResolution,
  determineQuorum,
  recordAttendance,
} from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { buildYearlyExport, restoreBundle } from '../src/pg/export.js';
import { buildHouseholds, parseInputRows } from '../print/core.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-2026';
const Y2 = 'y-2027';
const HEADER = 'ID ucznia;Imię ucznia;Nazwisko ucznia;Klasa;ID rodziny;Opiekun 1;E-mail opiekuna 1;Opiekun 2;E-mail opiekuna 2';
const REASON = 'Zgoda potwierdzona telefonicznie po imporcie (#207, dane syntetyczne).';

test('cały cykl roku szkolnego przez API: import, kartki, kampania, księga, uzgodnienie, ' +
  'raport KR, eksport, zamknięcie, przekazanie i nowy rok (#207)', async () => {
  const db = await createTestDb();
  try {
    async function call(path, cookie, { method = 'GET', body, key } = {}) {
      const response = await handlePgRequest(request(path, {
        method, cookie, body, headers: key ? { 'Idempotency-Key': key } : {},
      }), { db, APP_ENV: 'test' });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    const get = (path, cookie) => call(path, cookie);
    const post = (path, cookie, body, key) => call(path, cookie, { method: 'POST', body, key });
    const patch = (path, cookie, body) => call(path, cookie, { method: 'PATCH', body });

    // --- Krok 1: rok szkolny i klasy --------------------------------------
    // SQL: brak API (#78) — tworzenie roku szkolnego i klas jest dziś tylko SQL.
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await db.query(`INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', $1, '1A'), ('c-2b', $1, '2B')`, [Y1]);

    // --- Krok 2: konta zarządu, skarbnika, Komisji Rewizyjnej -------------
    // SQL: brak API (D-10) — zaproszenie ma dziś API, ale akceptacja konta
    // przez zaproszoną osobę jest poza zakresem testu (brak D-10); konta i
    // sesje są tu seedowane bezpośrednio, jak zakłada BRIEF dla tego repo.
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y1 }], mfa: true });
    const board2 = await seedUserSession(db, { userId: 'u-board2', roles: [{ role: 'board', schoolYearId: Y1 }], mfa: true });
    const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y1 }], mfa: true });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: Y1 }], mfa: true });
    await seedUserSession(db, { userId: 'u-rep', roles: [], mfa: true });

    // --- Krok 3: import uczniów i opiekunów -------------------------------
    // Rodzeństwo Oli i Jana (rodzina H2) w dwóch klasach, dwoje opiekunów w H1,
    // wiersz z błędnym e-mailem jednego opiekuna (krok 3a, #207): nie jest
    // pomijany — uczeń i opiekun trafiają do bazy, adres zostaje pusty.
    const csv = `${HEADER}\n`
      + 'S1;Ala;Testowa;1A;H1;Anna Testowa;anna@example.invalid;Piotr Testowy;piotr@example.invalid\n'
      + 'S2;Ola;Nowak;1A;H2;Ewa Nowak;zly-adres;;\n'
      + 'S3;Jan;Nowak;2B;H2;Ewa Nowak;zly-adres;;\n';
    const parsed = validateRows(parseCsv(csv), guessMapping(parseCsv(csv)[0]), { allowedClasses: ['1A', '2B'] });
    assert.equal(parsed.errors.length, 0, '#207 krok 3a: błędny e-mail jednego opiekuna nie odrzuca wiersza');
    assert.ok(parsed.warnings.some((w) => /Niepoprawny adres e-mail/.test(w.message)));
    const importPayload = toServerPayload(parsed, Y1);
    const importPreview = await post('/api/import/preview', admin, importPayload);
    assert.equal(importPreview.status, 200, JSON.stringify(importPreview.body));
    assert.equal(importPreview.body.counts.rowsAdded, 3);
    assert.equal(importPreview.body.counts.rowsSkipped, 0);

    // #145 (D-06): commit importu wymaga opublikowanej informacji o
    // przetwarzaniu danych — bez niej `/api/import/commit` odmawia
    // (`409 privacy_notice_missing`). Zarząd zatwierdza wersję innej osoby
    // niż autor (four-eyes), więc publikuje ją `board2`.
    const noticeDraft = await post('/api/admin/privacy-notices', admin, {
      bodyText: 'Informacja o przetwarzaniu danych — treść syntetyczna testu #207.',
      decisionRef: 'D-06/test-207',
    });
    assert.equal(noticeDraft.status, 201, JSON.stringify(noticeDraft.body));
    const noticeApproved = await post(`/api/admin/privacy-notices/${noticeDraft.body.notice.id}/approve`, board2);
    assert.equal(noticeApproved.status, 200, JSON.stringify(noticeApproved.body));
    const noticePublished = await post(`/api/admin/privacy-notices/${noticeDraft.body.notice.id}/publish`, board2);
    assert.equal(noticePublished.status, 200, JSON.stringify(noticePublished.body));

    const importCommit = await post('/api/import/commit', admin, {
      ...importPayload, fingerprint: importPreview.body.fingerprint, planDigest: importPreview.body.planDigest,
    }, 'import-y1-0001');
    assert.equal(importCommit.status, 201, JSON.stringify(importCommit.body));
    // Ponowienie z tym samym kluczem jest idempotentne (podwójne kliknięcie).
    const importRetry = await post('/api/import/commit', admin, {
      ...importPayload, fingerprint: importPreview.body.fingerprint, planDigest: importPreview.body.planDigest,
    }, 'import-y1-0001');
    assert.equal(importRetry.status, 200);
    const FAMILY_COUNT = 2; // H1, H2 (rodzeństwo Oli i Jana liczy się raz)

    // --- Krok 4: przydział przedstawiciela klasy 1A -----------------------
    const grant = await post('/api/admin/grants', admin, { userId: 'u-rep', role: 'representative', classId: 'c-1a', schoolYearId: Y1 });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));

    // --- Krok 5: kartki klasy i całego roku --------------------------------
    const cardsYear = await get(`/api/print/cards?schoolYearId=${Y1}`, board);
    assert.equal(cardsYear.status, 200, JSON.stringify(cardsYear.body));
    const householdsOfCards = buildHouseholds(parseInputRows(cardsYear.body.rows).rows).households;
    assert.equal(householdsOfCards.length, FAMILY_COUNT, 'liczba kartek roku = liczba rodzin z importu');
    // Identyfikatory rodzin nadaje baza (households.id) — "H1"/"H2" z pliku importu
    // to tylko source_ref; dalsze kroki (wpłaty, zgoda) odwołują się do id z API.
    const HH1 = cardsYear.body.rows.find((r) => r.firstName === 'Ala').householdId;
    const HH2 = cardsYear.body.rows.find((r) => r.firstName === 'Ola').householdId;
    const cards1a = await get(`/api/print/cards?schoolYearId=${Y1}&classId=c-1a`, admin);
    assert.equal(cards1a.status, 200);
    // Klasa 1A ma uczennice z obu rodzin (Ala z H1, Ola z H2) — pełne rodzeństwo z 2B dochodzi tylko w roku.
    assert.deepEqual(new Set(cards1a.body.rows.map((r) => r.householdId)), new Set([HH1, HH2]));

    // --- Krok 6: zgoda na kontakt (opiekun i relacja) przez API, kampania --
    // Przed zgodą kampania miałaby 0 odbiorców mimo poprawnych adresów (#190).
    const h1 = await get(`/api/households/${HH1}`, admin);
    assert.equal(h1.status, 200, JSON.stringify(h1.body));
    const anna = h1.body.guardians.find((g) => g.email === 'anna@example.invalid');
    assert.ok(anna, 'opiekun H1 z poprawnym adresem istnieje po imporcie');
    const ala = h1.body.students.find((s) => s.firstName === 'Ala');
    const consentGuardian = await patch(`/api/guardians/${anna.id}/contact`, board, { contactAllowed: true, reason: REASON });
    assert.equal(consentGuardian.status, 200, JSON.stringify(consentGuardian.body));
    const consentRelation = await patch(`/api/guardians/${anna.id}/students/${ala.id}`, board, { contactAllowed: true, reason: REASON });
    assert.equal(consentRelation.status, 200, JSON.stringify(consentRelation.body));

    const campaignDraft = await post('/api/email/campaigns', treasurer, {
      schoolYearId: Y1, title: 'Przypomnienie jesienne', audience: 'all_households',
      subject: 'Dobrowolna składka {rok}', bodyText: 'Tytuł przelewu: {rodzina}. To wiadomość testowa, bez wysyłki.',
    }, 'campaign-y1-0001');
    assert.equal(campaignDraft.status, 201, JSON.stringify(campaignDraft.body));
    const campaignId = campaignDraft.body.campaign.id;
    const snapshot = await post(`/api/email/campaigns/${campaignId}/snapshot`, treasurer, {}, 'campaign-snap-0001');
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    // H1 (zgoda + poprawny adres) dostaje wiadomość; H2 nie ma zgody i nie ma
    // poprawnego adresu (oba powody naraz — liczy się jeden, pierwszy sprawdzany).
    assert.equal(snapshot.body.recipientsCount, 1);
    const exclusionsTotal = Object.values(snapshot.body.exclusions).reduce((sum, n) => sum + n, 0);
    assert.equal(snapshot.body.recipientsCount + exclusionsTotal, FAMILY_COUNT,
      '#207: liczba rodzin = odbiorcy kampanii + wykluczenia');

    // --- Krok 7: kategorie księgi przez API (#207, część 1) ---------------
    const catIncome = await post('/api/ledger/categories', board, { schoolYearId: Y1, direction: 'income', name: 'Składki dobrowolne' });
    assert.equal(catIncome.status, 201, JSON.stringify(catIncome.body));
    const catExpense = await post('/api/ledger/categories', board, { schoolYearId: Y1, direction: 'expense', name: 'Wycieczki' });
    assert.equal(catExpense.status, 201, JSON.stringify(catExpense.body));
    const incomeCategoryId = catIncome.body.category.id;
    const expenseCategoryId = catExpense.body.category.id;

    // --- Krok 8: bilans otwarcia pierwszego roku przez API (#199) ---------
    const opening = await post('/api/ledger/opening-balance', board, {
      schoolYearId: Y1, bankCents: 500000, cashCents: 0, note: 'Stan z papierowej księgi na dzień przejęcia (dane syntetyczne).',
    }, 'opening-y1-0001');
    assert.equal(opening.status, 201, JSON.stringify(opening.body));
    assert.equal(opening.body.current.amountCents, 500000);

    // --- Krok 9: wpłaty (pełna, gotówka + korekta, nierozpoznana + przypisanie) ---
    const payFull = await post('/api/payments', treasurer, {
      schoolYearId: Y1, householdId: HH1, amountCents: 5000, receivedOn: '2026-09-20', method: 'bank', reference: 'H1 SEPT',
    }, 'pay-h1-0001');
    assert.equal(payFull.status, 201, JSON.stringify(payFull.body));
    const payCash = await post('/api/payments', treasurer, {
      schoolYearId: Y1, householdId: HH1, amountCents: 2000, receivedOn: '2026-09-25', method: 'cash', reference: null,
    }, 'pay-h1-0002');
    assert.equal(payCash.status, 201, JSON.stringify(payCash.body));
    const correction = await post(`/api/payments/${payCash.body.payment.id}/corrections`, treasurer, {
      amountCents: 500, reason: 'Pomyłka w kwocie gotówki (dane syntetyczne).',
    }, 'corr-h1-0001');
    assert.equal(correction.status, 201, JSON.stringify(correction.body));
    const payUnmatched = await post('/api/payments', treasurer, {
      schoolYearId: Y1, householdId: null, amountCents: 3000, receivedOn: '2026-09-22', method: 'bank', reference: 'nieznany nadawca',
    }, 'pay-unmatched-0001');
    assert.equal(payUnmatched.status, 201, JSON.stringify(payUnmatched.body));
    const assignment = await post(`/api/payments/${payUnmatched.body.payment.id}/assignment`, treasurer, { householdId: HH2 }, 'assign-h2-0001');
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
    // Podwójne kliknięcie przypisania jest idempotentne.
    const assignmentRetry = await post(`/api/payments/${payUnmatched.body.payment.id}/assignment`, treasurer, { householdId: HH2 }, 'assign-h2-0001');
    assert.equal(assignmentRetry.status, 200);
    const recordedNetTotal = 5000 + (2000 - 500) + 3000; // #10: ujęte ręcznie w księdze, wpis po wpisie

    // --- Krok 10: ujęcie wpłat w księdze -----------------------------------
    const entryFull = await post('/api/ledger', treasurer, {
      schoolYearId: Y1, direction: 'income', amountCents: 5000, categoryId: incomeCategoryId, description: 'Składka H1 wrzesień',
      occurredOn: '2026-09-20', paymentEntryId: payFull.body.payment.id, method: 'bank',
    }, 'entry-h1-full-0001');
    assert.equal(entryFull.status, 201, JSON.stringify(entryFull.body));
    const entryCash = await post('/api/ledger', treasurer, {
      schoolYearId: Y1, direction: 'income', amountCents: 1500, categoryId: incomeCategoryId, description: 'Składka H1 gotówka (po korekcie)',
      occurredOn: '2026-09-25', paymentEntryId: payCash.body.payment.id, method: 'cash',
    }, 'entry-h1-cash-0001');
    assert.equal(entryCash.status, 201, JSON.stringify(entryCash.body));
    const entryAssigned = await post('/api/ledger', treasurer, {
      schoolYearId: Y1, direction: 'income', amountCents: 3000, categoryId: incomeCategoryId, description: 'Składka H2 (przypisana)',
      occurredOn: '2026-09-22', paymentEntryId: payUnmatched.body.payment.id, method: 'bank',
    }, 'entry-h2-0001');
    assert.equal(entryAssigned.status, 201, JSON.stringify(entryAssigned.body));

    // --- Krok 11: wydatek > 3000 EUR z dowodem i uchwałą -------------------
    // Zebranie, kworum i uchwała są dziś domenowymi funkcjami wywoływanymi
    // bezpośrednio (moduł zebrań ma własną trasę HTTP, ale seed przez funkcje
    // domenowe jest szybszy i tego samego kontraktu — jak w tests/pg-export.test.js).
    const boardActor = { userId: 'u-board', grants: [{ role: 'board', classId: null, schoolYearId: Y1, expiresAt: null }], mfaVerified: true };
    const { meeting } = await createMeeting(db, boardActor, {
      idempotencyKey: 'meeting-y1-0001', schoolYearId: Y1, kind: 'plenary', title: 'Zebranie jesienne',
      scheduledAt: '2026-10-01T17:00:00Z', status: 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1,
      quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, boardActor, { meetingId: meeting.id, status: 'held' });
    await recordAttendance(db, boardActor, { meetingId: meeting.id, userId: 'u-board', capacity: 'representative', votingEligible: true, present: true });
    const { quorumCheck } = await determineQuorum(db, boardActor, { idempotencyKey: 'quorum-y1-0001', meetingId: meeting.id });
    await createResolution(db, boardActor, {
      idempotencyKey: 'resolution-y1-0001', meetingId: meeting.id, number: 'UCH/2026/1', title: 'Zakup wyposażenia na wycieczkę',
      body: 'Treść testowa.', status: 'adopted', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    });
    const expense = await post('/api/ledger', treasurer, {
      schoolYearId: Y1, direction: 'expense', amountCents: 300000, categoryId: expenseCategoryId, description: 'Wycieczka klasowa',
      occurredOn: '2026-10-05', method: 'bank', resolutionReference: 'UCH/2026/1',
    }, 'entry-expense-0001');
    assert.equal(expense.status, 201, JSON.stringify(expense.body));

    // --- Krok 12: uzgodnienie wyciągu ---------------------------------------
    const reconciliation = await post('/api/reconciliations', treasurer, {
      schoolYearId: Y1, statementDate: '2027-06-30', statementBalanceCents: 200000,
    }, 'reconciliation-y1-0001');
    assert.equal(reconciliation.status, 201, JSON.stringify(reconciliation.body));
    const reconciliationId = reconciliation.body.reconciliation.id;
    const lines = await post(`/api/reconciliations/${reconciliationId}/lines`, treasurer, {
      lines: [
        { bookedOn: '2026-09-20', amountCents: 5000, reference: 'H1 SEPT' },
        { bookedOn: '2026-09-22', amountCents: 3000, reference: 'nieznany nadawca' },
        { bookedOn: '2026-10-05', amountCents: -300000, reference: 'Faktura wycieczka' },
      ],
    }, 'reconciliation-lines-0001');
    assert.equal(lines.status, 201, JSON.stringify(lines.body));
    const suggestions = await get(`/api/reconciliations/${reconciliationId}/suggestions`, treasurer);
    assert.equal(suggestions.status, 200);
    for (const suggestion of suggestions.body.suggestions) {
      if (suggestion.candidates.length !== 1) continue;
      const match = await post(`/api/reconciliations/${reconciliationId}/matches`, treasurer, {
        statementLineId: suggestion.statementLineId, ledgerEntryId: suggestion.candidates[0].id,
      }, `match-${suggestion.statementLineId}`);
      assert.equal(match.status, 201, JSON.stringify(match.body));
    }
    // Zasada czterech oczu: potwierdza inna osoba niż ta, która utworzyła projekt.
    const confirm = await post(`/api/reconciliations/${reconciliationId}/confirm`, board, {
      confirmationNote: 'Różnica: wpłata w kasie (gotówka) nieujęta na wyciągu bankowym (dane syntetyczne).',
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

    // --- Krok 13: raport dla Komisji Rewizyjnej -----------------------------
    const auditReport = await get(`/api/reports/audit?schoolYearId=${Y1}`, audit);
    assert.equal(auditReport.status, 200, JSON.stringify(auditReport.body));
    const { report } = auditReport.body;
    assert.equal(report.balance.openingBalanceCents, 500000);
    assert.equal(report.balance.incomeCents, recordedNetTotal);
    assert.equal(report.balance.expenseCents, 300000);
    const closingBalanceCents = report.balance.closingBalanceCents;
    assert.equal(closingBalanceCents, 500000 + recordedNetTotal - 300000);
    // Wydatek z przyjętą uchwałą o pasującym numerze nie jest oznaczony jako `flagged`.
    assert.equal(report.expenseFlags?.length ?? 0, 0, 'wydatek z uchwałą nie jest oznaczony');
    const incomeCategory = report.categories.find((c) => c.id === incomeCategoryId);
    assert.equal(incomeCategory.netCents, recordedNetTotal, '#207: netto wpłat recorded = przychód kategorii składek w księdze');
    // Komisja Rewizyjna nie ma dostępu do księgi (#137, #161) — tylko do raportu.
    assert.equal((await get(`/api/ledger?schoolYearId=${Y1}`, audit)).status, 403);

    // --- Krok 14: eksport roczny ---------------------------------------------
    const exportResponse = await post('/api/exports', board, { schoolYearId: Y1 });
    assert.equal(exportResponse.status, 200, JSON.stringify(exportResponse.body));
    const bundle = exportResponse.body;
    const studentsInBundle = bundle.files['students.jsonl'].trim().split('\n').filter(Boolean).length;
    const householdsInBundle = bundle.files['households.jsonl'].trim().split('\n').filter(Boolean).length;
    assert.equal(studentsInBundle, 3);
    assert.equal(householdsInBundle, FAMILY_COUNT, '#207: eksport podaje tę samą liczbę rodzin co kartki i kampania');

    // --- Krok 15: zamknięcie roku (cztery oczy, lista kontrolna) ------------
    // SQL: brak API (#78) — rok następny musi istnieć, zanim można rozpocząć zamknięcie.
    await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    await db.query(`INSERT INTO classes (id, school_year_id, name) VALUES ('c-2a', $1, '2A'), ('c-3b', $1, '3B')`, [Y2]);

    const start = await post(`/api/year-close/${Y1}/start`, board, { nextSchoolYearId: Y2 });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    for (const item of [
      'financial_report', 'audit_commission_report', 'minutes_approved',
      'resolutions_archived', 'reconciliation_confirmed', 'documents_handed_over',
    ]) {
      const checked = await post(`/api/year-close/${Y1}/checklist/${item}`, treasurer, { note: `Potwierdzone (${item}), dane syntetyczne.` });
      assert.equal(checked.status, 201, `${item}: ${JSON.stringify(checked.body)}`);
    }
    // Cztery oczy: osoba rozpoczynająca zamknięcie nie może go też zakończyć.
    const closeBySameActor = await post(`/api/year-close/${Y1}/close`, board, {});
    assert.equal(closeBySameActor.status, 409);
    const close = await post(`/api/year-close/${Y1}/close`, board2, {});
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(close.body.balance.closingBalanceCents, closingBalanceCents);

    // --- Krok 16: przekazanie nowej Radzie -----------------------------------
    const handover = await get(`/api/year-close/${Y1}/handover`, admin);
    assert.equal(handover.status, 200, JSON.stringify(handover.body));
    assert.equal(handover.body.final, true);
    assert.equal(handover.body.finance.closingBalanceCents, closingBalanceCents,
      '#207: zestawienie przekazania podaje to samo saldo co raport KR i zamknięcie');
    assert.equal(handover.body.finance.nextYearOpeningBalance.carriedFromClosure, true);
    // Nowa Rada roku Y2 dostaje własne przydziały (nie ma ich automatycznie — #195).
    const boardNextYear = await seedUserSession(db, { userId: 'u-board-y2', roles: [{ role: 'board', schoolYearId: Y2 }], mfa: true });

    // --- Krok 17: bilans otwarcia nowego roku (przeniesiony automatycznie) --
    const nextOpening = await get(`/api/ledger/opening-balance?schoolYearId=${Y2}`, admin);
    assert.equal(nextOpening.status, 200, JSON.stringify(nextOpening.body));
    assert.equal(nextOpening.body.current.amountCents, closingBalanceCents,
      '#207: bilans otwarcia roku następnego = saldo zamknięcia roku poprzedniego');
    // Ręczny bilans otwarcia jest zarezerwowany dla pierwszego roku systemu (#199).
    const manualOpeningRefused = await post('/api/ledger/opening-balance', boardNextYear, {
      schoolYearId: Y2, bankCents: 1, cashCents: 0, note: 'Próba ręcznego bilansu drugiego roku.',
    }, 'opening-y2-manual-0001');
    assert.equal(manualOpeningRefused.status, 409);
    assert.equal(manualOpeningRefused.body.error, 'opening_balance_exists');

    // --- Krok 18: promocja — import pliku nowego roku (te same ID uczniów) --
    const promotionCsv = `${HEADER}\n`
      + 'S1;Ala;Testowa;2A;H1;Anna Testowa;anna@example.invalid;Piotr Testowy;piotr@example.invalid\n'
      + 'S2;Ola;Nowak;2A;H2;Ewa Nowak;zly-adres;;\n'
      + 'S3;Jan;Nowak;3B;H2;Ewa Nowak;zly-adres;;\n';
    const promotionParsed = validateRows(parseCsv(promotionCsv), guessMapping(parseCsv(promotionCsv)[0]), { allowedClasses: ['2A', '3B'] });
    const promotionPayload = toServerPayload(promotionParsed, Y2);
    const promotionPreview = await post('/api/import/preview', admin, promotionPayload);
    assert.equal(promotionPreview.status, 200, JSON.stringify(promotionPreview.body));
    assert.equal(promotionPreview.body.counts.rowsUpdated, 3, 'promocja aktualizuje istniejących uczniów, nie tworzy nowych rodzin');
    assert.equal(promotionPreview.body.counts.householdsCreated, 0);
    const promotionCommit = await post('/api/import/commit', admin, {
      ...promotionPayload, fingerprint: promotionPreview.body.fingerprint, planDigest: promotionPreview.body.planDigest,
    }, 'import-y2-0001');
    assert.equal(promotionCommit.status, 201, JSON.stringify(promotionCommit.body));

    // --- Krok 19: kategorie nowego roku (kopiowanie, #207 część 1) ----------
    const copyDryRun = await post('/api/ledger/categories/copy', boardNextYear, { fromSchoolYearId: Y1, toSchoolYearId: Y2, dryRun: true });
    assert.equal(copyDryRun.status, 200, JSON.stringify(copyDryRun.body));
    assert.equal(copyDryRun.body.copied.length, 2);
    const copyReal = await post('/api/ledger/categories/copy', boardNextYear, { fromSchoolYearId: Y1, toSchoolYearId: Y2, dryRun: false });
    assert.equal(copyReal.status, 200, JSON.stringify(copyReal.body));
    assert.equal(copyReal.body.copied.length, 2);
    const categoriesY2 = await get(`/api/ledger/categories?schoolYearId=${Y2}`, admin);
    assert.equal(categoriesY2.status, 200);
    assert.deepEqual(new Set(categoriesY2.body.categories.map((c) => c.name)), new Set(['Składki dobrowolne', 'Wycieczki']));
    // Podwójne kliknięcie kopiowania nie duplikuje kategorii.
    const copyAgain = await post('/api/ledger/categories/copy', boardNextYear, { fromSchoolYearId: Y1, toSchoolYearId: Y2, dryRun: false });
    assert.equal(copyAgain.body.copied.length, 0);
    assert.equal(copyAgain.body.skippedCount, 2);

    // --- Odtworzenie eksportu: kroki 3–5 i 13 dają ten sam wynik ------------
    const { bundle: rebuiltBundle } = await db.transaction((tx) => buildYearlyExport(tx, Y1));
    const target = await createTestDb();
    try {
      const restoreReport = await restoreBundle(target, rebuiltBundle);
      assert.equal(restoreReport.restored, true);
      assert.equal(restoreReport.reexportTotalsMatch, true);
      const { rows: restoredHouseholds } = await target.query('SELECT count(DISTINCT household_id)::int AS n FROM students');
      assert.equal(restoredHouseholds[0].n, FAMILY_COUNT, 'krok 3: liczba rodzin po odtworzeniu jest ta sama');
      const { rows: restoredStudents } = await target.query('SELECT count(*)::int AS n FROM students');
      assert.equal(restoredStudents[0].n, 3, 'kroki 3–5: liczba uczniów po odtworzeniu jest ta sama');
      const { rows: restoredSummary } = await target.query(
        'SELECT closing_balance_cents::int AS n FROM ledger_year_summary WHERE school_year_id = $1', [Y1],
      );
      assert.equal(restoredSummary[0].n, closingBalanceCents, 'krok 13: saldo po odtworzeniu jest to samo co w raporcie KR');
    } finally {
      await target.close();
    }
  } finally {
    await db.close();
  }
});
