// compaction — keeping a long agent transcript under a token budget without
// losing the recent working context (pi's algorithm + omp's `shake`).
//
// Two moves, cheapest first:
//   1. shake (LLM-free): swap the bodies of OLD, bulky tool results for a
//      recoverable artifact reference. Costs nothing but a Map insert — in a
//      browser, where an extra model call is expensive, this is the first line of
//      defence. The full text is preserved in the returned `artifacts` map so the
//      model can re-read it on demand.
//   2. summarize (LLM, optional): only if shaking did not get under budget, fold
//      the older region into one summary system message via an injected async
//      summarize(olderMessages) -> string. No summarizer wired ⇒ the older region
//      is dropped (with a marker) rather than blocking.
//
// Hard rules (omp): never cut inside a turn — the kept region always begins at a
// user/assistant boundary, so an assistant tool-call turn is never separated from
// its tool results. Leading system messages are always preserved.
//
// Pure and headless: the token estimator is injected (defaults to the loop's
// ~4-chars/token proxy), so this is fully unit-testable with a scripted estimator.

import { estimateTokens } from './agent-loop.mjs';

// How many leading messages are the pinned system preamble (never compacted).
function systemPrefixLen(messages) {
  let n = 0;
  while (n < messages.length && messages[n]?.role === 'system') n++;
  return n;
}

// The cut index: walk back from the end accumulating tokens until we have kept
// ~keepRecentTokens, then snap earlier to a turn boundary (a user/assistant
// message, never a tool result) so no turn is split. Never crosses into the
// system prefix.
function findCut(messages, keepRecentTokens, estimate, sysEnd) {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= sysEnd; i--) {
    const t = estimate([messages[i]]);
    // Don't pull a message into the recent window if it would blow the budget —
    // a single huge old tool result belongs in the older (shakeable) region, not
    // protected as "recent". The acc>0 guard keeps the kept window non-empty.
    if (acc > 0 && acc + t > keepRecentTokens) break;
    acc += t;
    cut = i;
  }
  // Snap to a boundary: kept must start at a user/assistant message, not a tool
  // result (which would orphan it from its assistant tool-call turn).
  while (cut > sysEnd && messages[cut]?.role === 'tool') cut--;
  return cut;
}

// LLM-free reduction: replace the bodies of bulky tool results in `region` with a
// recoverable artifact reference. Returns { messages, artifacts, saved } where
// artifacts maps ref id -> original content. `protect` keeps the newest N tokens
// of the region untouched.
export function shake(region, { estimate = estimateTokens, minChars = 200, artifactPrefix = 'artifact://tool-' } = {}) {
  const artifacts = new Map();
  let saved = 0;
  let counter = 0;
  const out = region.map((m) => {
    if (m?.role === 'tool' && typeof m.content === 'string' && m.content.length >= minChars) {
      const id = `${artifactPrefix}${++counter}`;
      artifacts.set(id, m.content);
      saved += estimate([m]);
      const ref = `[tool output elided — ${m.content.length} chars saved to ${id}; read it with the read tool if needed]`;
      saved -= estimate([{ role: 'tool', content: ref }]);
      return { ...m, content: ref, _artifact: id };
    }
    return m;
  });
  return { messages: out, artifacts, saved };
}

// The top-level pass. Returns:
//   { messages, compacted, method, artifacts, droppedTokens }
// method ∈ 'none' | 'shake' | 'summarize' | 'drop'.
export async function compactConversation(messages, {
  threshold = 20_000,        // stay at/under this many estimated tokens
  keepRecentTokens = 8_000,  // protect at least this much recent context
  estimate = estimateTokens,
  summarize = null,          // optional async (olderMessages) => string
  shakeMinChars = 200,
} = {}) {
  const before = estimate(messages);
  if (before <= threshold) return { messages, compacted: false, method: 'none', artifacts: new Map(), droppedTokens: 0 };

  const sysEnd = systemPrefixLen(messages);
  const cut = findCut(messages, keepRecentTokens, estimate, sysEnd);
  const system = messages.slice(0, sysEnd);
  const older = messages.slice(sysEnd, cut);
  const kept = messages.slice(cut);
  if (!older.length) {
    // Everything recent is already within one turn / the budget can't shrink.
    return { messages, compacted: false, method: 'none', artifacts: new Map(), droppedTokens: 0 };
  }

  // 1. shake the older region.
  const shaken = shake(older, { estimate, minChars: shakeMinChars });
  let next = [...system, ...shaken.messages, ...kept];
  if (estimate(next) <= threshold) {
    return { messages: next, compacted: true, method: 'shake', artifacts: shaken.artifacts, droppedTokens: shaken.saved };
  }

  // 2. still over → summarize (or drop) the older region.
  const olderTokens = estimate(shaken.messages);
  if (typeof summarize === 'function') {
    let summary;
    try { summary = await summarize(older); }
    catch (e) { summary = `[compaction summary unavailable: ${String(e?.message || e)}]`; }
    const summaryMsg = { role: 'system', content: `Earlier context (compacted):\n${summary}` };
    next = [...system, summaryMsg, ...kept];
    return { messages: next, compacted: true, method: 'summarize', artifacts: shaken.artifacts, droppedTokens: olderTokens };
  }

  const marker = { role: 'system', content: `[${older.length} earlier messages (~${olderTokens} tokens) were dropped to stay under the context budget.]` };
  next = [...system, marker, ...kept];
  return { messages: next, compacted: true, method: 'drop', artifacts: shaken.artifacts, droppedTokens: olderTokens };
}
