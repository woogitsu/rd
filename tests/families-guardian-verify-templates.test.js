// Ekran „Szablon wiadomości z kodem weryfikacyjnym” (#140 pkt 5) w panelu Rodziny: czyste funkcje
// families/guardian-verify-templates-core.js, okablowanie widoku oraz zgodność z prawdziwym API
// (PGlite). Dane wyłącznie syntetyczne (@example.invalid). Żadna wiadomość nie wychodzi: ani
// szablon, ani zatwierdzenie nie uruchamiają workera, a transport Brevo odmawia pod `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePgRequest } from '../src/pg/app.js';
import { VERIFY_BODY_PLACEHOLDERS } from '../src/email/guardian-verify.js';
import { ApiError } from '../shared/api.js';
import { ERROR_MESSAGES, parseRoute } from '../families/core.js';
import {
  BODY_MAX, BODY_MIN, BODY_PLACEHOLDERS, SUBJECT_MAX, SUBJECT_MIN, TEMPLATES_URL, TEMPLATE_MESSAGES,
  approveBody, approveConfirmation, approveResultMessage, approveUrl, createResultMessage, emptyText, failureText,
  statusSummary, toRow, toRows, validateDraft,
} from '../families/guardian-verify-templates-core.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const Y = 'y-2026';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const DRAFT = {
  subject: 'Potwierdzenie adresu e-mail dla Rady Rodziców',
  bodyText: 'Twój kod potwierdzający nowy adres to {kod}. Kod jest ważny {waznosc} godzin. Jeśli to nie Ty, zignoruj tę wiadomość.',
};

