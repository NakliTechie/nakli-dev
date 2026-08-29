// sys/kiln/main-thread-runtime.mjs
//
// A no-SharedArrayBuffer Python runtime for EMBEDDED (non-isolated) contexts —
// e.g. a Kiln app running as an iframe inside NakliOS, where the host is not
// cross-origin-isolated and the worker Kiln (worker-runtime.mjs) can't get
// SharedArrayBuffer.
//
// Design: run Pyodide on the MAIN THREAD (loadPyodide needs no SAB there), and
// instead of a live synchronous fs-bridge (which is what forces SAB), snapshot
// the Rig workspace into Pyodide's in-memory FS before each run and sync any
// new/changed files back after. `python file.py`, imports across workspace
// files, and file writes all work — without cross-origin isolation.
//
// Trade-offs vs the worker Kiln: execution blocks the UI thread (fine for the
// short scripts an agent runs; no interrupt), and each run re-snapshots the tree.
// When SharedArrayBuffer IS available (Forge/Anvil as a top-level isolated tab),
// prefer the worker Kiln instead — it's non-blocking and interruptible.
//
// It implements the minimal contract the Rig shell calls (shell.mjs `python`):
//   exec(cellId, code) -> { status:'ok'|'error'|'unavailable', stdout, stderr, message? }

import { PYODIDE_VERSION, PYODIDE_INDEX_URL, sanitizeTraceback } from './pyodide-runtime.mjs';

async function defaultLoadPyodide() {
  const mod = await import(PYODIDE_INDEX_URL + 'pyodide.mjs');
  return mod.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
}

// Paths the python MEMFS snapshot must not touch, in EITHER direction.
//  - __pycache__/.pyc: Pyodide-generated, never belong in the workspace.
//  - .git/: the git repo is the SHELL's domain (git runs over the workspace
//    fileops, not MEMFS). Its index + objects are BINARY; this snapshot reads and
//    writes every file as UTF-8, so round-tripping .git/ through MEMFS corrupts the
//    index (observed: `.git/index` truncated to 0 bytes after a python run, breaking
//    the shell's `git add`/`commit`). Excluding it in both directions keeps a
//    python run from ever mutating the repo the shell manages.
const SKIP_BACK = /(^|\/)(__pycache__|\.git)(\/|$)|\.pyc$/;

export function createMainThreadKiln({ fs, mount = 'work', loadPyodide = defaultLoadPyodide } = {}) {
  if (!fs) throw new Error('createMainThreadKiln requires a Rig fileops instance (fs)');
  const root = '/' + String(mount).replace(/^\/+|\/+$/g, '');
  let py = null;
  let loading = null;

  async function ensure() {
    if (py) return py;
    if (!loading) {
      loading = (async () => {
        const p = await loadPyodide();
        try { p.FS.mkdirTree(root); } catch (_) {}
        py = p;
        return p;
      })();
    }
    return loading;
  }

  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '' : p.slice(0, i); };
  function mkdirp(rel) { if (!rel) return; try { py.FS.mkdirTree(root + '/' + rel); } catch (_) {} }

  // Copy every workspace file into MEMFS; remember contents to detect changes.
  async function syncIn() {
    const seen = new Map();
    const res = await fs.list('', { recursive: true });
    if (!res || !res.ok) return seen;
    for (const e of res.entries) {
      if (e.type !== 'file') continue;
      if (SKIP_BACK.test(e.path)) continue; // never pull .git/ or caches into MEMFS
      const rd = await fs.read(e.path, { encoding: 'utf-8' });
      if (!rd || !rd.ok) continue;
      const d = dirOf(e.path); if (d) mkdirp(d);
      try { py.FS.writeFile(root + '/' + e.path, rd.data); seen.set(e.path, rd.data); } catch (_) {}
    }
    return seen;
  }

  // Walk MEMFS; write new/changed files back to the workspace (skipping caches).
  async function syncOut(seen) {
    const out = [];
    (function walk(dir) {
      let ents; try { ents = py.FS.readdir(dir); } catch (_) { return; }
      for (const name of ents) {
        if (name === '.' || name === '..') continue;
        const full = dir + '/' + name;
        let st; try { st = py.FS.stat(full); } catch (_) { continue; }
        if (py.FS.isDir(st.mode)) walk(full);
        else out.push(full);
      }
    })(root);
    for (const full of out) {
      const rel = full.slice(root.length + 1);
      if (SKIP_BACK.test(rel)) continue;
      let data; try { data = py.FS.readFile(full, { encoding: 'utf8' }); } catch (_) { continue; }
      if (seen.get(rel) === data) continue; // unchanged since snapshot
      await fs.write(rel, data);
    }
  }

  return {
    status: () => (py ? 'ready' : 'idle'),
    downloadSize: () => PYODIDE_VERSION && (12 * 1024 * 1024),
    async exec(cellId, code) {
      let p;
      try { p = await ensure(); }
      catch (e) { return { status: 'unavailable', message: 'Pyodide failed to load: ' + (e && e.message ? e.message : e) }; }

      let out = '', err = '';
      try { p.setStdout({ batched: (s) => { out += s; } }); } catch (_) {}
      try { p.setStderr({ batched: (s) => { err += s; } }); } catch (_) {}

      let seen = new Map();
      try {
        seen = await syncIn();
        // Run from the workspace dir and make its modules importable.
        p.runPython(`import os, sys\nos.chdir(${JSON.stringify(root)})\nif ${JSON.stringify(root)} not in sys.path: sys.path.insert(0, ${JSON.stringify(root)})`);
        await p.runPythonAsync(code);
        await syncOut(seen);
        return { status: 'ok', stdout: out, stderr: err };
      } catch (e) {
        try { await syncOut(seen); } catch (_) {}
        const msg = sanitizeTraceback(String(e && e.message ? e.message : e));
        return { status: 'error', stdout: out, stderr: err + (err && !err.endsWith('\n') ? '\n' : '') + msg };
      } finally {
        try { p.setStdout(); } catch (_) {}
        try { p.setStderr(); } catch (_) {}
      }
    },
  };
}
