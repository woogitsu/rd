// Macierz autoryzacji na rzeczywistych trasach API PostgreSQL (issue #4).
//
// Dla każdej trasy z tests/helpers/route-matrix.js i każdego aktora (role, przydział klasowy
// zarządu, brak przydziału, przydział wygasły/cofnięty, konto wyłączone, sesja wygasła/cofnięta,
// brak sesji) × MFA wł./wył. × zakres (własna klasa / inna klasa / dane ogólnoszkolne / inny rok)
// sprawdzamy:
//   1. status HTTP (401 / 403 / 404 / 2xx) zgodny z tabelą (zamierzona polityka),
//   2. odpowiedź odmowna nie zawiera żadnego syntetycznego znacznika danych,
//   3. odpowiedź 2xx nie zawiera znaczników zakresu, do którego aktor nie ma przydziału
//      (np. przedstawiciel 1A nigdy nie widzi danych 1B ani roku 2),
//   4. odmowa żądania zmieniającego stan niczego nie zapisuje (liczniki tabel i dziennika zdarzeń bez zmian).
// Przypadki oznaczone w macierzy `todo` (znane luki, np. SR-01) są wykonywane, ale ich rozbieżności
// trafiają do osobnego testu `todo` — CI pozostaje zielone, a luka jest widoczna w raporcie.
// Meta-test pilnuje, by każdy moduł z ROUTES i każda ścieżka w jego kodzie miały wpis w macierzy.
// Wyłącznie dane syntetyczne (domeny .invalid, znaczniki MRK-…). Żadna trasa nie wysyła poczty.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handlePgRequest, ROUTES } from '../src/pg/app.js';
import {
  approve, cancelTask, createDraft, createSignup, createTask, publish, submit, withdrawSignup,
} from '../src/pg/events.js';
import {
  addAgendaItem,
  approveMeetingNotice,
  approveMinutes,
  createMeeting,
  createMeetingNotice,
  createMinutesVersion,
  createResolution,
  determineQuorum,
  recordAttendance,
  setMinutesVisibility,
} from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import {
  AUDIT_ROW_PARENTS, AUDIT_ROW_ROUTE_EXEMPT, AUDIT_ROW_TECHNICAL, newRows, rowCoverageProblems, rowCoverageTables, rowIdSnapshot,
} from './helpers/audit-row-coverage.js';
import {
  addConsent, approve as approveNews, createDraft as createNewsDraft, publish as publishNews, registerPhoto,
  submit as submitNews, uploadPhotoFile, verifyPhoto,
} from '../src/pg/news.js';
import { hashSecret } from '../src/auth.js';
import { emailHash as suppressionEmailHash } from '../src/email/content.js';
import { createSession } from '../src/pg/auth.js';
import { assertNoPii } from '../src/pg/audit.js';
import { MFA_GATE_EXEMPT_EXACT, MFA_GATE_EXEMPT_PREFIXES } from '../src/pg/mfa-policy.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import { hashPassword } from '../src/pg/password.js';
import { generateStructuredReference } from '../src/pg/ogm.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedClass, seedDocument, seedEnrolledHousehold, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import {
  ACTOR_KEYS, ACTORS, MARKERS, MFA_GATE_EXEMPT_REASONS, REFERENCE_CASES, ROUTE_MATRIX, SCOPED_MARKER_KEYS, TARGETS, YEAR_1, YEAR_2,
  campaignBody, denyStatus, expectedStatus, importPayload, ledgerCategory, marker, mfaOnlyDenial, mfaPending, pdfBytes, PHOTO_SOURCE_DOCUMENT_ID, photoBody,
  pngBytes, safeKey, statementDate, todoReason, visibleScopes, yearDate,
} from './helpers/route-matrix.js';

const PAST = '2020-01-01T00:00:00Z';
const fxAdmin = { userId: 'u-fx-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };
const fxBoard = { userId: 'u-fx-board', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
// Konta pomocnicze fixture (poza macierzą): przydziały bez roku i klasy, sesje z MFA.
const FX_ACCOUNTS = {
  admin: { userId: 'u-fx-admin', role: 'admin' },
  board: { userId: 'u-fx-board', role: 'board' },
  board2: { userId: 'u-fx-board2', role: 'board' },
  treasurer: { userId: 'u-fx-treasurer', role: 'treasurer' },
};
// Sekret syntetyczny, wyłącznie na potrzeby testu (min. 32 znaki).
const WEBHOOK_SECRET = `syntetyczny-sekret-webhooka-${randomBytes(12).toString('hex')}`;
// Sekret podpisu tokenu wypisania (#110), wyłącznie na potrzeby testu.
const UNSUBSCRIBE_SECRET = `syntetyczny-sekret-wypisania-${randomBytes(12).toString('hex')}`;
const CHECKLIST_PREFILLED = ['financial_report', 'audit_commission_report', 'minutes_approved', 'resolutions_archived'];
const CHECKLIST_OPEN = ['reconciliation_confirmed', 'documents_handed_over'];
// Najniższy dozwolony koszt scrypt (N = 2^15) — szybsze testy tras logowania.
const FAST_SCRYPT = { SCRYPT_COST_LOG2: '15' };
const syntheticPassword = () => `Syntetyczne haslo ${randomBytes(6).toString('hex')}`;

let seq = 0;
const nextKey = (prefix) => `${prefix}-${String(++seq).padStart(5, '0')}`;
const isSuccess = (status) => status >= 200 && status < 300;

// #184: meta-test pokrycia audytem (AGENTS.md: trwały dziennik z aktorem, czasem i
// identyfikatorem obiektu). Trasa zapisu (metoda != GET), której UDANE wywołania w
// macierzy nie zostawiły ANI JEDNEGO zdarzenia audytu z actor_id, entity_type i
// entity_id, oblewa test. Wystarcza jedno zdarzenie na trasę, bo część przypadków
// macierzy to powtórki idempotentne (ta sama klasa, sesja już wygasła, kategorie już
// skopiowane) i słusznie nie tworzą nowego wpisu. Metadane każdego zdarzenia przechodzą
// assertNoPii. Wyjątki są jawne i uzasadnione; nie dopisuj tu trasy zmieniającej dane
// biznesowe — wtedy dopisz insertAuditEvent(tx, …) w trasie.
// Dodatkowo (#184 pkt 6) każdy NOWY wiersz tabeli z kolumną id musi mieć zdarzenie
// wskazujące go albo jego obiekt nadrzędny — listy w tests/helpers/audit-row-coverage.js.
export const AUDIT_EXEMPT_ROUTES = new Map([
  ['import.preview', 'podgląd: walidacja i różnica względem bazy, nic nie zapisuje (import.committed loguje commit)'],
  ['login.invitationPreview', 'podgląd zaproszenia (#164): tylko odczyt po tokenie, nic nie zapisuje; odmowy loguje auth.invitation_preview_failed — tests/pg-login.test.js'],
  ['admin.promotionPreview', 'podgląd promocji (#78): plan i skrót, nic nie zapisuje; zapis loguje promotion.applied/enrollment.promoted — tests/pg-promotions.test.js'],
  ['admin.promotionClassesPreview', 'podgląd kopii klas (#78): nic nie zapisuje; zapis loguje class.created — tests/pg-promotions.test.js'],
  ['ledger.categoryCopy', 'macierz wykonuje tylko podgląd (dryRun); rzeczywiste kopiowanie loguje ledger_category.copied — scenariusz w tests/audit-write-coverage.test.js'],
  ['families.enrollment', 'macierz przypisuje do tej samej klasy (powtórka, changed: false); utworzenie i zmiana logują enrollment.created/class_changed — tests/audit-write-coverage.test.js'],
  ['yearClose.start', 'baza grupy yearClose rozpoczyna zamknięcie w setupie, więc przypadki to powtórki; rozpoczęcie loguje year_close.started — tests/audit-write-coverage.test.js'],
  ['email.webhook', 'macierz wysyła zdarzenie „opened” (tylko dziennik techniczny email_webhook_events z kluczem deduplikacji); zmiana stanu adresu (bounce/spam) loguje email.address_suppressed'],
]);
// Trasy publiczne (bez sesji): zdarzenie musi mieć entity_type i entity_id, ale aktora
// nie ma kto wskazać — działa właściciel tokenu albo osoba spoza systemu.
export const AUDIT_ACTORLESS_ROUTES = new Map([
  ['email.preferences.post', 'publiczny link z podpisanym tokenem rodzica; zdarzenie email.preference.* bez konta'],
  ['guardianUpdates.submitPublic', 'publiczny formularz aktualizacji danych opiekuna; zdarzenie guardian_update_request.created bez konta'],
]);
const auditStats = new Map();
const withKey = (key) => ({ 'Idempotency-Key': key });

// ---------- fixtures ----------

// Zapisy gospodarstw hh-1/hh-2 idą do istniejących klas macierzy (bez nowych klas na listach).
const MATRIX_CLASSES = { [YEAR_1]: TARGETS.A.classId, [YEAR_2]: TARGETS.Y2.classId };

async function seedBase(db) {
  await seedSchoolYear(db, YEAR_1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, YEAR_2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  for (const target of [TARGETS.A, TARGETS.B, TARGETS.Y2]) {
    await seedClass(db, { id: target.classId, schoolYearId: target.schoolYearId });
  }
  for (const account of Object.values(FX_ACCOUNTS)) await seedUser(db, { userId: account.userId });
  await seedDocument(db, { id: PHOTO_SOURCE_DOCUMENT_ID, createdBy: 'u-fx-admin' });
  // #205: gospodarstwo we wpłacie musi mieć ucznia zapisanego w roku wpłaty (oba lata macierzy).
  await seedEnrolledHousehold(db, 'hh-1', [YEAR_1, YEAR_2], { classIds: MATRIX_CLASSES });
  // #138: cel ponownego przypisania wpłaty (payments.reassignment).
  await seedEnrolledHousehold(db, 'hh-2', [YEAR_1, YEAR_2], { classIds: MATRIX_CLASSES });
  // Kategorie księgi z nazwą niosącą znacznik roku (W1 = rok 1, Y2 = rok 2).
  for (const [year, scope] of [[YEAR_1, 'W1'], [YEAR_2, 'Y2']]) {
    await db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
       VALUES ($1, $2, 'income', $3, 'u-fx-admin'), ($4, $2, 'expense', $5, 'u-fx-admin')`,
      [`cat-in-${year}`, year, `Wpływy ${marker(scope)}`, `cat-out-${year}`, `Wydatki ${marker(scope)}`],
    );
  }
  // Rodziny: jedna na klasę + rodzeństwo w 1A i 1B (opiekun ze zgodą na kontakt).
  for (const key of ['A', 'B', 'Y2']) await makeHousehold(db, TARGETS[key], `hh-${key}`);
  // #205 (REFERENCE_CASES): identyfikatory spoza zakresu — konta bez przydziału w roku,
  // gospodarstwo zarchiwizowane i bez ucznia. hh-Y2 (wyżej) ma dziecko tylko w roku 2.
  await seedUser(db, { userId: 'u-fx-nogrant' });
  await seedUser(db, { userId: 'u-fx-rok2' });
  await db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('rg-fx-rok2', 'u-fx-rok2', 'treasurer', $1)", [YEAR_2]);
  await makeHousehold(db, TARGETS.A, 'hh-fx-arch');
  await db.query("UPDATE households SET archived_at = now() WHERE id = 'hh-fx-arch'");
  await db.query("INSERT INTO households (id) VALUES ('hh-fx-empty')");
  await db.query("INSERT INTO households (id) VALUES ('hh-sib')");
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
    VALUES ('gd-sib', 'hh-sib', 'Ewa', 'Opiekunka', 'opiekun-rodzenstwo@example.invalid', true)`);
  for (const key of ['A', 'B']) {
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, 'hh-sib', 'Jan', $2)",
      [`st-sib-${key}`, `Rodzeństwo ${marker(key)}`]);
    await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, 'gd-sib', true, true)",
      [`st-sib-${key}`]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [`en-sib-${key}`, `st-sib-${key}`, TARGETS[key].classId, YEAR_1]);
  }
  // #145 (D-06): import.commit wymaga opublikowanej informacji o przetwarzaniu
  // danych — poza zakresem tej macierzy (osobne testy w tests/pg-privacy-notice.test.js).
  await db.query(
    `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by, approved_by, approved_at, published_by, published_at)
     VALUES ('pn-fx', 'Informacja testowa.', repeat('a', 64), 'D-06/fx', 'published', 'u-fx-admin', 'u-fx-board', now(), 'u-fx-board', now())`,
  );
}

