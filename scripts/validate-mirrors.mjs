#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeManifest, validateMirrorState } from './mirror-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.json'), 'utf8'));
normalizeManifest(manifest);

let lock;
try {
  lock = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.lock.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const errors = await validateMirrorState(rootDir, manifest, lock);
if (errors.length) {
  console.error(`Mirror validation failed:\n${errors.map(error => `  - ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Mirror lock valid: ${lock.apps.length} app(s), all artifacts match.`);
}
