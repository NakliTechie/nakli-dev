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
         replayInfer, replayExecuteTool, compareRuns, requestHash, ReplayMiss,
         OUTCOME_SIGNALS, foldOutcome, foldReuse, foldStopReasons, stopReasonsLine,
         searchRecords, readEvent, historyTool, HISTORY_ROLES } from '../run-record.mjs';

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

// ─────────────────────────────────────────── history / retrieval (B2) ──
// Build three recorded runs; each writes a distinct file so a later run can find an
// earlier one's tool output — the "audit-state" rehydration the thread describes.
async function recordFinding(marker) {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: `investigate ${marker}` }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  const script = [{ content: '', toolCalls: [call('shell', { command: `echo ${marker}` }, 'c0')] }, { content: `found ${marker}`, toolCalls: [] }];
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()], infer: rec.wrapInfer(scripted(script)), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  return rec;
}

await test('HISTORY search: from "run 3" a query finds a tool result recorded in run 1, newest first, with a readable id', async () => {
  const entries = [
    { runId: 'run1', record: await recordFinding('WIDGET-ALPHA') },
    { runId: 'run2', record: await recordFinding('WIDGET-BETA') },
    { runId: 'run3', record: await recordFinding('WIDGET-GAMMA') },
  ];
  const hits = searchRecords(entries, { query: 'widget-alpha' });
  assert(hits.length >= 1, 'the run-1 finding is searchable from run 3');
  assert(hits.some((h) => h.runId === 'run1' && /WIDGET-ALPHA/.test(h.excerpt)), 'hit names its run and centres the excerpt on the match');
  assert(/^run1#\d+$/.test(hits.find((h) => h.runId === 'run1').id), 'the id is runId#index');
  const all = searchRecords(entries, { query: 'widget', limit: 20 });
  const ts = all.map((h) => h.ts); assert(ts.every((t, i) => i === 0 || ts[i - 1] >= t), 'newest first');
  eq(searchRecords(entries, { query: '' }).length, 0, 'an empty query finds nothing');
  eq(searchRecords(entries, { query: 'widget', limit: 2 }).length, 2, 'limit caps the hits');
});

await test('HISTORY role slices: reviewer sees tool events, supervisor sees the trajectory, neither leaks the other', async () => {
  const entries = [{ runId: 'r', record: await recordFinding('SLICE-X') }];
  const rev = searchRecords(entries, { query: 'slice-x', role: 'reviewer' });
  assert(rev.length >= 1 && rev.every((h) => HISTORY_ROLES.reviewer.has(h.tool)), 'reviewer hits are tool/verify events');
  const sup = searchRecords(entries, { query: 'slice-x', role: 'supervisor' });
  assert(sup.every((h) => HISTORY_ROLES.supervisor.has(h.tool)), 'supervisor hits are turns/stops/verify only');
  assert(!sup.some((h) => h.tool === 'tool.responded'), 'the supervisor slice does not carry tool results');
});

await test('HISTORY read: an event pages by offset and preserves the tail; a bad id is reported, not thrown', async () => {
  const entries = [{ runId: 'run1', record: await recordFinding('PAGEME') }];
  const hit = searchRecords(entries, { query: 'pageme', role: 'reviewer' }).find((h) => h.tool === 'tool.responded');
  assert(hit, 'the tool result is a hit');
  const p1 = readEvent(entries, hit.id, { offset: 0, limit: 4 });
  eq(p1.text.length, 4, 'first page is limit-sized'); eq(p1.nextOffset, 4, 'nextOffset points past it');
  const p2 = readEvent(entries, hit.id, { offset: p1.nextOffset, limit: 4000 });
  assert(p2.text.length > 0 && p2.nextOffset === null, 'the tail reads to the end');
  const whole = readEvent(entries, hit.id, { offset: 0, limit: 100000 });
  eq(p1.text + readEvent(entries, hit.id, { offset: 4, limit: 100000 }).text, whole.text, 'the pages reassemble the whole event');
  assert(readEvent(entries, 'nope', {}).error, 'a bad id is an error field'); assert(readEvent(entries, 'run1#999', {}).error, 'a missing event is an error');
});

await test('HISTORY never inlines base64/data-URI payloads; the tool advertises search + read', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'grab the image' }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  const bigB64 = 'A'.repeat(5000);
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'cat img' }, 'c0')] }, { content: 'ok', toolCalls: [] }])),
    executeTool: async () => bigB64, onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  const entries = [{ runId: 'img', record: rec }];
  const read = readEvent(entries, 'img#' + rec.events().findIndex((e) => e.tool === 'tool.responded'), { limit: 100000 });
  assert(/binary\/base64 — not inlined/.test(read.text) && !read.text.includes(bigB64), 'a base64 blob is summarised, never inlined');
  const t = historyTool(); eq(t.function.name, 'history', 'named history');
  assert(t.function.parameters.properties.op.enum.join(',') === 'search,read', 'search + read');
});

