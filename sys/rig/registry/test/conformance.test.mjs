// C1 conformance suite — the gate artifact for the Rig command registry.
//
//   node sys/rig/registry/test/conformance.test.mjs
//
// The contract test is GENERATED FROM METADATA: it iterates every registered
// command, so a new command cannot exist without being covered (RIG §4). Plus:
// valid schema per command; discovery (search/describe/list) leaves the tree
// hash unchanged and never reaches a handler (side-effect-free); invokeCommand
// is the sole invoker and wires through to fileops.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
import { buildRigRegistry, KNOWN_SCOPES } from '../index.mjs';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h >>> 0;
}

// Seed a fileops with a small tree and build a registry over fs + git, so the
// generated-from-metadata contract covers fs.* and git.* alike.
async function seeded() {
  const fs = createFileops({ backend: new MemoryBackend() });
  await fs.write('src/a.js', 'const a = 1;\n// TODO tidy\n');
  await fs.write('src/b.txt', 'plain\n');
  await fs.write('readme.md', '# hi\n');
  const git = createGitCore({ fs, dir: '/' });
  return { fs, git, registry: buildRigRegistry({ fs, git }) };
}

// Hash of the whole tree — path + bytes, sorted. Discovery must not change it.
async function treeHash(fs) {
  const g = await fs.glob('**', { cwd: '' });
  const parts = [];
  for (const p of g.matches.sort()) {
    const r = await fs.read(p);
    parts.push(p + '\0' + Array.from(r.data).join(','));
  }
  return fnv(parts.join('\n'));
}

// ── generated-from-metadata contract ────────────────────────────────────
await test('every command carries a valid RIG §4 contract (generated from metadata)', async () => {
  const { registry } = await seeded();
  const seen = new Set();
  assert(registry.commands.length >= 11, `expected ≥11 commands, got ${registry.commands.length}`);
  for (const c of registry.commands) {
    assert(typeof c.name === 'string' && c.name.length > 0, 'name is a non-empty string');
    assert(!seen.has(c.name), `duplicate name ${c.name}`); seen.add(c.name);
    assert(typeof c.summary === 'string' && c.summary.length > 0, `${c.name}: summary`);
    assert(!c.summary.includes('\n'), `${c.name}: summary is one line`);
    assert(typeof c.description === 'string' && c.description.length > 0, `${c.name}: description`);
    assert(c.inputSchema && c.inputSchema.type === 'object', `${c.name}: inputSchema is an object schema`);
    assert(c.returnSchema && typeof c.returnSchema === 'object', `${c.name}: returnSchema`);
    eq(typeof c.destructive, 'boolean', `${c.name}: destructive flag`);
    assert(typeof c.scope === 'string' && KNOWN_SCOPES.has(c.scope), `${c.name}: known scope (got ${c.scope})`);
    assert(c.annotations && typeof c.annotations.readOnlyHint === 'boolean', `${c.name}: annotations.readOnlyHint`);
    eq(typeof c.run, 'function', `${c.name}: run handler`);
  }
});

await test('input schemas are internally consistent (required ⊆ properties)', async () => {
  const { registry } = await seeded();
  for (const c of registry.commands) {
    const props = Object.keys(c.inputSchema.properties || {});
    for (const req of c.inputSchema.required || []) {
      assert(props.includes(req), `${c.name}: required "${req}" not in properties`);
    }
    assert(c.inputSchema.additionalProperties === false, `${c.name}: additionalProperties:false`);
  }
});

await test('destructive/read-only annotations are coherent', async () => {
  const { registry } = await seeded();
  const byName = new Map(registry.commands.map((c) => [c.name, c]));
  assert(byName.get('fs.remove').destructive === true, 'fs.remove is destructive');
  assert(byName.get('fs.read').annotations.readOnlyHint === true, 'fs.read is read-only');
  assert(byName.get('fs.write').annotations.readOnlyHint === false, 'fs.write mutates');
  for (const c of registry.commands) {
    if (c.annotations.readOnlyHint === true) eq(c.destructive, false, `${c.name}: read-only ⇒ not destructive`);
  }
});

// ── discovery is side-effect-free ────────────────────────────────────────
await test('discovery (list/search/describe/toolSchemas) leaves the tree hash unchanged', async () => {
  const { fs, registry } = await seeded();
  const before = await treeHash(fs);
  registry.list();
  registry.searchCommands('');
  registry.searchCommands('read');
  registry.toolSchemas();
  for (const c of registry.commands) registry.describeCommand(c.name);
  const after = await treeHash(fs);
  eq(after, before, 'tree hash unchanged by discovery');
});

