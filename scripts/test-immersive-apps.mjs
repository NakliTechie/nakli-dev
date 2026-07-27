import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

for (const id of ['slate', 'bofh']){
  const start = html.indexOf(`{ id:'${id}'`);
  const end = html.indexOf('\n  { id:', start + 1);
  assert.ok(start >= 0 && end > start, `${id} app entry exists`);
  const entry = html.slice(start, end);
  assert.doesNotMatch(
    entry,
    /maxMode:'basic'/,
    `${id} must use NakliOS's Immersive iframe window instead of forcing a browser tab`,
  );
}

assert.match(
  html,
  /if \(m === 'immersive'\)[\s\S]*?return spawnIframeWindow\(app\);/,
  'Immersive apps must launch in NakliOS iframe windows',
);

console.log('NakliOS Immersive Slate/BOFH launch contract: PASS');
