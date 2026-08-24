// C5 Layer-1 conformance — the bash-style shell core over the Rig registry.
//
//   node sys/rig/cli/test/shell.test.mjs
//
// Drives createShell over an in-memory Rig backend (fileops + agent face) and
// checks the shell mechanics: cwd/cd, bare fs verbs, coreutils builtins, pipes,
// redirects, path resolution, and destructive staging through the C4 face.
// xterm is not involved — this is the headless system under test.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createShell } from '../shell.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function freshShell() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  return { face, shell: createShell({ registry, face }) };
}
const run = async (shell, line) => (await shell.feed(line)).output;

await test('pwd starts at root and cd navigates', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'pwd'), '/', 'root pwd');
  await run(shell, 'mkdir -p src/lib');
  await run(shell, 'cd src');
  eq(await run(shell, 'pwd'), '/src', 'cd into src');
  eq(shell.cwd, 'src', 'cwd getter');
  await run(shell, 'cd lib');
  eq(await run(shell, 'pwd'), '/src/lib', 'nested cd');
  await run(shell, 'cd ..');
  eq(await run(shell, 'pwd'), '/src', 'cd ..');
  await run(shell, 'cd /');
  eq(await run(shell, 'pwd'), '/', 'cd /');
});

await test('echo, redirect (>), append (>>), and cat', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'echo hello world'), 'hello world', 'echo');
  await run(shell, 'echo line1 > notes.txt');
  eq(await run(shell, 'cat notes.txt'), 'line1', 'redirect wrote file');
  await run(shell, 'echo line2 >> notes.txt');
  eq(await run(shell, 'cat notes.txt'), 'line1\nline2', 'append keeps line separators');
});

await test('ls lists names and respects cwd + relative paths', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p proj');
  await run(shell, 'echo a > proj/a.txt');
  await run(shell, 'echo b > proj/b.txt');
  const ls = await run(shell, 'ls proj');
  assert(ls.includes('a.txt') && ls.includes('b.txt'), `ls proj: ${ls}`);
  await run(shell, 'cd proj');
  eq(await run(shell, 'cat a.txt'), 'a', 'relative cat resolves against cwd');
});

await test('pipes: cat | grep, wc, head, tail', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo apple > f.txt');
  await run(shell, 'echo banana >> f.txt');
  await run(shell, 'echo cherry >> f.txt');
  eq(await run(shell, 'cat f.txt | grep e'), 'apple\ncherry', 'grep filters piped lines');
  eq(await run(shell, 'cat f.txt | wc'), '3 3 20', 'wc counts lines words chars');
  eq(await run(shell, 'cat f.txt | head -2'), 'apple\nbanana', 'head -2');
  eq(await run(shell, 'cat f.txt | tail -1'), 'cherry', 'tail -1');
});

await test('grep -n and grep over a named file', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo one > log.txt');
  await run(shell, 'echo two >> log.txt');
  await run(shell, 'echo three >> log.txt');
  eq(await run(shell, 'grep t log.txt'), 'two\nthree', 'grep file');
  eq(await run(shell, 'cat log.txt | grep -n t'), '2:two\n3:three', 'grep -n line numbers');
});

await test('rm is destructive: stages, then removes on y', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo x > gone.txt');
  const staged = await run(shell, 'rm gone.txt');
  assert(/destructive/.test(staged), `rm should stage: ${staged}`);
  assert(shell.awaitingConfirm, 'awaitingConfirm set');
  await run(shell, 'y');
  assert(!shell.awaitingConfirm, 'confirm cleared');
  const after = await run(shell, 'cat gone.txt');
  assert(/error|not|ENOENT|failed/i.test(after), `file should be gone: ${after}`);
});

await test('rm cancelled on n leaves the file', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo keep > keep.txt');
  await run(shell, 'rm keep.txt');
  const cancelled = await run(shell, 'n');
  assert(/cancelled/.test(cancelled), `should cancel: ${cancelled}`);
  eq(await run(shell, 'cat keep.txt'), 'keep', 'file survives');
});

await test('&& short-circuits on failure', async () => {
  const { shell } = freshShell();
  const out = await run(shell, 'cat nope.txt && echo REACHED');
  assert(!out.includes('REACHED'), `&& should not reach after failure: ${out}`);
  const out2 = await run(shell, 'echo ok && echo REACHED');
  assert(out2.includes('REACHED'), `&& should reach after success: ${out2}`);
});

await test('unknown command is reported, not spawned', async () => {
  const { shell } = freshShell();
  const out = await run(shell, 'sudo rm -rf /');
  assert(/command not found/.test(out), `unknown: ${out}`);
});

await test('mv and cp move/copy through the registry', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo data > a.txt');
  await run(shell, 'cp a.txt b.txt');
  eq(await run(shell, 'cat b.txt'), 'data', 'cp');
  await run(shell, 'mv b.txt c.txt');
  eq(await run(shell, 'cat c.txt'), 'data', 'mv target');
  const afterMv = await run(shell, 'cat b.txt');
  assert(/error|not|ENOENT/i.test(afterMv), 'mv removed source');
});

if (failures.length) {
  console.error(`shell core: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C5-L1/shell conformance: ${passed}/${passed} passed`);
