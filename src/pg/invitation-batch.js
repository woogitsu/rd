// Zaproszenia zbiorcze przedstawicieli klas (#108). Prototyp — nie jest
// wdrożony i nie jest gotowy do pracy na danych rodzin.
//
//   POST /api/admin/invitation-batches/preview  { schoolYearId, text, ttlHours? }
//        podgląd: każdy wiersz „klasa; e-mail” z numerem wiersza wklejonego
//        tekstu, kodem błędu przy wierszu błędnym i `planDigest`. Nic nie zapisuje.
//   POST /api/admin/invitation-batches/apply    to samo + { planDigest }; nagłówek Idempotency-Key
//        jedno zatwierdzenie → osobne zaproszenia (każde z własnym zdarzeniem
//        `invitation.created` z `batchId`) i zdarzenie partii
//        `invitation.batch_created` — wszystko w JEDNEJ transakcji: albo cała
//        partia, albo nic. Tokeny wracają wyłącznie w tej odpowiedzi, raz.
//
// Idempotencja bez nowej tabeli: zdarzenie partii ma entity_type
// 'invitation_batch' i entity_id = Idempotency-Key. Ponowienie z tym samym
// kluczem (podwójne kliknięcie, zerwane połączenie) czeka na blokadę doradczą
// klucza i zwraca 200 `replayed: true` z listą zaproszeń partii BEZ tokenów
// (baza ma tylko skróty) — kod, który zginął, wydaje się ponownie przez
// „Wyślij ponownie” przy zaproszeniu. Ten sam klucz z innym planem: 409.
//
// Założenia do decyzji zarządu (wariant zachowawczy):
// - D-08 (kto zaprasza przedstawicieli): wyłącznie admin z MFA potwierdzonym
//   od niedawna (krok w górę jak POST /api/admin/invitations); zarząd nie ma
//   tu ani zapisu, ani odczytu, jak w całym module admina.
// - D-16/D-17 (szablon, nadawca): moduł NIE wysyła e-maili i nie dodaje nic do
//   kolejki Brevo — token przekazuje operator (lista do skopiowania lub
//   kartka do wydruku w admin/).
// - Rola zawsze `representative`, klasa z roku `schoolYearId`.
//
// Metadane audytu: wyłącznie identyfikatory (bez adresów e-mail, bez tekstu partii).

import { createHash } from 'node:crypto';
import { insertInvitation, isoTimestamp, normalizeEmail } from './auth.js';
import { insertAuditEvent } from './audit.js';
import { ApiError, readIdempotencyKey, readJsonObject } from './input.js';

export const INVITATION_BATCH_MAX_ROWS = 100;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 24 * 1024;
const MAX_CLASS_REF = 60;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROLE = 'representative';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// Wiersz „klasa; e-mail” (także przecinek lub tabulator — kopiowanie z arkusza).
// Numer wiersza = numer linii wklejonego tekstu (1…), więc komunikat
// „wiersz 7” wskazuje tę samą linię, którą widzi administrator. Puste linie
// i linie od „#” są pomijane; pierwsza linia bez „@” z nagłówkiem „e-mail”
// także (nagłówek arkusza).
export function parseInvitationBatchText(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new ApiError('invalid_invitation_batch_text');
  const rows = [];
  let seenContent = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const separator = [';', '\t', ','].find((candidate) => line.includes(candidate));
    const fields = separator ? line.split(separator).map((field) => field.trim()) : [line];
    const first = !seenContent;
    seenContent = true;
    if (first && fields.length === 2 && !fields[1].includes('@') && /mail/i.test(fields[1])) continue;
    const rowNumber = index + 1;
    if (fields.length !== 2 || !fields[0] || !fields[1]) {
      rows.push({ row: rowNumber, classRef: null, email: null, error: 'invalid_row_format' });
    } else if (fields[0].length > MAX_CLASS_REF) {
      rows.push({ row: rowNumber, classRef: null, email: fields[1].slice(0, 254), error: 'class_not_found' });
    } else {
      rows.push({ row: rowNumber, classRef: fields[0], email: fields[1].slice(0, 320) });
    }
    if (rows.length > INVITATION_BATCH_MAX_ROWS) throw new ApiError('too_many_rows');
  }
  if (!rows.length) throw new ApiError('invitation_batch_empty', 422);
  return rows;
}

function readTtlHours(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > 24 * 14) throw new ApiError('invalid_ttl');
  return value;
}

function readInput(data) {
  if (!validId(data.schoolYearId)) throw new ApiError('invalid_school_year_id');
  return { schoolYearId: data.schoolYearId, ttlHours: readTtlHours(data.ttlHours), rows: parseInvitationBatchText(data.text) };
}

