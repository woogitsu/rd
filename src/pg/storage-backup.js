// Kopia prywatnego magazynu dokumentów, tylko nowe obiekty, zweryfikowana
// względem `documents.sha256` (issue #103). Nigdy nie usuwa w celu — moduł
// nie importuje ani nie wywołuje `deleteObject` na magazynie docelowym.
//
// Zapis przebiegu do `backup_runs` (issue #90, migracja 0058, kind =
// 'storage_backup') jest OPCJONALNY i sprawdzany dynamicznie
// (`to_regclass('backup_runs')`): jeśli #90 nie jest jeszcze scalone na tej
// gałęzi/bazie, przebieg działa normalnie (kopiuje i weryfikuje), tylko bez
// zapisu w dzienniku — raport i tak trafia na stdout skryptu CLI. Po
// scaleniu #90 zapis zaczyna działać bez dalszych zmian tutaj.

import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../storage.js';

const DOCS_PREFIX = 'docs/';
const PAGE_SIZE = 200;

function storageBackupError(code, extra) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Strona wierszy `documents` z kluczem obiektu, w porządku klucza — pozwala
// wznowić po przerwaniu w połowie listy (kryterium akceptacji #103).
async function documentPage(db, afterKey) {
  const { rows } = await db.query(
    `SELECT object_key, sha256 FROM documents
     WHERE object_key IS NOT NULL AND sha256 IS NOT NULL AND object_key LIKE $1
       AND ($2::text IS NULL OR object_key > $2)
     ORDER BY object_key LIMIT $3`,
    [`${DOCS_PREFIX}%`, afterKey ?? null, PAGE_SIZE],
  );
  return rows;
}

async function allSourceKeys(sourceStorage) {
  const keys = [];
  let token;
  do {
    const page = await sourceStorage.listObjects(DOCS_PREFIX, token);
    keys.push(...page.keys);
    token = page.isTruncated ? page.nextContinuationToken : null;
  } while (token);
  return keys;
}

// Kopiuje obiekty `documents` (z kluczem i skrótem) brakujące w magazynie
// docelowym, weryfikuje skrót źródła i kopii względem `documents.sha256`,
// i raportuje osierocone/brakujące obiekty. Bez usuwania po żadnej stronie.
export async function runStorageBackup({ db, sourceStorage, targetStorage, startAfterKey = null }) {
  const report = {
    copied: 0, alreadyVerified: 0, missingInSource: 0, hashMismatches: 0, orphanedInSource: 0,
  };
  let cursor = startAfterKey;
  let hasMore = true;
  const seenDocumentKeys = new Set();

  while (hasMore) {
    const page = await documentPage(db, cursor);
    if (!page.length) { hasMore = false; break; }
    for (const doc of page) {
      seenDocumentKeys.add(doc.object_key);
      cursor = doc.object_key;
      if (await targetStorage.headObject(doc.object_key)) { report.alreadyVerified += 1; continue; }

      let source;
      try {
        source = await sourceStorage.getObject(doc.object_key);
      } catch (error) {
        if (error?.code === 'storage_object_not_found') { report.missingInSource += 1; continue; }
        throw error;
      }
      if (sha256Hex(source.body) !== doc.sha256) { report.hashMismatches += 1; continue; }

      await targetStorage.putObject(doc.object_key, source.body, source.contentType);
      const copy = await targetStorage.getObject(doc.object_key);
      if (sha256Hex(copy.body) !== doc.sha256) throw storageBackupError('storage_backup_copy_verification_failed');
      report.copied += 1;
    }
    hasMore = page.length === PAGE_SIZE;
  }

  // Osierocone: obiekty w źródle bez wiersza `documents` z hashem — dopiero
  // po pełnym przejściu listy dokumentów (seenDocumentKeys pokrywa wszystkie
  // strony tylko przy pełnym przebiegu, tj. startAfterKey === null).
  if (startAfterKey === null) {
    const sourceKeys = await allSourceKeys(sourceStorage);
    report.orphanedInSource = sourceKeys.filter((key) => !seenDocumentKeys.has(key)).length;
  }

  return { ...report, nextCursor: cursor };
}

export async function backupRunsTableExists(db) {
  const { rows } = await db.query("SELECT to_regclass('backup_runs') AS t");
  return rows[0]?.t != null;
}

export async function recordStorageBackupRun(db, { environment, result, report, errorCode = null, startedAt, finishedAt = new Date() }) {
  if (!(await backupRunsTableExists(db))) return { recorded: false };
  await db.query(
    `INSERT INTO backup_runs (id, kind, environment, started_at, finished_at, result, row_counts, error_code)
     VALUES ($1, 'storage_backup', $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), environment, startedAt, finishedAt, result, report ? JSON.stringify(report) : null, errorCode],
  );
  return { recorded: true };
}
