// K1 conformance — the Kiln fs bridge (headless, over MemoryBackend).
//
//   node sys/kiln/test/fs-bridge.test.mjs
//
// Byte-identical round-trip both directions; every escape class rejected at the
// bridge; a path one level above the mount is unreachable; the read cap refuses
// an oversized file. "Escapes rejected from INSIDE Python" is the parked browser
// harness (test/kiln-fs-bridge-harness.html), not this file.

import { MemoryBackend } from '../../rig/fileops/index.mjs';
import { createFsBridge } from '../fs-bridge.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function fnv(bytes) { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }

await test('byte-identical round-trip both directions through the bridge', async () => {
  const bridge = createFsBridge({ backend: new MemoryBackend(), mount: 'app/data' });
  const buf = new Uint8Array(256); for (let i = 0; i < 256; i++) buf[i] = i;
  assert((await bridge.write('sub/blob.bin', buf)).ok, 'write');
  const r = await bridge.read('sub/blob.bin');
  assert(r.ok && r.data instanceof Uint8Array, 'binary read');
  eq(r.data.length, 256, 'length'); eq(fnv(r.data), fnv(buf), 'byte-hash equal');
  assert((await bridge.write('note.txt', 'नमस्ते\n')).ok, 'text write');
  eq((await bridge.readText('note.txt')).data, 'नमस्ते\n', 'text round-trip');
});

await test('every escape class is rejected at the bridge', async () => {
  const bridge = createFsBridge({ backend: new MemoryBackend(), mount: 'app/data' });
  const cases = [
    ['dotdot', '../secret'],
    ['nested dotdot', 'a/../../secret'],
    ['absolute escape', '/../secret'],
    ['encoded', '%2e%2e/secret'],
    ['backslash', '..\\secret'],
    ['non-string', 42],
  ];
  for (const [label, input] of cases) {
    let threw = false, res;
    try { res = await bridge.read(input); } catch (_) { threw = true; }
    assert(!threw, `${label}: must not throw`);
    eq(res.ok, false, `${label}: rejected`);
    eq(res.code, 'EINVAL_PATH', `${label}: EINVAL_PATH (got ${res.code})`);
  }
  // write is guarded too
  eq((await bridge.write('../evil', 'x')).code, 'EINVAL_PATH', 'write escape rejected');
});

await test('a symlink escaping the mount is rejected', async () => {
  const backend = new MemoryBackend();
  const bridge = createFsBridge({ backend, mount: 'app/data' });
  await bridge.write('real.txt', 'inside');
  backend.symlink('app/data/link-in', 'real.txt');
  eq((await bridge.readText('link-in')).data, 'inside', 'in-mount symlink resolves');
  backend.symlink('app/data/link-out', '../../etc/passwd');
  eq((await bridge.read('link-out')).code, 'EINVAL_PATH', 'out-of-mount symlink rejected');
});

await test('a path above the mount is unreachable', async () => {
  const backend = new MemoryBackend();
  // A sibling file OUTSIDE the mount, written directly to the backend.
  await backend.write('app/secret.txt', new TextEncoder().encode('top secret'));
  const bridge = createFsBridge({ backend, mount: 'app/data' });
  await bridge.write('own.txt', 'mine');
  // cannot climb out to reach it
  eq((await bridge.read('../secret.txt')).code, 'EINVAL_PATH', 'cannot read above the mount');
  // and it never appears in a listing of the mount
  const names = (await bridge.list('')).entries.map((e) => e.name);
  assert(!names.includes('secret.txt'), 'above-mount file not listed');
  assert(names.includes('own.txt'), 'own file listed');
});

await test('the read cap refuses an oversized file', async () => {
  const bridge = createFsBridge({ backend: new MemoryBackend(), mount: 'm', readCapBytes: 100 });
  await bridge.write('small.txt', 'x'.repeat(50));
  await bridge.write('big.txt', 'x'.repeat(500));
  assert((await bridge.read('small.txt')).ok, 'small file read ok');
  const big = await bridge.read('big.txt');
  eq(big.ok, false, 'big file refused'); eq(big.code, 'E2BIG', 'E2BIG');
});

const total = passed + failures.length;
if (failures.length === 0) { console.log(`K1/fs-bridge conformance: ${passed}/${total} passed`); process.exit(0); }
else { console.log(`K1/fs-bridge conformance: ${passed}/${total} passed, ${failures.length} FAILED`); for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`); process.exit(1); }
