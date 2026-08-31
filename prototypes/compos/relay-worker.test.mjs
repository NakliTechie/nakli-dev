import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createArtifactWorker } from './relay-worker-core.mjs';

const relaySource = 'console.log("relay");\n';
const setupSource = '#!/bin/sh\necho setup\n';
const worker = createArtifactWorker({ relaySource, setupSource });

test('public relay sources contain no embedded private-key payload', async () => {
  const sources = await Promise.all([
    'compos-relay.mjs',
    'setup-local-tls.sh',
    'relay-worker.mjs',
    'relay-worker-core.mjs',
  ].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
  const joined = sources.join('\n');
  assert.doesNotMatch(joined, /BEGIN (?:RSA |EC |)PRIVATE KEY/);
  assert.doesNotMatch(joined, /embedded(?:Cert|Key)|TLS_(?:CERT|KEY).*B64/);
});

test('the Worker serves the relay from its root and named endpoint', async () => {
  for (const pathname of ['/', '/compos-relay.mjs']) {
    const response = await worker.fetch(new Request(`https://compos-relay.naklios.dev${pathname}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), relaySource);
    assert.match(response.headers.get('content-disposition'), /compos-relay\.mjs/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('the Worker serves the local TLS helper as a separate artifact', async () => {
  const response = await worker.fetch(
    new Request('https://compos-relay.naklios.dev/setup-local-tls.sh'),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), setupSource);
  assert.match(response.headers.get('content-type'), /text\/x-shellscript/);
  assert.match(response.headers.get('content-disposition'), /setup-local-tls\.sh/);
});

test('the Worker handles HEAD, unknown paths, and unsupported methods', async () => {
  const head = await worker.fetch(
    new Request('https://compos-relay.naklios.dev/', { method: 'HEAD' }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const missing = await worker.fetch(new Request('https://compos-relay.naklios.dev/other'));
  assert.equal(missing.status, 404);

  const refused = await worker.fetch(
    new Request('https://compos-relay.naklios.dev/', { method: 'POST' }),
  );
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('allow'), 'GET, HEAD');
});
