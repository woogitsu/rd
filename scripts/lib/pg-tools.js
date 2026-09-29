// Wspólne kroki pg_dump / pg_restore dla skryptów kopii zapasowej i próby
// odtworzenia (issue #90) oraz dla lokalnej próby na syntetycznych danych
// (scripts/restore-drill-local.js). Nie loguje adresów baz ani stderr narzędzi
// (mogą zawierać nazwy hostów) — błąd niesie tylko stały kod.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildRestoreReport } from '../../src/pg/restore-report.js';

function run(command, args, errorCode) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => reject(Object.assign(new Error(errorCode), { code: errorCode })));
    child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(errorCode), { code: errorCode }))));
  });
}

// Zrzut w formacie custom razem z raportem liczonym w TEJ SAMEJ migawce
// (pg_export_snapshot + pg_dump --snapshot) — raport jest więc dokładnym
// punktem odniesienia dla odtworzenia, nawet gdy baza dalej przyjmuje zapisy.
// Plik tymczasowy (katalog 0700) jest usuwany także przy błędzie.
export async function dumpWithReport(connectionString) {
  const client = new pg.Client({ connectionString });
  const dir = await mkdtemp(join(tmpdir(), 'rd-backup-'));
  const file = join(dir, 'dump.custom');
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query('SELECT pg_export_snapshot() AS id');
    const report = await buildRestoreReport((sql, params) => client.query(sql, params));
    await run('pg_dump', ['--format=custom', `--snapshot=${rows[0].id}`, '--file', file, '--dbname', connectionString], 'pg_dump_failed');
    return { plaintext: await readFile(file), report };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// pg_restore do bazy docelowej. Format custom ładuje dane (COPY) przed
// utworzeniem wyzwalaczy i kluczy obcych, więc tabele tylko do dopisywania
// nie wymagają --disable-triggers (sprawdza to test lokalny).
export async function restoreInto(targetUrl, plaintextBuffer) {
  const dir = await mkdtemp(join(tmpdir(), 'rd-restore-'));
  const file = join(dir, 'dump.custom');
  try {
    await writeFile(file, plaintextBuffer, { mode: 0o600 });
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', targetUrl, file], 'pg_restore_failed');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
