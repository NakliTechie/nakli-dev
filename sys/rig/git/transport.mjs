// transport — the C2 Transport seam and its permanent FakeTransport.
//
// All remote I/O (clone/fetch/push/listServerRefs) goes through ONE Transport
// interface. FakeTransport (a bare repo living in the store) is the permanent
// test seam; the Bridge project supplies the real HTTP transports later, and
// every Bridge checkpoint re-runs C2's checkpoint unchanged.
//
// A Transport implements:
//   clone({ git, base, fs, dir, ref })            → { ok, oid, branch }
//   fetch({ git, base, fs, dir, ref })            → { ok, oid }
//   push({ git, base, fs, dir, ref, remoteRef })  → { ok, oid }
//   listServerRefs({ ... })                       → { ok, refs }
// where `base` carries the isomorphic-git fs adapter and `fs` is the raw
// fileops (needed to move the object database).

// gitdir mount path for a worktree dir (dir '/' → '.git').
function gitdirOf(dir) {
  return (String(dir || '/').replace(/\/+$/, '') + '/.git').replace(/^\/+/, '') || '.git';
}

// Copy every file under srcRoot in srcFs to dstRoot in dstFs (overwriting).
// Git objects are content-addressed, so overwriting is always safe.
async function copyTree(srcFs, srcRoot, dstFs, dstRoot) {
  const g = await srcFs.glob('**', { cwd: srcRoot });
  if (!g.ok) return 0;
  let n = 0;
  for (const p of g.matches) {
    const rel = srcRoot ? p.slice(srcRoot.length + 1) : p;
    const r = await srcFs.read(p);
    if (!r.ok) continue;
    const w = await dstFs.write((dstRoot ? dstRoot + '/' : '') + rel, r.data, { createParents: true });
    if (w.ok) n++;
  }
  return n;
}

async function readLooseRefs(fs, gitdir) {
  const refs = {};
  const g = await fs.glob('**', { cwd: gitdir + '/refs/heads' });
  if (g.ok) {
    for (const p of g.matches) {
      const name = p.slice((gitdir + '/refs/heads/').length);
      const r = await fs.read(p, { encoding: 'utf-8' });
      if (r.ok) refs[name] = r.data.trim();
    }
  }
  return refs;
}

/**
 * FakeTransport — serves a source repo held in `sourceFs` at worktree
 * `sourceDir` (its gitdir is the bare object database for transfer purposes).
 */
export class FakeTransport {
  constructor({ sourceFs, sourceDir = '/' }) {
    if (!sourceFs) throw new Error('FakeTransport requires a sourceFs');
    this.sourceFs = sourceFs;
    this.sourceGitdir = gitdirOf(sourceDir);
  }

  async listServerRefs() {
    return { ok: true, refs: await readLooseRefs(this.sourceFs, this.sourceGitdir) };
  }

  // Copy the source object database + refs into a fresh target repo, then
  // materialise the worktree from HEAD.
  async clone({ git, base, fs, dir = '/' }) {
    const dstGitdir = gitdirOf(dir);
    await copyTree(this.sourceFs, this.sourceGitdir, fs, dstGitdir);
    let branch = null;
    try { branch = await git.currentBranch({ ...base, fullname: false }); } catch (_) {}
    // force: the copied .git/index references the source worktree, so a plain
    // checkout would think the (empty) target worktree is already populated and
    // skip writing files. A fresh clone always materialises the full tree.
    if (branch) await git.checkout({ ...base, ref: branch, force: true });
    const oid = await git.resolveRef({ ...base, ref: 'HEAD' });
    return { ok: true, oid, branch };
  }

  // Bring the source object database + refs into an existing target repo,
  // without touching the worktree.
  async fetch({ fs, dir = '/' }) {
    const dstGitdir = gitdirOf(dir);
    await copyTree(this.sourceFs, this.sourceGitdir + '/objects', fs, dstGitdir + '/objects');
    const refs = await readLooseRefs(this.sourceFs, this.sourceGitdir);
    for (const [name, oid] of Object.entries(refs)) {
      await fs.write(`${dstGitdir}/refs/remotes/origin/${name}`, oid + '\n', { createParents: true });
    }
    return { ok: true, refs };
  }

