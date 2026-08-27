// Rote — the harden loop (handoff §4). Anvil's `harden` mode drives this: author
// a deterministic .rote.js, run it via Rote, MINE the explore() traces into
// codified rules, TRIM with a reviewer, patch, and terminate on the machine-
// checked `rote check` — never on the agent's self-report (doctrine rule 5).
//
// This module owns the deterministic CONTROL FLOW only. The four fuzzy/effectful
// steps are injected primitives, so the loop is testable headless and, unchanged,
// wires to the live app: run = Rote's Worker runner, mine = a `dispatch`ed
// subagent over the run's overlay, trim = a `review` reviewer, apply = an Anvil
// edit + version bump, history = reading .rote/runs/<script>/*/run.json. Maker
// (harden) and runner (Rote) stay separate contexts (§4.1) because `run` is a
// call OUT, not an in-loop execution.

import { roteCheck, DEFAULT_FAIL_BUDGET } from './check.mjs';

export const HARDEN_MAX_PASSES = 6;

// The base tools harden mode exposes (mirrors MODE_TOOLS.harden); the app adds the
// `rote_*` tools on top. No shell, no free write (handoff §4.6).
export const HARDEN_TOOLS = Object.freeze(['read', 'edit', 'apply_patch', 'todowrite', 'dispatch', 'review']);

export const HARDEN_SYSTEM =
  'You are in HARDEN mode. Goal: turn a fuzzy automation into a deterministic ' +
  'script that needs the model only at the edges. Author or improve one .rote.js ' +
  'script, ask Rote to run it on the sample (never hand-run it yourself), then for ' +
  'each explore() call whose trace ended in a stable replayable action (a selector, ' +
  'a regex, a mapping) propose codifying it into the deterministic rule set and ' +
  'dropping the explore(); for each failure class propose the narrowest deterministic ' +
  'handler or a new explore() at exactly that edge. Never codify anything seen once, ' +
  'anything from a confused or looping trace, anything needing a secret, or a mutating ' +
  'registry call the person has not accepted. You are done only when `rote check` says ' +
  'so — do not declare it yourself.';

// What harden is allowed to codify (handoff §4.3 whitelist). A codification whose
// `kind` is not here, or that lacks the minimum observations, is rejected by the
// trim step regardless of what mining proposed.
export const CODIFY_WHITELIST = Object.freeze(['selector', 'regex', 'lookup', 'url-pattern', 'retry-param', 'classification']);
export const DEFAULT_MIN_OBS = 3;

// Is a proposed codification admissible by the §4.3 whitelist? Pure guard the
// trim step uses in addition to the reviewer's judgement.
export function admissibleCodification(c, { minObs = DEFAULT_MIN_OBS } = {}) {
  if (!c || typeof c !== 'object') return { ok: false, reason: 'not an object' };
  if (!CODIFY_WHITELIST.includes(c.kind)) return { ok: false, reason: `kind "${c.kind}" not in the codify whitelist` };
  if (c.needsSecret) return { ok: false, reason: 'derives from a secret' };
  if (c.fromLoopingTrace) return { ok: false, reason: 'derives from a confused/looping trace' };
  if (c.mutating && !c.personAccepted) return { ok: false, reason: 'mutating registry call not yet person-accepted' };
  if (c.kind === 'classification' && (c.observations || 0) < minObs) return { ok: false, reason: `only ${c.observations || 0} observations (< ${minObs})` };
  if ((c.observations || 0) < 1) return { ok: false, reason: 'seen zero times' };
  return { ok: true };
}

// Run harden passes until `rote check` terminates or the pass budget is spent.
// Primitives (all async):
//   run(script, sample)        -> runRecord {runId,...}
//   mine(runId, script)        -> { codifications:[], handlers:[] }   (dispatch)
//   trim(proposal, runId)      -> { accepted:[], rejected:[], reasons:[] }  (review)
//   apply(script, accepted)    -> { script, version }                  (Anvil edit + bump)
//   history(script)            -> runJson[]  (newest-first; feeds rote check)
//   trail(entry)               -> void       (HARDEN.md + .anvil/memory fact)
// Returns { outcome:'green'|'wall'|'budget', passes, decision, script }.
export async function runHarden({ script, sample, primitives, maxPasses = HARDEN_MAX_PASSES, failBudget = DEFAULT_FAIL_BUDGET }) {
  const p = primitives || {};
  for (const m of ['run', 'mine', 'trim', 'apply', 'history']) {
    if (typeof p[m] !== 'function') throw new Error(`runHarden needs a primitives.${m}() function`);
  }
  let cur = script;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const run = await p.run(cur, sample);
    const proposal = await p.mine(run.runId, cur);
    const trimmed = await p.trim(proposal, run.runId);
    // Defense in depth: even an accepted codification must pass the §4.3 whitelist.
    const accepted = (trimmed && Array.isArray(trimmed.accepted) ? trimmed.accepted : [])
      .filter((c) => admissibleCodification(c, { minObs: (script && script.hardenMinObs) || DEFAULT_MIN_OBS }).ok);
    const applied = await p.apply(cur, accepted);
    cur = applied && applied.script ? applied.script : cur;
    if (typeof p.trail === 'function') {
      await p.trail({ pass, runId: run.runId, run, accepted, rejected: (trimmed && trimmed.rejected) || [], reasons: (trimmed && trimmed.reasons) || [], version: applied && applied.version });
    }
    const decision = roteCheck(await p.history(cur), { failBudget });
    if (decision.exit === 0) return { outcome: 'green', passes: pass, decision, script: cur };
    if (decision.exit === 2) return { outcome: 'wall', passes: pass, decision, script: cur };
  }
  return { outcome: 'budget', passes: maxPasses, decision: null, script: cur };
}
