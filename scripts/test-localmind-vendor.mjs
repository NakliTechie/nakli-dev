import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('vendor/localmind/manifest.json', root), 'utf8'));

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.protocol, 'localmind.inference.v1');
assert.match(manifest.upstreamCommit, /^[0-9a-f]{40}$/);

for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(`vendor/localmind/${name}`, root));
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, expected, `${name} must match its pinned LocalMind artifact`);
}

const worker = await readFile(new URL('vendor/localmind/inference-worker.js', root), 'utf8');
assert.match(worker, /new URL\('\.\/lfm2_5\.js', import\.meta\.url\)/);
assert.match(worker, /localmind\.inference\.v1/);

console.log('Vendored LocalMind runtime: ok');