await test('a checkpoint is recorded on the chain and reads back through the history tool (B4)', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'long task' }], tools: [] });
  rec.onEvent({ type: 'turn-start', step: 0 });
  await rec.checkpoint('goal: ship X. progress: wrote the module. next: the test.');
  await rec.finish({ stop: 'done', steps: 1, verified: false }); await rec.settled();
  const ev = rec.events();
  const cp = ev.find((e) => e.tool === 'run.checkpoint'); assert(cp, 'the checkpoint is on the chain');
  eq((await verifyChain(ev)).ok, true, 'the chain still verifies with the new verb');
  eq(rec.resolve(cp).output.handoff, 'goal: ship X. progress: wrote the module. next: the test.', 'the handoff is the payload');
  const hits = searchRecords([{ runId: 'r', record: rec }], { query: 'ship X', role: 'supervisor' });
  assert(hits.some((h) => h.tool === 'run.checkpoint'), 'a checkpoint is in the supervisor slice');
});

await test('the fixed vocabulary is frozen and complete for the loop', () => {
  assert(Object.isFrozen(RUN_EVENTS), 'frozen');
  for (const v of ['run.started', 'turn.started', 'llm.requested', 'llm.responded', 'tool.called', 'tool.responded', 'tool.failed', 'verify.passed', 'verify.failed', 'run.stopped', 'run.checkpoint'])
    assert(RUN_EVENTS.includes(v), `missing verb ${v}`);
});

// ─────────────────────────────────────────────── outcome (A4) ──
// Three recorded fixtures — pass / failing gate / budget — plus an ungated finish and
// a memory-using run. Every label is derived from the record; strict on success.

await test('OUTCOME pass: a gated, verified finish is the ONLY way to earn the success label', async () => {
  const { rec } = await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'success', 'label'); eq(o.note, null, 'no caveat');
  const t = o.signals.find((s) => s.kind === 'terminal');
  eq(t.polarity, 'success', 'terminal polarity'); eq(t.weight, 1.0, 'terminal weight is ground truth (1.0), not a regex guess');
  assert(o.score > 0, 'positive score');
  for (const s of o.signals) assert(OUTCOME_SIGNALS.includes(s.kind), `known signal kind ${s.kind}`);
});

await test('OUTCOME failing gate: unverified stop → failure, and every failed round is counted', async () => {
  const { rec, result } = await recordRun({ verify: async () => ({ ok: false, exit: 1, stdout: '', stderr: 'nope' }) });
  eq(result.stop, 'unverified', 'sanity: the loop gave up after maxVerifyRounds');
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'failure', 'label');
  eq(o.signals.find((s) => s.kind === 'terminal').weight, 1.0, 'gate never passed is a full-weight failure');
  const g = o.signals.find((s) => s.kind === 'gate');
  assert(g && g.polarity === 'failure' && /3 failed gate round/.test(g.detail), `failed rounds counted: ${g && g.detail}`);
  assert(o.score < 0, 'negative score');
});

