// fileops — Rig's C0 filesystem surface.
//
// Composes the injected storage backend (live BACKENDS[bound] in the browser,
// MemoryBackend in tests) into the 11-op API the handoff specifies:
//
//   read(path,{encoding})  write(path,data,{createParents})  list(path,{recursive})
//   stat(path)   mkdir(path,{createParents})   remove(path,{recursive})
//   move(from,to)   copy(from,to)   patch(path,unifiedDiff)
//   glob(pattern,{cwd})   grep(pattern,{cwd,glob,maxResults})
//
// Contract:
//   - Every external path passes normalizeMountPath (the one ingress). ".."
//     escapes, absolute escapes, encoded traversal, symlink-out all fail closed.
//   - read returns a Uint8Array by default; text only with {encoding}.
//   - Expected conditions return typed { ok:false, code, message } — no throws.
//   - patch is atomic (no write on a failed hunk) and returns an exact `revert`.

import { normalizeMountPath, joinRoot } from './pathguard.mjs';
import { applyPatch, reversePatch } from './patch.mjs';

const enc = new TextEncoder();

function err(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // '**/' also matches zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/**
 * @param {object}  opts
 * @param {object}  opts.backend        storage primitive (see MemoryBackend)
 * @param {string}  [opts.root='']      mount root; all paths resolve within it
 * @param {number}  [opts.symlinkDepth] max symlink hops before ELOOP
 * @param {number}  [opts.grepCap]      default grep maxResults
 */
export function createFileops({ backend, root = '', symlinkDepth = 8, grepCap = 1000 }) {
  if (!backend) throw new Error('createFileops requires a backend');
  const rootPrefix = String(root || '').replace(/\/+$/, '');

  const toMountRel = (safe) => {
    if (!rootPrefix) return safe;
    if (safe === rootPrefix) return '';
    return safe.startsWith(rootPrefix + '/') ? safe.slice(rootPrefix.length + 1) : safe;
  };

  // Validate + fully resolve symlinks, re-checking mount containment on every
  // hop. Returns { ok, path (mount-relative), safe (backend safePath) }.
  async function resolveMount(mountRel, depthLeft) {
    const v = normalizeMountPath(mountRel);
    if (!v.ok) return v;
    const acc = [];
    for (let i = 0; i < v.segments.length; i++) {
      acc.push(v.segments[i]);
      const safe = joinRoot(rootPrefix, acc.join('/'));
      const st = await backend.stat(safe);
      if (st && st.type === 'symlink') {
        if (depthLeft <= 0) {
          return err('ELOOP', 'too many symlink levels', { input: mountRel });
        }
        const parent = acc.slice(0, -1).join('/');
        const combined = (parent ? parent + '/' : '') + st.target;
        const rest = v.segments.slice(i + 1).join('/');
        const next = combined + (rest ? '/' + rest : '');
        // normalizeMountPath inside the recursion rejects a target that climbs
        // above the mount root — this is the symlink-escape gate.
        const r = await resolveMount(next, depthLeft - 1);
        if (!r.ok && r.code === 'EINVAL_PATH') {
          return err('EINVAL_PATH', 'symlink escapes mount root', { input: mountRel });
        }
        return r;
      }
    }
    const path = acc.join('/');
    return { ok: true, path, safe: joinRoot(rootPrefix, path) };
  }

  const resolve = (p) => resolveMount(p, symlinkDepth);

  async function ensureParents(mountPath) {
    const parts = mountPath.split('/');
    for (let k = 1; k < parts.length; k++) {
      const anc = joinRoot(rootPrefix, parts.slice(0, k).join('/'));
      const st = await backend.stat(anc);
      if (!st && backend.mkdir) await backend.mkdir(anc);
    }
  }

  async function read(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such file: ${r.path}`, { path: r.path });
    if (st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    const bytes = await backend.readBinary(r.safe);
    if (opts.encoding) {
      return { ok: true, data: new TextDecoder(opts.encoding).decode(bytes) };
    }
    return { ok: true, data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
  }

  async function write(path, data, opts = {}) {
    const bytes = toBytes(data);
    if (bytes === null) return err('EINVAL', 'data must be a string, Uint8Array, or ArrayBuffer');
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (st && st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    if (opts.createParents) await ensureParents(r.path);
    await backend.write(r.safe, bytes);
    return { ok: true, path: r.path };
  }

  async function stat(path) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such path: ${r.path}`, { path: r.path });
    const out = { type: st.type, size: st.size ?? 0, mtimeMs: st.mtimeMs ?? 0 };
    if (st.target !== undefined) out.target = st.target;
    return { ok: true, stat: out };
  }

  async function mkdir(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (st) {
      if (st.type === 'dir') return { ok: true, path: r.path };
      return err('EEXIST', `already exists: ${r.path}`, { path: r.path });
    }
    if (opts.createParents) await ensureParents(r.path);
    if (backend.mkdir) await backend.mkdir(r.safe);
    return { ok: true, path: r.path };
  }

  async function list(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such directory: ${r.path}`, { path: r.path });
    if (st.type !== 'dir') return err('ENOTDIR', `not a directory: ${r.path}`, { path: r.path });
    const raw = await backend.list(r.safe);
    const basePrefix = r.safe === '' ? '' : r.safe + '/';
    const childMap = new Map(); // relBase -> type
    for (const full0 of raw) {
      const isDirMarker = full0.endsWith('/');
      const full = isDirMarker ? full0.slice(0, -1) : full0;
      if (full === r.safe) continue;
      if (basePrefix && !full.startsWith(basePrefix)) continue;
      const relBase = basePrefix ? full.slice(basePrefix.length) : full;
      if (relBase === '') continue;
      const segs = relBase.split('/');
      if (opts.recursive) {
        childMap.set(relBase, isDirMarker ? 'dir' : 'file');
        for (let k = 1; k < segs.length; k++) childMap.set(segs.slice(0, k).join('/'), 'dir');
      } else {
        const child = segs[0];
        const type = segs.length > 1 ? 'dir' : (isDirMarker ? 'dir' : 'file');
        if (!childMap.has(child) || type === 'dir') childMap.set(child, type);
      }
    }
    const entries = [...childMap.keys()].sort().map((rel) => ({
      path: r.path ? r.path + '/' + rel : rel,
      name: rel.split('/').pop(),
      type: childMap.get(rel),
    }));
    return { ok: true, entries };
  }

  async function remove(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such path: ${r.path}`, { path: r.path });
    if (st.type === 'dir') {
      const raw = await backend.list(r.safe);
      const descendants = raw.map((p) => (p.endsWith('/') ? p.slice(0, -1) : p))
        .filter((p) => p !== r.safe && p.startsWith(r.safe + '/'));
      if (descendants.length > 0 && !opts.recursive) {
        return err('ENOTEMPTY', `directory not empty: ${r.path}`, { path: r.path });
      }
      for (const d of raw) await backend.delete(d.endsWith('/') ? d.slice(0, -1) : d);
      await backend.delete(r.safe);
      return { ok: true, path: r.path };
    }
    await backend.delete(r.safe);
    return { ok: true, path: r.path };
  }

  async function copy(from, to) {
    const fr = await resolve(from);
    if (!fr.ok) return fr;
    const tr = await resolve(to);
    if (!tr.ok) return tr;
    const fst = await backend.stat(fr.safe);
    if (!fst) return err('ENOENT', `no such path: ${fr.path}`, { path: fr.path });
    const tst = await backend.stat(tr.safe);
    if (tst) return err('EEXIST', `destination exists: ${tr.path}`, { path: tr.path });
    if (fst.type === 'dir') {
      const raw = await backend.list(fr.safe);
      const fromPrefix = fr.safe === '' ? '' : fr.safe + '/';
      if (backend.mkdir) await backend.mkdir(tr.safe);
      for (const full0 of raw) {
        if (full0.endsWith('/')) continue;
        const rel = fromPrefix ? full0.slice(fromPrefix.length) : full0;
        const bytes = await backend.readBinary(full0);
        await backend.write(joinRoot(tr.safe, rel), bytes);
      }
      return { ok: true, from: fr.path, to: tr.path };
    }
    const bytes = await backend.readBinary(fr.safe);
    await backend.write(tr.safe, bytes);
    return { ok: true, from: fr.path, to: tr.path };
  }

  async function move(from, to) {
    const c = await copy(from, to);
    if (!c.ok) return c;
    const rm = await remove(from, { recursive: true });
    if (!rm.ok) return rm;
    return { ok: true, from: c.from, to: c.to };
  }

  async function patch(path, unifiedDiff) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such file: ${r.path}`, { path: r.path });
    if (st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    const bytes = await backend.readBinary(r.safe);
    const text = new TextDecoder('utf-8').decode(bytes);
    const applied = applyPatch(text, unifiedDiff);
    if (!applied.ok) return applied; // EPATCH names the hunk; nothing written (atomic)
    await backend.write(r.safe, enc.encode(applied.result));
    return { ok: true, path: r.path, revert: reversePatch(unifiedDiff) };
  }

  async function glob(pattern, opts = {}) {
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return cr;
    const raw = await backend.list(cr.safe);
    const basePrefix = cr.safe === '' ? '' : cr.safe + '/';
    const re = globToRegExp(pattern);
    const matches = [];
    for (const full0 of raw) {
      if (full0.endsWith('/')) continue;
      if (basePrefix && !full0.startsWith(basePrefix)) continue;
      const rel = basePrefix ? full0.slice(basePrefix.length) : full0;
      if (re.test(rel)) matches.push(cr.path ? cr.path + '/' + rel : rel);
    }
    matches.sort();
    return { ok: true, matches };
  }

  async function grep(pattern, opts = {}) {
    const max = opts.maxResults || grepCap;
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return cr;
    const globbed = await glob(opts.glob || '**', { cwd: opts.cwd || '' });
    if (!globbed.ok) return globbed;
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const matches = [];
    let truncated = false;
    outer: for (const p of globbed.matches) {
      const rd = await read(p, { encoding: 'utf-8' });
      if (!rd.ok) continue; // skip unreadable/binary lines silently
      const lines = rd.data.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (matches.length >= max) { truncated = true; break outer; }
          matches.push({ path: p, line: i + 1, text: lines[i] });
        }
      }
    }
    return { ok: true, matches, truncated };
  }

  return {
    read, write, list, stat, mkdir, remove, move, copy, patch, glob, grep,
    // exposed for the git adapter (C2) and grant layer (C4)
    _resolve: resolve,
    root: rootPrefix,
  };
}
