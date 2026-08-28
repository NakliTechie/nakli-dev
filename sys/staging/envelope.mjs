// Staging — one envelope, one reviewer (handoff P0.4). Every app already stages
// mutating calls (the Rig agent-face returns a proposalId); this standardizes the
// shape so a SINGLE reviewer component can render any app's diff, and codifies who
// may commit. This is the PURE half: the envelope, the diff-type registry, the
// normalizer seam the reviewer UI consumes, and the commit-authority decision. The
// DOM reviewer component and the live demo are parked (attended, /live-check-nt).

import { readCaveats } from '../identity/grant.mjs';

// A diff-type registry: each app declares its native diff format + a pure
// normalizer `(diff) -> {kind, ...}` that the one reviewer renders. Module-level
// so apps register at load; `clearRegistry` is for tests.
const REGISTRY = new Map(); // app -> { key, normalize }

export function registerDiffType(app, { key, normalize }) {
  if (!app || !key || typeof normalize !== 'function') throw new Error('registerDiffType needs { app, key, normalize() }');
  REGISTRY.set(app, { key, normalize });
  return true;
}
export function getDiffType(app) { return REGISTRY.get(app) || null; }
export function clearRegistry() { REGISTRY.clear(); }

export function newProposalId() { return 'prop_' + Math.random().toString(36).slice(2, 10); }

// Build a staging envelope for a mutating call. The app MUST have a registered
// diff type (its native format + the reviewer key), so a proposal is never
// un-renderable. `expires` is an absolute ms timestamp.
export function makeEnvelope({ app, tool, diff, expires, proposal_id = newProposalId() }) {
  const dt = REGISTRY.get(app);
  if (!dt) throw new Error(`no diff type registered for app "${app}" — cannot stage`);
  return { proposal_id, app, tool, diff, preview_renderer: dt.key, expires: expires ?? null };
}

// Normalize an envelope's diff into the reviewer-ready form via the app's
// registered normalizer — the pure seam the DOM reviewer sits on top of.
export function normalizeEnvelope(envelope) {
  const dt = REGISTRY.get(envelope.app);
  if (!dt) throw new Error(`no diff type for app "${envelope.app}"`);
  return dt.normalize(envelope.diff);
}

// The commit-authority decision (handoff §4: commit is person-only, OR grant-scoped
// auto-commit for REVERSIBLE ops only). `ctx` = { actor:'person'|'agent', tool,
// reversible, grant? }. Returns { allowed, mode:'person'|'auto'|'denied', reason }.
export function decideCommit(ctx = {}) {
  if (ctx.actor === 'person') return { allowed: true, mode: 'person', reason: 'person commit' };
  // An agent may commit only with a grant carrying auto-commit AND only a reversible
  // op. Attenuation only narrows, so EVERY auto-commit caveat in the chain must
  // permit the op (most-restrictive wins) — reading just the issuer's first caveat
  // would ignore a worker's tightening.
  const flags = ctx.grant ? readCaveats(ctx.grant, 'auto-commit') : [];
  if (!flags.length) return { allowed: false, mode: 'denied', reason: 'commit is person-only (no auto-commit grant)' };
  const allAny = flags.every((f) => f === 'any');
  const allReversibleOk = flags.every((f) => f === 'any' || f === 'reversible');
  if (allAny) return { allowed: true, mode: 'auto', reason: 'grant-scoped auto-commit (any)' };
  if (ctx.reversible === true && allReversibleOk) return { allowed: true, mode: 'auto', reason: 'grant-scoped auto-commit (reversible)' };
  return { allowed: false, mode: 'denied', reason: 'commit is person-only (op not covered by auto-commit caveats)' };
}

// Has the proposal expired? (`now` ms.)
export function isExpired(envelope, now) { return envelope.expires != null && Number(now) > envelope.expires; }