async function call(env, path, { cookie, method, body } = {}) {
  const response = await handlePgRequest(request(path, { cookie, method: method ?? (body ? 'POST' : 'GET'), body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, Y);
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const author = await seedUserSession(db, { userId: 'u-board-author', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  const approver = await seedUserSession(db, { userId: 'u-board-approver', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  return { db, env: { db, ...extraEnv }, cookies: { admin, author, approver } };
}

test('trasa i adresy: widok szablonu ma własną trasę, identyfikator jest walidowany i kodowany', () => {
  assert.deepEqual(parseRoute('#/guardian-verify-templates'), { view: 'guardianVerifyTemplates' });
  assert.deepEqual(parseRoute('#/guardian-updates'), { view: 'guardianUpdates' });
  assert.equal(TEMPLATES_URL, '/api/admin/guardian-verify-templates');
  assert.equal(approveUrl('tpl-1'), '/api/admin/guardian-verify-templates/tpl-1/approve');
  assert.throws(() => approveUrl('../x'));
  assert.throws(() => approveUrl(''));
});

test('znaczniki i granice w widoku są takie same jak w API (nie rozjeżdżają się po cichu)', () => {
  assert.deepEqual([...BODY_PLACEHOLDERS], [...VERIFY_BODY_PLACEHOLDERS]);
  assert.deepEqual([SUBJECT_MIN, SUBJECT_MAX, BODY_MIN, BODY_MAX], [3, 200, 20, 4000]);
  const migration = read('postgres/migrations/0184_guardian_update_verification.sql');
  assert.match(migration, /length\(btrim\(subject\)\) BETWEEN 3 AND 200/);
  assert.match(migration, /length\(btrim\(body_text\)\) BETWEEN 20 AND 4000/);
});

test('szkic: {kod} tylko w treści, inne znaczniki i klamry odrzucone, granice długości', () => {
  assert.deepEqual(validateDraft(DRAFT), { payload: { subject: DRAFT.subject, bodyText: DRAFT.bodyText } });
  assert.deepEqual(validateDraft({ subject: `  ${DRAFT.subject}  `, bodyText: `${DRAFT.bodyText}\r\n` }).payload.subject, DRAFT.subject);
  const bodyOnlyCode = 'Twój kod to {kod}, wpisz go na stronie.';
  assert.ok(validateDraft({ subject: 'Kod adresu', bodyText: bodyOnlyCode }).payload, '{waznosc} jest opcjonalne');
  const rejected = [
    [{ subject: 'Kod {kod}', bodyText: DRAFT.bodyText }, 'subject'],
    [{ subject: 'ab', bodyText: DRAFT.bodyText }, 'subject'],
    [{ subject: 'x'.repeat(201), bodyText: DRAFT.bodyText }, 'subject'],
    [{ subject: 'Dwie\nlinie', bodyText: DRAFT.bodyText }, 'subject'],
    [{ subject: DRAFT.subject, bodyText: 'Treść bez znacznika kodu, ale długa.' }, 'bodyText'],
    [{ subject: DRAFT.subject, bodyText: `${DRAFT.bodyText} {imie}` }, 'bodyText'],
    [{ subject: DRAFT.subject, bodyText: `${DRAFT.bodyText} {` }, 'bodyText'],
    [{ subject: DRAFT.subject, bodyText: 'Za krótko {kod}' }, 'bodyText'],
    [{ subject: DRAFT.subject, bodyText: `${'x'.repeat(4000)} {kod}` }, 'bodyText'],
    [{}, 'subject'],
  ];
  for (const [input, field] of rejected) {
    const result = validateDraft(input);
    assert.equal(result.field, field, JSON.stringify(input).slice(0, 60));
    assert.ok(result.error.length > 10);
    assert.equal(result.payload, undefined);
  }
});

test('wiersze: obowiązuje tylko wskazana wersja, szkic można zatwierdzić, zatwierdzona jest zamknięta', () => {
  const data = {
    enabled: false,
    currentTemplateId: 't-2',
    templates: [
      { id: 't-3', version: 3, subject: 'Temat 3', bodyText: 'Treść 3 {kod}', contentHash: 'a'.repeat(64), status: 'draft', createdBy: 'u-board-author-0001', createdAt: '2026-10-02T09:00:00Z', approvedBy: null, approvedAt: null },
      { id: 't-2', version: 2, subject: 'Temat 2', bodyText: 'Treść 2 {kod}', contentHash: 'b'.repeat(64), status: 'approved', createdBy: 'u1', createdAt: '2026-10-01T09:00:00Z', approvedBy: 'u2', approvedAt: '2026-10-01T10:00:00Z' },
      { id: 't-1', version: 1, subject: 'Temat 1', bodyText: 'Treść 1 {kod}', contentHash: 'c'.repeat(64), status: 'approved', createdBy: 'u1', createdAt: '2026-09-30T09:00:00Z', approvedBy: 'u2', approvedAt: '2026-09-30T10:00:00Z' },
    ],
  };
  const rows = toRows(data);
  assert.deepEqual(rows.map((row) => [row.version, row.statusLabel, row.current, row.canApprove]), [
    [3, 'Szkic', false, true], [2, 'Zatwierdzony', true, false], [1, 'Zatwierdzony', false, false],
  ]);
  assert.equal(rows[0].author, 'u-board-…');
  assert.equal(rows[0].hashShort, 'aaaaaaaa');
  assert.equal(rows[0].approver, '—');
  assert.equal(rows[1].approver, 'u2');
  assert.equal(rows[1].approvedAt, '01.10.2026 12:00', 'czas Europe/Brussels');
  const summary = statusSummary(data);
  assert.match(summary, /Obowiązuje wersja 2/);
  assert.match(summary, /wyłączona w konfiguracji serwera/);
  assert.match(statusSummary({ ...data, enabled: true }), /włączona w konfiguracji serwera/);
  assert.match(statusSummary({ templates: [], currentTemplateId: null, enabled: true }), /Brak zatwierdzonego szablonu — kod weryfikacyjny nie jest zlecany/);
  assert.match(emptyText({ templates: [] }), /Brak wersji szablonu/);
  assert.equal(emptyText(data), '');
  assert.equal(emptyText(null), '');
  assert.deepEqual(approveBody(rows[0]), { contentHash: 'a'.repeat(64) });
  assert.deepEqual(approveBody(toRow({ id: 'x', status: 'draft' })), {});
  assert.match(approveConfirmation(rows[0]), /niezmienne/);
  assert.match(approveConfirmation(rows[0]), /wyłącznie na adres z wniosku/);
  assert.match(approveResultMessage({ template: { status: 'approved', version: 3 } }, 3), /Wersja 3 została zatwierdzona/);
  assert.match(createResultMessage({ template: { version: 4 } }), /wersję 4.*inną osobę z zarządu/);
  assert.deepEqual(toRows(null), []);
  assert.deepEqual(toRows({ templates: 'x' }), []);
});

test('komunikaty odmów: self_approval_forbidden, mfa_stale i forbidden mają własny tekst, a klient rodzin nie przesłania go', () => {
  for (const [code, status, pattern] of [
    ['self_approval_forbidden', 403, /inna osoba z zarządu niż autor/],
    ['mfa_stale', 403, /15 minut/],
    ['forbidden', 403, /zatwierdza wyłącznie zarząd/],
    ['verify_template_changed', 409, /Odśwież widok/],
    ['verify_template_not_draft', 409, /niezmienna/],
    ['verify_code_placeholder_required', 400, /\{kod\}/],
  ]) {
    // `messages: ERROR_MESSAGES` — tak wołają API panele rodzin (families/main.js).
    const error = new ApiError({ status, code, messages: ERROR_MESSAGES });
    assert.match(failureText(error), pattern, code);
  }
  assert.match(failureText({ code: 'cokolwiek', message: 'Tekst klienta' }), /Tekst klienta/);
  assert.match(failureText({ status: 500 }), /\S/);
  assertEvery(Object.values(TEMPLATE_MESSAGES), (text) => text.length > 20 && !/[a-z]+_[a-z_]+/.test(text.replace(/\{[a-z]+\}|GUARDIAN_VERIFY_EMAIL_ENABLED/g, '')), 'bez surowych kodów w tekście');
});

test('widok korzysta z odpowiedzi prawdziwego API: szkic, zatwierdzenie przez inną osobę, odmowy', async () => {
  const ctx = await setup({ GUARDIAN_VERIFY_EMAIL_ENABLED: 'false' });
  try {
    const empty = await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.author });
    assert.equal(empty.status, 200);
    assert.match(statusSummary(empty.data), /Brak zatwierdzonego szablonu/);
    assert.match(statusSummary(empty.data), /wyłączona w konfiguracji/);
    assert.match(emptyText(empty.data), /Brak wersji/);

    const draft = validateDraft(DRAFT).payload;
    const created = await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.author, body: draft });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.match(createResultMessage(created.data), /Zapisano szkic jako wersję \d+/);

    const list = await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.approver });
    const [row] = toRows(list.data);
    assert.equal(row.status, 'draft');
    assert.equal(row.canApprove, true);
    assert.equal(row.subject, DRAFT.subject);
    assert.equal(row.contentHash.length, 64);
    const path = approveUrl(row.id);

    const own = await call(ctx.env, path, { cookie: ctx.cookies.author, body: approveBody(row) });
    assert.equal(own.status, 403);
    assert.equal(own.data.error, 'self_approval_forbidden');
    assert.match(failureText(new ApiError({ status: own.status, code: own.data.error, messages: ERROR_MESSAGES })), /inna osoba/);

    const byAdmin = await call(ctx.env, path, { cookie: ctx.cookies.admin, body: approveBody(row) });
    assert.deepEqual([byAdmin.status, byAdmin.data.error], [403, 'forbidden']);

    await ctx.db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-approver'");
    const stale = await call(ctx.env, path, { cookie: ctx.cookies.approver, body: approveBody(row) });
    assert.deepEqual([stale.status, stale.data.error], [403, 'mfa_stale']);
    assert.match(failureText(new ApiError({ status: stale.status, code: stale.data.error, messages: ERROR_MESSAGES })), /świeżego potwierdzenia/);
    assert.equal((await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.approver })).data.currentTemplateId, null, 'odmowy nic nie zatwierdziły');

    await ctx.db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-board-approver'");
    const wrongHash = await call(ctx.env, path, { cookie: ctx.cookies.approver, body: { contentHash: 'f'.repeat(64) } });
    assert.deepEqual([wrongHash.status, wrongHash.data.error], [409, 'verify_template_changed']);
    const approved = await call(ctx.env, path, { cookie: ctx.cookies.approver, body: approveBody(row) });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.match(approveResultMessage(approved.data, row.version), /została zatwierdzona/);
    // Podwójne kliknięcie tej samej osoby: ten sam wynik.
    assert.equal((await call(ctx.env, path, { cookie: ctx.cookies.approver, body: approveBody(row) })).status, 200);
    const again = await call(ctx.env, path, { cookie: ctx.cookies.author, body: approveBody(row) });
    assert.deepEqual([again.status, again.data.error], [409, 'verify_template_not_draft']);

    const after = toRows((await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.approver })).data);
    assert.deepEqual(after.map((item) => [item.status, item.current, item.canApprove]), [['approved', true, false]]);
    assert.equal(after[0].approver, 'u-board-…', 'skrócony identyfikator zatwierdzającego');

    // Ten sam zestaw reguł co w widoku: treści odrzucone po stronie przeglądarki odrzuca też serwer.
    for (const bad of [
      { subject: 'Kod {kod}', bodyText: DRAFT.bodyText },
      { subject: DRAFT.subject, bodyText: 'Treść bez znacznika kodu, ale długa.' },
      { subject: DRAFT.subject, bodyText: `${DRAFT.bodyText} {imie}` },
      { subject: 'x'.repeat(201), bodyText: DRAFT.bodyText },
      { subject: DRAFT.subject, bodyText: `${'x'.repeat(4000)} {kod}` },
    ]) {
      assert.ok(validateDraft(bad).error, 'przeglądarka odrzuca');
      assert.equal((await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.author, body: bad })).status, 400, 'serwer odrzuca');
    }
    // Granice dozwolone w przeglądarce przyjmuje też serwer.
    for (const ok of [
      { subject: 'x'.repeat(200), bodyText: DRAFT.bodyText },
      { subject: 'abc', bodyText: `${'x'.repeat(4000 - 6)} {kod}` },
    ]) {
      assert.ok(validateDraft(ok).payload, 'przeglądarka przyjmuje');
      assert.equal((await call(ctx.env, TEMPLATES_URL, { cookie: ctx.cookies.author, body: validateDraft(ok).payload })).status, 201, 'serwer przyjmuje');
    }
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM guardian_update_verifications");
    assert.equal(rows[0].n, 0, 'szablon i zatwierdzenie niczego nie zlecają ani nie wysyłają');
  } finally {
    await ctx.db.close();
  }
});

