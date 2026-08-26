// Agent loop — the pure orchestration that turns the inference tier into a
// coding agent (Forge C6 / LocalMind L0, the tool-using driver).
//
// The loop is deliberately I/O-free: the two things that touch the world —
// calling the model and running a tool — are injected. That keeps the control
// flow (send → tool_calls → execute → feed results → repeat) headlessly
// testable with mocks, exactly as an OpenCode/Codex loop is, before any live
// endpoint or terminal is wired.
//
//   const result = await runAgentLoop({
//     messages,                 // seed transcript (system + user)
//     tools: [shellTool()],     // OpenAI tool schemas
//     infer,                    // async ({messages, tools}) => { content, toolCalls, finishReason }
//     executeTool,              // async (name, args, rawCall) => string   (the tool result text)
//     maxSteps: 24,
//     onEvent,                  // optional (event) => void   progress taps
//   });
//   // result: { messages, steps, stop: 'done'|'max-steps'|'no-progress'|'error', text }

import { parseToolArguments } from './agent-protocol.mjs';

// The single most powerful tool for a coding agent: a real shell. The Forge
// shell already covers fileops, git, pipes, and globs, so one `shell` tool is a
// complete surface — the agent writes a command line, we run it, return output.
export function shellTool() {
  return {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a command in the workspace shell (bash-style: fileops, git, pipes, ' +
        'redirects, globs). Returns combined stdout/stderr as text. Destructive ' +
        'commands (rm, git commit) stage for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
        },
        required: ['command'],
      },
    },
  };
}

// The explicit-completion tool (Prime Agent's goal.complete()). The model calls
// it to assert the task is done; the loop's handler runs the verifier gate
// before accepting, and rejects with the gate's bounded output if it is red.
// Stronger than "the assistant stopped talking = done" — completion is an
// affirmative act the harness gets to veto.
export function taskDoneTool() {
  return {
    type: 'function',
    function: {
      name: 'task_done',
      description:
        'Call this when you believe the task is complete. The verification gate ' +
        'runs before this is accepted; if the gate is red you receive its output ' +
        'and must fix the problem and try again. Only a green gate ends the task.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'A one-line summary of what you did (optional).' },
        },
        required: [],
      },
    },
  };
}

// Rough token estimate (~4 chars/token) over a string or a message transcript.
// Deliberately cheap and dependency-free — the budget ladder and compaction only
// need a monotonic proxy, not a real tokenizer.
export function estimateTokens(input) {
  if (typeof input === 'string') return Math.ceil(input.length / 4);
  if (Array.isArray(input)) {
    let chars = 0;
    for (const m of input) {
      if (typeof m?.content === 'string') chars += m.content.length;
      if (Array.isArray(m?.tool_calls)) {
        for (const c of m.tool_calls) chars += (c.function?.arguments || '').length + (c.function?.name || '').length;
      }
    }
    return Math.ceil(chars / 4);
  }
  return 0;
}

// Bound a block of text to a line/byte cap for feeding back into the model — the
// same discipline as tool-output capping, applied to verifier gate output (Prime
// Agent: "a failed gate returns its bounded output to the agent"). Pure: no file
// spill (the loop has no workspace face), just a truncation marker.
export function boundedText(text, { maxLines = 200, maxBytes = 4000 } = {}) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  let capped = s;
  let truncated = false;
  if (lines.length > maxLines) { capped = lines.slice(0, maxLines).join('\n'); truncated = true; }
  if (capped.length > maxBytes) { capped = capped.slice(0, maxBytes); truncated = true; }
  return truncated ? capped + `\n… (output truncated: ${lines.length} lines / ${s.length} bytes)` : capped;
}

// A capped, model-facing rendering of a verifier verdict — the exact text fed
// back as the repair prompt / task_done rejection.
function gateFeedback(verdict, cap) {
  const exit = verdict?.exit ?? 1;
  const body = String(verdict?.stdout || '') + (verdict?.stderr ? (verdict?.stdout ? '\n' : '') + verdict.stderr : '');
  return `Verification failed (exit ${exit}). The task is NOT complete.` +
    (body ? '\n\n' + boundedText(body, cap) : '');
}

