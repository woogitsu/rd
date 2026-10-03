// Kontrola mutacyjna blokad (#208, punkt 4): dla każdej blokady z listy
// MUTANTS usuwa ją z kopii kodu (FOR UPDATE albo pg_advisory_xact_lock w jednej
// funkcji) i uruchamia wskazany test na PRAWDZIWYM PostgreSQL. Mutant musi dać
// czerwony test — inaczej blokada nie ma testu, który wykryje jej usunięcie.
//
//   npm run test:pg-mutations                 wszystkie mutanty
//   npm run test:pg-mutations -- --list       tylko lista (bez uruchamiania)
//   npm run test:pg-mutations -- admin-last   wybrane (po id)
//   npm run test:pg-mutations -- --shard=2/3  część 2 z 3 (CI: job test-pg-mutations;
//                                             podział: scripts/lock-mutation-shards.js)
//
// Kod repozytorium NIE jest zmieniany: skrypt kopiuje potrzebne katalogi do
// katalogu tymczasowego, tam podmienia jeden plik, uruchamia
// `scripts/test-pg-real.js` (własny serwer albo RD_TEST_PG_URL) i przywraca
// plik przed kolejnym mutantem. Najpierw przebieg bez mutacji (każdy plik
// testowy musi być zielony), potem mutanty. Wyłącznie dane syntetyczne.
//
// Blokady wierszy spoza listy mają wpis w LOCK_EXCEPTIONS (scripts/lock-inventory.js)
// z uzasadnieniem; tests/lock-inventory.test.js pilnuje, żeby każda blokada wiersza
// w src/pg miała mutant albo wyjątek (tabela pokrycia: docs/TESTING.md,
// „Inwentaryzacja blokad wierszy”).
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_KINDS, scanSource } from './lock-inventory.js';
import { parseShard, shardMutants } from './lock-mutation-shards.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const DOUBLE_CLICK = 'tests/pg-real-double-click.test.js';
const PAYMENT_LOCKS = 'tests/pg-real-payment-locks.test.js';
const CONCURRENCY = 'tests/pg-real-concurrency.test.js';
const DOMAIN = 'tests/pg-real-domain-locks.test.js';
const YEAR_CLOSE = 'tests/pg-year-close-race.test.js';
const COST_CENTERS = 'tests/pg-real-cost-center-locks.test.js';
const BUDGET_LOCKS = 'tests/pg-real-budget-locks.test.js';
const RECORD_LOCKS = 'tests/pg-real-record-locks.test.js';
const REPLAY_23505 = 'tests/pg-real-replay-23505.test.js';
const REQUEST_LOCKS = 'tests/pg-real-request-locks.test.js';
const DISABLE_SESSION = 'tests/pg-disable-session-race.test.js';
const AUTH_LOCKS = 'tests/pg-real-auth-locks.test.js';
const EMAIL_LOCKS = 'tests/pg-real-email-locks.test.js';
const MFA_LOCKS = 'tests/pg-real-mfa-locks.test.js';
const GUARDIAN_VERIFY_LOCKS = 'tests/pg-real-guardian-verify-locks.test.js';
const WEBHOOK_LOCKS = 'tests/pg-real-webhook-locks.test.js';

