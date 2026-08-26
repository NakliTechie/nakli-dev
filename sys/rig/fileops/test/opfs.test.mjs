// Conformance: sys/rig/fileops/opfs.mjs
// OPFS uses the same FileSystemDirectoryHandle API as FSA, so we mock a root
// handle (navigator.storage.getDirectory) and verify createOpfsBackend navigates
// to a per-workspace subdir, round-trips through the resulting FsaBackend, keeps
// separate namespaces isolated, and that deleteOpfsDir removes a subtree.

import { createOpfsBackend, deleteOpfsDir, opfsAvailable } from '../opfs.mjs';
import { createFileops } from '../index.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('FAIL:', n); } };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

// ── in-memory mock of the FileSystemDirectoryHandle API (same surface as FSA) ──
class MockFile {
  constructor() { this.kind = 'file'; this.bytes = new Uint8Array(); this.lastModified = 1; }
  async getFile() { const b = this.bytes; return { size: b.length, lastModified: this.lastModified, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }; }
  async createWritable() { const self = this; return { async write(d) { self.bytes = d instanceof Uint8Array ? d.slice() : new Uint8Array(d); }, async close() {} }; }
}
class MockDir {
  constructor() { this.kind = 'directory'; this.children = new Map(); }
  async getDirectoryHandle(name, { create } = {}) {
    let h = this.children.get(name);
    if (!h) { if (!create) throw new DOMException('NotFound', 'NotFoundError'); h = new MockDir(); this.children.set(name, h); }
    return h;
  }
  async getFileHandle(name, { create } = {}) {
    let h = this.children.get(name);
    if (!h) { if (!create) throw new DOMException('NotFound', 'NotFoundError'); h = new MockFile(); this.children.set(name, h); }
    return h;
  }
  async removeEntry(name) { this.children.delete(name); }
  async *entries() { for (const [k, v] of this.children) yield [k, v]; }
}

const setNavigator = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });

async function run() {
  const root = new MockDir();
  setNavigator({ storage: { getDirectory: async () => root } });

  ok('opfsAvailable true when getDirectory present', opfsAvailable() === true);

  // 1. round-trip through a per-workspace subdir
  {
    const be = await createOpfsBackend({ path: 'anvil/ws/p1' });
    const fs = createFileops({ backend: be });
    await fs.write('src/main.py', 'print(1)\n');
    const rd = await fs.read('src/main.py', { encoding: 'utf-8' });
    ok('write/read round-trips through OPFS backend', rd.ok && rd.data === 'print(1)\n');
  }

  // 2. same subdir persists across a second createOpfsBackend (survives "reload")
  {
    const be2 = await createOpfsBackend({ path: 'anvil/ws/p1' });
    const data = dec(await be2.readBinary('src/main.py'));
    ok('a fresh backend over the same path sees the earlier file', data === 'print(1)\n');
  }

  // 3. a different project namespace is isolated
  {
    const be = await createOpfsBackend({ path: 'anvil/ws/p2' });
    ok('other project namespace does not see p1 files', (await be.exists('src/main.py')) === false);
  }

  // 4. deleteOpfsDir removes a workspace subtree
  {
    await deleteOpfsDir({ path: 'anvil/ws/p1' });
    const be = await createOpfsBackend({ path: 'anvil/ws/p1' });
    ok('deleted workspace is empty afterward', (await be.exists('src/main.py')) === false);
  }

  // 5. unavailable OPFS → opfsAvailable false + createOpfsBackend throws
  {
    setNavigator({});
    ok('opfsAvailable false without navigator.storage', opfsAvailable() === false);
    let threw = false;
    try { await createOpfsBackend({ path: 'x' }); } catch { threw = true; }
    ok('createOpfsBackend throws when OPFS unavailable', threw);
  }

  console.log(`sys/rig/fileops/opfs conformance: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

run();
