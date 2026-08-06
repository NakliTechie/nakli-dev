// grant — Rig's single grant primitive (C4).
//
// A grant is the operator's per-session authorisation: a set of path prefixes
// and capability scopes. Rig is the ONE source of grants — Kiln derives its
// mount from the same grant and never sets, widens, or caches one (hard rule
// #5c). Deny by default: an empty prefix list allows nothing.
//
// Path checks reuse pathguard, so every traversal class (.., absolute-escape,
// encoded, backslash, control) is denied here exactly as it is at the fs
// ingress — the grant edge and the fs edge cannot disagree.

import { normalizeMountPath } from '../fileops/pathguard.mjs';

/**
 * @param {object}   opts
 * @param {string[]} [opts.prefixes]  mount-relative path prefixes ('' = whole mount)
 * @param {string[]} [opts.scopes]    capability scopes, e.g. 'fs:read', 'git:write'
 */
export function createGrant({ prefixes = [], scopes = [] } = {}) {
  let active = true;
  // Normalise prefixes through the same validator; drop any that don't validate.
  const norm = [];
  for (const p of prefixes) {
    const r = normalizeMountPath(p);
    if (r.ok) norm.push(r.path);
  }
  const scopeSet = new Set(scopes);

  function allowsPath(input) {
    if (!active) return false;
    const r = normalizeMountPath(input);
    if (!r.ok) return false; // traversal / encoded / absolute-escape → denied
    return norm.some((prefix) => prefix === '' || r.path === prefix || r.path.startsWith(prefix + '/'));
  }

  return {
    get active() { return active; },
    revoke() { active = false; },
    get prefixes() { return norm.slice(); },
    get scopes() { return [...scopeSet]; },
    allowsScope(scope) { return active && scopeSet.has(scope); },
    allowsPath,
    // A single object describing what is active — for a "grant visible while
    // active" surface (C5) and for the Kiln mount derivation.
    describe() {
      return { active, prefixes: norm.slice(), scopes: [...scopeSet] };
    },
  };
}
