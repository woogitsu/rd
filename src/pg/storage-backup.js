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

const PAGE_SIZE = 200;

// Dwa zbiory obiektów w prywatnym buckecie: dokumenty (`docs/`, tabela
// `documents`) i pliki zdjęć galerii (`photos/`, tabela `news_photo_files`,
// migracja 0084). Nazwy tabel są stałe (nie z wejścia).
export const BACKUP_SETS = Object.freeze([
  Object.freeze({ name: 'documents', prefix: 'docs/', table: 'documents' }),
  Object.freeze({ name: 'photos', prefix: 'photos/', table: 'news_photo_files' }),
]);

function storageBackupError(code, extra) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Strona wierszy z kluczem obiektu, w porządku klucza — pozwala wznowić po
// przerwaniu w połowie listy (kryterium akceptacji #103).
async function rowPage(db, set, afterKey) {
  const { rows } = await db.query(
    `SELECT object_key, sha256 FROM ${set.table}
     WHERE object_key IS NOT NULL AND sha256 IS NOT NULL AND object_key LIKE $1
       AND ($2::text IS NULL OR object_key > $2)
     ORDER BY object_key LIMIT $3`,
    [`${set.prefix}%`, afterKey ?? null, PAGE_SIZE],
  );
  return rows;
}

async function allSourceKeys(sourceStorage, prefix) {
  const keys = [];
  let token;
  do {
    const page = await sourceStorage.listObjects(prefix, token);
    keys.push(...page.keys);
    token = page.isTruncated ? page.nextContinuationToken : null;
  } while (token);
  return keys;
}

// Kopiuje obiekty `documents` i `news_photo_files` (z kluczem i skrótem)
// brakujące w magazynie docelowym, weryfikuje skrót źródła i kopii względem
// kolumny `sha256` i raportuje osierocone/brakujące obiekty. Bez usuwania po
// żadnej stronie. Pola najwyższego poziomu to sumy; `bySet` rozbija je na
// dokumenty i zdjęcia. `startAfterKey` dotyczy tylko `docs/` (wznowienie).
// `verifyTarget: true` dodatkowo pobiera już istniejące kopie i porównuje ich
// SHA-256 z kolumną `sha256` (pełna kontrola integralności kopii, np. raz w
// tygodniu); niezgodna kopia jest tylko zgłaszana jako `targetHashMismatches`
// (nie jest nadpisywana ani usuwana). Bez tej opcji istniejący obiekt liczy się
// jako `alreadyVerified` po samej obecności klucza (obiekty `docs/` i `photos/`
// są niezmienne: klucz zawiera identyfikator).
export async function runStorageBackup({ db, sourceStorage, targetStorage, startAfterKey = null, verifyTarget = false }) {
  const empty = () => ({
    copied: 0, alreadyVerified: 0, missingInSource: 0, hashMismatches: 0, orphanedInSource: 0, targetHashMismatches: 0,
  });
  const bySet = {};
  let cursor = startAfterKey;

  for (const set of BACKUP_SETS) {
    const report = empty();
    bySet[set.name] = report;
    const resumed = set.prefix === 'docs/' ? startAfterKey : null;
    let setCursor = resumed;
    let hasMore = true;
    const seenKeys = new Set();

    while (hasMore) {
      const page = await rowPage(db, set, setCursor);
      if (!page.length) { hasMore = false; break; }
      for (const row of page) {
        seenKeys.add(row.object_key);
        setCursor = row.object_key;
        if (await targetStorage.headObject(row.object_key)) {
          if (verifyTarget) {
            let existing = null;
            try {
              existing = await targetStorage.getObject(row.object_key);
            } catch (error) {
              if (error?.code !== 'storage_object_not_found') throw error;
            }
            if (!existing || sha256Hex(existing.body) !== row.sha256) { report.targetHashMismatches += 1; continue; }
          }
          report.alreadyVerified += 1;
          continue;
        }

        let source;
        try {
          source = await sourceStorage.getObject(row.object_key);
        } catch (error) {
          if (error?.code === 'storage_object_not_found') { report.missingInSource += 1; continue; }
          throw error;
        }
        if (sha256Hex(source.body) !== row.sha256) { report.hashMismatches += 1; continue; }

        await targetStorage.putObject(row.object_key, source.body, source.contentType);
        const copy = await targetStorage.getObject(row.object_key);
        if (sha256Hex(copy.body) !== row.sha256) throw storageBackupError('storage_backup_copy_verification_failed');
        report.copied += 1;
      }
      hasMore = page.length === PAGE_SIZE;
    }

    // Osierocone: obiekty w źródle bez wiersza z hashem — tylko po pełnym
    // przejściu listy wierszy (seenKeys pokrywa wszystkie strony wyłącznie
    // przy pełnym przebiegu tego zbioru).
    if (resumed === null) {
      const sourceKeys = await allSourceKeys(sourceStorage, set.prefix);
      report.orphanedInSource = sourceKeys.filter((key) => !seenKeys.has(key)).length;
    }
    if (set.prefix === 'docs/') cursor = setCursor;
  }

  const total = empty();
  for (const part of Object.values(bySet)) for (const field of Object.keys(total)) total[field] += part[field];
  return { ...total, bySet, nextCursor: cursor };
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
