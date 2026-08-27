// OverlayBackend — a copy-on-write worktree over any Rig storage backend. This
// is the isolation primitive behind parallel subagents (the "Polly" supervisor
// pattern): each subagent runs against its own overlay, so concurrent full-tool
// agents (including shell writes) can never corrupt each other or the real
// workspace. Reads fall through to the base; writes and deletes are captured in
// the overlay; nothing touches the base until an explicit commit.
//
// It implements the same 8-method backend contract as MemoryBackend (see
// memory-backend.mjs) so it drops in wherever createFileops({ backend }) is
// wired. safePath is a full store path string (no leading slash); directories
// are implicit (derived from key prefixes), same as the live object stores.
//
// Semantics:
//   read/exists/stat/list  → base view, with overlay writes shadowing and
//                            tombstones (deletes) hiding base entries.
//   write/mkdir            → overlay only; clears any tombstone for the path.
//   delete                 → overlay tombstone (exact key); base untouched.
//   changes()              → { written:[path…], deleted:[path…] } for merge/review.
//   commit(apply)          → replays writes+deletes onto the real store via a
//                            caller-supplied applier (so the app can capture
//                            pre-images / route through the audited agent face).
//
// A base directory that is emptied purely by overlay tombstones stops existing
// in the overlay view (matching object-store semantics), computed by a bounded
// descendant walk — the base is never mutated.

const MAX_DESCENDANT_SCAN = 5000; // safety cap on the base emptiness walk

export class OverlayBackend {
  constructor(base) {
    if (!base) throw new Error('OverlayBackend requires a base backend');
    this.base = base;
    this.writes = new Map();   // safePath -> { bytes, mtimeMs }
    this.tomb = new Set();     // deleted exact keys (files or explicit dirs)
    this.dirsAdded = new Set(); // explicit dir markers created in the overlay
  }

  _now() { return Date.now(); }

  async readBinary(safePath) {
    const w = this.writes.get(safePath);
    if (w) return w.bytes.slice();
    if (this.tomb.has(safePath)) throw new Error(`no such file: ${safePath}`);
    return this.base.readBinary(safePath);
  }

  async write(safePath, data) {
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    this.writes.set(safePath, { bytes, mtimeMs: this._now() });
    this.tomb.delete(safePath);
  }

  async delete(safePath) {
    this.writes.delete(safePath);
    this.dirsAdded.delete(safePath);
    this.tomb.add(safePath);
  }

  async mkdir(safePath) {
    this.dirsAdded.add(safePath);
    this.tomb.delete(safePath);
  }

  async exists(safePath) {
    return (await this.stat(safePath)) !== null;
  }

  async stat(safePath) {
    const w = this.writes.get(safePath);
    if (w) return { type: 'file', size: w.bytes.length, mtimeMs: w.mtimeMs };
    if (this.dirsAdded.has(safePath)) return { type: 'dir', size: 0, mtimeMs: 0 };
    if (this.tomb.has(safePath)) {
      // Exact key deleted; it may still be an implicit dir if live descendants remain.
      return (await this._isImplicitDir(safePath)) ? { type: 'dir', size: 0, mtimeMs: 0 } : null;
    }
    // Not touched in the overlay: consult the base, but resolve directoriness
    // from the merged live key-space (base dirs emptied by tombstones vanish).
    const b = await this.base.stat(safePath);
    if (b && (b.type === 'file' || b.type === 'symlink')) return b;
    if (await this._isImplicitDir(safePath)) return { type: 'dir', size: 0, mtimeMs: 0 };
    return null;
  }

