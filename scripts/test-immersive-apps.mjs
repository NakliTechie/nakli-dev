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
  /if \(m === 'immersive'\)[\s\S]*?return spawnIframeWindow\(app, options\);/,
  'Immersive apps must launch in NakliOS iframe windows',
);
assert.match(
  html,
  /\.nw-body\.has-iframe\s*\{\s*overflow:\s*hidden/,
  'iframe windows must not add a redundant host scrollbar',
);
assert.match(
  html,
  /body\.classList\.add\('has-iframe'\)/,
  'iframe windows mark their host body for overflow control',
);
assert.match(
  html,
  /iframe\.addEventListener\('load',\s*\(\)\s*=>\s*\{\s*markIframeLaunchPhase\(win,\s*'loaded'\)/,
  'iframe load reveals apps without waiting for a cooperative ready signal',
);
assert.match(
  html,
  /msg\.type\s*===\s*'naklios:ready'[\s\S]*?const win = findWin\(\)[\s\S]*?markIframeLaunchPhase\(win,\s*'ready'\)/,
  'cooperative ready signals still reveal apps before iframe load',
);
assert.doesNotMatch(
  html,
  /setTimeout\(\(\)\s*=>\s*skel\.remove\(\),\s*5000\)/,
  'iframe apps do not remain hidden behind the old fixed five-second cover',
);
assert.match(
  html,
  /scrollbar-color:[^;]*var\(--brand\)/,
  'NakliOS-owned scroll areas use the active theme',
);

console.log('NakliOS Immersive Slate/BOFH launch contract: PASS');
