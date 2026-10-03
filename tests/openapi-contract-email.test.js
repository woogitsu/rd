// Kontrakt API (#160, etap 6): prawdziwe odpowiedzi modułu `email` (PGlite, dane syntetyczne
// `@example.invalid`) walidowane schematami z docs/openapi.json (src/pg/schemas/email.js) przez
// tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza
// tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: wysyłka testowa i zadanie kolejki używają wyłącznie atrapy
// transportu (`fakeTransport`), a globalna pułapka sieci (tests/helpers/network-guard.js) liczy
// próby — licznik musi być 0. Adresy są syntetyczne; żaden test nie wysyła do prawdziwego rodzica.
//
// Przebieg kampanii: szkic → edycja z wersją → migawka odbiorców (rodzeństwo w dwóch klasach
// i dwoje opiekunów = jedna wiadomość; błędny adres, blokada adresu z webhooka, adres użyty już
// dla innej rodziny — wykluczenia) → podgląd → jawne zatwierdzenie skrótów treści i listy przez
// inną osobę z zarządu (świeże MFA) → kolejka z kluczem kampania + rodzina → zadanie (odmowa konta
// dostawcy = pauza, zdjęcie pauzy, wysyłka, ponowienie zadania bez duplikatów) → webhook → raport,
// lista „do sprawdzenia”, rozstrzygnięcia (cztery oczy) i kampania uzupełniająca. Do tego: lista
// wyłączeń ze zdjęciem blokady (dwie osoby), limit Brevo z ewidencją i korektą, stan zadania,
// wysyłka testowa (limit, odmowa adresu, wyłączona wysyłka), wypisanie jednym kliknięciem, listy
// z kursorem, granice ról (401, 403 dla przedstawiciela klasy, zarządu z przydziałem klasy, Komisji
// Rewizyjnej i braku MFA, obcy Origin) oraz błędy 400/404/409/413/415/422/429/503.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { EmailTransportError } from '../src/email/brevo.js';
import { emailHash, preferencesToken } from '../src/email/content.js';
import { runEmailBatch } from '../src/email/worker.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const WEBHOOK_SECRET = 'w'.repeat(48);
const UNSUBSCRIBE_SECRET = 'u'.repeat(48);
const PREVIEW_ADDRESS = 'skrzynka-testowa-rady@example.invalid';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. '
  + 'Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const HASH_F = 'f'.repeat(64);

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;
const today = () => new Date().toISOString().slice(0, 10);

// Atrapa transportu: zapamiętuje wiadomości, nigdy nie łączy się z siecią.
function fakeTransport(fail = () => null) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    async send(message) {
      calls.push(message);
      const error = fail(message, calls.length);
      if (error) throw error;
      return { messageId: `fake-${calls.length}-${message.outboxId}` };
    },
  };
}

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schemacie modułu (i każdy jej format) została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(client) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'email') continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 38, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !client.validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, method, path, validBody, componentName, { withKey = false } = {}) {
  const requiredFields = components[componentName].required;
  assert.ok(requiredFields.length > 0, `${componentName}: schemat ma wymagane pola`);
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call(method, path, {
      cookie, body, key: withKey ? key('req') : undefined, expect: 400, invalidRequest: true,
    });
    assert.equal(typeof response.body.error, 'string', `${componentName}.${field}: kod błędu`);
  }
}

// Rodzina: dzieci zapisane do wskazanych klas i opiekunowie z relacją do każdego dziecka.
async function family(db, householdId, { classes = ['c-1a'], guardians = [{}] } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const studentIds = [];
  for (const [index, classId] of classes.entries()) {
    const id = `${householdId}-s${index + 1}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Syntetyczny')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, YEAR]);
  }
  for (const [index, guardian] of guardians.entries()) {
    const id = `${householdId}-g${index + 1}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Syntetyczny', $3, true)`,
      [id, householdId, guardian.email ?? `${id}@example.invalid`],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
        [studentId, id, index === 0],
      );
    }
  }
}

async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedPublishedPrivacyNotice(db);
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: year('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: year('board') }),
    // MFA potwierdzone 20 min temu (krok w górę wymaga ≤ 15 min) — ustawiane niżej.
    boardStale: await seedUserSession(db, { userId: 'u-board-stale', mfa: true, roles: year('board') }),
    // Przydział zarządu bez roku: zapis kampanii roku, którego nie ma w bazie (400 invalid_reference).
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardClass: await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: year('board', { classId: 'c-1a' }) }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: year('board') }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: year('representative', { classId: 'c-1a' }) }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
  };
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-stale'");

  // h1: rodzeństwo w dwóch klasach i dwoje opiekunów (kontakt główny g1) → jedna wiadomość.
  await family(db, 'h1', { classes: ['c-1a', 'c-1b'], guardians: [{}, {}] });
  await family(db, 'h2');
  await family(db, 'h3', { guardians: [{ email: 'to-nie-jest-adres' }] });
  await family(db, 'h4');
  // h5: opiekun z adresem użytym już dla h2 → bez drugiej wiadomości na ten sam adres.
  await family(db, 'h5', { classes: ['c-1b'], guardians: [{ email: 'h2-g1@example.invalid' }] });
  await family(db, 'h6');
  await family(db, 'h7', { classes: ['c-1b'] });

  const previewTransport = fakeTransport();
  const env = {
    db,
    APP_ENV: 'development',
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    EMAIL_UNSUBSCRIBE_SECRET: UNSUBSCRIBE_SECRET,
    PUBLIC_BASE_URL: 'https://rd.example.invalid',
    EMAIL_PREVIEW_RECIPIENTS: PREVIEW_ADDRESS,
    emailTransport: previewTransport,
  };
  return { db, env, cookies, previewTransport, client: newClient(env) };
}

const webhookHeaders = { Authorization: `Bearer ${WEBHOOK_SECRET}` };