  // Send the target's objects + one branch ref up to the source.
  async push({ git, base, fs, dir = '/', ref, remoteRef }) {
    if (!ref) return { ok: false, code: 'EINVAL', message: 'push requires a ref' };
    const dstGitdir = gitdirOf(dir);
    await copyTree(fs, dstGitdir + '/objects', this.sourceFs, this.sourceGitdir + '/objects');
    const oid = await git.resolveRef({ ...base, ref });
    const name = (remoteRef || ref).replace(/^refs\/heads\//, '');
    await this.sourceFs.write(`${this.sourceGitdir}/refs/heads/${name}`, oid + '\n', { createParents: true });
    return { ok: true, oid, ref: name };
  }
}

// Adapt a naklios.net.fetch-style function into isomorphic-git's `http` plugin.
// isomorphic-git streams the request body (async iterable of Uint8Array) — the
// web client buffers it anyway, so we collect it and hand net.fetch one body; the
// response comes back as a single-chunk iterable. `netFetch` MUST be the sovereign
// egress relay (never a raw fetch — github/gitlab won't CORS a browser directly).
export function naklHttp(netFetch) {
  if (typeof netFetch !== 'function') throw new Error('naklHttp requires a net.fetch function');
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      let bodyBytes = null;
      if (body) {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        let len = 0; for (const c of chunks) len += c.length;
        bodyBytes = new Uint8Array(len); let off = 0;
        for (const c of chunks) { bodyBytes.set(c, off); off += c.length; }
      }
      const res = await netFetch({ url, method, headers, body: bodyBytes });
      return {
        url, method,
        statusCode: res.status,
        statusMessage: res.statusText || '',
        headers: res.headers || {},
        body: [res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body || 0)],
      };
    },
  };
}

// The real remote transport: git clone/fetch/push over HTTP via isomorphic-git,
// with ALL network I/O going through the injected `http` (→ the sovereign egress).
// `onAuth` supplies credentials (a PAT) for private repos; omit for public reads.
export class HttpTransport {
  constructor({ http, onAuth = undefined, corsProxy = undefined } = {}) {
    if (!http) throw new Error('HttpTransport requires an http plugin (see naklHttp)');
    this.http = http; this.onAuth = onAuth; this.corsProxy = corsProxy;
  }
  _net() { return { http: this.http, onAuth: this.onAuth, corsProxy: this.corsProxy }; }

  async clone({ git, base, url, ref, singleBranch = false, depth }) {
    if (!url) return { ok: false, code: 'EINVAL', message: 'clone requires a url' };
    await git.clone({ ...base, ...this._net(), url, ref, singleBranch, depth });
    const oid = await git.resolveRef({ ...base, ref: 'HEAD' });
    let branch = null; try { branch = await git.currentBranch({ ...base, fullname: false }); } catch (_) {}
    return { ok: true, oid, branch };
  }
  async fetch({ git, base, url, ref }) {
    if (!url) return { ok: false, code: 'EINVAL', message: 'fetch requires a url' };
    const r = await git.fetch({ ...base, ...this._net(), url, ref, singleBranch: !!ref });
    return { ok: true, oid: r && r.fetchHead, ref: r && r.fetchHeadDescription };
  }
  async push({ git, base, url, ref, remoteRef, force = false }) {
    if (!url) return { ok: false, code: 'EINVAL', message: 'push requires a url' };
    if (!ref) return { ok: false, code: 'EINVAL', message: 'push requires a ref' };
    const r = await git.push({ ...base, ...this._net(), url, ref, remoteRef, force });
    return { ok: !r?.error, ...r };
  }
  async listServerRefs({ git, url }) {
    if (!url) return { ok: false, code: 'EINVAL', message: 'listServerRefs requires a url' };
    const refs = await git.listServerRefs({ ...this._net(), url });
    return { ok: true, refs };
  }
}
