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
import { approve, createDraft, publish, submit } from '../src/pg/events.js';
import {
  approveMinutes, createMeeting, createMinutesVersion, createResolution, determineQuorum,
  recordAttendance, setMinutesVisibility, updateMeeting,
} from '../src/pg/meetings.js';
import {
  approve as approveNews, createDraft as createNewsDraft, publish as publishNews, registerPhoto, submit as submitNews,
  uploadPhotoFile, verifyPhoto,
} from '../src/pg/news.js';
import { hashSecret } from '../src/auth.js';
import { createSession } from '../src/pg/auth.js';
import { MFA_GATE_EXEMPT_EXACT, MFA_GATE_EXEMPT_PREFIXES } from '../src/pg/mfa-policy.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import { hashPassword } from '../src/pg/password.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import {
  ACTOR_KEYS, ACTORS, MARKERS, MFA_GATE_EXEMPT_REASONS, ROUTE_MATRIX, SCOPED_MARKER_KEYS, TARGETS, YEAR_1, YEAR_2,
  campaignBody, denyStatus, expectedStatus, importPayload, ledgerCategory, marker, mfaPending, pdfBytes, photoBody,
  pngBytes, statementDate, todoReason, visibleScopes, yearDate,
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
const withKey = (key) => ({ 'Idempotency-Key': key });

// ---------- fixtures ----------

async function seedBase(db) {
  await seedSchoolYear(db, YEAR_1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, YEAR_2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  for (const target of [TARGETS.A, TARGETS.B, TARGETS.Y2]) {
    await seedClass(db, { id: target.classId, schoolYearId: target.schoolYearId });
  }
  for (const account of Object.values(FX_ACCOUNTS)) await seedUser(db, { userId: account.userId });
  await db.query("INSERT INTO households (id) VALUES ('hh-1')");
  // #138: cel ponownego przypisania wpłaty (payments.reassignment).
  await db.query("INSERT INTO households (id) VALUES ('hh-2')");
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
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
    [enrollmentId, studentId, target.classId, target.schoolYearId]);
  return { householdId, guardianId, studentId, enrollmentId };
}

async function seedFixtureSessions(db) {
  const cookies = {};
  for (const [name, account] of Object.entries(FX_ACCOUNTS)) {
    cookies[name] = await seedUserSession(db, { userId: account.userId, roles: [{ role: account.role }], mfa: true });
  }
  return cookies;
}

// Wywołanie API kontem fixture; błąd = przerwanie testu (fixture musi się udać).
async function api(ctx, cookie, method, path, body, headers = {}) {
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

async function makeMeeting(db, target, stage, { title, minutesBody, visibility = 'parents', resolutionNumber } = {}) {
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
  const unmatched = stage === 'unmatched';
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
       reference, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, 100000, $8, 'bank', $4, $5, $6, $7)`,
    [id, unmatched ? null : 'hh-1', target.schoolYearId, `Wpłata ${marker(target.key)}`,
      unmatched ? 'unmatched' : 'recorded', fxAdmin.userId, `${id}-key`, yearDate(target, '10-01')],
  );
  return { paymentId: id };
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

async function makeReconciliation(ctx, target, stage) {
  const cookie = ctx.fxCookies.treasurer;
  const { json } = await api(ctx, cookie, 'POST', '/api/reconciliations', {
    schoolYearId: target.schoolYearId, statementDate: statementDate(target), statementBalanceCents: 100000,
    notes: `Uzgodnienie ${marker(target.key)}`,
  }, withKey(nextKey('fx-rec')));
  const reconciliationId = json.reconciliation.id;
  if (stage === 'draft') return { reconciliationId };
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
  event: (ctx, target, stage) => makeEvent(ctx.db, target, stage),
  meeting: (ctx, target, stage) => makeMeeting(ctx.db, target, stage),
  payment: (ctx, target, stage) => makePayment(ctx.db, target, stage),
  newsPost: (ctx, target, stage) => makeNewsPost(ctx.db, target, stage),
  publicPhotoFile: (ctx, target) => makePublicPhotoFile(ctx, target),
  photo: async (ctx) => {
    const key = nextKey('fx-photo');
    const { photo } = await registerPhoto(ctx.db, fxAdmin, { ...photoBody(key), idempotencyKey: key });
    return { photoId: photo.id };
  },
  document: async (ctx, target, kind) => {
    const classPart = kind === 'class' ? `&classId=${target.classId}` : '';
    const { json } = await api(ctx, ctx.fxCookies.admin, 'POST', `/api/documents?kind=${kind}&schoolYearId=${target.schoolYearId}${classPart}`,
      pdfBytes(target.key), { 'Content-Type': 'application/pdf', 'Idempotency-Key': nextKey('fx-doc') });
    return { documentId: json.document.id };
  },
  ledgerEntry: async (ctx, target) => {
    const { json } = await api(ctx, ctx.fxCookies.treasurer, 'POST', '/api/ledger', {
      schoolYearId: target.schoolYearId, direction: 'income', amountCents: 100000, categoryId: ledgerCategory(target),
      description: `Wpis ${marker(target.key)}`, occurredOn: yearDate(target, '10-01'), method: 'bank',
    }, withKey(nextKey('fx-ledger')));
    return { ledgerEntryId: json.entry.id };
  },
  // #97: wydatek zapisany przez konto pomocnicze (autor inny niż każdy aktor macierzy).
  ledgerExpense: async (ctx, target) => {
    const { json } = await api(ctx, ctx.fxCookies.treasurer, 'POST', '/api/ledger', {
      schoolYearId: target.schoolYearId, direction: 'expense', amountCents: 1000, categoryId: `cat-out-${target.schoolYearId}`,
      description: `Wydatek ${marker(target.key)}`, occurredOn: yearDate(target, '10-02'), method: 'bank',
    }, withKey(nextKey('fx-ledger-exp')));
    return { ledgerEntryId: json.entry.id };
  },
  // #207: kategoria świeża per przypadek — do dezaktywacji (nie może być
  // współdzielonym `cat-in-<year>`, bo tamta jest używana przez inne trasy).
  ledgerCategory: async (ctx, target) => {
    const id = nextKey('fx-ledger-cat');
    await ctx.db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
       VALUES ($1, $2, 'income', $3, 'u-fx-admin')`,
      [id, target.schoolYearId, `Kat ${marker(target.key)} ${id}`],
    );
    return { categoryId: id };
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
  reconciliation: makeReconciliation,
  household: (ctx, target) => makeHousehold(ctx.db, target),
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
  'meeting_request_keys', 'payment_entries', 'payment_corrections', 'payment_assignments', 'role_grants',
  'users', 'sessions', 'invitations', 'user_mfa_factors', 'mfa_recovery_codes',
  'import_batches', 'households', 'guardians', 'students', 'enrollments', 'student_guardians',
  'guardian_contact_changes', 'student_guardian_changes', 'enrollment_history', 'documents',
  'ledger_entries', 'ledger_corrections', 'ledger_opening_balances',
  'ledger_opening_balance_adjustments', 'ledger_transfers',
  'email_campaigns', 'email_campaign_recipients', 'email_campaign_exclusions', 'email_outbox',
  'email_webhook_events', 'email_suppressions', 'email_preferences_events', 'email_preview_sends',
  'news_posts', 'news_post_revisions', 'news_photos', 'news_photo_consents',
  'bank_reconciliations', 'bank_statement_imports', 'bank_statement_lines', 'bank_reconciliation_matches',
  'export_runs', 'school_year_closures', 'school_year_closure_checklist',
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
        db, storage: createMemoryStorage(), MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
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

async function runCase(ctx, route, actor, mfa, targetKey) {
  const expected = expectedStatus(route, actor, mfa, targetKey);
  let cookie = await caseCookie(ctx, route, actor, mfa);
  const obj = await objectFor(ctx, route, targetKey, expected, { cookie, route: route.id, success: isSuccess(expected) });
  if (obj?.cookie) cookie = obj.cookie;
  const key = `mx-${route.id}-${actor.key}-${mfa ? 'mfa' : 'nomfa'}-${targetKey === '-' ? 'x' : targetKey}-${++seq}`;
  const built = await route.build({ target: TARGETS[targetKey], obj, key, fx: ctx.fx });
  // Odczyty (GET) sprawdzamy pod kątem wycieku; ślad zapisu — dla metod zmieniających stan.
  const tracksWrites = route.method !== 'GET';
  const before = tracksWrites ? await writeFingerprint(ctx.db) : null;
  const response = await handlePgRequest(request(built.path, {
    method: route.method, body: built.body, headers: built.headers ?? {}, cookie,
  }), ctx.env);
  const text = await response.text();
  const label = `${route.method} ${built.path} | ${actor.key} | mfa=${mfa} | zakres=${targetKey}`;
  const problems = [];

  if (response.status !== expected) problems.push(`status ${response.status} zamiast ${expected}: ${text.slice(0, 200)}`);
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
  if (!isSuccess(expected) && tracksWrites) {
    const after = await writeFingerprint(ctx.db);
    const changed = WRITE_TABLES.filter((table) => after[table] !== before[table]);
    if (changed.length) problems.push(`odmowa zmieniła tabele: ${changed.join(', ')}`);
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
// na ukrycie nowej regresji uprawnień. Dziś macierz nie ma żadnego wpisu — ten
// meta-test to zabezpiecza: dodanie `todo` do route-matrix.js musi być świadome
// i opisane w PR/issue, nie przejść bez zauważenia.
test('macierz uprawnień: zero wpisów `todo` (znana luka wymaga świadomej decyzji, patrz #214)', () => {
  const allTodoReasons = ROUTE_MATRIX.flatMap((route) => caseList(route).map((item) => item.todo).filter(Boolean));
  assert.deepEqual(allTodoReasons, [], `macierz ma ${allTodoReasons.length} wpis(y) todo — opisz je w PR i w issue: ${allTodoReasons.join(' | ')}`);
});

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
  const signatures = ROUTE_MATRIX.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(signatures).size, signatures.length, 'para metoda + ścieżka musi być unikalna');
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
  events: ['../src/pg/routes/events.js', '../src/pg/events.js'],
  meetings: ['../src/pg/routes/meetings.js', '../src/pg/meetings.js'],
  import: ['../src/pg/routes/import.js'],
  documents: ['../src/pg/routes/documents.js', '../src/documents.js'],
  ledger: ['../src/pg/routes/ledger.js'],
  'ledger-cash': ['../src/pg/routes/ledger-cash.js'],
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
