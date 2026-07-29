import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../docs/experience-modes.md', import.meta.url), 'utf8');

assert.match(html, /function getDefaultMode\(\)\{\s*return 'immersive';\s*\}/);
assert.match(html, /if \(v === 'A' \|\| v === 'B'\) localStorage\.setItem\(LS_KEY\.mode, 'basic'\)/);
assert.match(html, /else if \(v === 'C'\) localStorage\.setItem\(LS_KEY\.mode, 'immersive'\)/);
assert.match(
  html,
  /function effectiveMode\(app\)[\s\S]*?app && app\.maxMode === 'basic'[\s\S]*?return m/,
  'catalog compatibility can fall back without changing the saved preference',
);
assert.match(
  html,
  /function openApp\(app,[\s\S]*?const m = effectiveMode\(app\)[\s\S]*?m === 'immersive'[\s\S]*?spawnIframeWindow\(app/,
  'Immersive embeds compatible apps',
);
assert.match(
  html,
  /app\.kind === 'system'[\s\S]*?spawnIframeWindow\(app/,
  'system apps remain hosted independently of the selected launch mode',
);
assert.match(readme, /\[`Experience mode policy`\]\(docs\/experience-modes\.md\)/);
assert.match(policy, /\*\*Keep Basic\.\*\*/);
assert.match(policy, /Switching modes does not migrate, copy, delete, or rebind app data/);
assert.match(policy, /mode switch never\s+grants same-origin privilege/);
assert.match(policy, /“Mode C” is not current product\s+terminology/);

console.log('NakliOS experience-mode compatibility policy: PASS');
