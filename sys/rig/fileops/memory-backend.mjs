// MemoryBackend — an in-memory implementation of the Rig fileops storage
// primitive, used as the headless test seam (the C2 FakeTransport pattern
// applied to storage). It mirrors the live `BACKENDS.crate` object-store
// semantics from naklios/index.html: directories are implicit (derived from
// key prefixes), writes are byte arrays, list is recursive.
//
// This is a test double, NOT a shipped parallel filesystem. Production wires
// createFileops({ backend: BACKENDS[bound] }) against the real Crate/Folder.
//
// Backend contract (safePath is a full store path string, no leading slash):
//   readBinary(safePath) -> Uint8Array          (only called on known files)
//   write(safePath, Uint8Array) -> void
//   delete(safePath) -> void                     (exact key)
//   exists(safePath) -> boolean
//   list(prefix) -> string[]                     (recursive descendants;
//                                                 explicit dirs suffixed '/')
//   stat(safePath) -> {type,size,mtimeMs,target?} | null
//   mkdir(safePath) -> void                      (explicit empty-dir marker)

export class MemoryBackend {
  constructor() {
    this.files = new Map();     // safePath -> { bytes, mtimeMs }
    this.dirs = new Set();      // explicit directory markers
    this.symlinks = new Map();  // safePath -> { target, mtimeMs }
  }

  _now() { return Date.now(); }

  async readBinary(safePath) {
    const entry = this.files.get(safePath);
    if (!entry) throw new Error(`no such file: ${safePath}`);
    return entry.bytes.slice(); // defensive copy
  }

  async write(safePath, data) {
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    this.files.set(safePath, { bytes, mtimeMs: this._now() });
  }

  async delete(safePath) {
    this.files.delete(safePath);
    this.dirs.delete(safePath);
    this.symlinks.delete(safePath);
  }

  async exists(safePath) {
    return this.files.has(safePath) || this.dirs.has(safePath)
      || this.symlinks.has(safePath) || this._isImplicitDir(safePath);
  }

  async mkdir(safePath) {
    this.dirs.add(safePath);
  }

  // Test helper — no live equivalent; models a symlink for escape testing.
  symlink(safePath, target) {
    this.symlinks.set(safePath, { target, mtimeMs: this._now() });
  }

  _isImplicitDir(safePath) {
    if (safePath === '') return true;
    const p = safePath + '/';
    for (const k of this.files.keys()) if (k.startsWith(p)) return true;
    for (const k of this.symlinks.keys()) if (k.startsWith(p)) return true;
    for (const k of this.dirs) if (k.startsWith(p)) return true;
    return false;
  }

  async stat(safePath) {
    const f = this.files.get(safePath);
    if (f) return { type: 'file', size: f.bytes.length, mtimeMs: f.mtimeMs };
    const s = this.symlinks.get(safePath);
    if (s) return { type: 'symlink', size: 0, mtimeMs: s.mtimeMs, target: s.target };
    if (this.dirs.has(safePath) || this._isImplicitDir(safePath)) {
      return { type: 'dir', size: 0, mtimeMs: 0 };
    }
    return null;
  }

  async list(prefix) {
    const under = (key) => prefix === '' ? true : (key === prefix || key.startsWith(prefix + '/'));
    const out = new Set();
    for (const k of this.files.keys()) if (under(k) && k !== prefix) out.add(k);
    for (const k of this.symlinks.keys()) if (under(k) && k !== prefix) out.add(k);
    for (const d of this.dirs) if (under(d) && d !== prefix) out.add(d + '/');
    return [...out].sort();
  }
}