await test('projected metadata never exposes the run handler', async () => {
  const { registry } = await seeded();
  for (const m of registry.list()) {
    assert(!('run' in m), `${m.name}: list() must not expose run`);
  }
  const d = registry.describeCommand('fs.read');
  assert(d && !('run' in d), 'describeCommand must not expose run');
  const miss = registry.describeCommand('nope.nope');
  eq(miss, null, 'describeCommand(unknown) → null');
});

// ── invokeCommand: sole invoker, wired through, typed miss ───────────────
await test('invokeCommand wires through to fileops', async () => {
  const { registry } = await seeded();
  const w = await registry.invokeCommand('fs.write', { path: 'note.txt', data: 'hello' });
  assert(w.ok, 'write via registry ok');
  const r = await registry.invokeCommand('fs.read', { path: 'note.txt', encoding: 'utf-8' });
  assert(r.ok, 'read via registry ok'); eq(r.data, 'hello', 'round-trips through the registry');
});

await test('invokeCommand on an unknown command returns a typed miss with suggestions', async () => {
  const { registry } = await seeded();
  let threw = false, res;
  try { res = await registry.invokeCommand('fs.reed', { path: 'x' }); } catch (_) { threw = true; }
  assert(!threw, 'unknown command must not throw');
  eq(res.ok, false, 'unknown → ok:false');
  eq(res.code, 'ENOCMD', 'ENOCMD code');
  assert(Array.isArray(res.suggestions) && res.suggestions.includes('fs.read'), `suggests fs.read (got ${JSON.stringify(res.suggestions)})`);
});

await test('searchCommands matches by name/summary/description', async () => {
  const { registry } = await seeded();
  eq(registry.searchCommands('grep').some((m) => m.name === 'fs.grep'), true, 'finds fs.grep');
  eq(registry.searchCommands('unified diff').some((m) => m.name === 'fs.patch'), true, 'finds fs.patch by description');
  eq(registry.searchCommands('').length, registry.commands.length, 'empty query lists all');
});

await test('toolSchemas emits LLM-shaped metadata from the registry', async () => {
  const { registry } = await seeded();
  const schemas = registry.toolSchemas();
  eq(schemas.length, registry.commands.length, 'one schema per command');
  for (const s of schemas) {
    assert(s.name && s.description && s.inputSchema, `${s.name}: name/description/inputSchema`);
    assert(!('run' in s) && !('execute' in s), `${s.name}: no handler leaked`);
  }
});

// ── git.* registered on the same registry, driven end-to-end through it ──
await test('git.* commands register and a full flow drives through invokeCommand', async () => {
  const { registry } = await seeded();
  const names = new Set(registry.commands.map((c) => c.name));
  for (const n of ['git.init', 'git.add', 'git.commit', 'git.status', 'git.log',
    'git.diff', 'git.branch', 'git.checkout', 'git.resolveRef', 'git.statusMatrix']) {
    assert(names.has(n), `missing ${n}`);
  }
  // The whole flow — fs.* and git.* — goes through the one invokeCommand.
  assert((await registry.invokeCommand('git.init', { defaultBranch: 'main' })).ok, 'git.init');
  assert((await registry.invokeCommand('fs.write', { path: 'g.txt', data: 'hi\n' })).ok, 'fs.write');
  assert((await registry.invokeCommand('git.add', { filepath: 'g.txt' })).ok, 'git.add');
  const c = await registry.invokeCommand('git.commit', {
    message: 'via registry', actor: 'operator', identity: { name: 'O', email: 'o@x' }, timestamp: 0,
  });
  assert(c.ok && c.oid, 'git.commit via registry');
  const rr = await registry.invokeCommand('git.resolveRef', { ref: 'HEAD' });
  eq(rr.oid, c.oid, 'HEAD resolves to the commit, all through the registry');
});

await test('git.commit as agent through the registry cannot borrow the operator identity', async () => {
  const { registry } = await seeded();
  await registry.invokeCommand('git.init', { defaultBranch: 'main' });
  await registry.invokeCommand('fs.write', { path: 'x.txt', data: 'x\n' });
  await registry.invokeCommand('git.add', { filepath: 'x.txt' });
  const c = await registry.invokeCommand('git.commit', {
    message: 'agent', actor: 'agent', identity: { name: 'Op', email: 'op@x' }, session: { id: 's1' }, timestamp: 0,
  });
  assert(c.ok, 'agent commit ok');
  eq(c.actor, 'agent', 'recorded as agent');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C1 conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C1 conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
