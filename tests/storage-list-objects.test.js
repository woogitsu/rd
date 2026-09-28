// listObjects (issue #103): paginacja dla magazynu w pamięci i S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, createS3Storage } from '../src/storage.js';

test('createMemoryStorage: listObjects filters by prefix and paginates', async () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < 3; i += 1) await storage.putObject(`docs/aaaaaaa${i}`, Buffer.from('x'), 'application/pdf');
  await storage.putObject('smoke/aaaaaaaa', Buffer.from('x'), 'application/pdf');

  const page = await storage.listObjects('docs/');
  assert.deepEqual(page.keys.sort(), ['docs/aaaaaaa0', 'docs/aaaaaaa1', 'docs/aaaaaaa2']);
  assert.equal(page.isTruncated, false);
  assert.equal(page.nextContinuationToken, null);
});

test('createS3Storage: listObjects sends ListObjectsV2 and parses truncated XML', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    const truncated = !url.toString().includes('continuation-token');
    const body = truncated
      ? '<ListBucketResult><Contents><Key>docs/a</Key></Contents><Contents><Key>docs/b</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>tok-1</NextContinuationToken></ListBucketResult>'
      : '<ListBucketResult><Contents><Key>docs/c</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
    return new Response(body, { status: 200 });
  };
  const storage = createS3Storage({
    endpoint: 'https://storage.example.invalid', region: 'eu-west-1', bucket: 'rd-docs',
    accessKeyId: 'AKIA', secretAccessKey: 'secret', fetchImpl,
  });

  const first = await storage.listObjects('docs/');
  assert.deepEqual(first.keys, ['docs/a', 'docs/b']);
  assert.equal(first.isTruncated, true);
  assert.equal(first.nextContinuationToken, 'tok-1');
  assert.match(calls[0], /list-type=2/);
  assert.match(calls[0], /prefix=docs%2F/);

  const second = await storage.listObjects('docs/', first.nextContinuationToken);
  assert.deepEqual(second.keys, ['docs/c']);
  assert.equal(second.isTruncated, false);
  assert.equal(second.nextContinuationToken, null);
  assert.match(calls[1], /continuation-token=tok-1/);
});
