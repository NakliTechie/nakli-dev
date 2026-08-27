// Conformance — `rote check` termination decision (handoff §4.4).
//   node sys/rote/test/check.test.mjs
import { roteCheck, DEFAULT_FAIL_BUDGET } from '../check.mjs';

let passed = 0; const failures = [];
function test(n, fn) { try { fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const run = (o) => ({ status: 'complete', exploreCalls: 0, ok: 0, failed: 0, failures: {}, ...o });

test('needs ≥2 completed runs → keep iterating', () => {
  eq(roteCheck([]).exit, 1, 'none');
  eq(roteCheck([run({})]).exit, 1, 'one');
  eq(roteCheck([run({}), { status: 'error' }]).exit, 1, 'error run not counted');
});

test('clean green — explore==0 and fail rate within budget', () => {
  const runs = [run({ exploreCalls: 0, ok: 990, failed: 10 }), run({ exploreCalls: 5, ok: 900, failed: 100 })];
  eq(roteCheck(runs).exit, 0, 'exit 0'); // 10/1000 = 1% ≤ 2%
});

test('not clean when fail rate exceeds budget', () => {
  const runs = [run({ exploreCalls: 0, ok: 900, failed: 100 }), run({ exploreCalls: 0, ok: 890, failed: 110 })];
  // explore==0 both, failed 110→100 decreased → improving, not green-clean (rate 10% > 2%)
  eq(roteCheck(runs).exit, 1, 'still improving');
});

test('converged green — plateaued with no stuck failure class (3 runs)', () => {
  // explore plateaued at 8 > 0, failures ~0 → not clean, not walled (no failure
  // class), converged → green. Needs 3 runs so wall can be ruled out first.
  const flat = run({ exploreCalls: 8, ok: 1000, failed: 0, failures: {} });
  eq(roteCheck([flat, flat, flat]).exit, 0, 'converged');
});

test('two runs never green on a plateau — gathers a third run first', () => {
  const stuck = run({ exploreCalls: 3, ok: 60, failed: 40, failures: { captcha: 40 } });
  eq(roteCheck([stuck, stuck]).exit, 1, 'a stuck-from-start pair keeps iterating, does not green');
});

test('wall — dominant failure class stuck across 3 runs → exit 2 (human)', () => {
  const runs = [run({ exploreCalls: 3, ok: 100, failed: 40, failures: { captcha: 40 } }),
                run({ exploreCalls: 3, ok: 100, failed: 40, failures: { captcha: 40 } }),
                run({ exploreCalls: 3, ok: 100, failed: 38, failures: { captcha: 38 } })];
  const r = roteCheck(runs);
  eq(r.exit, 2, 'wall'); eq(r.failureClass, 'captcha', 'names the class');
});

test('improving — metrics still decreasing → keep iterating', () => {
  const runs = [run({ exploreCalls: 4, ok: 970, failed: 30, failures: { x: 30 } }),
                run({ exploreCalls: 9, ok: 940, failed: 60, failures: { x: 60 } })];
  eq(roteCheck(runs).exit, 1, 'exploreCalls 9→4 and failed 60→30 both decreased');
});

test('happy path drives to clean green as explore reaches 0', () => {
  // run3 vs run2: explore 2→0, failed within budget → clean green (the §10 Harden gate end-state)
  const runs = [run({ exploreCalls: 0, ok: 995, failed: 5, failures: { edge: 5 } }),
                run({ exploreCalls: 2, ok: 980, failed: 20, failures: { edge: 20 } })];
  eq(roteCheck(runs).exit, 0, 'green once explore==0 and rate ≤ budget');
});

test('default budget constant', () => { eq(DEFAULT_FAIL_BUDGET, 0.02, 'default'); });

if (failures.length) {
  console.error(`rote-check: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`rote-check conformance: ${passed}/${passed} passed`);
