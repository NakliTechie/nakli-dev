// The host's review queue — the pure reducer under the P0 reviewer (Chunk 2, plan/
// chunk2-p0-into-apps-spec.md §5). The app ships a NATIVE diff over the bridge; the host
// enqueues it as an envelope, renders it with the one reviewer, and applies it only when a
// person (or a grant-scoped agent) commits. This module is that queue, with no DOM, no
// postMessage, no fs, and no global clock (an injected `now`) — so it is node-testable, and the
// browser wiring (naklios.review + renderReviewQueue) sits on top of it unchanged.
//
// It composes the shipped, tested primitives (envelope.mjs) and does not reimplement authority:
// decideCommit is the one commit rule (person always; agent only with an auto-commit grant
// caveat; reversible ops unless the caveat is 'any'; expiry outranks authority). A discarded
// proposal is poisoned (proposal-fingerprint.mjs) so the same mutation is not re-proposed.
//
// Two deliberate shape choices, documented:
//   - stage() is SYNCHRONOUS and never consults the ledger. Poison-checking needs an async
//     fingerprint, so it is a separate `isPoisoned(stageArgs)` the caller awaits BEFORE staging.
//     stage does not silently drop — dropping is the caller's decision, made visible.
//   - stage() of an app with no registered diff type returns { error } (makeEnvelope throws);
//     it never throws out of the reducer.

import { makeEnvelope, normalizeEnvelope, decideCommit, isExpired } from './envelope.mjs';
import { fingerprint, isPoisoned as ledgerPoisoned } from '../ai/proposal-fingerprint.mjs';

// A stable, key-order-independent string for a diff — so the same diff fingerprints identically.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
// The fingerprint inputs for a staged mutation (reuses the C3 {goal, steps, paths} shape): the
// app+tool identity, the whole diff as one canonical step, and any file paths the diff names.
function fpInputs({ app, tool, diff }) {
  const paths = [];
  const scan = (o) => { if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { if ((k === 'path' || k === 'file') && typeof o[k] === 'string') paths.push(o[k]); const v = o[k]; if (v && typeof v === 'object') scan(v); } };
  scan(diff);
  return { goal: `${app}:${tool}`, steps: [stable(diff)], paths: [...new Set(paths)] };
}

export function createReviewQueue({ now = () => Date.now(), ledger = null, onApply = null, onReject = null } = {}) {
  const pending = new Map(); // proposal_id -> { envelope, reversible }

  return {
    // Stage a native diff for review. Returns { proposal_id } or { error } (unregistered app).
    // Does NOT apply. Does NOT consult the ledger — the caller checks isPoisoned first.
    stage({ app, tool, diff, expires = null, reversible = false } = {}) {
      let envelope;
      try { envelope = makeEnvelope({ app, tool, diff, expires }); }
      catch (e) { return { error: String(e && e.message || e) }; }
      pending.set(envelope.proposal_id, { envelope, reversible: !!reversible });
      return { proposal_id: envelope.proposal_id };
    },

    // The pending proposals, each with its normalized preview (so a reviewer renders without
    // re-normalizing). Newest last (insertion order).
    list() {
      return [...pending.values()].map(({ envelope, reversible }) => ({
        proposal_id: envelope.proposal_id, app: envelope.app, tool: envelope.tool,
        renderer: envelope.preview_renderer, expires: envelope.expires, reversible,
        preview: normalizeEnvelope(envelope),
      }));
    },

    // Commit a proposal. Expiry outranks authority. On allowed: dequeue, onApply(envelope) once.
    commit(proposal_id, ctx = {}) {
      const entry = pending.get(proposal_id);
      if (!entry) return { ok: false, reason: 'no such proposal' };
      const t = now();
      if (isExpired(entry.envelope, t)) return { ok: false, reason: 'expired' };
      const decision = decideCommit({ actor: ctx.actor, tool: entry.envelope.tool, reversible: ctx.reversible ?? entry.reversible, grant: ctx.grant });
      if (!decision.allowed) return { ok: false, reason: decision.reason };
      pending.delete(proposal_id);
      if (typeof onApply === 'function') onApply(entry.envelope);
      return { ok: true, applied: true, mode: decision.mode };
    },

    // Discard a proposal: dequeue, onReject, and (with a ledger) poison its fingerprint so a
    // later stage of the SAME diff is detectable as already-rejected.
    async discard(proposal_id, { reason = '', cooloffDays } = {}) {
      const entry = pending.get(proposal_id);
      if (!entry) return { ok: false, reason: 'no such proposal' };
      pending.delete(proposal_id);
      if (typeof onReject === 'function') onReject(entry.envelope, reason);
      if (ledger) {
        try { const fp = await fingerprint(fpInputs(entry.envelope)); await ledger.reject({ fp, reason, ...(cooloffDays != null ? { cooloffDays } : {}) }); await ledger.settled?.(); } catch (_) { /* poison is best-effort; a discard still dequeues */ }
      }
      return { ok: true };
    },

    // Would staging this diff be re-proposing something already discarded? Async (fingerprint).
    async isPoisoned({ app, tool, diff } = {}) {
      if (!ledger) return false;
      const fp = await fingerprint(fpInputs({ app, tool, diff }));
      return ledgerPoisoned(ledger, fp, now()).poisoned;
    },

    size() { return pending.size; },
  };
}
