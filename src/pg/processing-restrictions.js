// Ograniczenie przetwarzania (RODO art. 18, #100): nałożenie i zdjęcie jako
// kolejne wiersze tabeli processing_restrictions (0178) — nic nie jest
// nadpisywane ani usuwane. Moduł nie zna HTTP; trasy w routes/admin.js.
//
// Założenia do D-07 (zachowawcze): ograniczenie nakłada administrator po
// weryfikacji tożsamości na podstawie żądania rodzaju `restriction` albo
// `objection`; podmiot wynika z żądania (gospodarstwo, w drugiej kolejności
// opiekun). Samo żądanie ucznia nie wskazuje podmiotu, który można
// ograniczyć — obsługujący rejestruje żądanie na gospodarstwo lub opiekuna.
// Zdarzenia nie zawierają danych osobowych: identyfikator żądania, rodzaj
// podmiotu i identyfikator zapisu.

import { insertAuditEvent } from './audit.js';

export const RESTRICTION_REQUEST_KINDS = ['restriction', 'objection'];

export class ProcessingRestrictionError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Bieżący stan ograniczeń: zbiory identyfikatorów gospodarstw i opiekunów.
// Jedyna definicja „ograniczonego” dla migawki kampanii; worker i kartki
// używają widoku processing_restricted_subjects bezpośrednio.
export async function loadProcessingRestrictions(executor) {
  const { rows } = await executor.query('SELECT household_id, guardian_id FROM processing_restricted_subjects');
  return {
    households: new Set(rows.filter((row) => row.household_id).map((row) => row.household_id)),
    guardians: new Set(rows.filter((row) => row.guardian_id).map((row) => row.guardian_id)),
  };
}

// Podmiot ograniczenia wynikający z żądania: gospodarstwo, potem opiekun.
export function restrictionSubject(request) {
  if (request.household_id) return { type: 'household', householdId: request.household_id, guardianId: null };
  if (request.guardian_id) return { type: 'guardian', householdId: null, guardianId: request.guardian_id };
  return null;
}

async function currentlyRestricted(tx, subject) {
  const { rows } = await tx.query(
    `SELECT action FROM processing_restrictions
      WHERE household_id IS NOT DISTINCT FROM $1 AND guardian_id IS NOT DISTINCT FROM $2
      ORDER BY seq DESC LIMIT 1`,
    [subject.householdId, subject.guardianId],
  );
  return rows[0]?.action === 'restrict';
}

// Nakłada (`restrict`) albo zdejmuje (`lift`) ograniczenie dla podmiotu żądania.
// Powtórzenie tego samego przejścia (podwójne kliknięcie, ponowienie) nie dopisuje
// wiersza ani zdarzenia i zwraca changed: false.
export async function changeProcessingRestriction(tx, actorId, requestId, action) {
  const { rows } = await tx.query(
    `SELECT id, kind, status, household_id, guardian_id FROM data_subject_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  const request = rows[0];
  if (!request) throw new ProcessingRestrictionError('data_request_not_found', 404);
  if (!RESTRICTION_REQUEST_KINDS.includes(request.kind)) throw new ProcessingRestrictionError('data_request_kind_not_restrictable', 409);
  if (request.status === 'received') throw new ProcessingRestrictionError('data_request_identity_not_verified', 409);
  // Nałożenie wymaga żądania w toku; zdjęcie może się powołać także na żądanie już rozstrzygnięte
  // (ograniczenie trwa po odpowiedzi), ale nie na odrzucone.
  if (request.status === 'rejected') throw new ProcessingRestrictionError('data_request_closed', 409);
  if (action === 'restrict' && request.status === 'answered') throw new ProcessingRestrictionError('data_request_closed', 409);
  const subject = restrictionSubject(request);
  if (!subject) throw new ProcessingRestrictionError('data_request_subject_not_restrictable', 409);
  // Serializacja zmian jednego podmiotu (dwa równoległe kliknięcia).
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd_processing_restriction:${subject.householdId ?? subject.guardianId}`]);
  const restricted = await currentlyRestricted(tx, subject);
  if ((action === 'restrict') === restricted) return { changed: false, restricted, subjectType: subject.type };
  const id = crypto.randomUUID();
  await tx.query(
    `INSERT INTO processing_restrictions (id, request_id, household_id, guardian_id, action, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, requestId, subject.householdId, subject.guardianId, action, actorId],
  );
  await insertAuditEvent(tx, {
    actorId,
    action: action === 'restrict' ? 'processing_restriction.applied' : 'processing_restriction.lifted',
    entityType: 'processing_restriction', entityId: id,
    metadata: { requestId, subjectType: subject.type },
  });
  return { changed: true, restricted: action === 'restrict', subjectType: subject.type, id };
}

// Historia ograniczeń podmiotu żądania (od najstarszego): bez danych osobowych.
export async function listProcessingRestrictions(executor, requestId) {
  const { rows } = await executor.query(
    `SELECT household_id, guardian_id FROM data_subject_requests WHERE id = $1`, [requestId],
  );
  if (!rows[0]) throw new ProcessingRestrictionError('data_request_not_found', 404);
  const subject = restrictionSubject(rows[0]);
  if (!subject) return { subjectType: null, restricted: false, events: [] };
  const { rows: events } = await executor.query(
    `SELECT id, request_id, action, created_by, created_at FROM processing_restrictions
      WHERE household_id IS NOT DISTINCT FROM $1 AND guardian_id IS NOT DISTINCT FROM $2
      ORDER BY seq`,
    [subject.householdId, subject.guardianId],
  );
  return {
    subjectType: subject.type,
    restricted: events.length > 0 && events[events.length - 1].action === 'restrict',
    events: events.map((row) => ({
      id: row.id, requestId: row.request_id, action: row.action, createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
