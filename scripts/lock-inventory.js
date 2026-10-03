// Inwentaryzacja blokad wierszy w src/pg (#208, kryterium „każda blokada wiersza
// ma dowód”). Skaner znajduje w KODZIE (bez komentarzy) każde `FOR UPDATE`,
// `FOR NO KEY UPDATE`, `FOR SHARE` i `FOR KEY SHARE`, przypisuje je do funkcji
// najwyższego poziomu i do tabeli, której wiersze blokuje. Każde wystąpienie musi
// mieć mutant w scripts/check-lock-mutations.js (usunięcie blokady czerwieni test
// z barierą na prawdziwym PostgreSQL) albo wpis w LOCK_EXCEPTIONS z uzasadnieniem.
// Pilnuje tego tests/lock-inventory.test.js (bez bazy); tabela pokrycia jest w
// docs/TESTING.md („Inwentaryzacja blokad wierszy”).
//
// Dopasowanie jest stabilne: plik + funkcja + tabela (+ rodzaj blokady), nie numer
// linii. Blokady doradcze (`pg_advisory_xact_lock`), `LOCK TABLE` i blokady w
// wyzwalaczach migracji są poza tym skanem (opis w docs/TESTING.md).
//
//   node scripts/lock-inventory.js              lista: plik, funkcja, tabela, blokada, pokrycie
//   node scripts/lock-inventory.js --markdown   tabela pokrycia do docs/TESTING.md
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Kolejność alternatyw: dłuższe najpierw (`FOR NO KEY UPDATE` przed `FOR UPDATE`).
export const ROW_LOCK = /FOR (NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)\b(?: OF (\w+))?/g;
export const LOCK_KINDS = { 'for-update': 'FOR UPDATE', 'for-no-key-update': 'FOR NO KEY UPDATE', 'for-share': 'FOR SHARE', 'for-key-share': 'FOR KEY SHARE' };
const KIND_OF = Object.fromEntries(Object.entries(LOCK_KINDS).map(([kind, sql]) => [sql, kind]));

// Granice funkcji jak w check-lock-mutations.js (`functionRange`): funkcja najwyższego
// poziomu trwa do następnej funkcji, `export const`/`export let` albo stałej WIELKIMI.
const FUNCTION_START = /^(?:export )?(?:async )?function (\w+)\(/gm;
const FUNCTION_END = /^(?:export )?(?:async )?function |^export (?:const|let) |^const [A-Z_]+ = /gm;

/**
 * Zastępuje komentarze spacjami (z zachowaniem nowych linii i długości), żeby
 * „FOR UPDATE” w komentarzu nie było blokadą. Uwzględnia napisy '…', "…",
 * szablony `…${…}…` (zagnieżdżone) i literały wyrażeń regularnych.
 * @param {string} source
 */
export function maskComments(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' '; };
  const stack = []; // 'tpl' albo liczba nawiasów { w wyrażeniu ${…}
  let i = 0;
  let lastSignificant = '';
  const n = source.length;
  const inTemplate = () => stack.length && stack[stack.length - 1] === 'tpl';
  while (i < n) {
    const c = source[i];
    if (inTemplate()) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; lastSignificant = '`'; continue; }
      if (c === '$' && source[i + 1] === '{') { stack.push(0); i += 2; lastSignificant = '{'; continue; }
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      i += 1;
      while (i < n && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      lastSignificant = c;
      continue;
    }
    if (c === '`') { stack.push('tpl'); i += 1; continue; }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant)
        || /\b(?:return|typeof|case|of|in)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))) {
      // Literał wyrażenia regularnego: do niezaescapowanego `/` poza klasą znaków.
      let inClass = false;
      i += 1;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      lastSignificant = '/';
      continue;
    }
    if (c === '{' && stack.length) stack[stack.length - 1] += 1;
    if (c === '}' && stack.length) {
      if (stack[stack.length - 1] === 0) { stack.pop(); i += 1; lastSignificant = '}'; continue; }
      stack[stack.length - 1] -= 1;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$]/.test(c) ? 'w' : c;
    i += 1;
  }
  return out.join('');
}

/** Funkcje najwyższego poziomu: [{ name, start, end }]. @param {string} source */
export function topLevelFunctions(source) {
  const starts = [...source.matchAll(FUNCTION_START)].map((m) => ({ name: m[1], start: m.index }));
  return starts.map((fn) => {
    FUNCTION_END.lastIndex = fn.start + 1;
    const next = FUNCTION_END.exec(source);
    return { ...fn, end: next ? next.index : source.length };
  });
}

