// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const host = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sdk = readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../apps/notes/index.html', import.meta.url), 'utf8');
const harness = readFileSync(new URL('../test/notes-host-harness.html', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../docs/app-contract.md', import.meta.url), 'utf8');

for (const [label, source] of [['NakliOS', host], ['Notes', notes]]) {
  for (const [index, match] of [...source.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
    if (!match[1].trim()) continue;
    assert.doesNotThrow(() => new Function(match[1]), `${label} inline script ${index + 1} parses`);
  }
}

const notesEntry = host.match(/\{\s*id:'notes'[\s\S]*?svg:`[\s\S]*?`\s*\},/);
assert.ok(notesEntry, 'Notes launcher entry exists');
assert.match(notesEntry[0], /kind:'system'/, 'Notes remains hosted in Basic and Immersive modes');
assert.match(notesEntry[0], /url:'\.\/apps\/notes\/'/, 'Notes uses the bundled same-origin app');
assert.match(notesEntry[0], /Browser, Folder, or encrypted Crate/, 'launcher describes distinct storage locations');
assert.match(host, /if \(app\.kind === 'system'\) return spawnIframeWindow\(app\);/);

assert.match(notes, /<script src="\.\.\/\.\.\/sdk\/naklios\.js"><\/script>/, 'Notes loads the public SDK');
assert.doesNotMatch(notes, /\b(?:alert|confirm|prompt)\s*\(/, 'Notes uses styled dialogs only');
assert.doesNotMatch(notes, /\.innerHTML\s*=/, 'user-authored note content is never interpolated as HTML');

for (const method of ['read', 'write', 'delete', 'exists', 'list', 'useBackend', 'subscribe']) {
  assert.match(notes, new RegExp(`naklios\\.fs\\.${method}|fs\\.${method}|hostedAdapter[\\s\\S]*?${method}`), `Notes uses ${method}`);
}
assert.match(notes, /indexedDB\.open\('naklios-notes-v1'/, 'Browser library persists in IndexedDB');
assert.match(notes, /const LOCATION_KEY = 'naklios\.notes\.location'/, 'selected library survives reload');
assert.match(notes, /Nothing was copied/, 'switching libraries explicitly avoids migration');

assert.match(notes, /const LIBRARY_FILE = 'library\.json'/, 'library index has a stable path');
assert.match(notes, /return `notes\/\$\{id\}\.\$\{ext\}`/, 'content and metadata use per-note files');
assert.match(notes, /notePath\(note\.id,'md'\)/, 'Markdown content is stored separately');
assert.match(notes, /writeMetadata\(note\)/, 'JSON metadata is stored separately');
assert.match(notes, /setTimeout\(\(\) => void flushNow\(\), 500\)/, 'editing autosaves through a debounce');
assert.match(notes, /visibilityState === 'hidden'[\s\S]*?flushNow/, 'backgrounding flushes pending edits');
assert.match(notes, /naklios\.beforeClose\(\(\) => flushNow\(\)\)/, 'window close returns the pending flush');
assert.match(
  notes,
  /Changes arrived from storage[\s\S]*?Keep mine[\s\S]*?Reload/,
  'concurrent storage changes require an explicit keep-or-reload decision',
);
assert.match(
  notes,
  /Storage disconnected while this note has unsaved changes/,
  'disconnecting a backend does not silently move or discard an unsaved note',
);

for (const feature of [
  'New notebook',
  'Search every note',
  'Recently Deleted',
  'Move to Trash',
  'Delete forever',
  'Restore',
  'Pin',
]) {
  assert.ok(notes.includes(feature), `Notes v1 surfaces ${feature}`);
}

assert.match(
  sdk,
  /subscribe: async function \(path, cb\)[\s\S]*?naklios:fs:subscribe[\s\S]*?return function \(\)[\s\S]*?naklios:fs:unsubscribe/,
  'SDK subscription resolves to an unsubscribe function',
);
assert.match(
  sdk,
  /Promise\.resolve\(closeWork\)[\s\S]*?naklios:beforeclose-ready/,
  'SDK acknowledges close only after asynchronous app work settles',
);
assert.match(
  host,
  /win\._sdkFeatures\?\.beforeCloseAck[\s\S]*?setTimeout\(\(\) => finalizeCloseWindow\(win\), 5000\)[\s\S]*?naklios:beforeclose-ready/,
  'host waits with a bounded fallback for close-aware apps',
);
assert.match(
  host,
  /function normaliseSubscriptionPath\(appId, path\)[\s\S]*?`apps\/\$\{appId\}/,
  'host scopes subscription prefixes to the calling app',
);
assert.match(
  host,
  /msg\.backend && msg\.backend !== backendId[\s\S]*?Storage backend changed before the subscription/,
  'subscriptions retain backend affinity',
);
assert.match(host, /fsCrateWatchTarget\.onChange\(event =>/, 'Crate forwards native change events');
assert.match(host, /setInterval\(\(\) => \{ void pollFsaSubscriptions\(\); \}, 2000\)/, 'Folder uses the documented two-second poll');
assert.match(
  host,
  /fsHostUnsubscribeSource\(iframe\.contentWindow\)/,
  'closing a window releases its subscriptions',
);
assert.match(harness, /stores = \{ fsa:new Map\(\), crate:new Map\(\) \}/, 'browser harness keeps isolated fake backends');
assert.match(harness, /Crate note leaked into Folder library/, 'browser harness rejects Crate-to-Folder copying');
assert.match(harness, /Folder note leaked into Crate library/, 'browser harness rejects Folder-to-Crate copying');
assert.match(harness, /source:'remote'/, 'browser harness exercises remote change delivery');
assert.match(harness, /all three safe decisions/, 'browser harness exercises explicit remote-conflict resolution');
assert.match(harness, /overwrote remote data without a decision/, 'browser harness rejects implicit conflict overwrites');
assert.match(harness, /survive reload/, 'browser harness exercises reload recovery');
for (const surface of [
  'naklios.beforeClose(callback)',
  'naklios.fs.subscribe',
  'Storage locations are separate',
  'Security boundary',
  'Minimum acceptance gate',
]) {
  assert.ok(contract.includes(surface), `app contract documents ${surface}`);
}

console.log('NakliOS Notes v1 and filesystem subscription contract: PASS');
