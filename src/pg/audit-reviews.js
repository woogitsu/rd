// Ścieżka kontroli Komisji Rewizyjnej (#137, migracja 0172): uwagi, odpowiedzi,
// zamknięcia i wnioski końcowe w niezmiennej tabeli audit_review_notes.
// Prototyp — nie jest wdrożony.
//
// Zapis i zdarzenie audytu powstają w jednej transakcji. Zdarzenia niosą
// identyfikatory, rodzaj i cel — nigdy treść uwagi (wolny tekst jest tylko w
// tabeli biznesowej, za bramką danych osobowych). Klucz idempotencji jest
// wymagany: ten sam klucz i ta sama treść odtwarza zapis (replayed), ten sam
// klucz z inną treścią to 409 idempotency_conflict.

import { insertAuditEvent } from './audit.js';

export const NOTE_KINDS = Object.freeze(['question', 'finding']);
export const TARGET_TYPES = Object.freeze(['ledger_entry', 'reconciliation', 'year']);
export const BODY_MIN = 3;
export const BODY_MAX = 2000;

export class AuditReviewError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value));

function mapDatabaseError(error) {
  const message = String(error?.message ?? '');
  const known = [
    ['school_year_closed', 'school_year_closed', 409],
    ['school_year_closure_is_final', 'school_year_closed', 409],
    ['audit_review_target_not_found', 'audit_review_target_not_found', 404],
    ['audit_review_parent_invalid', 'audit_review_not_found', 404],
    ['audit_review_closed', 'audit_review_closed', 409],
    ['audit_review_four_eyes', 'four_eyes_required', 403],
  ];
  for (const [needle, code, status] of known) {
    if (message.includes(needle)) throw new AuditReviewError(code, status);
  }
  throw error;
}

const COLUMNS = 'id, school_year_id, kind, target_type, target_id, parent_id, body, created_by, created_at, idempotency_key';

function present(row) {
  return {
    id: row.id,
    kind: row.kind,
    targetType: row.target_type,
    targetId: row.target_id,
    parentId: row.parent_id ?? null,
    body: row.body ?? null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

/** Wiersz uwagi z danego roku albo null (rok z URL musi zgadzać się z rokiem uwagi). */
export async function loadNote(executor, schoolYearId, noteId) {
  const { rows } = await executor.query(
    `SELECT ${COLUMNS} FROM audit_review_notes WHERE id = $1 AND school_year_id = $2`,
    [noteId, schoolYearId],
  );
  return rows[0] ?? null;
}

/**
 * Wątki (korzeń + odpowiedzi + zamknięcie) i wnioski końcowe roku, w kolejności
 * zapisu. Stan wątku: open (bez odpowiedzi), answered, closed.
 */
export async function listReviews(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT ${COLUMNS} FROM audit_review_notes WHERE school_year_id = $1 ORDER BY created_at, id`,
    [schoolYearId],
  );
  const threads = new Map();
  const conclusions = [];
  for (const row of rows) {
    if (row.kind === 'question' || row.kind === 'finding') {
      threads.set(row.id, { ...present(row), status: 'open', answers: [], closed: null });
    } else if (row.kind === 'conclusion') {
      conclusions.push(present(row));
    }
  }
  for (const row of rows) {
    const thread = threads.get(row.parent_id);
    if (!thread) continue;
    if (row.kind === 'answer') {
      thread.answers.push(present(row));
      if (thread.status === 'open') thread.status = 'answered';
    } else if (row.kind === 'closed') {
      thread.closed = present(row);
      thread.status = 'closed';
    }
  }
  const list = [...threads.values()];
  return {
    threads: list,
    conclusions,
    currentConclusion: conclusions.at(-1) ?? null,
    counts: {
      open: list.filter((t) => t.status === 'open').length,
      answered: list.filter((t) => t.status === 'answered').length,
      closed: list.filter((t) => t.status === 'closed').length,
    },
  };
}

function sameContent(row, input) {
  return row.created_by === input.actorId && row.school_year_id === input.schoolYearId && row.kind === input.kind
    && row.target_type === input.targetType && row.target_id === input.targetId
    && (row.parent_id ?? null) === (input.parentId ?? null) && (row.body ?? null) === (input.body ?? null);
}

const AUDIT = Object.freeze({
  question: { action: 'audit_review.note_added' },
  finding: { action: 'audit_review.note_added' },
  answer: { action: 'audit_review.answered' },
  closed: { action: 'audit_review.closed' },
  conclusion: { action: 'audit_review.conclusion_recorded' },
});

/**
 * Dopisuje jeden zapis. input: { actorId, schoolYearId, kind, targetType,
 * targetId, parentId?, body?, idempotencyKey, auditMetadata? }.
 * Zwraca { note, replayed }.
 */
export async function appendNote(db, input) {
  const load = async (executor) => (await executor.query(
    `SELECT ${COLUMNS} FROM audit_review_notes WHERE idempotency_key = $1`, [input.idempotencyKey],
  )).rows[0] ?? null;
  const replay = (row) => {
    if (!sameContent(row, input)) throw new AuditReviewError('idempotency_conflict', 409);
    return { note: present(row), replayed: true };
  };
  const existing = await load(db);
  if (existing) return replay(existing);
  const id = `arn-${crypto.randomUUID()}`;
  try {
    await db.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO audit_review_notes
             (id, school_year_id, kind, target_type, target_id, parent_id, body, created_by, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, input.schoolYearId, input.kind, input.targetType, input.targetId, input.parentId ?? null,
            input.body ?? null, input.actorId, input.idempotencyKey],
        );
      } catch (error) {
        if (error?.code === '23505') throw error;
        mapDatabaseError(error);
      }
      await insertAuditEvent(tx, {
        actorId: input.actorId, action: AUDIT[input.kind].action, entityType: 'audit_review_note', entityId: id,
        metadata: {
          schoolYearId: input.schoolYearId, kind: input.kind, targetType: input.targetType, targetId: input.targetId,
          ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.auditMetadata ?? {}),
        },
      });
    });
  } catch (error) {
    if (error?.code === '23505') {
      // Równoległe podwójne kliknięcie albo zamknięcie wątku, które wygrało wyścig.
      const winner = await load(db);
      if (winner) return replay(winner);
      if (input.kind === 'closed') throw new AuditReviewError('audit_review_closed', 409);
    }
    throw error;
  }
  return { note: present(await load(db)), replayed: false };
}
