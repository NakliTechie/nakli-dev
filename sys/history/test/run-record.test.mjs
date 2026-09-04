// Conformance — the run record: the log is the agent.
//   node sys/history/test/run-record.test.mjs
//
// A real runAgentLoop over a real Rig shell is RECORDED; then everything Anvil
// keeps about a run is derived from the record, and the run is REPLAYED with
// zero model calls. Strict replay must name the first divergent event.
import { runAgentLoop, shellTool, makeShellExecutor } from '../../ai/agent-loop.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { verifyChain } from '../ledger.mjs';
import { RUN_EVENTS, createRunRecorder, loadRecord, foldStatus, foldLog, foldTranscript,
         replayInfer, replayExecuteTool, compareRuns, requestHash, ReplayMiss } from '../run-record.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

function freshShell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return createShell({ registry, face });
}
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const scripted = (turns) => { let i = 0; return async () => turns[i++] || { content: 'done', toolCalls: [] }; };
const SCRIPT = () => [
  { content: '', toolCalls: [call('shell', { command: 'mkdir -p src' }, 'c0')] },
  { content: '', toolCalls: [call('shell', { command: 'echo hi > src/a.txt' }, 'c1')] },
  { content: '', toolCalls: [call('shell', { command: 'cat src/a.txt' }, 'c2')] },
  { content: 'Done — src/a.txt contains "hi".', toolCalls: [] },
];
const MESSAGES = [{ role: 'system', content: 'You are a coding agent with a shell.' }, { role: 'user', content: 'Create src/a.txt containing hi and show it.' }];

// Record one real run. Returns { rec, result, shell }.
async function recordRun({ verify = null, infer = scripted(SCRIPT()), now } = {}) {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test', now });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec.wrapInfer(infer), executeTool: makeShellExecutor(shell),
    onEvent: rec.onEvent, verify,
  });
  await rec.finish(result);
  await rec.settled();
  return { rec, result, shell };
}

await test('a real run is recorded as a verifiable chain using only the fixed verbs', async () => {
  const { rec, result } = await recordRun();
  eq(result.stop, 'done', 'the loop finished');
  const ev = rec.events();
  const v = await verifyChain(ev);
  eq(v.ok, true, `chain verifies (broke at ${v.brokenAt})`);
  for (const e of ev) assert(RUN_EVENTS.includes(e.tool), `unknown verb in record: ${e.tool}`);
  eq(ev[0].tool, 'run.started', 'opens with run.started');
  eq(ev[ev.length - 1].tool, 'run.stopped', 'closes with run.stopped');
  eq(ev.filter((e) => e.tool === 'llm.responded').length, 4, 'four model exchanges');
  eq(ev.filter((e) => e.tool === 'tool.called').length, 3, 'three tool calls');
  eq(ev.filter((e) => e.tool === 'tool.responded').length, 3, 'three tool results');
  // Every payload is reachable through the resolver — the chain holds hashes only.
  for (const e of ev) { const r = rec.resolve(e); assert(r.input !== undefined && r.output !== undefined, `payloads resolve for ${e.tool}`); }
  assert(!JSON.stringify(ev).includes('mkdir -p src'), 'the CHAIN carries no payload text, only hashes');
});

await test('status is a fold: an ungated done is unclaimed; a gated verified done is done', async () => {
  const ungated = await recordRun();
  const s1 = foldStatus(ungated.rec.events(), ungated.rec.resolve, { gated: false });
  eq(s1.phase, 'stopped', 'stopped'); eq(s1.stop, 'done', 'stop'); eq(s1.status, 'unclaimed', 'no gate → the agent\'s own claim');
  eq(s1.steps, 4, 'steps derived from turn.started');

  const gated = await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  eq(gated.result.verified, true, 'the gate passed');
  const s2 = foldStatus(gated.rec.events(), gated.rec.resolve, { gated: true });
  eq(s2.status, 'done', 'gate ∧ verified → done');
  assert(gated.rec.events().some((e) => e.tool === 'verify.passed'), 'the pass is in the record');
});

await test('the log pane is a fold: same rows renderLog draws, tool calls paired with results', async () => {
  const { rec } = await recordRun();
  const rows = foldLog(rec.events(), rec.resolve);
  eq(rows[0].k, 'user', 'opens with the prompt');
  const tools = rows.filter((r) => r.k === 'tool');
  eq(tools.length, 3, 'three tool rows');
  eq(tools[2].detail, 'cat src/a.txt', 'detail is the command');
  eq(tools[2].result, 'hi', 'the real shell output rode the record');
  assert(rows.some((r) => r.k === 'assistant' && /contains "hi"/.test(r.text)), 'assistant prose present');
  eq(rows[rows.length - 1].text, 'agent done · 4 steps', 'closing system row from run.stopped');
});

await test('the transcript is a fold: no system prefix, every tool reply paired with its call', async () => {
  const { rec } = await recordRun();
  const t = foldTranscript(rec.events(), rec.resolve);
  eq(t[0].role, 'user', 'starts after the system prefix');
  assert(!t.some((m) => m.role === 'system'), 'no system message carried');
  const offered = new Set();
  for (const m of t) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) offered.add(c.id);
    if (m.role === 'tool') assert(offered.has(m.tool_call_id), `orphan tool reply ${m.tool_call_id}`);
  }
  eq(t.filter((m) => m.role === 'tool').length, 3, 'three tool replies');
  eq(t[t.length - 1].role, 'assistant', 'ends on the final prose');
});

