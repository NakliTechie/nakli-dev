import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Non-FSA apps must EMBED (Immersive iframe window), never force a browser tab.
for (const id of ['bofh']){
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

// Cross-origin File-System-Access apps must open TOP-LEVEL (maxMode:'basic') —
// showDirectoryPicker() is blocked in a cross-origin iframe, so they cannot run
// embedded. Decision 2026-08-27: FSA apps top-level, non-FSA apps stay embedded.
// KanZen/NakliPoster-style apps that only need app-scoped storage work embedded;
// these open the user's EXISTING arbitrary folder, which needs a top-level tab.
for (const id of ['books', 'vaultmind', 'nakliposter', 'slate']){
  const start = html.indexOf(`{ id:'${id}'`);
  const end = html.indexOf('\n  { id:', start + 1);
  assert.ok(start >= 0 && end > start, `${id} app entry exists`);
  const entry = html.slice(start, end);
  assert.match(
    entry,
    /maxMode:'basic'/,
    `${id} is a cross-origin FSA app — it must open top-level (maxMode:'basic'), not embedded`,
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

console.log('NakliOS Immersive BOFH-embed + FSA-apps-top-level contract: PASS');
