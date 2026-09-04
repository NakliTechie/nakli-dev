// History — the run record (the log is the agent). An agent run is a fold over an
// append-only event chain; nothing about the run is stored that cannot be derived
// from it. This is the substrate under Anvil's task loop (and Forge's), and the
// first layer of plan/anvil-event-log-substrate.md.
//
// What today's scattered state becomes:
//   t.log     -> foldLog(events, resolve)         the UI rows are a projection
//   t.status  -> foldStatus(events, {gated})      "done" is derived, never set
//   t.convo   -> foldTranscript(events, resolve)  the carried transcript is a projection
//   replay    -> replayInfer / replayExecuteTool  the model is optional after the fact
//
// Two stores, one truth. The CHAIN (ledger.mjs) commits every event's input and
// output by HASH — tamper-evident, and it hoards nothing. The BLOBS map holds the
// payloads by that same hash, so a recorded model response or tool result can be
// served back on replay. `resolve(event)` joins them, exactly the seam ledger.mjs's
// replay() left open. Drop the blobs and the chain still verifies; drop the chain
// and the blobs are unattributed bytes.
//
// Fixed verbs, open nouns. RUN_EVENTS is frozen so tooling and tests key off it;
// tool names, args and payload shapes stay whatever the run produces.
//
// Recording is ORDER-PRESERVING and non-blocking to the loop: runAgentLoop calls
// onEvent synchronously, appendEvent hashes asynchronously, so appends ride one
// serial promise chain. Read the record only after `await settled()`.
//
// Pure over ledger.mjs. No storage, no DOM, no loop import — a caller records a
// run with any loop, and replays through any loop, by wrapping infer/executeTool.

import { appendEvent, contentHash, verifyChain, toNDJSON, fromNDJSON } from './ledger.mjs';

export const RUN_EVENTS = Object.freeze([
  'run.started',      // input: { messages, tools }            output: {}
  'turn.started',     // input: { step }                       output: {}
  'llm.requested',    // input: { request_hash, step }         output: {}
  'llm.responded',    // input: { request_hash, step }         output: { content, toolCalls, finishReason }
  'assistant.said',   // input: { step }                       output: { content }
  'tool.called',      // input: { id, name, args, step }       output: {}
  'tool.responded',   // input: { id, name, args_hash, step }  output: { result }
  'tool.failed',      // input: { id, name, step }             output: { error }
  'verify.passed',    // input: { step }                       output: { verdict }
  'verify.failed',    // input: { step, round, ran }           output: { verdict }
  'run.stopped',      // input: { steps }                      output: { stop, reason, verified, axis, error }
]);

// The loop's onEvent types this recorder understands. 'done' and the pre-stop
// signals (budget, no-progress, max-steps, aborted, error) are NOT recorded from
// the event stream — run.stopped is recorded once, from the loop's RETURN value,
// which is the only complete statement of how a run ended. A run whose record
// has no run.stopped died mid-flight; foldStatus reports it as still running,
// and the last event says where it died (Tardigrade's "derive unfinished work").
const LOOP_TO_VERB = Object.freeze({
  'turn-start': 'turn.started',
  'assistant': 'assistant.said',
  'tool-call': 'tool.called',
  'tool-result': 'tool.responded',
  'tool-error': 'tool.failed',
  'verify-pass': 'verify.passed',
  'verify-fail': 'verify.failed',
});

export class ReplayMiss extends Error {
  constructor(what, detail) { super(`replay miss: ${what}`); this.code = 'EREPLAYMISS'; this.detail = detail; }
}

// What the model was actually asked. Everything that determines the response and
// is visible to this layer — the host picks the model id, so it is included only
// when the caller labels it. Tool DEFINITIONS are in the hash: a run with a
// different toolset is a different run.
export async function requestHash({ messages, tools, model = null }) {
  return contentHash({ messages, tools: tools || [], model });
}