// `enrollments.class_id` jest NOT NULL: cele bez klasy (np. W1, dane ogólnoszkolne)
// dostają jednorazową syntetyczną klasę tego roku — sam fixture (żadna trasa jej
// nie widzi jako "klasę" w odpowiedzi, więc nie przecieka do asercji znaczników).
async function fallbackClassId(db, schoolYearId) {
  const id = `cls-fx-${schoolYearId}`;
  await db.query(
    `INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, 'Klasa fixture') ON CONFLICT (id) DO NOTHING`,
    [id, schoolYearId],
  );
  return id;
}

async function makeHousehold(db, target, householdId = nextKey('fx-hh')) {
  const guardianId = `${householdId}-g`;
  const studentId = `${householdId}-s`;
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
    VALUES ($1, $2, 'Anna', 'Opiekunka', $3, true)`, [guardianId, householdId, `${guardianId.toLowerCase()}@example.invalid`]);
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Ola', $3)",
    [studentId, householdId, `Uczennica ${marker(target.key)}`]);
  await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)',
    [studentId, guardianId]);
  const enrollmentId = `${householdId}-e`;
  const classId = target.classId ?? await fallbackClassId(db, target.schoolYearId);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
    [enrollmentId, studentId, classId, target.schoolYearId]);
  const membership = await db.query('SELECT id FROM student_households WHERE student_id = $1 AND is_primary', [studentId]);
  return { householdId, guardianId, studentId, enrollmentId, membershipId: membership.rows[0].id };
}

// #200: opiekun z aktywnymi relacjami z DWOMA uczniami z różnych klas tego samego roku
// (rodzeństwo we wspólnym gospodarstwie). Zarząd z przydziałem jednej klasy nie zmienia
// jego globalnego kontaktu (403 guardian_shared_outside_scope). Dla roku bez drugiej klasy
// (Y2) drugi uczeń trafia do tej samej klasy — trasa i tak odmawia poza zakresem roku.
async function makeSharedGuardianHousehold(db, target) {
  const base = await makeHousehold(db, target);
  const otherClassId = { A: TARGETS.B.classId, B: TARGETS.A.classId }[target.key] ?? target.classId;
  const studentId = `${base.householdId}-s2`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Jan', $3)",
    [studentId, base.householdId, 'Syntetyczny']);
  await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, false)',
    [studentId, base.guardianId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
    [`${base.householdId}-e2`, studentId, otherClassId, target.schoolYearId]);
  return base;
}

async function seedFixtureSessions(db) {
  const cookies = {};
  for (const [name, account] of Object.entries(FX_ACCOUNTS)) {
    cookies[name] = await seedUserSession(db, { userId: account.userId, roles: [{ role: account.role }], mfa: true });
  }
  return cookies;
}

// Świeżość MFA (krok w górę, MFA_STEP_UP_MAX_AGE_SECONDS = 15 min) liczy się od zegara ściennego,
// a sesje macierzy są zakładane raz na początku wielominutowego przebiegu — na obciążonej maszynie
// starzałyby się w trakcie i fixture/przypadki dostawałyby fałszywe 403 mfa_stale. Przed każdym
// wywołaniem przesuwamy więc mfa_verified_at potwierdzonych sesji na „teraz” (zapis w górę jest
// dozwolony przez trigger sesji; nie zmieniamy okna MFA w kodzie). Odmowy dla NIEPOTWIERDZONEGO MFA
// (mfa_required) zostają bez zmian, a stara weryfikacja → 403 mfa_stale jest testowana osobno
// (tests/pg-account-recovery.test.js, tests/pg-admin.test.js).
async function refreshMfaFreshness(db) {
  await db.query('UPDATE sessions SET mfa_verified_at = now() WHERE mfa_verified_at IS NOT NULL AND revoked_at IS NULL');
}

// Wywołanie API kontem fixture; błąd = przerwanie testu (fixture musi się udać).
async function api(ctx, cookie, method, path, body, headers = {}) {
  await refreshMfaFreshness(ctx.db);
  const response = await handlePgRequest(request(path, { method, body, headers, cookie }), ctx.env);
  const text = await response.text();
  if (!isSuccess(response.status)) throw new Error(`fixture ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* treść nie-JSON */ }
  return { response, json, text };
}

async function makeEvent(db, target, stage, { audience = 'internal', title } = {}) {
  const publicStage = stage === 'approved' || stage === 'published';
  const { event } = await createDraft(db, fxAdmin, {
    schoolYearId: target.schoolYearId, classId: target.classId,
    // Wydarzenia, które mogą trafić do publicznego kalendarza, niosą tylko znacznik jawny.
    title: title ?? `Wydarzenie ${publicStage ? marker('PUBLIC') : marker(target.key)}`,
    startsAt: '2026-11-12T18:30', audience: publicStage ? 'public' : audience,
    idempotencyKey: nextKey('fx-event'),
  });
  if (stage === 'draft') return { eventId: event.id };
  await submit(db, fxAdmin, { eventId: event.id, revision: 1 });
  if (stage === 'submitted') return { eventId: event.id };
  await approve(db, fxBoard, { eventId: event.id, revision: 1 });
  if (stage === 'approved') return { eventId: event.id };
  await publish(db, fxBoard, { eventId: event.id, revision: 1 });
  return { eventId: event.id };
}

// Zadanie wolontariatu (#142, #330): dostęp sprawdza ten sam canEdit(actor, event)
// co szkic wydarzenia (EVENT_EDIT), więc fixture reużywa makeEvent w stanie 'draft'.
async function makeEventTask(db, target, stage) {
  const { eventId } = await makeEvent(db, target, 'draft');
  const { task } = await createTask(db, fxAdmin, {
    eventId, title: `Zadanie ${marker(target.key)}`, slotsNeeded: 3, isPublic: false,
    idempotencyKey: nextKey('fx-task'),
  });
  if (stage === 'cancelled') {
    await cancelTask(db, fxAdmin, { eventId, taskId: task.id, reason: 'Odwołanie syntetyczne (fixture)' });
  }
  return { eventId, taskId: task.id };
}

async function makeEventTaskSignup(db, target, stage) {
  const { eventId, taskId } = await makeEventTask(db, target, 'draft');
  const { signup } = await createSignup(db, fxAdmin, {
    eventId, taskId, userId: fxBoard.userId, idempotencyKey: nextKey('fx-signup'),
  });
  if (stage === 'withdrawn') {
    await withdrawSignup(db, fxAdmin, { eventId, taskId, signupId: signup.id });
  }
  return { eventId, taskId, signupId: signup.id };
}

async function makeMeeting(db, target, stage, { title, itemTitle, minutesBody, visibility = 'parents', resolutionNumber } = {}) {
  const scopeMarker = marker(target.key);
  const { meeting } = await createMeeting(db, fxAdmin, {
    idempotencyKey: nextKey('fx-meeting'), schoolYearId: target.schoolYearId,
    kind: target.classId ? 'class' : 'plenary', classId: target.classId,
    title: title ?? `Zebranie ${scopeMarker}`, scheduledAt: '2026-10-10T17:00:00Z',
    status: stage === 'draft' ? 'draft' : 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1,
    quorumRuleSource: 'Założenie testowe',
  });
  const obj = { meetingId: meeting.id };
  if (stage === 'draft') return obj;
  // #113: zebranie zaplanowane z punktem porządku, szkicem i zatwierdzonym zawiadomieniem
  // (autor fxAdmin, zatwierdza fxBoard — inna osoba, zasada czterech oczu).
  if (['agendaItem', 'draftNotice', 'approvedNotice'].includes(stage)) {
    const { agendaItem } = await addAgendaItem(db, fxAdmin, {
      idempotencyKey: nextKey('fx-item'), meetingId: meeting.id, title: itemTitle ?? `Punkt ${scopeMarker}`,
    });
    const withItem = { ...obj, agendaItemId: agendaItem.id };
    if (stage === 'agendaItem') return withItem;
    const { notice } = await createMeetingNotice(db, fxAdmin, { meetingId: meeting.id });
    if (stage === 'approvedNotice') await approveMeetingNotice(db, fxBoard, { meetingId: meeting.id, noticeId: notice.id });
    return { ...withItem, noticeId: notice.id };
  }
  await updateMeeting(db, fxAdmin, { meetingId: meeting.id, status: 'held' });
  if (stage === 'held') return obj;
  if (stage === 'draftResolution') {
    const { resolution } = await createResolution(db, fxAdmin, {
      idempotencyKey: nextKey('fx-res'), meetingId: meeting.id, title: `Uchwała ${scopeMarker}`, body: 'Treść syntetyczna',
    });
    return { ...obj, resolutionId: resolution.id };
  }
  // #93: przyjęta uchwała zebrania ogólnego (numer generowany) — kwota upoważnienia do wydatku.
  if (stage === 'adoptedResolution' && !resolutionNumber) resolutionNumber = nextKey('UCHW-FX');
  if (stage === 'finalResolution' || resolutionNumber) {
    await recordAttendance(db, fxAdmin, {
      meetingId: meeting.id, userId: fxBoard.userId, capacity: 'board_member', votingEligible: true, present: true,
    });
    const { quorumCheck } = await determineQuorum(db, fxAdmin, { idempotencyKey: nextKey('fx-quorum'), meetingId: meeting.id });
    const { resolution } = await createResolution(db, fxAdmin, {
      idempotencyKey: nextKey('fx-res'), meetingId: meeting.id, title: `Uchwała ${scopeMarker}`, body: 'Treść syntetyczna',
      status: resolutionNumber ? 'adopted' : 'rejected', number: resolutionNumber,
      votesFor: resolutionNumber ? 1 : 0, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    });
    if (stage === 'finalResolution' || stage === 'adoptedResolution') return { ...obj, resolutionId: resolution.id };
  }
  const { minutes } = await createMinutesVersion(db, fxAdmin, {
    idempotencyKey: nextKey('fx-minutes'), meetingId: meeting.id,
    body: minutesBody ?? `Protokół ${scopeMarker} — treść syntetyczna.`,
  });
  if (stage === 'draftMinutes') return { ...obj, minutesId: minutes.id };
  // #135: zatwierdzający musi być inną osobą niż autor wersji (fxAdmin powyżej).
  await approveMinutes(db, fxBoard, { minutesId: minutes.id });
  if (stage === 'approvedMinutes') return { ...obj, minutesId: minutes.id };
  await setMinutesVisibility(db, fxAdmin, { idempotencyKey: nextKey('fx-vis'), minutesId: minutes.id, visibility });
  return { ...obj, minutesId: minutes.id };
}

