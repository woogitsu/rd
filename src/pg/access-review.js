// Przegląd dostępu po kadencji (#133, pkt 6): konta z przydziałami ról w roku,
// ostatni odczyt danych rodzin i PROPOZYCJA odebrania. Wyłącznie odczyt:
// nic nie jest odbierane automatycznie. Decyzję podejmuje administrator
// jawnie, istniejącą trasą POST /api/admin/grants/{id}/revoke (MFA, zdarzenie
// audytu, blokada ostatniego admina). Bez imion i e-maili — konto to
// identyfikator, przydział to rola i zakres. Wariant zachowawczy do D-04/D-08/
// D-09: dziennik odczytu czyta tylko admin.
import { isoTimestamp } from './auth.js';

export const ACCESS_REVIEW_MAX_ROWS = 500;

const SCOPE = `(g.school_year_id = $1 OR g.class_id IN (SELECT c.id FROM classes c WHERE c.school_year_id = $1))`;
const LOG_SCOPE = `(l.school_year_id = $1 OR l.class_id IN (SELECT c.id FROM classes c WHERE c.school_year_id = $1))`;

export function proposalFor({ status, yearEnded, readsWithoutValidGrant }) {
  if (status === 'active' && yearEnded) return { proposal: 'revoke', reason: 'school_year_ended' };
  if (readsWithoutValidGrant > 0) return { proposal: 'review', reason: 'reads_without_valid_grant' };
  return { proposal: 'keep', reason: null };
}

export async function accessReview(executor, schoolYearId) {
  const year = (await executor.query(
    `SELECT y.id, to_char(y.ends_on, 'YYYY-MM-DD') AS ends_on, (y.ends_on < rd_today()) AS ended,
            (SELECT c.status FROM school_year_closures c WHERE c.school_year_id = y.id) AS closure_status
       FROM school_years y WHERE y.id = $1`,
    [schoolYearId],
  )).rows[0];
  if (!year) return null;
  const { rows } = await executor.query(
    `SELECT g.id, g.user_id, g.role, g.class_id, g.school_year_id, g.granted_at, g.expires_at, g.revoked_at,
            CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN g.expires_at IS NOT NULL AND g.expires_at <= now() THEN 'expired'
                 ELSE 'active' END AS status,
            (SELECT max(l.last_seen_at) FROM data_access_log l
              WHERE l.actor_id = g.user_id AND l.outcome = 'ok') AS last_read_at,
            (SELECT COALESCE(sum(l.hit_count), 0) FROM data_access_log l
              WHERE l.actor_id = g.user_id AND l.outcome = 'ok' AND ${LOG_SCOPE}) AS reads_in_scope,
            (SELECT COALESCE(sum(l.hit_count), 0) FROM data_access_log l
              WHERE l.actor_id = g.user_id AND l.outcome = 'ok' AND ${LOG_SCOPE}
                AND NOT EXISTS (
                  SELECT 1 FROM role_grants v
                   WHERE v.user_id = l.actor_id AND v.granted_at <= l.occurred_at
                     AND (v.revoked_at IS NULL OR v.revoked_at > l.occurred_at)
                     AND (v.expires_at IS NULL OR v.expires_at > l.occurred_at))) AS reads_without_valid_grant
       FROM role_grants g
      WHERE ${SCOPE}
      ORDER BY (CASE WHEN g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) THEN 0 ELSE 1 END),
               g.user_id, g.role, g.id
      LIMIT ${ACCESS_REVIEW_MAX_ROWS + 1}`,
    [schoolYearId],
  );
  const yearEnded = Boolean(year.ended) || year.closure_status === 'closed';
  const visible = rows.slice(0, ACCESS_REVIEW_MAX_ROWS).map((row) => {
    const readsWithoutValidGrant = Number(row.reads_without_valid_grant);
    return {
      grantId: row.id,
      userId: row.user_id,
      role: row.role,
      classId: row.class_id ?? null,
      schoolYearId: row.school_year_id ?? null,
      status: row.status,
      grantedAt: isoTimestamp(row.granted_at),
      expiresAt: row.expires_at ? isoTimestamp(row.expires_at) : null,
      revokedAt: row.revoked_at ? isoTimestamp(row.revoked_at) : null,
      lastReadAt: row.last_read_at ? isoTimestamp(row.last_read_at) : null,
      readsInScope: Number(row.reads_in_scope),
      readsWithoutValidGrant,
      ...proposalFor({ status: row.status, yearEnded, readsWithoutValidGrant }),
    };
  });
  const count = (proposal) => visible.filter((g) => g.proposal === proposal).length;
  return {
    informational: true,
    automaticRevocation: false,
    schoolYear: { id: year.id, endsOn: year.ends_on, closed: year.closure_status === 'closed', ended: yearEnded },
    summary: {
      grants: visible.length,
      active: visible.filter((g) => g.status === 'active').length,
      proposedRevoke: count('revoke'),
      proposedReview: count('review'),
    },
    truncated: rows.length > ACCESS_REVIEW_MAX_ROWS,
    grants: visible,
  };
}
