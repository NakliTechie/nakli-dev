#!/usr/bin/env node
// Ablation: the same agent ± one capability over the fixed task set, printed as
// per-capability deltas (NOOA's way of reporting). Every arm is recorded; with
// --replay the whole matrix reproduces from the records with zero model calls.
//
//   node scripts/ablate.mjs                       run the fixtures, print the table
//   node scripts/ablate.mjs --record DIR          also save every arm's record under DIR/
//   node scripts/ablate.mjs --replay DIR          rerun from DIR/ — zero live calls expected
//
// Today's task set is scripted (sys/ai/test/ablate-fixtures.mjs): no host, no Ollama.
// A live task set plugs into the same harness by supplying `model(caps)` from the host.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAblation, renderTable } from '../sys/ai/ablate.mjs';
import { fixtureTasks, CAPABILITIES } from '../sys/ai/test/ablate-fixtures.mjs';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; if (!v || v.startsWith('--')) { console.error(`${f} needs a directory`); process.exit(2); } return v; };
const recordDir = flag('--record'), replayDir = flag('--replay');

let records = null;
if (replayDir) {
  records = JSON.parse(await readFile(join(replayDir, 'ablation.json'), 'utf8'));
}
const result = await runAblation({ tasks: fixtureTasks(), capabilities: CAPABILITIES, records, now: () => 0 });
console.log(renderTable(result));
if (recordDir) {
  await mkdir(recordDir, { recursive: true });
  await writeFile(join(recordDir, 'ablation.json'), JSON.stringify(result.records));
  console.log(`recorded → ${join(recordDir, 'ablation.json')}`);
}
if (replayDir && result.liveCalls !== 0) { console.error(`replay made ${result.liveCalls} live call(s) — the records do not cover this matrix`); process.exit(1); }
