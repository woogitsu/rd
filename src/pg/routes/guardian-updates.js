// Wniosek rodzica o aktualizację kontaktu przez jednorazowy link, z
// zatwierdzeniem przez zarząd (#140, część 1: zwykła aktualizacja kontaktu —
// nie formalne żądanie RODO #100, nie wypisanie z kategorii #110).
// Prototyp — nie jest wdrożony.
//
//   POST /api/admin/guardian-links                    admin, zarząd — wydaje link
//   GET  /api/public/guardian-update?token=            publiczny podgląd (imię, klasa)
//   POST /api/public/guardian-update                   publiczny formularz — tworzy WNIOSEK
//   GET  /api/admin/guardian-update-requests            admin, zarząd — kolejka (status=pending)
//   POST /api/admin/guardian-update-requests/{id}/approve
//   POST /api/admin/guardian-update-requests/{id}/reject
//   POST /api/public/guardian-update/verify            publiczne potwierdzenie kodu (#140 pkt 5)
//   GET  /api/admin/guardian-verify-templates           admin, zarząd — wersje szablonu wiadomości z kodem
//   POST /api/admin/guardian-verify-templates           admin, zarząd — nowy szkic szablonu
//   POST /api/admin/guardian-verify-templates/{id}/approve  zarząd, inna osoba niż autor, świeże MFA
//
// Każda trasa /api/admin/* tego modułu wymaga potwierdzonego MFA na poziomie
// trasy (#748, requireBoardContext), niezależnie od MFA_REQUIRED_ROLES; trasy
// /api/public/* uwierzytelnia wyłącznie token i MFA ich nie dotyczy.
//
// Rodzic nie ma konta (role w role_grants obejmują wyłącznie Radę) — token
// jest jedynym mechanizmem uwierzytelnienia, dlatego jednorazowy, krótkotrwały
// i przechowywany wyłącznie jako skrót SHA-256. Formularz publiczny nigdy nie
// zmienia `guardians` bezpośrednio: zapisuje wniosek (`pending`), zarząd go
// zatwierdza albo odrzuca. Zatwierdzenie korzysta z tego samego mechanizmu
// `rd.change_reason` co PATCH /api/guardians/:id/contact (families.js), więc
// historia zmian (guardian_contact_changes) i ten moduł opisują jedno
// zdarzenie, bez duplikowania logiki zapisu kontaktu.
//
// Wariant zachowawczy do czasu decyzji zarządu/administratora danych (patrz
// migracja 0087): każdy wniosek — także wycofanie zgody — czeka na
// zatwierdzenie człowieka; kolejkę widzą wyłącznie admin i zarząd bez
// przydziału klasowego (SR-01, jak board.js/#131).
//
// Kod weryfikacyjny na nowy adres (#140 pkt 5, migracja 0184; wskazania
// właściciela 2026-10-02): weryfikacja OPCJONALNA — zarząd może zatwierdzić
// wniosek z niepotwierdzonym adresem, ale kolejka pokazuje stan
// (`verification: none|sent|confirmed|expired|failed`), a zatwierdzenie zapisuje
// go w audycie. Kod jest zlecany automatycznie przy złożeniu wniosku z nowym
// adresem, ale wyłącznie gdy: flaga GUARDIAN_VERIFY_EMAIL_ENABLED=true, istnieje
// szablon zatwierdzony przez zarząd (cztery oczy, MFA) i opublikowana informacja
// o przetwarzaniu danych (D-06). Trasa publiczna NIE woła dostawcy — zapisuje
// wiersz kolejki `guardian_update_verifications` (klucz `verify:{requestId}`),
// który wysyła worker (src/email/worker.js) w limicie Brevo. Odbiorca = wyłącznie
// adres z tego wniosku. Kod jawny nie trafia do bazy ani do audytu.

import { createHash, randomBytes } from 'node:crypto';
import {
  freshMfaForbiddenCode, isAuthorizedScoped, loadAuthorizationContext, logAccessDenied, MFA_STEP_UP_MAX_AGE_SECONDS,
} from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { createJsonReader, decodePathId } from '../input.js';
import { emailHash, findForbiddenWording, normalizeEmail } from '../../email/content.js';
import {
  codeMatches, GUARDIAN_RESTRICTED_SQL, guardianVerifyEnabled, VERIFY_BODY_PLACEHOLDERS, VERIFY_CODE_PATTERN,
  VERIFY_MAX_FAILED_ATTEMPTS, verificationStatus, verifyTemplateHash,
} from '../../email/guardian-verify.js';
import { loadPublishedNotice } from './privacy-notice.js';
import { afterTupleAscSql, cursorTimestampSql, decodeListCursor, pageOf, parseListLimit } from '../list-cursor.js';

