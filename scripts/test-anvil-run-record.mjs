// Guards that Anvil actually RECORDS its runs — the wiring, not the module.
//
// sys/history/run-record.mjs is unit-tested in isolation; twice today a correct,
// tested helper sat behind a call site that never used it (belief-revision status,
// the first version of the convo-carry test). This pins every seam the record
// depends on inside apps/anvil/index.html.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');
const runTask = anvil.slice(anvil.indexOf('async function runTask(t, text){'));
assert.ok(runTask.length > 1000, 'runTask found');

assert.match(anvil, /import \{ createRunRecorder, foldStatus, foldLog \} from '\.\.\/\.\.\/sys\/history\/run-record\.mjs'/,
  'the run record is imported');

// Every loop in runTask is recorded: started before, finished after, infer wrapped, events chained.
const loops = [...runTask.matchAll(/runAgentLoop\(\{/g)].length;
assert.equal(loops, 2, 'runTask runs the loop in exactly two places (main + act-or-nudge)');
assert.equal([...runTask.matchAll(/await rec\.start\(\{ messages: \w+, tools \}\)/g)].length, 2, 'each loop is preceded by rec.start');
assert.equal([...runTask.matchAll(/await rec\.finish\(result\)/g)].length, 2, 'each loop is followed by rec.finish');
assert.equal([...runTask.matchAll(/infer: recInfer/g)].length, 2, 'each loop infers through the recorder');
assert.equal([...runTask.matchAll(/onEvent:recEvent/g)].length, 2, 'each loop reports through the recorder');
// Check each runAgentLoop CALL SITE itself — the subagent executor
// (makeToolExecutor({ infer: inferViaHost })) is deliberately unrecorded in this
// layer (tree-scoped subagent records are a later move), so a file-wide grep for
// `infer: inferViaHost` would be wrong.
for (const m of runTask.matchAll(/runAgentLoop\(\{[\s\S]*?\}\);/g)) {
  const site = m[0];
  assert.match(site, /infer: recInfer/, `a loop bypasses the recorder for inference: ${site.slice(0, 80)}…`);
  assert.match(site, /onEvent:recEvent/, `a loop bypasses the recorder for events: ${site.slice(0, 80)}…`);
  assert.ok(!/infer: inferViaHost|onEvent:onLoopEvent\b/.test(site), `a loop still uses the unrecorded seams: ${site.slice(0, 80)}…`);
}
assert.match(runTask, /const recEvent = ?\(e\)=>\{ onLoopEvent\(e\); rec\.onEvent\(e\); \}/,
  'the UI handler still runs (dual-write) AND the recorder sees every event');
assert.match(runTask, /rec\.wrapInfer\(inferViaHost\)/, 'the model exchange is content-addressed through wrapInfer');

// The record is read only after it settles, and the folds are checked against the live state.
assert.match(runTask, /await rec\.settled\(\);/, 'the record is settled before it is read');
assert.match(runTask, /foldStatus\(ev, rec\.resolve, \{ gated \}\)/, 'status fold uses the same gated rule as the app');
assert.match(runTask, /run record disagrees with task status/, 'a status disagreement is surfaced, not swallowed');
assert.match(runTask, /run record disagrees with the log/, 'a log disagreement is surfaced, not swallowed');

// Persisted OUTSIDE the agent's mount.
assert.match(anvil, /async function saveRunRecord\(t, rec\)/, 'a run store exists');
assert.match(anvil, /createOpfsBackend\(\{ path: dir \}\)/, 'records go to OPFS');
assert.match(anvil, /const dir='anvil\/runs\/'/, 'under anvil/runs/, not the workspace mount');
assert.ok(!/fs\.write\([^)]*runs\//.test(anvil), 'never written through the agent-facing `fs`');
assert.match(runTask, /await saveRunRecord\(t, rec\)/, 'every run is persisted');
assert.match(runTask, /record: could not persist/, 'a persistence failure is surfaced');

console.log('anvil-run-record: every loop is recorded, folds are self-checked, records persist outside the mount');