// Tabela blokowanych wierszy: dla `OF alias` — tabela tego aliasu w zapytaniu,
// w pozostałych przypadkach ostatnie `FROM tabela` przed blokadą (zapytania z
// blokadą w src/pg mieszczą się w 1500 znakach przed nią).
function lockedTable(masked, index, alias) {
  const before = masked.slice(Math.max(0, index - 1500), index);
  if (alias) {
    const aliased = [...before.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+([a-z_][a-z0-9_]*)\\s+(?:AS\\s+)?${alias}\\b`, 'g'))];
    if (aliased.length) return aliased[aliased.length - 1][1];
    const bare = [...before.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+(${alias})\\b`, 'g'))];
    if (bare.length) return bare[bare.length - 1][1];
    return null;
  }
  // Bez funkcji zwracających zbiór (`FROM unnest(…)` w podzapytaniu).
  const from = [...before.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/g)];
  return from.length ? from[from.length - 1][1] : null;
}

/**
 * Blokady wierszy w jednym pliku (kod bez komentarzy).
 * @param {string} source
 * @param {string} file ścieżka względna (np. src/pg/routes/payments.js)
 * @returns {{ file: string, fn: string|null, table: string|null, kind: string, line: number, index: number, length: number }[]}
 */
export function scanSource(source, file) {
  const masked = maskComments(source);
  const functions = topLevelFunctions(masked);
  const locks = [];
  for (const match of masked.matchAll(ROW_LOCK)) {
    const fn = functions.find((f) => match.index >= f.start && match.index < f.end) ?? null;
    locks.push({
      file,
      fn: fn ? fn.name : null,
      table: lockedTable(masked, match.index, match[2]),
      kind: KIND_OF[`FOR ${match[1]}`],
      line: source.slice(0, match.index).split('\n').length,
      index: match.index,
      length: match[0].length,
    });
  }
  return locks;
}

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

/** Wszystkie blokady wierszy w src/pg. @param {string} [base] katalog repozytorium */
export function scanRepository(base = root) {
  return walk(join(base, 'src/pg')).flatMap((path) => scanSource(readFileSync(path, 'utf8'), relative(base, path)));
}

export const lockKey = ({ file, fn, table, kind }) => `${file}#${fn}:${table}:${kind}`;