export const name = 'guardian-updates';

const EDIT_ROLES = ['admin', 'board'];
// Szablon wiadomości z kodem: szkic — admin/zarząd; zatwierdzenie — wyłącznie
// zarząd (D-16: treść wiadomości do rodziców zatwierdza Rada), inna osoba niż autor.
const TEMPLATE_APPROVE_ROLES = ['board'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;
const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 dni — propozycja z #140, do zatwierdzenia.
const MAX_BODY_BYTES = 4 * 1024;
const MAX_NOTE_LENGTH = 500;

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// #152: błąd 422 bramki pól wolnego tekstu (src/pg/pii-gate.js).
const piiFail = (code, categories) => new RequestError(code, 422, { categories });

// Zegar ważności linku (follow-up #214): testy podają env.now (funkcja
// zwracająca Date) — ten sam kontrakt co effectiveDay w src/pg/today.js —
// zamiast przestawiać niezmienny expires_at z wyłączonym strażnikiem.
// Produkcja nie ustawia env.now, więc liczy się zegar procesu.
function clock(env) {
  return typeof env?.now === 'function' ? env.now() : new Date();
}

function linkExpired(env, link) {
  return new Date(link.expires_at) <= clock(env);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  error: (code, status) => new RequestError(code, status),
});

// Admin/zarząd BEZ przydziału klasowego — ten sam wzorzec SR-01 co pulpit
// zarządu (board.js, #131): przedstawiciel klasy nie widzi kolejki wniosków.
// #748: MFA wymagane na samej trasie (`requireMfa: true`, jak import,
// privacy-notice i year-close), nie tylko przez bramkę routera — ta działa
// wyłącznie dla ról z MFA_REQUIRED_ROLES, a trasy zmieniają dane kontaktowe
// rodzin. Brak roli, zakresu albo MFA: ten sam ogólny `403 forbidden` i ślad
// `access.denied`. Trasy publiczne (właściciel tokenu) tej funkcji nie wołają.
async function requireBoardContext(request, env, roles = EDIT_ROLES) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const requirement = { roles, requireMfa: true };
  if (!isAuthorizedScoped(context, requirement)) {
    // #184: ślad odmowy 403 (przed transakcją żądania).
    await logAccessDenied(env, context, requirement, request);
    throw new RequestError('forbidden', 403);
  }
  return context;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// Identyfikator ze ścieżki: błędne kodowanie procentowe (np. `%E0%A4%A`) albo
// wartość spoza wzorca → 400 `invalid_request` PRZED sprawdzeniem sesji (jak
// dotąd validId w decideRequest/approveTemplate), zamiast nieprzechwyconego
// URIError → 503 z klasą `bug` (#748).
function pathId(raw) {
  return decodePathId(raw, { pattern: ID_PATTERN, notFound: () => new RequestError('invalid_request') });
}

// Klasy bieżących dzieci opiekuna — wyłącznie do podglądu formularza/kolejki
// (imię opiekuna + nazwa klasy, bez nazwisk, innych opiekunów i wpłat).
async function guardianPreview(env, guardianId) {
  const guardian = await env.db.query('SELECT first_name FROM guardians WHERE id = $1', [guardianId]);
  if (!guardian.rows[0]) return null;
  const classes = await env.db.query(
    `SELECT DISTINCT c.name FROM student_guardians_current sg
       JOIN enrollments_current e ON e.student_id = sg.student_id
       JOIN classes c ON c.id = e.class_id
      WHERE sg.guardian_id = $1
      ORDER BY c.name`,
    [guardianId],
  );
  return { guardianFirstName: guardian.rows[0].first_name, classNames: classes.rows.map((row) => row.name) };
}

// ---------- POST /api/admin/guardian-links ----------

async function issueLink(request, env, json) {
  const context = await requireBoardContext(request, env);
  const data = await readJson(request);
  if (!validId(data.guardianId)) throw new RequestError('invalid_request');
  const actorId = context.session.user.id;

  const guardian = await env.db.query('SELECT id FROM guardians WHERE id = $1', [data.guardianId]);
  if (!guardian.rows[0]) throw new RequestError('guardian_not_found', 404);

  const token = randomBytes(32).toString('hex');
  const linkId = crypto.randomUUID();
  // created_at i expires_at z tego samego zegara: CHECK (expires_at > created_at)
  // w migracji 0087 pozostaje spełniony także przy zegarze testowym.
  const issuedAt = clock(env);
  const expiresAt = new Date(issuedAt.getTime() + LINK_TTL_MS).toISOString();
  await env.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO guardian_update_links (id, guardian_id, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [linkId, data.guardianId, hashToken(token), actorId, issuedAt.toISOString(), expiresAt],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'guardian_update_link.created', entityType: 'guardian_update_link', entityId: linkId,
      metadata: { guardianId: data.guardianId },
    });
  });
  // Token w treści odpowiedzi WYŁĄCZNIE tu, raz — baza trzyma tylko skrót.
  // Nigdy nie wysyłać automatycznie (AGENTS.md): zarząd sam przekazuje link
  // (kartka, zatwierdzona kampania) poza tym wywołaniem.
  return json({ linkId, token, expiresAt }, 201);
}

