import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression lever for the semantic-search (RAG) backlog fixes:
// M-4 sync race, M-5 embed hang, M-6 index thrash, L-7 double sync,
// L-8 keyboard-reachable hits, UX-4 no-backend connect affordance.
// Static assertions over index.html, matching the repo's scripts/test-*.mjs.

const host = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Syntax gate on every inline script (covers the RAG + Spotlight rewrites).
for (const [i, m] of [...host.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  assert.doesNotThrow(() => new Function(m[1]), `inline host script ${i + 1} parses`);
}

// ── M-4: syncs serialize through one in-flight chain ──
assert.match(host, /syncChain:Promise\.resolve\(\)/, 'ragHost has a sync chain');
assert.match(host, /async function ragSyncIndexInner\(/, 'sync implementation is separated');
assert.match(
  host,
  /function ragSyncIndex\([\s\S]*?ragHost\.syncChain = ragHost\.syncChain\.then\(run, run\)/,
  'ragSyncIndex serializes concurrent syncs',
);

// ── M-5: embed calls have an error listener + timeout, and drop a dead worker ──
assert.match(host, /const RAG_EMBED_TIMEOUT_MS =/, 'embed has a timeout constant');
assert.match(
  host,
  /function ragEmbed\([\s\S]*?worker\.addEventListener\('error', onError\)/,
  'ragEmbed listens for worker crashes',
);
assert.match(
  host,
  /function ragEmbed\([\s\S]*?setTimeout\(\(\) => fail\('Embedding timed out'\)/,
  'ragEmbed times out instead of hanging',
);

// ── M-6: every walked candidate is retained regardless of chunk budget ──
assert.match(
  host,
  /const seen = new Set\(candidates\.map\(entry => entry\.path\)\)/,
  'seen is pre-populated so budget-skipped files are not evicted',
);

// ── L-7: ragSearchCore no longer runs its own sync ──
const searchCore = host.match(/async function ragSearchCore\([\s\S]*?\n}/)[0];
assert.ok(!/ragSyncIndex/.test(searchCore), 'ragSearchCore does not double-sync');

// ── L-8: one unified, keyboard-navigable row model over apps + semantic hits ──
assert.match(host, /function buildRows\(\)/, 'spotlight builds a unified row list');
assert.match(host, /async function activateRow\(row\)/, 'rows share one activation path');
assert.match(host, /if \(navIndices\.length\) void activateRow\(rows\[navIndices\[active\]\]\)/,
  'Enter activates the focused row (app or semantic hit)');

// ── UX-4: a no-backend meaning query offers to connect storage ──
assert.match(host, /type:'connect'/, 'no-backend queries offer a connect affordance');
assert.match(host, /Connect storage to search by meaning/, 'connect affordance has copy');
assert.match(host, /row\.type === 'connect'\)\{ close\(\); openSettings\('storage'\)/,
  'connect affordance opens storage settings');

console.log('test-semantic-search-fixes: all assertions passed');