// Wyjątki: blokady bez mutanta. `category`:
//  - 'zagnieżdżona' — ta sama transakcja wcześniej bierze blokadę wiersza nadrzędnego,
//    która ma własny mutant (`outer` = id mutanta); każdy zapis chronionej tabeli
//    przechodzi przez tę blokadę, więc usunięcie samej wewnętrznej nie zmienia
//    wyniku (mutant równoważny, nie do zabicia);
//  - 'ograniczenie' — serializację zapewnia baza niezależnie od blokady:
//    indeks UNIKALNY (+ odtworzenie 23505), wyzwalacz migracji albo warunkowy
//    UPDATE (`evidence` = nazwa z postgres/migrations albo fragment kodu tej funkcji
//    lub funkcji `in` z tego pliku); bez blokady zmienia się co najwyżej odpowiedź (kod błędu,
//    stan w metadanych audytu), bez podwójnego zapisu i utraconej aktualizacji;
//  - 'luka' — wyścig jest możliwy, a testu z barierą jeszcze nie ma (dalszy zakres
//    #208); `reason` opisuje skutek.
// Test-strażnik sprawdza, że `outer` to istniejący mutant, a `evidence` istnieje
// w migracjach (`migration`) albo w ciele funkcji (`code`).
export const LOCK_EXCEPTIONS = [
  // ---------------------------------------------------------------- finanse
  {
    file: 'src/pg/routes/ledger.js', fn: 'createReplacement', table: 'payment_entries', category: 'ograniczenie',
    evidence: { migration: 'ledger_entry_insert_guard' },
    reason: 'Wyzwalacz ledger_entry_insert_guard (0142) przy wstawieniu wpisu zastępczego sam blokuje wiersz wpłaty FOR UPDATE i porównuje kwotę z jej netto (ledger_payment_amount_mismatch). Blokada w API ustala tylko kolejność „wpłata, potem wpis” jak w korekcie wpłaty; wpis księgi ma osobny mutant ledger-replacement.',
  },
  {
    file: 'src/pg/routes/ledger.js', fn: 'createReview', table: 'ledger_entries', kind: 'for-share', category: 'ograniczenie',
    evidence: { migration: 'ledger_review_guard' },
    reason: 'Przegląd wydatku tylko dopisuje wiersz z unikalnym kluczem idempotencji (odtworzenie 23505). Wpis księgi jest niezmienny (kierunek, autor, rok), a wyzwalacz ledger_review_guard (0072) powtarza te same kontrole w transakcji zapisu, więc żadna reguła nie zależy od stanu, który mógłby zmienić się równolegle.',
  },
  {
    file: 'src/pg/routes/ledger.js', fn: 'createAuthorization', table: 'resolutions', category: 'ograniczenie',
    evidence: { migration: 'resolution_spending_authorizations_root_idx' },
    reason: 'Dwie kwoty upoważnienia z tej samej podstawy: indeks unikalny resolution_spending_authorizations_root_idx (pierwsza kwota) i UNIQUE supersedes_id (następca) z 0072 — przegrany dostaje 23505 i 409 authorization_superseded. Stan uchwały (przyjęta, bez korekty) sprawdza też wyzwalacz resolution_authorization_guard.',
  },
  {
    file: 'src/pg/routes/payment-references.js', fn: 'createReference', table: 'payment_references', category: 'ograniczenie',
    evidence: { migration: 'payment_references_active_household_year_idx' },
    reason: 'Przy pierwszej referencji FOR UPDATE nie ma czego blokować (zero wierszy); jedną aktywną referencję na gospodarstwo i rok trzyma indeks unikalny payment_references_active_household_year_idx (0085). Bez blokady drugie żądanie dostaje 23505 → 409 idempotency_conflict zamiast payment_reference_already_active, bez drugiego wiersza.',
  },
  {
    file: 'src/pg/routes/payment-references.js', fn: 'revokeReference', table: 'payment_references', category: 'ograniczenie',
    evidence: { migration: 'payment_reference_id TEXT NOT NULL UNIQUE' },
    reason: 'Jedno unieważnienie na referencję: UNIQUE payment_reference_revocations.payment_reference_id (0085), a wyzwalacz zastosowania blokuje referencję FOR UPDATE. Bez blokady drugie unieważnienie kończy się 23505 (odtworzenie po kluczu albo 409), bez drugiego zapisu.',
  },
  {
    file: 'src/pg/routes/reconciliation.js', fn: 'revokeMatch', table: 'bank_reconciliation_matches', category: 'zagnieżdżona', outer: 'reconciliation-lock',
    reason: 'Wcześniej w tej samej transakcji loadReconciliation(…, { lock: true }) blokuje wiersz uzgodnienia; każdy zapis bank_reconciliation_matches (dopasowanie, dopasowanie zbiorcze, pozycja z wyciągu, cofnięcie) przechodzi przez tę blokadę.',
  },
  {
    file: 'src/pg/routes/reconciliation.js', fn: 'confirmGroupMatch', table: 'ledger_entries', kind: 'for-share', category: 'ograniczenie',
    evidence: { migration: 'bank_group_match_items_guard_insert' },
    reason: 'Wyzwalacz pozycji dopasowania zbiorczego (0105, bank_group_match_items_guard_insert) blokuje cel FOR SHARE i porównuje kwotę z netto po zatwierdzeniu równoległej korekty (bank_match_amount_mismatch), a całe uzgodnienie jest zablokowane przez loadReconciliation. Blokada w API tylko ustala kolejność celów.',
  },
  {
    file: 'src/pg/routes/reconciliation.js', fn: 'confirmGroupMatch', table: 'payment_entries', kind: 'for-share', category: 'ograniczenie',
    evidence: { migration: 'bank_group_match_items_guard_insert' },
    reason: 'Jak dla ledger_entries: wyzwalacz bank_group_match_items_guard_insert (0105) blokuje wpłatę FOR SHARE i sprawdza netto przy wstawieniu pozycji; blokada w API ustala tylko kolejność celów.',
  },
  // ---------------------------------------------------------------- wydarzenia i zebrania
  {
    file: 'src/pg/events.js', fn: 'cancelTask', table: 'event_tasks', category: 'zagnieżdżona', outer: 'events-lock',
    reason: 'Funkcja zaczyna od lockEvent (wiersz wydarzenia FOR UPDATE); każdy zapis event_tasks (createTask, cancelTask) robi to samo, więc blokada zadania jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/events.js', fn: 'createSignup', table: 'event_task_signups', category: 'zagnieżdżona', outer: 'events-lock',
    reason: 'Zapis na zadanie i jego wycofanie zaczynają od lockEvent; nowy zapis tej samej osoby chroni dodatkowo indeks unikalny (gałąź 23505 w kodzie). Blokada istniejącego zapisu jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/events.js', fn: 'withdrawSignup', table: 'event_task_signups', category: 'zagnieżdżona', outer: 'events-lock',
    reason: 'Wycofanie zapisu zaczyna od lockEvent, jak każdy zapis event_task_signups; blokada wiersza zapisu jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/meetings.js', fn: 'withdrawAgendaItem', table: 'meeting_agenda_items', category: 'zagnieżdżona', outer: 'meetings-lock',
    reason: 'Wycofanie punktu porządku obrad wywołuje wcześniej lockMeeting; jedyny zapis withdrawn_at jest w tej funkcji, więc blokada punktu jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/meetings.js', fn: 'reorderAgendaItems', table: 'meeting_agenda_items', category: 'zagnieżdżona', outer: 'meetings-lock',
    reason: 'Zmiana kolejności wywołuje wcześniej lockMeeting; pozycje zmienia wyłącznie ta funkcja, więc blokada punktów jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/meetings.js', fn: 'loadNotice', table: 'meeting_notices', category: 'zagnieżdżona', outer: 'meetings-lock',
    reason: 'loadNotice(…, { lock: true }) wołają tylko approveMeetingNotice i createNoticeCampaignDraft, obie po lockMeeting; zawiadomienia powstają (createNoticeDraft) też pod lockMeeting.',
  },
  // ---------------------------------------------------------------- rodziny i wnioski rodziców
  {
    file: 'src/pg/routes/guardian-updates.js', fn: 'verificationsByRequest', table: 'guardian_update_verifications', category: 'ograniczenie',
    evidence: { code: "WHERE id = $1 AND state = 'queued'", in: 'decideRequest' },
    reason: 'Blokada (tylko z decideRequest, po blokadzie wniosku z mutantem guardian-update-decide) ustala stan weryfikacji zapisany w audycie decyzji. Anulowanie kodu jest warunkowym UPDATE … AND state = \'queued\', więc nie nadpisuje wysyłki workera; bez blokady audyt może pokazać stan sprzed równoległego potwierdzenia kodu (bez zmiany danych).',
  },
  {
    file: 'src/pg/routes/guardian-updates.js', fn: 'approveTemplate', table: 'guardian_verify_templates', category: 'ograniczenie',
    evidence: { migration: 'guardian_verify_template_guard' },
    reason: 'Wyzwalacz guardian_verify_template_guard (0184) dopuszcza wyłącznie przejście draft → approved, więc drugie zatwierdzenie nie nadpisze approved_by; bez blokady kończy się błędem wyzwalacza zamiast powtórki/409.',
  },
  // ---------------------------------------------------------------- konta, sesje, MFA
  {
    file: 'src/pg/account-recovery.js', fn: 'createRecoveryRequest', table: 'users', category: 'ograniczenie',
    evidence: { migration: 'account_recovery_requests_open_uidx' },
    reason: 'Jeden otwarty wniosek danego rodzaju na konto trzyma indeks unikalny account_recovery_requests_open_uidx (0125); bez blokady drugi wniosek kończy się 23505 zamiast zwrócenia istniejącego, bez drugiego wiersza.',
  },
  {
    file: 'src/pg/account-recovery.js', fn: 'lockRequest', table: 'account_recovery_requests', category: 'ograniczenie',
    evidence: { migration: 'account_recovery_request_guard' },
    reason: 'Wyzwalacz account_recovery_request_guard (0125) odrzuca zmianę wniosku, który nie jest już pending, więc drugie zatwierdzenie/odrzucenie wycofuje całą transakcję (z tokenem resetu, który i tak serializuje blokada konta z mutantem password-reset-issue). Bez blokady: błąd wyzwalacza zamiast 409 recovery_request_closed.',
  },
  {
    file: 'src/pg/auth.js', fn: 'revokeOwnSession', table: 'sessions', category: 'ograniczenie',
    evidence: { code: 'WHERE id = $1 AND revoked_at IS NULL', in: 'revokeSessionWith' },
    reason: 'Cofnięcie sesji to warunkowy UPDATE … AND revoked_at IS NULL (revokeSessionWith): drugi UPDATE czeka na pierwszy, po jego zatwierdzeniu nie zmienia wiersza i nie dopisuje zdarzenia.',
  },
  {
    file: 'src/pg/login.js', fn: 'acceptInvitationWithPassword', table: 'users', category: 'ograniczenie',
    evidence: { code: 'ON CONFLICT (email) DO NOTHING' },
    reason: 'Zaproszenie blokuje lockInvitation (mutant invitation-accept); nowe konto chroni ON CONFLICT (email) DO NOTHING (409 conflict) i klucz główny user_passwords, a wyłączenie konta w trakcie — FOR SHARE w createSession (mutant session-create-share). Blokada konta ustala tylko porównanie skrótu hasła z chwili sprawdzenia.',
  },
  {
    file: 'src/pg/login.js', fn: 'resetPasswordWithToken', table: 'password_reset_tokens', category: 'ograniczenie',
    evidence: { migration: 'password_reset_token_guard' },
    reason: 'Wyzwalacz password_reset_token_guard (0020) odrzuca zmianę tokenu już użytego albo cofniętego, więc drugie użycie tego samego tokenu wycofuje całą transakcję (z nowym hasłem); bez blokady: błąd wyzwalacza zamiast 400 invalid_token.',
  },
  {
    file: 'src/pg/mfa.js', fn: 'activeFactors', table: 'user_mfa_factors', category: 'zagnieżdżona', outer: 'mfa-lock-user',
    reason: 'activeFactors wołają tylko enrollFactor, attemptFactor i revokeAllOwnSessions, każda zaraz po lockUser (wiersz konta FOR UPDATE). Każdy zapis user_mfa_factors (zapis i potwierdzenie czynnika, reset MFA w adminResetMfaInTx, rotacja klucza po lockAccount) bierze wcześniej blokadę konta, więc blokada czynnika jest drugą warstwą (mutant równoważny).',
  },
  {
    file: 'src/pg/mfa-key-rotation.js', fn: 'rotateOneAccount', table: 'user_mfa_factors', category: 'zagnieżdżona', outer: 'mfa-key-rotation-account',
    reason: 'Rotacja zaczyna od lockAccount (wiersz konta FOR UPDATE), tak jak weryfikacja i zapis czynnika (lockUser) oraz reset MFA; każdy zapis user_mfa_factors przechodzi przez blokadę konta, więc blokada czynnika jest drugą warstwą (mutant równoważny). Bez obu blokad rotacja przenosi krok sprzed weryfikacji (kontrola pozytywna w tests/pg-real-mfa-locks.test.js).',
  },
  {
    file: 'src/pg/routes/admin.js', fn: 'setUserDisabled', table: 'users', category: 'ograniczenie',
    evidence: { code: 'WHERE id = $1 AND disabled_at IS NULL RETURNING id' },
    reason: 'Wyłączenie i włączenie konta to warunkowe UPDATE (… AND disabled_at IS NULL / IS NOT NULL): drugi UPDATE czeka na pierwszy i po jego zatwierdzeniu nie zmienia wiersza (changed: false, bez zdarzenia). Wyścig z tworzeniem sesji (#256) zamyka FOR SHARE w createSession (mutant session-create-share).',
  },
  {
    file: 'src/pg/routes/admin.js', fn: 'revokeGrant', table: 'role_grants', category: 'zagnieżdżona', outer: 'admin-last',
    reason: 'Wcześniej w tej samej transakcji lockGrantChanges bierze blokadę doradczą rd:role_grants (mutant admin-last), pod którą zmieniają się wszystkie przydziały; UPDATE jest dodatkowo warunkowy (… AND g.revoked_at IS NULL).',
  },
  // ---------------------------------------------------------------- e-mail i informacja o przetwarzaniu
  {
    file: 'src/pg/routes/email.js', fn: 'providerPauseLift', table: 'email_provider_pauses', category: 'ograniczenie',
    evidence: { code: 'WHERE id = $1 AND lifted_at IS NULL' },
    reason: 'Zdjęcie wstrzymania dostawcy to warunkowy UPDATE … AND lifted_at IS NULL: drugi czeka na pierwszy i nie zmienia wiersza, a brak wiersza przerywa transakcję razem z wpisem audytu. Bez blokady: błąd zamiast powtórki, bez podwójnego zapisu.',
  },
  {
    file: 'src/pg/routes/email.js', fn: 'approveResolution', table: 'email_outbox', category: 'ograniczenie',
    evidence: { migration: 'resolution_id TEXT NOT NULL UNIQUE' },
    reason: 'Jedno zatwierdzenie na rozstrzygnięcie: UNIQUE email_outbox_resolution_approvals.resolution_id (0156); bez blokady drugie kliknięcie dostaje 23505 zamiast powtórki, bez drugiego zapisu.',
  },
  {
    file: 'src/pg/routes/privacy-notice.js', fn: 'approveNotice', table: 'privacy_notices', category: 'ograniczenie',
    evidence: { migration: 'privacy_notice_approval_fields_locked' },
    reason: 'Wyzwalacz privacy_notice_guard (0075) dopuszcza zmianę approved_by/approved_at tylko przy przejściu draft → approved (privacy_notice_approval_fields_locked), więc drugie zatwierdzenie nie nadpisze pierwszego; bez blokady: błąd wyzwalacza zamiast powtórki.',
  },
  {
    file: 'src/pg/routes/privacy-notice.js', fn: 'publishNotice', table: 'privacy_notices', category: 'ograniczenie',
    evidence: { code: "pg_advisory_xact_lock(hashtext('rd_privacy_notice_publish'))" },
    reason: 'Publikację serializuje wcześniej w tej samej transakcji blokada doradcza rd_privacy_notice_publish (każda publikacja ją bierze), a przejścia stanów pilnuje wyzwalacz privacy_notice_guard (0075). Blokada doradcza nie ma osobnego mutanta (poza zakresem skanu blokad wierszy).',
  },
];