// ---------- GET /api/public/guardian-update ----------

async function previewLink(request, env, url, json) {
  const token = url.searchParams.get('token') ?? '';
  if (!TOKEN_PATTERN.test(token)) return json({ error: 'invalid_or_expired_link' }, 404);
  const { rows } = await env.db.query(
    'SELECT guardian_id, expires_at, used_at FROM guardian_update_links WHERE token_hash = $1',
    [hashToken(token)],
  );
  const link = rows[0];
  // Ten sam komunikat dla złego i wygasłego/zużytego tokenu (bez wyroczni istnienia).
  if (!link || link.used_at || linkExpired(env, link)) {
    return json({ error: 'invalid_or_expired_link' }, 404);
  }
  const preview = await guardianPreview(env, link.guardian_id);
  if (!preview) return json({ error: 'invalid_or_expired_link' }, 404);
  return json(preview);
}

// ---------- POST /api/public/guardian-update ----------

function parseUpdateFields(data) {
  const input = {};
  if (Object.hasOwn(data, 'email')) {
    if (data.email === null || data.email === '') input.email = null;
    else if (typeof data.email === 'string') {
      const email = data.email.trim().toLowerCase();
      // Poza wzorcem z parseContactInput (families.js) adres musi przejść
      // normalizeEmail kolejki wysyłek — inaczej zatwierdzony adres i tak byłby
      // pominięty przez worker, a rodzic nie dowiedziałby się o literówce.
      if (email.length > 254 || !EMAIL_PATTERN.test(email) || normalizeEmail(email) !== email) {
        throw new RequestError('invalid_email');
      }
      input.email = email;
    } else throw new RequestError('invalid_email');
  }
  if (Object.hasOwn(data, 'contactAllowed')) {
    if (typeof data.contactAllowed !== 'boolean') throw new RequestError('invalid_request');
    input.contactAllowed = data.contactAllowed;
  }
  if (!Object.hasOwn(input, 'email') && !Object.hasOwn(input, 'contactAllowed')) throw new RequestError('invalid_request');
  if (data.note !== undefined && data.note !== null) {
    if (typeof data.note !== 'string' || data.note.length > MAX_NOTE_LENGTH) throw new RequestError('invalid_request');
    input.note = data.note;
  }
  return input;
}