async function makePayment(db, target, stage) {
  const id = nextKey('fx-payment');
  const unmatched = stage === 'unmatched' || stage === 'allocated';
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
       reference, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, 100000, $8, 'bank', $4, $5, $6, $7)`,
    [id, unmatched ? null : 'hh-1', target.schoolYearId, `Wpłata ${marker(target.key)}`,
      unmatched ? 'unmatched' : 'recorded', fxAdmin.userId, `${id}-key`, yearDate(target, '10-01')],
  );
  if (stage === 'allocated') {
    // #127: wpłata nieprzypisana z jedną częścią dla hh-1 (payments.allocations.reversal).
    const allocationId = `${id}-alloc`;
    await db.query(
      `INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
       VALUES ($1, $2, $3, 'hh-1', 100, $4, $5)`,
      [allocationId, id, target.schoolYearId, fxAdmin.userId, `${allocationId}-key`],
    );
    return { paymentId: id, allocationId };
  }
  return { paymentId: id };
}

// #83: komunikacja strukturalna na świeżym gospodarstwie; 'revoked' dopisuje
// od razu zdarzenie unieważnienia (dla przypadków, którym wystarczy historia).
async function makePaymentReference(db, target, stage) {
  const householdId = nextKey('fx-hh-ref');
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const id = nextKey('fx-ref');
  await db.query(
    `INSERT INTO payment_references (id, school_year_id, household_id, structured_reference, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, target.schoolYearId, householdId, generateStructuredReference(), fxAdmin.userId, `${id}-key`],
  );
  if (stage === 'revoked') {
    await db.query(
      `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
       VALUES ($1, $2, 'Zamknięcie testowe (macierz)', $3, $4)`,
      [nextKey('fx-ref-rev'), id, fxAdmin.userId, `${id}-rev-key`],
    );
  }
  return { paymentReferenceId: id, householdId };
}

async function makeNewsPost(db, target, stage) {
  const published = stage === 'published';
  const { post } = await createNewsDraft(db, fxAdmin, {
    schoolYearId: target.schoolYearId, classId: target.classId,
    title: `Wpis ${published ? marker('PUBLIC') : marker(target.key)}`, body: 'Treść syntetyczna.',
    idempotencyKey: nextKey('fx-news'),
  });
  if (stage === 'draft') return { postId: post.id };
  await submitNews(db, fxAdmin, { postId: post.id, revision: 1 });
  if (stage === 'submitted') return { postId: post.id };
  await approveNews(db, fxBoard, { postId: post.id, revision: 1 });
  if (stage === 'approved') return { postId: post.id };
  await publishNews(db, fxBoard, { postId: post.id, revision: 1 });
  return { postId: post.id };
}

// Zdjęcie z plikiem (#96), zweryfikowane i opublikowane — jedyna droga, którą
// trasa publiczna GET /api/public/news-photos/:id/{web|thumb} zwraca 200
// (macierz sprawdza tu tylko, że wynik jest identyczny dla każdego, nie cały
// cykl życia pliku — patrz tests/pg-news.test.js).
async function makePublicPhotoFile(ctx, target) {
  const key = nextKey('fx-photofile');
  const { photo } = await registerPhoto(ctx.db, fxAdmin, { ...photoBody(key), idempotencyKey: key });
  await uploadPhotoFile(ctx.db, ctx.env.storage, fxAdmin, {
    photoId: photo.id, bytes: pngBytes(), contentType: 'image/png', idempotencyKey: `${key}-file`,
  });
  await verifyPhoto(ctx.db, fxBoard, { photoId: photo.id });
  const { post } = await createNewsDraft(ctx.db, fxAdmin, {
    schoolYearId: target.schoolYearId, title: `Fotorelacja ${marker('PUBLIC')}`, body: 'Treść syntetyczna.',
    photoIds: [photo.id], idempotencyKey: nextKey('fx-news-photo'),
  });
  await submitNews(ctx.db, fxAdmin, { postId: post.id, revision: 1 });
  await approveNews(ctx.db, fxBoard, { postId: post.id, revision: 1 });
  await publishNews(ctx.db, fxBoard, { postId: post.id, revision: 1 });
  return { photoId: photo.id };
}

// #145 (D-06): draft utworzony przez board2 (poza aktorami macierzy),
// zatwierdzony przez fxAdmin — inna osoba niż autor (cztery oczy), co nadal
// pozwala aktorom admin/board macierzy wywoływać kolejny krok bez konfliktu
// z ich własnym tożsamością.
async function makePrivacyNotice(ctx, _target, stage) {
  const created = await api(ctx, ctx.fxCookies.board2, 'POST', '/api/admin/privacy-notices',
    { bodyText: `Informacja testowa (macierz uprawnień, ${nextKey('fx-notice')}).`, decisionRef: 'D-06/fx-macierz' });
  const noticeId = created.json.notice.id;
  if (stage === 'draft') return { noticeId };
  await api(ctx, ctx.fxCookies.admin, 'POST', `/api/admin/privacy-notices/${noticeId}/approve`, {});
  if (stage === 'approved') return { noticeId };
  await api(ctx, ctx.fxCookies.admin, 'POST', `/api/admin/privacy-notices/${noticeId}/publish`, {});
  return { noticeId };
}

async function makeCampaign(ctx, target, stage) {
  const { json } = await api(ctx, ctx.fxCookies.board, 'POST', '/api/email/campaigns', campaignBody(target), withKey(nextKey('fx-campaign')));
  const campaignId = json.campaign.id;
  if (stage === 'draft') return { campaignId };
  const snapshot = await api(ctx, ctx.fxCookies.board, 'POST', `/api/email/campaigns/${campaignId}/snapshot`, {});
  const obj = { campaignId, contentHash: json.campaign.contentHash, recipientsHash: snapshot.json.recipientsHash };
  if (stage === 'snapshot') return obj;
  // Zatwierdza inna osoba niż autor migawki (zasada czterech oczu).
  await api(ctx, ctx.fxCookies.board2, 'POST', `/api/email/campaigns/${campaignId}/approve`,
    { contentHash: obj.contentHash, recipientsHash: obj.recipientsHash });
  if (stage === 'approved') return obj;
  // #130: harmonogram — sending/paused budowane na zakolejkowanej kampanii.
  await api(ctx, ctx.fxCookies.board, 'POST', `/api/email/campaigns/${campaignId}/queue`, {});
  if (stage === 'sending') return obj;
  if (stage === 'paused') {
    await api(ctx, ctx.fxCookies.board, 'POST', `/api/email/campaigns/${campaignId}/pause`, {});
    return obj;
  }
  if (stage === 'failed') {
    // #139: wiersz w stanie końcowym 'failed' do testu trasy resolutions (queued -> failed
    // jest dozwolonym przejściem bez przechodzenia przez worker/'sending').
    const { rows: [outboxRow] } = await ctx.db.query(
      "UPDATE email_outbox SET state = 'failed', last_error = 'delivery_unknown' WHERE campaign_id = $1 RETURNING id",
      [campaignId],
    );
    return { ...obj, outboxId: outboxRow.id };
  }
  return obj;
}

// Blokada aktywna (#94), do zdjęcia w macierzy uprawnień. Adres syntetyczny
// świeży za każdym razem (webhook to jedyna droga zapisu — bez surowego INSERT).
async function makeSuppression(ctx, _target, stage) {
  const email = `${nextKey('fx-suppr')}@example.invalid`;
  const emailHashValue = suppressionEmailHash(email);
  await api(ctx, undefined, 'POST', '/api/email/webhooks/brevo',
    { event: 'hard_bounce', email, id: nextKey('fx-suppr-evt'), ts_event: 1791187200 },
    { Authorization: `Bearer ${ctx.fx.webhookSecret}` });
  if (stage === 'active') return { emailHash: emailHashValue };
  // Wniosek zgłoszony przez inną osobę niż każdy z testowanych aktorów
  // (fxCookies.board = konto stałe 'u-fx-board', nigdy nie testowane w macierzy),
  // żeby zatwierdzenie (release) dawało sukces niezależnie od tego, kto go zatwierdza.
  const { json } = await api(ctx, ctx.fxCookies.board, 'POST', `/api/email/suppressions/${emailHashValue}/release-request`,
    { schoolYearId: YEAR_1, releaseReason: 'address_corrected' });
  return { emailHash: emailHashValue, requestId: json.requestId };
}

// Aktywna pauza konta dostawcy (#209). W produkcji zapisuje ją wyłącznie worker
// po odmowie 401/402/403; tu — wprost w bazie. Najwyżej jedna aktywna, więc
// fixture zwraca istniejącą, jeśli jeszcze nie została zdjęta.
async function makeProviderPause(ctx) {
  const { rows } = await ctx.db.query('SELECT id FROM email_provider_pauses WHERE lifted_at IS NULL');
  if (rows[0]) return { pauseId: rows[0].id };
  const pauseId = nextKey('fx-provider-pause');
  await ctx.db.query(
    "INSERT INTO email_provider_pauses (id, reason, error_code) VALUES ($1, 'account_rejected', 'provider_rejected_401')",
    [pauseId],
  );
  return { pauseId };
}

async function makeReconciliation(ctx, target, stage) {
  const cookie = ctx.fxCookies.treasurer;
  const { json } = await api(ctx, cookie, 'POST', '/api/reconciliations', {
    schoolYearId: target.schoolYearId, statementDate: statementDate(target), statementBalanceCents: 100000,
    notes: `Uzgodnienie ${marker(target.key)}`,
  }, withKey(nextKey('fx-rec')));
  const reconciliationId = json.reconciliation.id;
  if (stage === 'draft') return { reconciliationId };
  if (stage === 'groupReady' || stage === 'groupMatched') {
    // #127 cz. 2: przelew zbiorczy — jedna pozycja 2000 EUR ↔ dwie wpłaty po 1000 EUR.
    const first = await makePayment(ctx.db, target, 'recorded');
    const second = await makePayment(ctx.db, target, 'recorded');
    await api(ctx, cookie, 'POST', `/api/reconciliations/${reconciliationId}/lines`, {
      lines: [{ bookedOn: yearDate(target, '10-01'), amountCents: 200000, reference: 'Przelew zbiorczy syntetyczny' }],
    }, withKey(nextKey('fx-lines')));
    const detail = await api(ctx, cookie, 'GET', `/api/reconciliations/${reconciliationId}`);
    const obj = { reconciliationId, statementLineId: detail.json.lines[0].id, paymentIds: [first.paymentId, second.paymentId] };
    if (stage === 'groupReady') return obj;
    const group = await api(ctx, cookie, 'POST', `/api/reconciliations/${reconciliationId}/group-matches`, {
      statementLineId: obj.statementLineId, items: obj.paymentIds.map((paymentEntryId) => ({ paymentEntryId })),
    }, withKey(nextKey('fx-group')));
    return { ...obj, groupMatchId: group.json.groupMatch.id };
  }
  const { paymentId } = await makePayment(ctx.db, target, 'recorded');
  await api(ctx, cookie, 'POST', `/api/reconciliations/${reconciliationId}/lines`, {
    lines: [{ bookedOn: yearDate(target, '10-01'), amountCents: 100000, reference: 'Tytuł syntetyczny' }],
  }, withKey(nextKey('fx-lines')));
  const detail = await api(ctx, cookie, 'GET', `/api/reconciliations/${reconciliationId}`);
  const obj = { reconciliationId, statementLineId: detail.json.lines[0].id, paymentEntryId: paymentId };
  if (stage === 'withLine') return obj;
  const match = await api(ctx, cookie, 'POST', `/api/reconciliations/${reconciliationId}/matches`,
    { statementLineId: obj.statementLineId, paymentEntryId: paymentId }, withKey(nextKey('fx-match')));
  return { ...obj, matchId: match.json.match.id };
}

