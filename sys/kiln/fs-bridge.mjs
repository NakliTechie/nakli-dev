// fs-bridge — mount a SCOPED slice of naklios.fs for the Kiln kernel (K1).
//
// The kernel sees one subtree (the mount prefix) and nothing above it. This is
// the JS side of the bridge: it wraps a Rig fileops rooted at the mount, so
// every path the kernel supplies passes the same pathguard ingress used
// everywhere else — `..`, absolute escapes, encoded traversal, backslash, and
// symlink-out all fail closed, and a path above the mount is unreachable by
// construction. "One door, and it checks coats" (handoff K1).
//
// It adds one thing fileops does not: a read cap, so a large file is refused
// rather than loaded whole into the Worker heap (handoff: "large files stream;
// never load a tree into the Worker heap"). Binary-safe both directions.
//
// The Emscripten-FS mount into Pyodide, and "escapes rejected from INSIDE
// Python", are the browser layer — see test/kiln-fs-bridge-harness.html.

import { createFileops } from '../rig/fileops/index.mjs';

const DEFAULT_READ_CAP = 8 << 20; // 8 MiB

/**
 * @param {object} opts
 * @param {object} opts.backend            storage backend (MemoryBackend in tests)
 * @param {string} [opts.mount='']         mount prefix; the kernel is confined to it
 * @param {number} [opts.readCapBytes]     refuse reads larger than this
 */
export function createFsBridge({ backend, mount = '', readCapBytes = DEFAULT_READ_CAP }) {
  if (!backend) throw new Error('createFsBridge requires a backend');
  const fs = createFileops({ backend, root: mount });

  async function capGuard(path) {
    const st = await fs.stat(path);
    if (!st.ok) return st; // ENOENT/EINVAL_PATH pass straight through
    if (st.stat.type === 'file' && st.stat.size > readCapBytes) {
      return { ok: false, code: 'E2BIG', message: `file exceeds read cap: ${st.stat.size} > ${readCapBytes} bytes`, path };
    }
    return null;
  }

  return {
    // Bytes by default (binary-safe); text with { encoding }.
    async read(path, opts = {}) {
      const over = await capGuard(path);
      if (over) return over;
      return fs.read(path, opts);
    },
    readText(path) { return this.read(path, { encoding: 'utf-8' }); },
    write(path, data) { return fs.write(path, data, { createParents: true }); },
    list(path, opts) { return fs.list(path, opts); },
    stat(path) { return fs.stat(path); },
    mkdir(path, opts) { return fs.mkdir(path, opts); },
    remove(path, opts) { return fs.remove(path, opts); },
    glob(pattern, opts) { return fs.glob(pattern, opts); },
    grep(pattern, opts) { return fs.grep(pattern, opts); },
    mount,
    readCapBytes,
    _fs: fs, // for the K2 rig-module wiring
  };
}
