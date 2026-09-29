// Niezmienne, zatwierdzane migawki sprawozdania rocznego (#125, migracja 0138).
// Prototyp — nie jest wdrożony.
//
// Migawka = JSON sprawozdania (bez czasu generowania) + SHA-256 kanonicznego
// JSON-a. Zapis migawki i zdarzenie audytu powstają w jednej transakcji
// REPEATABLE READ z odczytem sum (jedna chwila bazy, jak w #213). Zdarzenia
// audytu niosą identyfikatory, rok i skrót — nigdy treść sprawozdania ani powód
// korekty. Korekta = nowa migawka wskazująca poprzednią (supersedes_id).
//
// Współbieżność: unikalność (rok, skrót), jedna migawka bez poprzednika w roku
// i jeden następca migawki pilnują indeksy w bazie. Przegrana w wyścigu
// (23505/40001) powtarza całą transakcję — druga próba widzi już zapis
// zwycięzcy i zwraca go (replayed) albo odpowiada 409.

import { insertAuditEvent } from './audit.js';
import { buildAnnualReport, payloadSha256, snapshotPayload } from './annual-report.js';

export class ReportError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const MAX_ATTEMPTS = 4;
const iso = (value) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value));

function mapDatabaseError(error) {
  const message = String(error?.message ?? '');
  const known = [
    ['school_year_closed', 'school_year_closed', 409],
    ['school_year_closure_is_final', 'school_year_closed', 409],
    ['report_snapshot_four_eyes', 'four_eyes_required', 403],
    ['report_snapshot_superseded', 'report_snapshot_superseded', 409],
    ['report_snapshot_supersedes_mismatch', 'invalid_request', 400],
    ['report_snapshot_not_found', 'report_snapshot_not_found', 404],
  ];
  for (const [needle, code, status] of known) {
    if (message.includes(needle)) throw new ReportError(code, status);
  }
  throw error;
}

const isRace = (error) => error?.code === '23505' || error?.code === '40001';

function summary(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    kind: row.kind,
    sha256: row.content_sha256,
    supersedesId: row.supersedes_id ?? null,
    supersededById: row.superseded_by_id ?? null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    approvedBy: row.approved_by ?? null,
    approvedAt: iso(row.approved_at),
  };
}

const STATUS_COLUMNS = `id, school_year_id, kind, content_sha256, supersedes_id, supersede_reason, created_by, created_at,
  superseded_by_id, approved_by, approved_at`;

export async function loadSnapshotYear(db, snapshotId) {
  const { rows } = await db.query('SELECT school_year_id FROM financial_report_snapshots WHERE id = $1', [snapshotId]);
  return rows[0]?.school_year_id ?? null;
}

export async function listSnapshots(db, schoolYearId) {
  const { rows } = await db.query(
    `SELECT ${STATUS_COLUMNS} FROM financial_report_snapshot_status
      WHERE school_year_id = $1 ORDER BY created_at, id`,
    [schoolYearId],
  );
  return rows.map(summary);
}

// Zwraca { snapshot, report, integrityOk } albo null. integrityOk = skrót
// przeliczony z zapisanej treści zgadza się ze skrótem zapisanym przy tworzeniu.
export async function readSnapshotById(executor, snapshotId) {
  const { rows } = await executor.query(
    `SELECT ${STATUS_COLUMNS}, (SELECT payload FROM financial_report_snapshots p WHERE p.id = v.id) AS payload
       FROM financial_report_snapshot_status v WHERE id = $1`,
    [snapshotId],
  );
  const row = rows[0];
  if (!row) return null;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return { snapshot: summary(row), report: payload, integrityOk: payloadSha256(payload) === row.content_sha256 };
}

