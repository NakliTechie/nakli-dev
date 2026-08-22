// Kiln Worker-runtime headless seams. The actual Worker + Pyodide execution is
// covered by test/kiln-worker-harness.html in a cross-origin-isolated browser.

import { MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFsBridge } from '../fs-bridge.mjs';
import {
  fromRigJsonValue,
  snapshotBridge,
  syncWorkerSnapshot,
  toRigJsonValue,
} from '../worker-runtime.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (error) { failures.push({ name, message: error.message }); }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert'); }
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'ne'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function makeGovernedMount({ prefixes = [''] } = {}) {
  const backend = new MemoryBackend();
  const bridge = createFsBridge({ backend, mount: 'workspace' });
  const registry = buildRigRegistry({ fs: bridge._fs });
  const grant = createGrant({ prefixes, scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const logFs = createFsBridge({ backend: new MemoryBackend(), mount: 'audit' })._fs;
  const opLog = createOpLog({ fs: logFs, now: () => 42 });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', caller: 'kiln-test' });
  return { backend, bridge, face, opLog };
}

await test('Rig JSON codec preserves nested binary values', async () => {
  const source = { ok: true, data: new Uint8Array([0, 1, 127, 255]), nested: [new Uint8Array([9])] };
  const decoded = fromRigJsonValue(JSON.parse(JSON.stringify(toRigJsonValue(source))));
  assert(decoded.data instanceof Uint8Array, 'data decoded to Uint8Array');
  eq([...decoded.data].join(','), '0,1,127,255', 'data bytes');
  eq([...decoded.nested[0]].join(','), '9', 'nested bytes');
});

await test('snapshotBridge captures directories and files byte-identically', async () => {
  const { bridge } = makeGovernedMount();
  await bridge.mkdir('nested', { createParents: true });
  await bridge.write('nested/a.bin', new Uint8Array([0, 2, 4, 8]));
  const snapshot = await snapshotBridge(bridge);
  assert(snapshot.dirs.includes('nested'), 'directory captured');
  const file = snapshot.files.find((entry) => entry.path === 'nested/a.bin');
  assert(file, 'file captured');
  eq([...file.data].join(','), '0,2,4,8', 'file bytes');
});

await test('Worker snapshot writes route through Rig and removals stage', async () => {
  const { bridge, face, opLog } = makeGovernedMount();
  await bridge.write('old.txt', 'old');
  const before = await snapshotBridge(bridge);
  const after = {
    dirs: ['new'],
    files: [{ path: 'new/value.bin', data: new Uint8Array([3, 1, 4]) }],
  };
  const synced = await syncWorkerSnapshot({ before, after, face, fsBridge: bridge });
  eq(synced.errors.length, 0, 'no sync errors');
  eq(synced.staged.length, 1, 'one staged removal');
  eq(synced.staged[0].command, 'fs.remove', 'removal command staged');
  eq([...(await bridge.read('new/value.bin')).data].join(','), '3,1,4', 'write persisted');
  assert((await bridge.readText('old.txt')).ok, 'staged removal did not delete');
  const log = await opLog.read();
  assert(log.some((entry) => entry.command === 'fs.write' && entry.status === 'ok'), 'write logged');
  assert(log.some((entry) => entry.command === 'fs.remove' && entry.status === 'staged'), 'removal logged');
  eq(face.pendingProposals().length, 1, 'proposal visible to operator');
});

await test('Worker snapshot cannot persist outside the active grant', async () => {
  const { bridge, face } = makeGovernedMount({ prefixes: ['allowed'] });
  const before = await snapshotBridge(bridge);
  const after = { dirs: [], files: [{ path: 'denied.txt', data: new Uint8Array([1]) }] };
  const synced = await syncWorkerSnapshot({ before, after, face, fsBridge: bridge });
  eq(synced.errors.length, 1, 'one grant error');
  eq(synced.errors[0].result.code, 'EGRANT', 'typed grant denial');
  eq((await bridge.read('denied.txt')).code, 'ENOENT', 'denied write absent');
});

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`K0-K2/worker-runtime conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`K0-K2/worker-runtime conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.message}`);
  process.exit(1);
}
