// C5 Layer-1 conformance — the bash-style shell core over the Rig registry.
//
//   node sys/rig/cli/test/shell.test.mjs
//
// Drives createShell over an in-memory Rig backend (fileops + agent face) and
// checks the shell mechanics: cwd/cd, bare fs verbs, coreutils builtins, pipes,
// redirects, path resolution, and destructive staging through the C4 face.
// xterm is not involved — this is the headless system under test.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
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

function freshShell({ git: withGit = false } = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const git = withGit ? createGitCore({ fs, dir: '/' }) : undefined;
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
  });
  // Op-log on its own backend so its jsonl never pollutes a git working tree.
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
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

await test('git: init, add, commit (staged), status, log', async () => {
  const { shell } = freshShell({ git: true });
  eq(await run(shell, 'git init'), 'ok', 'git init');
  await run(shell, 'echo hello > a.txt');
  const untracked = await run(shell, 'git status');
  assert(/\?\?\s+a\.txt/.test(untracked), `untracked shown: ${untracked}`);
  eq(await run(shell, 'git add a.txt'), 'ok', 'git add');
  const staged = await run(shell, 'git status');
  assert(/A\s+a\.txt/.test(staged), `staged shown: ${staged}`);
  const commitPrompt = await run(shell, 'git commit -m "first"');
  assert(/destructive/.test(commitPrompt), `commit stages: ${commitPrompt}`);
  await run(shell, 'y');
  eq(await run(shell, 'git status'), '(clean)', 'clean after commit');
  const log = await run(shell, 'git log');
  assert(/first/.test(log), `log shows message: ${log}`);
});

await test('variables: assignment, $VAR, ${VAR}, export/env/unset', async () => {
  const { shell } = freshShell();
  await run(shell, 'NAME=world');
  eq(await run(shell, 'echo hello $NAME'), 'hello world', '$VAR expands');
  eq(await run(shell, 'echo ${NAME}!'), 'world!', '${VAR} braces');
  await run(shell, 'export FOO=bar');
  const env = await run(shell, 'env');
  assert(/FOO=bar/.test(env) && /HOME=\//.test(env) && /PWD=\//.test(env), `env lists vars: ${env}`);
  await run(shell, 'unset NAME');
  eq(await run(shell, 'echo [$NAME]'), '[]', 'unset clears');
});

await test('$? reflects the last exit code; $PWD tracks cwd', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'echo $?'), '0', 'zero after success');
  await run(shell, 'cat nope.txt');           // fails
  eq(await run(shell, 'echo $?'), '1', 'one after failure');
  await run(shell, 'mkdir -p src');
  await run(shell, 'cd src');
  eq(await run(shell, 'echo $PWD'), '/src', '$PWD tracks cwd');
});

await test('variables expand in redirects and cd targets', async () => {
  const { shell } = freshShell();
  await run(shell, 'F=out.txt');
  await run(shell, 'echo hi > $F');
  eq(await run(shell, 'cat out.txt'), 'hi', 'redirect target expanded');
  await run(shell, 'mkdir -p work');
  await run(shell, 'D=work');
  await run(shell, 'cd $D');
  eq(await run(shell, 'pwd'), '/work', 'cd target expanded');
});

await test('glob expansion: *.txt expands, no-match stays literal', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo A > a.txt');
  await run(shell, 'echo B > b.txt');
  await run(shell, 'echo C > c.md');
  eq(await run(shell, 'echo *.txt'), 'a.txt b.txt', '*.txt expands to sorted matches');
  eq(await run(shell, 'cat *.txt'), 'A\nB', 'cat over a glob reads each match');
  eq(await run(shell, 'echo *.xyz'), '*.xyz', 'no match keeps the literal (nullglob off)');
  await run(shell, 'mkdir -p src');
  await run(shell, 'echo X > src/x.txt');
  await run(shell, 'cd src');
  eq(await run(shell, 'echo *.txt'), 'x.txt', 'glob is cwd-relative after cd');
});

if (failures.length) {
  console.error(`shell core: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C5-L1/shell conformance: ${passed}/${passed} passed`);
