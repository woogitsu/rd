// Pierwszy administrator na pustej bazie PostgreSQL (issue #187).
// Prototyp — nie jest gotowy do pracy na danych rodzin.
//
// Uruchamia operator z dostępem do DATABASE_URL (scripts/bootstrap-admin.js,
// `npm run auth:bootstrap-admin -- <email>`). Funkcja:
// - działa wyłącznie wtedy, gdy nie istnieje żaden aktywny administrator
//   (przydział `admin` niecofnięty, niewygasły, konto niewyłączone) i nie
//   czeka żadne ważne zaproszenie do roli `admin`,
// - zakłada konto z podanym adresem (albo używa istniejącego, niewyłączonego
//   konta bez aktywnej roli admin) i wydaje jednorazowe zaproszenie do roli
//   `admin` istniejącym mechanizmem (createInvitation). Rolę nadaje dopiero
//   przyjęcie zaproszenia (POST /api/invitations/accept na gałęzi logowania),
//   które ustawia też hasło; MFA administrator włącza po zalogowaniu,
// - zapisuje zdarzenie `auth.bootstrap_issued` bez e-maila i bez tokenu;
//   aktor techniczny `system:bootstrap` (actor_id = NULL, bo audit_events
//   wskazuje users),
// - odmawia przy APP_ENV=production bez jawnej zgody (allowProduction).
// Surowy token zwracany jest wyłącznie wywołującemu; w bazie zostaje SHA-256.

import { isProductionEnv, isProductionLikeEnv } from '../app-env.js';
import { insertAuditEvent } from './audit.js';
import { createInvitation } from './auth.js';

export const BOOTSTRAP_ACTOR = 'system:bootstrap';
// Założenie do potwierdzenia (D-08, D-10): zaproszenie startowe ważne 24 h, najwyżej 72 h.
export const BOOTSTRAP_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const BOOTSTRAP_MAX_TTL_SECONDS = 72 * 60 * 60;

export class BootstrapRefused extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BootstrapRefused('invalid_email');
  return value;
}

// Re-eksport: jedna implementacja w src/app-env.js (#166).
export { isProductionEnv };

// db: kontrakt src/db.js (albo PGlite). Zwraca { userId, userCreated, invitationId, secret, expiresAt }.
export async function bootstrapAdmin(db, {
  email, displayName = 'Administrator', appEnv, allowProduction = false, ttlSeconds = BOOTSTRAP_DEFAULT_TTL_SECONDS,
} = {}) {
  if (!db || typeof db.transaction !== 'function') throw new Error('database_unavailable');
  if (isProductionLikeEnv(appEnv) && allowProduction !== true) throw new BootstrapRefused('production_requires_flag');
  const normalized = normalizeEmail(email);
  const ttl = Math.max(60 * 60, Math.min(Number(ttlSeconds) || BOOTSTRAP_DEFAULT_TTL_SECONDS, BOOTSTRAP_MAX_TTL_SECONDS));
  const name = String(displayName ?? '').trim().slice(0, 120) || 'Administrator';

  return db.transaction(async (tx) => {
    // Dwa równoległe uruchomienia: drugie czeka na koniec pierwszego i widzi
    // jego zaproszenie, więc powstaje co najwyżej jeden ważny token.
    await tx.query('LOCK TABLE users, role_grants, invitations IN SHARE ROW EXCLUSIVE MODE');

    const admins = await tx.query(
      `SELECT count(*)::int AS n
         FROM role_grants g JOIN users u ON u.id = g.user_id
        WHERE g.role = 'admin' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND u.disabled_at IS NULL`,
    );
    if (admins.rows[0].n > 0) throw new BootstrapRefused('admin_exists');

    const pending = await tx.query(
      `SELECT min(expires_at) AS expires_at FROM invitations
        WHERE role = 'admin' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    );
    if (pending.rows[0].expires_at) {
      throw new BootstrapRefused('pending_admin_invitation', { expiresAt: new Date(pending.rows[0].expires_at).toISOString() });
    }

    let userCreated = false;
    let user = (await tx.query(
      'SELECT id, disabled_at FROM users WHERE lower(email) = $1 ORDER BY created_at, id LIMIT 1',
      [normalized],
    )).rows[0];
    if (user?.disabled_at) throw new BootstrapRefused('user_disabled');
    if (!user) {
      user = { id: crypto.randomUUID() };
      await tx.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [user.id, normalized, name]);
      userCreated = true;
      await insertAuditEvent(tx, {
        actorId: null, action: 'user.created', entityType: 'user', entityId: user.id,
        metadata: { source: 'bootstrap', actor: BOOTSTRAP_ACTOR },
      });
    }

    // createInvitation w tej samej transakcji; created_by musi wskazywać konto
    // (FK), więc jest nim zapraszany — aktora technicznego zapisuje zdarzenie niżej.
    const txEnv = { db: { query: (...args) => tx.query(...args), transaction: (fn) => fn(tx) } };
    const invitation = await createInvitation(txEnv, { actorId: user.id, email: normalized, role: 'admin', ttlSeconds: ttl });

    await insertAuditEvent(tx, {
      actorId: null, action: 'auth.bootstrap_issued', entityType: 'invitation', entityId: invitation.invitationId,
      metadata: { actor: BOOTSTRAP_ACTOR, userId: user.id, userCreated, role: 'admin', expiresAt: invitation.expiresAt },
    });
    return { userId: user.id, userCreated, invitationId: invitation.invitationId, secret: invitation.secret, expiresAt: invitation.expiresAt };
  });
}
