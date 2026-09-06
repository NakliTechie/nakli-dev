// Guards the history tool's wiring in Anvil (B2): the agent can search and read its own
// run records, in every mode, over the persisted records — the retrieval half of the
// substrate. Grep-based; pins the seam, the pure core is unit-tested in run-record.test.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchRecords, readEvent, historyTool } from '../sys/history/run-record.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

assert.match(anvil, /import \{[^}]*\bsearchRecords\b[^}]*\bhistoryTool\b[^}]*\} from '\.\.\/\.\.\/sys\/history\/run-record\.mjs'/, 'Anvil imports the history core');
assert.match(anvil, /async function loadTaskRecords\(scope/, 'a helper loads the task\'s records by scope');
// forward-pass NAF-02/NAF-07: every scope stays inside the active project, and the CALLER names
// its task rather than inheriting whatever the UI has selected.
assert.match(anvil, /if\(p!==proj\) continue;/, 'project scope no longer reads every project');
assert.match(anvil, /loadTaskRecords\(scope,\s*runCtx/, 'history asks for the calling task\'s records');
assert.match(anvil, /getDirectoryHandle\('anvil'\)\)\.getDirectoryHandle\('runs'\)/, 'it reads the persisted OPFS records');
assert.match(anvil, /if\(nm==='history'\)\{/, 'a history handler exists');
assert.match(anvil, /searchRecords\(entries,\{ query:/, 'search is served by the pure core');
assert.match(anvil, /readEvent\(entries,String\(\(ar&&ar\.id\)\|\|''\)/, 'read is served by the pure core');
assert.match(anvil, /tools\.push\(historyTool\(\)\);/, 'the history tool is offered');
// history is NOT gated to code mode (read-only): it must not be in the mode!=='code' refusal list
assert.ok(!/nm==='history'[^)]*\)\)\{\s*\n\s*return 'Error: the "'\+nm/.test(anvil), 'history is available in every mode');

// The contract the app depends on, in the pure core.
assert.equal(historyTool().function.name, 'history', 'tool name');
assert.equal(searchRecords([], { query: 'x' }).length, 0, 'no records → no hits, no throw');
assert.ok(readEvent([], 'nope', {}).error, 'a bad id is an error, not a throw');

console.log('anvil-history: the agent can search and read its own run records in every mode');