async function submitUpdate(request, env, json) {
  const data = await readJson(request);
  if (typeof data.token !== 'string' || !TOKEN_PATTERN.test(data.token)) {
    return json({ error: 'invalid_or_expired_link' }, 404);
  }
  const input = parseUpdateFields(data);
  const tokenHash = hashToken(data.token);

  const result = await env.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT id, guardian_id, expires_at, used_at FROM guardian_update_links WHERE token_hash = $1 FOR UPDATE',
      [tokenHash],
    );
    const link = rows[0];
    if (!link || linkExpired(env, link)) throw new RequestError('invalid_or_expired_link', 404);
    // Jednorazowość: ponowne wysłanie tym samym tokenem — 409, bez drugiego
    // wniosku (AC #140). Odróżnione od "zły/wygasły token" celowo: to
    // odpowiedź na WŁASNE, wcześniej ważne żądanie, nie na zgadywanie.
    if (link.used_at) throw new RequestError('link_used', 409);

    // #152: uwaga opiekuna trafia do niezmiennego wniosku. Odrzucenie cofa transakcję,
    // więc link pozostaje nieużyty i można wysłać poprawiony tekst.
    const gate = gateFreeText([['guardian_update_requests.note', input.note ?? null]], { confirm: data.confirmPersonalData === true, fail: piiFail });
    await tx.query('UPDATE guardian_update_links SET used_at = now() WHERE id = $1', [link.id]);
    const requestId = crypto.randomUUID();
    await tx.query(
      `INSERT INTO guardian_update_requests (
         id, link_id, guardian_id, proposed_email, proposed_email_set,
         proposed_contact_allowed, proposed_contact_allowed_set, note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [requestId, link.id, link.guardian_id,
        Object.hasOwn(input, 'email') ? input.email : null, Object.hasOwn(input, 'email'),
        Object.hasOwn(input, 'contactAllowed') ? input.contactAllowed : null, Object.hasOwn(input, 'contactAllowed'),
        input.note ?? null],
    );
    // #140 pkt 5: wiersz weryfikacji tylko dla NOWEGO adresu (nie dla samej zgody
    // ani usunięcia adresu). W tej samej transakcji co wniosek — jeden wniosek,
    // jeden wiersz, klucz verify:{requestId}; podwójne wysłanie formularza kończy
    // się wyżej (409 link_used) bez drugiego wiersza.
    const verification = input.email
      ? await planVerification(tx, env, { requestId, guardianId: link.guardian_id, email: input.email })
      : null;
    await insertAuditEvent(tx, {
      actorId: null, action: 'guardian_update_request.created', entityType: 'guardian_update_request', entityId: requestId,
      metadata: {
        guardianId: link.guardian_id, ...piiAuditMetadata(gate),
        ...(verification ? {
          verificationId: verification.id, verification: verification.state,
          verificationReason: verification.reason, templateVersion: verification.templateVersion,
        } : {}),
      },
    });
    return { requestId, verification };
  });
  // Odpowiedź publiczna nie rozróżnia „zlecono” od „adres zablokowany”
  // (brak wyroczni listy wyłączeń, #94): `requested` = powstał wiersz weryfikacji
  // do wysyłki (stan widzi tylko zarząd w kolejce), `none` = kodu nie będzie.
  const requested = result.verification && ['queued', 'failed'].includes(result.verification.state);
  return json({ requestId: result.requestId, status: 'pending', emailVerification: requested ? 'requested' : 'none' }, 201);
}

// Plan weryfikacji nowego adresu przy złożeniu wniosku. Kolejność bramek:
// flaga → zatwierdzony szablon → opublikowana informacja o przetwarzaniu (D-06)
// → ograniczenie przetwarzania (#100) → lista wyłączeń (#94). Wynik zapisany
// jako wiersz (także `skipped` z powodem — API pokazuje wtedy `none` i powód).
async function planVerification(tx, env, { requestId, guardianId, email }) {
  const id = crypto.randomUUID();
  let state = 'queued';
  let reason = null;
  let template = null;
  let notice = null;
  if (!guardianVerifyEnabled(env)) {
    state = 'skipped';
    reason = 'verification_disabled';
  } else {
    const { rows } = await tx.query(
      "SELECT id, version FROM guardian_verify_templates WHERE status = 'approved' ORDER BY version DESC LIMIT 1",
    );
    template = rows[0] ?? null;
    notice = template ? await loadPublishedNotice(tx) : null;
    if (!template) { state = 'skipped'; reason = 'template_missing'; }
    else if (!notice) { state = 'skipped'; reason = 'privacy_notice_missing'; }
    else if ((await tx.query(GUARDIAN_RESTRICTED_SQL, [guardianId])).rows[0]) {
      state = 'skipped';
      reason = 'processing_restricted';
    } else {
      const suppressed = await tx.query('SELECT 1 FROM email_active_suppressions WHERE email_hash = $1', [emailHash(email)]);
      if (suppressed.rows[0]) { state = 'failed'; reason = 'address_suppressed'; }
    }
  }
  await tx.query(
    `INSERT INTO guardian_update_verifications (id, request_id, idempotency_key, template_id, privacy_notice_id, state, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, requestId, `verify:${requestId}`, template?.id ?? null, notice?.id ?? null, state, reason],
  );
  return { id, state, reason, templateVersion: template?.version ?? null };
}

// ---------- GET /api/admin/guardian-update-requests ----------

// #94: ostrzeżenie dla zatwierdzającego, gdy proponowany adres jest na
// liście wyłączeń (odbicie, skarga, wypisanie). Lista trzyma wyłącznie skrót
// adresu, więc porównujemy skróty; w odpowiedzi tylko powód blokady, bez
// skrótu. Zatwierdzenie NIE zdejmuje blokady (to osobna procedura dwóch osób,
// email.js) — wysyłka na taki adres pozostaje wstrzymana.
async function suppressionsByEmail(env, emails) {
  const byHash = new Map();
  for (const email of emails) {
    const normalized = normalizeEmail(email);
    if (normalized) byHash.set(emailHash(normalized), email);
  }
  const result = new Map();
  if (!byHash.size) return result;
  const { rows } = await env.db.query(
    'SELECT email_hash, reason FROM email_active_suppressions WHERE email_hash = ANY($1::text[])',
    [[...byHash.keys()]],
  );
  for (const row of rows) result.set(byHash.get(row.email_hash), row.reason);
  return result;
}