export function createRunRecorder({ app = 'anvil', principal = 'local', grant_id = null, now = () => Date.now() } = {}) {
  const events = [];
  const blobs = new Map();      // hash -> payload (input or output)
  const argsHashes = new Map(); // tool-call id -> args_hash (so tool.responded can be keyed for replay)
  let head = null;
  let queue = Promise.resolve();

  let step = null;              // the current turn, as the loop reports it
  async function append(tool, input, output) {
    const { event, head: h } = await appendEvent(head, { ts: now(), principal, door: 'call', tool, app, input, output, grant_id });
    head = h;
    events.push(event);
    blobs.set(event.input_hash, input);
    blobs.set(event.output_hash, output);
    return event;
  }
  // Serialise every append so the chain order is the order things happened. The
  // payload is a THUNK evaluated at append time, so an event can read what earlier
  // appends produced (a tool's args_hash) rather than a snapshot taken at enqueue.
  function enqueue(tool, thunk) {
    const p = queue.then(async () => { const { input, output } = await thunk(); return append(tool, input, output); });
    queue = p.catch(() => {}); // a failed append must not wedge the queue
    return p;
  }

  return {
    // ---- recording ----
    start({ messages, tools }) { return enqueue('run.started', () => ({ input: { messages, tools: tools || [] }, output: {} })); },

    // Pass as runAgentLoop's onEvent. Synchronous by contract; the append is queued.
    onEvent(e) {
      const verb = LOOP_TO_VERB[e?.type];
      if (!verb) return; // done / budget / no-progress / max-steps / aborted / error → run.stopped covers them
      if (e.type === 'turn-start') step = e.step ?? null;
      const s = e.step ?? step;
      switch (verb) {
        case 'turn.started': enqueue(verb, () => ({ input: { step: s }, output: {} })); break;
        case 'assistant.said': enqueue(verb, () => ({ input: { step: s }, output: { content: String(e.content ?? '') } })); break;
        case 'tool.called': {
          const args = e.args ?? {};
          enqueue(verb, async () => { argsHashes.set(e.id, await contentHash(args)); return { input: { id: e.id, name: e.name, args, step: s }, output: {} }; });
          break;
        }
        case 'tool.responded':
          enqueue(verb, () => ({ input: { id: e.id, name: e.name, args_hash: argsHashes.get(e.id) ?? null, step: s }, output: { result: String(e.result ?? '') } }));
          break;
        case 'tool.failed': enqueue(verb, () => ({ input: { id: e.id, name: e.name, step: s }, output: { error: String(e.error ?? '') } })); break;
        case 'verify.passed': enqueue(verb, () => ({ input: { step: s }, output: { verdict: e.verdict ?? null } })); break;
        case 'verify.failed': enqueue(verb, () => ({ input: { step: s, round: e.round ?? null, ran: e.ran ?? null }, output: { verdict: e.verdict ?? null } })); break;
      }
    },

    // Wrap the loop's infer so every model exchange is recorded, content-addressed.
    wrapInfer(infer, { model = null } = {}) {
      return async (args) => {
        const request_hash = await requestHash({ messages: args.messages, tools: args.tools, model });
        const s = step;
        await enqueue('llm.requested', () => ({ input: { request_hash, step: s }, output: {} }));
        const reply = await infer(args);
        const response = { content: reply?.content ?? '', toolCalls: reply?.toolCalls ?? [], finishReason: reply?.finishReason ?? 'stop' };
        await enqueue('llm.responded', () => ({ input: { request_hash, step: s }, output: response }));
        return reply;
      };
    },

    // Record how a loop ended, from its return value — the one complete statement.
    // Called once per loop; a task that re-runs the loop (Anvil's act-or-nudge)
    // records two run.stopped events, and foldStatus reads the LAST — honest, since
    // two loops ran.
    async finish(result) {
      await enqueue('run.stopped', () => ({ input: { steps: result?.steps ?? null }, output: {
        stop: result?.stop ?? 'unknown', reason: result?.reason ?? null,
        verified: result?.verified === true, axis: result?.budgetAxis ?? null,
        error: result?.error ?? null,
      } }));
    },

    // ---- the record ----
    async settled() { await queue; },
    events() { return events.slice(); },
    head() { return head; },
    blobs() { return new Map(blobs); },
    resolve(event) { return { input: blobs.get(event.input_hash), output: blobs.get(event.output_hash) }; },
    // Portable form: the chain as NDJSON, the payloads by hash. Drop `blobs` for a
    // hashes-only audit copy that still verifies.
    export() { return { events: toNDJSON(events), blobs: Object.fromEntries(blobs) }; },
  };
}

