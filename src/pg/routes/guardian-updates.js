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
// przydziału klasowego (SR-01, jak board.js/#131); brak weryfikacji nowego
// e-maila kodem (poza zakresem tego PR).

import { createHash, randomBytes } from 'node:crypto';
import { isAuthorizedScoped, loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { createJsonReader } from '../input.js';
import { emailHash, normalizeEmail } from '../../email/content.js';

export const name = 'guardian-updates';

const EDIT_ROLES = ['admin', 'board'];
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
async function requireBoardContext(request, env) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles: EDIT_ROLES })) {
    // #184: ślad odmowy 403 (przed transakcją żądania).
    await logAccessDenied(env, context, { roles: EDIT_ROLES }, request);
    throw new RequestError('forbidden', 403);
  }
  return context;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
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
    await insertAuditEvent(tx, {
      actorId: null, action: 'guardian_update_request.created', entityType: 'guardian_update_request', entityId: requestId,
      metadata: { guardianId: link.guardian_id, linkId: link.id, ...piiAuditMetadata(gate) },
    });
    return { requestId };
  });
  return json({ requestId: result.requestId, status: 'pending' }, 201);
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
  const { rows } = await env.db.query(
    `SELECT id, guardian_id, proposed_email, proposed_email_set, proposed_contact_allowed,
            proposed_contact_allowed_set, note, created_at
       FROM guardian_update_requests
      WHERE status = $1
      ORDER BY created_at, id
      LIMIT 200`,
    [status],
  );
  const suppressed = await suppressionsByEmail(env, rows
    .filter((row) => row.proposed_email_set && row.proposed_email)
    .map((row) => row.proposed_email));
  const requests = [];
  for (const row of rows) {
    const preview = await guardianPreview(env, row.guardian_id);
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
  return json({ requests });
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
      metadata: { guardianId: current.guardian_id },
    });
    return { status, changed };
  });
  return json({ requestId, status: result.status, changed: result.changed });
}

export async function handle(request, env, url, json) {
  const decideMatch = url.pathname.match(/^\/api\/admin\/guardian-update-requests\/([^/]+)\/(approve|reject)$/);
  const isIssueLink = request.method === 'POST' && url.pathname === '/api/admin/guardian-links';
  const isPreview = request.method === 'GET' && url.pathname === '/api/public/guardian-update';
  const isSubmit = request.method === 'POST' && url.pathname === '/api/public/guardian-update';
  const isList = request.method === 'GET' && url.pathname === '/api/admin/guardian-update-requests';
  if (!decideMatch && !isIssueLink && !isPreview && !isSubmit && !isList) return null;

  try {
    if (isIssueLink) return await issueLink(request, env, json);
    if (isPreview) return await previewLink(request, env, url, json);
    if (isSubmit) return await submitUpdate(request, env, json);
    if (isList) return await listRequests(request, env, url, json);
    return await decideRequest(request, env, decodeURIComponent(decideMatch[1]), decideMatch[2], json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
