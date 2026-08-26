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
import { runAgentLoop, shellTool, makeShellExecutor, taskDoneTool,
  estimateTokens, boundedText, interceptBashCommand } from '../agent-loop.mjs';

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

await test('verifier gate: a failing verdict is fed back; only a passing one completes', async () => {
  const shell = freshShell();
  const verify = async () => {
    const out = (await shell.feed('cat status.txt')).output;
    const ok = /PASS/.test(out);
    return { ok, exit: ok ? 0 : 1, stdout: out };
  };
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'echo FAIL > status.txt' }, 'c0')] },
      { content: 'done (prematurely)', toolCalls: [] },              // claims done → verify FAILS
      { content: '', toolCalls: [call('shell', { command: 'echo PASS > status.txt' }, 'c1')] }, // fix
      { content: 'now really done', toolCalls: [] },                 // claims done → verify PASSES
    ]),
    executeTool: makeShellExecutor(shell),
    verify,
    onEvent: (e) => events.push(e),
  });
  eq(result.stop, 'done', 'completed'); eq(result.verified, true, 'verified true');
  assert(events.some((e) => e.type === 'verify-fail'), 'a verify-fail was surfaced');
  assert(events.some((e) => e.type === 'verify-pass'), 'a verify-pass ended it');
});

await test('verifier gate: stop:unverified when the model never satisfies the verifier', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'I think it is done', toolCalls: [] }), // always claims done, never acts
    executeTool: makeShellExecutor(shell),
    verify: async () => ({ ok: false, exit: 1, stderr: 'still failing' }),
    maxVerifyRounds: 2,
  });
  eq(result.stop, 'unverified', 'never verified'); eq(result.verified, false, 'verified false');
  eq(result.steps, 2, 'stopped after maxVerifyRounds');
});

await test('no verifier → the model still completes on its own (back-compat)', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: 'all set', toolCalls: [] }]),
    executeTool: makeShellExecutor(shell),
  });
  eq(result.stop, 'done', 'done without a verifier');
  assert(result.verified === undefined, 'no verified flag when no verifier');
});

// ── Batch 7: gate memoization by workspace hash ─────────────────────────
await test('gate memoization: an unchanged workspace hash replays the cached failure — no rerun', async () => {
  let verifyCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'I claim it is done', toolCalls: [] }), // never acts
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => { verifyCalls++; return { ok: false, exit: 1, stderr: 'still red' }; },
    workspaceHash: async () => 'STABLE', // workspace never changes
    maxVerifyRounds: 3,
  });
  eq(result.stop, 'unverified', 'stopped unverified');
  eq(verifyCalls, 1, 'gate ran once; the 2 later identical-hash rounds replayed the memo');
});

await test('gate memoization: a changed workspace hash reruns the gate', async () => {
  let verifyCalls = 0;
  let hashN = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'done?', toolCalls: [] }),
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => { verifyCalls++; return { ok: false, exit: 1, stderr: 'red' }; },
    workspaceHash: async () => `H${hashN++}`, // different every check
    maxVerifyRounds: 3,
  });
  eq(result.stop, 'unverified', 'unverified');
  eq(verifyCalls, 3, 'gate reran each round because the hash changed');
});

// ── Batch 7: bounded gate output as the repair prompt ───────────────────
await test('bounded gate output is fed back as the repair prompt', async () => {
  const bigStdout = Array.from({ length: 500 }, (_, i) => `error line ${i}`).join('\n');
  let sawFeedback = null;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: 'done (early)', toolCalls: [] }, // fails → feedback injected
      (messages) => { sawFeedback = messages[messages.length - 1]; return { content: '', toolCalls: [] }; },
    ]),
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => ({ ok: false, exit: 2, stdout: bigStdout }),
    gateOutputCap: { maxLines: 50, maxBytes: 5000 },
    maxVerifyRounds: 3,
  });
  assert(sawFeedback && sawFeedback.role === 'user', 'a user repair message was injected');
  assert(/exit 2/.test(sawFeedback.content), 'the exit code is in the repair prompt');
  assert(/output truncated/.test(sawFeedback.content), 'the gate output was bounded');
  assert(sawFeedback.content.split('\n').length < 100, 'feedback is capped, not the full 500 lines');
});