// Rehydrate an exported record into the same shape the recorder exposes for reading.
export function loadRecord({ events, blobs }) {
  const evs = typeof events === 'string' ? fromNDJSON(events) : events.slice();
  const map = blobs instanceof Map ? new Map(blobs) : new Map(Object.entries(blobs || {}));
  return {
    events: () => evs.slice(),
    blobs: () => new Map(map),
    resolve: (e) => ({ input: map.get(e.input_hash), output: map.get(e.output_hash) }),
    verify: () => verifyChain(evs),
  };
}

// ─────────────────────────────────────────────────────────────── folds ────

// Where the run stands. `gated` is whether a verify command was set — an UNGATED
// task_done returns verified:true from the loop (agent-loop.mjs:290-295), so
// "done" is derived from gate ∧ verified, never from verified alone. This is
// Anvil's 139c381 rule, now a pure function of the record.
export function foldStatus(events, resolve, { gated = false } = {}) {
  const stopEv = [...events].reverse().find((e) => e.tool === 'run.stopped');
  const steps = events.filter((e) => e.tool === 'turn.started').length;
  if (!stopEv) return { phase: 'running', status: 'running', stop: null, verified: false, steps };
  return { phase: 'stopped', steps, ...statusOf(resolve(stopEv)?.output || {}, gated) };
}
function statusOf(out, gated) {
  const stop = out.stop ?? 'unknown';
  const verified = out.verified === true;
  let status;
  if (stop === 'done') status = (gated && verified) ? 'done' : 'unclaimed';
  else if (stop === 'error' || stop === 'unverified') status = 'error';
  else status = 'idle';
  return { stop, verified, status, reason: out.reason ?? null, axis: out.axis ?? null, error: out.error ?? null };
}

// Join each chain event with its payloads. Folds below take the joined form.
export function joined(events, resolve) {
  return events.map((e) => { const r = resolve(e) || {}; return { ...e, input: r.input, output: r.output }; });
}

// Anvil's log pane rows, derived. Same shapes renderLog already draws.
export function foldLog(events, resolve) {
  const rows = [];
  const open = new Map(); // tool-call id -> row
  for (const e of joined(events, resolve)) {
    const inp = e.input || {}, out = e.output || {};
    switch (e.tool) {
      case 'run.started':
        for (const m of (inp.messages || [])) if (m.role === 'user') rows.push({ k: 'user', text: String(m.content ?? '') });
        break;
      case 'assistant.said': rows.push({ k: 'assistant', text: out.content ?? '' }); break;
      case 'tool.called': {
        const a = inp.args || {};
        const detail = a.command || a.path || a.file || a.old_string || (a.patch ? 'patch' : '') || '';
        const row = { k: 'tool', name: inp.name, detail: String(detail).split('\n')[0].slice(0, 120), result: null, error: null, args: a };
        open.set(inp.id, row); rows.push(row); break;
      }
      case 'tool.responded': {
        const row = open.get(inp.id);
        if (row) { row.result = String(out.result ?? '').slice(0, 8000); open.delete(inp.id); }
        else rows.push({ k: 'tool', name: inp.name || '(tool)', detail: '', result: String(out.result ?? '').slice(0, 8000), error: null });
        break;
      }
      case 'tool.failed': {
        const row = open.get(inp.id);
        if (row) { row.error = String(out.error ?? ''); open.delete(inp.id); }
        else rows.push({ k: 'tool', name: inp.name || '(tool)', detail: '(arguments rejected)', result: null, error: String(out.error ?? '') });
        break;
      }
      case 'verify.passed': rows.push({ k: 'system', text: '✓ gate passed — exit 0' }); break;
      case 'verify.failed': rows.push({ k: 'system', text: `✗ gate failed (round ${inp.round ?? 1}) — exit ${out.verdict?.exit ?? '?'}; agent retrying` }); break;
      case 'run.stopped': {
        const s = out.stop;
        const label = s === 'aborted' ? 'stopped' : s === 'budget' ? `hit budget (${out.axis || ''})` : s === 'unverified' ? 'gate never passed' : s === 'error' ? `error: ${out.error || ''}` : s;
        rows.push({ k: 'system', text: `agent ${label} · ${inp.steps ?? '?'} steps` });
        break;
      }
    }
  }
  return rows;
}