async function makeAdminTarget(ctx, stage) {
  const userId = nextKey('fx-konto');
  if (stage === 'active') {
    await seedUserSession(ctx.db, { userId });
    return { userId };
  }
  if (stage === 'disabled') {
    await seedUser(ctx.db, { userId, disabled: true });
    return { userId };
  }
  if (stage === 'grant') {
    await seedUser(ctx.db, { userId });
    const grantId = randomUUID();
    await ctx.db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ($1, $2, 'board', $3)", [grantId, userId, YEAR_1]);
    return { grantId };
  }
  if (stage === 'finishedYear') {
    // Zakończony rok syntetyczny z jednym przydziałem — nigdy rok 1 aktorów macierzy.
    const schoolYearId = nextKey('y-stary');
    await seedSchoolYear(ctx.db, schoolYearId, { startsOn: '2019-09-01', endsOn: '2020-08-31' });
    await seedUser(ctx.db, { userId });
    await ctx.db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ($1, $2, 'board', $3)", [randomUUID(), userId, schoolYearId]);
    return { schoolYearId };
  }
  if (stage === 'withFactor') {
    // Konto z potwierdzonym czynnikiem MFA (reset MFA przez administratora).
    const cookie = await seedUserSession(ctx.db, { userId });
    await makeMfaFactor(ctx, 'confirmed', { cookie });
    return { userId };
  }
  if (stage === 'recoveryRequest') {
    // #146: otwarty wniosek o reset hasła konta zarządu, złożony przez INNE konto niż aktor macierzy.
    await seedUser(ctx.db, { userId });
    const requesterId = nextKey('fx-wnioskodawca');
    await seedUser(ctx.db, { userId: requesterId });
    await ctx.db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ($1, $2, 'board', $3)", [randomUUID(), userId, YEAR_1]);
    const requestId = randomUUID();
    await ctx.db.query(
      `INSERT INTO account_recovery_requests (id, kind, target_user_id, requested_by, ttl_seconds, expires_at)
       VALUES ($1, 'password_reset', $2, $3, 7200, now() + interval '1 day')`,
      [requestId, userId, requesterId],
    );
    return { requestId };
  }
  if (stage === 'invitation') {
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/admin/invitations',
      { email: `${userId}@example.invalid`, role: 'board', schoolYearId: YEAR_1 });
    return { invitationId: json.invitation.id };
  }
  if (stage === 'emptySchoolYear') {
    // Rok bez klas (#78) — cel dla tworzenia klas; nigdy rok 1 aktorów macierzy.
    const schoolYearId = nextKey('y-pusty');
    await seedSchoolYear(ctx.db, schoolYearId, { startsOn: '2029-09-01', endsOn: '2030-08-31' });
    return { schoolYearId };
  }
  if (stage === 'promotionYears') {
    // Dwa syntetyczne lata z jedną klasą każdy (#78) — nigdy lata aktorów macierzy.
    const fromSchoolYearId = nextKey('y-zrodlo');
    const toSchoolYearId = nextKey('y-cel');
    const fromClassId = nextKey('c-zrodlo');
    const toClassId = nextKey('c-cel');
    await seedSchoolYear(ctx.db, fromSchoolYearId, { startsOn: '2031-09-01', endsOn: '2032-08-31' });
    await seedSchoolYear(ctx.db, toSchoolYearId, { startsOn: '2032-09-01', endsOn: '2033-08-31' });
    await ctx.db.query('INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
      [fromClassId, fromSchoolYearId, `Z-${fromClassId}`, toClassId, toSchoolYearId, `C-${toClassId}`]);
    const householdId = nextKey('hh-promocja');
    const studentId = nextKey('s-promocja');
    const enrollmentId = nextKey('e-promocja');
    await ctx.db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
    await ctx.db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Test', 'Promocja')", [studentId, householdId]);
    await ctx.db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [enrollmentId, studentId, fromClassId, fromSchoolYearId]);
    return { fromSchoolYearId, toSchoolYearId, fromClassId, toClassId, studentId, enrollmentId };
  }
  if (stage === 'dataRequest') {
    // Rejestr żądań osób (#100) — cel dla przejścia stanu; gospodarstwo ogólnoszkolne (hh-1).
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/admin/data-requests',
      { kind: 'access', householdId: 'hh-1', receivedOn: '2026-10-01' });
    return { requestId: json.request.id };
  }
  throw new Error(`unknown admin fixture ${stage}`);
}

// Czynnik MFA należący do świeżego użytkownika przypadku (caseInfo.cookie).
async function makeMfaFactor(ctx, stage, { cookie, route }) {
  const enrolled = await api(ctx, cookie, 'POST', '/api/mfa/enroll', {});
  const code = (offsetSteps) => totp(base32Decode(enrolled.json.secret), Date.now() + offsetSteps * 30_000);
  if (stage === 'enrolled') return { code: code(0) };
  const confirm = await api(ctx, cookie, 'POST', '/api/mfa/confirm', { code: code(0) });
  const rotated = confirm.response.headers.get('Set-Cookie').split(';', 1)[0];
  // Weryfikacja: kolejny krok TOTP (poprzedni został zużyty przy potwierdzeniu).
  return { cookie: rotated, code: route === 'mfa.recovery' ? confirm.json.recoveryCodes[0] : code(1) };
}

// ---------- trasy logowania (#3) ----------

async function setPassword(db, userId, password) {
  await db.query(
    `INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ($1, $2, 'invitation')
     ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash`,
    [userId, await hashPassword(password, { env: FAST_SCRYPT })],
  );
}

// Konto z hasłem (bez przydziałów) do logowania; wspólne dla wszystkich przypadków.
async function makeLoginAccount(ctx) {
  const userId = nextKey('fx-login');
  await seedUser(ctx.db, { userId });
  const password = syntheticPassword();
  await setPassword(ctx.db, userId, password);
  return { email: `${userId}@example.invalid`, password };
}

// Świeże zaproszenie (token zwracany raz przez administratora) dla nowego adresu.
async function makeInvitationToken(ctx) {
  const email = `${nextKey('fx-zapr').toLowerCase()}@example.invalid`;
  const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/admin/invitations', { email, role: 'board', schoolYearId: YEAR_1 });
  return { token: json.token, password: syntheticPassword() };
}

// Świeży token resetu hasła wydany przez administratora dla nowego konta.
async function makePasswordResetToken(ctx) {
  const userId = nextKey('fx-reset');
  await seedUser(ctx.db, { userId });
  const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', `/api/admin/users/${userId}/password-reset`, {});
  return { token: json.token, newPassword: syntheticPassword() };
}

// Hasło świeżego użytkownika przypadku (caseInfo.cookie) — zmiana własnego hasła.
async function makeOwnPassword(ctx, { cookie }) {
  const tokenHash = await hashSecret(cookie.slice(cookie.indexOf('=') + 1));
  const { rows } = await ctx.db.query('SELECT user_id FROM sessions WHERE token_hash = $1', [tokenHash]);
  if (!rows[0]) throw new Error('fixture ownPassword: brak sesji przypadku');
  const password = syntheticPassword();
  await setPassword(ctx.db, rows[0].user_id, password);
  return { password, newPassword: syntheticPassword() };
}

// Gospodarstwo bez zapisu (enrollment)/klasy — w odróżnieniu od `household`
// (niżej, przez makeHousehold) nie woła fallbackClassId. #83: trasa
// payment-references.create nie zależy od klasy, a każdy target YEAR_TARGETS
// obejmuje też cel bez classId (W1) — makeHousehold wstawiłby wtedy trwałą
// "klasę fixture" do bazy współdzielonej z resztą macierzy, zafałszowując
// listę klas w innych podtestach (families.classes).
async function makePlainHousehold(db) {
  const householdId = nextKey('fx-hh-plain');
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  return { householdId };
}

// #150: druga, jednorazowa sesja TEGO SAMEGO konta (nie ta z caseInfo.cookie, którą
// dalej wysyła żądanie testowe) — do sprawdzenia, że własną (ale INNĄ) sesję da się
// cofnąć. Bieżąca sesja przypadku zostaje nietknięta.
async function makeOwnSession(ctx, { cookie }) {
  const tokenHash = await hashSecret(cookie.slice(cookie.indexOf('=') + 1));
  const { rows } = await ctx.db.query('SELECT user_id FROM sessions WHERE token_hash = $1', [tokenHash]);
  if (!rows[0]) throw new Error('fixture ownSession: brak sesji przypadku');
  try {
    const extra = await createSession(ctx.db, { userId: rows[0].user_id });
    return { sessionId: extra.sessionId };
  } catch {
    // Aktorzy odmowy dzielący ten fixture (konto wyłączone/sesja wygasła/cofnięta,
    // patrz objectFor: obiekt odmowy jest wspólny dla całej trasy) mają user_id
    // wskazujące na konto, dla którego createSession odmawia (`user_unavailable`).
    // Żądanie i tak dostanie 401 zanim identyfikator zostanie użyty do czegokolwiek.
    return { sessionId: 'fx-own-session-unavailable' };
  }
}


