// Kiln's dedicated Pyodide Worker.
//
// The main thread owns consent, storage, grants, and Rig. This Worker owns the
// Python heap. A SharedArrayBuffer carries interrupts into a busy Python call
// and lets synchronous generated `rig.*` functions wait for the main thread's
// governed registry result without exposing a second capability path.

import { createPyodideRuntime } from './pyodide-runtime.mjs';

let runtime = null;
let pyodide = null;
let mountPath = '/workspace';
let rigRpcBytes = 8 << 20;
let queue = Promise.resolve();

const textDecoder = new TextDecoder();

function reply(id, ok, value) {
  self.postMessage({ type: 'response', id, ok, value });
}

function ensureDirectory(path) {
  if (!path || path === '/') return;
  try { pyodide.FS.mkdirTree(path); } catch (_) {}
}

function clearDirectory(path) {
  for (const name of pyodide.FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = path.replace(/\/$/, '') + '/' + name;
    const st = pyodide.FS.lstat(child);
    if (pyodide.FS.isDir(st.mode)) {
      clearDirectory(child);
      pyodide.FS.rmdir(child);
    } else {
      pyodide.FS.unlink(child);
    }
  }
}

function loadSnapshot(snapshot) {
  pyodide.FS.chdir(mountPath);
  clearDirectory(mountPath);
  const dirs = [...(snapshot?.dirs || [])].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const path of dirs) ensureDirectory(mountPath + '/' + path);
  for (const file of snapshot?.files || []) {
    const full = mountPath + '/' + file.path;
    ensureDirectory(full.slice(0, full.lastIndexOf('/')));
    pyodide.FS.writeFile(full, file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data));
  }
}

function takeSnapshot() {
  const dirs = [];
  const files = [];
  const walk = (dir, rel) => {
    for (const name of pyodide.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = dir.replace(/\/$/, '') + '/' + name;
      const childRel = rel ? rel + '/' + name : name;
      const st = pyodide.FS.lstat(full);
      if (pyodide.FS.isDir(st.mode)) {
        dirs.push(childRel);
        walk(full, childRel);
      } else if (pyodide.FS.isFile(st.mode)) {
        files.push({ path: childRel, data: pyodide.FS.readFile(full, { encoding: 'binary' }) });
      }
    }
  };
  walk(mountPath, '');
  dirs.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files };
}

function callRig(name, argsJson) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const payloadBuffer = new SharedArrayBuffer(rigRpcBytes);
  const control = new Int32Array(controlBuffer);
  self.postMessage({ type: 'rig-call', name, argsJson, controlBuffer, payloadBuffer });
  const wait = Atomics.wait(control, 0, 0, 60000);
  if (wait === 'timed-out') throw new Error(`Rig call timed out: ${name}`);
  const length = Atomics.load(control, 1);
  const status = Atomics.load(control, 2);
  const payloadBytes = new Uint8Array(length);
  payloadBytes.set(new Uint8Array(payloadBuffer, 0, length));
  const payload = textDecoder.decode(payloadBytes);
  if (status !== 1) throw new Error(payload || `Rig call failed: ${name}`);
  return payload;
}

function installRigModule(source) {
  if (!source) return;
  pyodide.globals.set('_kiln_rig_call', callRig);
  pyodide.globals.set('_kiln_rig_source', source);
  pyodide.runPython(`
import sys as _kiln_sys
import types as _kiln_types
_kiln_rig_module = _kiln_types.ModuleType("rig")
_kiln_rig_module.__dict__["_rig_call"] = _kiln_rig_call
exec(_kiln_rig_source, _kiln_rig_module.__dict__)
_kiln_sys.modules["rig"] = _kiln_rig_module
`);
}

function installFilesystemGuard() {
  pyodide.globals.set('_kiln_mount_path', mountPath);
  pyodide.runPython(`
import os as _kiln_os
import sys as _kiln_sys

_KILN_ROOT = _kiln_os.path.realpath(_kiln_mount_path)
_KILN_READONLY_RUNTIME_ROOTS = ("/usr/", "/lib/")

def _kiln_resolve_path(value):
    if isinstance(value, int):
        return None
    try:
        path = _kiln_os.fspath(value)
    except TypeError:
        return None
    if isinstance(path, bytes):
        path = _kiln_os.fsdecode(path)
    if not _kiln_os.path.isabs(path):
        path = _kiln_os.path.join(_kiln_os.getcwd(), path)
    return _kiln_os.path.realpath(path)

def _kiln_inside(path):
    return path == _KILN_ROOT or path.startswith(_KILN_ROOT + _kiln_os.sep)

def _kiln_fs_audit(event, args):
    path_indexes = {
        "open": (0,), "os.chdir": (0,), "os.listdir": (0,), "os.scandir": (0,),
        "os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,), "os.chmod": (0,),
        "os.chown": (0,), "os.truncate": (0,), "os.utime": (0,),
        "os.rename": (0, 1), "os.link": (0, 1), "os.symlink": (0, 1),
    }.get(event)
    if not path_indexes:
        return
    for index in path_indexes:
        if index >= len(args):
            continue
        path = _kiln_resolve_path(args[index])
        if path is None or _kiln_inside(path):
            continue
        read_only_runtime = event == "open" and path.startswith(_KILN_READONLY_RUNTIME_ROOTS)
        if read_only_runtime:
            mode = args[1] if len(args) > 1 else "r"
            if not any(flag in str(mode) for flag in ("w", "a", "+", "x")):
                continue
        raise PermissionError(f"path outside Kiln mount: {args[index]}")

_kiln_sys.addaudithook(_kiln_fs_audit)
_kiln_os.chdir(_KILN_ROOT)
`);
}

async function initialize(message) {
  const { loadPyodide } = await import(message.indexURL + 'pyodide.mjs');
  const interruptBuffer = new Uint8Array(message.interruptBuffer);
  mountPath = message.mountPath || mountPath;
  rigRpcBytes = message.rigRpcBytes || rigRpcBytes;
  pyodide = await loadPyodide({ indexURL: message.indexURL });
  ensureDirectory(mountPath);
  pyodide.FS.mount(pyodide.FS.filesystems.MEMFS, {}, mountPath);
  runtime = createPyodideRuntime(pyodide, interruptBuffer);
  installRigModule(message.rigModuleSource);
  installFilesystemGuard();
  return { version: pyodide.version, mountPath };
}

async function handle(message) {
  try {
    if (message.op === 'init') {
      reply(message.id, true, await initialize(message));
      return;
    }
    if (!runtime) throw new Error('Kiln Worker is not initialized');
    if (message.op === 'runCode') {
      loadSnapshot(message.snapshot);
      const value = await runtime.runCode(message.code, message.options || {});
      const names = runtime.listNames();
      const namespace = {};
      for (const name of names) namespace[name] = runtime.inspect(name);
      value.namespace = namespace;
      value.snapshot = takeSnapshot();
      reply(message.id, true, value);
      return;
    }
    if (message.op === 'reset') {
      runtime.reset(message.options || {});
      if (!message.options?.keepMounts) clearDirectory(mountPath);
      reply(message.id, true, { ok: true });
      return;
    }
    if (message.op === 'close') {
      reply(message.id, true, { ok: true });
      self.close();
      return;
    }
    throw new Error(`Unknown Kiln Worker operation: ${message.op}`);
  } catch (error) {
    reply(message.id, false, {
      message: String(error?.message || error),
      stack: String(error?.stack || error),
    });
  }
}

self.addEventListener('message', (event) => {
  queue = queue.then(() => handle(event.data));
});
