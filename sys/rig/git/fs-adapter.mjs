// fs-adapter — presents a Node-fs-shaped `{ promises }` surface over a Rig
// fileops instance, so vendored isomorphic-git runs over naklios.fs unchanged.
// This is the C2 "adapter only, never fork isomorphic-git" boundary.
//
// Two translations matter:
//   1. isomorphic-git expects the Node contract: methods THROW errors carrying
//      a `.code` ('ENOENT', 'ENOTDIR', …). Rig fileops returns typed
//      { ok:false, code } results. The adapter converts result → coded throw.
//   2. stat/lstat must return STABLE `ino`/`dev` — synthesised from a path hash.
//      If ino changed between calls, git would see phantom modifications.

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0) || 1; // never 0
}

function nodeErr(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// mode bits git cares about: regular file, directory, symlink. The object store
// has no executable bit; 0o100644 is correct for all tracked blobs here.
function modeFor(type) {
  return type === 'dir' ? 0o40000 : type === 'symlink' ? 0o120000 : 0o100644;
}

function makeStat(path, st) {
  const type = st.type;
  const sec = Math.floor((st.mtimeMs || 0) / 1000);
  return {
    type,
    mode: modeFor(type),
    size: st.size || 0,
    ino: fnv(path),
    uid: 1,
    gid: 1,
    dev: 1, // one synthetic device for the whole mount — stable
    mtimeMs: st.mtimeMs || 0,
    ctimeMs: st.mtimeMs || 0,
    mtimeSeconds: sec,
    ctimeSeconds: sec,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

/**
 * @param {object} fs  a createFileops(...) instance
 * @returns an object with a `.promises` namespace consumable by isomorphic-git.
 */
export function makeFsAdapter(fs) {
  const promises = {
    async readFile(path, opts) {
      const encoding = typeof opts === 'string' ? opts : (opts && opts.encoding);
      const norm = encoding === 'utf8' ? 'utf-8' : encoding;
      const res = await fs.read(path, norm ? { encoding: norm } : {});
      if (!res.ok) throw nodeErr(res.code, res.message);
      return res.data;
    },

    async writeFile(path, data, _opts) {
      // isomorphic-git mkdirs first, but createParents keeps the Folder backend
      // safe if a parent is missing; the object store ignores dirs anyway.
      const res = await fs.write(path, data, { createParents: true });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async unlink(path) {
      const res = await fs.remove(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async readdir(path) {
      const res = await fs.list(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
      return res.entries.map((e) => e.name);
    },

    async mkdir(path, opts) {
      const res = await fs.mkdir(path, { createParents: !!(opts && opts.recursive) });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async rmdir(path) {
      const res = await fs.remove(path, { recursive: false });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async stat(path) {
      const res = await fs.stat(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
      return makeStat(path, res.stat);
    },

    // The backends do not represent symlinks (a repo containing one fails loudly
    // at symlink() below), so lstat === stat here.
    async lstat(path) {
      return promises.stat(path);
    },

    // Fail loudly — never a silent no-op (RIG §5).
    async symlink(_target, _path) {
      throw nodeErr('ENOSYS', 'symlinks are not supported on this storage backend');
    },
    async readlink(path) {
      throw nodeErr('EINVAL', `not a symlink: ${path}`);
    },

    // The object store has no file modes; accept and ignore so isomorphic-git's
    // optional chmod path does not error.
    async chmod(_path, _mode) {},
  };

  return { promises };
}