// kind: 'for-update' usuwa każde `FOR UPDATE [OF x]` w kodzie funkcji `fn`
// (komentarze pomija skaner z scripts/lock-inventory.js), 'for-share' — każde
// `FOR SHARE [OF x]`; opcjonalne `table` zawęża mutant do blokady wierszy tej
// tabeli (funkcja z kilkoma blokadami: osobny mutant na każdą, wymaga tego
// tests/lock-inventory.test.js); 'advisory' zamienia `pg_advisory_xact_lock(` na
// `(` (zapytanie zostaje poprawne i ma te same parametry, ale niczego nie blokuje).
export const MUTANTS = [
  { id: 'payments-correction', file: 'src/pg/routes/payments.js', fn: 'createCorrection', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'payments-assign', file: 'src/pg/routes/payments.js', fn: 'assignPayment', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'ledger-correction', file: 'src/pg/routes/ledger.js', fn: 'createCorrection', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'ledger-payment-link', file: 'src/pg/routes/ledger.js', fn: 'createEntry', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'reconciliation-lock', file: 'src/pg/routes/reconciliation.js', fn: 'loadReconciliation', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'email-campaign-lock', file: 'src/pg/routes/email.js', fn: 'loadCampaign', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'admin-last', file: 'src/pg/routes/admin.js', fn: 'lockGrantChanges', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'invitation-pending', file: 'src/pg/auth.js', fn: 'insertInvitation', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'invitation-reissue', file: 'src/pg/auth.js', fn: 'reissueInvitation', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'import-commit', file: 'src/pg/routes/import.js', fn: 'commit', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'payments-refund', file: 'src/pg/routes/payments.js', fn: 'createRefund', kind: 'for-update', test: PAYMENT_LOCKS },
  { id: 'payments-reassign', file: 'src/pg/routes/payments.js', fn: 'reassignPayment', kind: 'for-update', test: PAYMENT_LOCKS },
  { id: 'payments-allocation', file: 'src/pg/routes/payments.js', fn: 'createAllocation', kind: 'for-update', test: PAYMENT_LOCKS },
  { id: 'payments-allocation-reversal', file: 'src/pg/routes/payments.js', fn: 'reverseAllocation', kind: 'for-update', test: PAYMENT_LOCKS },
  { id: 'ledger-transfer-reversal', file: 'src/pg/routes/ledger-cash.js', fn: 'createTransfer', kind: 'for-update', test: PAYMENT_LOCKS },
  { id: 'ledger-replacement', file: 'src/pg/routes/ledger.js', fn: 'createReplacement', kind: 'for-update', table: 'ledger_entries', test: PAYMENT_LOCKS },
  { id: 'email-cancel', file: 'src/pg/routes/email.js', fn: 'loadCampaign', kind: 'for-update', test: CONCURRENCY },
  { id: 'events-lock', file: 'src/pg/events.js', fn: 'lockEvent', kind: 'for-update', test: DOMAIN },
  { id: 'news-lock', file: 'src/pg/news.js', fn: 'lockPost', kind: 'for-update', test: DOMAIN },
  { id: 'meetings-lock', file: 'src/pg/meetings.js', fn: 'lockMeeting', kind: 'for-update', test: DOMAIN },
  { id: 'documents-status', file: 'src/pg/routes/documents.js', fn: 'changeStatus', kind: 'for-update', test: DOMAIN },
  { id: 'families-contact', file: 'src/pg/routes/families.js', fn: 'updateGuardianContact', kind: 'for-update', test: DOMAIN },
  { id: 'year-close', file: 'src/pg/routes/year-close.js', fn: 'closeYear', kind: 'advisory', test: YEAR_CLOSE },
  { id: 'cost-center-allocation', file: 'src/pg/routes/ledger-cost-centers.js', fn: 'loadEntry', kind: 'for-update', test: COST_CENTERS },
  { id: 'budget-category', file: 'src/pg/routes/ledger-budget.js', fn: 'deactivateCategory', kind: 'for-update', test: BUDGET_LOCKS },
  { id: 'budget-revision', file: 'src/pg/routes/ledger-budget.js', fn: 'reviseLine', kind: 'for-update', test: BUDGET_LOCKS },
  { id: 'opening-adjustment', file: 'src/pg/routes/ledger-cash.js', fn: 'createAdjustment', kind: 'for-update', test: BUDGET_LOCKS },
  { id: 'families-identity', file: 'src/pg/routes/families.js', fn: 'updateIdentity', kind: 'for-update', table: 'students', test: RECORD_LOCKS },
  { id: 'families-identity-guardian', file: 'src/pg/routes/families.js', fn: 'updateIdentity', kind: 'for-update', table: 'guardians', test: RECORD_LOCKS },
  { id: 'families-relation-contact', file: 'src/pg/routes/families.js', fn: 'updateRelationContact', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-change-enrollment', file: 'src/pg/routes/families.js', fn: 'changeEnrollment', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-end-enrollment', file: 'src/pg/routes/families.js', fn: 'endEnrollment', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-end-relation', file: 'src/pg/routes/families.js', fn: 'endRelation', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-end-student-household', file: 'src/pg/routes/families.js', fn: 'endStudentHousehold', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-end-guardian-household', file: 'src/pg/routes/families.js', fn: 'endGuardianHousehold', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'families-add-student-household', file: 'src/pg/routes/families.js', fn: 'addStudentHousehold', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'documents-description', file: 'src/pg/routes/documents.js', fn: 'createDescription', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'news-photo-lock', file: 'src/pg/news.js', fn: 'lockPhoto', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'meetings-update', file: 'src/pg/meetings.js', fn: 'updateMeeting', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'meetings-resolution-update', file: 'src/pg/meetings.js', fn: 'updateResolution', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'meetings-attendance', file: 'src/pg/meetings.js', fn: 'recordAttendance', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'invitation-accept', file: 'src/pg/auth.js', fn: 'lockInvitation', kind: 'for-update', test: RECORD_LOCKS },
  { id: 'year-close-closure-lock', file: 'src/pg/routes/year-close.js', fn: 'loadClosure', kind: 'for-update', test: REPLAY_23505 },
  // Inwentaryzacja blokad (scripts/lock-inventory.js): blokady, których brak daje realny wyścig.
  { id: 'grant-request-lock', file: 'src/pg/grant-requests.js', fn: 'lockGrantRequest', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'session-create-share', file: 'src/pg/auth.js', fn: 'createSession', kind: 'for-share', test: DISABLE_SESSION },
  { id: 'guardian-update-submit', file: 'src/pg/routes/guardian-updates.js', fn: 'submitUpdate', kind: 'for-update', test: REQUEST_LOCKS },
  { id: 'guardian-update-decide', file: 'src/pg/routes/guardian-updates.js', fn: 'decideRequest', kind: 'for-update', table: 'guardian_update_requests', test: REQUEST_LOCKS },
  { id: 'guardian-update-decide-guardian', file: 'src/pg/routes/guardian-updates.js', fn: 'decideRequest', kind: 'for-update', table: 'guardians', test: REQUEST_LOCKS },
  { id: 'data-request-status', file: 'src/pg/routes/admin.js', fn: 'setDataRequestStatus', kind: 'for-update', test: REQUEST_LOCKS },
  { id: 'processing-restriction-request', file: 'src/pg/processing-restrictions.js', fn: 'changeProcessingRestriction', kind: 'for-update', test: REQUEST_LOCKS },
  { id: 'families-rectification-request', file: 'src/pg/routes/families.js', fn: 'checkRectificationRequest', kind: 'for-share', test: REQUEST_LOCKS },
  { id: 'ledger-category-deactivate', file: 'src/pg/routes/ledger.js', fn: 'deactivateCategory', kind: 'for-update', test: BUDGET_LOCKS },
  { id: 'password-reset-issue', file: 'src/pg/login.js', fn: 'issuePasswordResetInTx', kind: 'for-update', test: AUTH_LOCKS },
  { id: 'login-attempt-reserve', file: 'src/pg/login.js', fn: 'reserveAttempt', kind: 'for-update', test: AUTH_LOCKS },
  { id: 'grant-target-lock', file: 'src/pg/routes/admin.js', fn: 'lockGrantTarget', kind: 'for-update', test: AUTH_LOCKS },
  { id: 'email-outbox-resolution', file: 'src/pg/routes/email.js', fn: 'createResolution', kind: 'for-update', test: EMAIL_LOCKS },
  { id: 'email-suppression-release', file: 'src/pg/routes/email.js', fn: 'release', kind: 'for-update', test: EMAIL_LOCKS },
  // Dawne luki inwentaryzacji (#208): kod weryfikacyjny wniosku rodzica, MFA i webhook dostawcy.
  { id: 'guardian-verify-confirm', file: 'src/pg/routes/guardian-updates.js', fn: 'confirmCode', kind: 'for-update', test: GUARDIAN_VERIFY_LOCKS },
  { id: 'mfa-lock-user', file: 'src/pg/mfa.js', fn: 'lockUser', kind: 'for-update', test: MFA_LOCKS },
  { id: 'mfa-admin-reset', file: 'src/pg/login.js', fn: 'adminResetMfaInTx', kind: 'for-update', test: MFA_LOCKS },
  { id: 'mfa-key-rotation-account', file: 'src/pg/mfa-key-rotation.js', fn: 'lockAccount', kind: 'for-update', test: MFA_LOCKS },
  { id: 'email-webhook-outbox', file: 'src/pg/routes/email.js', fn: 'recordWebhookEvent', kind: 'for-update', test: WEBHOOK_LOCKS },
];

// Zwraca [początek, koniec) ciała funkcji najwyższego poziomu `fn` w `source`.
export function functionRange(source, fn) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${fn}\\(`, 'm'));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^export (?:const|let) |^const [A-Z_]+ = /m);
  return [start, next < 0 ? source.length : start + 1 + next];
}

export function applyMutant(source, mutant) {
  const range = functionRange(source, mutant.fn);
  if (!range) throw new Error(`${mutant.id}: brak funkcji ${mutant.fn} w ${mutant.file}`);
  if (mutant.kind === 'advisory') {
    const body = source.slice(...range);
    const hits = body.match(/pg_advisory_xact_lock\(/g)?.length ?? 0;
    if (!hits) throw new Error(`${mutant.id}: brak blokady (${mutant.kind}) w ${mutant.fn} — lista mutantów jest nieaktualna`);
    return { source: source.slice(0, range[0]) + body.replace(/pg_advisory_xact_lock\(/g, '(') + source.slice(range[1]), hits };
  }
  // Blokady wierszy: wystąpienia ze skanera (kod bez komentarzy) w tej funkcji,
  // danego rodzaju i — gdy mutant ma `table` — tylko tej tabeli. Usuwane od końca
  // razem z poprzedzającymi białymi znakami.
  const targets = selectMutantLocks(source, mutant);
  if (!targets.length) throw new Error(`${mutant.id}: brak blokady (${mutant.kind}${mutant.table ? `, ${mutant.table}` : ''}) w ${mutant.fn} — lista mutantów jest nieaktualna`);
  let mutated = source;
  for (const lock of [...targets].sort((a, b) => b.index - a.index)) {
    let start = lock.index;
    while (start > 0 && /\s/.test(mutated[start - 1])) start -= 1;
    mutated = mutated.slice(0, start) + mutated.slice(lock.index + lock.length);
  }
  return { source: mutated, hits: targets.length };
}

// Wystąpienia blokady wierszy, które usuwa mutant (rodzaj `for-update`, `for-share`, …).
export function selectMutantLocks(source, mutant) {
  if (!LOCK_KINDS[mutant.kind]) throw new Error(`${mutant.id}: nieznany rodzaj mutanta ${mutant.kind}`);
  return scanSource(source, mutant.file)
    .filter((lock) => lock.fn === mutant.fn && lock.kind === mutant.kind && (!mutant.table || lock.table === mutant.table));
}

function runTests(dir, file) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['scripts/test-pg-real.js', file], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => {
      const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
      const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
      ok({ code: code ?? 1, pass, fail, out });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.filter((a) => !a.startsWith('--'));
  let mutants = selected.length ? MUTANTS.filter((m) => selected.includes(m.id)) : MUTANTS;
  if (selected.length && mutants.length !== selected.length) {
    console.error(`Nieznany mutant: ${selected.filter((id) => !MUTANTS.some((m) => m.id === id)).join(', ')}`);
    return 2;
  }
  const shardArg = args.find((a) => a.startsWith('--shard='));
  if (shardArg) {
    // Część i/N liczona zawsze z pełnej listy MUTANTS (każdy mutant w dokładnie jednej części).
    if (selected.length) { console.error('--shard nie łączy się z wyborem mutantów po id.'); return 2; }
    let shard;
    try { shard = parseShard(shardArg.slice('--shard='.length)); } catch (error) { console.error(error.message); return 2; }
    mutants = shardMutants(MUTANTS, shard.index, shard.total);
    console.error(`# część ${shard.index}/${shard.total}: mutantów ${mutants.length} z ${MUTANTS.length}`);
  }
  for (const mutant of mutants) applyMutant(await readFile(join(root, mutant.file), 'utf8'), mutant);
  if (args.includes('--list')) {
    for (const m of mutants) console.log(`${m.id}\t${m.file}#${m.fn}${m.table ? `:${m.table}` : ''}\t${m.kind}\t${m.test}`);
    return 0;
  }

  const dir = await mkdtemp(join(tmpdir(), 'rd-mutants-'));
  try {
    // Cała kopia robocza (~10 MB) bez zależności, historii git i artefaktów budowania:
    // kod aplikacji importuje moduły z wielu katalogów (print/, shared/, import/ …).
    const skipped = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report']);
    for (const entry of await readdir(root)) {
      if (!skipped.has(entry)) await cp(join(root, entry), join(dir, entry), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');

    const baseline = [...new Set(mutants.map((m) => m.test))];
    for (const file of baseline) {
      const result = await runTests(dir, file);
      if (result.code !== 0 || !(result.pass > 0) || result.fail !== 0) {
        console.error(result.out.slice(-4000));
        console.error(`Przebieg bez mutacji nie jest zielony: ${file} (kod ${result.code}, pass ${result.pass}, fail ${result.fail}).`);
        return 2;
      }
      console.log(`# bez mutacji: ${file} — pass ${result.pass}`);
    }

    const survivors = [];
    for (const mutant of mutants) {
      const target = join(dir, mutant.file);
      const original = await readFile(target, 'utf8');
      const { source, hits } = applyMutant(original, mutant);
      await writeFile(target, source);
      try {
        const result = await runTests(dir, mutant.test);
        // Wynik bez linii „# fail” (proces padł przed raportem) to błąd, nie „zabity mutant”.
        const killed = Number.isFinite(result.fail) && result.fail > 0;
        if (!Number.isFinite(result.fail)) {
          console.error(result.out.slice(-3000));
          console.error(`${mutant.id}: brak raportu testów (kod ${result.code}).`);
          return 2;
        }
        console.log(`${killed ? 'zabity  ' : 'PRZEŻYŁ '} ${mutant.id} (${mutant.file}#${mutant.fn}${mutant.table ? `:${mutant.table}` : ''}, ${hits}× ${mutant.kind}) — fail ${result.fail}, pass ${result.pass}`);
        if (!killed) survivors.push(mutant.id);
      } finally {
        await writeFile(target, original);
      }
    }
    if (survivors.length) {
      console.error(`Mutanty, których żaden test nie wykrył: ${survivors.join(', ')}`);
      return 1;
    }
    console.log(`# wszystkie mutanty zabite: ${mutants.length}`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