await test('OUTCOME budget: a budget stop is a failure to finish (0.8), never a success', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rec.wrapInfer(scripted(SCRIPT())), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent, budget: { turns: 2 } });
  await rec.finish(result); await rec.settled();
  eq(result.stop, 'budget', 'sanity: budget tripped');
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'failure', 'label');
  const t = o.signals.find((s) => s.kind === 'terminal');
  eq(t.weight, 0.8, 'did-not-finish weight'); assert(/budget \(turns\)/.test(t.detail), `names the axis: ${t.detail}`);
});

await test('OUTCOME unclaimed: an ungated finish yields NO success evidence, and says so', async () => {
  const { rec } = await recordRun();
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'unknown', 'not success, not failure');
  assert(/unclaimed/.test(o.note || ''), `the note explains: ${o.note}`);
  eq(o.signals.find((s) => s.kind === 'terminal').polarity, 'neutral', 'terminal is neutral');
  eq(o.score, 0, 'no score either way');
  // the RECORD must corroborate: a stop claiming verified:true with no verify.passed event
  // in the chain (an ungated loop says exactly that) earns nothing — a flag cannot mint success.
  const forged = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await forged.start({ messages: MESSAGES, tools: [] });
  await forged.finish({ stop: 'done', verified: true, steps: 1 }); await forged.settled();
  const f = foldOutcome(forged.events(), forged.resolve);
  eq(f.label, 'unknown', 'verified:true without a verify.passed event is not success'); assert(/unclaimed/.test(f.note), f.note);
  // a hashes-only audit copy (blobs dropped) says why it has no evidence
  const audit = loadRecord({ events: rec.export().events });
  const a = foldOutcome(audit.events(), audit.resolve);
  eq(a.label, 'unknown', 'no payload → unknown'); assert(/payload is missing/.test(a.note), a.note);
  // a run that died mid-flight: no run.stopped → no evidence, with a note
  const dead = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await dead.start({ messages: MESSAGES, tools: [shellTool()] }); await dead.settled();
  const d = foldOutcome(dead.events(), dead.resolve);
  eq(d.label, 'unknown', 'dead run is unknown'); assert(/no run\.stopped/.test(d.note), d.note);
});

// A memory-using run: recall x twice, then retract it — both per-fact failure signals fire.
const MEM_SCRIPT = () => [
  { content: '', toolCalls: [call('recall', { name: 'cache-guess' }, 'r1')] },
  { content: '', toolCalls: [call('recall', { name: 'cache-guess' }, 'r2')] },
  { content: '', toolCalls: [call('recall', { name: 'db-fact' }, 'r3')] },
  { content: '', toolCalls: [call('revise', { name: 'cache-guess', status: 'retracted', cause: 'correction' }, 'v1')] },
  { content: 'done', toolCalls: [] },
];
async function recordMemRun({ verify = null } = {}) {
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [] });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [], infer: rec.wrapInfer(scripted(MEM_SCRIPT())), executeTool: async (name, args) => `${name}:${args.name}`, onEvent: rec.onEvent, verify });
  await rec.finish(result); await rec.settled();
  return rec;
}

await test('OUTCOME per-fact: repeat recall and recall-then-retract are failure evidence on the FACT', async () => {
  const rec = await recordMemRun();
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.recalled.join(','), 'cache-guess,db-fact', 'deliberate recalls, in order, deduped');
  eq(o.retracted.join(','), 'cache-guess', 'retractions seen');
  const rr = o.signals.find((s) => s.kind === 'repeat_recall'); assert(rr && /2×/.test(rr.detail), `repeat recall fires: ${rr && rr.detail}`);
  const c = o.signals.find((s) => s.kind === 'contradiction'); assert(c && /retracted in the same run/.test(c.detail), 'contradiction fires');
  const ev = o.facts['cache-guess'] || [];
  assert(ev.some((x) => x.kind === 'repeat_recall') && ev.some((x) => x.kind === 'contradiction'), 'both land on the fact');
  assert(!o.facts['db-fact'], 'a fact recalled once in an unclaimed run earns nothing');
  eq(o.label, 'failure', 'the run itself reads as failure (score < 0) even though it "finished"');
});