test('klient kontraktu: nagłówek Idempotency-Replayed — brak dozwolony tylko przy `required: false` (kontrola pozytywna)', async () => {
  const respond = (status, headers = {}) => createContractClient({
    spec,
    fetch: async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json', ...headers } }),
  });
  const createBody = { schoolYearId: YEAR, title: 'Kampania', audience: 'all_households', subject: 'Temat {rok}', bodyText: BODY };
  // Szkic: nagłówek wymagany przy 201 — jego brak jest błędem.
  await assert.rejects(
    respond(201).call('POST', '/api/email/campaigns', { body: createBody, key: key('ctl'), expect: 201 }),
    /Idempotency-Replayed/,
  );
  // Zatwierdzenie: brak nagłówka przy pierwszym wykonaniu jest dozwolony (błąd dotyczy dopiero treści),
  // a wartość spoza specyfikacji — nie.
  const approveBody = { contentHash: HASH_F, recipientsHash: HASH_F };
  await assert.rejects(
    respond(200).call('POST', '/api/email/campaigns/c1/approve', { body: approveBody, expect: 200 }),
    /odpowiedź niezgodna ze schematem/,
  );
  await assert.rejects(
    respond(200, { 'Idempotency-Replayed': 'false' }).call('POST', '/api/email/campaigns/c1/approve', { body: approveBody, expect: 200 }),
    /Idempotency-Replayed/,
  );
});