/** Pokrycie: wystąpienie → mutanty i wyjątki, które je obejmują. */
export function coverage(locks, mutants, exceptions = LOCK_EXCEPTIONS) {
  return locks.map((lock) => ({
    lock,
    mutants: mutants.filter((m) => m.file === lock.file && m.fn === lock.fn
      && (m.kind ?? 'for-update') === lock.kind && (!m.table || m.table === lock.table)),
    exceptions: exceptions.filter((e) => e.file === lock.file && e.fn === lock.fn
      && e.table === lock.table && (e.kind ?? 'for-update') === lock.kind),
  }));
}

// Tabela pokrycia w Markdown (docs/TESTING.md, między znacznikami TABLE_START/TABLE_END;
// zgodność z kodem sprawdza tests/lock-inventory.test.js). `rows` z coverage().
export const TABLE_START = '<!-- lock-inventory:start (generuje: node scripts/lock-inventory.js --markdown) -->';
export const TABLE_END = '<!-- lock-inventory:end -->';
export function coverageTable(rows) {
  const cell = (text) => String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = [
    '| Plik i funkcja | Tabela | Blokada | Dowód |',
    '| --- | --- | --- | --- |',
  ];
  for (const { lock, mutants, exceptions } of rows) {
    const proof = mutants.length
      ? mutants.map((m) => `mutant \`${m.id}\` (\`${m.test}\`)`).join(', ')
      : exceptions.length
        ? `wyjątek, ${exceptions[0].category}${exceptions[0].outer ? ` (pod \`${exceptions[0].outer}\`)` : ''}: ${exceptions[0].reason}`
        : '**BRAK**';
    lines.push(`| \`${lock.file.replace(/^src\/pg\//, '')}\` \`${lock.fn}\` | \`${lock.table}\` | ${LOCK_KINDS[lock.kind]} | ${cell(proof)} |`);
  }
  return [TABLE_START, ...lines, TABLE_END].join('\n');
}

async function main() {
  const { MUTANTS } = await import('./check-lock-mutations.js');
  const rows = coverage(scanRepository(), MUTANTS);
  if (process.argv.includes('--markdown')) {
    console.log(coverageTable(rows));
    return 0;
  }
  for (const { lock, mutants, exceptions } of rows) {
    const status = mutants.length ? `mutant ${mutants.map((m) => m.id).join(', ')}`
      : exceptions.length ? `wyjątek (${exceptions[0].category})` : 'BRAK';
    console.log(`${lock.file}#${lock.fn}\t${lock.table}\t${LOCK_KINDS[lock.kind]}\t${status}`);
  }
  const missing = rows.filter((r) => !r.mutants.length && !r.exceptions.length).length;
  console.log(`# blokad: ${rows.length}, z mutantem: ${rows.filter((r) => r.mutants.length).length}, wyjątków: ${rows.filter((r) => !r.mutants.length && r.exceptions.length).length}, bez pokrycia: ${missing}`);
  return missing ? 1 : 0;
}

// Bez await na najwyższym poziomie: main() importuje check-lock-mutations.js, który importuje ten moduł.
if (import.meta.url === `file://${process.argv[1]}`) main().then((code) => { process.exitCode = code; });
