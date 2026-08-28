// Conformance — P0.4 Staging (pure half): envelope, diff registry, commit authority.
//   node sys/staging/test/envelope.test.mjs
import { registerDiffType, getDiffType, clearRegistry, makeEnvelope, normalizeEnvelope, decideCommit, isExpired, newProposalId } from '../envelope.mjs';
import { issueGrant, attenuate, caveat, newRootKey } from '../../identity/grant.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// The registry is module-level; reset before seeding the app diff types.
clearRegistry();
registerDiffType('reckon', { key: 'cell-range', normalize: (d) => ({ kind: 'cells', ranges: d.ranges }) });
registerDiffType('draft', { key: 'prosemirror-steps', normalize: (d) => ({ kind: 'steps', steps: d.steps }) });

await test('M0: one reviewer seam normalizes a Reckon AND a Draft diff via the registry', async () => {
  const rEnv = makeEnvelope({ app: 'reckon', tool: 'reckon.stage', diff: { ranges: [{ a1: 'A1', before: '', after: '42' }] } });
  const dEnv = makeEnvelope({ app: 'draft', tool: 'draft.stage', diff: { steps: [{ insert: 'hi' }] } });
  eq(rEnv.preview_renderer, 'cell-range', 'reckon renderer key');
  eq(dEnv.preview_renderer, 'prosemirror-steps', 'draft renderer key');
  const rn = normalizeEnvelope(rEnv), dn = normalizeEnvelope(dEnv);
  eq(rn.kind, 'cells', 'reckon normalized'); eq(dn.kind, 'steps', 'draft normalized');
  eq(rn.ranges[0].after, '42', 'reckon payload preserved through the one seam');
});

await test('staging an app with no registered diff type fails loud', () => {
  let threw = false; try { makeEnvelope({ app: 'unknownapp', tool: 'x', diff: {} }); } catch (_) { threw = true; }
  assert(threw, 'no diff type → cannot stage');
});

await test('commit is person-only by default; an agent without an auto-commit grant is denied', async () => {
  eq(decideCommit({ actor: 'person', tool: 'reckon.commit' }).mode, 'person', 'person commits');
  const d = decideCommit({ actor: 'agent', tool: 'reckon.commit', reversible: true });
  eq(d.allowed, false, 'agent denied'); eq(d.mode, 'denied', 'denied mode');
});

await test('grant-scoped auto-commit allows an agent ONLY for reversible ops', async () => {
  const root = newRootKey();
  const g = await issueGrant(root, { caveats: [caveat.tools(['reckon.stage']), caveat.autoCommit(true)] });
  eq(decideCommit({ actor: 'agent', tool: 'reckon.commit', reversible: true, grant: g }).mode, 'auto', 'reversible → auto');
  eq(decideCommit({ actor: 'agent', tool: 'reckon.commit', reversible: false, grant: g }).allowed, false, 'irreversible → still denied');
  const gAny = await issueGrant(root, { caveats: [caveat.autoCommit(false)] }); // 'any'
  eq(decideCommit({ actor: 'agent', tool: 'x', reversible: false, grant: gAny }).mode, 'auto', 'auto-commit:any allows either');
});

await test('auto-commit is most-restrictive across a delegation chain', async () => {
  const root = newRootKey();
  // issuer permits ANY auto-commit; a worker attenuates to reversible-only
  let g = await issueGrant(root, { caveats: [caveat.autoCommit(false)] }); // 'any'
  g = await attenuate(g, caveat.autoCommit(true)); // 'reversible' — tightens
  eq(decideCommit({ actor: 'agent', tool: 'x', reversible: false, grant: g }).allowed, false, 'irreversible denied — worker tightening wins over issuer any');
  eq(decideCommit({ actor: 'agent', tool: 'x', reversible: true, grant: g }).mode, 'auto', 'reversible still allowed');
});

await test('expiry + proposal id', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.stage', diff: { ranges: [] }, expires: 1000 });
  assert(isExpired(env, 1001), 'expired past the deadline');
  assert(!isExpired(env, 999), 'live before it');
  assert(newProposalId().startsWith('prop_'), 'id shape');
  assert(getDiffType('reckon').key === 'cell-range', 'registry lookup');
});

if (failures.length) { console.error(`staging/envelope: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`staging/envelope conformance: ${passed}/${passed} passed`);
