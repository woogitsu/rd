// Weryfikacja drugiej kopii bucketu dokumentów i próba jej odtworzenia
// (issue #103). Część niezależna od wyboru dostawcy kopii (D-01/D-20):
// działa na dowolnym magazynie o kontrakcie src/storage.js, w testach i
// próbie lokalnej — na atrapie lub katalogu z danymi syntetycznymi.
//
// Tylko odczyt kopii i tabeli `documents`. Żadnego usuwania. Raport zawiera
// liczby i identyfikatory techniczne wierszy `documents` (nie klucze
// obiektów, nie nazwy plików, nie dane osobowe).

import { sha256Hex } from '../storage.js';

const DOCS_PREFIX = 'docs/';
const MAX_LISTED_IDS = 50;
const LOCAL_KINDS = new Set(['memory', 'directory']);

function verifyError(code) {
  return Object.assign(new Error(code), { code });
}

async function listAllKeys(storage, prefix) {
  const keys = [];
  let token;
  do {
    const page = await storage.listObjects(prefix, token);
    keys.push(...page.keys);
    token = page.isTruncated ? page.nextContinuationToken : null;
  } while (token);
  return keys.sort();
}

// Manifest SHA-256 kopii: dla każdego obiektu `docs/*` skrót i rozmiar
// policzone z faktycznej treści (nie z metadanych dostawcy).
export async function buildStorageManifest(storage, { now = new Date() } = {}) {
  const entries = [];
  for (const key of await listAllKeys(storage, DOCS_PREFIX)) {
    const object = await storage.getObject(key);
    entries.push({ key, sha256: sha256Hex(object.body), size: object.body.length });
  }
  return { format: 'rd-storage-manifest-v1', generatedAt: now.toISOString(), entries };
}

export function parseStorageManifest(value) {
  const manifest = typeof value === 'string' ? JSON.parse(value) : value;
  if (manifest?.format !== 'rd-storage-manifest-v1' || !Array.isArray(manifest.entries)) {
    throw verifyError('storage_manifest_invalid');
  }
  for (const entry of manifest.entries) {
    if (typeof entry?.key !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !Number.isInteger(entry.size)) {
      throw verifyError('storage_manifest_invalid');
    }
  }
  return manifest;
}

async function documentRows(db) {
  const { rows } = await db.query(
    `SELECT id, object_key, sha256, byte_size FROM documents
     WHERE object_key IS NOT NULL AND sha256 IS NOT NULL AND object_key LIKE $1
     ORDER BY object_key`,
    [`${DOCS_PREFIX}%`],
  );
  return rows;
}

function capped(ids) {
  return { count: ids.length, documentIds: ids.slice(0, MAX_LISTED_IDS), truncated: ids.length > MAX_LISTED_IDS };
}

// Porównuje manifest kopii z tabelą `documents`. `ok` tylko gdy brak braków,
// niezgodnych skrótów i niezgodnych rozmiarów. Osierocone obiekty kopii
// (bez wiersza w bazie) są zgłaszane liczbą i NIE psują `ok` — kopia nie
// usuwa niczego, a osierocony obiekt bywa skutkiem nieudanej transakcji.
export async function verifyStorageBackup({ db, manifest }) {
  const parsed = parseStorageManifest(manifest);
  const byKey = new Map(parsed.entries.map((entry) => [entry.key, entry]));
  const rows = await documentRows(db);
  const missing = []; const mismatched = []; const sizeMismatched = [];
  let expectedBytes = 0; let backupBytes = 0;
  const documentKeys = new Set();
  for (const row of rows) {
    documentKeys.add(row.object_key);
    expectedBytes += Number(row.byte_size);
    const entry = byKey.get(row.object_key);
    if (!entry) { missing.push(row.id); continue; }
    backupBytes += entry.size;
    if (entry.sha256 !== row.sha256) mismatched.push(row.id);
    else if (entry.size !== Number(row.byte_size)) sizeMismatched.push(row.id);
  }
  const orphaned = parsed.entries.filter((entry) => !documentKeys.has(entry.key)).length;
  const report = {
    documentsWithObject: rows.length,
    objectsInBackup: parsed.entries.length,
    expectedBytes,
    backupBytes,
    missingInBackup: capped(missing),
    hashMismatches: capped(mismatched),
    sizeMismatches: capped(sizeMismatched),
    orphanedInBackup: orphaned,
  };
  report.ok = !missing.length && !mismatched.length && !sizeMismatched.length;
  return report;
}

// Próba odtworzenia: kopiuje próbkę obiektów z kopii do LOKALNEGO magazynu
// (atrapa lub katalog) i porównuje SHA-256 odtworzonych bajtów z
// `documents.sha256`. Cel inny niż lokalny (np. S3) jest odrzucany — próba
// nie może nadpisać prawdziwego bucketu.
export async function runStorageRestoreDrill({ db, backupStorage, restoreStorage, sampleSize = 20, random = Math.random }) {
  if (!LOCAL_KINDS.has(restoreStorage?.kind)) throw verifyError('storage_restore_target_not_local');
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw verifyError('storage_restore_sample_invalid');
  const rows = await documentRows(db);
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(0, sampleSize);
  const missing = []; const failed = []; let restored = 0;
  for (const row of sample) {
    let object;
    try { object = await backupStorage.getObject(row.object_key); } catch (error) {
      if (error?.code === 'storage_object_not_found') { missing.push(row.id); continue; }
      throw error;
    }
    if (sha256Hex(object.body) !== row.sha256) { failed.push(row.id); continue; }
    await restoreStorage.putObject(row.object_key, object.body, object.contentType);
    const again = await restoreStorage.getObject(row.object_key);
    if (sha256Hex(again.body) !== row.sha256) { failed.push(row.id); continue; }
    restored += 1;
  }
  return {
    documentsWithObject: rows.length,
    sampled: sample.length,
    restored,
    missingInBackup: capped(missing),
    hashFailures: capped(failed),
    ok: restored === sample.length,
  };
}
