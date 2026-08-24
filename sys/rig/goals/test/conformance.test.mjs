// C7 conformance — Rig goal records.
//
//   node sys/rig/goals/test/conformance.test.mjs
//
// Covers RIG-VISION §7: create/attach, revision-guarded updates, budget
// exhaustion, cold resume (survives a fresh store over the same backend), and
// the load-bearing rule — `status: done` is verifier-only.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGoalStore } from '../index.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function fresh() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  return { backend, fs, goals: createGoalStore({ fs, clock: (() => { let t = 1_700_000_000_000; return () => (t += 1000); })() }) };
}

await test('create seeds an active record with a plan and revision', async () => {
  const { goals } = fresh();
  const r = await goals.create({
    id: 'g1', goal: 'green the suite', grantPrefix: 'src',
    budget: 100, plan: [{ step: 'fix', doneCondition: 'tests pass', keystone: true }],
  });
  eq(r.status, 'active', 'active');
  eq(r.currentStep, 0, 'step 0');
  eq(r.revision, 1, 'revision after first write');
  eq(r.plan[0].status, 'open', 'plan step open');
  assert(r.plan[0].keystone === true, 'keystone carried');
  const got = await goals.get('g1');
  eq(got.goal, 'green the suite', 'persisted');
});

await test('duplicate create is refused', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x' });
  let threw = false;
  try { await goals.create({ id: 'g1', goal: 'y' }); } catch { threw = true; }
  assert(threw, 'duplicate rejected');
});

await test('update is revision-guarded; a stale write is rejected', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x' });          // revision 1
  const ok = await goals.update('g1', { currentStep: 1 }, { revision: 1 });
  assert(ok.ok, 'fresh revision accepted');
  eq(ok.revision, 2, 'revision bumped');
  const stale = await goals.update('g1', { currentStep: 2 }, { revision: 1 });
  assert(!stale.ok && stale.code === 'ESTALE', 'stale revision rejected');
  eq((await goals.get('g1')).currentStep, 1, 'stale write did not land');
});

await test('status:done cannot be set through update', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x' });
  const res = await goals.update('g1', { status: 'done' });
  assert(!res.ok && res.code === 'EVERIFY', 'update refuses done');
  eq((await goals.get('g1')).status, 'active', 'still active');
});

await test('markDone requires a zero-exit verifier verdict', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x' });
  const nonzero = await goals.markDone('g1', { exit: 1, command: 'pytest' });
  assert(!nonzero.ok && nonzero.code === 'EVERIFY', 'non-zero verdict rejected');
  eq((await goals.get('g1')).status, 'active', 'not done on failure');
  const missing = await goals.markDone('g1', null);
  assert(!missing.ok, 'missing verdict rejected');
  const done = await goals.markDone('g1', { exit: 0, command: 'pytest -q', runId: 'v42' });
  assert(done.ok, 'zero-exit verdict accepted');
  const rec = await goals.get('g1');
  eq(rec.status, 'done', 'done');
  eq(rec.verifiedBy.runId, 'v42', 'records the verifier run');
});

await test('budget spend flags exhaustion', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x', budget: 50 });
  const a = await goals.spend('g1', 30);
  assert(!a.exhausted, 'not exhausted at 30/50');
  const b = await goals.spend('g1', 25);
  assert(b.exhausted, 'exhausted at 55/50');
});

await test('pause/resume transition status', async () => {
  const { goals } = fresh();
  const r = await goals.create({ id: 'g1', goal: 'x' });
  await goals.pause('g1', r.revision);
  eq((await goals.get('g1')).status, 'paused', 'paused');
  await goals.resume('g1', (await goals.get('g1')).revision);
  eq((await goals.get('g1')).status, 'active', 'resumed');
});

await test('cold resume: a fresh store over the same backend reads the goal', async () => {
  const { backend, fs, goals } = fresh();
  await goals.create({ id: 'g1', goal: 'survive the tab close', currentStep: 0 });
  await goals.update('g1', { currentStep: 3 }, { revision: 1 });
  // simulate a new session: a brand-new store over the SAME backend
  const goals2 = createGoalStore({ fs: createFileops({ backend }) });
  const got = await goals2.get('g1');
  eq(got.currentStep, 3, 'resumes at the same step');
  eq(got.goal, 'survive the tab close', 'trail intact');
});

await test('clear removes the record', async () => {
  const { goals } = fresh();
  await goals.create({ id: 'g1', goal: 'x' });
  await goals.clear('g1');
  eq(await goals.get('g1'), null, 'gone after clear');
});

if (failures.length) {
  console.error(`C7 goals: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C7/goals conformance: ${passed}/${passed} passed`);
