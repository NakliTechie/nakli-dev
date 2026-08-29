// Assay Run-Mode loop — the campaign outer loop (Menagerie §5) as a PURE REDUCER
// over the History ledger, not a Restate workflow.
//
// The whole durability argument in one function: campaign state is `f(ledger)`.
// `nextStep(ledger)` reads the blocks appended so far and returns the single next
// action (whose role, what action, which round) — or an exit. Nothing is stored
// outside the ledger, so PARK/RESUME is free: kill the driver at any point, and on
// restart `nextStep` over the persisted ledger returns exactly where it left off.
// That is the durable-step guarantee Restate sells, obtained from a replayable log
// we already own (sys/history) — no standing workflow engine, sovereign.
//
// Anvil is the driver: it calls nextStep, runs the named role (as a role-manifest
// subagent), lets that role append its block through the Grant wall, and loops. It
// commandeers Menagerie only to DISPLAY a leg — never to decide one.
//
// Round model: candidate c0 = round 0 (bootstrap). For round k: a MEASURE of
// candidate k (assay.measure + assay.finding.v1 at round k) → a DIRECTIVE at round k
// → candidate k+1. So k = the highest candidate round, and the phase within round k
// is decided by which of {measure, directive} has been appended.

const DEFAULTS = Object.freeze({ ship_bar: 0.85, epsilon: 0.01, weight_floor: 0, same_directive_cap: 3 });

function byRound(blocks) { return blocks.slice().sort((a, b) => (a.round ?? 0) - (b.round ?? 0)); }
function atRound(blocks, r) { return blocks.filter((b) => (b.round ?? 0) === r); }
function directiveSig(d) { return JSON.stringify((d.items || []).map((i) => [i.area, i.instruction])); }

// Ship: pass-mass ≥ bar, the last two measured rounds moved < ε, and no open finding
// above the weight floor. Needs ≥2 measurements to see movement.
export function shipReady(measures, findingsAtLast, cfg) {
  const m = byRound(measures);
  if (m.length < 2) return false;
  const last = m[m.length - 1], prev = m[m.length - 2];
  const moved = Math.abs(Number(last.pass_mass) - Number(prev.pass_mass));
  const openFinding = (findingsAtLast || []).some((f) => (f.clusters || []).some((c) => Number(c.weight) > cfg.weight_floor));
  return Number(last.pass_mass) >= cfg.ship_bar && moved < cfg.epsilon && !openFinding;
}

// No-discrimination: the last two rounds' finding sets are identical (same cluster
// ids and mass). The instrument stopped revealing differences → must expand, and
// (§6) cannot ship on a flat instrument.
export function noDiscrimination(findings) {
  const rounds = [...new Set(findings.map((f) => f.round ?? 0))].sort((a, b) => a - b);
  if (rounds.length < 2) return false;
  const sig = (r) => JSON.stringify(atRound(findings, r).flatMap((f) => (f.clusters || []).map((c) => [String(c.id), Number(c.pass_mass_delta ?? c.weight ?? 0)])).sort());
  return sig(rounds[rounds.length - 1]) === sig(rounds[rounds.length - 2]);
}

// No-progress: the same directive issued `cap` times with no pass-mass movement.
export function noProgress(directives, measures, cfg) {
  const d = byRound(directives);
  if (d.length < cfg.same_directive_cap) return false;
  const tail = d.slice(-cfg.same_directive_cap);
  const sameDir = tail.every((x) => directiveSig(x) === directiveSig(tail[0]));
  const m = byRound(measures);
  if (m.length < 2) return false;
  const refIdx = Math.max(0, m.length - cfg.same_directive_cap);
  const flat = Math.abs(Number(m[m.length - 1].pass_mass) - Number(m[refIdx].pass_mass)) < cfg.epsilon;
  return sameDir && flat;
}

// The reducer. Returns { phase, round?, next?: {actor, action, round?}, exit? }.
// `next.actor` is a role name (owner/assayer/implementer/foreman); the driver maps it
// to that role's manifest + grant set. Exits: 'ship' | 'no-discrimination' | 'no-progress'.
export function nextStep(ledger, { campaign, config = {}, budgetHit = false } = {}) {
  const campaigns = ledger.ofType('assay.campaign', campaign);
  if (!campaigns.length) return { phase: 'unstarted', next: { actor: 'owner', action: 'campaign.start' } };
  const cfg = { ...DEFAULTS, ship_bar: Number(campaigns[campaigns.length - 1].ship_bar) || DEFAULTS.ship_bar, ...config };

  if (!ledger.ofType('assay.instrument.v1', campaign).length) {
    return { phase: 'instrument', next: { actor: 'assayer', action: 'build-instrument', round: 0 } };
  }
  const candidates = ledger.ofType('assay.candidate', campaign);
  if (!candidates.length) {
    return { phase: 'bootstrap-candidate', round: 0, next: { actor: 'implementer', action: 'build-candidate', round: 0 } };
  }

  const k = Math.max(...candidates.map((c) => Number(c.round) || 0));
  const measures = ledger.ofType('assay.measure', campaign);
  const findings = ledger.ofType('assay.finding.v1', campaign);
  const directives = ledger.ofType('assay.directive.v1', campaign);

  // Budget cap always parks first (§6 no-progress/budget branch).
  if (budgetHit) return { phase: 'exit', round: k, exit: 'no-progress', next: { actor: 'foreman', action: 'park', round: k } };

  // Measure candidate k, if not yet measured.
  if (!atRound(measures, k).length) {
    return { phase: 'measure', round: k, next: { actor: 'assayer', action: 'measure', round: k } };
  }

  // Fresh measurement in hand → test the exits, best outcome first.
  if (shipReady(measures, atRound(findings, k), cfg)) {
    return { phase: 'exit', round: k, exit: 'ship', next: { actor: 'foreman', action: 'propose-ship', round: k } };
  }
  if (noDiscrimination(findings)) {
    return { phase: 'expand', round: k, next: { actor: 'foreman', action: 'request-expansion', round: k } };
  }
  if (noProgress(directives, measures, cfg)) {
    return { phase: 'exit', round: k, exit: 'no-progress', next: { actor: 'foreman', action: 'park', round: k } };
  }

  // Continue: adjudicate this round into a directive, then build the next candidate.
  if (!atRound(directives, k).length) {
    return { phase: 'adjudicate', round: k, next: { actor: 'foreman', action: 'adjudicate', round: k } };
  }
  return { phase: 'implement', round: k, next: { actor: 'implementer', action: 'build-candidate', round: k + 1 } };
}
