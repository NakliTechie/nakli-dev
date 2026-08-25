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
}) {
  if (typeof infer !== 'function') throw new Error('runAgentLoop needs an infer function');
  if (typeof executeTool !== 'function') throw new Error('runAgentLoop needs an executeTool function');
  const convo = messages.slice();
  let lastText = '';
  let repeats = 0;
  let prevSignature = null;
  let verifyRounds = 0;

  for (let step = 0; step < maxSteps; step++) {
    let reply;
    try {
      reply = await infer({ messages: convo, tools });
    } catch (e) {
      onEvent({ type: 'error', error: String(e?.message || e), step });
      return { messages: convo, steps: step, stop: 'error', text: lastText, error: String(e?.message || e) };
    }

    const content = typeof reply?.content === 'string' ? reply.content : '';
    const toolCalls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
    if (content) { lastText = content; onEvent({ type: 'assistant', content, step }); }

    // No tool calls → the model believes it is done. If a verifier is wired, the
    // model does NOT get to declare done — the verifier does. A failing verdict is
    // fed back so the model fixes it; only a passing verdict (exit 0) completes.
    if (!toolCalls.length) {
      convo.push(assistantTurn(content, null));
      if (verify) {
        let verdict;
        try { verdict = await verify(); }
        catch (e) { verdict = { ok: false, exit: 1, stderr: String(e?.message || e) }; }
        if (verdict && verdict.ok) {
          onEvent({ type: 'verify-pass', verdict, step });
          onEvent({ type: 'done', reason: 'verified', step });
          return { messages: convo, steps: step + 1, stop: 'done', verified: true, text: lastText };
        }
        verifyRounds++;
        onEvent({ type: 'verify-fail', verdict, round: verifyRounds, step });
        if (verifyRounds >= maxVerifyRounds) {
          onEvent({ type: 'done', reason: 'unverified', step });
          return { messages: convo, steps: step + 1, stop: 'unverified', verified: false, text: lastText, verdict };
        }
        const detail = String(verdict?.stderr || verdict?.stdout || '').slice(0, 1000);
        convo.push({ role: 'user', content:
          `Verification failed (exit ${verdict?.exit ?? 1}). The task is NOT complete. ` +
          `Fix the problem and continue.${detail ? '\n\n' + detail : ''}` });
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

    // Execute each tool call and feed the result back as a tool message.
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const id = callId(call, step, i);
      const name = call.function?.name || '';
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
    const res = await shell.feed(command);
    const out = res?.output ?? '';
    return out === '' ? '(no output)' : String(out);
  };
}
