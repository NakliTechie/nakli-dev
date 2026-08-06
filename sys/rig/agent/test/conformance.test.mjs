// C4 conformance suite — the gate artifact for the Rig agent face.
//
//   node sys/rig/agent/test/conformance.test.mjs
//
// Covers RIG §6/§12: every escape class + grant edge rejected; destructive ops
// stage and only run on accept; the op-log records every call and replaying the
// recorded sequence reconstructs the exact tree; with the developer setting off
// window.rig is undefined.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace, installWindowRig, digestArgs } from '../index.mjs';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h >>> 0;
}
async function treeHash(fs, cwd) {
  const g = await fs.glob('**', { cwd });
  const parts = [];
  for (const p of g.matches.sort()) {
    const r = await fs.read(p);
    parts.push(p + '\0' + Array.from(r.data).join(','));
  }
  return fnv(parts.join('\n'));
}

function setup({ prefixes = ['work'], scopes = ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const logFs = createFileops({ backend: new MemoryBackend() }); // op-log on its own store
  let clock = 1000;
  const opLog = createOpLog({ fs: logFs, now: () => (clock += 1) });
  const grant = createGrant({ prefixes, scopes });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', caller: 'sess-1' });
  return { fs, registry, opLog, grant, face };
}

// ── escape-class matrix — every class rejected, no throw ─────────────────
await test('escape-class matrix: every out-of-grant / traversal path is rejected', async () => {
  const { face } = setup();
  const escapes = ['../secret', '/etc/passwd', 'work/../secret', '%2e%2e/x', '..\\x', 'other/x.txt'];
  for (const p of escapes) {
    let threw = false, res;
    try { res = await face.invoke('fs.write', { path: p, data: 'x' }); } catch (_) { threw = true; }
    assert(!threw, `${p}: must not throw`);
    eq(res.ok, false, `${p}: rejected`);
    eq(res.code, 'EGRANT', `${p}: EGRANT (got ${res.code})`);
  }
  const ok = await face.invoke('fs.write', { path: 'work/a.txt', data: 'hi' });
  assert(ok.ok, 'an in-grant write is allowed');
});

// ── grant edges ──────────────────────────────────────────────────────────
await test('grant edges: scope withheld, revocation, and prefix boundary', async () => {
  const noRemove = setup({ scopes: ['fs:read', 'fs:write'] });
  await noRemove.face.invoke('fs.write', { path: 'work/a.txt', data: 'x' });
  eq((await noRemove.face.invoke('fs.remove', { path: 'work/a.txt' })).code, 'EGRANT', 'fs:remove scope withheld');

  const revoked = setup();
  await revoked.face.invoke('fs.write', { path: 'work/a.txt', data: 'x' });
  revoked.grant.revoke();
  eq((await revoked.face.invoke('fs.read', { path: 'work/a.txt' })).code, 'EGRANT', 'revoked grant denies');

  const bounded = setup({ prefixes: ['work'], scopes: ['fs:read', 'fs:write'] });
  eq((await bounded.face.invoke('fs.write', { path: 'workshop/x', data: 'x' })).code, 'EGRANT', 'workshop is not under work');
});

// ── destructive staging ──────────────────────────────────────────────────
await test('destructive ops stage a proposal and only run on accept', async () => {
  const { fs, face } = setup();
  await face.invoke('fs.write', { path: 'work/a.txt', data: 'A' });
  const staged = await face.invoke('fs.remove', { path: 'work/a.txt' });
  eq(staged.staged, true, 'remove is staged, not executed');
  assert(staged.proposalId, 'proposal id issued');
  assert((await fs.stat('work/a.txt')).ok, 'file still present while staged');
  const acc = await face.accept(staged.proposalId);
  assert(acc.ok, 'accept executes the removal');
  eq((await fs.stat('work/a.txt')).code, 'ENOENT', 'file gone after accept');

  await face.invoke('fs.write', { path: 'work/b.txt', data: 'B' });
  const s2 = await face.invoke('fs.remove', { path: 'work/b.txt' });
  assert(face.reject(s2.proposalId), 'reject returns true');
  assert((await fs.stat('work/b.txt')).ok, 'file survives a rejected proposal');
  eq((await face.accept(s2.proposalId)).code, 'ENOPROPOSAL', 'a rejected proposal cannot be accepted');
});

// ── op-log fidelity + replay reconstructs the tree ───────────────────────
await test('op-log records every call and replaying the sequence reconstructs the tree', async () => {
  const A = setup();
  const ops = [
    ['fs.write', { path: 'work/a.txt', data: 'A' }],
    ['fs.write', { path: 'work/b.txt', data: 'B' }],
    ['fs.mkdir', { path: 'work/d' }],
    ['fs.write', { path: 'work/d/c.txt', data: 'C' }],
  ];
  for (const [n, i] of ops) assert((await A.face.invoke(n, i)).ok, `${n} ok`);
  const log = await A.opLog.read();
  eq(log.length, ops.length, 'one entry per op');
  for (let k = 0; k < ops.length; k++) {
    eq(log[k].command, ops[k][0], `entry ${k} command`);
    eq(log[k].status, 'ok', `entry ${k} status`);
    eq(log[k].argsDigest, digestArgs(ops[k][1]), `entry ${k} args digest fidelity`);
    eq(log[k].actor, 'agent', `entry ${k} actor`);
    eq(log[k].caller, 'sess-1', `entry ${k} caller`);
  }
  // Replay the recorded sequence into a fresh tree → identical hash (empty diff).
  const B = setup();
  for (const [n, i] of ops) await B.face.invoke(n, i);
  eq(await treeHash(B.fs, 'work'), await treeHash(A.fs, 'work'), 'replay reconstructs the exact tree');
});

await test('op-log redacts token-shaped strings before digesting', async () => {
  const { face, opLog } = setup();
  // A token-shaped value must not change the digest vs its redacted form.
  await face.invoke('fs.write', { path: 'work/x.txt', data: 'ghp_ABCDEFGHIJKLMNOPQRSTUV0123456789' });
  const log = await opLog.read();
  const last = log[log.length - 1];
  eq(last.argsDigest, digestArgs({ path: 'work/x.txt', data: '[redacted]' }), 'digest is over the redacted args');
});

// ── window.rig is off by default ─────────────────────────────────────────
await test('window.rig is undefined with the setting off, present with it on', async () => {
  const { face } = setup();
  const target = {};
  installWindowRig({ target, enabled: false, face });
  eq(target.rig, undefined, 'off → window.rig undefined');
  const uninstall = installWindowRig({ target, enabled: true, face });
  assert(target.rig && typeof target.rig.invoke === 'function', 'on → window.rig.invoke present');
  assert(Array.isArray(target.rig.tools()), 'window.rig.tools() emits tool schemas');
  eq(target.rig.grant().active, true, 'window.rig.grant() describes the active grant');
  uninstall();
  eq(target.rig, undefined, 'uninstall → window.rig undefined');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C4 conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C4 conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