const MAKERS = {
  privacyNotice: (ctx, target, stage) => makePrivacyNotice(ctx, target, stage),
  event: (ctx, target, stage) => makeEvent(ctx.db, target, stage),
  eventTask: (ctx, target, stage) => makeEventTask(ctx.db, target, stage),
  eventTaskSignup: (ctx, target, stage) => makeEventTaskSignup(ctx.db, target, stage),
  meeting: (ctx, target, stage) => makeMeeting(ctx.db, target, stage),
  payment: (ctx, target, stage) => makePayment(ctx.db, target, stage),
  paymentReference: (ctx, target, stage) => makePaymentReference(ctx.db, target, stage),
  plainHousehold: (ctx) => makePlainHousehold(ctx.db),
  newsPost: (ctx, target, stage) => makeNewsPost(ctx.db, target, stage),
  publicPhotoFile: (ctx, target) => makePublicPhotoFile(ctx, target),
  photo: async (ctx) => {
    const key = nextKey('fx-photo');
    const { photo } = await registerPhoto(ctx.db, fxAdmin, { ...photoBody(key), idempotencyKey: key });
    return { photoId: photo.id };
  },
  // Zgoda do wycofania (#106): zdjęcie bez zidentyfikowanych osób nie wymaga
  // zgody, ale trasa wycofania działa na dowolnym odwołaniu do dokumentu zgody.
  consent: async (ctx) => {
    const key = nextKey('fx-consent');
    const { photo } = await registerPhoto(ctx.db, fxAdmin, { ...photoBody(key), idempotencyKey: key });
    const consentDocumentRef = `zgoda-${safeKey(key)}`.slice(0, 120);
    await addConsent(ctx.db, fxAdmin, { photoId: photo.id, subjectNo: 1, subjectKind: 'adult', consentDocumentRef });
    return { consentDocumentRef };
  },
  document: async (ctx, target, kind) => {
    const classPart = kind === 'class' ? `&classId=${target.classId}` : '';
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', `/api/documents?kind=${kind}&schoolYearId=${target.schoolYearId}${classPart}`,
      pdfBytes(target.key), { 'Content-Type': 'application/pdf', 'Idempotency-Key': nextKey('fx-doc') });
    return { documentId: json.document.id };
  },
  // Para dokumentów tego samego rodzaju/roku/klasy — cel zastąpienia (issue #82).
  documentPair: async (ctx, target, kind) => {
    const original = await MAKERS.document(ctx, target, kind);
    const replacement = await MAKERS.document(ctx, target, kind);
    return { documentId: original.documentId, replacementDocumentId: replacement.documentId };
  },
  ledgerEntry: async (ctx, target) => {
    const { json } = await api(ctx, ctx.fxCookies.treasurer, 'POST', '/api/ledger', {
      schoolYearId: target.schoolYearId, direction: 'income', amountCents: 100000, categoryId: ledgerCategory(target),
      description: `Wpis ${marker(target.key)}`, occurredOn: yearDate(target, '10-01'), method: 'bank',
    }, withKey(nextKey('fx-ledger')));
    return { ledgerEntryId: json.entry.id };
  },
  // #125: przygotowanie do utworzenia migawki — zmiana księgi (nowa treść) i bieżąca migawka roku.
  reportSnapshotPrep: async (ctx, target) => {
    await MAKERS.ledgerEntry(ctx, target);
    const { rows } = await ctx.db.query(
      `SELECT id FROM financial_report_snapshot_status WHERE school_year_id = $1 AND superseded_by_id IS NULL`,
      [target.schoolYearId],
    );
    return { supersedesId: rows[0]?.id ?? null };
  },
  // #125: migawka zapisana przez konto pomocnicze (autor inny niż każdy aktor macierzy).
  reportSnapshot: async (ctx, target) => {
    const { supersedesId } = await MAKERS.reportSnapshotPrep(ctx, target);
    const { json } = await api(ctx, ctx.fxCookies.treasurer, 'POST', '/api/reports/annual/snapshots', {
      schoolYearId: target.schoolYearId, ...(supersedesId ? { supersedesId, reason: 'Korekta syntetyczna' } : {}),
    });
    return { snapshotId: json.snapshot.id };
  },
  // #97: wydatek zapisany przez konto pomocnicze (autor inny niż każdy aktor macierzy).
  ledgerExpense: async (ctx, target) => {
    const { json } = await api(ctx, ctx.fxCookies.treasurer, 'POST', '/api/ledger', {
      schoolYearId: target.schoolYearId, direction: 'expense', amountCents: 1000, categoryId: `cat-out-${target.schoolYearId}`,
      description: `Wydatek ${marker(target.key)}`, occurredOn: yearDate(target, '10-02'), method: 'bank',
    }, withKey(nextKey('fx-ledger-exp')));
    return { ledgerEntryId: json.entry.id };
  },
  // Świeża, aktywna kategoria wydatków wprost w bazie — współdzielona przez
  // ledger.categoryDeactivate (#207, nie może być `cat-in-<year>`, bo tamta
  // jest używana przez inne trasy), ledgerBudget.deactivateCategory /
  // ledgerBudget.createLine (#107, bez linii preliminarza).
  ledgerCategory: async (ctx, target) => {
    const categoryId = nextKey('fx-cat');
    await ctx.db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ($1, $2, 'expense', $3, 'u-fx-admin')`,
      [categoryId, target.schoolYearId, `Kategoria ${marker(target.key)} ${categoryId}`],
    );
    return { categoryId };
  },
  // #107: kategoria z pierwszą wersją linii preliminarza.
  budgetLine: async (ctx, target) => {
    const categoryId = nextKey('fx-cat-line');
    const lineId = nextKey('fx-line');
    await ctx.db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ($1, $2, 'expense', $3, 'u-fx-admin')`,
      [categoryId, target.schoolYearId, `Plan ${marker(target.key)} ${categoryId}`],
    );
    await ctx.db.query(
      `INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, created_by, idempotency_key)
       VALUES ($1, $2, $3, 10000, 'u-fx-admin', $4)`,
      [lineId, target.schoolYearId, categoryId, nextKey('fx-line-key')],
    );
    return { lineId, categoryId };
  },
  // Bilans otwarcia roku celu wprost w bazie (#199); trasa poprawki wymaga jego istnienia.
  openingBalance: async (ctx, target) => {
    await ctx.db.query(
      `INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, note, created_by, idempotency_key)
       VALUES ($1, $2, 10000, 2000, 'Bilans syntetyczny', 'u-fx-admin', $3) ON CONFLICT (school_year_id) DO NOTHING`,
      [nextKey('fx-ob'), target.schoolYearId, nextKey('fx-ob-key')],
    );
    return {};
  },
  campaign: makeCampaign,
  suppression: makeSuppression,
  providerPause: makeProviderPause,
  reconciliation: makeReconciliation,
  household: (ctx, target) => makeHousehold(ctx.db, target),
  sharedGuardianHousehold: (ctx, target) => makeSharedGuardianHousehold(ctx.db, target),
  // #86: gospodarstwo fixture + drugie, puste — do dodania członkostwa ucznia.
  householdSpare: async (ctx, target) => {
    const made = await makeHousehold(ctx.db, target);
    const spareHouseholdId = `${made.householdId}-spare`;
    await ctx.db.query('INSERT INTO households (id) VALUES ($1)', [spareHouseholdId]);
    return { ...made, spareHouseholdId };
  },
  // #140: trasy nie są przypisane do konkretnej klasy (target W1 ma
  // classId=null — dane ogólnoszkolne) — gospodarstwo fixture zawsze
  // pod TARGETS.A, niezależnie od przekazanego targetu.
  guardianOnly: (ctx) => makeHousehold(ctx.db, TARGETS.A, nextKey('fx-guh')),
  // Gospodarstwo świeże + jednorazowy link (token w treści odpowiedzi tylko
  // przy wydaniu — do testu podglądu/formularza publicznego).
  guardianUpdateLink: async (ctx) => {
    const { guardianId } = await makeHousehold(ctx.db, TARGETS.A, nextKey('fx-guh'));
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/admin/guardian-links', { guardianId });
    return { token: json.token, linkId: json.linkId, guardianId };
  },
  // Wniosek `pending` świeży na przypadek — do zatwierdzenia/odrzucenia.
  guardianUpdateRequest: async (ctx) => {
    const { guardianId } = await makeHousehold(ctx.db, TARGETS.A, nextKey('fx-gur'));
    const { json: link } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/admin/guardian-links', { guardianId });
    const { json: submitted } = await api(ctx, null, 'POST', '/api/public/guardian-update',
      { token: link.token, contactAllowed: true });
    return { requestId: submitted.requestId, guardianId };
  },
  adminTarget: (ctx, _target, stage) => makeAdminTarget(ctx, stage),
  importPlan: async (ctx, target) => {
    const payload = importPayload(target, nextKey('fximp'));
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', '/api/import/preview', payload);
    return { payload, fingerprint: json.fingerprint, planDigest: json.planDigest };
  },
  mfaFactor: (ctx, _target, stage, caseInfo) => makeMfaFactor(ctx, stage, caseInfo),
  loginAccount: (ctx) => makeLoginAccount(ctx),
  invitationToken: (ctx) => makeInvitationToken(ctx),
  passwordResetToken: (ctx) => makePasswordResetToken(ctx),
  ownPassword: (ctx, _target, _stage, caseInfo) => makeOwnPassword(ctx, caseInfo),
  ownSession: (ctx, _target, _stage, caseInfo) => makeOwnSession(ctx, caseInfo),
  // Kolejna niepotwierdzona pozycja listy kontrolnej (rok 1); odmowy używają dowolnej pozycji.
  checklistItem: async (ctx, target, _stage, { success }) => ({
    item: (target.key === 'W1' && success ? ctx.checklistOpen.shift() : null) ?? CHECKLIST_PREFILLED[0],
  }),
};

function makeObject(ctx, { kind, stage }, target, caseInfo = {}) {
  const maker = MAKERS[kind];
  if (!maker) throw new Error(`unknown fixture kind ${kind}`);
  return maker(ctx, target, stage, caseInfo);
}

// Obiekt współdzielony (kind, stage, zakres) — tworzony raz na bazę.
async function staticObject(ctx, kind, stage, targetKey) {
  const cacheKey = `static:${kind}:${stage}:${targetKey}`;
  if (!ctx.cache.has(cacheKey)) ctx.cache.set(cacheKey, makeObject(ctx, { kind, stage }, TARGETS[targetKey]));
  return ctx.cache.get(cacheKey);
}

async function seedStatic(ctx) {
  const fx = { resolutionNumber: { W1: 'UCHW/1/R1', Y2: 'UCHW/1/R2' }, webhookSecret: WEBHOOK_SECRET, unsubscribeSecret: UNSUBSCRIBE_SECRET };
  for (const key of ['A', 'B', 'W1', 'Y2']) {
    await staticObject(ctx, 'event', 'draft', key);
    ctx.cache.set(`static:meeting:shared:${key}`,
      makeMeeting(ctx.db, TARGETS[key], 'shared', { resolutionNumber: fx.resolutionNumber[key] }));
    await ctx.cache.get(`static:meeting:shared:${key}`);
  }
  for (const key of ['W1', 'Y2']) await staticObject(ctx, 'payment', 'recorded', key);
  // Jawne dane: opublikowane wydarzenie i protokół publiczny bez znaczników klas.
  await makeEvent(ctx.db, TARGETS.W1, 'published', { title: `Wydarzenie ${marker('PUBLIC')}` });
  await makeMeeting(ctx.db, TARGETS.W1, 'shared', {
    title: `Zebranie jawne ${marker('PUBLIC')}`, minutesBody: `Protokół ${marker('PUBLIC')} — treść jawna.`, visibility: 'public',
  });
  // #113: jawne zawiadomienie zebrania ogólnego (bez znaczników klas) oraz zatwierdzone zawiadomienie
  // zebrania klasowego A, które nie może pojawić się na stronie publicznej.
  await makeMeeting(ctx.db, TARGETS.W1, 'approvedNotice', {
    title: `Zebranie jawne ${marker('PUBLIC')}`, itemTitle: `Punkt jawny ${marker('PUBLIC')}`,
  });
  await makeMeeting(ctx.db, TARGETS.A, 'approvedNotice');
  // Kampania istniejąca w bazie (#110): email_preferences_events.campaign_id
  // ma FK do email_campaigns, więc token wypisania w macierzy musi wskazywać
  // na prawdziwy wiersz, nie dowolny ciąg znaków.
  fx.preferencesCampaignId = (await makeCampaign(ctx, TARGETS.W1, 'draft')).campaignId;
  return fx;
}

async function seedSessions(db) {
  const sessions = {};
  for (const actor of ACTORS) {
    if (actor.anonymous) continue;
    sessions[actor.key] = {};
    for (const mfa of [false, true]) {
      sessions[actor.key][mfa] = await seedUserSession(db, sessionOptions(actor, mfa, !mfa));
    }
  }
  return sessions;
}

function sessionOptions(actor, mfa, withGrants, userId = `mx-${actor.key}`) {
  return {
    userId,
    roles: withGrants ? actor.grants : [],
    mfa,
    disabled: Boolean(actor.disabled),
    expiresAt: actor.sessionExpired ? PAST : undefined,
    revoked: Boolean(actor.sessionRevoked),
  };
}

const WRITE_TABLES = [
  'audit_events', 'events', 'event_revisions', 'meetings', 'meeting_agenda_items', 'meeting_attendees',
  'meeting_quorum_checks', 'meeting_minutes', 'meeting_minutes_publications', 'resolutions',
  'meeting_request_keys', 'payment_entries', 'payment_corrections', 'payment_assignments',
  'payment_allocations', 'payment_allocation_reversals', 'role_grants',
  'users', 'sessions', 'invitations', 'user_mfa_factors', 'mfa_recovery_codes',
  'import_batches', 'households', 'guardians', 'students', 'enrollments', 'student_guardians',
  'guardian_contact_changes', 'student_guardian_changes', 'enrollment_history', 'documents',
  'ledger_entries', 'ledger_corrections', 'ledger_opening_balances',
  'ledger_opening_balance_adjustments', 'ledger_transfers',
  'email_campaigns', 'email_campaign_recipients', 'email_campaign_exclusions', 'email_outbox',
  'email_webhook_events', 'email_suppressions', 'email_suppression_release_requests', 'email_suppression_releases',
  'email_preferences_events', 'email_preview_sends', 'email_provider_pauses',
  'news_posts', 'news_post_revisions', 'news_photos', 'news_photo_consents',
  'bank_reconciliations', 'bank_statement_imports', 'bank_statement_lines', 'bank_reconciliation_matches',
  'bank_reconciliation_group_matches', 'bank_reconciliation_group_match_items',
  'bank_reconciliation_group_match_revocations',
  'export_runs', 'school_year_closures', 'school_year_closure_checklist',
  'financial_report_snapshots', 'financial_report_snapshot_approvals',
  'user_passwords', 'password_reset_tokens', 'login_rate_limits',
];

async function writeFingerprint(db) {
  const { rows } = await db.query(
    `SELECT ${WRITE_TABLES.map((table) => `(SELECT count(*) FROM ${table})::int AS ${table}`).join(', ')}`,
  );
  return rows[0];
}