await test('OUTCOME strict on success: a fact recalled in a PASSED run earns success evidence; a retracted one never does', async () => {
  const rec = await recordMemRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'success', 'gate passed');
  assert((o.facts['db-fact'] || []).some((x) => x.kind === 'terminal' && x.polarity === 'success' && x.weight === 0.5), 'db-fact was load-bearing in a success');
  assert(!(o.facts['cache-guess'] || []).some((x) => x.polarity === 'success'), 'the retracted fact earns no success');
});

await test('OUTCOME reuse across runs: ≥3 distinct runs recalling a fact → load-bearing (neutral); injection never counts', async () => {
  const runs = [await recordMemRun(), await recordMemRun(), await recordMemRun()];
  const reuse = foldReuse(runs, { minRuns: 3 });
  const names = reuse.map((r) => r.name).sort().join(',');
  eq(names, 'cache-guess,db-fact', 'both facts recalled in 3 runs');
  eq(reuse[0].polarity, 'neutral', 'reuse is neutral — used, not proven');
  eq(foldReuse(runs.slice(0, 2), { minRuns: 3 }).length, 0, 'two runs are not enough');
  // a run with NO recall tool calls contributes nothing, however many facts its index injected
  const { rec: plain } = await recordRun();
  eq(foldReuse([plain, plain, plain]).length, 0, 'injection is not use');
  const one = await recordMemRun();
  eq(foldReuse([one, one, one]).length, 0, 'the same record passed thrice is one run, not three');
});

// ──────────────────────────────────────────── stop reasons (D1) ──
await test('STOP REASONS: a histogram over records — by stop, by derived status, by budget axis; unfinished counted', async () => {
  const pass = (await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) })).rec;
  const fail = (await recordRun({ verify: async () => ({ ok: false, exit: 1, stdout: '', stderr: '' }) })).rec;
  const plain = (await recordRun()).rec; // ungated done → unclaimed under gated:true (the index's reading)
  const shell = freshShell();
  const bud = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await bud.start({ messages: MESSAGES, tools: [shellTool()] });
  const r = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: bud.wrapInfer(scripted(SCRIPT())), executeTool: makeShellExecutor(shell), onEvent: bud.onEvent, budget: { turns: 1 } });
  await bud.finish(r); await bud.settled();
  const dead = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await dead.start({ messages: MESSAGES, tools: [] }); await dead.settled();
  const h = foldStopReasons([pass, fail, plain, bud, dead, pass /* dup */]);
  eq(h.runs, 5, 'five distinct records (a duplicate object counts once)');
  eq(h.unfinished, 1, 'the dead run is unfinished');
  eq(h.byStop.done, 2, 'two done stops (one gated, one not)');
  eq(h.byStop.unverified, 1, 'one unverified'); eq(h.byStop.budget, 1, 'one budget');
  eq(h.byStatus.done, 1, 'only the gated pass is done'); eq(h.byStatus.unclaimed, 1, 'the ungated finish is unclaimed');
  eq(h.byStatus.error, 1, 'unverified reads as error'); eq(h.byStatus.idle, 1, 'budget reads as idle'); eq(h.byStatus.running, 1, 'dead reads as running');
  eq(h.byAxis.turns, 1, 'the budget axis is counted');
  const line = stopReasonsLine(h);
  assert(/^5 runs · /.test(line) && /budget: turns 1/.test(line), line);
  eq(stopReasonsLine(foldStopReasons([])), 'no runs recorded', 'empty');
  eq(JSON.stringify(pass.events()), JSON.stringify(pass.events()), 'read-only: events untouched');
});

if (failures.length) { console.error(`history/run-record: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`history/run-record conformance: ${passed}/${passed} passed`);