// omp's bash interceptors: shell idioms with a strictly-better structured tool
// are redirected instead of run, so the model reaches for read/write/edit/rg.
// Returns a hint string (the tool result) when a command should be intercepted,
// or null to run it normally. Conservative by design — only idioms the curated
// shell handles poorly or destructively-in-place are intercepted; plain reads
// (`cat file`) and simple redirects the shell supports are left alone.
export function interceptBashCommand(command) {
  const cmd = String(command == null ? '' : command).trim();
  if (!cmd) return null;
  // In-place stream editors → the edit tool (the shell's sed reads stdin only).
  if (/(^|\|)\s*sed\s+[^|]*-i\b/.test(cmd) || /(^|\|)\s*perl\s+[^|]*-i\b/.test(cmd) ||
      /(^|\|)\s*awk\s+[^|]*-i\s+inplace\b/.test(cmd)) {
    return 'Use the `edit` tool for in-place file edits instead of `sed -i`/`perl -i` — it is exact, reviewable, and cannot silently corrupt the file.';
  }
  // Recursive grep → the `rg` tool (the shell grep does not recurse directories).
  if (/(^|\|)\s*grep\s+[^|]*-(?:r|R|-recursive)\b/.test(cmd)) {
    return 'Use the `rg` tool (ripgrep) for recursive search — the shell `grep` reads named files/stdin only, not directory trees.';
  }
  // Writing a file via cat/heredoc redirection → the write tool.
  if (/(^|\|)\s*cat\s*(?:<<|>)/.test(cmd) || /(^|\|)\s*cat\s+[^|]*<</.test(cmd)) {
    return 'Use the `write` tool to create or overwrite a file instead of `cat >`/heredoc — it creates parent directories and is unambiguous.';
  }
  return null;
}

// Build the assistant turn to append to the transcript. Mirrors the OpenAI
// contract: content is null when the turn is purely tool calls.
function assistantTurn(content, toolCalls) {
  const turn = { role: 'assistant', content: content || (toolCalls?.length ? null : '') };
  if (toolCalls?.length) turn.tool_calls = toolCalls;
  return turn;
}

// Give a tool call a stable id so the paired tool result can reference it. Some
// endpoints omit ids on tool calls; synthesise a deterministic one from the step.
function callId(call, step, index) {
  return call.id || `call_${step}_${index}`;
}

// A signature of the tool calls in a step, to detect a stuck loop (the model
// repeating the identical call with no new information).
function stepSignature(toolCalls) {
  return (toolCalls || [])
    .map(c => `${c.function?.name}(${c.function?.arguments || ''})`)
    .join('|');
}

