import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('vendor/localmind/manifest.json', root), 'utf8'));

assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.protocol, 'localmind.inference.v1');
assert.match(manifest.upstreamCommit, /^[0-9a-f]{40}$/);
assert.equal(manifest.defaultModelKey, 'lfm2-230m-webgpu');

for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(`vendor/localmind/${name}`, root));
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, expected, `${name} must match its pinned LocalMind artifact`);
}

const worker = await readFile(new URL('vendor/localmind/inference-worker.js', root), 'utf8');
const onnxWorker = await readFile(new URL('vendor/localmind/onnx-inference-worker.js', root), 'utf8');
const catalog = await readFile(new URL('vendor/localmind/host-model-catalog.js', root), 'utf8');
assert.match(worker, /new URL\('\.\/lfm2_5\.js', import\.meta\.url\)/);
assert.match(worker, /localmind\.inference\.v1/);
assert.match(onnxWorker, /Gemma4ForConditionalGeneration/);
assert.match(onnxWorker, /AutoModelForCausalLM/);
assert.match(catalog, /gemma4-e2b/);
assert.match(catalog, /gemma4-e4b/);
assert.match(catalog, /qwen3-4b/);

console.log('Vendored LocalMind runtime: ok');
