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

{ const imp = anvil.match(/import \{([^}]*)\} from '\.\.\/\.\.\/sys\/history\/run-record\.mjs'/);
  assert.ok(imp, 'the run record is imported');
  for (const n of ['createRunRecorder','foldStatus','foldLog','loadRecord']) assert.ok(imp[1].includes(n), `imports ${n}`); }

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
assert.match(anvil, /async function saveRunRecord\(t, rec(, \{[^)]*\})?\)\{/, 'a run store exists');
assert.match(anvil, /createOpfsBackend\(\{ path:'anvil\/'\+rel \}\)/, 'records go to OPFS');
assert.match(anvil, /const rel='runs\/'\+String\(state\.activeProject/, 'under anvil/runs/<project>/<task>/, not the workspace mount');
assert.ok(!/fs\.write\([^)]*runs\//.test(anvil), 'never written through the agent-facing `fs`');
assert.match(runTask, /await saveRunRecord\(t, rec(, \{ gated \})?\)/, 'every run is persisted');
assert.match(runTask, /record: could not persist/, 'a persistence failure is surfaced');

// ── the storage ladder: rung 1 (Anvil home) and the honest durability line ──
// navigator.storage.persisted() was FALSE on naklios.dev on 2026-09-04, so OPFS
// is eviction-eligible; the home is a disk folder outside every workspace.
assert.match(anvil, /const HOME_KEY='anvil-home'/, 'the home handle has its own IDB key');
assert.match(anvil, /async function connectHome\(h\)/, 'connectHome exists');
assert.match(anvil, /h\.requestPermission\(\{mode:'readwrite'\}\)/, 'the home is re-granted through requestPermission');
assert.match(anvil, /id="home-chip"/, 'the home has a visible affordance');
assert.match(anvil, /\$\('home-chip'\)\.onclick = async/, 'and a click handler (the picker needs a gesture)');
assert.match(anvil, /showDirectoryPicker\(\{ mode:'readwrite', id:'anvil-home' \}\)/, 'the picker is keyed so the browser remembers the choice');
assert.match(anvil, /const h=await idbGet\(HOME_KEY\); if\(h&&typeof h\.queryPermission==='function'\)\{ homeSaved=true;/, 'boot re-checks the remembered home');
assert.match(anvil, /opfsPersisted=await navigator\.storage\.persisted\(\)/, 'boot learns whether browser storage is persisted');
// write-through: both rungs attempted, each reported, neither silently skipped
const save = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec){'), anvil.indexOf('async function runTask(t, text){'));
assert.match(save, /createOpfsBackend\(\{ path:'anvil\/'\+rel \}\)/, 'rung 0: OPFS');
assert.match(save, /if\(homeHandle\)\{/, 'rung 1: the home, when connected');
assert.match(save, /fh\.createWritable\(\)/, 'the home is written through raw FSA handles, not the agent-facing fs');
assert.match(save, /'browser storage \(evictable\)'/, 'an unpersisted OPFS copy is labelled evictable');
assert.match(save, /return \{ path, name, tiers, errors \}/, 'every rung and every failure is returned');
assert.ok(!/fs\.write/.test(save), 'saveRunRecord never touches the agent-facing fs');
// the closing line
assert.match(runTask, /const where = saved\.tiers\.length \? saved\.tiers\.join\(' \+ '\) : 'NOT saved'/, 'the closing line names every rung the record reached');
assert.match(runTask, /browser storage only; the browser may evict it\. Pick an Anvil home/, 'browser-only + unpersisted → the line says so and says what fixes it');
assert.match(runTask, /saved\.errors\.join/, 'a failed rung is reported, not swallowed');

// ── the index: derived, rebuildable, and actually READ ──
// An index nobody reads is dead code (today's lesson, twice). The closing line
// reads it back, so the read path is exercised on every run.
assert.match(anvil, /indexedDB\.open\(DIR_DB,2\)/, 'the IDB schema is v2');
assert.match(anvil, /createObjectStore\(RUNS_STORE,\{keyPath:'id'\}\)/, 'a runs store keyed by id');
for (const ix of ['project','task','endedAt']) assert.match(anvil, new RegExp(`createIndex\\('${ix}','${ix}'\\)`), `indexed by ${ix}`);
assert.match(anvil, /if\(!db\.objectStoreNames\.contains\(DIR_STORE\)\) db\.createObjectStore\(DIR_STORE\)/, 'the v1 store survives the upgrade');
assert.match(anvil, /function runIndexRow\(/, 'rows are derived by one function');
assert.match(anvil, /const st=foldStatus\(ev, rec\.resolve, \{ gated \}\)/, 'a row\'s status is the FOLD, not a copy of t.status');
const save2 = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec'), anvil.indexOf('async function runTask(t, text){'));
assert.match(save2, /await runsPut\(runIndexRow\(/, 'saveRunRecord writes the row after the files');
assert.match(save2, /count=\(await runsForTask\(String\(t\.id\)\)\)\.length/, 'and reads the task\'s run count back');
assert.match(runTask, /' · run '\+saved\.count\+' of this task'/, 'the closing line is a real reader of the index');
assert.match(anvil, /async function rebuildRunIndex\(\)/, 'the doctor exists');
const doctor = anvil.slice(anvil.indexOf('async function rebuildRunIndex(){'), anvil.indexOf('async function saveRunRecord('));
assert.match(doctor, /const rec=loadRecord\(dump\); const v=await rec\.verify\(\)/, 'every file is chain-verified on the way in');
assert.match(doctor, /row\.chainOk=v\.ok; row\.brokenAt=v\.brokenAt/, 'a broken chain is indexed as broken, not hidden');
assert.match(doctor, /getDirectoryHandle\('anvil'\)/, 'scans OPFS');
assert.match(doctor, /homeHandle\.getDirectoryHandle\('runs'\)/, 'and the home when connected');
assert.match(anvil, /if\(\(await runsCount\(\)\)===0\)\{ await rebuildRunIndex\(\); \}/, 'boot backfills an empty index from files');

// ── rung 2: the host store (Crate / host Folder) ──
const save3 = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec'), anvil.indexOf('async function runTask(t, text){'));
assert.match(save3, /if\(hostFsReady\(\)\)\{/, 'rung 2 is attempted when the host has a store');
assert.match(save3, /new CrateBackend\(nak\.fs\), root:''/, 'through the same CrateBackend the workspace uses, rooted at the store root');
assert.match(save3, /hx\.write\(rel\+'\/'\+name, text\)/, 'written under runs/, outside the ws/<project> mount');
assert.match(save3, /which==='crate' \? 'Crate' : 'host '\+which/, 'the tier is labelled by what the host actually is');
const doctor2 = anvil.slice(anvil.indexOf('async function rebuildRunIndex(){'), anvil.indexOf('async function saveRunRecord('));
assert.match(doctor2, /hx\.list\('runs',\{recursive:true\}\)/, 'the doctor scans the host store too');
assert.match(doctor2, /prev\.tiers\.push\(tier\)/, 'a record found on several rungs is one row with all its tiers');

console.log('anvil-run-record: every loop is recorded, folds are self-checked, records persist outside the mount, the durability line is honest, and the index is derived, rebuildable and read');
