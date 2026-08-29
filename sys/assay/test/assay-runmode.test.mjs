// Conformance — Assay Run-Mode driver (runCampaign over the ledger reducer).
// Proves a whole campaign runs start→ship through injected role executors, pauses at
// person-only gates, and the resulting ledger passes all three verifiers.
//   node sys/assay/test/assay-runmode.test.mjs
import { createAssayLedger } from '../ledger.mjs';
import { runCampaign } from '../runmode.mjs';
import { verifyWall, verifyTests, replay } from '../verify.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const C = 'c1';
const OWNER = 'actor:human:owner1', ASSAYER = 'actor:agent:assayer:c1', IMPL = 'actor:agent:implementer:c1', FOREMAN = 'actor:agent:foreman:c1';

// A deterministic campaign that converges to ship: pass-mass climbs and settles,
// finding weights fall below the floor. Each executor emits the block(s) its role
// would produce — the same blocks a real role-subagent would append.
const PM = (r) => [0.6, 0.8, 0.86, 0.865][r] ?? 0.87;
const WEIGHT = (r) => [10, 8, 4, 3][r] ?? 2;

function executors() {
  return {
    'campaign.start': () => ({ type: 'assay.campaign', campaign: C, actor: OWNER, ts: 1, goal: 'samtools', ship_bar: 0.85 }),
    'build-instrument': () => ({ type: 'assay.instrument.v1', campaign: C, actor: ASSAYER, ts: 2, version: 1, ratchet_sha: 'sha256:a' }),
    'build-candidate': ({ round }) => ({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 100 + round, round, git_ref: 'c' + round, from_directive: round >= 1 ? 'd' + (round - 1) : null, implementer_tests: { count: 5 + round, deleted: 0 } }),
    measure: ({ round }) => ([
      { type: 'assay.measure', campaign: C, actor: ASSAYER, ts: 200 + round, round, pass_mass: PM(round), cluster_count: 1 },
      { type: 'assay.finding.v1', campaign: C, actor: ASSAYER, ts: 250 + round, round, clusters: [{ id: 'cl' + round, area: 'view', weight: WEIGHT(round) }] },
    ]),
    adjudicate: ({ round }) => ({ type: 'assay.directive.v1', campaign: C, actor: FOREMAN, ts: 300 + round, round, id: 'd' + round, from_findings: ['cl' + round], items: [{ area: 'view', weight: 3, instruction: 'fix-' + round }] }),
    'propose-ship': ({ round }) => ({ type: 'assay.ship', campaign: C, actor: FOREMAN, ts: 900, round, candidate_ref: 'c' + round, foreman_rationale: 'pass-mass over bar, converged' }),
  };
}

await test('a full campaign runs start → ship through the driver', async () => {
  const L = createAssayLedger();
  const res = await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 } });
  eq(res.status, 'ship', 'campaign reaches the ship exit');
  eq(L.ofType('assay.ship', C).length, 1, 'a ship block was proposed');
  eq(L.ofType('assay.candidate', C).length, 4, 'candidates c0..c3 built');
  eq(L.ofType('assay.measure', C).length, 4, 'four measurement rounds');
  assert((await L.verifyIntegrity()).ok, 'ledger chain intact end to end');
});

await test('the shipped campaign passes all three verifiers', async () => {
  const L = createAssayLedger();
  await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 } });
  eq(verifyWall(L, { campaign: C }).code, 0, 'no wall breach');
  eq(verifyTests(L, { campaign: C }).code, 0, 'test count monotone (5,6,7,8)');
  eq(replay(L, { campaign: C }).code, 0, 'finding→directive→candidate lineage intact');
});

await test('missing executor pauses (the Owner must start the campaign)', async () => {
  const L = createAssayLedger();
  const ex = executors(); delete ex['campaign.start'];
  const res = await runCampaign({ ledger: L, campaign: C, executors: ex });
  eq(res.status, 'paused'); assert(/no executor/.test(res.reason), 'paused for the missing starter');
});

await test('a person-only gate that declines pauses for the human', async () => {
  const L = createAssayLedger();
  const ex = executors(); ex['propose-ship'] = () => null; // Owner not present to accept
  const res = await runCampaign({ ledger: L, campaign: C, executors: ex, config: { weight_floor: 5, epsilon: 0.01 } });
  eq(res.status, 'paused'); eq(res.reason, 'awaiting-human');
  eq(L.ofType('assay.ship', C).length, 0, 'no ship recorded without the human');
});

await test('maxIters bounds a runaway driver', async () => {
  const L = createAssayLedger();
  const res = await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 }, maxIters: 2 });
  eq(res.status, 'max-iters', 'the guard fires'); eq(res.iters, 3, 'stopped after the cap');
});

await test('resume: re-running the driver over the persisted ledger finishes the campaign', async () => {
  const L = createAssayLedger();
  await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 }, maxIters: 3 }); // stops early
  assert(L.ofType('assay.ship', C).length === 0, 'not shipped yet at the cap');
  const res = await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 } }); // resume
  eq(res.status, 'ship', 'resuming over the same ledger reaches ship');
});

if (failures.length) {
  console.error(`Assay run-mode: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Assay run-mode: ${passed} passed — driver runs a campaign start→ship, pauses at person-only gates, resumes over the persisted ledger, output passes wall|tests|replay.`);
