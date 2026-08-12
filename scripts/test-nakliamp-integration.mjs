import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [host, mirror, vendor, manifest, harness] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/nakliamp/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/nakliamp/VENDOR.md', import.meta.url), 'utf8'),
  readFile(new URL('../apps/manifest.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../test/nakliamp-host-harness.html', import.meta.url), 'utf8'),
]);

const declared = manifest.apps.find(app => app.id === 'nakliamp');
assert.ok(declared, 'NakliAmp mirror is declared');
assert.equal(declared.repo, 'NakliTechie/nakliamp', 'NakliAmp mirror points to its authoritative repository');
assert.deepEqual(
  declared.files.map(file => file.destination),
  [
    'index.html',
    'VENDOR.md',
    'engine/nakliamp-engine.mjs',
    'engine/reel-engine.mjs',
    'vendor/mediabunny/mediabunny-1.51.0.min.mjs',
    'vendor/mediabunny/LICENSE-MPL-2.0.txt',
  ],
  'NakliAmp declares exactly its six public artifacts',
);
assert.match(
  host,
  /id:'nakliamp'[\s\S]*?url:'https:\/\/nakliamp\.naklitechie\.com\/'[\s\S]*?embedUrl:'https:\/\/naklios\.dev\/apps\/nakliamp\/'/,
  'NakliOS keeps NakliAmp canonical standalone and same-origin in Immersive mode',
);
assert.match(mirror, /name="nakliamp-version" content="0\.1\.0-m0"/, 'NakliAmp mirror exposes the M0 version');
assert.match(mirror, /v0\.1\.0-m0 · preview/, 'NakliAmp mirror exposes the preview label');
assert.match(mirror, /connect-src 'self'/, 'NakliAmp mirror limits connections to its own origin');
assert.doesNotMatch(mirror, /connect-src[^;]*https?:/, 'NakliAmp mirror does not allow remote HTTP connections');
assert.match(vendor, /Corresponding Mediabunny source is available/, 'NakliAmp mirror includes the source-availability notice');
assert.match(harness, /Mirrored NakliAmp requested a cross-origin resource/, 'Browser harness rejects remote resource loads');
assert.match(harness, /NakliAmp mirror did not use the pinned Reel path/, 'Browser harness checks the pinned engine path');

console.log('NakliOS ↔ NakliAmp mirror, locality, and preview contract: PASS');
