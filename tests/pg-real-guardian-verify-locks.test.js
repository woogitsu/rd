// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): test z barierą na PRAWDZIWYM
// PostgreSQL dla blokady wiersza weryfikacji w confirmCode (src/pg/routes/guardian-updates.js,
// publiczne potwierdzenie kodu na nowy adres z wniosku rodzica, #140 pkt 5).
//
// Limit prób (VERIFY_MAX_FAILED_ATTEMPTS) sprawdza kod aplikacji po odczycie wiersza. Bez
// blokady dwie równoległe próby czytają ten sam licznik: dwie błędne przy 4 próbach kończą się
// na CHECK failed_attempts ≤ 5 (0184) błędem zamiast odmowy, a — co ważniejsze — poprawny kod
// wpisany równolegle z piątą błędną próbą zostaje przyjęty, choć limit właśnie się wyczerpał
// (wyzwalacz 0184 nie wiąże potwierdzenia z licznikiem). Test pokazuje ten drugi skutek.
//
// Schemat jak w pg-real-record-locks (tests/helpers/pg-race.js): pierwsze żądanie staje W
// TRANSAKCJI, drugie startuje osobnym połączeniem i musi czekać w bazie na zapytanie z
// blokadą z kodu (`pg_stat_activity`); dopiero potem pierwsze zatwierdza.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid). Kod wysyła worker z atrapą transportu —
// nic nie wychodzi do sieci (pułapka sieci liczy próby, licznik musi być 0).
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutant guardian-verify-confirm).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emailConfig } from '../src/email/brevo.js';
import { VERIFY_MAX_FAILED_ATTEMPTS, verifyTemplateHash } from '../src/email/guardian-verify.js';
import { runEmailBatch } from '../src/email/worker.js';
import { networkGuardCalls, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const FLAG = { GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
const WORKER_ENV = {
  APP_ENV: 'test', EMAIL_SENDING_ENABLED: 'true', BREVO_FROM_EMAIL: 'rada@rada.example.invalid',
  EMAIL_TEST_ALLOWLIST: '*@example.invalid', ...FLAG,
};
const TEMPLATE = {
  subject: 'Potwierdzenie adresu e-mail dla Rady Rodziców',
  bodyText: 'Twój kod potwierdzający nowy adres to {kod}. Kod jest ważny {waznosc} godzin. Jeśli to nie Ty, zignoruj tę wiadomość.',
};
const VERIFY = '/api/public/guardian-update/verify';

// Opiekun g-1 z wnioskiem o nowy adres i wysłanym kodem (szablon zatwierdzony przez dwie
// osoby, opublikowana informacja o przetwarzaniu, przebieg workera z atrapą transportu).
// Zwraca token linku, poprawny kod i identyfikator wniosku.
async function sentCode(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedPublishedPrivacyNotice(db);
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'stary@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-1', 'g-1', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 's-1', 'c-1a', '${YEAR}');
  `);
  await seedUser(db, { userId: 'u-board-1' });
  await seedUser(db, { userId: 'u-board-2' });
  await db.query(
    `INSERT INTO guardian_verify_templates (id, subject, body_text, content_hash, status, created_by, approved_by, approved_at)
     VALUES ('tpl-1', $1, $2, $3, 'approved', 'u-board-1', 'u-board-2', now())`,
    [TEMPLATE.subject, TEMPLATE.bodyText, verifyTemplateHash(TEMPLATE)],
  );
  const admin = await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] });
  const env = { db, ...FLAG };
  const link = await callApi(env, 'POST', '/api/admin/guardian-links', admin, { guardianId: 'g-1' });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const submitted = await callApi(env, 'POST', '/api/public/guardian-update', null, { token: link.body.token, email: 'nowy@example.invalid' });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.emailVerification, 'requested');
  const sent = [];
  const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-verify-${sent.length}` }; } };
  await runEmailBatch(env, { transport, dryRun: false, now: new Date(), config: emailConfig(WORKER_ENV) });
  assert.equal(sent.length, 1, 'jedna wiadomość z kodem');
  const code = /\b(\d{8})\b/.exec(sent[0].text)?.[1];
  assert.ok(code, 'wiadomość zawiera kod');
  return { token: link.body.token, code, requestId: submitted.body.requestId };
}

const otherCode = (code) => String((Number(code) + 1) % 1e8).padStart(8, '0');

test('#208 (bariera, rodziny): poprawny kod wpisany razem z ostatnią dozwoloną błędną próbą — czeka na blokadę weryfikacji i jest odrzucony; limit prób nie do obejścia', { skip }, async () => {
  await withReal(async (db) => {
    const { token, code, requestId } = await sentCode(db);
    const wrong = { token, code: otherCode(code) };
    for (let i = 1; i < VERIFY_MAX_FAILED_ATTEMPTS; i += 1) {
      const failed = await callApi({ db }, 'POST', VERIFY, null, wrong);
      assert.deepEqual([failed.status, failed.body.error], [400, 'invalid_or_expired_code']);
    }
    const r = await race(db, {
      pauseAfter: /UPDATE guardian_update_verifications SET failed_attempts/,
      first: (env) => callApi(env, 'POST', VERIFY, null, wrong),
      second: (env) => callApi(env, 'POST', VERIFY, null, { token, code }),
    });
    assertWaitsOn(r, /^SELECT v\.id, v\.request_id, v\.code_salt/, 'poprawny kod czeka na blokadę wiersza weryfikacji');
    assert.deepEqual([r.a.status, r.a.body.error], [400, 'invalid_or_expired_code']);
    // Bez blokady poprawny kod czyta licznik 4 (sprzed piątej błędnej próby), przechodzi
    // sprawdzenie limitu, a jego UPDATE confirmed_at czeka tylko na zapis licznika i po nim
    // potwierdza adres (200) mimo wyczerpanego limitu.
    assert.deepEqual([r.b.status, r.b.body.error], [400, 'invalid_or_expired_code']);
    const { rows } = await db.query('SELECT failed_attempts, confirmed_at FROM guardian_update_verifications WHERE request_id = $1', [requestId]);
    assert.deepEqual([rows[0].failed_attempts, rows[0].confirmed_at], [VERIFY_MAX_FAILED_ATTEMPTS, null]);
    assert.equal(await auditCount(db, 'guardian_update_request.verification_confirmed'), 0);
    assert.equal(await auditCount(db, 'guardian_update_request.verification_attempt_failed'), VERIFY_MAX_FAILED_ATTEMPTS);
    // Po wyczerpaniu limitu poprawny kod nadal nie działa.
    const later = await callApi({ db }, 'POST', VERIFY, null, { token, code });
    assert.deepEqual([later.status, later.body.error], [400, 'invalid_or_expired_code']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM guardian_update_verifications WHERE confirmed_at IS NOT NULL'), 0);
    assert.equal(networkGuardCalls(), 0);
  });
});