test('okablowanie widoku: sekcja, okno z nazwą, kontrolki z etykietami, żądania tylko przez wspólny klient', () => {
  const html = read('families/index.html');
  assert.match(html, /id="guardian-verify-templates-view"/);
  assert.match(html, /<dialog id="vt-dialog" aria-labelledby="vt-dialog-title">/);
  assert.match(html, /<label for="vt-subject">/);
  assert.match(html, /<label for="vt-bodytext">/);
  assert.match(html, /id="vt-form-error" role="alert"/);
  assert.match(html, /href="#\/guardian-verify-templates"/);
  const main = read('families/main.js');
  assert.match(main, /guardianVerifyTemplates: byId\("guardian-verify-templates-view"\)/);
  assert.match(main, /renderGuardianVerifyTemplates\(\{ api, showView, setBreadcrumbs, showMessage \}\)/);
  const view = read('families/guardian-verify-templates.js');
  assert.doesNotMatch(view, /\bfetch\s*\(|innerHTML|localStorage|sessionStorage/);
  assert.match(view, /deps\.api\(approveUrl\(id\)/);
  // Podwójne kliknięcie: jedno zatwierdzenie na wersję naraz i jeden zapis szkicu naraz.
  assert.match(view, /state\.approving\.has\(id\)/);
  assert.match(view, /if \(state\.saving\) return;/);
});
