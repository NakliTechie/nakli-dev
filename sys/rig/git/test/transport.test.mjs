// C2 conformance suite (Layer 2: Transport seam + FakeTransport).
//
//   node sys/rig/git/test/transport.test.mjs
//
// Covers RIG §5 checkpoint parts 1 and 4: clone a pinned repo@SHA → head
// matches; ref set survives a round-trip; and a pushed branch reappears on the
// server with its objects transferred. FakeTransport is an object-copy between
// two fileops-backed repos — the permanent test seam.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../git-core.mjs';
import { FakeTransport, naklHttp, HttpTransport } from '../transport.mjs';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message + (e.stack ? '\n    ' + e.stack.split('\n')[1] : '') }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const OP = { name: 'Op', email: 'op@x' };
const commitOp = (g, m) => g.commit({ message: m, actor: 'operator', identity: OP, timestamp: 0, timezoneOffset: 0 });

// A source repo: main @ c1 (a.txt), plus a `feature` branch at the same commit.
async function makeSource() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  await git.init({ defaultBranch: 'main' });
  await fs.write('a.txt', 'hello\n');
  await git.add({ filepath: 'a.txt' });
  await commitOp(git, 'first');
  await git.branch({ ref: 'feature' });
  const head = (await git.resolveRef({ ref: 'HEAD' })).oid;
  return { fs, git, head, transport: new FakeTransport({ sourceFs: fs, sourceDir: '/' }) };
}
const freshTarget = (transport) => {
  const fs = createFileops({ backend: new MemoryBackend() });
  return { fs, git: createGitCore({ fs, dir: '/', transport }) };
};

// ── part 1: clone pinned repo@SHA → head matches ─────────────────────────
await test('clone: target HEAD matches the source pinned SHA and worktree materialises', async () => {
  const src = await makeSource();
  const t = freshTarget(src.transport);
  const res = await t.git.clone({});
  assert(res.ok, 'clone ok');
  eq(res.oid, src.head, 'clone reports the source SHA');
  eq((await t.git.resolveRef({ ref: 'HEAD' })).oid, src.head, 'target HEAD === source SHA');
  eq((await t.fs.read('a.txt', { encoding: 'utf-8' })).data, 'hello\n', 'worktree materialised from HEAD');
});

// ── part 4: ref set survives round-trip ──────────────────────────────────
await test('clone: the full ref set survives', async () => {
  const src = await makeSource();
  const t = freshTarget(src.transport);
  await t.git.clone({});
  const branches = (await t.git.listBranches()).branches.slice().sort();
  eq(JSON.stringify(branches), JSON.stringify(['feature', 'main']), 'both refs present after clone');
});

await test('push: a new branch and its objects round-trip back to the server', async () => {
  const src = await makeSource();
  const t = freshTarget(src.transport);
  await t.git.clone({});
  await t.git.branch({ ref: 'topic', checkout: true });
  await t.fs.write('t.txt', 'topic\n');
  await t.git.add({ filepath: 't.txt' });
  const tc = await commitOp(t.git, 'topic work');
  assert(tc.ok, 'target commit ok');
  const p = await t.git.push({ ref: 'topic' });
  assert(p.ok, `push ok (${p.code || ''})`);
  // The server advertises the pushed ref…
  const server = await src.transport.listServerRefs();
  assert('topic' in server.refs, `server has topic (${JSON.stringify(Object.keys(server.refs))})`);
  eq(server.refs.topic, tc.oid, 'server topic oid === pushed commit');
  // …and holds its objects (the source can resolve and read the commit).
  eq((await src.git.resolveRef({ ref: 'topic' })).oid, tc.oid, 'source resolves topic to the pushed oid');
  const rc = await src.git.readCommit({ oid: tc.oid });
  assert(/topic work/.test(rc.commit.message), 'source holds the pushed commit object');
});

// ── HttpTransport adapter (naklHttp): the net.fetch ↔ isomorphic-git glue ──
await test('naklHttp collects a streamed request body into one net.fetch call', async () => {
  let seen = null;
  const http = naklHttp(async (req) => { seen = req; return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: new Uint8Array([1, 2, 3]) }; });
  async function* body() { yield new Uint8Array([9, 9]); yield new Uint8Array([8]); }
  const res = await http.request({ url: 'https://h/x', method: 'POST', headers: { Authorization: 'Basic z' }, body: body() });
  assert(seen && seen.body && seen.body.length === 3, 'streamed chunks concatenated to net.fetch body');
  eq(seen.headers.Authorization, 'Basic z', 'Authorization forwarded verbatim');
  eq(res.statusCode, 200, 'statusCode mapped from status');
  const out = []; for (const c of res.body) out.push(...c);
  eq(out.join(''), '123', 'response body wrapped as a single-chunk iterable');
});
await test('naklHttp handles a null body (GET) and requires a fetch fn', async () => {
  let seen = null;
  const http = naklHttp(async (req) => { seen = req; return { status: 200, headers: {}, body: new Uint8Array(0) }; });
  await http.request({ url: 'https://h/x', method: 'GET', headers: {} });
  eq(seen.body, null, 'no body → net.fetch body is null');
  let threw = false; try { naklHttp(null); } catch (_) { threw = true; }
  assert(threw, 'naklHttp(non-function) is refused');
});
await test('HttpTransport requires an http plugin; push/clone validate inputs', async () => {
  let threw = false; try { new HttpTransport({}); } catch (_) { threw = true; }
  assert(threw, 'HttpTransport without http is refused');
  const tp = new HttpTransport({ http: naklHttp(async () => ({ status: 200, headers: {}, body: new Uint8Array(0) })) });
  eq((await tp.clone({ git: {}, base: {} })).code, 'EINVAL', 'clone without url → EINVAL');
  eq((await tp.push({ git: {}, base: {}, url: 'https://h/r' })).code, 'EINVAL', 'push without ref → EINVAL');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C2 (Layer 2 / Transport) conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C2 (Layer 2 / Transport) conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