await test('REPLAY: the run re-executes with ZERO model calls and reproduces the record exactly', async () => {
  const { rec } = await recordRun();
  let liveCalls = 0;
  const shell = freshShell();
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec2.wrapInfer(replayInfer(rec, { strict: true, live: async () => { liveCalls++; return { content: 'x', toolCalls: [] }; } })),
    executeTool: makeShellExecutor(shell), // tools run LIVE against a fresh workspace
    onEvent: rec2.onEvent,
  });
  await rec2.finish(result); await rec2.settled();
  eq(liveCalls, 0, 'no live model call was made');
  eq(result.stop, 'done', 'replayed run finished');
  const cmp = compareRuns(rec, rec2);
  eq(cmp.ok, true, `strict replay is green (diverged at ${cmp.at}: ${cmp.why})`);
  eq((await shell.feed('cat src/a.txt')).output, 'hi', 'and the replayed run rebuilt the workspace for real');
});

await test('REPLAY with recorded tools too: no side effects, still green', async () => {
  const { rec } = await recordRun();
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec2.wrapInfer(replayInfer(rec)), executeTool: replayExecuteTool(rec),
    onEvent: rec2.onEvent,
  });
  await rec2.finish(result); await rec2.settled();
  eq(compareRuns(rec, rec2).ok, true, 'fully recorded replay is green');
});

await test('STRICT replay names the FIRST divergent event when the world changed', async () => {
  const { rec } = await recordRun();
  // A live tool that answers differently to the third call — the world moved.
  const shell = freshShell();
  const liveExec = makeShellExecutor(shell);
  const exec = async (name, args, c) => (args?.command === 'cat src/a.txt' ? 'DIFFERENT' : liveExec(name, args, c));
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  let miss = null;
  try {
    const result = await runAgentLoop({
      messages: MESSAGES, tools: [shellTool()],
      infer: rec2.wrapInfer(replayInfer(rec, { strict: true })), executeTool: exec, onEvent: rec2.onEvent,
    });
    await rec2.finish(result);
  } catch (e) { miss = e; }
  await rec2.settled();
  // The divergence surfaces two ways, both correct: the changed tool output is a
  // different event, and the NEXT model request (which embeds that output) is a
  // request the record never saw.
  const cmp = compareRuns(rec, rec2);
  eq(cmp.ok, false, 'red');
  const divergedVerb = rec.events()[cmp.at].tool;
  eq(divergedVerb, 'tool.responded', `first divergence is the changed tool result, not something later (got ${divergedVerb} at ${cmp.at})`);
  assert(/output of tool\.responded differs/.test(cmp.why), cmp.why);
  // And the loop itself was stopped by a ReplayMiss on the unseen request.
  const stopped = rec2.events().find((e) => e.tool === 'run.stopped');
  const stopOut = stopped ? rec2.resolve(stopped).output : null;
  assert((miss instanceof ReplayMiss) || (stopOut && stopOut.stop === 'error' && /replay miss/.test(stopOut.error || '')),
    'the unseen request was refused in strict mode');
});

await test('content addressing: same request → same hash; a different toolset is a different run', async () => {
  const a = await requestHash({ messages: MESSAGES, tools: [shellTool()] });
  const b = await requestHash({ messages: MESSAGES, tools: [shellTool()] });
  const c = await requestHash({ messages: MESSAGES, tools: [] });
  const d = await requestHash({ messages: MESSAGES, tools: [shellTool()], model: 'qwen3:8b' });
  eq(a, b, 'deterministic'); assert(a !== c, 'tool definitions are in the hash'); assert(a !== d, 'model label is in the hash');
});

await test('export/load round-trips; a hashes-only copy (no blobs) still verifies', async () => {
  const { rec } = await recordRun();
  const dump = rec.export();
  assert(typeof dump.events === 'string' && dump.events.includes('run.started'), 'NDJSON chain');
  const back = loadRecord(dump);
  eq((await back.verify()).ok, true, 'reloaded chain verifies');
  eq(back.events().length, rec.events().length, 'same length');
  eq(foldStatus(back.events(), back.resolve).status, foldStatus(rec.events(), rec.resolve).status, 'same fold');
  const audit = loadRecord({ events: dump.events }); // blobs dropped
  eq((await audit.verify()).ok, true, 'a payload-free audit copy still verifies');
  eq(audit.resolve(audit.events()[0]).input, undefined, 'but cannot resolve payloads — by design');
});

await test('a run that died mid-flight reads as running, and the record says where', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  // The tab "closes" during the second model call: infer never returns and no finish() is recorded.
  let n = 0;
  const infer = rec.wrapInfer(async () => { n++; if (n === 2) throw new Error('tab closed'); return SCRIPT()[0]; });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer, executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  // (no rec.finish — the process is gone)
  await rec.settled();
  const s = foldStatus(rec.events(), rec.resolve);
  eq(s.phase, 'running', 'no run.stopped → still running, not silently idle');
  const last = rec.events()[rec.events().length - 1];
  eq(last.tool, 'llm.requested', 'the last event is the request that never answered — the work owed');
  eq(result.stop, 'error', 'sanity: the loop did surface the throw');
});

await test('the fixed vocabulary is frozen and complete for the loop', () => {
  assert(Object.isFrozen(RUN_EVENTS), 'frozen');
  for (const v of ['run.started', 'turn.started', 'llm.requested', 'llm.responded', 'tool.called', 'tool.responded', 'tool.failed', 'verify.passed', 'verify.failed', 'run.stopped'])
    assert(RUN_EVENTS.includes(v), `missing verb ${v}`);
});

if (failures.length) { console.error(`history/run-record: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`history/run-record conformance: ${passed}/${passed} passed`);
