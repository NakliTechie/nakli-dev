import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAppInventory } from './app-inventory-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(rootDir, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.lock.json'), 'utf8'));

assert.deepEqual(await auditAppInventory(rootDir, html, manifest, lock), []);

const fixture = await mkdtemp(path.join(os.tmpdir(), 'naklios-inventory-'));
try {
  await cp(path.join(rootDir, 'apps'), path.join(fixture, 'apps'), { recursive: true });
  await writeFile(path.join(fixture, 'apps', 'tijori', 'stale.js'), 'stale');
  const errors = await auditAppInventory(fixture, html, manifest, lock);
  assert.ok(errors.some(error => error.includes('mirrored files differ')), 'extra mirror artifacts are rejected');

  const brokenHtml = html.replace(
    "embedUrl:'https://naklios.dev/apps/tijori/'",
    "embedUrl:'https://naklios.dev/apps/not-tijori/'",
  );
  const catalogErrors = await auditAppInventory(rootDir, brokenHtml, manifest, lock);
  assert.ok(catalogErrors.some(error => error.includes('catalog embedUrl')), 'catalog/mirror path drift is rejected');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('NakliOS deterministic app inventory audit behavior: PASS');

