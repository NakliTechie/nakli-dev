#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAppInventory } from './app-inventory-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, manifest, lock] = await Promise.all([
  readFile(path.join(rootDir, 'index.html'), 'utf8'),
  readFile(path.join(rootDir, 'apps', 'manifest.json'), 'utf8').then(JSON.parse),
  readFile(path.join(rootDir, 'apps', 'manifest.lock.json'), 'utf8').then(JSON.parse),
]);
const errors = await auditAppInventory(rootDir, html, manifest, lock);
if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('NakliOS app catalog, mirrors, lockfile, and on-disk inventory: PASS');
}

