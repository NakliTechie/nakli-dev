// The fixed task set for the ablation harness — three scripted tasks whose scripted
// "model" reacts to the capabilities under test, so the deltas are real and the whole
// matrix runs headlessly: no host, no Ollama, no network. Shared by the conformance
// test and scripts/ablate.mjs.
//
// Capabilities:
//   gate   — a verify command exists (the loop feeds a failing verdict back)
//   memory — the project-memory index is injected into the system prompt
//   retry  — a failing gate is fed back up to 3 times (off: once, then give up)
import { shellTool, makeShellExecutor } from '../agent-loop.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';

export const CAPABILITIES = ['gate', 'memory', 'retry'];

function freshShell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return createShell({ registry, face });
}
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const SYSTEM = 'You are a coding agent with a shell.';
const MEMORY_FACT = 'Project memory: the linter expects the header line "# attest" at the top of RUN.md.';

// T1 — attest-lint style: write RUN.md, the gate checks its header. The scripted
// model writes it wrong first; on a fed-back failure it fixes it. Without a gate the
// wrong file stands (unclaimed); with memory it writes it right the first time.
function attestLint() {
  return {
    id: 'attest-lint',
    messages: (caps) => [{ role: 'system', content: SYSTEM + (caps.memory ? '\n' + MEMORY_FACT : '') }, { role: 'user', content: 'Create RUN.md for the attest linter.' }],
    tools: () => [shellTool()],
    model: (caps) => {
      // Scripted by CALL COUNT, never by parsing the loop's wording: odd calls act,
      // even calls say done. Call 1 writes it wrong unless memory says how; call 3
      // (only reached when a failed gate was fed back) writes it right.
      let i = 0;
      return async ({ messages }) => {
        i++;
        const knows = messages[0] && /# attest/.test(String(messages[0].content));
        if (i === 1) return { content: '', toolCalls: [call('shell', { command: knows ? 'printf "# attest\\nlint\\n" > RUN.md' : 'printf "lint\\n" > RUN.md' }, 'c1')] };
        if (i === 3) return { content: '', toolCalls: [call('shell', { command: 'printf "# attest\\nlint\\n" > RUN.md' }, 'c3')] };
        return { content: 'Done — RUN.md written.', toolCalls: [] };
      };
    },
    executeTool: (_caps, ctx) => makeShellExecutor(ctx.shell = freshShell()),
    gate: (caps, ctx) => caps.gate ? async () => { const out = (await ctx.shell.feed('cat RUN.md')).output || ''; const ok = /^# attest/.test(out); return { ok, exit: ok ? 0 : 1, stdout: out, stderr: ok ? '' : 'missing "# attest" header' }; } : null,
    loopOptions: (caps) => ({ maxVerifyRounds: caps.retry ? 3 : 1 }),
  };
}

// T2 — memory saves exploration: with the fact injected the model goes straight to
// the answer (2 steps); without it, it explores first (4 steps). The gate is trivial.
function memoryShortcut() {
  return {
    id: 'memory-shortcut',
    messages: (caps) => [{ role: 'system', content: SYSTEM + (caps.memory ? '\nProject memory: the config lives at cfg/app.json.' : '') }, { role: 'user', content: 'Set the port in the config to 8080.' }],
    tools: () => [shellTool()],
    model: () => {
      let i = 0;
      return async ({ messages }) => {
        i++;
        const knows = /cfg\/app\.json/.test(String(messages[0]?.content || ''));
        const plan = knows
          ? ['mkdir -p cfg && echo "{\\"port\\":8080}" > cfg/app.json']
          : ['ls', 'find . -name "*.json"', 'mkdir -p cfg && echo "{\\"port\\":8080}" > cfg/app.json'];
        if (i <= plan.length) return { content: '', toolCalls: [call('shell', { command: plan[i - 1] }, 'c' + i)] };
        return { content: 'Done.', toolCalls: [] };
      };
    },
    executeTool: (_caps, ctx) => makeShellExecutor(ctx.shell = freshShell()),
    gate: (caps, ctx) => caps.gate ? async () => { const out = (await ctx.shell.feed('cat cfg/app.json')).output || ''; const ok = /8080/.test(out); return { ok, exit: ok ? 0 : 1, stdout: out, stderr: '' }; } : null,
    loopOptions: (caps) => ({ maxVerifyRounds: caps.retry ? 3 : 1 }),
  };
}

// T3 — retry matters: the gate fails twice before the model's third attempt passes.
// retry off (one round) → unverified; retry on → success. Memory changes nothing here.
function flakyFix() {
  return {
    id: 'flaky-fix',
    messages: () => [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Make build.sh exit 0.' }],
    tools: () => [shellTool()],
    model: () => {
      // By call count: calls 1, 3, 5 are attempts 1, 2, 3 (the third is good); even
      // calls say done. Attempt 2 and 3 are reached only when the gate feeds back.
      let i = 0;
      return async () => {
        i++;
        if (i % 2 === 1) { const attempt = (i + 1) / 2; const good = attempt >= 3; return { content: '', toolCalls: [call('shell', { command: `printf "exit ${good ? 0 : 1}\\n" > build.sh` }, 'a' + attempt)] }; }
        return { content: 'Done.', toolCalls: [] };
      };
    },
    executeTool: (_caps, ctx) => makeShellExecutor(ctx.shell = freshShell()),
    gate: (caps, ctx) => caps.gate ? async () => { const out = (await ctx.shell.feed('cat build.sh')).output || ''; const ok = /exit 0/.test(out); return { ok, exit: ok ? 0 : 1, stdout: out, stderr: '' }; } : null,
    loopOptions: (caps) => ({ maxVerifyRounds: caps.retry ? 3 : 1 }),
  };
}

// One fresh workspace per (task, arm): executeTool makes the shell and parks it on the
// arm's own ctx; the gate reads it from there. No module state, so concurrent matrices
// or duplicate task ids cannot cross-wire a gate to another arm's shell.

export function fixtureTasks() { return [attestLint(), memoryShortcut(), flakyFix()]; }
