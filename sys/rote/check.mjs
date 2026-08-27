// Rote — `rote check <script>`: the harden termination decision (handoff §4.4),
// a PURE function over recent run records. It is the verify-gate command Anvil's
// harden loop runs; the agent's self-report is never an input (§8, doctrine
// rule 5). Exit codes match the handoff:
//   0 (green) — done: either clean (no AI + failures within budget) or converged
//               (the last two runs stopped improving).
//   2 (wall)  — a dominant failure class is stuck across three consecutive runs;
//               harden emits a BLOCKER and a human is needed.
//   1         — keep iterating (still improving, or not enough data yet).
//
// Only `status:"complete"` runs are data points — a crashed/errored run is not a
// convergence signal. Runs are newest-first.

export const DEFAULT_FAIL_BUDGET = 0.02;

const total = (r) => (r.ok || 0) + (r.failed || 0);
function topClass(r) {
  let best = null, bc = -1;
  for (const [k, v] of Object.entries(r.failures || {})) if (v > bc) { bc = v; best = k; }
  return best;
}

export function roteCheck(runs, { failBudget = DEFAULT_FAIL_BUDGET } = {}) {
  const R = (runs || []).filter((r) => r && r.status === 'complete');
  if (R.length < 2) return { exit: 1, reason: `need at least 2 completed runs to judge (have ${R.length})` };
  const last = R[0], prev = R[1];
  const t = total(last);
  const rate = t ? (last.failed || 0) / t : 0;

  // Clean green: reason-once/run-many fully achieved — no explore() and failures
  // within the operator's budget. Judged on the latest run alone.
  if ((last.exploreCalls || 0) === 0 && rate <= failBudget) {
    return { exit: 0, reason: `clean — exploreCalls=0, fail rate ${(rate * 100).toFixed(2)}% ≤ ${(failBudget * 100).toFixed(2)}%` };
  }

  // Below here we distinguish a genuine plateau (converged → green) from a
  // dominant-class stall (wall → human). That distinction needs THREE runs, so
  // never green-on-plateau with only two — otherwise a script that is stuck from
  // the first pass would be accepted before the wall rule could ever fire. Gather
  // a third run first.
  if (R.length < 3) return { exit: 1, reason: `only ${R.length} runs — need a third to tell a plateau from a stall` };

  // Wall: a dominant failure class that has not decreased across three runs.
  // Checked before "converged" so a genuinely stuck problem escalates.
  const cls = topClass(last);
  if (cls) {
    const c0 = (last.failures || {})[cls] || 0;
    const c2 = (R[2].failures || {})[cls] || 0;
    if (c0 > 0 && c0 >= c2 && (last.failed || 0) >= (prev.failed || 0)) {
      return { exit: 2, reason: `wall — failure class "${cls}" not decreasing over 3 runs (${c2} → ${(prev.failures || {})[cls] || 0} → ${c0})`, failureClass: cls };
    }
  }

  // Converged green: neither metric decreased over the last two runs and it is
  // not walled — harden has extracted what it can (residual edges stay fuzzy).
  if ((last.exploreCalls || 0) >= (prev.exploreCalls || 0) && (last.failed || 0) >= (prev.failed || 0)) {
    return { exit: 0, reason: `converged — exploreCalls ${prev.exploreCalls}→${last.exploreCalls}, failed ${prev.failed}→${last.failed} (no further improvement)` };
  }

  // Still improving → keep iterating.
  return { exit: 1, reason: `improving — exploreCalls ${prev.exploreCalls}→${last.exploreCalls}, failed ${prev.failed}→${last.failed}` };
}