// Skrót planu: rok, ważność i dokładna lista (wiersz, klasa, adres) po
// rozpoznaniu klas — zatwierdzenie dotyczy dokładnie tego, co pokazał podgląd.
export function invitationBatchDigest({ schoolYearId, ttlHours, rows }) {
  return sha256(JSON.stringify({
    schoolYearId, ttlHours: ttlHours ?? null, rows: rows.map((item) => [item.row, item.classId ?? null, item.email ?? null, item.error ?? null]),
  }));
}

// Sprawdza wiersze względem bazy (w transakcji zapisu przy apply — pod blokadami).
// Zwraca wiersze z classId/className/email (znormalizowanym), `existingAccount`
// i ewentualnym kodem błędu. Kody wiersza: invalid_row_format, invalid_email,
// class_not_found, duplicate_row, cannot_grant_self, invitation_pending,
// representative_already_assigned.
async function checkRows(executor, { actorId, schoolYearId, rows }) {
  const year = await executor.query('SELECT 1 FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) throw new ApiError('school_year_not_found', 404);
  const { rows: classes } = await executor.query('SELECT id, name FROM classes WHERE school_year_id = $1', [schoolYearId]);
  const byId = new Map(classes.map((item) => [item.id, item]));
  const byName = new Map(classes.map((item) => [item.name.trim().toLowerCase(), item]));
  const actor = (await executor.query('SELECT lower(email) AS email FROM users WHERE id = $1', [actorId])).rows[0];

  const checked = rows.map((item) => {
    if (item.error) return { ...item, classId: null, className: null };
    const klass = byId.get(item.classRef) ?? byName.get(item.classRef.toLowerCase());
    let email = item.email;
    let error = null;
    try { email = normalizeEmail(item.email); } catch { error = 'invalid_email'; }
    if (!klass) return { row: item.row, classRef: item.classRef, classId: null, className: null, email, error: 'class_not_found' };
    if (!error && actor && email === actor.email) error = 'cannot_grant_self';
    return { row: item.row, classRef: item.classRef, classId: klass.id, className: klass.name, email, error };
  });

  const seen = new Set();
  for (const item of checked) {
    if (item.error) continue;
    const key = `${item.classId}\u0000${item.email}`;
    if (seen.has(key)) item.error = 'duplicate_row';
    seen.add(key);
  }

  const emails = [...new Set(checked.filter((item) => !item.error).map((item) => item.email))];
  if (emails.length) {
    const pending = await executor.query(
      `SELECT lower(email) AS email, class_id FROM invitations
        WHERE lower(email) = ANY($1::text[]) AND role = $2 AND school_year_id = $3
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [emails, ROLE, schoolYearId],
    );
    const pendingKeys = new Set(pending.rows.map((row) => `${row.class_id}\u0000${row.email}`));
    const granted = await executor.query(
      `SELECT lower(u.email) AS email, g.class_id FROM role_grants g JOIN users u ON u.id = g.user_id
        WHERE lower(u.email) = ANY($1::text[]) AND g.role = $2 AND g.school_year_id = $3
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`,
      [emails, ROLE, schoolYearId],
    );
    const grantedKeys = new Set(granted.rows.map((row) => `${row.class_id}\u0000${row.email}`));
    const accounts = await executor.query('SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])', [emails]);
    const accountEmails = new Set(accounts.rows.map((row) => row.email));
    for (const item of checked) {
      if (item.error) continue;
      const key = `${item.classId}\u0000${item.email}`;
      if (grantedKeys.has(key)) item.error = 'representative_already_assigned';
      else if (pendingKeys.has(key)) item.error = 'invitation_pending';
      item.existingAccount = accountEmails.has(item.email);
    }
  }
  return checked.map((item) => ({
    row: item.row, classRef: item.classRef ?? null, classId: item.classId, className: item.className,
    email: item.email ?? null, existingAccount: Boolean(item.existingAccount), error: item.error ?? null,
  }));
}

function summary(input, rows) {
  const invalid = rows.filter((item) => item.error).length;
  return {
    schoolYearId: input.schoolYearId, ttlHours: input.ttlHours, rows,
    counts: { total: rows.length, valid: rows.length - invalid, invalid },
    planDigest: invitationBatchDigest({ ...input, rows }),
  };
}

async function previewRoute(env, actorId, request, json) {
  const input = readInput(await readJsonObject(request, { maxBytes: MAX_BODY_BYTES }));
  const rows = await checkRows(env.db, { actorId, ...input });
  return json(summary(input, rows));
}

async function replay(tx, event, planDigest) {
  const metadata = typeof event.metadata_json === 'string' ? JSON.parse(event.metadata_json) : event.metadata_json;
  if (metadata?.planDigest !== planDigest) throw new ApiError('idempotency_key_reused', 409);
  const ids = Array.isArray(metadata.invitationIds) ? metadata.invitationIds : [];
  const { rows } = await tx.query(
    `SELECT i.id, i.email, i.class_id, c.name AS class_name, i.expires_at,
            CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                 WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN i.expires_at <= now() THEN 'expired'
                 ELSE 'pending' END AS status
       FROM invitations i LEFT JOIN classes c ON c.id = i.class_id
      WHERE i.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    batchId: event.entity_id, schoolYearId: metadata.schoolYearId ?? null, planDigest, replayed: true,
    invitations: ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
      id: row.id, email: row.email, classId: row.class_id, className: row.class_name,
      expiresAt: isoTimestamp(row.expires_at),
      status: row.status,
    })),
  };
}

