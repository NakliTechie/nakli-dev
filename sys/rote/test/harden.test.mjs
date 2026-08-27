// Conformance — the harden loop control flow (handoff §4). Fakes stand in for the
// effectful primitives (run/mine/trim/apply/history); this proves termination,
// the wall path, the pass budget, and the §4.3 codify whitelist.
//   node sys/rote/test/harden.test.mjs
import { runHarden, admissibleCodification, HARDEN_TOOLS, CODIFY_WHITELIST } from '../harden.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// A fake harden environment: a scripted sequence of run records (newest pushed
// each pass) drives rote check; primitives record calls.
function fakeEnv(runSequence) {
  const history = []; let i = 0; const calls = { run: 0, mine: 0, trim: 0, apply: 0, trail: 0 };
  const primitives = {
    async run() { calls.run++; const r = runSequence[Math.min(i, runSequence.length - 1)]; i++; history.unshift({ status: 'complete', ok: 0, failed: 0, failures: {}, exploreCalls: 0, ...r, runId: 'r' + i }); return history[0]; },
    async mine() { calls.mine++; return { codifications: [{ kind: 'selector', observations: 5 }], handlers: [] }; },
    async trim(proposal) { calls.trim++; return { accepted: proposal.codifications, rejected: [], reasons: [] }; },
    async apply(script) { calls.apply++; return { script, version: (script.version || 1) + 1 }; },
    async history() { return history.slice(); },
    async trail() { calls.trail++; },
  };
  return { primitives, calls };
}

await test('harden reaches GREEN when explore() drops to 0 within budget', async () => {
  // pass1: explore 4/fail 40 · pass2: 2/20 · pass3: 0/5  → rote check clean-green
  const { primitives, calls } = fakeEnv([
    { exploreCalls: 4, ok: 60, failed: 40, failures: { edge: 40 } },
    { exploreCalls: 2, ok: 80, failed: 20, failures: { edge: 20 } },
    { exploreCalls: 0, ok: 99, failed: 1, failures: { edge: 1 } }, // within 2% budget → clean green
  ]);
  const res = await runHarden({ script: { name: 's', version: 1 }, sample: {}, primitives });
  eq(res.outcome, 'green', 'green'); eq(res.passes, 3, 'terminated on pass 3');
  assert(calls.trail === 3, 'a trail entry per pass');
});

await test('harden hits the WALL when a failure class is stuck across 3 runs', async () => {
  const stuck = { exploreCalls: 3, ok: 60, failed: 40, failures: { captcha: 40 } };
  const { primitives } = fakeEnv([stuck, stuck, stuck, stuck]);
  const res = await runHarden({ script: { name: 's', version: 1 }, sample: {}, primitives });
  eq(res.outcome, 'wall', 'wall'); eq(res.decision.failureClass, 'captcha', 'names the stuck class');
});

await test('harden stops at the pass budget when it never converges', async () => {
  // strictly improving forever → never green, never walled
  const seq = Array.from({ length: 10 }, (_, k) => ({ exploreCalls: 20 - k, ok: 0, failed: 20 - k, failures: { x: 20 - k } }));
  const { primitives, calls } = fakeEnv(seq);
  const res = await runHarden({ script: { name: 's', version: 1 }, sample: {}, primitives, maxPasses: 4 });
  eq(res.outcome, 'budget', 'budget'); eq(res.passes, 4, 'ran the budget'); eq(calls.run, 4, 'ran 4 times');
});

await test('admissibleCodification enforces the §4.3 whitelist', () => {
  assert(admissibleCodification({ kind: 'selector', observations: 1 }).ok, 'selector ok');
  assert(!admissibleCodification({ kind: 'clicking', observations: 9 }).ok, 'non-whitelisted kind rejected');
  assert(!admissibleCodification({ kind: 'selector', observations: 0 }).ok, 'zero observations rejected');
  assert(!admissibleCodification({ kind: 'regex', needsSecret: true, observations: 5 }).ok, 'secret-derived rejected');
  assert(!admissibleCodification({ kind: 'selector', fromLoopingTrace: true, observations: 5 }).ok, 'looping-trace rejected');
  assert(!admissibleCodification({ kind: 'classification', observations: 2 }).ok, 'classification under min-obs rejected');
  assert(admissibleCodification({ kind: 'classification', observations: 3 }).ok, 'classification at min-obs ok');
  assert(!admissibleCodification({ kind: 'url-pattern', mutating: true, personAccepted: false, observations: 5 }).ok, 'unaccepted mutating rejected');
});

await test('runHarden filters out non-admissible codifications even if trim accepted them', async () => {
  const { primitives } = fakeEnv([{ exploreCalls: 0, ok: 100, failed: 0 }, { exploreCalls: 0, ok: 100, failed: 0 }]);
  // trim returns a looping-trace codification; runHarden must drop it before apply
  let appliedAccepted = null;
  primitives.trim = async () => ({ accepted: [{ kind: 'selector', fromLoopingTrace: true, observations: 9 }], rejected: [], reasons: [] });
  primitives.apply = async (script, accepted) => { appliedAccepted = accepted; return { script, version: 2 }; };
  await runHarden({ script: { name: 's', version: 1 }, sample: {}, primitives });
  eq(appliedAccepted.length, 0, 'looping-trace codification dropped before apply');
});

await test('constants exported', () => {
  eq(JSON.stringify(HARDEN_TOOLS), JSON.stringify(['read', 'edit', 'apply_patch', 'todowrite', 'dispatch', 'review']), 'tools');
  assert(CODIFY_WHITELIST.includes('selector') && CODIFY_WHITELIST.includes('classification'), 'whitelist');
});

if (failures.length) {
  console.error(`harden: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`harden conformance: ${passed}/${passed} passed`);