export async function runAgentLoop({
  messages,
  tools,
  infer,
  executeTool,
  maxSteps = 24,
  onEvent = () => {},
  verify = null,           // optional async () => { ok, exit, stdout, stderr } (a K3 verifier)
  maxVerifyRounds = 3,     // how many times a failing verdict is fed back before giving up
  workspaceHash = null,    // optional async () => string — gate memoization by workspace state
  budget = null,           // optional { turns, tokens, wallClockMs } — the completion budget ladder
  gateOutputCap = { maxLines: 200, maxBytes: 4000 }, // how much gate output is fed back
  now = () => Date.now(),  // injectable clock (wall-clock budget is testable headlessly)
  signal = null,           // optional AbortSignal — cooperative stop between turns/tools
}) {
  if (typeof infer !== 'function') throw new Error('runAgentLoop needs an infer function');
  if (typeof executeTool !== 'function') throw new Error('runAgentLoop needs an executeTool function');
  const convo = messages.slice();
  let lastText = '';
  let repeats = 0;
  let prevSignature = null;
  let verifyRounds = 0;
  const startedAt = now();

  // Cooperative stop: the caller aborts the signal (a Stop button). We check it
  // between turns, right after inference, and before each tool call, then return
  // stop:'aborted' with whatever conversation exists so far. An in-flight
  // inference/tool call is not force-killed — the loop stops at the next boundary.
  const aborted = () => !!(signal && signal.aborted);
  const abortReturn = (step) => { onEvent({ type: 'aborted', step }); return { messages: convo, steps: step, stop: 'aborted', text: lastText }; };

  // Gate memoization (Prime Agent): after a verifier failure, remember the
  // workspace hash and the failing verdict. If the next gate request arrives on
  // an identical hash, replay the cached failure instead of re-running the gate —
  // no burning gate runtime on an unchanged workspace. Returns { verdict, ran }.
  let memo = null; // { hash, verdict }
  async function runGate() {
    let hash = null;
    if (typeof workspaceHash === 'function') {
      try { hash = await workspaceHash(); } catch { hash = null; }
    }
    if (memo && hash != null && hash === memo.hash) {
      return { verdict: memo.verdict, ran: false };
    }
    let verdict;
    try { verdict = await verify(); }
    catch (e) { verdict = { ok: false, exit: 1, stderr: String(e?.message || e) }; }
    if (verdict && !verdict.ok && hash != null) memo = { hash, verdict };
    else if (verdict && verdict.ok) memo = null; // a pass invalidates any cached failure
    return { verdict, ran: true };
  }

  // The budget ladder: turns / tokens / wall-clock. Any tripped axis stops the
  // loop with stop:'budget' and names the axis. Checked at the top of each turn.
  function budgetTripped(step) {
    if (!budget) return null;
    if (Number.isFinite(budget.turns) && step >= budget.turns) return 'turns';
    if (Number.isFinite(budget.tokens) && estimateTokens(convo) > budget.tokens) return 'tokens';
    if (Number.isFinite(budget.wallClockMs) && now() - startedAt >= budget.wallClockMs) return 'wall-clock';
    return null;
  }

  for (let step = 0; step < maxSteps; step++) {
    if (aborted()) return abortReturn(step);
    const axis = budgetTripped(step);
    if (axis) {
      onEvent({ type: 'budget', axis, step });
      onEvent({ type: 'done', reason: 'budget', axis, step });
      return { messages: convo, steps: step, stop: 'budget', budgetAxis: axis, text: lastText };
    }
    let reply;
    try {
      reply = await infer({ messages: convo, tools });
    } catch (e) {
      onEvent({ type: 'error', error: String(e?.message || e), step });
      return { messages: convo, steps: step, stop: 'error', text: lastText, error: String(e?.message || e) };
    }

    if (aborted()) return abortReturn(step);
    const content = typeof reply?.content === 'string' ? reply.content : '';
    const toolCalls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
    if (content) { lastText = content; onEvent({ type: 'assistant', content, step }); }

    // No tool calls → the model believes it is done. If a verifier is wired, the
    // model does NOT get to declare done — the verifier does. A failing verdict is
    // fed back so the model fixes it; only a passing verdict (exit 0) completes.
    if (!toolCalls.length) {
      convo.push(assistantTurn(content, null));
      if (verify) {
        const { verdict, ran } = await runGate();
        if (verdict && verdict.ok) {
          onEvent({ type: 'verify-pass', verdict, step });
          onEvent({ type: 'done', reason: 'verified', step });
          return { messages: convo, steps: step + 1, stop: 'done', verified: true, text: lastText };
        }
        verifyRounds++;
        onEvent({ type: 'verify-fail', verdict, round: verifyRounds, ran, step });
        if (verifyRounds >= maxVerifyRounds) {
          onEvent({ type: 'done', reason: 'unverified', step });
          return { messages: convo, steps: step + 1, stop: 'unverified', verified: false, text: lastText, verdict };
        }
        convo.push({ role: 'user', content:
          gateFeedback(verdict, gateOutputCap) + '\nFix the problem and continue.' });
        continue;
      }
      onEvent({ type: 'done', reason: reply?.finishReason || 'stop', step });
      return { messages: convo, steps: step + 1, stop: 'done', text: lastText };
    }

    // No-progress guard: the identical tool-call set two steps running means the
    // model is stuck — stop rather than burn the budget.
    const signature = stepSignature(toolCalls);
    repeats = signature === prevSignature ? repeats + 1 : 0;
    prevSignature = signature;
    if (repeats >= 2) {
      convo.push(assistantTurn(content, toolCalls));
      onEvent({ type: 'no-progress', step, signature });
      return { messages: convo, steps: step + 1, stop: 'no-progress', text: lastText };
    }

    convo.push(assistantTurn(content, toolCalls));

    // Execute each tool call and feed the result back as a tool message. A
    // `task_done` call is intercepted here (not passed to executeTool): the loop
    // owns completion, so it runs the gate and either accepts or rejects.
    let gateGreen = false;
    for (let i = 0; i < toolCalls.length; i++) {
      if (aborted()) return abortReturn(step + 1);
      const call = toolCalls[i];
      const id = callId(call, step, i);
      const name = call.function?.name || '';

      if (name === 'task_done') {
        if (!verify) { // no gate wired → the explicit signal is accepted as-is
          onEvent({ type: 'tool-result', name, id, result: 'accepted', step });
          convo.push({ role: 'tool', tool_call_id: id, content: 'Task accepted (no verification gate configured).' });
          gateGreen = true;
          continue;
        }
        const { verdict, ran } = await runGate();
        if (verdict && verdict.ok) {
          onEvent({ type: 'verify-pass', verdict, step });
          convo.push({ role: 'tool', tool_call_id: id, content: 'Verification passed. Task complete.' });
          gateGreen = true;
        } else {
          verifyRounds++;
          onEvent({ type: 'verify-fail', verdict, round: verifyRounds, ran, step });
          convo.push({ role: 'tool', tool_call_id: id, content: gateFeedback(verdict, gateOutputCap) });
          if (verifyRounds >= maxVerifyRounds) {
            onEvent({ type: 'done', reason: 'unverified', step });
            return { messages: convo, steps: step + 1, stop: 'unverified', verified: false, text: lastText, verdict };
          }
        }
        continue;
      }

      const parsed = parseToolArguments(call);
      let resultText;
      if (!parsed.ok) {
        resultText = `Error: could not parse arguments as JSON: ${parsed.error}`;
        onEvent({ type: 'tool-error', name, id, error: parsed.error, step });
      } else {
        onEvent({ type: 'tool-call', name, id, args: parsed.value, step });
        try {
          resultText = await executeTool(name, parsed.value, call);
        } catch (e) {
          resultText = `Error: ${String(e?.message || e)}`;
          onEvent({ type: 'tool-error', name, id, error: String(e?.message || e), step });
        }
        onEvent({ type: 'tool-result', name, id, result: resultText, step });
      }
      convo.push({ role: 'tool', tool_call_id: id, content: String(resultText ?? '') });
    }

    if (gateGreen) {
      onEvent({ type: 'done', reason: 'verified', step });
      return { messages: convo, steps: step + 1, stop: 'done', verified: true, text: lastText };
    }
  }

  onEvent({ type: 'max-steps', steps: maxSteps });
  return { messages: convo, steps: maxSteps, stop: 'max-steps', text: lastText };
}

// Bind the shell tool to a Forge shell instance: returns an executeTool(name,args)
// that runs `args.command` through the shell and returns its output. Unknown tool
// names return an error string (the model learns from it) rather than throwing.
export function makeShellExecutor(shell) {
  return async function executeTool(name, args) {
    if (name !== 'shell') return `Error: unknown tool "${name}"`;
    const command = typeof args?.command === 'string' ? args.command : '';
    if (!command.trim()) return 'Error: shell tool requires a non-empty command';
    const hint = interceptBashCommand(command);
    if (hint) return hint; // omp interceptor: redirect to a structured tool, don't run
    const res = await shell.feed(command);
    const out = res?.output ?? '';
    return out === '' ? '(no output)' : String(out);
  };
}
