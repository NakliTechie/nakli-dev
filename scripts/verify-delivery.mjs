import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [configSource, assetsIgnore, forgeReadme] = await Promise.all([
  readFile(path.join(root, 'wrangler.jsonc'), 'utf8'),
  readFile(path.join(root, '.assetsignore'), 'utf8'),
  readFile(path.join(root, 'apps', 'forge', 'README.md'), 'utf8'),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const config = JSON.parse(configSource);
assert(config.name === 'nakli-dev', `Unexpected Worker name: ${config.name}`);
assert(config.assets?.directory === './', 'The static asset directory must be the repository root.');
assert(config.assets?.not_found_handling === '404-page', 'Unknown routes must use the 404-page policy.');

const expectedRules = [
  '.*',
  '**/.*',
  'node_modules/',
  'plan/',
  'scripts/',
  'redirects/',
  'test/',
  '**/test/',
  '**/*.test.mjs',
  'apps/forge/',
  'wrangler.jsonc',
];
const rules = assetsIgnore.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
assert(JSON.stringify(rules) === JSON.stringify(expectedRules), `Unexpected asset exclusions: ${rules.join(', ')}`);
assert(/\*\*Status:\*\* planning\./.test(forgeReadme), 'The Forge deployment exclusion lacks planning status evidence.');

const requiredAssets = [
  'index.html',
  'LICENSE',
  'sdk/naklios.js',
  'apps/manifest.json',
  'apps/manifest.lock.json',
  'apps/nakliamp/index.html',
  'apps/nakliamp/VENDOR.md',
  'apps/nakliamp/engine/nakliamp-engine.mjs',
  'apps/nakliamp/engine/reel-engine.mjs',
  'apps/nakliamp/vendor/mediabunny/LICENSE-MPL-2.0.txt',
  'apps/nakliamp/vendor/mediabunny/mediabunny-1.51.0.min.mjs',
  'vendor/localmind/host-model-catalog.js',
  'vendor/crate/v1.0.2/crate.js',
  'sys/kiln/kiln.mjs',
  'sys/rig/registry/registry.mjs',
];
await Promise.all(requiredAssets.map(asset => access(path.join(root, ...asset.split('/')))));

console.log('PASS — NakliOS delivery policy: hidden state, plans, tests, scripts, and Forge planning files excluded');
