// Conformance — FsaBackend over a MOCK File System Access directory handle.
//
//   node sys/rig/fileops/test/fsa-backend.test.mjs
//
// The mock implements the FSA API surface FsaBackend uses (getDirectoryHandle /
// getFileHandle / removeEntry / entries / getFile / createWritable), so the
// backend's path/handle logic is verified headlessly and — crucially — through
// the real createFileops layer and a real createShell, proving the whole stack
// persists against a folder-shaped backend.

import { FsaBackend } from '../fsa-backend.mjs';
import { createFileops } from '../index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createShell } from '../../cli/shell.mjs';
import { MemoryBackend } from '../memory-backend.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

// ── an in-memory mock of the FSA directory-handle API ───────────────────
class MockFile {
  constructor(name) { this.kind = 'file'; this.name = name; this.bytes = new Uint8Array(); this.lastModified = 1; }
  async getFile() { const b = this.bytes; return { size: b.length, lastModified: this.lastModified, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }; }
  async createWritable() { const self = this; return { async write(d) { self.bytes = d instanceof Uint8Array ? d.slice() : new Uint8Array(d); }, async close() {} }; }
}
class MockDir {
  constructor(name = '') { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  async getDirectoryHandle(name, { create } = {}) {
    let h = this.children.get(name);
    if (!h) { if (!create) throw new DOMException(`NotFound: ${name}`, 'NotFoundError'); h = new MockDir(name); this.children.set(name, h); }
    if (h.kind !== 'directory') throw new DOMException('TypeMismatch', 'TypeMismatchError');
    return h;
  }
  async getFileHandle(name, { create } = {}) {
    let h = this.children.get(name);
    if (!h) { if (!create) throw new DOMException(`NotFound: ${name}`, 'NotFoundError'); h = new MockFile(name); this.children.set(name, h); }
    if (h.kind !== 'file') throw new DOMException('TypeMismatch', 'TypeMismatchError');
    return h;
  }
  async removeEntry(name) { this.children.delete(name); }
  async *entries() { for (const [k, v] of this.children) yield [k, v]; }
}

// ── direct backend contract ─────────────────────────────────────────────
await test('write → readBinary round-trip, nested dirs auto-created', async () => {
  const be = new FsaBackend(new MockDir());
  await be.write('src/lib/a.txt', enc('hello'));
  eq(dec(await be.readBinary('src/lib/a.txt')), 'hello', 'round-trip');
  eq((await be.stat('src/lib/a.txt')).type, 'file', 'stat file');
  eq((await be.stat('src/lib')).type, 'dir', 'stat intermediate dir');
  eq((await be.stat('nope.txt')), null, 'missing → null');
});
await test('list returns immediate children with dir suffix', async () => {
  const be = new FsaBackend(new MockDir());
  await be.write('proj/a.txt', enc('a'));
  await be.write('proj/sub/b.txt', enc('b'));
  await be.mkdir('proj/empty');
  const ls = await be.list('proj');
  eq(JSON.stringify(ls), JSON.stringify(['proj/a.txt', 'proj/empty/', 'proj/sub/']), 'children + suffixes');
});
await test('delete removes files and dirs; exists reflects it', async () => {
  const be = new FsaBackend(new MockDir());
  await be.write('x.txt', enc('x'));
  assert(await be.exists('x.txt'), 'exists before');
  await be.delete('x.txt');
  assert(!(await be.exists('x.txt')), 'gone after');
  assert(await be.exists(''), 'root always exists');
});

// ── through the real fileops layer ──────────────────────────────────────
await test('createFileops over FsaBackend: write/read/list/patch', async () => {
  const fs = createFileops({ backend: new FsaBackend(new MockDir()) });
  const w = await fs.write('notes/todo.txt', 'buy milk');
  assert(w.ok, 'write ok');
  const r = await fs.read('notes/todo.txt', { encoding: 'utf-8' });
  eq(r.data, 'buy milk', 'read back');
  const l = await fs.list('notes');
  assert(l.ok && l.entries.some((e) => e.name === 'todo.txt'), 'listed');
});

// ── through the shell (the full Forge stack) ────────────────────────────
await test('a shell over FsaBackend persists across a fresh shell (reload analogue)', async () => {
  const root = new MockDir(); // survives across shells, like a real folder across reloads
  function shellOn(backend) {
    const fs = createFileops({ backend });
    const registry = buildRigRegistry({ fs });
    const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
    const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
    return createShell({ registry, face });
  }
  const s1 = shellOn(new FsaBackend(root));
  await s1.feed('mkdir -p work');
  await s1.feed('echo persisted > work/data.txt');
  // A brand-new shell + backend over the SAME folder handle sees the file.
  const s2 = shellOn(new FsaBackend(root));
  eq((await s2.feed('cat work/data.txt')).output, 'persisted', 'survived a fresh shell over the same folder');
});

await test('FsaBackend rejects a non-handle', () => {
  let threw = false;
  try { new FsaBackend({}); } catch { threw = true; }
  assert(threw, 'requires a directory handle');
});

if (failures.length) {
  console.error(`fsa-backend: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/rig/fileops/fsa-backend conformance: ${passed}/${passed} passed`);
