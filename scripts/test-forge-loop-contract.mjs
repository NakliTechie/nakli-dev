// Guards Forge against the agent-loop contract.
//
// b7e5a16 changed a SHARED seam in sys/ai/agent-loop.mjs: `infer` now receives a
// `signal`, and a new `turn-start` event is emitted before every model turn.
// Anvil was updated for both. Forge consumes the same loop, passes its own
// `infer`, and has no test in this repo — so the change was `inferred` safe, not
// verified. This runs Forge's REAL handlers, lifted out of apps/forge/index.html,
// against the REAL runAgentLoop.
//
// Two things must hold:
//   1. Forge's inferViaHost survives being handed an extra `signal` field.
//   2. Forge's onEvent survives an event type it has never seen.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAgentLoop } from '../sys/ai/agent-loop.mjs';

const forge = await readFile(new URL('../apps/forge/index.html', import.meta.url), 'utf8');

// ── 1. infer: Forge destructures only { messages, tools } ────────────────
const inferSrc = forge.slice(forge.indexOf('async function inferViaHost({'), forge.indexOf('async function inferViaHost({') + 200);
assert.match(inferSrc, /async function inferViaHost\(\{ messages, tools \}\)/,
  'Forge still destructures only messages + tools (extra fields are ignored, not an error)');

// ── 2. onEvent: lift Forge's real handler and drive it ───────────────────
const evStart = forge.indexOf('onEvent: (e) => {');
const evEnd = forge.indexOf('},\n      });', evStart);
assert.ok(evStart > 0 && evEnd > evStart, "Forge's onEvent handler found");
const handlerBody = forge.slice(evStart + 'onEvent: (e) => {'.length, evEnd);

const written = [];
const term = { write: (s) => written.push(String(s)) };
const noop = (s) => String(s == null ? '' : s);
// Forge's handler closes over these terminal constants; supply them verbatim.
const forgeOnEvent = new Function('term', 'DIM', 'RESET', 'RED', 'ACCENT', 'toCRLF',
  `return (e) => {${handlerBody}};`)(term, '', '', '', '', noop);

// The new event must be inert here: Forge's chain has no else branch, so an
// unknown type falls through and does nothing. Prove it rather than assume it.
assert.doesNotThrow(() => forgeOnEvent({ type: 'turn-start', step: 0 }),
  "Forge's onEvent tolerates the new turn-start event");
assert.equal(written.length, 0, 'turn-start writes nothing to the Forge terminal (inert, as expected)');

// ── 3. drive the real loop with Forge's real handlers ────────────────────
let sawSignalField = false;
const scripted = [
  { content: '', toolCalls: [{ id: 'c0', type: 'function', function: { name: 'shell', arguments: '{"command":"echo hi"}' } }] },
  { content: 'finished.', toolCalls: [] },
];
let turn = 0;
const forgeStyleInfer = async ({ messages, tools }) => {
  // Forge names only these two. If the loop passed something positionally or
  // required the callee to accept `signal`, this would break.
  assert.ok(Array.isArray(messages) && Array.isArray(tools), 'Forge-shaped infer got its two fields');
  return scripted[turn++] || { content: 'done', toolCalls: [] };
};
// Separately confirm the loop really is sending a signal field (so the guard is
// meaningful and this test cannot silently pass on a loop that stopped sending it).
const probingInfer = async (args) => { sawSignalField = 'signal' in args; return { content: 'ok', toolCalls: [] }; };

const result = await runAgentLoop({
  messages: [{ role: 'system', content: 'forge' }, { role: 'user', content: 'say hi' }],
  tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
  infer: forgeStyleInfer,
  executeTool: async () => 'hi',
  onEvent: forgeOnEvent,
  maxSteps: 6,
});
assert.equal(result.stop, 'done', `a Forge-shaped run still completes (got ${result.stop})`);
assert.ok(written.some(s => /hi/.test(s)), 'Forge still renders tool output to its terminal');

await runAgentLoop({
  messages: [{ role: 'user', content: 'probe' }],
  tools: [], infer: probingInfer, executeTool: async () => '', maxSteps: 1,
});
assert.equal(sawSignalField, true,
  'the loop does pass `signal` to infer — so tolerating it is a real property, not a vacuous pass');

console.log('forge-loop-contract: Forge survives the signal param and the turn-start event');
