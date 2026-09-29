// Lokalna, automatyczna próba odtworzenia (restore drill) na SYNTETYCZNYCH
// danych (issue #90). Nie łączy się z Railway ani z żadnym zdalnym serwerem:
// wymaga lokalnego PostgreSQL (127.0.0.1 / ::1 / gniazdo) z prawem CREATE
// DATABASE i odmawia każdego innego hosta.
//
// Przebieg (prawdziwe pg_dump / pg_restore, ta sama logika co w produkcji):
//   1. dwie tymczasowe bazy: źródłowa i docelowa,
//   2. migracje + zestaw scripts/lib/synthetic-seed.js (rodzeństwo, dwoje
//      opiekunów, wpłaty częściowe, korekty) + wpisy księgi i audytu,
//   3. runBackup: zrzut w migawce z raportem, szyfrowanie RSA/AES-GCM, zapis
//      do magazynu w pamięci, wpis w backup_runs,
//   4. runRestoreDrill: SHA-256, odszyfrowanie, pg_restore do bazy docelowej,
//      migrator ("No pending migrations."), raport i porównanie z punktem
//      odniesienia z kroku 3,
//   5. usunięcie obu baz (chyba że keepDatabases).
// Raport zawiera wyłącznie liczności, sumy w centach i skróty SHA-256.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createMemoryStorage } from '../../src/storage.js';
import { runBackup, runRestoreDrill } from '../../src/pg/backup.js';
import { buildRestoreReport } from '../../src/pg/restore-report.js';
import { applyMigrations, loadMigrations } from '../../src/postgres-migrations.js';
import { insertRows, insertSyntheticData } from './synthetic-seed.js';
import { dumpWithReport, restoreInto } from './pg-tools.js';

const migrationsDirectory = fileURLToPath(new URL('../../postgres/migrations/', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function drillError(code) {
  return Object.assign(new Error(code), { code });
}

// Twarda blokada: tylko serwer lokalny. Adres nigdy nie trafia do komunikatu.
export function assertLocalServer(adminUrl) {
  let url;
  try { url = new URL(adminUrl); } catch { throw drillError('local_drill_url_invalid'); }
  const host = decodeURIComponent(url.hostname);
  const socketHost = url.searchParams.get('host');
  const isLocal = LOCAL_HOSTS.has(host) || host.startsWith('/') || (host === '' && (socketHost ?? '').startsWith('/'));
  if (!isLocal) throw drillError('local_drill_requires_local_postgres');
}

function databaseUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(admin, name) {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
}

// Dane spoza zestawu podstawowego: księga (wpływ i wydatek) i zdarzenia audytu
// — tabele, na których próba sprawdza sumy i wyzwalacze tylko do dopisywania.
async function insertLedgerAndAudit(client, year) {
  await insertRows(client, 'ledger_categories', ['id', 'school_year_id', 'direction', 'name', 'created_by'], [
    ['lc-in', year, 'income', 'Składki dobrowolne', 'u0001'],
    ['lc-out', year, 'expense', 'Wydatki klasowe', 'u0001'],
  ]);
  await insertRows(client, 'ledger_entries',
    ['id', 'school_year_id', 'direction', 'amount_cents', 'category_id', 'description', 'occurred_on', 'method', 'created_by', 'idempotency_key'], [
      ['le-1', year, 'income', '150000', 'lc-in', 'Wpływ syntetyczny 1', '2026-10-02', 'bank', 'u0001', 'drill-ledger-0001'],
      ['le-2', year, 'income', '25050', 'lc-in', 'Wpływ syntetyczny 2', '2026-10-03', 'cash', 'u0001', 'drill-ledger-0002'],
      ['le-3', year, 'expense', '40025', 'lc-out', 'Wydatek syntetyczny', '2026-10-04', 'bank', 'u0001', 'drill-ledger-0003'],
    ]);
  await insertRows(client, 'audit_events', ['id', 'actor_id', 'action', 'entity_type', 'entity_id'],
    Array.from({ length: 5 }, (_, i) => [`ae-${i + 1}`, 'u0001', 'payment.recorded', 'payment_entry', `p000${i + 1}`]));
}

/**
 * @param {object} options
 * @param {string} options.adminUrl adres LOKALNEGO serwera z prawem CREATE DATABASE
 * @param {(sourceClient: pg.Client) => Promise<void>} [options.afterBackup] zmiana źródła po kopii
 *   (dowód, że punktem odniesienia jest migawka kopii, nie żywa baza)
 * @param {(targetClient: pg.Client, sourceClient: pg.Client) => Promise<void>} [options.inspectTarget]
 * @param {(storage: object, objectKey: string) => void} [options.tamperStorage] psucie kopii w magazynie
 * @param {(targetClient: pg.Client) => Promise<void>} [options.mutateTarget] psucie odtworzonej bazy
 *   tuż przed raportem (test wykrywania utraty wiersza)
 * @param {boolean} [options.keepDatabases]
 */
export async function runLocalRestoreDrill({ adminUrl, afterBackup, inspectTarget, tamperStorage, mutateTarget, keepDatabases = false }) {
  assertLocalServer(adminUrl);
  const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
  const sourceName = `rd_drill_src_${suffix}`;
  const targetName = `rd_drill_dst_${suffix}`;
  const sourceUrl = databaseUrl(adminUrl, sourceName);
  const targetUrl = databaseUrl(adminUrl, targetName);

  const admin = new pg.Client({ connectionString: adminUrl });
  let source;
  let target;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${sourceName}`);
    await admin.query(`CREATE DATABASE ${targetName}`);
    source = new pg.Client({ connectionString: sourceUrl });
    target = new pg.Client({ connectionString: targetUrl });
    await source.connect();
    await target.connect();

    const migrations = await loadMigrations(migrationsDirectory);
    await applyMigrations(source, migrations);
    const seed = await insertSyntheticData({ exec: (sql) => source.query(sql) });
    await insertLedgerAndAudit({ exec: (sql) => source.query(sql) }, 'y2026');

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const storage = createMemoryStorage();
    const backup = await runBackup({
      db: source, storage, encryptPublicKeyPem: publicKey, environment: 'local',
      dump: () => dumpWithReport(sourceUrl),
    });
    if (afterBackup) await afterBackup(source);
    if (tamperStorage) tamperStorage(storage, backup.objectKey);

    const restoreStartedAt = Date.now();
    const report = await runRestoreDrill({
      db: source, storage, decryptPrivateKeyPem: privateKey, sourceUrl, targetUrl, environment: 'local',
      restore: (plaintext) => restoreInto(targetUrl, plaintext),
      migrateTarget: () => applyMigrations(target, migrations),
      reportQuery: async () => {
        if (mutateTarget) await mutateTarget(target);
        return buildRestoreReport((sql, params) => target.query(sql, params));
      },
    });
    const restoreMs = Date.now() - restoreStartedAt;
    if (inspectTarget) await inspectTarget(target, source);
    return {
      report, restoreMs, backupSizeBytes: backup.sizeBytes,
      seed: { students: seed.students.length, households: seed.households.length, payments: seed.payments.length, corrections: seed.corrections.length },
    };
  } finally {
    await source?.end().catch(() => {});
    await target?.end().catch(() => {});
    if (!keepDatabases) {
      await dropDatabase(admin, sourceName);
      await dropDatabase(admin, targetName);
    }
    await admin.end().catch(() => {});
  }
}