  // Any LIVE descendant under safePath? Live = an overlay write/dir under it, or
  // a base descendant that is not tombstoned. Bounded so a huge tree can't hang.
  async _isImplicitDir(safePath) {
    if (safePath === '') return true; // the store root always exists
    const p = safePath + '/';
    for (const k of this.writes.keys()) if (k.startsWith(p)) return true;
    for (const k of this.dirsAdded) if (k === safePath || k.startsWith(p)) return true;
    // Walk the base subtree for a non-tombstoned descendant.
    let scanned = 0;
    const stack = [safePath];
    while (stack.length) {
      const dir = stack.pop();
      let kids;
      try { kids = await this.base.list(dir); } catch (_) { kids = []; }
      for (const kid of kids) {
        if (++scanned > MAX_DESCENDANT_SCAN) return true; // assume live (keeps dir visible)
        const isDir = kid.endsWith('/');
        const full = isDir ? kid.slice(0, -1) : kid;
        if (isDir) { stack.push(full); continue; }
        if (!this.tomb.has(full)) return true; // a surviving base file → dir is live
      }
    }
    return false;
  }

  // Immediate children of prefix, dirs suffixed '/', base+overlay merged with
  // tombstones applied and overlay writes shadowing base. Mirrors MemoryBackend.list.
  async list(prefix) {
    const base = prefix === '' ? '' : prefix + '/';
    const children = new Map(); // childName -> isDir

    // Base children first (tomb-filtered; emptied dirs dropped).
    let baseKids;
    try { baseKids = await this.base.list(prefix); } catch (_) { baseKids = []; }
    for (const kid of baseKids) {
      const isDir = kid.endsWith('/');
      const full = isDir ? kid.slice(0, -1) : kid;
      const rest = base ? full.slice(base.length) : full;
      if (rest === '' || rest.includes('/')) continue; // defensive: not an immediate child
      if (isDir) {
        if (await this._isImplicitDir(full)) children.set(rest, true);
      } else if (!this.tomb.has(full)) {
        if (!children.has(rest)) children.set(rest, false);
      }
    }

    // Overlay-added keys (writes + explicit dirs) contribute children too.
    const consider = (key, forceDir) => {
      if (prefix !== '' && !(key === prefix || key.startsWith(base))) return;
      if (key === prefix) return;
      const rest = base ? key.slice(base.length) : key;
      if (rest === '') return;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (forceDir) children.set(rest, true);
        else if (!children.has(rest)) children.set(rest, false);
      } else {
        children.set(rest.slice(0, slash), true); // deeper key ⇒ this level is a dir
      }
    };
    for (const k of this.writes.keys()) consider(k, false);
    for (const d of this.dirsAdded) consider(d, true);

    return [...children.entries()]
      .map(([name, isDir]) => base + name + (isDir ? '/' : ''))
      .sort();
  }

  // The changeset this overlay would apply to the base — for conflict detection,
  // review, and merge. Sorted for stable digests.
  changes() {
    return {
      written: [...this.writes.keys()].sort(),
      deleted: [...this.tomb].sort(),
    };
  }

  hasChanges() { return this.writes.size > 0 || this.tomb.size > 0; }

  // Replay this overlay onto the real store. `apply` is caller-supplied so the
  // app can capture pre-images and route writes through the audited agent face:
  //   apply.write(path, bytes) -> Promise   (bytes is a Uint8Array — pass through
  //                                          byte-exact; do NOT decode/re-encode)
  //   apply.remove(path)       -> Promise
  // Writes are applied before deletes, each in sorted order for determinism.
  // NOTE: explicit EMPTY directories (mkdir → dirsAdded) are not replayed — under
  // object-store implicit-dir semantics a dir exists only via its files, so an
  // empty dir has no durable representation to carry across. Files + deletes are.
  async commit(apply) {
    if (!apply || typeof apply.write !== 'function' || typeof apply.remove !== 'function') {
      throw new Error('commit(apply) needs { write, remove }');
    }
    const applied = { written: [], deleted: [] };
    for (const path of [...this.writes.keys()].sort()) {
      await apply.write(path, this.writes.get(path).bytes.slice());
      applied.written.push(path);
    }
    for (const path of [...this.tomb].sort()) {
      await apply.remove(path);
      applied.deleted.push(path);
    }
    return applied;
  }
}
