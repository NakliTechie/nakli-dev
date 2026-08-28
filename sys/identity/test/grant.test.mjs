// Conformance — P0.1 agent capability tokens (Grant). The M0 vector: a person-issued
// grant presented by an Anvil call to Reckon's face, accepted/rejected by caveat.
//   node sys/identity/test/grant.test.mjs
import { issueGrant, attenuate, verifyGrant, caveat, newRootKey, newGrantId, readCaveat } from '../grant.mjs';
import { b64uDecode, b64uEncode } from '../crypto.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const AGENT = 'prin_agent', PERSON = 'prin_person';
const T0 = Date.parse('2026-08-27T12:00:00Z');
const TTL = T0 + 10 * 60 * 1000;
async function personGrant(root) {
  return issueGrant(root, { identifier: 'grant_demo', caveats: [
    caveat.principal(AGENT), caveat.tools(['reckon.stage']), caveat.scope('reckon:sheet/budget'),
    caveat.ttl(TTL), caveat.budget({ calls: 50 }), caveat.issuer(PERSON),
  ] });
}
const ctx = (over) => ({ principal: AGENT, tool: 'reckon.stage', target: 'reckon:sheet/budget/A1', now: T0, usage: { calls: 0 }, ...over });

await test('M0: a valid in-scope call is accepted', async () => {
  const root = newRootKey();
  const g = await personGrant(root);
  eq((await verifyGrant(g, root, ctx())).ok, true, 'reckon.stage in scope, in ttl, in budget');
});

await test('M0: reckon.commit is rejected (not in the tool allowlist)', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  const r = await verifyGrant(g, root, ctx({ tool: 'reckon.commit' }));
  eq(r.ok, false, 'rejected'); assert(/not in/.test(r.reason), r.reason);
});

await test('M0: an expired call is rejected (ttl)', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  const r = await verifyGrant(g, root, ctx({ now: TTL + 1 }));
  eq(r.ok, false, 'rejected'); assert(/expired/.test(r.reason), r.reason);
});

await test('M0: wrong principal, out-of-scope target, and budget exhaustion all reject', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  assert(!(await verifyGrant(g, root, ctx({ principal: 'prin_other' }))).ok, 'wrong principal');
  assert(!(await verifyGrant(g, root, ctx({ target: 'reckon:sheet/salaries' }))).ok, 'out of scope');
  assert(!(await verifyGrant(g, root, ctx({ usage: { calls: 51 } }))).ok, 'budget exhausted');
});

await test('delegation: a narrower worker sub-grant works; a widening attempt is ineffective', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  // narrow to a worker: tighter budget + a worker principal
  const WORKER = 'prin_worker';
  let worker = await attenuate(g, caveat.principal(WORKER));   // now requires principal==WORKER too
  worker = await attenuate(worker, caveat.budget({ calls: 5 })); // tighter budget
  // worker must present as WORKER (the added caveat) — and the parent principal caveat is AGENT,
  // so a single call can't satisfy both unless AGENT==WORKER. This models "worker acts, parent delegated":
  // re-issue a clean parent for the worker line without the AGENT principal pin:
  const g2 = await issueGrant(root, { identifier: 'grant_line', caveats: [caveat.tools(['reckon.stage']), caveat.ttl(TTL)] });
  const w2 = await attenuate(g2, caveat.tools(['reckon.stage'])); // still narrow
  eq((await verifyGrant(w2, root, ctx({ principal: WORKER }))).ok, true, 'worker can stage');
  // widening: worker tries to add reckon.commit
  const wide = await attenuate(g2, caveat.tools(['reckon.stage', 'reckon.commit']));
  const r = await verifyGrant(wide, root, ctx({ principal: WORKER, tool: 'reckon.commit' }));
  eq(r.ok, false, 'the parent tools caveat still blocks reckon.commit — widening is ineffective');
});

await test('tamper: flipping the signature or dropping a caveat fails verification', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  const bad = b64uDecode(g.sig); bad[0] ^= 0xff;
  assert(!(await verifyGrant({ ...g, sig: b64uEncode(bad) }, root, ctx())).ok, 'flipped sig fails');
  const dropped = { ...g, caveats: g.caveats.filter((c) => c.type !== 'tools') };
  assert(!(await verifyGrant(dropped, root, ctx())).ok, 'dropping a caveat breaks the chain');
});

await test('revocation: a revoked grant id is rejected', async () => {
  const root = newRootKey(); const g = await personGrant(root);
  const r = await verifyGrant(g, root, ctx({ revocationList: new Set([g.identifier]) }));
  eq(r.ok, false, 'revoked'); eq(r.reason, 'revoked', 'reason');
});

await test('unknown caveat type fails closed', async () => {
  const root = newRootKey();
  const g = await issueGrant(root, { identifier: 'g_weird', caveats: [{ type: 'weird', value: 1 }] });
  const r = await verifyGrant(g, root, ctx());
  eq(r.ok, false, 'rejected'); assert(/unknown caveat/.test(r.reason), r.reason);
});

await test('readCaveat surfaces the auto-commit flag for the staging layer', async () => {
  const root = newRootKey();
  const g = await issueGrant(root, { caveats: [caveat.tools(['x.stage']), caveat.autoCommit(true)] });
  eq(readCaveat(g, 'auto-commit'), 'reversible', 'auto-commit read');
  assert(newGrantId().startsWith('grant_'), 'id shape');
});

if (failures.length) { console.error(`identity/grant: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`identity/grant conformance: ${passed}/${passed} passed`);
