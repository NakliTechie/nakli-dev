import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const lock = JSON.parse(readFileSync(
  new URL('../apps/manifest.lock.json', import.meta.url),
  'utf8',
));

for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  assert.doesNotThrow(() => new Function(match[1]), `inline NakliOS script ${index + 1} parses`);
}

assert.match(
  html,
  /class="nw-info-btn" title="App Info" aria-label="App Info"/,
  'every window titlebar exposes an accessible App Info button',
);
assert.match(html, /dlg\.id = 'nw-app-info-dialog'/, 'App Info uses an in-app dialog');
assert.match(html, /aria-labelledby', 'nw-app-info-title'/, 'App Info has an accessible name');
assert.match(html, /aria-describedby', 'nw-app-info-intro'/, 'App Info has an accessible description');
assert.match(html, /dlg\.showModal\(\)/, 'App Info uses modal focus and Escape behavior');

for (const label of [
  'Loaded URL',
  'Origin',
  'Sandbox',
  'Sandbox tokens',
  'Load event',
  'Ready signal',
  'SDK bridge',
  'Storage capability',
  'Connected locations',
  'App storage binding',
  'Provenance',
]) {
  assert.match(html, new RegExp(`label:'${label}'`), `App Info reports ${label}`);
}

assert.match(
  html,
  /function markIframeLaunchPhase[\s\S]*?timing\[phase\] = performance\.now\(\) - timing\.started[\s\S]*?refreshOpenAppInfo\(win\)/,
  'load and ready timing updates remain live while App Info is open',
);
assert.match(
  html,
  /function capabilitySnapshot\(appId\)[\s\S]*?fsBackends[\s\S]*?fsBackend/,
  'storage diagnostics use the same capability snapshot sent to apps',
);
assert.match(
  html,
  /const explicitlyDenied = v === 'denied' \|\|[\s\S]*?v\.granted === false/,
  'legacy string denials and current object denials both suppress filesystem capability',
);
assert.match(
  html,
  /win\._capabilities = snapshot[\s\S]*?refreshOpenAppInfo\(win\)/,
  'capability changes refresh the current window diagnostics',
);
assert.match(
  html,
  /if \(!chosen\)[\s\S]*?saveAppPermissions\(\)[\s\S]*?broadcastCapabilities\(\)[\s\S]*?backend: chosen[\s\S]*?saveAppPermissions\(\)[\s\S]*?broadcastCapabilities\(\)/,
  'first-operation grants and denials immediately refresh capability diagnostics',
);
assert.match(
  html,
  /id:'notepad'[\s\S]{0,140}hostStorage:true/,
  'Notepad declares its host-native storage capability',
);
assert.match(
  html,
  /app\.hostStorage\s*\?\s*capabilitySnapshot\(app\.id\)[\s\S]*?Object\.values\(openWindows\)[\s\S]*?win\._app\?\.hostStorage[\s\S]*?refreshOpenAppInfo\(win\)/,
  'classic Notepad gets initial and live Folder/Crate diagnostics',
);
assert.match(
  html,
  /new URL\('apps\/manifest\.lock\.json', location\.href\)/,
  'mirror provenance comes from the checked-in lock manifest',
);
assert.match(html, /Vendored standalone-app mirror/, 'vendored mirrors are identified');
assert.match(html, /mirror\.resolvedCommit/, 'mirror provenance includes its immutable commit');
assert.match(html, /artifact\.sha256/, 'mirror provenance includes its locked artifact hash');
assert.match(html, /Built into this NakliOS release/, 'classic apps have host provenance');
assert.match(html, /Canonical standalone app \(not a vendored mirror\)/, 'remote apps identify canonical provenance');
assert.match(
  html,
  /url:'\.\/apps\/files\/',\s*embedUrl:'\.\/apps\/files\/'/,
  'Files remains same-origin when NakliOS is served from a nested local path',
);

const tijori = lock.apps.find((app) => app.id === 'tijori');
assert.ok(tijori?.resolvedCommit, 'fixture includes an immutable Tijori mirror commit');
assert.match(tijori.files[0].sha256, /^[a-f0-9]{64}$/, 'fixture includes a full mirror artifact hash');

console.log('NakliOS per-window App Info contract: PASS');