test('kontrakt modułu email: prawdziwe odpowiedzi kampanii, kolejki, wyłączeń, limitu i webhooka zgodne ze schematami', async () => {
  const { db, env, cookies, previewTransport, client } = await world();
  const T = cookies.treasurer;
  const A = cookies.boardA;
  const B = cookies.boardB;
  try {
    // ---------- Webhook przed migawką: blokada adresu h4 (bounce) i skarga na adres spoza rodzin ----------
    const bounce = await client.call('POST', '/api/email/webhooks/brevo', {
      headers: webhookHeaders, expect: 200,
      body: { event: 'hard_bounce', email: 'h4-g1@example.invalid', id: 'evt-1', ts_event: 1791187200 },
    });
    assert.deepEqual(bounce.body, { received: 1, recorded: 1, suppressed: 1, ignored: 0 });
    const batch = await client.call('POST', '/api/email/webhooks/brevo', {
      headers: webhookHeaders, expect: 200,
      body: [
        { event: 'spam', email: 'skarga@example.invalid', id: 'evt-2', ts_event: 1791187201 },
        { event: 'nowe_zdarzenie_dostawcy', email: 'x@example.invalid', id: 'evt-3' },
        { event: 'hard_bounce', email: 'h4-g1@example.invalid', id: 'evt-1', ts_event: 1791187200 },
      ],
    });
    assert.deepEqual(batch.body, { received: 3, recorded: 1, suppressed: 1, ignored: 1 }, 'powtórzone zdarzenie bez drugiego zapisu');
    // Błędy webhooka: sekret, typ treści, JSON, pusta lista, rozmiar, brak konfiguracji.
    const event = { event: 'opened', email: 'x@example.invalid', id: 'evt-9' };
    await client.call('POST', '/api/email/webhooks/brevo', { body: event, expect: 401 });
    await client.call('POST', '/api/email/webhooks/brevo', { headers: { Authorization: `Bearer ${'z'.repeat(48)}` }, body: event, expect: 401 });
    await client.call('POST', '/api/email/webhooks/brevo', { headers: { ...webhookHeaders, 'Content-Type': 'text/plain' }, body: 'event=opened', expect: 415, invalidRequest: true });
    await client.call('POST', '/api/email/webhooks/brevo', { headers: { ...webhookHeaders, 'Content-Type': 'application/json' }, body: '{"event":', expect: 400, invalidRequest: true });
    await client.call('POST', '/api/email/webhooks/brevo', { headers: webhookHeaders, body: [], expect: 400, invalidRequest: true });
    await client.call('POST', '/api/email/webhooks/brevo', { headers: webhookHeaders, body: { ...event, pad: 'x'.repeat(70 * 1024) }, expect: 413 });
    const unconfigured = newClient({ ...env, BREVO_WEBHOOK_SECRET: '' });
    await unconfigured.call('POST', '/api/email/webhooks/brevo', { headers: webhookHeaders, body: event, expect: 503 });

    // ---------- Szkic: utworzenie, ponowienie, konflikt klucza, błędy treści ----------
    const draftBody = {
      schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY,
    };
    const draftKey = key('camp');
    const created = await client.call('POST', '/api/email/campaigns', { cookie: T, body: draftBody, key: draftKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    assert.deepEqual([created.body.campaign.status, created.body.campaign.kind, created.body.campaign.revisionNo], ['draft', 'standard', 1]);
    const replay = await client.call('POST', '/api/email/campaigns', { cookie: T, body: draftBody, key: draftKey, expect: 200 });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(replay.body, created.body);
    await client.call('POST', '/api/email/campaigns', { cookie: T, body: { ...draftBody, subject: 'Inny temat {rok}' }, key: draftKey, expect: 409 });
    const id = created.body.campaign.id;
    const base = `/api/email/campaigns/${id}`;

    const contentErrors = [
      [{ ...draftBody, subject: 'ab' }, 'invalid_subject', true],
      [{ ...draftBody, title: 'x' }, 'invalid_title', true],
      [{ ...draftBody, bodyText: 'Za krótko' }, 'invalid_body', true],
      [{ ...draftBody, bodyText: `${BODY} Imię dziecka: {imie}.` }, 'invalid_placeholder', false],
      [{ ...draftBody, bodyText: `${BODY} To nie jest dług.` }, 'forbidden_wording', false],
      [{ ...draftBody, category: 'pilne' }, 'invalid_category', true],
      [{ ...draftBody, audience: 'wszyscy' }, 'invalid_audience', true],
    ];
    for (const [body, code, invalidRequest] of contentErrors) {
      const response = await client.call('POST', '/api/email/campaigns', { cookie: T, body, key: key('camp'), expect: 400, invalidRequest });
      assert.equal(response.body.error, code);
    }
    assert.equal((await client.call('POST', '/api/email/campaigns', { cookie: T, body: draftBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    assert.equal((await client.call('POST', '/api/email/campaigns', {
      cookie: T, headers: { 'Content-Type': 'application/json' }, body: '{"title":', key: key('camp'), expect: 400, invalidRequest: true,
    })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/email/campaigns', {
      cookie: T, body: { ...draftBody, bodyText: `${BODY} ${'x'.repeat(40000)}` }, key: key('camp'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', '/api/email/campaigns', { cookie: T, body: 'title=x', key: key('camp'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/email/campaigns', {
      cookie: cookies.boardGlobal, body: { ...draftBody, schoolYearId: 'y-brak' }, key: key('camp'), expect: 400,
    })).body.error, 'invalid_reference');
    await assertRequiredFieldsEnforced(client, T, 'POST', '/api/email/campaigns', draftBody, 'EmailCampaignCreateRequest', { withKey: true });

    // ---------- Edycja z wersją (#215) ----------
    const updateBody = { ...draftBody, title: 'Przypomnienie jesienne (poprawione)', revision: 1, sendNotBefore: '2026-11-02T08:00:00.000Z' };
    const updated = await client.call('PUT', base, { cookie: T, body: updateBody, expect: 200 });
    assert.deepEqual([updated.body.campaign.revisionNo, updated.body.campaign.sendNotBefore, updated.body.approvalInvalidated], [2, '2026-11-02T08:00:00.000Z', false]);
    const sameEdit = await client.call('PUT', base, { cookie: T, body: updateBody, expect: 200 });
    assert.equal(sameEdit.body.campaign.revisionNo, 2, 'podwójne kliknięcie tej samej edycji bez nowej wersji');
    assert.equal((await client.call('PUT', base, { cookie: T, body: { ...updateBody, title: 'Inna zmiana tytułu' }, expect: 409 })).body.error, 'revision_conflict');
    assert.equal((await client.call('PUT', base, { cookie: T, body: { ...updateBody, sendNotBefore: 'jutro rano' }, expect: 400, invalidRequest: true })).body.error, 'invalid_send_not_before');
    assert.equal((await client.call('PUT', base, { cookie: T, body: { ...updateBody, revision: 2, audience: 'class_households' }, expect: 400 })).body.error, 'invalid_audience');
    const cleared = await client.call('PUT', base, { cookie: T, body: { ...updateBody, revision: 2, sendNotBefore: null }, expect: 200 });
    assert.deepEqual([cleared.body.campaign.revisionNo, cleared.body.campaign.sendNotBefore], [3, null]);
    await assertRequiredFieldsEnforced(client, T, 'PUT', base, { ...updateBody, revision: 3, sendNotBefore: null }, 'EmailCampaignUpdateRequest');
    await client.call('PUT', '/api/email/campaigns/nie-ma-takiej', { cookie: T, body: updateBody, expect: 404 });

    // ---------- Odczyt szkicu i podgląd bez migawki ----------
    const draftStatus = await client.call('GET', base, { cookie: T, expect: 200 });
    assert.deepEqual([draftStatus.body.outbox, draftStatus.body.providerPause], [{}, null]);
    const emptyPreview = await client.call('GET', `${base}/preview`, { cookie: T, expect: 200 });
    assert.deepEqual([emptyPreview.body.snapshotCurrent, emptyPreview.body.recipientsHash, emptyPreview.body.sends], [null, null, false]);
    assert.equal((await client.call('GET', '/api/email/campaigns/nie-ma-takiej/preview', { cookie: T, expect: 404 })).body.error, 'campaign_not_found');
    assert.equal((await client.call('GET', `/api/email/campaigns/${'%20'.repeat(3)}`, { cookie: T, expect: 400 })).body.error, 'invalid_campaign_id');

    // ---------- Migawka odbiorców: jedna wiadomość na rodzinę, wykluczenia z powodem ----------
    const snapshot = await client.call('POST', `${base}/snapshot`, { cookie: T, expect: 200 });
    assert.equal(snapshot.body.recipientsCount, 4);
    assert.deepEqual(snapshot.body.exclusions, { duplicate_address: 1, no_valid_email: 1, suppressed: 1 });
    const preview = await client.call('GET', `${base}/preview`, { cookie: A, expect: 200 });
    assert.deepEqual([preview.body.snapshotCurrent, preview.body.recipientsCount, preview.body.sample.householdId], [true, 4, 'h1']);
    assert.match(preview.body.sample.recipient, /\*/, 'próbka ma adres maskowany');
    assert.ok(preview.body.warnings.includes('household_id_as_payment_reference'));
    // Lista odbiorców z kursorem: h1 raz (kontakt główny), bez drugiego opiekuna i bez h5 (ten sam adres co h2).
    const page1 = await client.call('GET', `${base}/recipients?limit=2`, { cookie: T, expect: 200 });
    assert.deepEqual([page1.body.recipients.length, page1.body.truncated, page1.body.limit], [2, true, 2]);
    const page2 = await client.call('GET', `${base}/recipients?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { cookie: T, expect: 200 });
    assert.deepEqual([page2.body.nextCursor, page2.body.truncated], [null, false]);
    const recipients = [...page1.body.recipients, ...page2.body.recipients];
    assert.deepEqual(recipients.map((row) => [row.householdId, row.guardianId]), [['h1', 'h1-g1'], ['h2', 'h2-g1'], ['h6', 'h6-g1'], ['h7', 'h7-g1']]);
    await client.call('GET', `${base}/recipients?limit=500`, { cookie: T, expect: 400 });
    await client.call('GET', `${base}/recipients?cursor=nie-kursor`, { cookie: T, expect: 400 });

    // ---------- Jawne zatwierdzenie treści i listy (zarząd, inna osoba, świeże MFA) ----------
    const approveBody = { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash };
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: T, body: approveBody, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: cookies.boardStale, body: approveBody, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: A, body: { ...approveBody, contentHash: HASH_F }, expect: 409 })).body.error, 'approval_stale');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: A, body: { contentHash: 'abc', recipientsHash: 'abc' }, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/approve`, approveBody, 'EmailApproveRequest');
    // Kolejka przed zatwierdzeniem nie powstaje.
    assert.equal((await client.call('POST', `${base}/queue`, { cookie: T, expect: 409 })).body.error, 'approval_required');
    const approved = await client.call('POST', `${base}/approve`, { cookie: A, body: approveBody, expect: 200 });
    assert.equal(approved.headers.get('Idempotency-Replayed'), null, 'pierwsze zatwierdzenie bez nagłówka ponowienia');
    assert.deepEqual([approved.body.campaign.status, approved.body.campaign.approvedBy], ['approved', 'u-board-a']);
    const approvedAgain = await client.call('POST', `${base}/approve`, { cookie: A, body: approveBody, expect: 200 });
    assert.equal(approvedAgain.headers.get('Idempotency-Replayed'), 'true');

    // ---------- Kolejka: klucz kampania + rodzina, ponowienie bez duplikatów ----------
    const queued = await client.call('POST', `${base}/queue`, { cookie: T, expect: 200 });
    assert.deepEqual([queued.body.queued, queued.body.campaign.status, queued.headers.get('Idempotency-Replayed')], [4, 'sending', null]);
    const queuedAgain = await client.call('POST', `${base}/queue`, { cookie: T, expect: 200 });
    assert.deepEqual([queuedAgain.body.queued, queuedAgain.headers.get('Idempotency-Replayed')], [0, 'true']);
    const { rows: keys } = await db.query('SELECT idempotency_key FROM email_outbox WHERE campaign_id = $1 ORDER BY idempotency_key', [id]);
    assert.deepEqual(keys.map((row) => row.idempotency_key), ['h1', 'h2', 'h6', 'h7'].map((h) => `campaign:${id}:household:${h}`));

    // Pauza i wznowienie (#130), każde z ponowieniem.
    const paused = await client.call('POST', `${base}/pause`, { cookie: T, expect: 200 });
    assert.deepEqual([paused.body.campaign.status, paused.headers.get('Idempotency-Replayed')], ['paused', null]);
    assert.equal((await client.call('POST', `${base}/pause`, { cookie: T, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `${base}/resume`, { cookie: T, expect: 200 })).body.campaign.status, 'sending');
    assert.equal((await client.call('POST', `${base}/resume`, { cookie: T, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');

    // Stan zadania przed pierwszym przebiegiem: kampania czeka → alarm.
    const neverRan = await client.call('GET', `/api/email/worker-status?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual([neverRan.body.workerStatus.lastRun, neverRan.body.workerStatus.alarms], [null, ['worker_never_ran']]);

    // ---------- Zadanie: odmowa konta dostawcy (401) = pauza, zdjęcie pauzy, wysyłka ----------
    const start = Date.now();
    const rejecting = fakeTransport(() => new EmailTransportError('provider_rejected_401', { accountLevel: true }));
    const run1 = await runEmailBatch(env, { transport: rejecting, dryRun: false, now: new Date(start) });
    assert.deepEqual([run1.stoppedReason, run1.sent, rejecting.calls.length], ['provider_account_rejected', 0, 1]);
    const pause = await client.call('GET', `/api/email/provider-pause?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual([pause.body.pause.reason, pause.body.pause.errorCode, pause.body.pause.liftedAt], ['account_rejected', 'provider_rejected_401', null]);
    const sendingStatus = await client.call('GET', base, { cookie: T, expect: 200 });
    assert.deepEqual([sendingStatus.body.outbox, sendingStatus.body.providerPause.id], [{ queued: 4 }, pause.body.pause.id]);
    const liftBody = { schoolYearId: YEAR, pauseId: pause.body.pause.id };
    assert.equal((await client.call('POST', '/api/email/provider-pause/lift', { cookie: T, body: liftBody, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', '/api/email/provider-pause/lift', { cookie: cookies.boardStale, body: liftBody, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', '/api/email/provider-pause/lift', { cookie: A, body: { ...liftBody, pauseId: 'zła pauza!' }, expect: 400, invalidRequest: true })).body.error, 'invalid_provider_pause_id');
    assert.equal((await client.call('POST', '/api/email/provider-pause/lift', { cookie: A, body: { ...liftBody, pauseId: 'brak-pauzy' }, expect: 404 })).body.error, 'provider_pause_not_found');
    await assertRequiredFieldsEnforced(client, A, 'POST', '/api/email/provider-pause/lift', liftBody, 'EmailProviderPauseLiftRequest');
    const lifted = await client.call('POST', '/api/email/provider-pause/lift', { cookie: A, body: liftBody, expect: 200 });
    assert.deepEqual([lifted.body.pause.liftedBy, lifted.headers.get('Idempotency-Replayed')], ['u-board-a', null]);
    assert.equal((await client.call('POST', '/api/email/provider-pause/lift', { cookie: A, body: liftBody, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('GET', `/api/email/provider-pause?schoolYearId=${YEAR}`, { cookie: T, expect: 200 })).body.pause, null);

    // Wysyłka: h6 — wynik niepewny (delivery_unknown), h7 — 400 dostawcy; reszta przyjęta.
    const transport = fakeTransport((message) => {
      if (message.to === 'h6-g1@example.invalid') return new EmailTransportError('delivery_unknown', { uncertain: true });
      if (message.to === 'h7-g1@example.invalid') return new EmailTransportError('provider_rejected_400');
      return null;
    });
    const run2 = await runEmailBatch(env, { transport, dryRun: false, now: new Date(start + 10 * 60_000) });
    assert.equal(run2.sent, 2, JSON.stringify(run2));
    // Ponowienie zadania: nic nie wychodzi drugi raz (klucz kampania + rodzina).
    await runEmailBatch(env, { transport, dryRun: false, now: new Date(start + 20 * 60_000) });
    assert.deepEqual(transport.calls.map((message) => message.to).sort(),
      ['h1-g1@example.invalid', 'h2-g1@example.invalid', 'h6-g1@example.invalid', 'h7-g1@example.invalid']);
    assert.deepEqual(transport.calls.map((message) => message.idempotencyKey).sort(), keys.map((row) => row.idempotency_key));
    const { rows: outbox } = await db.query('SELECT id, household_id, state, last_error, provider_message_id FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
    const row = Object.fromEntries(outbox.map((item) => [item.household_id, item]));
    assert.deepEqual(outbox.map((item) => [item.household_id, item.state]), [['h1', 'sent'], ['h2', 'sent'], ['h6', 'failed'], ['h7', 'failed']]);
    assert.deepEqual([row.h6.last_error, row.h7.last_error], ['delivery_unknown', 'provider_rejected_400']);

    const ran = await client.call('GET', `/api/email/worker-status?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.equal(ran.body.workerStatus.lastRun.mode, 'live');

    // Webhook: doręczenie wiadomości h1 dopasowane po identyfikatorze wiersza.
    await client.call('POST', '/api/email/webhooks/brevo', {
      headers: webhookHeaders, expect: 200,
      body: { event: 'delivered', email: 'h1-g1@example.invalid', 'message-id': row.h1.provider_message_id, 'X-Mailin-custom': row.h1.id, ts_event: 1791190800 },
    });

    // ---------- Raport, lista „do sprawdzenia”, rozstrzygnięcia (cztery oczy) ----------
    const report = await client.call('GET', `${base}/report`, { cookie: T, expect: 200 });
    assert.deepEqual([report.body.summary.delivered, report.body.summary.sent, report.body.summary.delivery_unknown, report.body.summary.failed],
      [1, 1, 1, 1]);
    assert.deepEqual(report.body.lastProviderEvent, { delivered: 1, none: 3 });
    const csv = await client.call('GET', `${base}/report?format=csv`, { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(csv.bytes), /summary;delivery_unknown_unresolved;1/);
    assert.equal((await client.call('GET', `${base}/report?format=pdf`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_format');
    const attention1 = await client.call('GET', `${base}/attention?limit=1`, { cookie: T, expect: 200 });
    const attention2 = await client.call('GET', `${base}/attention?limit=1&cursor=${encodeURIComponent(attention1.body.nextCursor)}`, { cookie: T, expect: 200 });
    const attentionRows = [...attention1.body.rows, ...attention2.body.rows];
    assert.deepEqual(attentionRows.map((item) => item.outboxId).sort(), [row.h6.id, row.h7.id].sort());
    assert.equal(attention2.body.nextCursor, null);
    assert.ok(attentionRows.length === 2 && attentionRows.every((item) => /\*/.test(item.email)), 'adres maskowany');

    const notSent = { outboxId: row.h6.id, resolution: 'confirmed_not_sent', evidenceCode: 'brevo_log_no_event' };
    assert.equal((await client.call('POST', `${base}/resolutions`, { cookie: T, body: notSent, expect: 403 })).body.error, 'forbidden');
    const resolved = await client.call('POST', `${base}/resolutions`, { cookie: A, body: notSent, expect: 201 });
    const resolvedAgain = await client.call('POST', `${base}/resolutions`, { cookie: A, body: notSent, expect: 200 });
    assert.deepEqual([resolvedAgain.body, resolvedAgain.headers.get('Idempotency-Replayed')], [resolved.body, 'true']);
    const delivered = await client.call('POST', `${base}/resolutions`, {
      cookie: T, body: { outboxId: row.h7.id, resolution: 'confirmed_delivered', evidenceCode: 'brevo_log_delivered' }, expect: 201,
    });
    assert.equal((await client.call('POST', `${base}/resolutions`, { cookie: A, body: { ...notSent, outboxId: row.h1.id }, expect: 409 })).body.error, 'not_resolvable');
    assert.equal((await client.call('POST', `${base}/resolutions`, { cookie: A, body: { ...notSent, outboxId: 'brak-wiersza' }, expect: 404 })).body.error, 'outbox_not_found');
    assert.equal((await client.call('POST', `${base}/resolutions`, { cookie: A, body: { ...notSent, evidenceCode: 'Wolny tekst' }, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/resolutions`, notSent, 'EmailResolutionRequest');

    const approvePath = (resolutionId) => `${base}/resolutions/${resolutionId}/approve`;
    const resolutionId = resolved.body.resolution.id;
    assert.equal((await client.call('POST', approvePath(resolutionId), { cookie: A, expect: 403 })).body.error, 'self_approval_forbidden');
    assert.equal((await client.call('POST', approvePath(resolutionId), { cookie: T, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', approvePath(resolutionId), { cookie: cookies.boardStale, expect: 403 })).body.error, 'mfa_stale');
    const resolutionApproved = await client.call('POST', approvePath(resolutionId), { cookie: B, expect: 201 });
    assert.equal(resolutionApproved.body.approval.approvedBy, 'u-board-b');
    assert.equal((await client.call('POST', approvePath(resolutionId), { cookie: B, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', approvePath(delivered.body.resolution.id), { cookie: B, expect: 409 })).body.error, 'resolution_not_approvable');
    assert.equal((await client.call('POST', approvePath('brak-rozstrzygniecia'), { cookie: B, expect: 404 })).body.error, 'outbox_resolution_not_found');
    const attentionAfter = await client.call('GET', `${base}/attention`, { cookie: T, expect: 200 });
    assert.deepEqual(attentionAfter.body.rows.map((item) => item.resolutionApproval).sort(), ['approved', null].sort());

    // ---------- Kampania uzupełniająca: tylko h6 (zatwierdzone „nie wyszła”) ----------
    const followupKey = key('fup');
    const followup = await client.call('POST', `${base}/followup`, { cookie: T, key: followupKey, expect: 201 });
    assert.deepEqual([followup.body.campaign.kind, followup.body.campaign.sourceCampaignId, followup.body.eligibleHouseholds], ['followup', id, 1]);
    const followupAgain = await client.call('POST', `${base}/followup`, { cookie: T, key: followupKey, expect: 200 });
    assert.equal(followupAgain.body.campaign.id, followup.body.campaign.id);
    assert.equal((await client.call('POST', `${base}/followup`, { cookie: A, key: followupKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', `${base}/followup`, { cookie: T, expect: 400 })).body.error, 'invalid_idempotency_key');
    const followupBase = `/api/email/campaigns/${followup.body.campaign.id}`;
    assert.equal((await client.call('POST', `${followupBase}/followup`, { cookie: T, key: key('fup'), expect: 409 })).body.error, 'followup_source_not_eligible');
    const followupSnapshot = await client.call('POST', `${followupBase}/snapshot`, { cookie: T, expect: 200 });
    assert.equal(followupSnapshot.body.recipientsCount, 1);
    assert.deepEqual((await client.call('GET', `${followupBase}/recipients`, { cookie: T, expect: 200 })).body.recipients.map((item) => item.householdId), ['h6']);
    // Kampania zakończona nie przyjmuje anulowania.
    assert.equal((await client.call('POST', `${base}/cancel`, { cookie: T, expect: 409 })).body.error, 'campaign_locked');

    // ---------- Druga kampania: autor nie zatwierdza sam, anulowanie, lista z kursorem ----------
    const second = await client.call('POST', '/api/email/campaigns', {
      cookie: B, key: key('camp'), expect: 201, body: { ...draftBody, title: 'Informacja organizacyjna', category: 'organizational' },
    });
    const secondBase = `/api/email/campaigns/${second.body.campaign.id}`;
    await client.call('POST', `${secondBase}/snapshot`, { cookie: B, expect: 200 });
    const secondPreview = await client.call('GET', `${secondBase}/preview`, { cookie: B, expect: 200 });
    assert.equal((await client.call('POST', `${secondBase}/approve`, {
      cookie: B, expect: 403, body: { contentHash: secondPreview.body.contentHash, recipientsHash: secondPreview.body.recipientsHash },
    })).body.error, 'self_approval_forbidden');
    assert.equal((await client.call('POST', `${secondBase}/resume`, { cookie: T, expect: 409 })).body.error, 'campaign_locked');
    const listPage1 = await client.call('GET', `/api/email/campaigns?schoolYearId=${YEAR}&limit=2`, { cookie: T, expect: 200 });
    assert.equal(listPage1.body.truncated, true);
    const listPage2 = await client.call('GET', `/api/email/campaigns?schoolYearId=${YEAR}&limit=2&cursor=${encodeURIComponent(listPage1.body.nextCursor)}`, { cookie: T, expect: 200 });
    assert.deepEqual([...listPage1.body.campaigns, ...listPage2.body.campaigns].map((item) => item.id).sort(),
      [id, followup.body.campaign.id, second.body.campaign.id].sort());
    await client.call('GET', `/api/email/campaigns?schoolYearId=${YEAR}&limit=0`, { cookie: T, expect: 400 });
    await client.call('GET', `/api/email/campaigns?schoolYearId=${YEAR}&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { cookie: T, expect: 400 });
    await client.call('GET', '/api/email/campaigns', { cookie: T, expect: 400 });

    // ---------- Wysyłka testowa: tylko adres techniczny Rady, atrapa transportu ----------
    const testKey = key('tst');
    const testSend = await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: testKey, body: { recipientEmail: PREVIEW_ADDRESS }, expect: 201 });
    assert.equal(testSend.body.sent, true);
    assert.equal((await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: testKey, body: { recipientEmail: PREVIEW_ADDRESS }, expect: 200 })).body.providerMessageId, testSend.body.providerMessageId);
    assert.equal(previewTransport.calls.length, 1, 'ponowienie z tym samym kluczem nie wysyła drugiej wiadomości');
    assert.match(previewTransport.calls[0].subject, /^\[TEST\] /);
    assert.equal((await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: key('tst'), body: { recipientEmail: 'h1-g1@example.invalid' }, expect: 403 })).body.error, 'preview_recipient_not_allowed');
    assert.equal((await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: key('tst'), body: { recipientEmail: 'to nie adres' }, expect: 400 })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, T, 'POST', `${secondBase}/test-send`, { recipientEmail: PREVIEW_ADDRESS }, 'EmailTestSendRequest', { withKey: true });
    const disabled = newClient({ ...env, EMAIL_SENDING_ENABLED: 'false' });
    assert.equal((await disabled.call('POST', `${secondBase}/test-send`, { cookie: T, key: key('tst'), body: { recipientEmail: PREVIEW_ADDRESS }, expect: 409 })).body.error, 'sending_disabled');
    for (let i = 0; i < 4; i += 1) {
      await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: key('tst'), body: { recipientEmail: PREVIEW_ADDRESS }, expect: 201 });
    }
    assert.equal((await client.call('POST', `${secondBase}/test-send`, { cookie: T, key: key('tst'), body: { recipientEmail: PREVIEW_ADDRESS }, expect: 429 })).body.error, 'preview_campaign_limit');
    assert.equal(previewTransport.calls.length, 5);
    assert.ok(previewTransport.calls.length === 5 && previewTransport.calls.every((message) => message.to === PREVIEW_ADDRESS), 'test wyłącznie na adres techniczny');

    // Anulowanie szkicu z ponowieniem; zmiany po anulowaniu są zablokowane.
    const cancelled = await client.call('POST', `${secondBase}/cancel`, { cookie: T, expect: 200 });
    assert.deepEqual([cancelled.body.campaign.status, cancelled.body.cancelledMessages, cancelled.body.inFlight], ['cancelled', 0, 0]);
    assert.equal((await client.call('POST', `${secondBase}/cancel`, { cookie: T, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `${secondBase}/pause`, { cookie: T, expect: 409 })).body.error, 'campaign_locked');
    assert.equal((await client.call('POST', `${secondBase}/snapshot`, { cookie: T, expect: 409 })).body.error, 'campaign_locked');
    assert.equal((await client.call('PUT', secondBase, { cookie: T, body: { ...draftBody, revision: 1 }, expect: 409 })).body.error, 'campaign_locked');
    assert.equal((await client.call('POST', `${secondBase}/followup`, { cookie: T, key: key('fup'), expect: 409 })).body.error, 'followup_no_households');

    // ---------- Lista wyłączeń i zdjęcie blokady (dwie osoby) ----------
    const suppressions1 = await client.call('GET', `/api/email/suppressions?schoolYearId=${YEAR}&limit=1`, { cookie: T, expect: 200 });
    const suppressions2 = await client.call('GET', `/api/email/suppressions?schoolYearId=${YEAR}&limit=1&cursor=${encodeURIComponent(suppressions1.body.nextCursor)}`, { cookie: T, expect: 200 });
    const suppressions = [...suppressions1.body.suppressions, ...suppressions2.body.suppressions];
    const h4 = suppressions.find((item) => item.reason === 'hard_bounce');
    const complaint = suppressions.find((item) => item.reason === 'complaint');
    assert.deepEqual([h4.emailHash, h4.guardianId, h4.householdId, complaint.guardianId], [emailHash('h4-g1@example.invalid'), 'h4-g1', 'h4', null]);
    await client.call('GET', `/api/email/suppressions?schoolYearId=${YEAR}&limit=501`, { cookie: T, expect: 400 });
    const releasePath = (hash, action) => `/api/email/suppressions/${hash}/${action}`;
    const requestBody = { schoolYearId: YEAR, releaseReason: 'address_corrected', confirmationNote: 'parent_email_reply' };
    const requested = await client.call('POST', releasePath(h4.emailHash, 'release-request'), { cookie: T, body: requestBody, expect: 201 });
    const requestedAgain = await client.call('POST', releasePath(h4.emailHash, 'release-request'), { cookie: T, body: requestBody, expect: 200 });
    assert.equal(requestedAgain.body.requestId, requested.body.requestId);
    assert.equal((await client.call('POST', releasePath(complaint.emailHash, 'release-request'), { cookie: T, body: requestBody, expect: 409 })).body.error, 'release_reason_not_allowed');
    assert.equal((await client.call('POST', releasePath(HASH_F, 'release-request'), { cookie: T, body: requestBody, expect: 404 })).body.error, 'suppression_not_active');
    assert.equal((await client.call('POST', releasePath(h4.emailHash, 'release-request'), { cookie: T, body: { ...requestBody, releaseReason: 'inny' }, expect: 400, invalidRequest: true })).body.error, 'invalid_release_reason');
    assert.equal((await client.call('POST', releasePath(h4.emailHash, 'release-request'), { cookie: T, body: { ...requestBody, confirmationNote: 'Rozmowa z mamą' }, expect: 400, invalidRequest: true })).body.error, 'invalid_confirmation_note');
    const pii = await client.call('POST', releasePath(h4.emailHash, 'release-request'), { cookie: A, body: { ...requestBody, confirmationNote: '0471234567' }, expect: 422 });
    assert.equal(pii.body.error, 'possible_personal_data');
    await assertRequiredFieldsEnforced(client, T, 'POST', releasePath(h4.emailHash, 'release-request'), requestBody, 'EmailSuppressionReleaseRequestBody');
    const releaseBody = { schoolYearId: YEAR, requestId: requested.body.requestId };
    assert.equal((await client.call('POST', releasePath(h4.emailHash, 'release'), { cookie: T, body: releaseBody, expect: 403 })).body.error, 'self_approval_forbidden');
    assert.equal((await client.call('POST', releasePath(h4.emailHash, 'release'), { cookie: A, body: { ...releaseBody, requestId: 'brak-wniosku' }, expect: 404 })).body.error, 'request_not_found');
    await assertRequiredFieldsEnforced(client, A, 'POST', releasePath(h4.emailHash, 'release'), releaseBody, 'EmailSuppressionReleaseBody');
    const released = await client.call('POST', releasePath(h4.emailHash, 'release'), { cookie: A, body: releaseBody, expect: 201 });
    assert.equal(typeof released.body.releaseId, 'string');
    assert.equal((await client.call('POST', releasePath(h4.emailHash, 'release'), { cookie: A, body: releaseBody, expect: 409 })).body.error, 'request_already_consumed');

    // ---------- Limit Brevo: stan i ewidencja wiadomości spoza kolejki z korektą ----------
    const quota = await client.call('GET', `/api/email/quota?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual([quota.body.quota.dailyLimit, quota.body.quota.queuedCampaigns], [300, { campaigns: 0, queuedMessages: 0 }]);
    const otherBody = { schoolYearId: YEAR, day: today(), count: 3, reasonCode: 'invitation' };
    const otherKey = key('oth');
    const other = await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: otherBody, key: otherKey, expect: 201 });
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: otherBody, key: otherKey, expect: 200 })).body.entry.id, other.body.entry.id);
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...otherBody, count: 4 }, key: otherKey, expect: 409 })).body.error, 'idempotency_conflict');
    const correctionBody = { schoolYearId: YEAR, day: today(), count: -1, reasonCode: 'correction', correctsId: other.body.entry.id };
    const correction = await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: correctionBody, key: key('oth'), expect: 201 });
    assert.deepEqual([correction.body.entry.count, correction.body.entry.correctsId], [-1, other.body.entry.id]);
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...correctionBody, count: -5 }, key: key('oth'), expect: 409 })).body.error, 'quota_correction_exceeds');
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...correctionBody, correctsId: 'brak-wpisu' }, key: key('oth'), expect: 404 })).body.error, 'quota_correction_target_not_found');
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...otherBody, reasonCode: 'inne' }, key: key('oth'), expect: 400, invalidRequest: true })).body.error, 'invalid_quota_reason');
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...otherBody, count: 0 }, key: key('oth'), expect: 400 })).body.error, 'invalid_quota_count');
    assert.equal((await client.call('POST', '/api/email/quota/other-sends', { cookie: T, body: { ...otherBody, day: '2020-01-01' }, key: key('oth'), expect: 400 })).body.error, 'invalid_quota_day');
    await assertRequiredFieldsEnforced(client, T, 'POST', '/api/email/quota/other-sends', otherBody, 'EmailQuotaOtherSendRequest', { withKey: true });
    const others1 = await client.call('GET', `/api/email/quota/other-sends?schoolYearId=${YEAR}&day=${today()}&limit=1`, { cookie: T, expect: 200 });
    const others2 = await client.call('GET', `/api/email/quota/other-sends?schoolYearId=${YEAR}&day=${today()}&limit=1&cursor=${encodeURIComponent(others1.body.nextCursor)}`, { cookie: T, expect: 200 });
    const entries = [...others1.body.entries, ...others2.body.entries];
    const original = entries.find((item) => item.id === other.body.entry.id);
    assert.deepEqual([entries.length, original.corrected, original.correctedCount, original.correctableCount], [2, true, 1, 2]);
    await client.call('GET', `/api/email/quota/other-sends?schoolYearId=${YEAR}&day=2026-02-30`, { cookie: T, expect: 400, invalidRequest: true });

    // ---------- Wypisanie jednym kliknięciem (publiczne, token HMAC) ----------
    const token = encodeURIComponent(preferencesToken(UNSUBSCRIBE_SECRET, {
      campaignId: id, category: 'contribution_reminder', emailHash: emailHash('h2-g1@example.invalid'),
    }));
    const shown = await client.call('GET', `/api/email/preferences?t=${token}`, { expect: 200 });
    assert.deepEqual(shown.body, { category: 'contribution_reminder', action: 'opt_out' });
    const optedOut = await client.call('POST', `/api/email/preferences?t=${token}`, { origin: false, expect: 200 });
    assert.deepEqual(optedOut.body, { category: 'contribution_reminder', optedOut: true });
    await client.call('POST', `/api/email/preferences?t=${token}`, { origin: 'https://poczta.example.invalid', expect: 200 });
    const { rows: [{ n: preferenceEvents }] } = await db.query('SELECT COUNT(*)::int AS n FROM email_preferences_events');
    assert.equal(preferenceEvents, 1, 'drugie kliknięcie bez drugiego zdarzenia');
    assert.equal((await client.call('GET', `/api/email/preferences?t=${token}x`, { expect: 400 })).body.error, 'invalid_token');
    assert.equal((await client.call('POST', '/api/email/preferences?t=zly.token', { expect: 400 })).body.error, 'invalid_token');
    const limited = newClient({ ...env, EMAIL_PREFERENCES_RATE_LIMIT: '1' });
    const clientIp = { 'x-forwarded-for': '203.0.113.77' };
    await limited.call('GET', `/api/email/preferences?t=${token}`, { headers: clientIp, expect: 200 });
    assert.equal((await limited.call('GET', `/api/email/preferences?t=${token}`, { headers: clientIp, expect: 429 })).body.error, 'rate_limited');
    assert.equal((await limited.call('POST', `/api/email/preferences?t=${token}`, { headers: clientIp, expect: 429 })).body.error, 'rate_limited');

    // ---------- Granice ról ----------
    const reads = [
      `/api/email/campaigns?schoolYearId=${YEAR}`, base, `${base}/preview`, `${base}/recipients`, `${base}/report`, `${base}/attention`,
      `/api/email/suppressions?schoolYearId=${YEAR}`, `/api/email/provider-pause?schoolYearId=${YEAR}`,
      `/api/email/worker-status?schoolYearId=${YEAR}`, `/api/email/quota?schoolYearId=${YEAR}`,
      `/api/email/quota/other-sends?schoolYearId=${YEAR}`,
    ];
    for (const path of reads) {
      await client.call('GET', path, { expect: 401 });
      // Przedstawiciel klasy (poza zakresem kampanii całej szkoły), zarząd z przydziałem klasy i Komisja Rewizyjna.
      for (const cookie of [cookies.rep, cookies.boardClass, cookies.audit]) {
        assert.equal((await client.call('GET', path, { cookie, expect: 403 })).body.error, 'forbidden', path);
      }
      assert.equal((await client.call('GET', path, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', path);
    }
    const writes = [
      ['POST', '/api/email/campaigns', draftBody, true],
      ['POST', `${base}/approve`, approveBody, false],
      ['POST', `${base}/snapshot`, undefined, false],
      ['POST', `/api/email/quota/other-sends`, otherBody, true],
      ['POST', releasePath(complaint.emailHash, 'release-request'), { ...requestBody, releaseReason: 'parent_request' }, false],
    ];
    for (const [method, path, body, keyed] of writes) {
      const withKey = () => (keyed ? key('deny') : undefined);
      await client.call(method, path, { body, key: withKey(), expect: 401 });
      for (const cookie of [cookies.rep, cookies.boardClass, cookies.audit]) {
        assert.equal((await client.call(method, path, { cookie, body, key: withKey(), expect: 403 })).body.error, 'forbidden', path);
      }
      assert.equal((await client.call(method, path, { cookie: A, body, key: withKey(), expect: 403, origin: 'https://obcy.example.invalid' })).body.error, 'invalid_origin', path);
    }

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(client);
  } finally {
    await db.close();
  }
});
