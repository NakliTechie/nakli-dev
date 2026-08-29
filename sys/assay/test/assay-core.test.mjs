// Conformance — Assay core (de-risk slice): the Grant wall, the assay.* ledger over
// History, and the three verifier hooks. Proves the one novel mechanism cheaply,
// on primitives that already exist — no Restate, no Menagerie, no UI.
//   node sys/assay/test/assay-core.test.mjs
import { newRootKey } from '../../identity/grant.mjs';
import { createAssayLedger, validateBlock, ASSAY_BLOCK_TYPES } from '../ledger.mjs';
import { mintRole, authorize, guardedAccess, ROLES, PERSON_ONLY } from '../roles.mjs';
import { verifyWall, verifyTests, replay } from '../verify.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const C = 'c1';
const OWNER = 'actor:human:owner1';
const CHECKER = 'actor:agent:checker:c1';
const IMPL = 'actor:agent:builder:c1';
const LEAD = 'actor:agent:lead:c1';
const NOW = 2000;
const mint = (rootKey, role, principal) => mintRole(rootKey, { campaign: C, role, principal, now: 1000, ttlMs: 3600_000 });
const ctx = (principal, tool, target) => ({ principal, tool, target, now: NOW });

async function cleanLedger() {
  const L = createAssayLedger();
  await L.append({ type: 'assay.campaign', campaign: C, actor: OWNER, ts: 1, goal: 'samtools view parity', ship_bar: 0.85 });
  await L.append({ type: 'assay.instrument.v1', campaign: C, actor: CHECKER, ts: 2, version: 1, ratchet_sha: 'sha256:aaa', areas: [], case_count: 0 });
  await L.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 3, round: 0, git_ref: 'c0', builder_tests: { count: 5, skipped: 0, deleted: 0 } });
  await L.append({ type: 'assay.finding.v1', campaign: C, actor: CHECKER, ts: 4, round: 0, instrument_version: 1, clusters: [{ id: 'cl1', area: 'view', weight: 3 }] });
  await L.append({ type: 'assay.directive.v1', campaign: C, actor: LEAD, ts: 5, round: 1, id: 'd1', from_findings: ['cl1'], items: [{ area: 'view', weight: 3, instruction: 'implement -H header' }] });
  await L.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 6, round: 1, git_ref: 'c1', from_directive: 'd1', builder_tests: { count: 7, skipped: 0, deleted: 0 } });
  return L;
}

// ── roles + the wall ──────────────────────────────────────────────────────────
await test('three role manifests mint, each a set of scoped grants', async () => {
  const rk = newRootKey();
  eq(ROLES.length, 3, 'three roles');
  const impl = await mint(rk, 'builder', IMPL);
  eq(impl.grants.length, 6, 'builder holds 6 grants');
  const assr = await mint(rk, 'checker', CHECKER);
  assert(assr.grants.length >= 5, 'checker holds its grant set');
  assert(PERSON_ONLY.includes('ship.accept'), 'ship.accept is declared person-only');
});

await test('the WALL: builder is denied the raw instrument scope; checker is granted it', async () => {
  const rk = newRootKey();
  const impl = await mint(rk, 'builder', IMPL);
  const assr = await mint(rk, 'checker', CHECKER);
  const target = `assay:${C}:instrument/case/42`;
  const dImpl = await authorize(impl, rk, ctx(IMPL, 'read', target));
  assert(!dImpl.ok, 'builder read of a raw instrument case must be denied');
  const aAssr = await authorize(assr, rk, ctx(CHECKER, 'read', target));
  assert(aAssr.ok, 'checker read of the instrument must be allowed');
});

await test('lead sees the summary leaf but NOT raw cases (scope disjointness)', async () => {
  const rk = newRootKey();
  const fore = await mint(rk, 'lead', LEAD);
  const summary = await authorize(fore, rk, ctx(LEAD, 'read', `assay:${C}:instrument:summary`));
  assert(summary.ok, 'lead may read the instrument summary');
  const rawCase = await authorize(fore, rk, ctx(LEAD, 'read', `assay:${C}:instrument/case/42`));
  assert(!rawCase.ok, 'lead must NOT reach a raw instrument case');
});

await test('builder owns its candidate (read+write) but cannot write the instrument', async () => {
  const rk = newRootKey();
  const impl = await mint(rk, 'builder', IMPL);
  assert((await authorize(impl, rk, ctx(IMPL, 'write', `assay:${C}:candidate`))).ok, 'builder writes candidate');
  assert(!(await authorize(impl, rk, ctx(IMPL, 'write', `assay:${C}:instrument`))).ok, 'builder cannot write instrument');
});

await test('a wrong-principal grant does not authorize (principal caveat binds)', async () => {
  const rk = newRootKey();
  const assr = await mint(rk, 'checker', CHECKER);
  // Present the checker's grant set but claim to be the builder.
  const forged = await authorize({ ...assr }, rk, ctx(IMPL, 'read', `assay:${C}:instrument`));
  assert(!forged.ok, 'the principal caveat must reject a mismatched actor');
});

// ── Grant → History: the breach lands in the ledger ─────────────────────────────
await test('guardedAccess: a denied instrument reach records an assay.wall.breach', async () => {
  const rk = newRootKey();
  const impl = await mint(rk, 'builder', IMPL);
  const L = createAssayLedger();
  const target = `assay:${C}:instrument/case/7`;
  const res = await guardedAccess(impl, rk, ctx(IMPL, 'read', target), L, { campaign: C, tool_call_id: 'tc1' });
  assert(!res.ok, 'the reach is denied');
  const breaches = L.ofType('assay.wall.breach', C);
  eq(breaches.length, 1, 'exactly one breach recorded');
  eq(breaches[0].actor, IMPL, 'breach attributes the builder');
  eq(breaches[0].scope, target, 'breach records the reached scope');
  assert((await L.verifyIntegrity()).ok, 'the breach is committed on an intact hash-chain');
});

