import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeManifest, sha256, validateMirrorState } from './mirror-lib.mjs';

const bytes = Buffer.from('<!doctype html><title>Fixture</title>\n');
const manifest = {
  version: 1,
  apps: [{
    id: 'fixture',
    repo: 'NakliTechie/Fixture',
    ref: 'v1.2.3',
    files: [{ source: 'dist/index.html', destination: 'index.html' }],
  }],
};
const normalized = normalizeManifest(manifest);
assert.equal(normalized.apps[0].requestedRef, 'v1.2.3');
assert.deepEqual(normalized.apps[0].files[0], {
  source: 'dist/index.html',
  destination: 'index.html',
});

assert.throws(
  () => normalizeManifest({
    apps: [{
      id: 'escape',
      repo: 'NakliTechie/Fixture',
      ref: 'main',
      files: [{ source: '../secret', destination: 'index.html' }],
    }],
  }),
  /unsafe path segment/,
  'mirror sources must not escape the declared repository path',
);

const root = await mkdtemp(path.join(tmpdir(), 'naklios-mirror-test-'));
await mkdir(path.join(root, 'apps', 'fixture'), { recursive: true });
await writeFile(path.join(root, 'apps', 'fixture', 'index.html'), bytes);
const lock = {
  version: 1,
  apps: [{
    id: 'fixture',
    repo: 'NakliTechie/Fixture',
    requestedRef: 'v1.2.3',
    resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
    files: [{
      source: 'dist/index.html',
      destination: 'index.html',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }],
  }],
};
assert.deepEqual(await validateMirrorState(root, manifest, lock), []);

await writeFile(path.join(root, 'apps', 'fixture', 'index.html'), 'drift\n');
assert.match(
  (await validateMirrorState(root, manifest, lock)).join('\n'),
  /artifact differs from locked SHA-256/,
  'local mirror drift must fail validation',
);

console.log('Mirror manifest and immutable lock contract: PASS');