// Jedna baza PGlite na grupę tras. Grupa `yearClose` ma własną bazę, bo zamknięcie roku 1
// wygasza przydziały roku 1 i zamraża jego księgę.
const contexts = new Map();
async function matrixContext(group = 'main') {
  if (!contexts.has(group)) {
    contexts.set(group, (async () => {
      const db = await createTestDb();
      const env = {
        db, APP_ENV: 'test', storage: createMemoryStorage(), MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET, EMAIL_UNSUBSCRIBE_SECRET: UNSUBSCRIBE_SECRET, ...FAST_SCRYPT,
        // Wysyłka testowa (#104): bramka bez sieci wyłączona, transport wstrzyknięty
        // (nigdy nie łączy się z siecią), adres z listy technicznej Rady.
        EMAIL_SENDING_ENABLED: 'true', EMAIL_PREVIEW_RECIPIENTS: 'fx-preview@rada.example.invalid',
        emailTransport: { send: async () => ({ messageId: 'fx-preview-message' }) },
      };
      await seedBase(db);
      const ctx = { db, env, cache: new Map(), fxCookies: await seedFixtureSessions(db), checklistOpen: [...CHECKLIST_OPEN] };
      ctx.fx = group === 'main' ? await seedStatic(ctx) : { webhookSecret: WEBHOOK_SECRET, unsubscribeSecret: UNSUBSCRIBE_SECRET };
      if (group === 'yearClose') {
        // Zamknięcie roku 1 rozpoczęte przez inną osobę; dwie pozycje listy kontrolnej zostają dla macierzy.
        await api(ctx, ctx.fxCookies.board, 'POST', `/api/year-close/${YEAR_1}/start`, { nextSchoolYearId: YEAR_2 });
        for (const item of CHECKLIST_PREFILLED) {
          await api(ctx, ctx.fxCookies.treasurer, 'POST', `/api/year-close/${YEAR_1}/checklist/${item}`, { note: 'Potwierdzenie syntetyczne' });
        }
      }
      ctx.sessions = await seedSessions(db);
      return ctx;
    })());
  }
  return contexts.get(group);
}

async function objectFor(ctx, route, targetKey, expected, caseInfo) {
  if (!route.object) return null;
  const target = TARGETS[targetKey];
  // Obiekt zależny od sesji przypadku (MFA) powstaje tylko, gdy żądanie ma się udać.
  if (route.freshUser) return isSuccess(expected) ? makeObject(ctx, route.object, target, caseInfo) : null;
  if (route.fixture === 'fresh' && isSuccess(expected)) return makeObject(ctx, route.object, target, caseInfo);
  if (route.fixture === 'static') return staticObject(ctx, route.object.kind, route.object.stage, targetKey);
  // Odmowa: obiekt wspólny dla (trasa, zakres) — odmowa nie może go zmienić.
  const cacheKey = `${route.id}:${targetKey}`;
  if (!ctx.cache.has(cacheKey)) ctx.cache.set(cacheKey, makeObject(ctx, route.object, target, caseInfo));
  return ctx.cache.get(cacheKey);
}

function markersIn(text, scopes) {
  return scopes.flatMap((scope) => MARKERS[scope].filter((value) => text.includes(value)).map((value) => `${scope}:${value}`));
}

async function caseCookie(ctx, route, actor, mfa) {
  if (actor.anonymous) return undefined;
  if (route.freshUser) return seedUserSession(ctx.db, sessionOptions(actor, mfa, true, nextKey(`mx-${actor.key}-u`)));
  if (route.freshSession) return seedUserSession(ctx.db, sessionOptions(actor, mfa, false));
  return ctx.sessions[actor.key][mfa];
}

async function auditIds(db) {
  const { rows } = await db.query('SELECT id FROM audit_events');
  return rows.map((row) => row.id);
}

async function runCase(ctx, route, actor, mfa, targetKey) {
  const expected = expectedStatus(route, actor, mfa, targetKey);
  let cookie = await caseCookie(ctx, route, actor, mfa);
  const obj = await objectFor(ctx, route, targetKey, expected, { cookie, route: route.id, success: isSuccess(expected) });
  if (obj?.cookie) cookie = obj.cookie;
  const key = `mx-${route.id}-${actor.key}-${mfa ? 'mfa' : 'nomfa'}-${targetKey === '-' ? 'x' : targetKey}-${++seq}`;
  const built = await route.build({ target: TARGETS[targetKey], obj, key, fx: ctx.fx });
  await refreshMfaFreshness(ctx.db); // przed odciskiem zapisów, żeby nie wyglądało to na zmianę po odmowie
  // Odczyty (GET) sprawdzamy pod kątem wycieku; ślad zapisu — dla metod zmieniających stan.
  const tracksWrites = route.method !== 'GET';
  const before = tracksWrites ? await writeFingerprint(ctx.db) : null;
  const auditBefore = tracksWrites && isSuccess(expected) ? await auditIds(ctx.db) : null;
  // #184 pkt 6: identyfikatory wierszy przed zapisem — każdy nowy wiersz musi mieć zdarzenie.
  const rowTables = auditBefore ? await rowCoverageTables(ctx.db) : null;
  const rowsBefore = rowTables ? await rowIdSnapshot(ctx.db, rowTables) : null;
  const response = await handlePgRequest(request(built.path, {
    method: route.method, body: built.body, headers: built.headers ?? {}, cookie,
  }), ctx.env);
  const text = await response.text();
  const label = `${route.method} ${built.path} | ${actor.key} | mfa=${mfa} | zakres=${targetKey}`;
  const problems = [];

  if (response.status !== expected) problems.push(`status ${response.status} zamiast ${expected}: ${text.slice(0, 200)}`);
  // #161: odmowa wyłącznie z powodu MFA ma kod prowadzący do zapisu MFA, nie ogólne `forbidden`
  // (sprawdzane dla każdej trasy × aktora z macierzy; dokumenty celowo odpowiadają 404).
  const mfaReason = mfaOnlyDenial(route, actor, mfa, targetKey);
  let mfaCode = null;
  if (mfaReason && expected === 403 && response.status === 403) {
    try { mfaCode = JSON.parse(text).error; } catch { /* treść nie-JSON */ }
  }
  if (!isSuccess(response.status)) {
    const leaked = markersIn(text, [...SCOPED_MARKER_KEYS, 'PUBLIC']);
    if (leaked.length) problems.push(`odmowa zawiera dane: ${leaked.join(', ')}`);
  } else {
    const visible = visibleScopes(route, actor, targetKey);
    const leaked = markersIn(text, SCOPED_MARKER_KEYS.filter((scope) => !visible.includes(scope)));
    if (leaked.length) problems.push(`odpowiedź 2xx zawiera dane spoza zakresu aktora: ${leaked.join(', ')}`);
    if (route.contains && isSuccess(expected)) {
      const missing = route.contains(actor, TARGETS[targetKey]).filter((scope) => !text.includes(marker(scope)));
      if (missing.length) problems.push(`odpowiedź nie zawiera oczekiwanych danych: ${missing.join(', ')}`);
    }
    if (route.check && isSuccess(expected)) {
      let json = null;
      try { json = JSON.parse(text); } catch { /* treść nie-JSON */ }
      problems.push(...route.check({ actor, mfa, targetKey, json, text }));
    }
  }
  if (auditBefore && isSuccess(response.status)) {
    const { rows } = await ctx.db.query(
      `SELECT actor_id, action, entity_type, entity_id, metadata_json FROM audit_events WHERE id <> ALL($1::text[])`,
      [auditBefore],
    );
    const stats = auditStats.get(route.id) ?? { successes: 0, complete: 0, actions: new Set() };
    auditStats.set(route.id, stats);
    stats.successes += 1;
    const needsActor = !AUDIT_ACTORLESS_ROUTES.has(route.id);
    for (const row of rows) {
      stats.actions.add(row.action);
      try { assertNoPii(row.metadata_json ?? {}); } catch (error) { problems.push(`zdarzenie ${row.action}: ${error.message}`); }
    }
    if (rows.some((row) => (row.actor_id || !needsActor) && row.entity_type && row.entity_id)) stats.complete += 1;
    const created = await newRows(ctx.db, rowsBefore, await rowIdSnapshot(ctx.db, rowTables));
    problems.push(...rowCoverageProblems(route.id, created, rows));
  }
  if (!isSuccess(expected) && tracksWrites) {
    const after = await writeFingerprint(ctx.db);
    const changed = WRITE_TABLES.filter((table) => after[table] !== before[table]);
    if (changed.length) problems.push(`odmowa zmieniła tabele: ${changed.join(', ')}`);
  }

  if (mfaReason && mfaCode !== null && mfaCode !== 'mfa_enrollment_required' && await grantsStillLive(ctx, cookie, actor)) {
    problems.push(`odmowa z powodu samego MFA (${mfaReason === 'gate' ? 'bramka routera' : 'trasa'}) ma kod ${mfaCode} zamiast mfa_enrollment_required — konto bez czynnika nie trafi do zapisu MFA (#161)`);
  }
  if (route.id === 'session.access' && response.status === 200) {
    const { grants } = JSON.parse(text);
    // #189: sesja czekająca na MFA (rola z wymogiem MFA, bez MFA) nie poznaje przydziałów.
    const hidden = ['noGrant', 'expiredGrant', 'revokedGrant'].includes(actor.key) || mfaPending(actor, mfa);
    const expectedGrants = hidden ? 0 : actor.grants.length;
    if (grants.length !== expectedGrants) problems.push(`/api/access zwraca ${grants.length} przydziałów zamiast ${expectedGrants}`);
  }
  if (route.id === 'session.logout' && cookie) {
    const after = await handlePgRequest(request('/api/session', { cookie }), ctx.env);
    if (after.status !== 401) problems.push(`sesja działa po wylogowaniu (status ${after.status})`);
  }
  return problems.map((problem) => `${label}: ${problem}`);
}

// #161: czy przydziały aktora nadal obowiązują (fixture mogło je zmienić — np. udane zamknięcie
// roku wygasza role tego roku; wtedy `forbidden` jest poprawne, bo rola już nie pasuje).
// Bramka czekająca na MFA odpowiada { mfaRequired: true }; bez niej /api/access zwraca przydziały.
async function grantsStillLive(ctx, cookie, actor) {
  const response = await handlePgRequest(request('/api/access', { cookie }), ctx.env);
  if (response.status !== 200) return false;
  const body = await response.json();
  if (body.mfaRequired) return true;
  const live = actor.grants.filter((grant) => !grant.revoked && !grant.expiresAt).length;
  return Array.isArray(body.grants) && body.grants.length === live;
}

function caseList(route) {
  const cases = [];
  for (const targetKey of route.targets) {
    for (const actor of ACTORS) {
      for (const mfa of [false, true]) cases.push({ targetKey, actor, mfa, todo: todoReason(route, actor, mfa, targetKey) });
    }
  }
  return cases;
}

for (const route of ROUTE_MATRIX) {
  const cases = caseList(route);
  const todoReasons = [...new Set(cases.map((item) => item.todo).filter(Boolean))];
  let todoFailures = [];
  const done = test(`macierz uprawnień: ${route.id} (${route.method} ${route.path})`, async () => {
    const ctx = await matrixContext(route.group);
    for (const [kind, stage, targets] of route.needs ?? []) {
      for (const targetKey of targets) await staticObject(ctx, kind, stage, targetKey);
    }
    const failures = [];
    for (const item of cases) {
      const problems = await runCase(ctx, route, item.actor, item.mfa, item.targetKey);
      if (item.todo) todoFailures.push(...problems);
      else failures.push(...problems);
    }
    assert.equal(cases.length, route.targets.length * ACTORS.length * 2);
    const stats = auditStats.get(route.id);
    // #184: trasa zapisu bez ani jednego udanego przypadku nie ma sprawdzonego dziennika.
    if (route.method !== 'GET' && !stats) {
      failures.push(`${route.method} ${route.path}: żaden przypadek macierzy nie kończy się sukcesem — pokrycie audytem niesprawdzone (dodaj przypadek dozwolony)`);
    }
    if (stats && !AUDIT_EXEMPT_ROUTES.has(route.id) && !stats.complete) {
      failures.push(`${route.method} ${route.path}: ${stats.successes} udanych zapisów bez zdarzenia audytu z ${AUDIT_ACTORLESS_ROUTES.has(route.id) ? '' : 'actor_id, '}entity_type i entity_id (zdarzenia: ${[...stats.actions].join(', ') || 'brak'}) — dopisz insertAuditEvent(tx, …) w trasie`);
    }
    assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  });
  if (todoReasons.length) {
    // Znana luka: przypadki zostały wykonane w teście powyżej; tu tylko wynik (todo nie blokuje CI).
    test(`macierz uprawnień — znana luka: ${route.id}`, { todo: todoReasons.join(' | ') }, async () => {
      await done;
      assert.deepEqual(todoFailures, [], `\n${todoFailures.join('\n')}`);
      todoFailures = [];
    });
  }
}

