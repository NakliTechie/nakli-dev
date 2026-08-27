// Rote — minimal, Rote-local secrets vault + redaction (handoff §2.6, §3.3, §5.3;
// the decision to build this rather than route through Tijori is recorded in the
// project history). Secrets NEVER reach a script as a literal and NEVER land in
// `.rote/`, a log, an `explore()` prompt, or `run.json`.
//
// Two halves, both pure/injectable:
//   • grants.json holds only  name → ref  (safe to version; no secret in it).
//   • the value store (ref → secret) lives OUTSIDE `.rote/` — an encrypted
//     host blob in production, an in-memory map in tests. Injected as `store`.
//
// A run resolves every grant its `meta.grants` declares BEFORE `run()` starts, so
// `ctx.vault.get(name)` is synchronous (matches the handoff's example) and every
// secret is registered with the redactor up front. A declared-but-unresolvable
// grant fails the run loud (class 'grant-unavailable') rather than at some later
// call site.

// The redactor: a growing set of secret values; `redact` strips every occurrence
// from a string before it is persisted; `contains` powers the canary assertion.
export function createRedactor(mark = '[REDACTED]') {
  const values = new Set();
  // Both the raw value AND its JSON-string-escaped form. A secret containing a
  // quote/backslash/newline/control char appears ESCAPED inside a persisted JSON
  // line (`pa\"ss`, not `pa"ss`); the raw form alone would miss it and leak. We
  // strip both, so a secret is caught whether it lands in plain text (out.text)
  // or a stringified record (run.json / log.ndjson / explore/*.json).
  const forms = (v) => { const raw = String(v); const esc = JSON.stringify(raw).slice(1, -1); return esc === raw ? [raw] : [raw, esc]; };
  const allForms = () => { const out = []; for (const v of values) out.push(...forms(v)); return out; };
  return {
    register(v) { const s = String(v == null ? '' : v); if (s) values.add(s); return this; },
    // Replace longest forms first so a secret containing another is handled.
    redact(text) {
      let out = String(text == null ? '' : text);
      for (const f of allForms().sort((a, b) => b.length - a.length)) { if (f) out = out.split(f).join(mark); }
      return out;
    },
    contains(text) {
      const s = String(text == null ? '' : text);
      for (const f of allForms()) if (f && s.includes(f)) return true;
      return false;
    },
    size() { return values.size; },
  };
}

// Resolve the grants a script declared into a synchronous getter. `store.get(ref)`
// is async (an encrypted blob); we await all of them here, register each value
// for redaction, then hand back a sync `get`. A script may only read a grant it
// declared in `meta.grants` — an undeclared name throws.
export async function createVault({ meta, grants, store, redactor }) {
  if (!redactor) throw new Error('createVault requires a redactor');
  const declared = new Set(Array.isArray(meta && meta.grants) ? meta.grants : []);
  const map = new Map(); // grantName -> resolved value
  const grantRefs = (grants && typeof grants === 'object') ? grants : {};
  for (const name of declared) {
    const ref = grantRefs[name];
    if (!ref) { const e = new Error(`grant "${name}" is declared but has no ref in grants.json`); e.code = 'grant-unavailable'; throw e; }
    let value;
    try { value = store ? await store.get(ref) : null; }
    catch (err) { const e = new Error(`grant "${name}" failed to resolve: ${String(err && err.message || err)}`); e.code = 'grant-unavailable'; throw e; }
    if (value == null || value === '') { const e = new Error(`grant "${name}" (ref ${ref}) has no value in the vault`); e.code = 'grant-unavailable'; throw e; }
    redactor.register(value);
    map.set(name, String(value));
  }
  return {
    get(name) {
      if (!declared.has(name)) throw new Error(`grant "${name}" was not declared in meta.grants`);
      if (!map.has(name)) throw new Error(`grant "${name}" is not available`);
      return map.get(name);
    },
    declared: () => [...declared],
  };
}

// An in-memory value store — the test double for the encrypted host blob. The
// production store has the same shape ({ get, set, delete }) over an encrypted
// OPFS/IndexedDB (or Crate) blob, never over `.rote/`.
export function createMemoryVaultStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    async get(ref) { return m.has(ref) ? m.get(ref) : null; },
    async set(ref, value) { m.set(ref, String(value)); },
    async delete(ref) { m.delete(ref); },
  };
}
