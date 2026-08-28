// Conformance — P0.1 enforcement (Batch 4): the agent face checks a presented
// capability grant, ADDITIVELY (no-capability path unchanged), and logs denials.
//   node sys/rig/agent/test/agent-face-capability.test.mjs
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../index.mjs';
import { issueGrant, verifyGrant, caveat, newRootKey } from '../../../identity/grant.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '') }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const NOW = Date.parse('2026-08-27T12:00:00Z');
function stack() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  return { fs, registry, grant, opLog };
}
// A capability closure the app would build: bind the macaroon grant + root key.
function capabilityFor(grantObj, root, { principal = 'prin_agent', revoked = new Set() } = {}) {
  return { verify: ({ tool, target }) => verifyGrant(grantObj, root, { principal, tool, target, now: NOW, revocationList: revoked }) };
}

await test('additive: a face with NO capability behaves exactly as before', async () => {
  const { registry, grant, opLog } = stack();
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const r = await face.invoke('fs.write', { path: 'a.txt', data: 'hi' });
  assert(r && (r.ok || r.staged) , 'write proceeds (ok or staged) with no capability layer');
});

await test('capability grants the tool → the call proceeds', async () => {
  const { registry, grant, opLog } = stack();
  const root = newRootKey();
  const cap = await issueGrant(root, { caveats: [caveat.principal('prin_agent'), caveat.tools(['fs.write']), caveat.ttl(NOW + 1e6)] });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', capability: capabilityFor(cap, root) });
  const r = await face.invoke('fs.write', { path: 'a.txt', data: 'hi' });
  assert(r && (r.ok || r.staged), 'granted tool proceeds');
  assert(r.code !== 'ECAP', 'not capability-denied');
});

await test("capability WITHOUT the tool → denied ECAP and logged (the M0: fails loud + logs)", async () => {
  const { registry, grant, opLog } = stack();
  const root = newRootKey();
  const cap = await issueGrant(root, { caveats: [caveat.principal('prin_agent'), caveat.tools(['fs.read']), caveat.ttl(NOW + 1e6)] });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', capability: capabilityFor(cap, root) });
  const r = await face.invoke('fs.write', { path: 'a.txt', data: 'hi' }); // fs.write not in [fs.read]
  eq(r.ok, false, 'denied'); eq(r.code, 'ECAP', 'capability denial code');
  const log = await opLog.read();
  assert(log.some((e) => e.status === 'ECAP' && e.command === 'fs.write'), 'denial recorded in History');
});

await test('a revoked capability is denied', async () => {
  const { registry, grant, opLog } = stack();
  const root = newRootKey();
  const cap = await issueGrant(root, { caveats: [caveat.principal('prin_agent'), caveat.tools(['fs.write']), caveat.ttl(NOW + 1e6)] });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', capability: capabilityFor(cap, root, { revoked: new Set([cap.identifier]) }) });
  const r = await face.invoke('fs.write', { path: 'a.txt', data: 'hi' });
  eq(r.code, 'ECAP', 'revoked → denied'); assert(/revoked/.test(r.message), r.message);
});

await test('capability is also enforced at accept() time for staged destructive ops', async () => {
  const { registry, grant, opLog } = stack();
  const root = newRootKey();
  // grant fs.write but not fs.remove; stage a remove via a permissive capability, then narrow at accept
  const cap = await issueGrant(root, { caveats: [caveat.principal('prin_agent'), caveat.tools(['fs.write', 'fs.remove']), caveat.ttl(NOW + 1e6)] });
  const revoked = new Set();
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', capability: capabilityFor(cap, root, { revoked }) });
  const staged = await face.invoke('fs.remove', { path: 'a.txt' });
  assert(staged.staged, 'destructive remove staged');
  revoked.add(cap.identifier); // capability revoked between stage and accept
  const accepted = await face.accept(staged.proposalId, { by: 'operator' });
  eq(accepted.code, 'ECAP', 'accept re-checks capability → denied after revocation');
});

if (failures.length) { console.error(`agent-face-capability: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`agent-face-capability conformance: ${passed}/${passed} passed`);
