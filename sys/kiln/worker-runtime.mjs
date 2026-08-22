// Main-thread proxy for Kiln's dedicated Pyodide Worker.
//
// Storage snapshots cross the Worker boundary at cell boundaries. Mutations
// flow back through the governed Rig face: writes invoke `fs.write`; removals
// become staged `fs.remove` proposals. The Worker never receives the backend,
// grant, registry, or operation log objects.

import { PYODIDE_INDEX_URL } from './pyodide-runtime.mjs';

const enc = new TextEncoder();

function bytesEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToBase64(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toRigJsonValue(value) {
  if (value instanceof Uint8Array) {
    return { __kiln_type: 'bytes', base64: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) return toRigJsonValue(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return toRigJsonValue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(toRigJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = toRigJsonValue(child);
    return out;
  }
  return value;
}

export function fromRigJsonValue(value) {
  if (value && typeof value === 'object' && value.__kiln_type === 'bytes') {
    return base64ToBytes(value.base64);
  }
  if (Array.isArray(value)) return value.map(fromRigJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = fromRigJsonValue(child);
    return out;
  }
  return value;
}

export async function snapshotBridge(fsBridge) {
  if (!fsBridge) return { dirs: [], files: [] };
  const listed = await fsBridge.list('', { recursive: true });
  if (!listed.ok && listed.code === 'ENOENT') return { dirs: [], files: [] };
  if (!listed.ok) throw new Error(listed.message || 'Could not list the Kiln mount');
  const dirs = listed.entries.filter((entry) => entry.type === 'dir').map((entry) => entry.path);
  const files = [];
  for (const entry of listed.entries.filter((candidate) => candidate.type === 'file')) {
    const read = await fsBridge.read(entry.path);
    if (!read.ok) throw new Error(read.message || `Could not read ${entry.path}`);
    files.push({ path: entry.path, data: read.data });
  }
  return { dirs, files };
}

function snapshotMaps(snapshot) {
  return {
    dirs: new Set(snapshot.dirs || []),
    files: new Map((snapshot.files || []).map((file) => [file.path, file.data])),
  };
}

export async function syncWorkerSnapshot({ before, after, face, fsBridge }) {
  const prior = snapshotMaps(before || { dirs: [], files: [] });
  const next = snapshotMaps(after || { dirs: [], files: [] });
  const result = { writes: [], directories: [], staged: [], errors: [] };
  const invoke = face
    ? (name, input) => face.invoke(name, input)
    : async (name, input) => {
        const op = name.slice(3);
        if (op === 'write') return fsBridge.write(input.path, input.data);
        if (op === 'mkdir') return fsBridge.mkdir(input.path, { createParents: input.createParents });
        if (op === 'remove') return fsBridge.remove(input.path, { recursive: input.recursive });
        return { ok: false, code: 'ENOCMD', message: `Unsupported filesystem sync command: ${name}` };
      };

  for (const path of [...next.dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    if (prior.dirs.has(path)) continue;
    const out = await invoke('fs.mkdir', { path, createParents: true });
    if (out.ok) result.directories.push(path);
    else if (out.staged) result.staged.push(out);
    else result.errors.push({ command: 'fs.mkdir', path, result: out });
  }
  for (const [path, data] of next.files) {
    if (prior.files.has(path) && bytesEqual(prior.files.get(path), data)) continue;
    const out = await invoke('fs.write', { path, data, createParents: true });
    if (out.ok) result.writes.push(path);
    else if (out.staged) result.staged.push(out);
    else result.errors.push({ command: 'fs.write', path, result: out });
  }
  const removedFiles = [...prior.files.keys()].filter((path) => !next.files.has(path));
  const removedDirs = [...prior.dirs].filter((path) => !next.dirs.has(path))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const path of [...removedFiles, ...removedDirs]) {
    const out = await invoke('fs.remove', { path, recursive: true });
    if (out.ok) continue;
    if (out.staged) result.staged.push(out);
    else if (out.code !== 'ENOENT') result.errors.push({ command: 'fs.remove', path, result: out });
  }
  return result;
}

/**
 * Create a runtime matching `createKernelCore`'s injected runtime contract.
 */
export async function createWorkerRuntime({
  face = null,
  fsBridge = null,
  rigModuleSource = '',
  indexURL = PYODIDE_INDEX_URL,
  mountPath = '/workspace',
  rigRpcBytes = 8 << 20,
  WorkerClass = globalThis.Worker,
} = {}) {
  if (typeof WorkerClass !== 'function') throw new Error('Kiln requires Worker support');
  if (typeof SharedArrayBuffer !== 'function') {
    throw new Error('Kiln requires cross-origin isolation for SharedArrayBuffer');
  }

  const workerModuleUrl = new URL('./worker.mjs', import.meta.url).href;
  const blobUrl = URL.createObjectURL(new Blob([
    `import ${JSON.stringify(workerModuleUrl)};`,
  ], { type: 'application/javascript' }));
  const worker = new WorkerClass(blobUrl, { type: 'module', name: 'naklios-kiln' });
  const interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
  const pending = new Map();
  let requestId = 0;
  let namespace = {};
  let closed = false;

  function settleAll(error) {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  }

  async function handleRigCall(message) {
    const control = new Int32Array(message.controlBuffer);
    const target = new Uint8Array(message.payloadBuffer);
    try {
      if (!face) throw new Error('Rig is unavailable in this Kiln session');
      const args = fromRigJsonValue(JSON.parse(message.argsJson));
      const result = await face.invoke(message.name, args);
      const payload = enc.encode(JSON.stringify(toRigJsonValue(result)));
      if (payload.length > target.length) throw new Error(`Rig result exceeds ${target.length} bytes`);
      target.set(payload);
      Atomics.store(control, 1, payload.length);
      Atomics.store(control, 2, 1);
    } catch (error) {
      const payload = enc.encode(String(error?.message || error)).subarray(0, target.length);
      target.set(payload);
      Atomics.store(control, 1, payload.length);
      Atomics.store(control, 2, -1);
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    }
  }

  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'rig-call') {
      void handleRigCall(message);
      return;
    }
    if (message.type !== 'response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.value?.message || 'Kiln Worker request failed'));
  });
  worker.addEventListener('error', (event) => {
    settleAll(new Error(event.message || 'Kiln Worker failed'));
  });

  function request(op, payload = {}) {
    if (closed) return Promise.reject(new Error('Kiln Worker is closed'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'request', id, op, ...payload });
    });
  }

  const ready = await request('init', {
    indexURL,
    interruptBuffer: interruptBuffer.buffer,
    mountPath,
    rigRpcBytes,
    rigModuleSource,
  });
  URL.revokeObjectURL(blobUrl);

  async function runCode(code, options = {}) {
    const before = await snapshotBridge(fsBridge);
    const value = await request('runCode', { code, options, snapshot: before });
    namespace = value.namespace || {};
    delete value.namespace;
    const after = value.snapshot || { dirs: [], files: [] };
    delete value.snapshot;
    value.fsSync = await syncWorkerSnapshot({ before, after, face, fsBridge });
    return value;
  }

  function interrupt() {
    interruptBuffer[0] = 2;
  }

  function reset(options = {}) {
    namespace = {};
    void request('reset', { options }).catch(() => {});
  }

  async function close() {
    if (closed) return;
    try { await request('close'); } finally {
      closed = true;
      worker.terminate();
      settleAll(new Error('Kiln Worker closed'));
    }
  }

  return {
    runCode,
    interrupt,
    reset,
    listNames: () => Object.keys(namespace),
    inspect: (name) => namespace[name] || null,
    close,
    workerInfo: ready,
  };
}