// #214: `todo` w macierzy nie oblewa CI, więc bez limitu jest wygodnym miejscem
// na ukrycie nowej regresji uprawnień. Dopuszczalne `todo` to WYŁĄCZNIE wpisy
// z listy poniżej: klucz to id trasy, wartość to numer otwartego issue. Lista
// jest dziś pusta. Nowe `todo` bez wpisu oraz wpis bez `todo` w macierzy (lub bez
// numeru issue) oblewają test — luka musi być zgłoszona, nie schowana.
export const ALLOWED_TODO = Object.freeze({
  // 'route.id': '#NNN',
});

export function todoViolations(routes, allowed, listCases = caseList) {
  const problems = [];
  const withTodo = new Set();
  for (const route of routes) {
    if (listCases(route).some((item) => item.todo)) withTodo.add(route.id);
  }
  for (const id of withTodo) {
    if (!Object.hasOwn(allowed, id)) problems.push(`trasa ${id} ma \`todo\` bez wpisu w ALLOWED_TODO`);
  }
  for (const [id, issue] of Object.entries(allowed)) {
    if (!/^#\d+$/.test(String(issue))) problems.push(`wpis ${id} nie wskazuje numeru issue (#NNN)`);
    if (!withTodo.has(id)) problems.push(`wpis ${id} w ALLOWED_TODO nie ma odpowiadającego \`todo\` w macierzy`);
  }
  return problems;
}

test('macierz uprawnień: `todo` tylko z listy ALLOWED_TODO wskazującej issue (#214)', () => {
  assert.deepEqual(todoViolations(ROUTE_MATRIX, ALLOWED_TODO), []);
});

test('meta-test `todo` wykrywa nowe `todo` bez wpisu, wpis martwy i wpis bez issue (kontrola pozytywna)', () => {
  const fakeRoutes = [
    { id: 'a.route', targets: [], todo: () => 'luka' },
    { id: 'b.route', targets: [] },
  ];
  const listCases = (route) => [{ todo: route.todo?.() }];
  assert.equal(todoViolations(fakeRoutes, {}, listCases).length, 1, 'todo bez wpisu');
  assert.deepEqual(todoViolations(fakeRoutes, { 'a.route': '#214' }, listCases), []);
  assert.equal(todoViolations(fakeRoutes, { 'a.route': 'kiedyś' }, listCases).length, 1, 'wpis bez numeru issue');
  assert.equal(todoViolations(fakeRoutes, { 'a.route': '#214', 'b.route': '#1' }, listCases).length, 1, 'martwy wpis');
});

// ---------- identyfikatory w treści żądania: spoza zakresu = nieistniejący (#205, SR-07) ----------

for (const item of REFERENCE_CASES) {
  test(`identyfikator w treści: ${item.id} — spoza zakresu i nieistniejący dają tę samą odmowę, bez zapisu`, async () => {
    const ctx = await matrixContext();
    const route = ROUTE_MATRIX.find((entry) => entry.id === item.routeId);
    assert.ok(route, `brak trasy ${item.routeId} w macierzy`);
    const target = TARGETS[item.target];
    for (const actorKey of item.actors) {
      const cookie = ctx.sessions[actorKey][true];
      const values = [...item.outOfScope, item.missing, item.inScope];
      // Obiekty (zebranie, wpłata nieprzypisana) powstają PRZED zdjęciem śladu zapisu.
      const objects = new Map();
      for (const value of values) {
        objects.set(value, route.object ? await makeObject(ctx, route.object, target, { cookie, route: route.id, success: true }) : null);
      }
      const send = async (value) => {
        const built = await route.build({ target, obj: objects.get(value), key: nextKey(`ref-${item.id}`), fx: ctx.fx });
        const response = await handlePgRequest(request(built.path, {
          method: route.method, body: item.body(value, { target, actorKey }),
          headers: { 'Idempotency-Key': nextKey(`ref-key-${actorKey}`) }, cookie,
        }), ctx.env);
        const text = await response.text();
        return { status: response.status, text };
      };
      const before = await writeFingerprint(ctx.db);
      const refused = [];
      for (const value of [...item.outOfScope, item.missing]) refused.push({ value, ...(await send(value)) });
      for (const result of refused) {
        assert.equal(result.status, item.denied, `${actorKey}/${result.value}: ${result.text}`);
        assert.equal(JSON.parse(result.text).error, item.deniedError, `${actorKey}/${result.value}`);
        assert.equal(result.text, refused[refused.length - 1].text, `${actorKey}/${result.value}: odpowiedź odróżnia spoza zakresu od nieistniejącego`);
        for (const scope of SCOPED_MARKER_KEYS) assert.ok(!MARKERS[scope].some((value) => result.text.includes(value)), `${actorKey}: odmowa zawiera dane ${scope}`);
      }
      assert.deepEqual(await writeFingerprint(ctx.db), before, `${actorKey}: odmowa zmieniła dane`);
      const accepted = await send(item.inScope);
      assert.equal(accepted.status, item.ok, `${actorKey}/${item.inScope}: ${accepted.text}`);
    }
  });
}

test.after(async () => {
  for (const pending of contexts.values()) await (await pending).db.close();
});

// ---------- testy uzupełniające (poza macierzą) ----------

test('email: webhook Brevo bez sekretu albo ze złym sekretem — 401 i brak zapisu', async () => {
  const ctx = await matrixContext();
  const before = await writeFingerprint(ctx.db);
  for (const headers of [{}, { Authorization: `Bearer ${'x'.repeat(48)}` }, { Authorization: `Bearer ${WEBHOOK_SECRET}x` }]) {
    const response = await handlePgRequest(request('/api/email/webhooks/brevo', {
      method: 'POST', origin: false, headers, body: { event: 'hard_bounce', email: 'opiekun-a@example.invalid', id: 1 },
    }), ctx.env);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(await writeFingerprint(ctx.db), before);
});

test('families: rodzeństwo w 1A i 1B — przedstawiciel widzi wyłącznie dziecko własnej klasy', async () => {
  const ctx = await matrixContext();
  // Zarząd (także z przydziałem klasy) i skarbnik przechodzą bramkę MFA routera tylko z sesją z MFA.
  for (const [actorKey, own, other, mfa] of [['repA', 'A', 'B', false], ['repB', 'B', 'A', false], ['boardA', 'A', 'B', true]]) {
    const response = await handlePgRequest(request('/api/households/hh-sib', { cookie: ctx.sessions[actorKey][mfa] }), ctx.env);
    const text = await response.text();
    assert.equal(response.status, 200, `${actorKey}: ${text}`);
    assert.ok(text.includes(marker(own)), `${actorKey}: brak dziecka własnej klasy`);
    assert.ok(!text.includes(marker(other)), `${actorKey}: widzi rodzeństwo z innej klasy`);
  }
  const wide = await handlePgRequest(request('/api/households/hh-sib', { cookie: ctx.sessions.treasurer[true] }), ctx.env);
  const text = await wide.text();
  assert.ok(text.includes(marker('A')) && text.includes(marker('B')), 'skarbnik widzi całą rodzinę roku');
});

test('denyStatus: funkcja odmowy zwraca wyłącznie 400/403/404', () => {
  for (const route of ROUTE_MATRIX.filter((entry) => typeof entry.deny === 'function')) {
    for (const actor of ACTORS) {
      for (const targetKey of route.targets) {
        for (const mfa of [false, true]) assert.ok([400, 403, 404].includes(denyStatus(route, actor, targetKey, mfa)), route.id);
      }
    }
  }
});

// ---------- meta-testy: macierz musi nadążać za ROUTES ----------

test('meta: każdy moduł z ROUTES ma wpisy w macierzy i odwrotnie', () => {
  const registered = ROUTES.map((route) => route.name);
  assert.equal(new Set(registered).size, registered.length, 'moduły w ROUTES muszą mieć unikalne `name`');
  const listed = new Set(ROUTE_MATRIX.map((route) => route.module));
  for (const name of registered) {
    assert.ok(listed.has(name),
      `Moduł tras "${name}" jest w ROUTES (src/pg/app.js), ale nie ma wpisów w tests/helpers/route-matrix.js. `
      + 'Dopisz każdą jego trasę do ROUTE_MATRIX i do tabeli w docs/AUTHORIZATION.md.');
  }
  for (const name of listed) assert.ok(registered.includes(name), `Macierz opisuje moduł "${name}", którego nie ma w ROUTES`);
});

test('meta: wpisy macierzy są spójne (id, aktorzy, zakresy, statusy)', () => {
  const ids = ROUTE_MATRIX.map((route) => route.id);
  assert.equal(new Set(ids).size, ids.length, 'id tras w macierzy muszą być unikalne');
  // `variant` (opcjonalny): druga pozycja tej samej trasy z innym obiektem fixture (np. #200 —
  // opiekun z dziećmi z dwóch klas), z własną tabelą oczekiwanych statusów.
  const signatures = ROUTE_MATRIX.map((route) => `${route.method} ${route.path}${route.variant ? ` [${route.variant}]` : ''}`);
  assert.equal(new Set(signatures).size, signatures.length, 'para metoda + ścieżka (+ variant) musi być unikalna');
  for (const route of ROUTE_MATRIX) {
    assert.ok(route.targets.length > 0 && route.targets.every((key) => key in TARGETS), route.id);
    assert.ok([200, 201, 204].includes(route.ok), `${route.id}: ok`);
    if (typeof route.allow === 'object') {
      const denies = typeof route.deny === 'function'
        ? ACTORS.flatMap((actor) => route.targets.flatMap((key) => [false, true].map((mfa) => route.deny(actor, key, mfa))))
        : [route.deny];
      assert.ok(denies.every((status) => [400, 403, 404].includes(status)), `${route.id}: deny`);
      if (route.mfaDeny !== undefined) assert.ok([403, 404].includes(route.mfaDeny), `${route.id}: mfaDeny`);
      for (const [actorKey, scopes] of Object.entries(route.allow)) {
        assert.ok(ACTOR_KEYS.includes(actorKey), `${route.id}: nieznany aktor ${actorKey}`);
        assert.ok(scopes.every((scope) => route.targets.includes(scope)), `${route.id}: zakres spoza targets`);
      }
      // Każda trasa chroniona musi mieć co najmniej jeden przypadek odmowy dla innego roku.
      if (route.targets.includes('Y2')) {
        assert.ok(Object.values(route.allow).every((scopes) => !scopes.includes('Y2')), `${route.id}: Y2`);
      }
    } else {
      assert.ok(['authenticated', 'public'].includes(route.allow), route.id);
    }
  }
});

const MODULE_SOURCES = {
  session: ['../src/pg/routes/session.js'],
  payments: ['../src/pg/routes/payments.js'],
  'payment-references': ['../src/pg/routes/payment-references.js'],
  'payment-instructions': ['../src/pg/routes/payment-instructions.js'],
  events: ['../src/pg/routes/events.js', '../src/pg/events.js'],
  meetings: ['../src/pg/routes/meetings.js', '../src/pg/meetings.js'],
  import: ['../src/pg/routes/import.js'],
  documents: ['../src/pg/routes/documents.js', '../src/documents.js'],
  ledger: ['../src/pg/routes/ledger.js'],
  'ledger-cash': ['../src/pg/routes/ledger-cash.js'],
  'ledger-budget': ['../src/pg/routes/ledger-budget.js'],
  'ledger-cost-centers': ['../src/pg/routes/ledger-cost-centers.js'],
  email: ['../src/pg/routes/email.js'],
  news: ['../src/pg/routes/news.js', '../src/pg/news.js'],
  admin: ['../src/pg/routes/admin.js'],
  reconciliation: ['../src/pg/routes/reconciliation.js'],
  'financial-reports': ['../src/pg/routes/financial-reports.js'],
  exports: ['../src/pg/routes/exports.js'],
  families: ['../src/pg/routes/families.js'],
  print: ['../src/pg/routes/print.js'],
  'year-close': ['../src/pg/routes/year-close.js'],
  mfa: ['../src/pg/routes/mfa.js'],
  login: ['../src/pg/routes/login.js'],
  representative: ['../src/pg/routes/representative.js'],
  'guardian-updates': ['../src/pg/routes/guardian-updates.js'],
  'privacy-notice': ['../src/pg/routes/privacy-notice.js'],
  board: ['../src/pg/routes/board.js'],
};

// Segmenty ścieżek widoczne w kodzie modułu: literały '/api/…', segmenty z wyrażeń
// regularnych /^\/api…$/ (\/słowo, (a|b)) i porównania w funkcji route() modułu zebrań.
// Dla modułu administracji — także sekcje z KNOWN_SECTIONS.
function pathSegmentsInSource(source) {
  const segments = new Set();
  for (const [, literal] of source.matchAll(/'(\/api\/[a-z/-]+)'/g)) {
    for (const part of literal.split('/').filter(Boolean)) segments.add(part);
  }
  for (const [, regex] of source.matchAll(/\/(\^\\\/api[^\n]*?)\$\//g)) {
    for (const [, word] of regex.matchAll(/\\\/([a-z][a-z-]*)/g)) segments.add(word);
    for (const [, group] of regex.matchAll(/\(([a-z|]+)\)/g)) group.split('|').forEach((word) => segments.add(word));
  }
  const sections = source.match(/KNOWN_SECTIONS = new Set\(\[([^\]]*)\]\)/);
  if (sections) for (const [, word] of sections[1].matchAll(/'([a-z][a-z-]*)'/g)) segments.add(word);
  const routeFunction = source.match(/\nfunction route\([\s\S]*?\n}\n/);
  if (routeFunction) {
    for (const [, word] of routeFunction[0].matchAll(/[a-e] === '([a-z][a-z-]*)'/g)) segments.add(word);
  }
  return segments;
}

test('meta: każda ścieżka widoczna w kodzie modułu tras jest pokryta macierzą', async () => {
  for (const route of ROUTES) {
    const files = MODULE_SOURCES[route.name];
    assert.ok(files, `Dopisz pliki źródłowe modułu "${route.name}" do MODULE_SOURCES w tym teście`);
    const covered = new Set(ROUTE_MATRIX.filter((entry) => entry.module === route.name)
      .flatMap((entry) => entry.path.split('?')[0].split('/').filter(Boolean)));
    let found = 0;
    for (const file of files) {
      const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const segments = pathSegmentsInSource(source);
      found += segments.size;
      for (const segment of segments) {
        assert.ok(covered.has(segment),
          `${file}: segment ścieżki "${segment}" nie występuje w żadnym wpisie macierzy modułu "${route.name}"`);
      }
    }
    assert.ok(found > 0, `${route.name}: nie znaleziono żadnej ścieżki w kodzie — zaktualizuj pathSegmentsInSource`);
  }
});

test('meta: każde zwolnienie z bramki MFA ma uzasadnienie i wpis w macierzy (#189)', () => {
  const exempt = [...MFA_GATE_EXEMPT_EXACT, ...MFA_GATE_EXEMPT_PREFIXES];
  assert.deepEqual([...exempt].sort(), Object.keys(MFA_GATE_EXEMPT_REASONS).sort(),
    'Nowe zwolnienie w src/pg/mfa-policy.js wymaga uzasadnienia w MFA_GATE_EXEMPT_REASONS (tests/helpers/route-matrix.js)');
  for (const path of exempt) {
    assert.ok(ROUTE_MATRIX.some((route) => (path.endsWith('/') ? route.path.startsWith(path) : route.path.split('?')[0] === path)),
      `zwolnienie ${path} bez wpisu w macierzy`);
  }
});

test('meta: każda trasa macierzy jest opisana w docs/AUTHORIZATION.md', async () => {
  const doc = await readFile(fileURLToPath(new URL('../docs/AUTHORIZATION.md', import.meta.url)), 'utf8');
  for (const route of ROUTE_MATRIX) {
    assert.ok(doc.includes(`\`${route.method} ${route.path}\``),
      `docs/AUTHORIZATION.md: brak wiersza \`${route.method} ${route.path}\` w tabeli macierzy tras`);
  }
});

test('meta: detektor macierzy wykrywa błędny status i wyciek danych (kontrola pozytywna)', async () => {
  const ctx = await matrixContext();
  const byId = Object.fromEntries(ROUTE_MATRIX.map((route) => [route.id, route]));
  const repA = ACTORS.find((actor) => actor.key === 'repA');
  // Tabela twierdzi (błędnie), że 1A może czytać szkic 1B — trasa odmawia, więc detektor zgłasza status.
  const wrongStatus = await runCase(ctx, { ...byId['events.get'], allow: { repA: ['A', 'B'] } }, repA, false, 'B');
  assert.ok(wrongStatus.some((problem) => problem.includes('status 404 zamiast 200')), wrongStatus.join('\n'));
  // Tabela twierdzi, że przedstawiciel nie może widzieć żadnej klasy — /api/access zawiera "kl-1a".
  const leak = await runCase(ctx, { ...byId['session.access'], visible: () => [] }, repA, false, '-');
  assert.ok(leak.some((problem) => problem.includes('A:"kl-1a"')), leak.join('\n'));
  // Ślad odmowy: próba zapisu bez uprawnień nie zmienia tabel (przypadek poprawny = brak problemów).
  const denied = await runCase(ctx, byId['events.create'], repA, false, 'B');
  assert.deepEqual(denied, []);
  // #161: tabela twierdzi, że przedstawiciel czyta wpłaty z MFA — bez MFA trasa odpowiada ogólnym
  // `forbidden` (rola nie pasuje), więc detektor zgłasza brak kodu prowadzącego do zapisu MFA.
  const deadEnd = await runCase(ctx, { ...byId['payments.list'], allow: { repA: ['W1'] } }, repA, false, 'W1');
  assert.ok(deadEnd.some((problem) => problem.includes('kod forbidden zamiast mfa_enrollment_required')), deadEnd.join('\n'));
  // Poprawny przypadek: lista własnej klasy bez czynnika daje mfa_enrollment_required (brak problemów).
  assert.deepEqual(await runCase(ctx, byId['exports.classRoster'], repA, false, 'A'), []);
});

// ---------- regresje dawnych rozbieżności ----------

// SR-07 (naprawione): PATCH/submit/cancel cudzego wydarzenia odpowiadają jak brak wydarzenia.
test('events: zmiana cudzego szkicu odpowiada jak brak wydarzenia (bez wyroczni istnienia)', async () => {
  const ctx = await matrixContext();
  const repA = ctx.sessions.repA[false];
  const foreign = (await staticObject(ctx, 'event', 'draft', 'B')).eventId;
  const attempts = [
    ['PATCH', '', { revision: 1, title: 'Próba zmiany' }],
    ['POST', '/submit', { revision: 1 }],
    ['POST', '/cancel', { revision: 1, reason: 'Próba odwołania' }],
  ];
  for (const [method, suffix, body] of attempts) {
    const missing = await handlePgRequest(request(`/api/events/nieistniejace-wydarzenie${suffix}`, {
      method, cookie: repA, body,
    }), ctx.env);
    const other = await handlePgRequest(request(`/api/events/${foreign}${suffix}`, {
      method, cookie: repA, body,
    }), ctx.env);
    assert.equal(missing.status, 404, `${method} ${suffix}`);
    assert.equal(other.status, missing.status, `${method} ${suffix}: odmowa dla cudzej klasy powinna być nieodróżnialna od braku obiektu`);
  }
});

test('meta: wyjątki od pokrycia audytem wskazują istniejące trasy zapisu i mają uzasadnienie (#184)', () => {
  const writes = new Map(ROUTE_MATRIX.filter((route) => route.method !== 'GET').map((route) => [route.id, route]));
  for (const [name, list] of [['AUDIT_EXEMPT_ROUTES', AUDIT_EXEMPT_ROUTES], ['AUDIT_ACTORLESS_ROUTES', AUDIT_ACTORLESS_ROUTES]]) {
    for (const [id, reason] of list) {
      assert.ok(writes.has(id), `${name}: ${id} nie jest trasą zapisu w macierzy`);
      assert.ok(reason.length >= 30, `${name}: ${id} bez uzasadnienia`);
    }
  }
  for (const id of AUDIT_EXEMPT_ROUTES.keys()) assert.ok(!AUDIT_ACTORLESS_ROUTES.has(id), `${id} na obu listach`);
});

test('meta: wyjątki pokrycia wierszy audytem wskazują tabele z kolumną id i mają uzasadnienie (#184 pkt 6)', async () => {
  const ctx = await matrixContext();
  const tables = new Set(await rowCoverageTables(ctx.db));
  const writes = new Set(ROUTE_MATRIX.filter((route) => route.method !== 'GET').map((route) => route.id));
  for (const [table, entry] of AUDIT_ROW_PARENTS) {
    assert.ok(tables.has(table), `AUDIT_ROW_PARENTS: ${table} nie jest tabelą z kolumną id`);
    assert.equal(typeof entry.keys, 'function', `AUDIT_ROW_PARENTS: ${table} bez funkcji kluczy`);
    assert.ok(entry.why.length >= 30, `AUDIT_ROW_PARENTS: ${table} bez uzasadnienia`);
    for (const key of entry.metadataKeys ?? []) assert.match(key, /^[a-z][A-Za-z]*Id$/, `AUDIT_ROW_PARENTS: ${table}: klucz metadanych ${key}`);
    assert.ok(!AUDIT_ROW_TECHNICAL.has(table), `${table} na dwóch listach`);
  }
  for (const [table, why] of AUDIT_ROW_TECHNICAL) {
    assert.ok(tables.has(table), `AUDIT_ROW_TECHNICAL: ${table} nie jest tabelą z kolumną id`);
    assert.ok(why.length >= 30, `AUDIT_ROW_TECHNICAL: ${table} bez uzasadnienia`);
  }
  for (const [routeId, entry] of AUDIT_ROW_ROUTE_EXEMPT) {
    assert.ok(writes.has(routeId), `AUDIT_ROW_ROUTE_EXEMPT: ${routeId} nie jest trasą zapisu w macierzy`);
    assert.ok(entry.why.length >= 30, `AUDIT_ROW_ROUTE_EXEMPT: ${routeId} bez uzasadnienia`);
    for (const table of entry.tables) assert.ok(tables.has(table), `AUDIT_ROW_ROUTE_EXEMPT: ${routeId}: ${table} nie jest tabelą z kolumną id`);
  }
  // Tabele finansowe, ról i wysyłek (AGENTS.md) nie mogą być zwolnione jako techniczne.
  for (const table of AUDIT_ROW_TECHNICAL.keys()) {
    assert.doesNotMatch(table, /^(payment|ledger|bank_|role_grants|invitations|users|email_campaigns|email_outbox$)/, `${table}: tabela biznesowa na liście technicznej`);
  }
});