// The OpenAI-shaped transcript after the system prefix — what the next run is
// handed. Derived, so it can never drift from what happened: every tool reply is
// paired with the assistant turn that called it, by construction.
export function foldTranscript(events, resolve) {
  const out = [];
  let pendingCalls = null;
  const flushAssistant = () => {
    if (pendingCalls) { out.push({ role: 'assistant', content: null, tool_calls: pendingCalls }); pendingCalls = null; }
  };
  for (const e of joined(events, resolve)) {
    const inp = e.input || {}, o = e.output || {};
    switch (e.tool) {
      case 'run.started':
        for (const m of (inp.messages || [])) if (m.role !== 'system') out.push(m);
        break;
      case 'llm.responded': {
        flushAssistant();
        const calls = Array.isArray(o.toolCalls) ? o.toolCalls : [];
        if (calls.length) pendingCalls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } }));
        else if (o.content) out.push({ role: 'assistant', content: o.content });
        break;
      }
      case 'tool.responded': flushAssistant(); out.push({ role: 'tool', tool_call_id: inp.id, content: String(o.result ?? '') }); break;
      case 'tool.failed': flushAssistant(); out.push({ role: 'tool', tool_call_id: inp.id, content: `Error: ${o.error ?? ''}` }); break;
      case 'verify.failed': out.push({ role: 'user', content: `Gate failed (exit ${o.verdict?.exit ?? '?'}).\nFix the problem and continue.` }); break;
    }
  }
  // An assistant turn whose tool replies never arrived is malformed as the next
  // request's tail — the run died there. Drop it; the record still shows it.
  return out;
}

// ─────────────────────────────────────────────────────────────── replay ───

// An infer that serves recorded responses by request hash — zero model calls.
// strict: a request the record never saw is a divergence (throw ReplayMiss).
// permissive: fall through to `live` and let the new response land as new history.
export function replayInfer(record, { strict = true, live = null, model = null } = {}) {
  const responses = new Map(); // request_hash -> [response, ...] in order
  for (const e of joined(record.events(), record.resolve)) {
    if (e.tool !== 'llm.responded') continue;
    const h = e.input?.request_hash; if (!h) continue;
    if (!responses.has(h)) responses.set(h, []);
    responses.get(h).push(e.output);
  }
  const cursor = new Map();
  return async (args) => {
    const h = await requestHash({ messages: args.messages, tools: args.tools, model });
    const list = responses.get(h) || [];
    const i = cursor.get(h) || 0;
    if (i < list.length) { cursor.set(h, i + 1); return { ...list[i] }; }
    if (strict || typeof live !== 'function') throw new ReplayMiss('model request not in record', { request_hash: h });
    return live(args);
  };
}

// An executeTool that serves recorded results by (name, args) — no side effects.
export function replayExecuteTool(record, { strict = true, live = null } = {}) {
  const results = new Map(); // `${name}:${args_hash}` -> [result...]
  for (const e of joined(record.events(), record.resolve)) {
    if (e.tool !== 'tool.responded' || !e.input?.args_hash) continue;
    const k = `${e.input.name}:${e.input.args_hash}`;
    if (!results.has(k)) results.set(k, []);
    results.get(k).push(e.output?.result ?? '');
  }
  const cursor = new Map();
  return async (name, args, call) => {
    const k = `${name}:${await contentHash(args ?? {})}`;
    const list = results.get(k) || [];
    const i = cursor.get(k) || 0;
    if (i < list.length) { cursor.set(k, i + 1); return list[i]; }
    if (strict || typeof live !== 'function') throw new ReplayMiss('tool call not in record', { name, args });
    return live(name, args, call);
  };
}

// Compare two records event by event — verb, input hash, output hash. Timestamps
// and chain links are deliberately excluded: they differ by construction. Returns
// the FIRST divergence, which is the whole point ("a green strict replay is a
// proof that the run is reproducible", and a red one names the event).
export function compareRuns(recorded, live) {
  const a = recorded.events(), b = live.events();
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x.tool !== y.tool) return { ok: false, at: i, why: `verb ${x.tool} ≠ ${y.tool}` };
    if (x.input_hash !== y.input_hash) return { ok: false, at: i, why: `input of ${x.tool} differs` };
    if (x.output_hash !== y.output_hash) return { ok: false, at: i, why: `output of ${x.tool} differs` };
  }
  if (a.length !== b.length) return { ok: false, at: n, why: `length ${a.length} ≠ ${b.length}` };
  return { ok: true, at: -1, why: '' };
}