async function listRequests(request, env, url, json) {
  const context = await requireBoardContext(request, env);
  const status = url.searchParams.get('status') ?? 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new RequestError('invalid_request');
  // #159: keyset (created_at, id) zamiast LIMIT 200 bez sygnału obcięcia.
  const fail = (code) => { throw new RequestError(code); };
  const limit = parseListLimit(url.searchParams.get('limit'), { defaultLimit: 200, maxLimit: 200 }, fail);
  const scope = JSON.stringify(['guardian-update-requests', status]);
  const cursor = decodeListCursor(url.searchParams.get('cursor'), { kind: 'timestamp', scope }, fail);
  const values = [status];
  const after = cursor ? `AND ${afterTupleAscSql(['created_at', 'id'], [cursor.key, cursor.id], values, ['::timestamptz', ''])}` : '';
  const { rows: fetched } = await env.db.query(
    `SELECT id, guardian_id, proposed_email, proposed_email_set, proposed_contact_allowed,
            proposed_contact_allowed_set, note, created_at, ${cursorTimestampSql('created_at')} AS cursor_ts
       FROM guardian_update_requests
      WHERE status = $1 ${after}
      ORDER BY created_at, id
      LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(fetched, limit, (row) => ({ key: row.cursor_ts, id: row.id }), scope);
  const rows = page.items;
  const suppressed = await suppressionsByEmail(env, rows
    .filter((row) => row.proposed_email_set && row.proposed_email)
    .map((row) => row.proposed_email));
  const verifications = await verificationsByRequest(env.db, rows.map((row) => row.id));
  const now = clock(env);
  const requests = [];
  for (const row of rows) {
    const preview = await guardianPreview(env, row.guardian_id);
    const verification = verificationStatus(verifications.get(row.id) ?? null, now, {
      hasNewEmail: Boolean(row.proposed_email_set && row.proposed_email),
    });
    requests.push({
      id: row.id,
      guardianFirstName: preview?.guardianFirstName ?? null,
      classNames: preview?.classNames ?? [],
      proposedEmail: row.proposed_email_set ? row.proposed_email : undefined,
      proposedContactAllowed: row.proposed_contact_allowed_set ? row.proposed_contact_allowed : undefined,
      // Powód aktywnej blokady proponowanego adresu (#94) albo null.
      proposedEmailSuppression: row.proposed_email_set && row.proposed_email
        ? suppressed.get(row.proposed_email) ?? null
        : null,
      // #140 pkt 5: stan kodu weryfikacyjnego nowego adresu (bez adresu i kodu).
      verification: verification.status,
      verificationReason: verification.reason,
      verificationDelivery: verification.delivery,
      verificationExpiresAt: verification.expiresAt,
      note: row.note,
      createdAt: row.created_at,
    });
  }
  // #133: lista pokazuje imię opiekuna i proponowany adres — odczyt zostawia ślad
  // (bez danych osobowych i identyfikatorów opiekunów; tylko stan filtra i liczba).
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'guardian_update_request.list_viewed',
    entityType: 'guardian_update_request', entityId: status, metadata: { status, count: requests.length },
  });
  return json({ requests, nextCursor: page.nextCursor, truncated: page.truncated, limit });
}

async function verificationsByRequest(executor, requestIds, { lock = false } = {}) {
  const map = new Map();
  if (!requestIds.length) return map;
  const { rows } = await executor.query(
    `SELECT id, request_id, state, last_error, code_expires_at, failed_attempts, confirmed_at, send_started_at
       FROM guardian_update_verifications WHERE request_id = ANY($1::text[])${lock ? ' FOR UPDATE' : ''}`,
    [requestIds],
  );
  for (const row of rows) map.set(row.request_id, row);
  return map;
}

// ---------- POST /api/admin/guardian-update-requests/{id}/(approve|reject) ----------

async function decideRequest(request, env, requestId, decision, json) {
  if (!validId(requestId)) throw new RequestError('invalid_request');
  const context = await requireBoardContext(request, env);
  const actorId = context.session.user.id;

  const result = await env.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, guardian_id, status, proposed_email, proposed_email_set,
              proposed_contact_allowed, proposed_contact_allowed_set
         FROM guardian_update_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const current = rows[0];
    if (!current) throw new RequestError('request_not_found', 404);
    // Idempotentne: podwójne kliknięcie na już rozstrzygniętym wniosku nie
    // jest błędem — zwraca ten sam stan, bez drugiego zdarzenia audytu.
    if (current.status !== 'pending') return { status: current.status, changed: false };

    // #140 pkt 5: stan weryfikacji nowego adresu W CHWILI decyzji (do audytu
    // i odpowiedzi). Zatwierdzenie z niepotwierdzonym adresem jest dozwolone
    // (wskazanie 2026-10-02), ale zostawia w audycie pole `unverifiedContactChange`.
    const hasNewEmail = Boolean(current.proposed_email_set && current.proposed_email);
    const verificationRow = (await verificationsByRequest(tx, [requestId], { lock: true })).get(requestId) ?? null;
    const verification = verificationStatus(verificationRow, clock(env), { hasNewEmail });

    let changed = false;
    if (decision === 'approve') {
      const guardianRow = await tx.query('SELECT email, contact_allowed FROM guardians WHERE id = $1 FOR UPDATE', [current.guardian_id]);
      const guardian = guardianRow.rows[0];
      if (!guardian) throw new RequestError('guardian_not_found', 404);
      const nextEmail = current.proposed_email_set ? current.proposed_email : guardian.email ?? null;
      const nextContactAllowed = current.proposed_contact_allowed_set ? current.proposed_contact_allowed : guardian.contact_allowed;
      changed = nextEmail !== (guardian.email ?? null) || nextContactAllowed !== guardian.contact_allowed;
      if (changed) {
        await tx.query(
          `SELECT set_config('rd.actor_id', $1, true), set_config('rd.change_reason', $2, true),
                  set_config('rd.effective_on', '', true)`,
          [actorId, `parent_request:${requestId}`],
        );
        await tx.query('UPDATE guardians SET email = $2, contact_allowed = $3 WHERE id = $1',
          [current.guardian_id, nextEmail, nextContactAllowed]);
      }
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await tx.query(
      'UPDATE guardian_update_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1',
      [requestId, status, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: `guardian_update_request.${status}`, entityType: 'guardian_update_request', entityId: requestId,
      metadata: {
        guardianId: current.guardian_id,
        ...(hasNewEmail ? {
          verification: verification.status,
          ...(decision === 'approve' && verification.status !== 'confirmed' ? { unverifiedContactChange: true } : {}),
        } : {}),
      },
    });
    // Rozstrzygnięty wniosek: kod jeszcze niewysłany już nie wyjdzie (wiersz
    // w kolejce → cancelled). Wiersz w trakcie wysyłki zatrzyma worker
    // (potwierdzenie sprawdza, czy wniosek nadal oczekuje).
    if (verificationRow?.state === 'queued') {
      await tx.query(
        `UPDATE guardian_update_verifications SET state = 'cancelled', last_error = 'request_decided', updated_at = now()
          WHERE id = $1 AND state = 'queued'`,
        [verificationRow.id],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'guardian_update_request.verification_cancelled', entityType: 'guardian_update_request', entityId: requestId,
        metadata: { verificationId: verificationRow.id, reason: 'request_decided' },
      });
    }
    return { status, changed, verification: hasNewEmail ? verification.status : null };
  });
  return json({
    requestId, status: result.status, changed: result.changed,
    ...(result.verification ? { verification: result.verification } : {}),
  });
}

// ---------- POST /api/public/guardian-update/verify ----------

// Jedna odpowiedź dla złego tokenu, złego kodu, kodu wygasłego, wyczerpanego
// limitu prób, wniosku rozstrzygniętego i wniosku bez kodu (bez wyroczni).
const VERIFY_FAILED = Object.freeze({ error: 'invalid_or_expired_code' });

async function confirmCode(request, env, json) {
  const data = await readJson(request);
  if (typeof data.token !== 'string' || !TOKEN_PATTERN.test(data.token)
      || typeof data.code !== 'string' || !VERIFY_CODE_PATTERN.test(data.code)) {
    return json(VERIFY_FAILED, 400);
  }
  const now = clock(env);
  const outcome = await env.db.transaction(async (tx) => {
    // Ten sam jednorazowy token co formularz (już zużyty przez wniosek): wskazuje
    // DOKŁADNIE jeden wniosek i jego wiersz weryfikacji — kod innego wniosku
    // (np. drugiego opiekuna tego samego dziecka) nie pasuje do tej soli/skrótu.
    const { rows } = await tx.query(
      `SELECT v.id, v.request_id, v.code_salt, v.code_hash, v.code_expires_at, v.failed_attempts,
              v.confirmed_at, v.send_started_at, r.status AS request_status
         FROM guardian_update_links l
         JOIN guardian_update_requests r ON r.link_id = l.id
         JOIN guardian_update_verifications v ON v.request_id = r.id
        WHERE l.token_hash = $1
        FOR UPDATE OF v`,
      [hashToken(data.token)],
    );
    const row = rows[0];
    if (!row || row.request_status !== 'pending' || !row.code_hash || !row.send_started_at) return { ok: false };
    // Ponowienie po zgubionej odpowiedzi (podwójne kliknięcie): ten sam poprawny
    // kod po potwierdzeniu — ta sama odpowiedź, bez drugiego zdarzenia.
    if (row.confirmed_at) return { ok: codeMatches(row, data.code), replay: true };
    if (row.failed_attempts >= VERIFY_MAX_FAILED_ATTEMPTS || new Date(row.code_expires_at) <= now) return { ok: false };
    if (!codeMatches(row, data.code)) {
      const { rows: updated } = await tx.query(
        `UPDATE guardian_update_verifications SET failed_attempts = failed_attempts + 1, updated_at = now()
          WHERE id = $1 RETURNING failed_attempts`,
        [row.id],
      );
      await insertAuditEvent(tx, {
        actorId: null, action: 'guardian_update_request.verification_attempt_failed', entityType: 'guardian_update_request',
        entityId: row.request_id, metadata: { verificationId: row.id, failedAttempts: updated[0].failed_attempts },
      });
      return { ok: false };
    }
    await tx.query('UPDATE guardian_update_verifications SET confirmed_at = now(), updated_at = now() WHERE id = $1', [row.id]);
    await insertAuditEvent(tx, {
      actorId: null, action: 'guardian_update_request.verification_confirmed', entityType: 'guardian_update_request',
      entityId: row.request_id, metadata: { verificationId: row.id, failedAttempts: row.failed_attempts },
    });
    return { ok: true };
  });
  if (!outcome.ok) return json(VERIFY_FAILED, 400);
  return json({ verification: 'confirmed' });
}

// ---------- /api/admin/guardian-verify-templates ----------

const SUBJECT_MAX = 200;
const BODY_MAX = 4000;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

// Treść szablonu wpisuje zarząd — kod nie dostarcza wartości domyślnej (D-16).
function parseTemplate(data) {
  const subject = typeof data.subject === 'string' ? data.subject.trim() : '';
  const bodyText = typeof data.bodyText === 'string' ? data.bodyText.replace(/\r\n/g, '\n').trim() : '';
  if (subject.length < 3 || subject.length > SUBJECT_MAX || /[\n{}]/.test(subject) || CONTROL.test(subject)) {
    throw new RequestError('invalid_verify_template');
  }
  if (bodyText.length < 20 || bodyText.length > BODY_MAX || CONTROL.test(bodyText)) {
    throw new RequestError('invalid_verify_template');
  }
  const found = [...bodyText.matchAll(PLACEHOLDER)].map((match) => match[1]);
  const braces = (bodyText.match(/[{}]/g) ?? []).length;
  if (braces !== found.length * 2 || found.some((name) => !VERIFY_BODY_PLACEHOLDERS.includes(name))) {
    throw new RequestError('invalid_verify_template');
  }
  if (!found.includes('kod')) throw new RequestError('verify_code_placeholder_required');
  if (findForbiddenWording(subject) || findForbiddenWording(bodyText)) throw new RequestError('forbidden_wording');
  return { subject, bodyText };
}

function templateView(row) {
  return {
    id: row.id,
    version: row.version,
    subject: row.subject,
    bodyText: row.body_text,
    contentHash: row.content_hash,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  };
}

async function listTemplates(request, env, url, json) {
  await requireBoardContext(request, env);
  // #159: wersje od najnowszej, kursor keyset po `version` (unikalny, rośnie) zamiast
  // LIMIT 100 bez sygnału obcięcia. `limit` domyślnie i maksymalnie 100 (jak dotąd).
  const fail = (code) => { throw new RequestError(code); };
  const limit = parseListLimit(url.searchParams.get('limit'), { defaultLimit: 100, maxLimit: 100 }, fail);
  const scope = JSON.stringify(['guardian-verify-templates']);
  const cursor = decodeListCursor(url.searchParams.get('cursor'), { kind: 'text', scope }, fail);
  // Klucz kursora trafia do `::int`: kursor sfałszowany poza liczbą dałby błąd bazy zamiast 400.
  if (cursor && !/^\d{1,9}$/.test(cursor.key)) fail('invalid_cursor');
  const values = [];
  const after = cursor ? (values.push(cursor.key), `WHERE version < $${values.length}::int`) : '';
  const { rows: fetched } = await env.db.query(
    `SELECT * FROM guardian_verify_templates ${after} ORDER BY version DESC LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(fetched, limit, (row) => ({ key: String(row.version), id: row.id }), scope);
  // Obowiązuje najnowsza zatwierdzona wersja (tę zapisuje wniosek przy złożeniu); wyszukana
  // osobno, bo może leżeć poza bieżącą stroną (np. po wielu szkicach od ostatniego zatwierdzenia).
  const { rows: approved } = await env.db.query(
    "SELECT id FROM guardian_verify_templates WHERE status = 'approved' ORDER BY version DESC LIMIT 1",
  );
  return json({
    templates: page.items.map(templateView),
    currentTemplateId: approved[0]?.id ?? null,
    enabled: guardianVerifyEnabled(env),
    nextCursor: page.nextCursor,
    truncated: page.truncated,
    limit: page.limit,
  });
}

async function createTemplate(request, env, json) {
  const context = await requireBoardContext(request, env);
  const actorId = context.session.user.id;
  const { subject, bodyText } = parseTemplate(await readJson(request));
  const id = crypto.randomUUID();
  return env.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO guardian_verify_templates (id, subject, body_text, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, subject, bodyText, verifyTemplateHash({ subject, bodyText }), actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'guardian_verify_template.created', entityType: 'guardian_verify_template', entityId: id,
      metadata: { version: rows[0].version, contentHash: rows[0].content_hash },
    });
    return json({ template: templateView(rows[0]) }, 201);
  });
}

