// Conformance: sys/kiln/main-thread-runtime.mjs
// Verifies the no-SAB main-thread Python runtime's workspace<->MEMFS sync and the
// shell `exec` contract, using a fake Pyodide (injected loader). No real Pyodide.

import { createMainThreadKiln } from '../main-thread-runtime.mjs';
import { createFileops } from '../../rig/fileops/index.mjs';
import { MemoryBackend } from '../../rig/fileops/memory-backend.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// ── A minimal fake Pyodide: a flat in-memory FS + hookable runPythonAsync ──
function makeFakePyodide() {
  const files = new Map();   // abs path -> string content
  const dirs = new Set(['/']);
  let stdout = null, stderr = null;
  const addDirs = (p) => { const parts = p.split('/').filter(Boolean); let cur = ''; for (const s of parts) { cur += '/' + s; dirs.add(cur); } };
  const FS = {
    mkdirTree(p) { addDirs(p); },
    writeFile(p, d) { const dd = p.slice(0, p.lastIndexOf('/')); if (dd) addDirs(dd); files.set(p, String(d)); },
    readFile(p) { if (!files.has(p)) throw new Error('ENOENT: ' + p); return files.get(p); },
    readdir(dir) {
      const prefix = dir === '/' ? '/' : dir + '/';
      const names = new Set();
      for (const p of [...files.keys(), ...dirs]) {
        if (p === dir || !p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split('/')[0];
        if (name) names.add(name);
      }
      return ['.', '..', ...names];
    },
    stat(p) { const isDir = dirs.has(p) && !files.has(p); return { mode: isDir ? 0o040000 : 0o0100000 }; },
    isDir(mode) { return (mode & 0o170000) === 0o040000; },
  };
  const py = {
    FS,
    setStdout(o) { stdout = o && o.batched; },
    setStderr(o) { stderr = o && o.batched; },
    runPython() { /* os.chdir / sys.path — no-op in the fake */ },
    async runPythonAsync(code) { if (py._onRun) await py._onRun({ FS, out: (s) => stdout && stdout(s), err: (s) => stderr && stderr(s), code }); },
    _files: files, _onRun: null,
  };
  return py;
}

async function run() {
  // ── 1. syncIn: workspace files land in MEMFS under the mount root ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    await fs.write('a.py', 'print("hi")\n');
    await fs.write('pkg/b.py', 'VALUE = 42\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    let sawFiles = null;
    fake._onRun = ({ FS }) => { sawFiles = { a: FS.readFile('/work/a.py'), b: FS.readFile('/work/pkg/b.py') }; };
    const r = await kiln.exec('shell', 'noop');
    ok('exec returns ok', r.status === 'ok');
    ok('syncIn copied a.py into MEMFS', sawFiles && sawFiles.a === 'print("hi")\n');
    ok('syncIn copied nested pkg/b.py into MEMFS', sawFiles && sawFiles.b === 'VALUE = 42\n');
  }

  // ── 2. stdout is captured and returned ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ out }) => { out('hello\n'); out('world\n'); };
    const r = await kiln.exec('shell', 'print("hello"); print("world")');
    ok('stdout captured', r.stdout === 'hello\nworld\n');
    ok('no stderr on success', r.stderr === '');
  }

  // ── 3. syncOut: a NEW file Python writes is synced back to the workspace ──
  {
    const backend = new MemoryBackend();
    const fs = createFileops({ backend });
    await fs.write('seed.txt', 'seed\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ FS }) => { FS.writeFile('/work/out.txt', 'generated\n'); };
    await kiln.exec('shell', 'open("out.txt","w").write("generated")');
    const rd = await fs.read('out.txt', { encoding: 'utf-8' });
    ok('new file synced back to workspace', rd.ok && rd.data === 'generated\n');
  }

  // ── 4. syncOut skips __pycache__ / .pyc ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ FS }) => { FS.writeFile('/work/__pycache__/m.pyc', 'bytecode'); FS.writeFile('/work/keep.py', 'x=1\n'); };
    await kiln.exec('shell', 'import m');
    const cache = await fs.read('__pycache__/m.pyc', { encoding: 'utf-8' });
    const keep = await fs.read('keep.py', { encoding: 'utf-8' });
    ok('__pycache__/.pyc not synced back', !cache.ok);
    ok('normal file still synced back', keep.ok && keep.data === 'x=1\n');
  }

  // ── 5. a Python error → status:error, with the message in stderr ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = () => { throw new Error('NameError: name \'x\' is not defined'); };
    const r = await kiln.exec('shell', 'print(x)');
    ok('error → status error', r.status === 'error');
    ok('error message in stderr', /NameError/.test(r.stderr));
  }

  // ── 6. loader failure → status:unavailable (graceful) ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const kiln = createMainThreadKiln({ fs, loadPyodide: async () => { throw new Error('no network'); } });
    const r = await kiln.exec('shell', 'print(1)');
    ok('loader failure → unavailable', r.status === 'unavailable');
    ok('unavailable carries a message', /no network/.test(r.message || ''));
  }

  console.log(`sys/kiln/main-thread-runtime conformance: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

run();
