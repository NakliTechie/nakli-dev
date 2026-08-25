// Conformance — the agent loop over a real Rig shell.
//
//   node sys/ai/test/agent-loop.test.mjs
//
// The model is mocked (a scripted `infer`), but the tool side is the real Forge
// shell over an in-memory Rig backend — so this exercises the true tool-calling
// path (send → tool_calls → shell.feed → tool result → repeat) end-to-end,
// headlessly. The live endpoint is the only piece a browser/Ollama session adds.

import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGitCore } from '../../rig/git/git-core.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { runAgentLoop, shellTool, makeShellExecutor } from '../agent-loop.mjs';

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
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
  });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  return createShell({ registry, face });
}

// A scripted model: each entry is what infer() returns for that step. Later
// steps can inspect the transcript to react to tool results.
function scriptedInfer(script) {
  let i = 0;
  return async ({ messages }) => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return typeof step === 'function' ? step(messages) : step;
  };
}
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ── the headline: a multi-step tool-calling loop drives the real shell ──
await test('a scripted 3-tool-call loop creates and reads a file, then finishes', async () => {
  const shell = freshShell();
  const events = [];
  const result = await runAgentLoop({
    messages: [
      { role: 'system', content: 'You are a coding agent with a shell.' },
      { role: 'user', content: 'Create src/a.txt containing hi and show it.' },
    ],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'mkdir -p src' }, 'c0')] },
      { content: '', toolCalls: [call('shell', { command: 'echo hi > src/a.txt' }, 'c1')] },
      { content: '', toolCalls: [call('shell', { command: 'cat src/a.txt' }, 'c2')] },
      { content: 'Done — src/a.txt contains "hi".', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
    onEvent: e => events.push(e),
  });
  eq(result.stop, 'done', 'loop ended cleanly');
  eq(result.steps, 4, 'four model turns');
  assert(/hi/.test(result.text), `final text mentions the content: ${result.text}`);
  // The transcript carries the real tool result from `cat`.
  const toolMsgs = result.messages.filter(m => m.role === 'tool');
  eq(toolMsgs.length, 3, 'three tool results appended');
  eq(toolMsgs[2].content, 'hi', 'cat returned the file content through the real shell');
  // Prove the write actually landed in the workspace.
  eq((await shell.feed('cat src/a.txt')).output, 'hi', 'file persisted in the backend');
  // Events fired for each tool call and result.
  eq(events.filter(e => e.type === 'tool-call').length, 3, 'three tool-call events');
  eq(events.filter(e => e.type === 'tool-result').length, 3, 'three tool-result events');
  assert(events.some(e => e.type === 'done'), 'a done event fired');
});

await test('assistant tool-call turns carry null content + tool_calls, paired by id', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'list root' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'pwd' }, 'x1')] },
      { content: 'root is /', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
  });
  const assistantToolTurn = result.messages.find(m => m.role === 'assistant' && m.tool_calls);
  eq(assistantToolTurn.content, null, 'tool-call turn has null content');
  eq(assistantToolTurn.tool_calls[0].id, 'x1', 'tool_call id preserved');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  eq(toolMsg.tool_call_id, 'x1', 'tool result references the call id');
});

await test('no-progress guard stops a model repeating the identical call', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'r')] }]), // same forever
    executeTool: makeShellExecutor(shell),
    maxSteps: 50,
  });
  eq(result.stop, 'no-progress', 'stuck loop caught');
  assert(result.steps < 10, `bailed early, not at maxSteps: ${result.steps}`);
});

await test('max-steps bounds a model that keeps calling distinct tools', async () => {
  const shell = freshShell();
  let n = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: `echo ${n++}` }, `c${n}`)] }),
    executeTool: makeShellExecutor(shell),
    maxSteps: 5,
  });
  eq(result.stop, 'max-steps', 'bounded');
  eq(result.steps, 5, 'stopped at the cap');
});

await test('a tool call with invalid JSON args yields an error result, loop continues', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [{ id: 'b', type: 'function', function: { name: 'shell', arguments: '{bad json' } }] },
      { content: 'ok, recovered', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
  });
  eq(result.stop, 'done', 'recovered and finished');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert(/could not parse/i.test(toolMsg.content), `error surfaced to the model: ${toolMsg.content}`);
});

await test('makeShellExecutor rejects unknown tools and empty commands', async () => {
  const exec = makeShellExecutor(freshShell());
  assert(/unknown tool/.test(await exec('frobnicate', {})), 'unknown tool');
  assert(/non-empty/.test(await exec('shell', { command: '  ' })), 'empty command');
  eq(await exec('shell', { command: 'echo hi' }), 'hi', 'real output');
});

await test('shellTool schema is a valid OpenAI function tool', () => {
  const t = shellTool();
  eq(t.type, 'function', 'type');
  eq(t.function.name, 'shell', 'name');
  eq(t.function.parameters.required[0], 'command', 'required command');
});

await test('infer errors surface as stop:error, not a throw', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => { throw new Error('endpoint down'); },
    executeTool: makeShellExecutor(freshShell()),
  });
  eq(result.stop, 'error', 'error captured');
  assert(/endpoint down/.test(result.error), 'error text preserved');
});

if (failures.length) {
  console.error(`agent-loop: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/agent-loop conformance: ${passed}/${passed} passed`);
