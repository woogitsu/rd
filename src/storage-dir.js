// Lokalny magazyn w katalogu (issue #103): atrapa drugiej kopii i celu próby
// odtworzenia na SYNTETYCZNYCH danych. Nie łączy się z siecią. Kontrakt jak
// createMemoryStorage (src/storage.js). Klucz przechodzi assertObjectKey, więc
// nie może wyjść poza katalog (brak "..", ukośników wieloznacznych).

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { assertObjectKey } from './storage.js';

const META_SUFFIX = '.meta.json';
const LIST_PAGE_SIZE = 1000;

function notFound() {
  return Object.assign(new Error('storage_object_not_found'), { code: 'storage_object_not_found' });
}

export function createDirectoryStorage(directory) {
  const base = resolve(directory);
  const pathFor = (key) => {
    assertObjectKey(key);
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw Object.assign(new Error('storage_invalid_key'), { code: 'storage_invalid_key' });
    return path;
  };
  return {
    kind: 'directory',
    async putObject(key, bytes, contentType) {
      const path = pathFor(key);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, Buffer.from(bytes));
      await writeFile(path + META_SUFFIX, JSON.stringify({ contentType: String(contentType) }));
    },
    async getObject(key) {
      const path = pathFor(key);
      let body;
      try { body = await readFile(path); } catch (error) {
        if (error.code === 'ENOENT') throw notFound();
        throw error;
      }
      let contentType = 'application/octet-stream';
      try { contentType = JSON.parse(await readFile(path + META_SUFFIX, 'utf8')).contentType; } catch { /* brak metadanych */ }
      return { body: Uint8Array.from(body), contentType, size: body.length };
    },
    async headObject(key) {
      try { return (await stat(pathFor(key))).isFile(); } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async deleteObject(key) {
      const path = pathFor(key);
      await rm(path, { force: true });
      await rm(path + META_SUFFIX, { force: true });
    },
    async listObjects(prefix = '', continuationToken) {
      const keys = [];
      let prefixes = [];
      try { prefixes = await readdir(base, { withFileTypes: true }); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const entry of prefixes) {
        if (!entry.isDirectory()) continue;
        for (const file of await readdir(join(base, entry.name))) {
          if (file.endsWith(META_SUFFIX)) continue;
          const key = `${entry.name}/${file}`;
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
      keys.sort();
      const start = continuationToken ? Number(continuationToken) : 0;
      const isTruncated = start + LIST_PAGE_SIZE < keys.length;
      return {
        keys: keys.slice(start, start + LIST_PAGE_SIZE), isTruncated,
        nextContinuationToken: isTruncated ? String(start + LIST_PAGE_SIZE) : null,
      };
    },
  };
}
