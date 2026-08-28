// Identity — agent capability tokens (handoff P0.1), macaroon-style, matching the
// fabric's existing grant model. A grant is an identifier + a chain of caveats,
// bound by an HMAC chain rooted in a per-issuer secret:
//   sig0 = HMAC(rootKey, identifier);  sig_{i+1} = HMAC(sig_i, caveat_i)
// The macaroon property: ANYONE holding a grant can ATTENUATE it (append a caveat
// and re-HMAC) WITHOUT the root key — but can never remove or loosen one, because
// verification (which needs the root key) re-derives the whole chain and requires
// EVERY caveat to hold. So delegation = adding narrowing caveats; widening is
// structurally impossible. Verified offline by the enforcement point (the app face)
// that holds the root key in its FIF. No server.

import { hmac, b64uEncode, b64uDecode, constantTimeEqual, randomBytes } from './crypto.mjs';

export function newGrantId() { return 'grant_' + b64uEncode(randomBytes(12)); }
export function newRootKey() { return randomBytes(32); } // per-issuer secret, held in the FIF

// Caveat builders — first-party predicates the verifier evaluates locally.
export const caveat = {
  principal: (id) => ({ type: 'principal', value: String(id) }),
  tools: (list) => ({ type: 'tools', value: [...list].map(String) }),
  scope: (prefix) => ({ type: 'scope', value: String(prefix) }),
  ttl: (expiryMs) => ({ type: 'ttl', value: Number(expiryMs) }),
  budget: ({ calls = null, tokens = null, spend = null } = {}) => ({ type: 'budget', value: { calls, tokens, spend } }),
  issuer: (id) => ({ type: 'issuer', value: String(id) }),
  autoCommit: (reversibleOnly = true) => ({ type: 'auto-commit', value: reversibleOnly ? 'reversible' : 'any' }),
};

// Deterministic caveat bytes for the HMAC chain (stable key order per type).
function serializeCaveat(c) {
  if (!c || typeof c !== 'object') return 'invalid';
  if (c.type === 'budget') { const v = c.value || {}; return `budget:${v.calls}|${v.tokens}|${v.spend}`; }
  if (c.type === 'tools') return `tools:${[...c.value].join(',')}`;
  return `${c.type}:${typeof c.value === 'object' ? JSON.stringify(c.value) : c.value}`;
}

async function chainSig(rootKey, identifier, caveats) {
  let sig = await hmac(rootKey, identifier);
  for (const c of caveats) sig = await hmac(sig, serializeCaveat(c));
  return sig;
}

// Issue a grant. `rootKey` is the issuer's secret; `caveats` the initial narrowing.
export async function issueGrant(rootKey, { identifier = newGrantId(), caveats = [] } = {}) {
  const sig = await chainSig(rootKey, identifier, caveats);
  return { identifier, caveats: caveats.slice(), sig: b64uEncode(sig) };
}

// Attenuate: append a caveat WITHOUT the root key (the macaroon property).
export async function attenuate(grant, newCaveat) {
  const sig = await hmac(b64uDecode(grant.sig), serializeCaveat(newCaveat));
  return { identifier: grant.identifier, caveats: [...grant.caveats, newCaveat], sig: b64uEncode(sig) };
}

// Evaluate one first-party caveat against the call context. Unknown types
// FAIL CLOSED — a verifier that cannot understand a caveat must not honour the grant.
function checkCaveat(c, ctx) {
  switch (c.type) {
    case 'principal': return ctx.principal === c.value ? null : `principal ${ctx.principal} ≠ ${c.value}`;
    case 'tools': return c.value.includes(ctx.tool) ? null : `tool "${ctx.tool}" not in [${c.value.join(', ')}]`;
    case 'scope': { const t = String(ctx.target || ''); return (t === c.value || t.startsWith(c.value + '/')) ? null : `target "${t}" outside scope "${c.value}"`; }
    case 'ttl': return (Number(ctx.now) <= c.value) ? null : `expired (ttl ${c.value} < now ${ctx.now})`;
    case 'budget': {
      const u = ctx.usage || {}; const v = c.value || {};
      for (const k of ['calls', 'tokens', 'spend']) if (v[k] != null && (u[k] || 0) > v[k]) return `budget ${k} exhausted (${u[k]} > ${v[k]})`;
      return null;
    }
    case 'issuer': return null;      // informational (attribution), no runtime predicate
    case 'auto-commit': return null; // read by the staging layer, not a call predicate
    default: return `unknown caveat type "${c.type}"`; // fail closed
  }
}

// Verify a presented grant. `rootKey` is the issuer's secret (from the FIF).
// `ctx` = { principal, tool, target, now, usage?, revocationList? }. Returns
// { ok, reason }. Signature is checked first (constant-time), then revocation,
// then every caveat.
export async function verifyGrant(grant, rootKey, ctx = {}) {
  if (!grant || !grant.identifier || !Array.isArray(grant.caveats) || !grant.sig) return { ok: false, reason: 'malformed grant' };
  const expected = await chainSig(rootKey, grant.identifier, grant.caveats);
  if (!constantTimeEqual(expected, b64uDecode(grant.sig))) return { ok: false, reason: 'signature' };
  const revoked = ctx.revocationList && (ctx.revocationList.has ? ctx.revocationList.has(grant.identifier) : ctx.revocationList.includes(grant.identifier));
  if (revoked) return { ok: false, reason: 'revoked' };
  for (const c of grant.caveats) { const err = checkCaveat(c, ctx); if (err) return { ok: false, reason: err }; }
  return { ok: true, reason: '' };
}

// Read a caveat value out of a grant (e.g. the auto-commit flag for staging).
export function readCaveat(grant, type) {
  const c = (grant && grant.caveats || []).find((x) => x.type === type);
  return c ? c.value : undefined;
}
