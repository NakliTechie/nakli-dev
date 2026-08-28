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

// Canonical JSON with sorted object keys — so serialization is INJECTIVE: two
// caveats serialize identically iff they are structurally equal. A non-injective
// form (e.g. tools joined by ',') would let tools:['a,b'] and tools:['a','b']
// share a chain input, a widening-forgery vector.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
// The caveat bytes for the HMAC chain — type and value as a canonical 2-tuple, so
// no value or delimiter can be confused with a type or a sibling field.
function serializeCaveat(c) {
  if (!c || typeof c !== 'object') return stable(['invalid', c]);
  return stable([c.type, c.value ?? null]);
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
    case 'scope': {
      const t = String(ctx.target || '');
      if (t.split('/').includes('..')) return `target "${t}" contains a ".." segment`; // no traversal out of scope
      return (t === c.value || t.startsWith(c.value + '/')) ? null : `target "${t}" outside scope "${c.value}"`;
    }
    case 'ttl': return (Number.isFinite(Number(ctx.now)) && Number(ctx.now) <= c.value) ? null : `expired (ttl ${c.value} < now ${ctx.now})`;
    case 'budget': {
      const u = ctx.usage || {}; const v = c.value || {};
      // >= : the cap is inclusive of prior usage, so a call that would meet or
      // exceed it is denied. A non-finite counter fails CLOSED (treated as exhausted).
      for (const k of ['calls', 'tokens', 'spend']) {
        if (v[k] == null) continue;
        const used = (u[k] === undefined || u[k] === null) ? 0 : Number(u[k]); // don't let NaN||0 hide it
        if (!Number.isFinite(used) || used >= v[k]) return `budget ${k} exhausted (${u[k]} ≥ ${v[k]})`;
      }
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
  let presented;
  try { presented = b64uDecode(grant.sig); } catch (_) { return { ok: false, reason: 'malformed signature' }; }
  const expected = await chainSig(rootKey, grant.identifier, grant.caveats);
  if (!constantTimeEqual(expected, presented)) return { ok: false, reason: 'signature' };
  const revoked = ctx.revocationList && (ctx.revocationList.has ? ctx.revocationList.has(grant.identifier) : ctx.revocationList.includes(grant.identifier));
  if (revoked) return { ok: false, reason: 'revoked' };
  for (const c of grant.caveats) { const err = checkCaveat(c, ctx); if (err) return { ok: false, reason: err }; }
  return { ok: true, reason: '' };
}

// Read the FIRST caveat value of a type. For a type that can be ATTENUATED
// (appended more restrictively, e.g. auto-commit), read all of them and combine —
// see readCaveats — rather than trusting the issuer's first.
export function readCaveat(grant, type) {
  const c = (grant && grant.caveats || []).find((x) => x.type === type);
  return c ? c.value : undefined;
}
// All values of a caveat type, issuer-first — so a consumer can apply the
// most-restrictive across a delegation chain (attenuation only narrows).
export function readCaveats(grant, type) {
  return (grant && grant.caveats || []).filter((x) => x.type === type).map((x) => x.value);
}

// NOTE (enforcement-point contract): verifyGrant authorizes over TRUSTED ctx.
// The caller MUST (a) bind ctx.principal to a verifyDescriptor-checked identity
// with the correct minter key, (b) supply honest usage counters, and (c) ALWAYS
// pass ctx.revocationList — an omitted list means "no revocations" and a revoked
// grant would verify. Treat the list as a required input at every face call.
