// C4b conformance suite — the gate artifact for the faux CLI (headless).
//
//   node sys/rig/cli/test/conformance.test.mjs
//
// RIG §7/§12: every command reachable from a typed line; argument coercion
// matches declared schemas; unknown yields suggestions; destructive cannot run
// without confirmation; scrollback serialise→restore is byte-identical (and
// token-redacted). The parser/repl are tested here directly; xterm is not.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { compile, tokenize, createRepl, createScrollback } from '../index.mjs';

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
const j = (x) => JSON.stringify(x);
const js = (o) => JSON.stringify(o, Object.keys(o).sort()); // order-independent

function setup() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const logFs = createFileops({ backend: new MemoryBackend() });
  const opLog = createOpLog({ fs: logFs, now: () => 1 });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  const face = createAgentFace({ registry, grant, opLog, actor: 'operator', caller: 'cli' });
  const repl = createRepl({ registry, face });
  return { fs, registry, face, repl };
}
const outText = (r) => r.output.join('\n');

// ── every command reachable from a typed line ────────────────────────────
await test('every registered command is reachable by its dotted name', async () => {
  const { registry } = setup();
  for (const c of registry.commands) {
    const compiled = compile(`/${c.name}`, registry);
    eq(compiled.kind, 'command', `${c.name}: reachable`);
    eq(compiled.name, c.name, `${c.name}: resolves to itself`);
  }
});

await test('aliases and namespace subcommands resolve', async () => {
  const { registry } = setup();
  eq(compile('/ls src', registry).name, 'fs.list', 'ls → fs.list');
  eq(compile('/cat a.txt', registry).name, 'fs.read', 'cat → fs.read');
  eq(compile('/git status a.js', registry).name, 'git.status', 'git status → git.status');
  eq(compile('/git diff', registry).name, 'git.diff', 'git diff → git.diff');
});

// ── argument coercion matches declared schemas ───────────────────────────
await test('argument coercion matches inputSchema types', async () => {
  const { registry } = setup();
  const ls = compile('/ls -R src', registry);
  eq(js(ls.input), js({ path: 'src', recursive: true }), 'ls -R src');
  eq(typeof ls.input.recursive, 'boolean', 'recursive is boolean');

  const rd = compile('/read a.txt --encoding utf-8', registry);
  eq(js(rd.input), js({ path: 'a.txt', encoding: 'utf-8' }), 'read --encoding');

  const gr = compile('/grep TODO --glob *.py --maxResults 5', registry);
  eq(gr.input.pattern, 'TODO', 'grep pattern positional');
  eq(gr.input.glob, '*.py', 'grep --glob');
  eq(gr.input.maxResults, 5, 'grep --maxResults coerced');
  eq(typeof gr.input.maxResults, 'number', 'maxResults is a number');

  const mv = compile('/mv a.txt b.txt', registry);
  eq(js(mv.input), js({ from: 'a.txt', to: 'b.txt' }), 'mv two positionals');

  const q = compile('/grep "a b c"', registry);
  eq(q.input.pattern, 'a b c', 'quoted argument preserved');
});

// ── unknown yields suggestions, never a throw ────────────────────────────
await test('an unknown command yields suggestions', async () => {
  const { registry, repl } = setup();
  const u = compile('/reed x', registry);
  eq(u.kind, 'unknown', 'unknown kind');
  assert(u.suggestions.includes('fs.read'), `suggests fs.read (${j(u.suggestions)})`);
  const r = await repl.feed('/reed x');
  assert(/unknown command/.test(outText(r)), 'repl reports unknown');
  assert(/fs\.read/.test(outText(r)), 'repl shows suggestions');
});

// ── destructive cannot run without confirmation ──────────────────────────
await test('destructive commands require an explicit y', async () => {
  const { fs, repl } = setup();
  await repl.feed('/write work/a.txt hello');
  eq((await fs.read('work/a.txt', { encoding: 'utf-8' })).data, 'hello', 'file written via CLI');
  const staged = await repl.feed('/rm work/a.txt');
  assert(staged.awaitingConfirm, 'awaiting confirmation');
  assert(/destructive/.test(outText(staged)), 'prints the proposal');
  assert((await fs.stat('work/a.txt')).ok, 'file NOT removed before confirm');
  const done = await repl.feed('y');
  assert(/done/.test(outText(done)), 'confirmed');
  eq((await fs.stat('work/a.txt')).code, 'ENOENT', 'removed after y');

  await repl.feed('/write work/b.txt bye');
  await repl.feed('/rm work/b.txt');
  const cancel = await repl.feed('n');
  assert(/cancelled/.test(outText(cancel)), 'cancelled on n');
  assert((await fs.stat('work/b.txt')).ok, 'file survives a cancelled removal');
});

// ── /help renders registry metadata (no hand-written help) ───────────────
await test('/help renders from registry metadata', async () => {
  const { repl } = setup();
  const all = outText(await repl.feed('/help'));
  assert(/\/fs\.read/.test(all) && /\/git\.status/.test(all), '/help lists commands');
  const one = outText(await repl.feed('/help fs.patch'));
  assert(/unified diff/.test(one), '/help fs.patch shows its description');
  assert(/fs:write/.test(one), '/help shows the scope');
});

// ── a real read/write/list round-trip through the CLI ────────────────────
await test('a read/write/list flow runs end-to-end through the repl', async () => {
  const { repl } = setup();
  await repl.feed('/write work/x.txt "hi there"');
  eq(outText(await repl.feed('/read work/x.txt')), 'hi there', 'read echoes content');
  const ls = outText(await repl.feed('/ls work'));
  assert(/x\.txt/.test(ls), 'ls shows the file');
});

// ── scrollback: redacted, serialise→restore byte-identical ───────────────
await test('scrollback redacts tokens and round-trips byte-identical', async () => {
  const sb = createScrollback();
  sb.push('a normal line');
  sb.push('key: ghp_ABCDEFGHIJKLMNOP0123456789');
  sb.push('oid 1234567890abcdef1234567890abcdef12345678 stays'); // 40-hex git oid
  const s1 = sb.serialize();
  assert(!/ghp_ABCDEF/.test(s1), 'provider key redacted');
  assert(/\[redacted\]/.test(s1), 'redaction marker present');
  assert(/1234567890abcdef1234567890abcdef12345678/.test(s1), 'git oid (40 hex) preserved');
  sb.restore(s1);
  const s2 = sb.serialize();
  eq(s1, s2, 'serialise → restore → serialise is byte-identical');
});

// ── tokenizer basics ─────────────────────────────────────────────────────
await test('tokenizer respects quotes and whitespace', async () => {
  eq(j(tokenize('read "a b" --x 1')), j(['read', 'a b', '--x', '1']), 'quoted token');
  eq(j(tokenize('  ls   src  ')), j(['ls', 'src']), 'collapses whitespace');
  eq(j(tokenize('write f ""')), j(['write', 'f', '']), 'empty quoted token kept');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C4b conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C4b conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
