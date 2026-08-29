// Conformance — Assay Run-Mode loop (the campaign reducer over the History ledger).
// Proves the sovereign durable loop: state = f(ledger), so park/resume = replay a
// prefix. No Restate.
//   node sys/assay/test/assay-loop.test.mjs
import { createAssayLedger } from '../ledger.mjs';
import { nextStep, shipReady, noDiscrimination, noProgress } from '../loop.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const C = 'c1';
const OWNER = 'actor:human:owner1', CHECKER = 'actor:agent:checker:c1', IMPL = 'actor:agent:builder:c1', LEAD = 'actor:agent:lead:c1';

// Block factories.
const campaign = (ship_bar = 0.85) => ({ type: 'assay.campaign', campaign: C, actor: OWNER, ts: 1, goal: 'samtools', ship_bar });
const instrument = (version = 1) => ({ type: 'assay.instrument.v1', campaign: C, actor: CHECKER, ts: 2, version, ratchet_sha: 'sha256:a' });
const candidate = (round, count = 5) => ({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 10 + round, round, git_ref: 'c' + round, from_directive: round >= 1 ? 'd' + (round - 1) : null, builder_tests: { count, deleted: 0 } });
const measure = (round, pass_mass) => ({ type: 'assay.measure', campaign: C, actor: CHECKER, ts: 20 + round, round, pass_mass, cluster_count: 1 });
const finding = (round, clusters) => ({ type: 'assay.finding.v1', campaign: C, actor: CHECKER, ts: 30 + round, round, clusters });
const directive = (round, sig = 'x') => ({ type: 'assay.directive.v1', campaign: C, actor: LEAD, ts: 40 + round, round, id: 'd' + round, from_findings: ['cl' + round], items: [{ area: 'view', weight: 3, instruction: sig }] });

async function ledgerOf(blocks) {
  const L = createAssayLedger();
  for (const b of blocks) await L.append(b);
  return L;
}
async function step(blocks, opts = {}) {
  return nextStep(await ledgerOf(blocks), { campaign: C, ...opts });
}

// ── the state machine, step by step ─────────────────────────────────────────────
await test('unstarted → owner starts the campaign', async () => {
  const s = await step([]);
  eq(s.phase, 'unstarted'); eq(s.next.actor, 'owner'); eq(s.next.action, 'campaign.start');
});
await test('campaign only → checker authors the instrument (before any build)', async () => {
  const s = await step([campaign()]);
  eq(s.next.actor, 'checker'); eq(s.next.action, 'build-instrument');
});
await test('instrument exists → builder builds candidate c0', async () => {
  const s = await step([campaign(), instrument()]);
  eq(s.next.actor, 'builder'); eq(s.next.action, 'build-candidate'); eq(s.next.round, 0);
});
await test('candidate c0 → checker measures round 0', async () => {
  const s = await step([campaign(), instrument(), candidate(0)]);
  eq(s.next.actor, 'checker'); eq(s.next.action, 'measure'); eq(s.next.round, 0);
});
await test('measured, below bar → lead adjudicates into a directive', async () => {
  const s = await step([campaign(), instrument(), candidate(0), measure(0, 0.5), finding(0, [{ id: 'cl0', weight: 3 }])]);
  eq(s.next.actor, 'lead'); eq(s.next.action, 'adjudicate'); eq(s.next.round, 0);
});
await test('directive issued → builder builds the next candidate', async () => {
  const s = await step([campaign(), instrument(), candidate(0), measure(0, 0.5), finding(0, [{ id: 'cl0', weight: 3 }]), directive(0)]);
  eq(s.next.actor, 'builder'); eq(s.next.action, 'build-candidate'); eq(s.next.round, 1);
});

