// Staging — the ENFORCEMENT POINT (handoff P0). The four P0 primitives are each
// shipped and each pure; nothing yet composed them into the thing an app calls.
// This is that seam, and it is the only place the four meet:
//
//   Identity  who is acting (a principal, minted by a person)
//   Grant     may they  (verifyGrant, with the FIF's revocation list ALWAYS passed)
//   History   it happened (hash-chained, per app — allows AND denials)
//   Staging   what would change (an envelope the one reviewer renders)
//
// The rule the whole layer exists to enforce: an agent may PROPOSE but not
// COMMIT. A stage call from an authorised agent produces an envelope; a commit
// is person-only unless a grant carries an auto-commit caveat for a reversible
// op (decideCommit). Every refusal is logged before it is thrown, because a
// refusal nobody can audit is indistinguishable from an action that never ran.
//
// Storage-free and DOM-free: the caller injects the FIF, the clock, and the
// `appliers` that make a committed proposal actually land in its app.

import { verifyGrant } from '../identity/grant.mjs';
import { appendEvent } from '../history/ledger.mjs';
import { makeEnvelope, normalizeEnvelope, decideCommit, isExpired } from './envelope.mjs';

export class StagingDenied extends Error {
  constructor(reason, event) { super(reason); this.code = 'EDENIED'; this.reason = reason; this.event = event; }
}

// `fif` is a createFifStore() (unlocked). `appliers` maps app -> async (envelope)
// -> result; an app with no applier can stage and be reviewed but not committed,
// which is the honest state for an app that has not been wired yet.
export function createStagingSession({ fif, appliers = {}, now = () => Date.now() } = {}) {
  if (!fif) throw new Error('a staging session needs an unlocked FIF');

  const heads = new Map();     // app -> chain head hash (per-app chains stay independently verifiable)
  const events = new Map();    // app -> events[]
  const pending = new Map();   // proposal_id -> { envelope, principal, grant, reversible, target }
  const usage = new Map();     // grant identifier -> { calls } — budget caveats need honest counters

  async function log(app, { principal, tool, input, output, grant_id }) {
    const prev = heads.get(app) ?? null;
    const { event, head } = await appendEvent(prev, {
      ts: now(), principal, door: 'call', tool, app, input, output, grant_id,
    });
    heads.set(app, head);
    if (!events.has(app)) events.set(app, []);
    events.get(app).push(event);
    return event;
  }

  // Authorise one call against its grant. Returns the failure reason, or null.
  async function authorize({ principal, grant, tool, target }) {
    if (!grant) return 'no grant presented';
    const u = usage.get(grant.identifier) || { calls: 0 };
    const v = await verifyGrant(grant, fif.rootKey(), {
      principal, tool, target, now: now(),
      usage: u,
      // The enforcement-point contract (grant.mjs:120-124): an omitted list
      // silently means "nothing revoked". It is passed here, always.
      revocationList: fif.revocationList(),
    });
    return v.ok ? null : v.reason;
  }

  return {
    // Propose a mutation. Authorised → a staged envelope, logged. Refused →
    // logged, then thrown as StagingDenied (loud, with the reason).
    async stage({ principal, grant, app, tool, target = app, diff, reversible = true, expiresInMs = null }) {
      const denial = await authorize({ principal, grant, tool, target });
      if (denial) {
        const event = await log(app, { principal, tool, input: { target, staged: false }, output: { denied: denial }, grant_id: grant ? grant.identifier : null });
        throw new StagingDenied(denial, event);
      }
      // Count the call only once it is authorised, so a denial cannot burn budget.
      const u = usage.get(grant.identifier) || { calls: 0 };
      usage.set(grant.identifier, { calls: u.calls + 1 });

      const envelope = makeEnvelope({ app, tool, diff, expires: expiresInMs == null ? null : now() + expiresInMs });
      pending.set(envelope.proposal_id, { envelope, principal, grant, reversible, target });
      const event = await log(app, {
        principal, tool,
        input: { target, diff },
        // Commit by hash, not content: History proves WHAT was proposed without
        // hoarding the payload (ledger.mjs's whole posture).
        output: { staged: true, proposal_id: envelope.proposal_id, preview_renderer: envelope.preview_renderer },
        grant_id: grant.identifier,
      });
      return { envelope, event, normalized: normalizeEnvelope(envelope) };
    },

    // Commit a staged proposal. `actor` is 'person' or 'agent' — the person path
    // needs no grant (a human at the keyboard IS the authority); the agent path
    // must clear decideCommit AND re-clear its grant, because time has passed
    // since staging and the grant may have expired or been revoked meanwhile.
    async commit(proposalId, { actor, principal = null, grant = null } = {}) {
      const rec = pending.get(proposalId);
      if (!rec) throw new Error(`no pending proposal "${proposalId}"`);
      const { envelope } = rec;
      const app = envelope.app;

      if (isExpired(envelope, now())) {
        const event = await log(app, { principal, tool: `${app}.commit`, input: { proposal_id: proposalId }, output: { denied: 'expired' }, grant_id: grant ? grant.identifier : null });
        pending.delete(proposalId);
        throw new StagingDenied('proposal expired', event);
      }

      const decision = decideCommit({ actor, tool: `${app}.commit`, reversible: rec.reversible, grant });
      if (!decision.allowed) {
        const event = await log(app, { principal, tool: `${app}.commit`, input: { proposal_id: proposalId }, output: { denied: decision.reason }, grant_id: grant ? grant.identifier : null });
        throw new StagingDenied(decision.reason, event);
      }
      if (actor === 'agent') {
        const denial = await authorize({ principal, grant, tool: `${app}.commit`, target: rec.target });
        if (denial) {
          const event = await log(app, { principal, tool: `${app}.commit`, input: { proposal_id: proposalId }, output: { denied: denial }, grant_id: grant.identifier });
          throw new StagingDenied(denial, event);
        }
      }

      const applier = appliers[app];
      if (typeof applier !== 'function') throw new Error(`app "${app}" has no applier — it can stage and be reviewed, but not commit`);
      const applied = await applier(envelope);
      pending.delete(proposalId);
      const event = await log(app, {
        principal, tool: `${app}.commit`,
        input: { proposal_id: proposalId },
        output: { committed: true, mode: decision.mode, applied },
        grant_id: grant ? grant.identifier : null,
      });
      return { applied, event, mode: decision.mode };
    },

    // Drop a proposal without applying it. Recorded — a discard is a decision.
    async discard(proposalId, { principal = null } = {}) {
      const rec = pending.get(proposalId);
      if (!rec) return false;
      pending.delete(proposalId);
      await log(rec.envelope.app, { principal, tool: `${rec.envelope.app}.discard`, input: { proposal_id: proposalId }, output: { discarded: true }, grant_id: rec.grant ? rec.grant.identifier : null });
      return true;
    },

    // What the reviewer renders: every open proposal, any mix of apps.
    pending() { return [...pending.values()].map((r) => r.envelope); },
    proposal(id) { const r = pending.get(id); return r ? r.envelope : null; },
    contextFor(id) {
      const r = pending.get(id);
      return r ? { actor: 'person', reversible: r.reversible, grant: r.grant, now: now() } : null;
    },

    // The ledger — per app (each chain independently verifiable) or merged.
    events(app) { return app ? [...(events.get(app) || [])] : Object.fromEntries([...events].map(([k, v]) => [k, [...v]])); },
    usageFor(grantId) { return { ...(usage.get(grantId) || { calls: 0 }) }; },
  };
}
