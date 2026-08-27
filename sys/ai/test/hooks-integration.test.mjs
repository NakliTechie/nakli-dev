// Integration — a postTool hook command actually runs through the real Rig
// shell (the part Anvil wires around baseExec), and a preTool block decision.
//   node sys/ai/test/hooks-integration.test.mjs
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { parseHooks, preToolDecision, postToolCommands } from '../hooks.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

function mkShell(){
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  return { fs, shell: createShell({ registry, face }) };
}
const run = async (shell, line) => (await shell.feed(line)).output;

await test('postTool hook: matching command runs through the shell and takes effect', async () => {
  const { shell } = mkShell();
  const hooks = parseHooks('{"postTool":[{"on":"write|edit","pathMatch":"*.py","run":"echo formatted-{file} > marker.txt"}]}');
  // Anvil calls postToolCommands after a write; here we run them on the shell.
  const cmds = postToolCommands(hooks, 'write', { path: 'app.py' });
  eq(cmds.length, 1, 'one command produced');
  eq(cmds[0], "echo formatted-'app.py' > marker.txt", 'file substituted + quoted');
  for (const c of cmds) await run(shell, c);
  // quote-stripping concatenates: formatted-'app.py' -> formatted-app.py
  eq(await run(shell, 'cat marker.txt'), 'formatted-app.py', 'hook wrote the marker');
});

await test('postTool hook: no match → no commands, shell untouched', async () => {
  const { shell } = mkShell();
  const hooks = parseHooks('{"postTool":[{"on":"write","pathMatch":"*.py","run":"echo x > m.txt"}]}');
  const cmds = postToolCommands(hooks, 'write', { path: 'app.js' }); // wrong ext
  eq(cmds.length, 0, 'no command for .js');
  const after = await run(shell, 'cat m.txt');
  assert(/error|not|ENOENT|failed/i.test(after), 'marker never created');
});

await test('preTool block: dangerous shell refused, safe one allowed', async () => {
  const hooks = parseHooks('{"preTool":[{"on":"shell","commandMatch":"rm -rf /","block":"Refusing dangerous rm."}]}');
  assert(preToolDecision(hooks, 'shell', { command: 'sudo rm -rf /' }).blocked, 'dangerous blocked');
  assert(!preToolDecision(hooks, 'shell', { command: 'ls -la' }).blocked, 'safe allowed');
  assert(!preToolDecision(hooks, 'write', { path: 'a.py' }).blocked, 'other tool allowed');
});

if (failures.length){
  console.error(`hooks-integration: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`hooks-integration conformance: ${passed}/${passed} passed`);