await test('an ALLOWED access records no breach', async () => {
  const rk = newRootKey();
  const assr = await mint(rk, 'checker', CHECKER);
  const L = createAssayLedger();
  const res = await guardedAccess(assr, rk, ctx(CHECKER, 'read', `assay:${C}:instrument`), L, { campaign: C });
  assert(res.ok, 'checker instrument read allowed');
  eq(L.ofType('assay.wall.breach', C).length, 0, 'no breach on an allowed access');
});

// ── ledger validation + integrity ───────────────────────────────────────────────
await test('validateBlock accepts known blocks, allows forward assay.* types, rejects the rest', async () => {
  eq(ASSAY_BLOCK_TYPES.includes('assay.finding.v1'), true, 'finding is a known type');
  eq(validateBlock({ type: 'assay.campaign', campaign: C, actor: OWNER, ts: 1, goal: 'g', ship_bar: 0.85 }), null, 'valid campaign');
  eq(validateBlock({ type: 'assay.future', campaign: C, actor: OWNER, ts: 1 }), null, 'unknown assay.* allowed (additionalBlockTypes: allow)');
  assert(validateBlock({ type: 'assay.future', campaign: C, actor: OWNER, ts: 1 }, { allowUnknown: false }), 'strict mode rejects unknown');
  assert(validateBlock({ type: 'reckon.stage', campaign: C, actor: OWNER, ts: 1 }), 'non-assay type rejected');
  assert(validateBlock({ type: 'assay.finding.v1', campaign: C, actor: CHECKER, ts: 1, clusters: [] }), 'finding with empty clusters rejected');
});

await test('tampering a committed block breaks integrity', async () => {
  const L = await cleanLedger();
  assert((await L.verifyIntegrity()).ok, 'clean ledger verifies');
  L.blocks[0].goal = 'silently changed';
  assert(!(await L.verifyIntegrity()).ok, 'a post-hoc edit is caught');
});

// ── verifier hooks: green on clean, red on each seeded negative ──────────────────
await test('verify wall|tests + replay all pass on a clean campaign', async () => {
  const L = await cleanLedger();
  eq(verifyWall(L, { campaign: C }).code, 0, 'wall clean');
  eq(verifyTests(L, { campaign: C }).code, 0, 'tests monotone');
  eq(replay(L, { campaign: C }).code, 0, 'lineage intact');
});

await test('verify wall fails on a seeded breach', async () => {
  const L = await cleanLedger();
  await L.append({ type: 'assay.wall.breach', campaign: C, actor: IMPL, ts: 7, scope: `assay:${C}:instrument/case/9`, tool_call_id: 'x' });
  eq(verifyWall(L, { campaign: C }).code, 1, 'a breach fails the wall verifier');
});

await test('verify tests fails on a deleted test with no reason, passes with a reason', async () => {
  const bad = createAssayLedger();
  await bad.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 1, round: 0, git_ref: 'a', builder_tests: { count: 5, deleted: 0 } });
  await bad.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 2, round: 1, from_directive: 'd', builder_tests: { count: 4, deleted: 2 } });
  eq(verifyTests(bad, { campaign: C }).code, 1, 'deleted tests with no reason fails');

  const ok = createAssayLedger();
  await ok.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 1, round: 0, git_ref: 'a', builder_tests: { count: 5, deleted: 0 } });
  await ok.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 2, round: 1, from_directive: 'd', builder_tests: { count: 4, deleted: 2 }, test_change_reason: 'merged duplicate suites' });
  eq(verifyTests(ok, { campaign: C }).code, 0, 'deleted tests WITH a ledger reason passes');
});

await test('verify tests fails on a silent count decrease', async () => {
  const L = createAssayLedger();
  await L.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 1, round: 0, git_ref: 'a', builder_tests: { count: 9, deleted: 0 } });
  await L.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 2, round: 1, from_directive: 'd', builder_tests: { count: 6, deleted: 0 } });
  eq(verifyTests(L, { campaign: C }).code, 1, 'a count drop with no reason fails');
});

await test('replay fails on a directive citing an unknown finding', async () => {
  const L = createAssayLedger();
  await L.append({ type: 'assay.finding.v1', campaign: C, actor: CHECKER, ts: 1, round: 0, clusters: [{ id: 'cl1' }] });
  await L.append({ type: 'assay.directive.v1', campaign: C, actor: LEAD, ts: 2, round: 1, id: 'd1', from_findings: ['ghost'], items: [] });
  eq(replay(L, { campaign: C }).code, 1, 'a directive with no originating finding is a lineage gap');
});

await test('replay fails on a candidate citing an unknown directive', async () => {
  const L = createAssayLedger();
  await L.append({ type: 'assay.finding.v1', campaign: C, actor: CHECKER, ts: 1, round: 0, clusters: [{ id: 'cl1' }] });
  await L.append({ type: 'assay.directive.v1', campaign: C, actor: LEAD, ts: 2, round: 1, id: 'd1', from_findings: ['cl1'], items: [] });
  await L.append({ type: 'assay.candidate', campaign: C, actor: IMPL, ts: 3, round: 1, from_directive: 'ghost', builder_tests: { count: 1 } });
  eq(replay(L, { campaign: C }).code, 1, 'a candidate with no originating directive is a lineage gap');
});

if (failures.length) {
  console.error(`Assay core: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Assay core: ${passed} passed — Grant wall denies + records breach; assay.* ledger on History; verify wall|tests + replay green on clean, red on seeded negatives.`);
