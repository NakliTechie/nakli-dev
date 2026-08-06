// git-core — Rig's C2 git surface over vendored isomorphic-git.
//
// isomorphic-git is used through the fs adapter only; it is never forked.
// In scope: init, add, remove, commit, log, status, statusMatrix, branch,
// checkout, listBranches, listRemotes, diff (working tree and between refs),
// resolveRef, readCommit. Out: merge, rebase, submodules, LFS.
//
// Commit identity (RIG §5): operator commits use the operator's Identity; agent
// commits are forced to agent@rig.local plus a session trailer, and can NEVER
// borrow the operator's identity. Push is a Transport concern (Layer 2), is
// operator-only, and is not exposed to the kernel.

import * as git from '../../../vendor/isomorphic-git/1.40.0/isomorphic-git.mjs';
import { makeFsAdapter } from './fs-adapter.mjs';

const AGENT_IDENTITY = { name: 'Rig agent', email: 'agent@rig.local' };

function appendSessionTrailer(message, session) {
  const id = session && session.id ? String(session.id) : 'unknown';
  const body = message.endsWith('\n') ? message : message + '\n';
  return `${body}\nRig-Session: ${id}\n`;
}

/**
 * @param {object} opts
 * @param {object} opts.fs         a createFileops(...) instance
 * @param {string} [opts.dir='/']  worktree root within the mount
 * @param {object} [opts.transport] a Transport (Layer 2) for clone/fetch/push
 */
export function createGitCore({ fs, dir = '/', transport = null }) {
  if (!fs) throw new Error('createGitCore requires a fileops instance (fs)');
  const igfs = makeFsAdapter(fs);
  const base = { fs: igfs, dir };

  async function init({ defaultBranch = 'main' } = {}) {
    await git.init({ ...base, defaultBranch });
    return { ok: true };
  }

  async function add({ filepath }) {
    await git.add({ ...base, filepath });
    return { ok: true };
  }

  async function remove({ filepath }) {
    await git.remove({ ...base, filepath });
    return { ok: true };
  }

  // actor: 'operator' (requires identity) | 'agent' (forced agent@rig.local).
  async function commit({ message, actor = 'operator', identity, session, timestamp, timezoneOffset = 0 } = {}) {
    if (!message || typeof message !== 'string') {
      return { ok: false, code: 'EINVAL', message: 'commit requires a message' };
    }
    let author;
    let msg = message;
    if (actor === 'agent') {
      author = { ...AGENT_IDENTITY }; // never the operator's identity
      msg = appendSessionTrailer(message, session);
    } else if (actor === 'operator') {
      if (!identity || !identity.name || !identity.email) {
        return { ok: false, code: 'ENOIDENT', message: 'operator commit requires an identity {name,email}' };
      }
      author = { name: identity.name, email: identity.email };
    } else {
      return { ok: false, code: 'EINVAL', message: `unknown commit actor: ${actor}` };
    }
    author.timestamp = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
    author.timezoneOffset = timezoneOffset;
    const oid = await git.commit({ ...base, message: msg, author, committer: author });
    return { ok: true, oid, actor };
  }

  async function log(opts = {}) {
    return { ok: true, commits: await git.log({ ...base, ...opts }) };
  }

  async function status({ filepath }) {
    return { ok: true, status: await git.status({ ...base, filepath }) };
  }

  async function statusMatrix(opts = {}) {
    return { ok: true, matrix: await git.statusMatrix({ ...base, ...opts }) };
  }

  async function branch({ ref, checkout = false }) {
    await git.branch({ ...base, ref, checkout });
    return { ok: true };
  }

  async function listBranches() {
    return { ok: true, branches: await git.listBranches({ ...base }) };
  }

  async function checkout({ ref, force = false }) {
    await git.checkout({ ...base, ref, force });
    return { ok: true };
  }

  async function listRemotes() {
    return { ok: true, remotes: await git.listRemotes({ ...base }) };
  }

  async function resolveRef({ ref }) {
    return { ok: true, oid: await git.resolveRef({ ...base, ref }) };
  }

  async function readCommit({ oid }) {
    // isomorphic-git returns { oid, commit, payload }; expose the inner commit
    // object (message, tree, parent, author, committer).
    const r = await git.readCommit({ ...base, oid });
    return { ok: true, oid: r.oid, commit: r.commit };
  }

  // The tree oid of a ref/commit — content-addressed and timestamp-independent,
  // which is why the checkpoint asserts the TREE hash, not the commit hash.
  async function treeOid({ ref = 'HEAD' } = {}) {
    const oid = await git.resolveRef({ ...base, ref });
    const { commit } = await git.readCommit({ ...base, oid });
    return { ok: true, oid: commit.tree };
  }

  // diff working tree (refB omitted) or between two refs.
  async function diff({ refA = 'HEAD', refB = null } = {}) {
    const trees = [git.TREE({ ref: refA }), refB ? git.TREE({ ref: refB }) : git.WORKDIR()];
    // walk prunes a subtree when map returns undefined, so directories must
    // return a truthy marker to keep descending; only blobs emit a change.
    const KEEP = { _dir: true };
    const changes = await git.walk({
      ...base,
      trees,
      map: async (filepath, entries) => {
        if (filepath === '.') return KEEP;
        // The gitdir lives inside the worktree when dir='/'; never diff it.
        if (filepath === '.git' || filepath.startsWith('.git/')) return undefined;
        const [a, b] = entries;
        const aType = a && (await a.type());
        const bType = b && (await b.type());
        if (aType === 'tree' || bType === 'tree') return KEEP; // descend into real dirs
        const aOid = a && (await a.oid());
        const bOid = b && (await b.oid());
        if (aOid === bOid) return undefined; // unchanged blob
        const state = aOid && bOid ? 'modified' : aOid ? 'deleted' : 'added';
        return { path: filepath, status: state };
      },
      reduce: async (parent, children) => {
        const flat = (children || []).flat().filter(Boolean);
        if (parent && parent.path) flat.push(parent);
        return flat;
      },
    });
    return { ok: true, changes: (changes || []).filter((c) => c && c.path) };
  }

  // ── Transport-backed (Layer 2): clone/fetch/push/listRemote ──────────────
  function requireTransport(op) {
    if (!transport) throw new Error(`git.${op} needs a Transport (none configured)`);
    return transport;
  }
  // Transports also receive the raw fileops (`fs`) and worktree `dir`: base.fs
  // is the isomorphic-git adapter, but a Transport needs glob/read/write to move
  // the object database.
  async function clone(opts = {}) { return requireTransport('clone').clone({ git, base, fs, dir, ...opts }); }
  async function fetch(opts = {}) { return requireTransport('fetch').fetch({ git, base, fs, dir, ...opts }); }
  async function push(opts = {}) { return requireTransport('push').push({ git, base, fs, dir, ...opts }); }
  async function listServerRefs(opts = {}) { return requireTransport('listServerRefs').listServerRefs({ git, base, fs, dir, ...opts }); }

  return {
    init, add, remove, commit, log, status, statusMatrix,
    branch, listBranches, checkout, listRemotes,
    resolveRef, readCommit, treeOid, diff,
    clone, fetch, push, listServerRefs,
    _git: git, _base: base,
  };
}