// Tworzy migawkę z bieżących danych księgi. Zwraca { snapshot, replayed }.
export async function createSnapshot(db, { actorId, schoolYearId, supersedesId = null, reason = null, id = null }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const built = await buildAnnualReport(tx, schoolYearId);
        if (!built) throw new ReportError('school_year_not_found', 404);
        const payload = snapshotPayload(built);
        const sha256 = payloadSha256(payload);

        const existing = (await tx.query(
          `SELECT ${STATUS_COLUMNS} FROM financial_report_snapshot_status
            WHERE school_year_id = $1 AND kind = 'annual' AND content_sha256 = $2`,
          [schoolYearId, sha256],
        )).rows[0];
        if (existing) {
          // Ta sama treść co bieżąca migawka: podwójne kliknięcie / ponowienie. Ta sama treść co
          // migawka zastąpiona = korekta cofnęłaby księgę do starego stanu — bez nowego zapisu.
          if (existing.superseded_by_id) throw new ReportError('report_snapshot_content_exists', 409);
          return { snapshot: summary(existing), replayed: true };
        }

        const head = (await tx.query(
          `SELECT id FROM financial_report_snapshot_status
            WHERE school_year_id = $1 AND kind = 'annual' AND superseded_by_id IS NULL`,
          [schoolYearId],
        )).rows[0];
        if (head) {
          if (!supersedesId) throw new ReportError('report_snapshot_supersedes_required', 409);
          if (supersedesId !== head.id) throw new ReportError('report_snapshot_superseded', 409);
          if (!reason) throw new ReportError('invalid_reason');
        } else if (supersedesId || reason) {
          throw new ReportError('invalid_request');
        }

        const snapshotId = id ?? `frs-${crypto.randomUUID()}`;
        try {
          await tx.query(
            `INSERT INTO financial_report_snapshots
               (id, school_year_id, kind, payload, content_sha256, supersedes_id, supersede_reason, created_by)
             VALUES ($1, $2, 'annual', $3::jsonb, $4, $5, $6, $7)`,
            [snapshotId, schoolYearId, JSON.stringify(payload), sha256, head ? supersedesId : null, head ? reason : null, actorId],
          );
        } catch (error) {
          if (isRace(error)) throw error;
          mapDatabaseError(error);
        }
        await insertAuditEvent(tx, {
          actorId, action: 'report.snapshot.created', entityType: 'financial_report_snapshot', entityId: snapshotId,
          metadata: { schoolYearId, kind: 'annual', sha256, supersedesId: head ? supersedesId : null },
        });
        const created = (await tx.query(
          `SELECT ${STATUS_COLUMNS} FROM financial_report_snapshot_status WHERE id = $1`, [snapshotId],
        )).rows[0];
        return { snapshot: summary(created), replayed: false };
      });
    } catch (error) {
      if (isRace(error) && attempt < MAX_ATTEMPTS) continue;
      if (isRace(error)) throw new ReportError('conflict', 409);
      throw error;
    }
  }
}

// Zatwierdza migawkę (inna osoba niż autor — pilnuje też trigger w bazie).
// Powtórne zatwierdzenie zwraca istniejące bez nowego zapisu. READ COMMITTED:
// trigger zatwierdzenia bierze FOR UPDATE na migawce i widzi następcę
// zapisanego równolegle.
export async function approveSnapshot(db, { actorId, snapshotId }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const row = (await tx.query(
          `SELECT ${STATUS_COLUMNS} FROM financial_report_snapshot_status WHERE id = $1`, [snapshotId],
        )).rows[0];
        if (!row) throw new ReportError('report_snapshot_not_found', 404);
        if (row.approved_at) return { snapshot: summary(row), replayed: true };
        if (row.superseded_by_id) throw new ReportError('report_snapshot_superseded', 409);
        if (row.created_by === actorId) throw new ReportError('four_eyes_required', 403);
        try {
          await tx.query(
            `INSERT INTO financial_report_snapshot_approvals (snapshot_id, school_year_id, approved_by)
             VALUES ($1, $2, $3)`,
            [snapshotId, row.school_year_id, actorId],
          );
        } catch (error) {
          if (isRace(error)) throw error;
          mapDatabaseError(error);
        }
        await insertAuditEvent(tx, {
          actorId, action: 'report.snapshot.approved', entityType: 'financial_report_snapshot', entityId: snapshotId,
          metadata: { schoolYearId: row.school_year_id, kind: row.kind, sha256: row.content_sha256 },
        });
        const approved = (await tx.query(
          `SELECT ${STATUS_COLUMNS} FROM financial_report_snapshot_status WHERE id = $1`, [snapshotId],
        )).rows[0];
        return { snapshot: summary(approved), replayed: false };
      });
    } catch (error) {
      if (isRace(error) && attempt < MAX_ATTEMPTS) continue;
      if (isRace(error)) throw new ReportError('conflict', 409);
      throw error;
    }
  }
}