async function approveTemplate(request, env, id, json) {
  if (!validId(id)) throw new RequestError('invalid_request');
  const context = await requireBoardContext(request, env, TEMPLATE_APPROVE_ROLES);
  // #150 (SR-10, krok w górę): zatwierdzenie otwiera automatyczną wysyłkę do
  // rodziców — MFA musi być potwierdzone od niedawna (po sprawdzeniu roli).
  const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
  if (staleCode) throw new RequestError(staleCode, 403);
  const actorId = context.session.user.id;
  const data = await readJson(request);
  return env.db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT * FROM guardian_verify_templates WHERE id = $1 FOR UPDATE', [id]);
    const template = rows[0];
    if (!template) throw new RequestError('verify_template_not_found', 404);
    if (template.status === 'approved') {
      // Ponowienie (podwójne kliknięcie) — ten sam stan, bez drugiego zdarzenia.
      if (template.approved_by === actorId) return json({ template: templateView(template) }, 200, { 'Idempotency-Replayed': 'true' });
      throw new RequestError('verify_template_not_draft', 409);
    }
    if (template.created_by === actorId) throw new RequestError('self_approval_forbidden', 403);
    // Zatwierdzający potwierdza wersję treści, którą widział (jak skrót kampanii).
    if (data.contentHash !== undefined && data.contentHash !== template.content_hash) {
      throw new RequestError('verify_template_changed', 409);
    }
    const { rows: updated } = await tx.query(
      `UPDATE guardian_verify_templates SET status = 'approved', approved_by = $2, approved_at = now()
        WHERE id = $1 RETURNING *`,
      [id, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'guardian_verify_template.approved', entityType: 'guardian_verify_template', entityId: id,
      metadata: { version: template.version, contentHash: template.content_hash },
    });
    return json({ template: templateView(updated[0]) });
  });
}

