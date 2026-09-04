// Guards the belief-revision wiring in Anvil.
//
// sys/ai/memory-store.mjs implements hypothesis/verified/retracted facts and is
// unit-tested, but the app dropped `status` when reading fact files into the
// index — so buildMemoryIndex saw `status === undefined` on every fact, the
// `f.status !== 'retracted'` filter kept every disproven fact in the injected
// context, and neither the hypothesis tag nor the "do not re-derive" footer
// could ever render. The pure module passing its own tests did not catch it:
// the defect lived entirely in the two call sites.
//
// Grep-based, like the other app-contract tests. It pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildMemoryIndex, parseFact } from '../sys/ai/memory-store.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// Both readers must carry status through. Neither may push a fact object that
// stops at `type:` — that is exactly the shape of the original defect.
const pushes = [...anvil.matchAll(/(?:facts|out)\.push\(\{[^}]*description:\s*f\.description[^}]*\}\)/g)].map(m => m[0]);
assert.equal(pushes.length, 2, `expected 2 fact-index push sites, found ${pushes.length}`);
for (const p of pushes) {
  assert.match(p, /status:\s*f\.status/, `a fact-index push drops status (the retraction filter goes dead): ${p}`);
  // A1: relations (supersedes / derived_from / contradicts / slot) must ride along
  // too — buildMemoryIndex orders a successor above what it supersedes and tags the
  // stale row; a push that enumerates fields drops them exactly as status was dropped.
  assert.match(p, /\.\.\.f\b/, `a fact-index push drops the relations (supersession never renders): ${p}`);
}
// And the write side can create a related fact: the remember tool offers the relations
// and the handler passes them through to recordFact.
assert.match(anvil, /recordFact\(note, ar&&ar\.type, 'hypothesis', \{ slot: ar&&ar\.slot, derived_from: ar&&ar\.derived_from, supersedes: ar&&ar\.supersedes \}\)/, 'the remember handler passes slot/derived_from/supersedes to recordFact');
assert.match(anvil, /slotHolder\(await listFacts\(\), r\.slot\)/, 'a slot supersedes its current holder at write time');

// The memory panel must SHOW a retracted fact rather than listing it as live —
// retract visibly, never silently delete.
assert.match(anvil, /RETRACTED/, 'the memory panel marks retracted facts');
assert.match(anvil, /mark\(f\.status\)/, 'the panel renders each fact with its status marker');

// And the contract the app depends on still holds in the pure module: a fact
// carrying status:'retracted' is excluded and counted in the footer.
const retracted = parseFact('---\nname: dead-idea\ndescription: disproven\ntype: project\nstatus: retracted\n---\nbody\n');
assert.equal(retracted.status, 'retracted', 'parseFact surfaces status');
const live = parseFact('---\nname: good\ndescription: holds\ntype: project\nstatus: hypothesis\n---\nbody\n');

const index = buildMemoryIndex([
  { name: live.name, description: live.description, type: live.type, status: live.status },
  { name: retracted.name, description: retracted.description, type: retracted.type, status: retracted.status },
]);
assert.ok(!index.includes('dead-idea'), 'a retracted fact never reaches the injected index');
assert.match(index, /hypothesis — verify or retract/, 'a hypothesis is tagged as provisional');
assert.match(index, /1 fact\(s\) were retracted \(disproven\) and hidden/, 'the agent is told retracted facts exist');

// The regression itself: dropping status re-admits the retracted fact.
const dropped = buildMemoryIndex([
  { name: retracted.name, description: retracted.description, type: retracted.type },
]);
assert.ok(dropped.includes('dead-idea'),
  'sanity: without status the filter cannot engage — which is why the app must pass it');

console.log('anvil-memory-status: belief revision is wired through to the app');
