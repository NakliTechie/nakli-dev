// K3 conformance — the verifier kernel (headless seam over MockVerifierRuntime).
//
//   node sys/kiln/test/verifier.test.mjs
//
// Proves the three walls that make a verdict trustworthy — fresh namespace,
// read-only mount, immutable command — the golden red→green fixture, the
// REQUIRED adversarial gate (a kernel that monkey-patched assert still gets a
// truthful verdict), and the wiring into C7 goals.markDone. The real-Pyodide
// adversarial run lives in test/kiln-verifier-harness.html (attended browser).

import { createVerifier } from '../verifier.mjs';
import { MockVerifierRuntime } from '../verifier-mock.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGoalStore } from '../../rig/goals/index.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
async function throwsAsync(fn, re, msg) {
  try { await fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${msg}: wrong error ${e.message}`); return; }
  throw new Error(`${msg || 'should throw'}: did not throw`);
}

const freshFactory = () => () => new MockVerifierRuntime();

// ── constructor guards ─────────────────────────────────────────────────
await test('createVerifier requires a fresh-runtime factory and a command', async () => {
  await throwsAsync(async () => createVerifier({ verificationCommand: 'CHECK x' }), /loadRuntime/, 'no factory');
  await throwsAsync(async () => createVerifier({ loadRuntime: freshFactory() }), /verificationCommand/, 'no command');
  await throwsAsync(async () => createVerifier({ loadRuntime: freshFactory(), verificationCommand: '  ' }), /verificationCommand/, 'blank command');
});

// ── golden red → green ──────────────────────────────────────────────────
await test('golden fixture: failing run → non-zero; passing run → zero', async () => {
  const red = createVerifier({
    loadRuntime: freshFactory(),
    verificationCommand: 'CHECK result.txt',
    mount: { 'result.txt': 'FAIL: 1 of 3 tests failed' },
  });
  const rv = await red.verify({ runId: 'r1' });
  eq(rv.exit, 1, 'red exit'); eq(rv.ok, false, 'red not ok');

  const green = createVerifier({
    loadRuntime: freshFactory(),
    verificationCommand: 'CHECK result.txt',
    mount: { 'result.txt': 'PASS: 3 of 3 tests passed' },
  });
  const gv = await green.verify({ runId: 'r2' });
  eq(gv.exit, 0, 'green exit'); eq(gv.ok, true, 'green ok');
  eq(gv.command, 'CHECK result.txt', 'verdict carries the command for goals.verifiedBy');
  eq(gv.runId, 'r2', 'runId threaded');
});

// ── THE adversarial gate ────────────────────────────────────────────────
await test('adversarial: an agent kernel that monkey-patched assert cannot launder the verdict', async () => {
  // The genuine state of the run tree: the suite FAILED.
  const mount = { 'result.txt': 'FAIL: assertion error in test_core' };

  // Attack: the agent poisons its OWN kernel so its checks always "pass".
  const agentKernel = new MockVerifierRuntime();
  agentKernel.mountReadOnly(mount);
  await agentKernel.runCommand('PATCH_ASSERT');                 // redefine assert in the agent ns
  const laundered = await agentKernel.runCommand('CHECK result.txt');
  eq(laundered.exit, 0, 'in the poisoned kernel the failing check reports pass (attack is real)');

  // The verifier runs the SAME command in a FRESH runtime → the patch is absent.
  const verifier = createVerifier({
    loadRuntime: () => new MockVerifierRuntime(),               // fresh namespace, every call
    verificationCommand: 'CHECK result.txt',
    mount,
  });
  const verdict = await verifier.verify({ runId: 'r3' });
  eq(verdict.exit, 1, 'verifier is NOT fooled — truthful non-zero');
  eq(verdict.ok, false, 'verdict is a fail');
});

await test('each verify() gets a fresh namespace (a prior run cannot poison the next)', async () => {
  let built = 0;
  const shared = new MockVerifierRuntime();
  // A pathological factory that reuses one instance would let state leak; the
  // correct factory builds fresh. Prove the verifier asks for a new one each call.
  const verifier = createVerifier({
    loadRuntime: () => { built++; return new MockVerifierRuntime(); },
    verificationCommand: 'CHECK result.txt',
    mount: { 'result.txt': 'FAIL' },
  });
  await verifier.verify(); await verifier.verify();
  eq(built, 2, 'a fresh runtime per verification');
  void shared;
});

// ── read-only mount ─────────────────────────────────────────────────────
await test('read-only mount: the verification cannot write state to force a pass', async () => {
  const verifier = createVerifier({
    loadRuntime: freshFactory(),
    // even if a command tried to fake a PASS by writing the result file, the
    // mount refuses the write and the run fails.
    verificationCommand: 'WRITE result.txt PASS\nCHECK result.txt',
    mount: { 'result.txt': 'FAIL' },
  });
  const v = await verifier.verify();
  eq(v.exit, 1, 'write refused, check still fails');
  assert(/read-only/.test(v.stderr), `stderr notes the refusal: ${v.stderr}`);
});

// ── immutable command ───────────────────────────────────────────────────
await test('the verificationCommand is immutable: a command passed to verify() is ignored', async () => {
  const verifier = createVerifier({
    loadRuntime: freshFactory(),
    verificationCommand: 'CHECK result.txt',      // the real, failing check
    mount: { 'result.txt': 'FAIL' },
  });
  // An attacker tries to swap in a friendlier check at verify-time.
  const v = await verifier.verify({ runId: 'r', command: 'ECHO everything is fine', verificationCommand: 'ECHO fine' });
  eq(v.exit, 1, 'the original failing command ran, not the injected one');
  eq(v.command, 'CHECK result.txt', 'verdict reports the immutable command');
});

// ── fail CLOSED on a malformed exit ─────────────────────────────────────
await test('a malformed / missing exit is a failure, never coerced to a pass', async () => {
  for (const bad of [undefined, null, NaN, false, true, '', '0', {}, 1.5]) {
    const v = await createVerifier({
      loadRuntime: () => ({ runCommand: async () => ({ exit: bad, stdout: '', stderr: '' }) }),
      verificationCommand: 'X',
    }).verify();
    assert(v.exit !== 0 && v.ok === false, `bad exit ${JSON.stringify(bad)} must NOT be a pass (got ${v.exit})`);
  }
  // a runtime that returns nothing at all → still a failure, not a pass.
  const none = await createVerifier({
    loadRuntime: () => ({ runCommand: async () => undefined }),
    verificationCommand: 'X',
  }).verify();
  eq(none.exit, 1, 'missing result → exit 1'); eq(none.ok, false, 'not ok');
  // a genuine integer zero is the ONLY pass; a non-zero integer is preserved.
  eq((await createVerifier({ loadRuntime: () => ({ runCommand: async () => ({ exit: 0 }) }), verificationCommand: 'X' }).verify()).ok, true, 'real 0 passes');
  const two = await createVerifier({ loadRuntime: () => ({ runCommand: async () => ({ exit: 2 }) }), verificationCommand: 'X' }).verify();
  eq(two.exit, 2, 'non-zero integer preserved'); eq(two.ok, false, 'non-zero not ok');
});

// ── wall 1 is load-bearing (not a JS tautology) ─────────────────────────
await test('wall 1: reusing a poisoned runtime WOULD launder; a fresh one does not', async () => {
  const mount = { 'result.txt': 'FAIL: suite failed' };
  // A runtime the agent already poisoned (assert patched in its namespace).
  const poisoned = new MockVerifierRuntime();
  await poisoned.runCommand('PATCH_ASSERT');
  // A verifier (mis)wired to REUSE that runtime launders the verdict — this is
  // exactly the attack wall 1 exists to stop.
  const reusing = createVerifier({ loadRuntime: () => poisoned, verificationCommand: 'CHECK result.txt', mount });
  eq((await reusing.verify()).exit, 0, 'reuse of the poisoned runtime launders (exit 0) — the attack works without wall 1');
  // The correct verifier builds a FRESH runtime; the ONLY difference is freshness,
  // and it flips the verdict to truthful. If verifier.mjs cached/reused, this fails.
  const fresh = createVerifier({ loadRuntime: () => new MockVerifierRuntime(), verificationCommand: 'CHECK result.txt', mount });
  eq((await fresh.verify()).exit, 1, 'fresh runtime → truthful non-zero; freshness IS the defense');
});

// ── a thrown runtime is a fail, never a silent pass ─────────────────────
await test('a runtime that throws yields exit 1, not a pass', async () => {
  const verifier = createVerifier({
    loadRuntime: () => ({ runCommand: async () => { throw new Error('kernel died'); } }),
    verificationCommand: 'CHECK x',
  });
  const v = await verifier.verify();
  eq(v.exit, 1, 'thrown → exit 1'); eq(v.ok, false, 'not ok');
  assert(/kernel died/.test(v.stderr), 'error captured');
});

// ── C7 wiring: the verdict is exactly what goals.markDone consumes ──────
await test('a failing verdict is refused by goals.markDone; a passing one flips the goal to done', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  let t = 1_700_000_000_000;
  const goals = createGoalStore({ fs, clock: () => (t += 1000) });
  await goals.create({ id: 'g1', goal: 'green the suite', grantPrefix: 'src', budget: 100, plan: [{ step: 'fix', doneCondition: 'suite passes' }] });

  // Agent claims done while the suite fails → verifier says exit 1 → markDone refuses.
  const failing = await createVerifier({
    loadRuntime: freshFactory(), verificationCommand: 'CHECK result.txt', mount: { 'result.txt': 'FAIL' },
  }).verify({ runId: 'run-a' });
  const refused = await goals.markDone('g1', failing);
  eq(refused.ok, false, 'markDone refuses a non-zero verdict');
  eq(refused.code, 'EVERIFY', 'refusal is EVERIFY');
  eq((await goals.get('g1')).status, 'active', 'goal is still active');

  // Suite genuinely green → verifier exit 0 → markDone flips it.
  const passing = await createVerifier({
    loadRuntime: freshFactory(), verificationCommand: 'CHECK result.txt', mount: { 'result.txt': 'PASS' },
  }).verify({ runId: 'run-b' });
  const done = await goals.markDone('g1', passing);
  eq(done.ok, true, 'markDone accepts a zero-exit verdict');
  eq((await goals.get('g1')).status, 'done', 'goal flipped to done');
  eq((await goals.get('g1')).verifiedBy.command, 'CHECK result.txt', 'verifiedBy records the command');
});

if (failures.length) {
  console.error(`verifier: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/kiln/verifier (K3 headless) conformance: ${passed}/${passed} passed`);