async function applyRoute(env, actorId, request, json) {
  const key = readIdempotencyKey(request);
  const data = await readJsonObject(request, { maxBytes: MAX_BODY_BYTES });
  const input = readInput(data);
  if (typeof data.planDigest !== 'string' || !HEX64.test(data.planDigest)) throw new ApiError('invalid_plan_digest');

  const result = await env.db.transaction(async (tx) => {
    // Podwójne kliknięcie i ponowienie po zerwanym połączeniu czekają tutaj,
    // a po zatwierdzeniu pierwszego widzą jego zdarzenie partii.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd:invitation_batch:${key}`]);
    const previous = await tx.query(
      `SELECT entity_id, metadata_json FROM audit_events
        WHERE action = 'invitation.batch_created' AND entity_type = 'invitation_batch' AND entity_id = $1
        LIMIT 1`,
      [key],
    );
    if (previous.rows[0]) return { status: 200, body: await replay(tx, previous.rows[0], data.planDigest) };

    // Blokady adresów (ta sama przestrzeń co createInvitation/rejectPending, #208)
    // w stałej kolejności — równoległe „Zaproś” i druga partia z tym samym
    // adresem czekają, więc sprawdzenie oczekujących poniżej jest aktualne.
    const lockEmails = [...new Set(input.rows.flatMap((item) => {
      try { return [normalizeEmail(item.email)]; } catch { return []; }
    }))].sort();
    for (const email of lockEmails) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd:invitation:${email}`]);

    const rows = await checkRows(tx, { actorId, ...input });
    const plan = summary(input, rows);
    if (plan.planDigest !== data.planDigest) throw new ApiError('invitation_batch_stale', 409);
    if (plan.counts.invalid) throw new ApiError('invitation_batch_invalid', 422);

    const batchId = key;
    const ttlSeconds = input.ttlHours ? input.ttlHours * 3600 : undefined;
    const invitations = [];
    for (const item of rows) {
      const created = await insertInvitation(tx, {
        actorId, email: item.email, role: ROLE, classId: item.classId, schoolYearId: input.schoolYearId, ttlSeconds, batchId,
      });
      invitations.push({
        row: item.row, id: created.invitationId, email: item.email, classId: item.classId, className: item.className,
        expiresAt: created.expiresAt, status: 'pending', token: created.secret,
      });
    }
    await insertAuditEvent(tx, {
      actorId, action: 'invitation.batch_created', entityType: 'invitation_batch', entityId: batchId,
      metadata: {
        schoolYearId: input.schoolYearId, planDigest: plan.planDigest, count: invitations.length,
        invitationIds: invitations.map((item) => item.id),
      },
    });
    return { status: 201, body: { batchId, schoolYearId: input.schoolYearId, planDigest: plan.planDigest, replayed: false, invitations } };
  });
  return json(result.body, result.status);
}

// segments: ścieżka po /api/admin/, np. ['invitation-batches', 'preview'].
// Zwraca undefined dla nieznanej ścieżki (router admina odpowie 404/405).
export function routeInvitationBatches(env, actorId, request, segments, json) {
  const [, action] = segments;
  if (segments.length !== 2 || request.method !== 'POST') return undefined;
  if (action === 'preview') return previewRoute(env, actorId, request, json);
  if (action === 'apply') return applyRoute(env, actorId, request, json);
  return undefined;
}

export function invitationBatchAllowedMethods(segments) {
  const [, action] = segments;
  if (segments.length === 2 && (action === 'preview' || action === 'apply')) return ['POST'];
  return null;
}
