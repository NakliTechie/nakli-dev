// C2 conformance suite (Layer 1: fs adapter + local git ops).
//
//   node sys/rig/git/test/conformance.test.mjs
//
// Covers RIG §5 checkpoint parts 2 and 3 (known edit → content hash matches;
// statusMatrix correct on a fixture), plus branch/checkout/log, the operator↔
// agent commit-identity split, and diff. Runs vendored isomorphic-git over Rig
// fileops (MemoryBackend). Transport/clone (parts 1 & 4) are Layer 2.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../git-core.mjs';

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

function newRepo() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  return { fs, git };
}
const OP = { name: 'Op Erator', email: 'op@example.com' };
const commitOp = (git, message) => git.commit({ message, actor: 'operator', identity: OP, timestamp: 0, timezoneOffset: 0 });

// ── part 2: known edit → content hash matches ────────────────────────────
await test('init → write → add → commit; HEAD resolves; blob hash is the known git hash', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('a.txt', 'hello\n');
  await git.add({ filepath: 'a.txt' });
  const c = await commitOp(git, 'first');
  assert(c.ok, 'commit ok');
  const head = await git.resolveRef({ ref: 'HEAD' });
  eq(head.oid, c.oid, 'HEAD resolves to the commit');
  // `printf 'hello\n' | git hash-object --stdin` == ce013625030ba8dba906f756967f9e9ca394464a
  const blob = await git._git.readBlob({ ...git._base, oid: c.oid, filepath: 'a.txt' });
  eq(blob.oid, 'ce013625030ba8dba906f756967f9e9ca394464a', 'blob hashes to the canonical git object id');
});

await test('tree hash is deterministic for identical content across repos', async () => {
  const build = async () => {
    const { fs, git } = newRepo();
    await git.init({ defaultBranch: 'main' });
    await fs.write('dir/a.txt', 'alpha\n');
    await fs.write('dir/b.txt', 'beta\n');
    await git.add({ filepath: 'dir/a.txt' });
    await git.add({ filepath: 'dir/b.txt' });
    await commitOp(git, 'seed');
    return (await git.treeOid({ ref: 'HEAD' })).oid;
  };
  const t1 = await build();
  const t2 = await build();
  eq(t1, t2, 'identical content ⇒ identical tree hash');
});

// ── part 3: statusMatrix correct on a fixture ────────────────────────────
await test('statusMatrix reflects committed / modified-unstaged / untracked', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('tracked.txt', 'v1\n');
  await git.add({ filepath: 'tracked.txt' });
  await commitOp(git, 'add tracked');
  await fs.write('tracked.txt', 'v2\n');        // modified in workdir, not staged
  await fs.write('untracked.txt', 'new\n');     // never added
  const { matrix } = await git.statusMatrix();
  const row = (p) => matrix.find((r) => r[0] === p);
  eq(JSON.stringify(row('tracked.txt')), JSON.stringify(['tracked.txt', 1, 2, 1]), 'tracked = modified-unstaged');
  eq(JSON.stringify(row('untracked.txt')), JSON.stringify(['untracked.txt', 0, 2, 0]), 'untracked');
});

// ── branch / checkout / log ──────────────────────────────────────────────
await test('branch, checkout, and log across branches', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('base.txt', 'base\n');
  await git.add({ filepath: 'base.txt' });
  await commitOp(git, 'base');
  await git.branch({ ref: 'feature' });
  await git.checkout({ ref: 'feature' });
  await fs.write('feat.txt', 'feat\n');
  await git.add({ filepath: 'feat.txt' });
  await commitOp(git, 'feature work');
  const branches = (await git.listBranches()).branches;
  assert(branches.includes('main') && branches.includes('feature'), `branches: ${branches}`);
  eq((await git.log()).commits.length, 2, 'feature has 2 commits');
  await git.checkout({ ref: 'main' });
  eq((await git.log()).commits.length, 1, 'main still has 1 commit');
  eq((await fs.stat('feat.txt')).code, 'ENOENT', 'feat.txt absent on main after checkout');
});

// ── commit identity split (RIG §5) ───────────────────────────────────────
await test('agent commits are forced to agent@rig.local with a session trailer', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('x.txt', 'x\n');
  await git.add({ filepath: 'x.txt' });
  // Pass an operator identity too — it must be ignored for an agent commit.
  const c = await git.commit({ message: 'agent change', actor: 'agent', identity: OP, session: { id: 'sess-1' }, timestamp: 0 });
  assert(c.ok, 'agent commit ok');
  const { commit } = await git.readCommit({ oid: c.oid });
  eq(commit.author.email, 'agent@rig.local', 'agent author email');
  eq(commit.author.name, 'Rig agent', 'agent author name (never the operator)');
  assert(/Rig-Session: sess-1/.test(commit.message), `session trailer present: ${JSON.stringify(commit.message)}`);
});

await test('operator commit without an identity is refused', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('y.txt', 'y\n');
  await git.add({ filepath: 'y.txt' });
  const c = await git.commit({ message: 'no id', actor: 'operator', timestamp: 0 });
  eq(c.ok, false, 'refused'); eq(c.code, 'ENOIDENT', 'ENOIDENT');
});

// ── diff (working tree and between refs) ─────────────────────────────────
await test('diff reports working-tree changes', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('a.txt', 'one\n');
  await git.add({ filepath: 'a.txt' });
  await commitOp(git, 'c1');
  await fs.write('a.txt', 'one changed\n'); // modified in workdir
  await fs.write('b.txt', 'brand new\n');   // added in workdir
  const { changes } = await git.diff();
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  eq(byPath['a.txt'], 'modified', 'a.txt modified');
  eq(byPath['b.txt'], 'added', 'b.txt added');
});

await test('diff between two refs', async () => {
  const { fs, git } = newRepo();
  await git.init({ defaultBranch: 'main' });
  await fs.write('a.txt', 'a\n');
  await git.add({ filepath: 'a.txt' });
  const c1 = await commitOp(git, 'c1');
  await fs.write('b.txt', 'b\n');
  await git.add({ filepath: 'b.txt' });
  const c2 = await commitOp(git, 'c2');
  const { changes } = await git.diff({ refA: c1.oid, refB: c2.oid });
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  eq(byPath['b.txt'], 'added', 'b.txt added between c1 and c2');
  assert(!('a.txt' in byPath), 'a.txt unchanged between c1 and c2');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C2 (Layer 1) conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C2 (Layer 1) conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