// ── Batch 7: explicit completion (task_done) + gate veto ────────────────
await test('task_done: a red gate rejects completion; a later green gate accepts it', async () => {
  const shell = freshShell();
  const verify = async () => {
    const out = (await shell.feed('cat status.txt')).output;
    const ok = /PASS/.test(out);
    return { ok, exit: ok ? 0 : 1, stdout: out };
  };
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do it' }],
    tools: [shellTool(), taskDoneTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'echo FAIL > status.txt' }, 's0')] },
      { content: '', toolCalls: [call('task_done', { summary: 'think done' }, 'd0')] }, // gate RED → rejected
      { content: '', toolCalls: [call('shell', { command: 'echo PASS > status.txt' }, 's1')] },
      { content: '', toolCalls: [call('task_done', { summary: 'really done' }, 'd1')] }, // gate GREEN → accepted
    ]),
    executeTool: makeShellExecutor(shell),
    verify,
    onEvent: (e) => events.push(e),
  });
  eq(result.stop, 'done', 'completed via task_done');
  eq(result.verified, true, 'verified true');
  // The rejected task_done left a tool message with the gate failure.
  const rejected = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'd0');
  assert(/NOT complete/.test(rejected.content), 'red task_done fed back the failure');
  const accepted = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'd1');
  assert(/complete/i.test(accepted.content), 'green task_done accepted');
});

await test('task_done with no gate wired is accepted as the explicit done signal', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool(), taskDoneTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('task_done', {}, 'd')] }]),
    executeTool: makeShellExecutor(freshShell()),
  });
  eq(result.stop, 'done', 'done'); eq(result.verified, true, 'accepted');
});

// ── Batch 7: the budget ladder (turns / tokens / wall-clock) ────────────
await test('budget ladder: the turns axis trips its stop reason', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: `echo ${Math.random()}` }, `c${Math.random()}`)] }),
    executeTool: makeShellExecutor(freshShell()),
    budget: { turns: 3 },
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'turns', 'the turns axis');
  eq(result.steps, 3, 'stopped at the turn budget');
});

await test('budget ladder: the tokens axis trips its stop reason', async () => {
  const huge = 'x'.repeat(40_000); // ~10k tokens, dwarfs the budget
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: huge }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'echo hi' }, 'c')] }),
    executeTool: makeShellExecutor(freshShell()),
    budget: { tokens: 100 },
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'tokens', 'the tokens axis');
});

await test('budget ladder: the wall-clock axis trips its stop reason', async () => {
  let t = 1000;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => { t += 5000; return { content: '', toolCalls: [call('shell', { command: 'echo hi' }, `c${t}`)] }; },
    executeTool: makeShellExecutor(freshShell()),
    budget: { wallClockMs: 10_000 },
    now: () => t, // injected clock advances 5s per turn
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'wall-clock', 'the wall-clock axis');
});

// ── Batch 3 rest: bash interceptor hints ────────────────────────────────
await test('interceptBashCommand redirects sed -i / grep -r / cat > to structured tools', () => {
  assert(/edit/.test(interceptBashCommand('sed -i s/a/b/ f.txt') || ''), 'sed -i → edit');
  assert(/edit/.test(interceptBashCommand('perl -i -pe s/a/b/ f') || ''), 'perl -i → edit');
  assert(/rg|ripgrep/.test(interceptBashCommand('grep -r foo src/') || ''), 'grep -r → rg');
  assert(/rg|ripgrep/.test(interceptBashCommand('grep -R foo .') || ''), 'grep -R → rg');
  assert(/write/.test(interceptBashCommand('cat > out.txt') || ''), 'cat > → write');
  assert(/write/.test(interceptBashCommand('cat <<EOF') || ''), 'cat heredoc → write');
  eq(interceptBashCommand('cat f.txt'), null, 'plain cat read is not intercepted');
  eq(interceptBashCommand('grep foo f.txt'), null, 'non-recursive grep is not intercepted');
  eq(interceptBashCommand('echo hi > f.txt'), null, 'echo redirect (supported) is not intercepted');
  eq(interceptBashCommand('ls -la'), null, 'ls is not intercepted');
});

await test('the shell executor returns the interceptor hint instead of running the command', async () => {
  const exec = makeShellExecutor(freshShell());
  const out = await exec('shell', { command: 'sed -i s/a/b/ f.txt' });
  assert(/edit/.test(out), `hint returned: ${out}`);
});

// ── token estimator + boundedText (compaction/budget primitives) ────────
await test('estimateTokens and boundedText behave as monotonic, capping primitives', () => {
  assert(estimateTokens('a'.repeat(400)) === 100, '~4 chars/token');
  assert(estimateTokens([{ role: 'user', content: 'a'.repeat(40) }]) === 10, 'over a transcript');
  const capped = boundedText(Array.from({ length: 300 }, (_, i) => `L${i}`).join('\n'), { maxLines: 10, maxBytes: 9999 });
  assert(/truncated/.test(capped), 'marks truncation');
  assert(capped.split('\n').length <= 12, 'capped to ~10 lines');
  eq(boundedText('short'), 'short', 'short text passes through unchanged');
});

if (failures.length) {
  console.error(`agent-loop: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/agent-loop conformance: ${passed}/${passed} passed`);