// ── exits ───────────────────────────────────────────────────────────────────────
await test('SHIP: at/above bar, movement < ε, no open finding above the floor', async () => {
  const s = await step([
    campaign(0.85), instrument(),
    candidate(0), candidate(1),
    measure(0, 0.865), measure(1, 0.87),
    finding(1, [{ id: 'cl1', weight: 3 }]),
  ], { config: { weight_floor: 5, epsilon: 0.01 } });
  eq(s.exit, 'ship'); eq(s.next.actor, 'lead'); eq(s.next.action, 'propose-ship');
});
await test('EXPAND: instrument flat two rounds and still below bar → cannot ship', async () => {
  const flat = [{ id: 'A', pass_mass_delta: 0.1 }];
  const s = await step([
    campaign(0.85), instrument(),
    candidate(0), candidate(1), candidate(2),
    measure(0, 0.5), measure(1, 0.5), measure(2, 0.5),
    finding(1, flat), finding(2, flat),
  ]);
  eq(s.phase, 'expand'); eq(s.exit, undefined); eq(s.next.action, 'request-expansion');
});
await test('PARK: same directive 3× with flat pass-mass → no-progress', async () => {
  const s = await step([
    campaign(0.85), instrument(),
    candidate(0), candidate(1), candidate(2), candidate(3),
    measure(0, 0.5), measure(1, 0.5), measure(2, 0.5), measure(3, 0.5),
    finding(1, [{ id: 'a' }]), finding(2, [{ id: 'b' }]), finding(3, [{ id: 'c' }]), // differ → not no-discrimination
    directive(0, 'same'), directive(1, 'same'), directive(2, 'same'),
  ]);
  eq(s.exit, 'no-progress'); eq(s.next.action, 'park');
});
await test('PARK: a budget hit parks immediately, whatever the phase', async () => {
  const s = await step([campaign(), instrument(), candidate(0)], { budgetHit: true });
  eq(s.exit, 'no-progress'); eq(s.next.action, 'park');
});

// ── the durability proof: state = f(ledger), so resume = replay a prefix ─────────
await test('nextStep is a pure function of the ledger (deterministic)', async () => {
  const blocks = [campaign(), instrument(), candidate(0), measure(0, 0.5), finding(0, [{ id: 'cl0', weight: 3 }])];
  const a = await step(blocks);
  const b = await step(blocks);
  eq(JSON.stringify(a), JSON.stringify(b), 'same ledger → same next step');
});
await test('RESUME-BY-REPLAY: a prefix yields exactly the step that produced the next block', async () => {
  const full = [campaign(), instrument(), candidate(0), measure(0, 0.5), finding(0, [{ id: 'cl0', weight: 3 }]), directive(0), candidate(1)];
  // Drop the last block (candidate round 1). The reducer over the prefix must ask
  // for exactly that block — i.e. kill after the directive, resume, continue.
  const resumed = await step(full.slice(0, -1));
  eq(resumed.next.actor, 'builder'); eq(resumed.next.action, 'build-candidate'); eq(resumed.next.round, 1);
  // And the full ledger has moved past it (now wants to measure round 1).
  const after = await step(full);
  eq(after.next.action, 'measure'); eq(after.next.round, 1);
});

// ── predicate units ──────────────────────────────────────────────────────────────
await test('predicate: shipReady needs two measurements', async () => {
  const cfg = { ship_bar: 0.85, epsilon: 0.01, weight_floor: 5 };
  eq(shipReady([measure(0, 0.9)], [], cfg), false, 'one measure is not enough');
  eq(shipReady([measure(0, 0.9), measure(1, 0.905)], [], cfg), true, 'two, converged, clean → ship');
});
await test('predicate: noDiscrimination and noProgress fire only on their signatures', async () => {
  const same = [{ id: 'A', pass_mass_delta: 0.1 }];
  eq(noDiscrimination([finding(1, same), finding(2, same)]), true, 'identical rounds → flat');
  eq(noDiscrimination([finding(1, [{ id: 'A' }]), finding(2, [{ id: 'B' }])]), false, 'differing rounds → not flat');
  const cfg = { epsilon: 0.01, same_directive_cap: 3 };
  eq(noProgress([directive(0, 's'), directive(1, 's'), directive(2, 's')], [measure(0, 0.5), measure(1, 0.5), measure(2, 0.5)], cfg), true, 'same directive + flat → stuck');
});

if (failures.length) {
  console.error(`Assay loop: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Assay loop: ${passed} passed — campaign reducer over History (start→measure→adjudicate→implement), exits ship/expand/park, resume-by-replay. No Restate.`);