export async function handle(request, env, url, json) {
  // Decyzja wyłącznie metodą POST (jak zatwierdzenie szablonu niżej): GET na tej
  // ścieżce omijałby kontrolę Origin i tryb tylko do odczytu routera.
  const decideMatch = request.method === 'POST'
    && url.pathname.match(/^\/api\/admin\/guardian-update-requests\/([^/]+)\/(approve|reject)$/);
  const isIssueLink = request.method === 'POST' && url.pathname === '/api/admin/guardian-links';
  const isPreview = request.method === 'GET' && url.pathname === '/api/public/guardian-update';
  const isSubmit = request.method === 'POST' && url.pathname === '/api/public/guardian-update';
  const isList = request.method === 'GET' && url.pathname === '/api/admin/guardian-update-requests';
  const isVerify = request.method === 'POST' && url.pathname === '/api/public/guardian-update/verify';
  const isTemplates = url.pathname === '/api/admin/guardian-verify-templates' && ['GET', 'POST'].includes(request.method);
  const templateApproveMatch = request.method === 'POST'
    && url.pathname.match(/^\/api\/admin\/guardian-verify-templates\/([^/]+)\/approve$/);
  if (!decideMatch && !isIssueLink && !isPreview && !isSubmit && !isList && !isVerify && !isTemplates && !templateApproveMatch) return null;

  try {
    if (isIssueLink) return await issueLink(request, env, json);
    if (isPreview) return await previewLink(request, env, url, json);
    if (isSubmit) return await submitUpdate(request, env, json);
    if (isList) return await listRequests(request, env, url, json);
    if (isVerify) return await confirmCode(request, env, json);
    if (isTemplates) return request.method === 'GET' ? await listTemplates(request, env, url, json) : await createTemplate(request, env, json);
    if (templateApproveMatch) return await approveTemplate(request, env, pathId(templateApproveMatch[1]), json);
    return await decideRequest(request, env, pathId(decideMatch[1]), decideMatch[2], json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
